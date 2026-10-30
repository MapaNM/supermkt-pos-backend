const express = require('express');
const mongoose = require('mongoose'); // 🔐 needed for session/transaction support
const router = express.Router();
const RouteError = require('../utils/routeError');
const Customer = require('../models/Customer');
const { requireOpenShift } = require('../middleware/requireShift'); // 🔐 Make Shift mandatory (for Cash payments)
const { requireAdmin } = require('../middleware/auth'); // 🔐 note: `protect` already applied at /api/customers in server.js

// 1. Add a new customer
router.post('/add', async (req, res) => {
    try {
        const { name, phone, isLoyaltyMember } = req.body;
        const existing = await Customer.findOne({ phone });
        if (existing) return res.status(400).json({ message: "This phone number already exists in the system! ❌" });

        // 🆕 BILL-LEVEL DISCOUNT: Also saves the Loyalty Card Holder flag
        const newCustomer = new Customer({ name, phone, isLoyaltyMember: isLoyaltyMember || false });
        await newCustomer.save();
        res.status(201).json({ message: "Customer added successfully! 👤", customer: newCustomer });
    } catch (error) {
        console.error("Failed to add customer", error);
        res.status(500).json({ message: "Failed to add customer" });
    }
});

// 🛠️ UPDATED: Route to update customer details
// 🔐 SECURITY FIX: Previously the whole req.body was passed into the DB update (Mass-Assignment Vulnerability) -
// even if the Edit Form only sends name/phone, if an extra field (e.g. creditBalance,
// creditHistory) was added to the request body, it would also get updated. Now only the fields the Edit Form
// actually sends (name, phone) are allow-listed, and only those are sent to the DB.
router.put("/update/:id", requireAdmin, async (req, res) => {
  try {
    const { name, phone } = req.body;
    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (phone !== undefined) updateFields.phone = phone;

    const updatedCustomer = await Customer.findByIdAndUpdate(
      req.params.id, // The ID coming from the Frontend is taken here
      updateFields,
      { returnDocument: 'after', runValidators: true }
    );

    if (!updatedCustomer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json({ message: "Details updated successfully! 🔄", customer: updatedCustomer });
  } catch (error) {
    console.error("Failed to update", error);
    res.status(500).json({ message: "Failed to update" });
  }
});

// 2. Get all customers
router.get('/', async (req, res) => {
    try {
        const customers = await Customer.find().sort({ name: 1 });
        res.status(200).json(customers);
    } catch (error) {
        console.error("Failed to fetch data", error);
        res.status(500).json({ message: "Failed to fetch data" });
    }
});

// 3. Search for a customer by phone number
// 🔍 🛠️ UPDATED: SEARCH CUSTOMER BY NAME OR PHONE
// customerRoutes.js
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get("/search/:query", async (req, res) => {
  try {
    const { query } = req.params;

    if (!query || query.trim().length === 0) {
      return res.json([]);
    }

    const safeQuery = escapeRegex(query.trim());

    const customers = await Customer.find({
      $or: [
        { name: { $regex: safeQuery, $options: "i" } },
        { phone: { $regex: safeQuery, $options: "i" } }
      ]
    }).limit(10);

    res.json(customers);
  } catch (error) {
    console.error("Failed to search", error);
    res.status(500).json({ message: "Failed to search" });
  }
});

// 🛠️ UPDATED: Route to delete a customer
router.delete("/delete/:id", requireAdmin, async (req, res) => {
  try {
    const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);

    if (!deletedCustomer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json({ message: "Deleted successfully! 🗑️" });
  } catch (error) {
    console.error("Failed to delete", error);
    res.status(500).json({ message: "Failed to delete" });
  }
});

// 4. Settle credit (Pay/Settle Credit)
// 🛠️ REWRITE (2026-10-16): The old code created 2 entries in creditHistory (a payment + a separate entry called "isChangeReturn"),
// but the "isChangeReturn" field was
// never defined in the Customer.js schema - because of Mongoose strict-schema, that field was silently
// dropped on save. Result: even when there was an Overpayment, the cashback was never shown in the UI (orange badge/summary),
// and since changeGiven was missing from the response, the toast also wrongly showed as plain "success".
//
// Now using the very same pattern as the Supplier payment route (/suppliers/pay/:id, which already works correctly) -
// a single ledger entry (amount = only the amount applied to the debt, with paidAmount/changeGiven in separate
// fields), using the paidAmount/changeGiven fields already defined in the Customer.js schema,
// wrapped in a Transaction (to protect against lost-update races between concurrent payments).
// The Payment Method/Cashier tracking added for Shift Reconciliation is also brought
// into this same single entry - those fields have now been added to the Customer.js schema as well.
router.post('/pay-credit/:id', requireOpenShift({ onlyIfCash: true }), async (req, res) => {
    const { amount, paymentMethod } = req.body;
    const paidAmount = Number(amount);
    if (!paidAmount || paidAmount <= 0) {
        return res.status(400).json({ message: "Please enter a valid amount!" });
    }
    const validMethods = ["Cash", "Card", "Bank Transfer", "Other"];
    const method = validMethods.includes(paymentMethod) ? paymentMethod : "Cash";

    const session = await mongoose.startSession();
    let responsePayload = null;

    try {
        await session.withTransaction(async () => {
            const customer = await Customer.findById(req.params.id).session(session);
            if (!customer) throw new RouteError(404, "Customer not found");

            const owedBefore = customer.creditBalance || 0;

            // 🆕 FIX: A "payment" cannot be recorded for a customer with no credit - just like balanceDue,
            // there is something to settle only if creditBalance is greater than 0.
            if (owedBefore <= 0) {
                throw new RouteError(400, "This customer has no outstanding credit to pay! No payment is required.");
            }

            // Only up to the remaining credit amount of the paid amount is actually applied to creditBalance
            const appliedAmount = Math.round(Math.min(paidAmount, owedBefore) * 100) / 100;
            // The remainder (the amount paid over the credit) - the "cashback" that must be returned
            const changeGiven = Math.round((paidAmount - appliedAmount) * 100) / 100;

            customer.creditBalance = Math.max(0, Math.round((owedBefore - appliedAmount) * 100) / 100);

            // (This "appliedAmount" is what matches the Cash Drawer - paidAmount - changeGiven = appliedAmount,
            // so taking the amount of this single entry in the Shift aggregation is sufficient.)
            if (!customer.creditHistory) customer.creditHistory = [];
            customer.creditHistory.push({
                amount: -appliedAmount,
                paidAmount,
                changeGiven,
                cashier: req.user.username,
                paymentMethod: method,
                date: new Date(),
                description: changeGiven > 0
                    ? `Credit payment made (Amount paid: Rs.${paidAmount.toFixed(2)}, Applied to credit: Rs.${appliedAmount.toFixed(2)}, Change returned: Rs.${changeGiven.toFixed(2)}) - ${method}`
                    : `Credit payment made (Payment Received) - ${method}`
            });

            await customer.save({ session });

            responsePayload = {
                message: changeGiven > 0
                    ? `Credit updated successfully! 💵 Change to be returned: Rs.${changeGiven.toFixed(2)}`
                    : "Credit updated successfully! ✅",
                customer,
                appliedAmount,
                changeGiven
            };
        });

        res.status(200).json(responsePayload);
    } catch (error) {
        if (error instanceof RouteError) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error("Failed to settle", error);
        res.status(500).json({ message: "Failed to settle" });
    } finally {
        await session.endSession();
    }
});

module.exports = router;