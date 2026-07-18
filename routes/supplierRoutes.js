const express = require("express");
const router = express.Router();
const Supplier = require("../models/Supplier");
const Product = require("../models/Product");

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
    res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි", error: error.message });
  }
});

// 2. සියලුම Suppliers ලබාගැනීම
router.get("/", async (req, res) => {
  try {
    const suppliers = await Supplier.find().sort({ name: 1 });
    res.status(200).json(suppliers);
  } catch (error) {
    res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි", error: error.message });
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
    res.status(500).json({ message: "සෙවීම අසාර්ථකයි", error: error.message });
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
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි", error: error.message });
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
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි", error: error.message });
  }
});

// 6. 🛠️ UPDATED (Step 2 - GRN Multi-item): Supplier Invoice එකකින් Products කිහිපයක් එකවර ලැබුණු බව සටහන් කිරීම
// items: [{ productId, quantity, costPrice }, ...] - එකම Supplier Invoice එකකින් ආපු product ගණන කීයක් හෝ පිළිගනී
router.post("/record-purchase/:id", async (req, res) => {
  try {
    const { items, description } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "අවම වශයෙන් භාණ්ඩයක් හෝ GRN List එකට එකතු කරන්න!" });
    }

    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ message: "සැපයුම්කරු සොයාගත නොහැක" });

    let grandTotal = 0;
    const ledgerItems = [];

    // සියලුම items validate + process කරයි (එකක් හරි fail වුනොත් කිසිවක් save වෙන්නේ නැහැ)
    for (const item of items) {
      const qty = parseFloat(item.quantity);
      const cost = parseFloat(item.costPrice);

      if (!item.productId || !qty || qty <= 0 || !cost || cost <= 0) {
        return res.status(400).json({ message: "සියලුම භාණ්ඩ වල නිවැරදි ප්‍රමාණයක් සහ මිලක් තිබිය යුතුයි!" });
      }

      const product = await Product.findById(item.productId);
      if (!product) {
        return res.status(404).json({ message: "එක් භාණ්ඩයක් සොයාගත නොහැක - GRN List එක නැවත පරීක්ෂා කරන්න" });
      }

      // 🛠️ NEW: stockMode "set" නම් - වත්මන් තොගය මේ ප්‍රමාණයටම සකසයි (Opening/Correction Stock සඳහා)
      //          stockMode "add" (default) නම් - වත්මන් තොගයට මේ ප්‍රමාණය එකතු කරයි (සාමාන්‍ය GRN සඳහා)
      const stockMode = item.stockMode === "set" ? "set" : "add";
      if (stockMode === "set") {
        product.stock = qty;
      } else {
        product.stock = parseFloat(product.stock || 0) + qty;
      }
      product.costPrice = cost;
      await product.save();

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

    await supplier.save();

    res.status(200).json({
      message: `Stock ලැබීම සාර්ථකව සටහන් කලා! 📦 (භාණ්ඩ ${ledgerItems.length}ක්, මුළු ගණන: රු.${grandTotal.toFixed(2)})`,
      supplier,
    });
  } catch (error) {
    res.status(500).json({ message: "සටහන් කිරීම අසාර්ථකයි", error: error.message });
  }
});

// 7. Supplier ට මුදල් ගෙවීම (Settle Payment)
router.post("/pay/:id", async (req, res) => {
  try {
    const { amount } = req.body;
    const paidAmount = Number(amount);

    if (!paidAmount || paidAmount <= 0) {
      return res.status(400).json({ message: "නිවැරදි මුදලක් ඇතුලත් කරන්න!" });
    }

    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ message: "සැපයුම්කරු සොයාගත නොහැක" });

    supplier.balanceDue -= paidAmount;
    if (supplier.balanceDue < 0) supplier.balanceDue = 0;

    supplier.ledger.push({
      type: "payment",
      amount: paidAmount,
      description: "ගෙවීමක් සිදු කිරීම",
      date: new Date(),
    });

    await supplier.save();
    res.status(200).json({ message: "ගෙවීම සාර්ථකව සටහන් කලා! 💵", supplier });
  } catch (error) {
    res.status(500).json({ message: "ගෙවීම අසාර්ථකයි", error: error.message });
  }
});

module.exports = router;