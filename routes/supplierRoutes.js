const express = require("express");
const mongoose = require("mongoose"); // 🔐 needed for session/transaction support
const router = express.Router();
const RouteError = require("../utils/RouteError");
const Supplier = require("../models/Supplier");
const Product = require("../models/Product");
const GRN = require("../models/GRN"); // 🆕 Professional GRN document
const Counter = require("../models/Counter"); // 🆕 Sequential GRN numbering (same pattern as Invoice No)
// 🔐 note: this entire router is mounted behind `protect` + `requireAdmin` in server.js —
// supplier management (purchases, balances, payments) is admin-only, no per-route changes needed here.

// Regex special characters escape කිරීම (Regex Injection වළක්වන්න)
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const roundQty = (num) => Math.round((parseFloat(num) || 0) * 1000) / 1000;
const round2 = (num) => Math.round((parseFloat(num) || 0) * 100) / 100;

// 🆕 PROFESSIONAL SEQUENTIAL GRN NUMBER GENERATOR - Invoice No එකේම pattern එක
// GRN-20260101-0001 වගේ, දවසකට 0001 ඉඳන් restart වෙනවා (Real GRN Document Style)
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

// 1. අලුත් Supplier කෙනෙක් ඇතුලත් කිරීම
router.post("/add", async (req, res) => {
  try {
    const { name, phone, address } = req.body;

    const existing = await Supplier.findOne({ phone });
    if (existing) {
      return res.status(400).json({ message: "මෙම දුරකථන අංකය දැනටමත් Supplier කෙනෙක් සතුව ඇත! ❌" });
    }

    const newSupplier = new Supplier({ name, phone, address });
    await newSupplier.save();
    res.status(201).json({ message: "සැපයුම්කරු සාර්ථකව ඇතුලත් කලා! 🚚", supplier: newSupplier });
  } catch (error) {
    console.error("ඇතුලත් කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි" });
  }
});

// 2. සියලුම Suppliers ලබාගැනීම
router.get("/", async (req, res) => {
  try {
    const suppliers = await Supplier.find().sort({ name: 1 });
    res.status(200).json(suppliers);
  } catch (error) {
    console.error("දත්ත ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි" });
  }
});

// 3. Supplier කෙනෙක් නමින් හෝ දුරකථන අංකයෙන් සෙවීම (Live Search)
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
    console.error("සෙවීම අසාර්ථකයි", error);
    res.status(500).json({ message: "සෙවීම අසාර්ථකයි" });
  }
});

// 4. Supplier විස්තර යාවත්කාලීන කිරීම
router.put("/update/:id", async (req, res) => {
  try {
    const updatedSupplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, {
      returnDocument: "after",
      runValidators: true,
    });

    if (!updatedSupplier) {
      return res.status(404).json({ message: "සැපයුම්කරු සොයාගත නොහැක" });
    }

    res.json({ message: "විස්තර යාවත්කාලීන කිරීම සාර්ථකයි! 🔄", supplier: updatedSupplier });
  } catch (error) {
    console.error("යාවත්කාලීන කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි" });
  }
});

// 5. Supplier කෙනෙක් මකා දැමීම
router.delete("/delete/:id", async (req, res) => {
  try {
    const deletedSupplier = await Supplier.findByIdAndDelete(req.params.id);
    if (!deletedSupplier) {
      return res.status(404).json({ message: "සැපයුම්කරු සොයාගත නොහැක" });
    }
    res.json({ message: "මකා දැමීම සාර්ථකයි! 🗑️" });
  } catch (error) {
    console.error("මකා දැමීම අසාර්ථකයි", error);
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි" });
  }
});

// 6. 🆕 PROFESSIONAL GRN REBUILD: Supplier Invoice එකකින් Products කිහිපයක් එකවර ලැබුණු බව සටහන් කිරීම
// items: [{ productId, orderedQty, receivedQty, costPrice, expiryDate, stockMode }, ...]
//
// 🐛 FIX (core bug this rebuild solves): කලින් මෙතන product.stock විතරක් update කලා, batches[] array එක
// කවදාවත් update කලේ නෑ. Frontend එකේ getTotalStock() batches තියෙනවා නම් batches[].stock එකතුවයි
// return කරන්නේ product.stock එක බලන්නේම නෑ - ඒ නිසා GRN එකෙන් ලැබුණු stock එක catalog/dashboard/checkout
// කොහේවත් පේන්නේ නැතුව "අතුරුදහන්" වුනා. දැන් "add" mode එකේදී අලුත් Batch එකක් හදලා, ඒකේම Cost Price
// සහ Expiry Date එකත් සටහන් කරලා, product.stock එකත් batches[].stock එකත් එකවර atomic විදිහට $inc කරනවා -
// checkout/void/return routes වල already පාවිච්චි කරන dual-field pattern එකමයි.
router.post("/record-purchase/:id", async (req, res) => {
  const { items, description, supplierInvoiceRef, receivedBy } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "අවම වශයෙන් භාණ්ඩයක් හෝ GRN List එකට එකතු කරන්න!" });
  }

  // 🔐 TRANSACTIONS: GRN document එක, Product batches[] update එක, Supplier ledger entry එක -
  // මේ හැම දේම එකවර සාර්ථක වෙන්න ඕන, එකක් fail උනොත් කිසිවක් save වෙන්නේ නෑ (all-or-nothing).
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(req.params.id).session(session);
      if (!supplier) throw new RouteError(404, "සැපයුම්කරු සොයාගත නොහැක");

      const grnNo = await generateGrnNo(session);

      let grandTotal = 0;
      let overallHasDiscrepancy = false;
      let anyPartial = false;
      const ledgerItems = []; // backward-compatible Supplier.ledger items (legacy shape, used by existing ledger modal)
      const grnItems = []; // full new GRN.items (richer shape)

      // සියලුම items validate + process කරයි
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const receivedQty = roundQty(item.receivedQty ?? item.quantity); // 🔐 "quantity" = legacy field name, backward compat
        const orderedQty = roundQty(item.orderedQty || 0);
        const cost = parseFloat(item.costPrice);

        if (!item.productId || !receivedQty || receivedQty <= 0 || !cost || cost <= 0) {
          throw new RouteError(400, "සියලුම භාණ්ඩ වල නිවැරදි ලැබුණු ප්‍රමාණයක් සහ මිලක් තිබිය යුතුයි!");
        }

        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          throw new RouteError(404, "එක් භාණ්ඩයක් සොයාගත නොහැක - GRN List එක නැවත පරීක්ෂා කරන්න");
        }

        const expiryDate = item.expiryDate ? new Date(item.expiryDate) : null;
        const stockMode = item.stockMode === "set" ? "set" : "add";

        // 🆕 Discrepancy check: Ordered Qty සටහන් කරලා තියෙනවා නම්, Received Qty එකට සමාන නැත්නම් flag කරයි
        const lineHasDiscrepancy = orderedQty > 0 && orderedQty !== receivedQty;
        if (lineHasDiscrepancy) {
          overallHasDiscrepancy = true;
          if (receivedQty < orderedQty) anyPartial = true;
        }

        let newBatchId = "";

        if (stockMode === "set") {
          // 🛠️ "Replace/Set" = Opening Stock හෝ Correction සඳහා පමණි - batches කිහිපයක් තියෙනවා නම්
          // කුමන batch එක replace කරන්නද කියන අපැහැදිලි බව නිසා, batch 0 හෝ 1ක් ඇති products වලට විතරක් ඉඩ දෙයි.
          if (Array.isArray(product.batches) && product.batches.length > 1) {
            throw new RouteError(
              400,
              `"${product.name}" භාණ්ඩයට Batch කිහිපයක් දැනටමත් තිබෙන නිසා "Replace" mode පාවිච්චි කරන්න බෑ - Stock Management එකෙන් එක් එක් Batch එක සකසන්න.`
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
          // 🆕 "Add" (සාමාන්‍ය GRN) = අලුත් Batch එකක් හදලා, ඒකේම Cost Price + Expiry Date සටහන් කරයි -
          // පරණ batch එකේ cost price එක සමග මිශ්‍ර නොවී, batch එකින් එක නිවැරදි ලාභ ගණනය සඳහා වෙන්ව තියෙනවා.
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
            throw new RouteError(404, "එක් භාණ්ඩයක් සොයාගත නොහැක - GRN List එක නැවත පරීක්ෂා කරන්න");
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

      // 📄 GRN Document එක හදයි (Print/PDF + History සඳහා)
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

      // 💰 Grand Total එක Supplier ගේ Balance Due එකට එකතු කර, Legacy Ledger Entry එකක්ද තියාගනියි
      // (Supplier Details Modal එක දැනටමත් මේ shape එකෙන් data පෙන්වන නිසා backward-compat සඳහා)
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
        message: `GRN ${grnNo} සාර්ථකව සටහන් කලා! 📦 (භාණ්ඩ ${grnItems.length}ක්, මුළු ගණන: රු.${grandTotal.toFixed(2)})`,
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
    res.status(500).json({ message: "සටහන් කිරීම අසාර්ථකයි" });
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
    console.error("GRN List ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "GRN ලැයිස්තුව ලබාගැනීම අසාර්ථකයි" });
  }
});

// 6.6 🆕 Single GRN (Print/PDF view සඳහා සම්පූර්ණ විස්තර)
router.get("/grn/:id", async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id);
    if (!grn) return res.status(404).json({ message: "GRN එක සොයාගත නොහැක" });
    res.status(200).json(grn);
  } catch (error) {
    console.error("GRN ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "GRN එක ලබාගැනීම අසාර්ථකයි" });
  }
});

// 7. Supplier ට මුදල් ගෙවීම (Settle Payment)
// 🐛 BUG FIX: කලින් supplier ට ගෙවන්න ඕන ප්‍රමාණයට වඩා වැඩි මුදලක් (වැරදීමකින් හෝ උදා: round-figure
// චෙක් එකක්) ගෙව්වොත්, balanceDue 0ට clamp කලත්, ledger එකේ සම්පූර්ණ ගණනම "payment" විදිහට
// සටහන් වුනා - ඇත්තටම ගෙවන්න ඕන ප්‍රමාණයට වඩා වැඩි ගණන (ආපසු ලැබෙන්න ඕන "change" එක) ගැන record
// එකක්ම තිබුණේ නෑ.
router.post("/pay/:id", async (req, res) => {
  const { amount } = req.body;
  const paidAmount = Number(amount);

  if (!paidAmount || paidAmount <= 0) {
    return res.status(400).json({ message: "නිවැරදි මුදලක් ඇතුලත් කරන්න!" });
  }

  // 🔐 TRANSACTIONS: record-purchase එකේ වගේම, මේකත් session.withTransaction() එකකින් wrap කලා -
  // concurrent writes අතරේ "lost update" race එකකින් ආරක්ෂා වෙන්න.
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(req.params.id).session(session);
      if (!supplier) throw new RouteError(404, "සැපයුම්කරු සොයාගත නොහැක");

      const currentDue = supplier.balanceDue || 0;

      // 🆕 FIX: ගෙවීමට ඇති මුදලක් නැති supplier කෙනෙකුට "ගෙවීමක්" record කරන්න බෑ - balanceDue
      // 0ට වඩා තිබුනොත් විතරයි settle කරන්න ඕන දෙයක් තියෙන්නේ.
      if (currentDue <= 0) {
        throw new RouteError(400, "මෙම සැපයුම්කරුට ගෙවීමට ඇති මුදලක් නැත! ගෙවීමක් අවශ්‍ය නොවේ.");
      }

      // balanceDue එකට ඇත්තටම යෙදෙන්නේ, ගෙවපු මුදලෙන් ණයට ඉතිරිව තියෙන ප්‍රමාණය දක්වා විතරයි
      const appliedAmount = Math.round(Math.min(paidAmount, currentDue) * 100) / 100;
      // ඉතුරු (ණයට වඩා ගෙවපු) මුදල - ආපසු ලැබෙන්න ඕන "change" එක
      const changeGiven = Math.round((paidAmount - appliedAmount) * 100) / 100;

      supplier.balanceDue = Math.max(0, Math.round((currentDue - appliedAmount) * 100) / 100);

      supplier.ledger.push({
        type: "payment",
        amount: appliedAmount,
        paidAmount,
        changeGiven,
        description: changeGiven > 0
          ? `ගෙවීමක් සිදු කිරීම (ගෙවූ මුදල: රු.${paidAmount.toFixed(2)}, ණයට යෙදුවේ: රු.${appliedAmount.toFixed(2)}, ආපසු ලැබුණු මුදල: රු.${changeGiven.toFixed(2)})`
          : "ගෙවීමක් සිදු කිරීම",
        date: new Date(),
      });

      await supplier.save({ session });

      responsePayload = {
        message: changeGiven > 0
          ? `ගෙවීම සාර්ථකව සටහන් කලා! 💵 ආපසු ලැබෙන්න ඕන මුදල: රු.${changeGiven.toFixed(2)}`
          : "ගෙවීම සාර්ථකව සටහන් කලා! 💵",
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
    console.error("ගෙවීම අසාර්ථකයි", error);
    res.status(500).json({ message: "ගෙවීම අසාර්ථකයි" });
  } finally {
    await session.endSession();
  }
});

module.exports = router;