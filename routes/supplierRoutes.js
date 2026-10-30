const express = require("express");
const mongoose = require("mongoose"); // 🔐 needed for session/transaction support
const router = express.Router();
const RouteError = require("../utils/routeError");
const Supplier = require("../models/Supplier");
const Product = require("../models/Product");
const { requireOpenShift } = require("../middleware/requireShift"); // 🔐 Make Shift mandatory (for Cash payments)
const GRN = require("../models/GRN"); // 🆕 Professional GRN document
const Counter = require("../models/Counter"); // 🆕 Sequential GRN numbering (same pattern as Invoice No)
// 🔐 note: this entire router is mounted behind `protect` + `requireAdmin` in server.js —
// supplier management (purchases, balances, payments) is admin-only, no per-route changes needed here.

// Escape Regex special characters (to prevent Regex Injection)
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const roundQty = (num) => Math.round((parseFloat(num) || 0) * 1000) / 1000;
const round2 = (num) => Math.round((parseFloat(num) || 0) * 100) / 100;

// 🆕 PROFESSIONAL SEQUENTIAL GRN NUMBER GENERATOR - Same pattern as the Invoice No
// like GRN-20260101-0001, restarting from 0001 each day (Real GRN Document Style)
async function generateGrnNo(session = null) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const counterId = `grn-${dateStr}`;

  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );

  return `GRN-${dateStr}-${String(counter.seq).padStart(4, "0")}`;
}

// 1. Add a new Supplier
router.post("/add", async (req, res) => {
  try {
    const { name, phone, address } = req.body;

    const existing = await Supplier.findOne({ phone });
    if (existing) {
      return res.status(400).json({ message: "This phone number already belongs to another Supplier! ❌" });
    }

    const newSupplier = new Supplier({ name, phone, address });
    await newSupplier.save();
    res.status(201).json({ message: "Supplier added successfully! 🚚", supplier: newSupplier });
  } catch (error) {
    console.error("Failed to add supplier", error);
    res.status(500).json({ message: "Failed to add supplier" });
  }
});

// 2. Get all Suppliers
router.get("/", async (req, res) => {
  try {
    const suppliers = await Supplier.find().sort({ name: 1 });
    res.status(200).json(suppliers);
  } catch (error) {
    console.error("Failed to fetch data", error);
    res.status(500).json({ message: "Failed to fetch data" });
  }
});

// 3. Search for a Supplier by name or phone number (Live Search)
router.get("/search/:query", async (req, res) => {
  try {
    const { query } = req.params;
    if (!query || query.trim().length === 0) return res.json([]);

    const safeQuery = escapeRegex(query.trim());
    const suppliers = await Supplier.find({
      $or: [
        { name: { $regex: safeQuery, $options: "i" } },
        { phone: { $regex: safeQuery, $options: "i" } },
      ],
    }).limit(10);

    res.json(suppliers);
  } catch (error) {
    console.error("Failed to search", error);
    res.status(500).json({ message: "Failed to search" });
  }
});

// 4. Update Supplier details
// 🔐 SECURITY FIX: Previously the whole req.body was passed into the DB update (Mass-Assignment Vulnerability) -
// even if the Edit Form only sends name/phone/address, if an extra field (e.g.
// balanceDue, ledger) was added to the request body, it would also get updated - meaning financial records
// could be silently overwritten by a direct API call. Now only the fields the Edit Form
// actually sends (name, phone, address) are allow-listed, and only those are sent to the DB.
router.put("/update/:id", async (req, res) => {
  try {
    const { name, phone, address } = req.body;
    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (phone !== undefined) updateFields.phone = phone;
    if (address !== undefined) updateFields.address = address;

    const updatedSupplier = await Supplier.findByIdAndUpdate(req.params.id, updateFields, {
      returnDocument: "after",
      runValidators: true,
    });

    if (!updatedSupplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    res.json({ message: "Details updated successfully! 🔄", supplier: updatedSupplier });
  } catch (error) {
    console.error("Failed to update", error);
    res.status(500).json({ message: "Failed to update" });
  }
});

// 5. Delete a Supplier
router.delete("/delete/:id", async (req, res) => {
  try {
    const deletedSupplier = await Supplier.findByIdAndDelete(req.params.id);
    if (!deletedSupplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    res.json({ message: "Deleted successfully! 🗑️" });
  } catch (error) {
    console.error("Failed to delete", error);
    res.status(500).json({ message: "Failed to delete" });
  }
});

// 6. 🆕 PROFESSIONAL GRN REBUILD: Recording that multiple Products were received at once from a single Supplier Invoice
// items: [{ productId, orderedQty, receivedQty, costPrice, expiryDate, stockMode }, ...]
//
// 🐛 FIX (core bug this rebuild solves): Previously only product.stock was updated here, and the batches[] array
// was never updated. When batches exist, the Frontend getTotalStock() returns the sum of batches[].stock
// and does not look at product.stock at all - so the stock received via GRN "disappeared" and was not visible anywhere in the
// catalog/dashboard/checkout. Now in "add" mode, a new Batch is created, its own Cost Price
// and Expiry Date are recorded, and both product.stock and batches[].stock are atomically $inc'd together -
// the same dual-field pattern already used by the checkout/void/return routes.
router.post("/record-purchase/:id", async (req, res) => {
  const { items, description, supplierInvoiceRef, receivedBy } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Please add at least one item to the GRN List!" });
  }

  // 🔐 TRANSACTIONS: The GRN document, the Product batches[] update, and the Supplier ledger entry -
  // all of these must succeed together; if one fails, nothing is saved (all-or-nothing).
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(req.params.id).session(session);
      if (!supplier) throw new RouteError(404, "Supplier not found");

      const grnNo = await generateGrnNo(session);

      let grandTotal = 0;
      let overallHasDiscrepancy = false;
      let anyPartial = false;
      const ledgerItems = []; // backward-compatible Supplier.ledger items (legacy shape, used by existing ledger modal)
      const grnItems = []; // full new GRN.items (richer shape)

      // Validates + processes all items
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const receivedQty = roundQty(item.receivedQty ?? item.quantity); // 🔐 "quantity" = legacy field name, backward compat
        const orderedQty = roundQty(item.orderedQty || 0);
        const cost = parseFloat(item.costPrice);

        if (!item.productId || !receivedQty || receivedQty <= 0 || !cost || cost <= 0) {
          throw new RouteError(400, "All items must have a valid received quantity and price!");
        }

        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          throw new RouteError(404, "An item was not found - please recheck the GRN List");
        }

        const expiryDate = item.expiryDate ? new Date(item.expiryDate) : null;
        const stockMode = item.stockMode === "set" ? "set" : "add";

        // 🆕 Discrepancy check: If an Ordered Qty is recorded, flags it when it does not equal the Received Qty
        const lineHasDiscrepancy = orderedQty > 0 && orderedQty !== receivedQty;
        if (lineHasDiscrepancy) {
          overallHasDiscrepancy = true;
          if (receivedQty < orderedQty) anyPartial = true;
        }

        let newBatchId = "";

        if (stockMode === "set") {
          // 🛠️ "Replace/Set" = for Opening Stock or Correction only - because of the ambiguity over
          // which batch to replace when there are multiple batches, it is allowed only for products with 0 or 1 batch.
          if (Array.isArray(product.batches) && product.batches.length > 1) {
            throw new RouteError(
              400,
              `"Replace" mode cannot be used for "${product.name}" because it already has multiple Batches - adjust each Batch individually from Stock Management.`
            );
          }

          if (Array.isArray(product.batches) && product.batches.length === 1) {
            product.batches[0].stock = receivedQty;
            product.batches[0].costPrice = cost;
            if (expiryDate) product.batches[0].expiryDate = expiryDate;
            newBatchId = product.batches[0].batchId;
          }
          product.stock = receivedQty;
          product.costPrice = cost;
          await product.save({ session });
        } else {
          // 🆕 "Add" (normal GRN) = creates a new Batch and records its own Cost Price + Expiry Date -
          // without mixing with the cost price of the old batch, it is kept separate batch by batch for accurate profit calculation.
          newBatchId = `${grnNo}-${idx + 1}`;
          const updated = await Product.findOneAndUpdate(
            { _id: item.productId },
            {
              $inc: { stock: receivedQty },
              $push: {
                batches: {
                  batchId: newBatchId,
                  label: "",
                  price: product.price,
                  costPrice: cost,
                  marketPrice: product.marketPrice,
                  discount: 0,
                  stock: receivedQty,
                  expiryDate: expiryDate || null,
                },
              },
              $set: { costPrice: cost },
            },
            { session, new: true }
          );
          if (!updated) {
            throw new RouteError(404, "An item was not found - please recheck the GRN List");
          }
        }

        const subtotal = round2(receivedQty * cost);
        grandTotal += subtotal;

        ledgerItems.push({
          productName: product.name,
          quantity: receivedQty,
          costPrice: cost,
          subtotal,
          stockMode,
        });

        grnItems.push({
          productId: product._id,
          productName: product.name,
          unit: product.unit ?? "Kg",
          orderedQty,
          receivedQty,
          costPrice: cost,
          subtotal,
          expiryDate,
          batchId: newBatchId,
          stockMode,
          hasDiscrepancy: lineHasDiscrepancy,
        });
      }

      grandTotal = round2(grandTotal);

      const status = overallHasDiscrepancy ? (anyPartial ? "Partially Received" : "Discrepancy") : "Received";

      // 📄 Creates the GRN Document (for Print/PDF + History)
      const newGrn = new GRN({
        grnNo,
        supplierId: supplier._id,
        supplierName: supplier.name,
        supplierInvoiceRef: supplierInvoiceRef || "",
        notes: description || "",
        items: grnItems,
        grandTotal,
        status,
        hasDiscrepancy: overallHasDiscrepancy,
        receivedBy: receivedBy || "",
        date: new Date(),
      });
      await newGrn.save({ session });

      // 💰 Adds the Grand Total to the Supplier's Balance Due, and also keeps a Legacy Ledger Entry
      // (for backward-compat, since the Supplier Details Modal already displays data in this shape)
      supplier.balanceDue += grandTotal;
      supplier.ledger.push({
        type: "purchase",
        amount: grandTotal,
        description: `${grnNo}${supplierInvoiceRef ? ` (Invoice: ${supplierInvoiceRef})` : ""}${description ? ` - ${description}` : ""}`,
        items: ledgerItems,
        date: new Date(),
      });

      await supplier.save({ session });

      responsePayload = {
        message: `GRN ${grnNo} recorded successfully! 📦 (${grnItems.length} items, Grand Total: Rs.${grandTotal.toFixed(2)})`,
        supplier,
        grn: newGrn,
      };
    });

    res.status(200).json(responsePayload);
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Record-purchase error:", error);
    res.status(500).json({ message: "Failed to record the GRN" });
  } finally {
    await session.endSession();
  }
});

// 6.5 🆕 GRN List (History) - Filter: supplierId, from, to, q (GRN No / Supplier Name search)
router.get("/grn/list", async (req, res) => {
  try {
    const { supplierId, from, to, q } = req.query;
    const filter = {};

    if (supplierId) filter.supplierId = supplierId;

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filter.date.$lte = toDate;
      }
    }

    if (q && q.trim()) {
      const safeQ = escapeRegex(q.trim());
      filter.$or = [
        { grnNo: { $regex: safeQ, $options: "i" } },
        { supplierName: { $regex: safeQ, $options: "i" } },
        { supplierInvoiceRef: { $regex: safeQ, $options: "i" } },
      ];
    }

    const grns = await GRN.find(filter).sort({ date: -1 }).limit(300);
    res.status(200).json(grns);
  } catch (error) {
    console.error("Failed to fetch GRN List", error);
    res.status(500).json({ message: "Failed to fetch the GRN list" });
  }
});

// 6.6 🆕 Single GRN (full details for Print/PDF view)
router.get("/grn/:id", async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id);
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    res.status(200).json(grn);
  } catch (error) {
    console.error("Failed to fetch GRN", error);
    res.status(500).json({ message: "Failed to fetch the GRN" });
  }
});

// 7. Pay money to a Supplier (Settle Payment)
// 🐛 BUG FIX: Previously, if more than the amount owed to the supplier was paid (by mistake or e.g. a round-figure
// cheque), even though balanceDue was clamped to 0, the entire amount was recorded in the ledger as a "payment" -
// there was no record at all of the amount paid over what was actually owed (the "change"
// that should be returned).
// 🆕 SHIFT RECONCILIATION: Now records the Payment Method (Cash/Card/Bank Transfer/Other) and which Admin
// made this payment - only "Cash" payments are deducted from the Cash Drawer calculation at Shift Close.
router.post("/pay/:id", requireOpenShift({ onlyIfCash: true }), async (req, res) => {
  const { amount, paymentMethod } = req.body;
  const paidAmount = Number(amount);
  const validMethods = ["Cash", "Card", "Bank Transfer", "Other"];
  const method = validMethods.includes(paymentMethod) ? paymentMethod : "Cash";

  if (!paidAmount || paidAmount <= 0) {
    return res.status(400).json({ message: "Please enter a valid amount!" });
  }

  // 🔐 TRANSACTIONS: Like record-purchase, this is also wrapped in a session.withTransaction() -
  // to protect against a "lost update" race between concurrent writes.
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(req.params.id).session(session);
      if (!supplier) throw new RouteError(404, "Supplier not found");

      const currentDue = supplier.balanceDue || 0;

      // 🆕 FIX: A "payment" cannot be recorded for a supplier with no amount owed - there is something to settle
      // only if balanceDue is greater than 0.
      if (currentDue <= 0) {
        throw new RouteError(400, "This supplier has no outstanding amount payable! No payment is required.");
      }

      // Only up to the remaining credit amount of the paid amount is actually applied to balanceDue
      const appliedAmount = Math.round(Math.min(paidAmount, currentDue) * 100) / 100;
      // The remainder (the amount paid over the credit) - the "change" that must be returned
      const changeGiven = Math.round((paidAmount - appliedAmount) * 100) / 100;

      supplier.balanceDue = Math.max(0, Math.round((currentDue - appliedAmount) * 100) / 100);

      supplier.ledger.push({
        type: "payment",
        amount: appliedAmount,
        paidAmount,
        changeGiven,
        cashier: req.user.username,
        paymentMethod: method,
        description: changeGiven > 0
          ? `Payment made (Amount paid: Rs.${paidAmount.toFixed(2)}, Applied to credit: Rs.${appliedAmount.toFixed(2)}, Change returned: Rs.${changeGiven.toFixed(2)}) - ${method}`
          : `Payment made - ${method}`,
        date: new Date(),
      });

      await supplier.save({ session });

      responsePayload = {
        message: changeGiven > 0
          ? `Payment recorded successfully! 💵 Change to be returned: Rs.${changeGiven.toFixed(2)}`
          : "Payment recorded successfully! 💵",
        supplier,
        appliedAmount,
        changeGiven
      };
    });

    res.status(200).json(responsePayload);
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Failed to make payment", error);
    res.status(500).json({ message: "Failed to make payment" });
  } finally {
    await session.endSession();
  }
});

module.exports = router;