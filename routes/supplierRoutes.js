const express = require("express");
const mongoose = require("mongoose"); // 🔐 needed for session/transaction support
const router = express.Router();
const RouteError = require("../utils/RouteError");
const Supplier = require("../models/Supplier");
const Product = require("../models/Product");
// 🔐 note: this entire router is mounted behind `protect` + `requireAdmin` in server.js —
// supplier management (purchases, balances, payments) is admin-only, no per-route changes needed here.

// Regex special characters escape කිරීම (Regex Injection වළක්වන්න)
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// 6. 🛠️ UPDATED (Step 2 - GRN Multi-item): Supplier Invoice එකකින් Products කිහිපයක් එකවර ලැබුණු බව සටහන් කිරීම
// items: [{ productId, quantity, costPrice }, ...] - එකම Supplier Invoice එකකින් ආපු product ගණන කීයක් හෝ පිළිගනී
router.post("/record-purchase/:id", async (req, res) => {
  const { items, description } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "අවම වශයෙන් භාණ්ඩයක් හෝ GRN List එකට එකතු කරන්න!" });
  }

  // 🔐 TRANSACTIONS: කලින් comment එකේම කිව්වා "එකක් හරි fail වුනොත් කිසිවක් save වෙන්නේ නැහැ"
  // කියලා - ඒත් ඇත්තටම code එක එහෙම වැඩ කලේ නෑ! item 3 fail උනොත්, item 1,2 ගේ stock
  // දැනටමත් save වෙලා ඉවරයි. දැන් session.withTransaction() එකෙන් ඇත්තටම all-or-nothing කරයි.
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(req.params.id).session(session);
      if (!supplier) throw new RouteError(404, "සැපයුම්කරු සොයාගත නොහැක");

      let grandTotal = 0;
      const ledgerItems = [];

      // සියලුම items validate + process කරයි
      for (const item of items) {
        const qty = parseFloat(item.quantity);
        const cost = parseFloat(item.costPrice);

        if (!item.productId || !qty || qty <= 0 || !cost || cost <= 0) {
          throw new RouteError(400, "සියලුම භාණ්ඩ වල නිවැරදි ප්‍රමාණයක් සහ මිලක් තිබිය යුතුයි!");
        }

        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          throw new RouteError(404, "එක් භාණ්ඩයක් සොයාගත නොහැක - GRN List එක නැවත පරීක්ෂා කරන්න");
        }

        // 🛠️ stockMode "set" නම් - වත්මන් තොගය මේ ප්‍රමාණයටම සකසයි (Opening/Correction Stock සඳහා)
        //    stockMode "add" (default) නම් - වත්මන් තොගයට මේ ප්‍රමාණය එකතු කරයි (සාමාන්‍ය GRN සඳහා)
        const stockMode = item.stockMode === "set" ? "set" : "add";
        if (stockMode === "set") {
          product.stock = qty;
        } else {
          product.stock = parseFloat(product.stock || 0) + qty;
        }
        product.costPrice = cost;
        await product.save({ session });

        const subtotal = qty * cost;
        grandTotal += subtotal;

        ledgerItems.push({
          productName: product.name,
          quantity: qty,
          costPrice: cost,
          subtotal,
          stockMode,
        });
      }

      // 💰 Grand Total එක Supplier ගේ Balance Due එකට එකතු කර, එකම Ledger Entry එකක් log කරයි
      supplier.balanceDue += grandTotal;
      supplier.ledger.push({
        type: "purchase",
        amount: grandTotal,
        description: description || `GRN - භාණ්ඩ ${ledgerItems.length}ක් ලැබුණි`,
        items: ledgerItems,
        date: new Date(),
      });

      await supplier.save({ session });

      responsePayload = {
        message: `Stock ලැබීම සාර්ථකව සටහන් කලා! 📦 (භාණ්ඩ ${ledgerItems.length}ක්, මුළු ගණන: රු.${grandTotal.toFixed(2)})`,
        supplier,
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