const express = require('express');
const mongoose = require('mongoose'); // 🔐 needed for session/transaction support
const router = express.Router();
const RouteError = require('../utils/RouteError');
const Customer = require('../models/Customer');
const { requireAdmin } = require('../middleware/auth'); // 🔐 note: `protect` already applied at /api/customers in server.js

// 1. අලුත් පාරිභෝගිකයෙක් ඇතුලත් කිරීම
router.post('/add', async (req, res) => {
    try {
        const { name, phone, isLoyaltyMember } = req.body;
        const existing = await Customer.findOne({ phone });
        if (existing) return res.status(400).json({ message: "මෙම දුරකථන අංකය දැනටමත් පද්ධතියේ ඇත! ❌" });

        // 🆕 BILL-LEVEL DISCOUNT: Loyalty Card Holder flag එකත් සේව් කරයි
        const newCustomer = new Customer({ name, phone, isLoyaltyMember: isLoyaltyMember || false });
        await newCustomer.save();
        res.status(201).json({ message: "පාරිභෝගිකයා සාර්ථකව ඇතුලත් කලා! 👤", customer: newCustomer });
    } catch (error) {
        console.error("ඇතුලත් කිරීම අසාර්ථකයි", error);
        res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි" });
    }
});

// 🛠️ UPDATED: පාරිභෝගික විස්තර යාවත්කාලීන කිරීමේ Route එක
// 🔐 SECURITY FIX: කලින් req.body එකම whole එකක් විදිහට DB update එකට දැම්මා (Mass-Assignment Vulnerability) -
// Edit Form එකෙන් name/phone විතරක් එවුවත්, request body එකට extra field එකක් (උදා: creditBalance,
// creditHistory) එකතු කරලා එව්වොත් ඒකත් update වෙනවා. දැන් Edit Form එකෙන් ඇත්තටම එවන fields
// (name, phone) විතරක් allow-list කරලා, ඒවා විතරක් DB එකට යවනවා.
router.put("/update/:id", requireAdmin, async (req, res) => {
  try {
    const { name, phone } = req.body;
    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (phone !== undefined) updateFields.phone = phone;

    const updatedCustomer = await Customer.findByIdAndUpdate(
      req.params.id, // Frontend එකෙන් එන ID එක මෙතනින් ලබාගනී
      updateFields,
      { returnDocument: 'after', runValidators: true }
    );

    if (!updatedCustomer) {
      return res.status(404).json({ message: "පාරිභෝගිකයා සොයාගත නොහැක" });
    }

    res.json({ message: "විස්තර යාවත්කාලීන කිරීම සාර්ථකයි! 🔄", customer: updatedCustomer });
  } catch (error) {
    console.error("යාවත්කාලීන කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි" });
  }
});

// 2. සියලුම පාරිභෝගිකයන් ලබාගැනීම
router.get('/', async (req, res) => {
    try {
        const customers = await Customer.find().sort({ name: 1 });
        res.status(200).json(customers);
    } catch (error) {
        console.error("දත්ත ලබාගැනීම අසාර්ථකයි", error);
        res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි" });
    }
});

// 3. පාරිභෝගිකයෙකු දුරකථන අංකයෙන් සෙවීම
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
    console.error("සෙවීම අසාර්ථකයි", error);
    res.status(500).json({ message: "සෙවීම අසාර්ථකයි" });
  }
});

// 🛠️ UPDATED: පාරිභෝගිකයෙකු මකා දැමීමේ Route එක
router.delete("/delete/:id", requireAdmin, async (req, res) => {
  try {
    const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);

    if (!deletedCustomer) {
      return res.status(404).json({ message: "පාරිභෝගිකයා සොයාගත නොහැක" });
    }

    res.json({ message: "මකා දැමීම සාර්ථකයි! 🗑️" });
  } catch (error) {
    console.error("මකා දැමීම අසාර්ථකයි", error);
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි" });
  }
});

// 4. ණය මුදල් පියවීම (Pay/Settle Credit)
// 🛠️ REWRITE (2026-10-16): පරණ කේතය creditHistory එකට entries 2ක් (payment + "isChangeReturn"
// කියන වෙනම entry එකක්) හදනවා තිබුණා, ඒත් "isChangeReturn" field එක Customer.js schema එකේ
// කවදාවත් define කරලා තිබුනේ නෑ - Mongoose strict-schema නිසා save කරද්දී ඒ field එකම silently
// drop වුනා. ප්‍රතිඵලය: Overpayment එකක් උනත්, cashback එක UI එකේ (orange badge/summary) කවදාවත්
// පේන්නේ නෑ, response එකේ changeGiven නැති නිසා toast එකත් වැරදියට "success" විදිහටම පෙන්වුනා.
//
// දැන් Supplier payment route එකේම (/suppliers/pay/:id, දැනටමත් හරියට වැඩ කරන) pattern එකම -
// Single ledger entry එකක් (amount = applied-to-debt විතරක්, paidAmount/changeGiven වෙනම
// fields වලින්), Customer.js schema එකේ දැනටමත් define කරලා තියෙන paidAmount/changeGiven fields
// පාවිච්චි කරලා, Transaction එකකින් wrap කරලා (concurrent payments අතරේ lost-update race එකකින්
// ආරක්ෂා වෙන්න). Shift Reconciliation සඳහා එකතු කරපු Payment Method/Cashier tracking එකත්
// මෙතනටම (single entry එකටම) ගේනවා - Customer.js schema එකටත් ඒ fields දැන් එකතු කරලා තියෙනවා.
router.post('/pay-credit/:id', async (req, res) => {
    const { amount, paymentMethod } = req.body;
    const paidAmount = Number(amount);
    if (!paidAmount || paidAmount <= 0) {
        return res.status(400).json({ message: "නිවැරදි මුදලක් ඇතුලත් කරන්න!" });
    }
    const validMethods = ["Cash", "Card", "Bank Transfer", "Other"];
    const method = validMethods.includes(paymentMethod) ? paymentMethod : "Cash";

    const session = await mongoose.startSession();
    let responsePayload = null;

    try {
        await session.withTransaction(async () => {
            const customer = await Customer.findById(req.params.id).session(session);
            if (!customer) throw new RouteError(404, "පාරිභෝගිකයා සොයාගත නොහැක");

            const owedBefore = customer.creditBalance || 0;

            // 🆕 FIX: ණයක් නැති customer කෙනෙකුට "ගෙවීමක්" record කරන්න බෑ - balanceDue වගේම,
            // creditBalance 0ට වඩා තිබුනොත් විතරයි settle කරන්න ඕන දෙයක් තියෙන්නේ.
            if (owedBefore <= 0) {
                throw new RouteError(400, "මෙම පාරිභෝගිකයාට ගෙවීමට ඇති ණයක් නැත! ගෙවීමක් අවශ්‍ය නොවේ.");
            }

            // creditBalance එකට ඇත්තටම යෙදෙන්නේ, ගෙවපු මුදලෙන් ණයට ඉතිරිව තියෙන ප්‍රමාණය දක්වා විතරයි
            const appliedAmount = Math.round(Math.min(paidAmount, owedBefore) * 100) / 100;
            // ඉතුරු (ණයට වඩා ගෙවපු) මුදල - ආපසු ලැබෙන්න ඕන "cashback" එක
            const changeGiven = Math.round((paidAmount - appliedAmount) * 100) / 100;

            customer.creditBalance = Math.max(0, Math.round((owedBefore - appliedAmount) * 100) / 100);

            // (Cash Drawer එකට ගැලපෙන්නේ මේ "appliedAmount" එකමයි - paidAmount - changeGiven = appliedAmount,
            // ඒ නිසා Shift aggregation එකේදී මේ එක entry එකේ amount එක ගත්තොත් ප්‍රමාණවත්.)
            if (!customer.creditHistory) customer.creditHistory = [];
            customer.creditHistory.push({
                amount: -appliedAmount,
                paidAmount,
                changeGiven,
                cashier: req.user.username,
                paymentMethod: method,
                date: new Date(),
                description: changeGiven > 0
                    ? `ණය මුදල් ගෙවීමක් සිදු කලා (ගෙවූ මුදල: රු.${paidAmount.toFixed(2)}, ණයට යෙදුවේ: රු.${appliedAmount.toFixed(2)}, ආපසු ලැබුණු මුදල: රු.${changeGiven.toFixed(2)}) - ${method}`
                    : `ණය මුදල් ගෙවීමක් සිදු කලා (Payment Received) - ${method}`
            });

            await customer.save({ session });

            responsePayload = {
                message: changeGiven > 0
                    ? `ණය මුදල සාර්ථකව යාවත්කාලීන කලා! 💵 ආපසු ලැබෙන්න ඕන මුදල: රු.${changeGiven.toFixed(2)}`
                    : "ණය මුදල සාර්ථකව යාවත්කාලීන කලා! ✅",
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
        console.error("පියවීම අසාර්ථකයි", error);
        res.status(500).json({ message: "පියවීම අසාර්ථකයි" });
    } finally {
        await session.endSession();
    }
});

module.exports = router;