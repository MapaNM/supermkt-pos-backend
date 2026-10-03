const express = require("express");
const router = express.Router();
const Promotion = require("../models/Promotion");
const { requireAdmin } = require("../middleware/auth"); // 🔐 note: `protect` already applied at /api/promotions in server.js

// 1. සියලුම Promotions ලබාගැනීම (Billing Screen එකටත්, Admin Panel එකටත් දෙකටම)
router.get("/", async (req, res) => {
  try {
    const promotions = await Promotion.find().sort({ type: 1, createdAt: -1 });
    res.status(200).json(promotions);
  } catch (error) {
    console.error("දත්ත ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි" });
  }
});

// 2. අලුත් Promotion එකක් ඇතුලත් කිරීම
router.post("/add", requireAdmin, async (req, res) => {
  try {
    const { type, name, discountPercent } = req.body;
    if (!["occasion", "loyalty"].includes(type)) {
      return res.status(400).json({ message: "Type එක 'occasion' හෝ 'loyalty' විය යුතුය" });
    }
    const newPromotion = new Promotion({ type, name, discountPercent, isActive: false });
    await newPromotion.save();
    res.status(201).json({ message: "Promotion එක සාර්ථකව ඇතුලත් කලා! 🎉", promotion: newPromotion });
  } catch (error) {
    console.error("ඇතුලත් කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි" });
  }
});

// 3. Promotion එකක් Update කිරීම
router.put("/update/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await Promotion.findByIdAndUpdate(req.params.id, req.body, { returnDocument: "after", runValidators: true });
    if (!updated) return res.status(404).json({ message: "Promotion එක සොයාගත නොහැක" });
    res.json({ message: "යාවත්කාලීන කිරීම සාර්ථකයි! 🔄", promotion: updated });
  } catch (error) {
    console.error("යාවත්කාලීන කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි" });
  }
});

// 4. Promotion එකක් Activate කිරීම (එකම type එකේ අනිත් සියල්ල auto-deactivate වේ - එකවර active විය හැක්කේ එකයි)
router.put("/activate/:id", requireAdmin, async (req, res) => {
  try {
    const promotion = await Promotion.findById(req.params.id);
    if (!promotion) return res.status(404).json({ message: "Promotion එක සොයාගත නොහැක" });

    // 🛠️ එකම Type එකේ (occasion/loyalty) අනිත් සියලුම Promotions deactivate කරයි
    await Promotion.updateMany({ type: promotion.type, _id: { $ne: promotion._id } }, { isActive: false });

    promotion.isActive = true;
    await promotion.save();

    res.json({ message: `"${promotion.name}" Activate කලා! ✅`, promotion });
  } catch (error) {
    console.error("Activate කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Activate කිරීම අසාර්ථකයි" });
  }
});

// 5. Promotion එකක් Deactivate කිරීම
router.put("/deactivate/:id", requireAdmin, async (req, res) => {
  try {
    const promotion = await Promotion.findByIdAndUpdate(req.params.id, { isActive: false }, { returnDocument: "after" });
    if (!promotion) return res.status(404).json({ message: "Promotion එක සොයාගත නොහැක" });
    res.json({ message: `"${promotion.name}" Deactivate කලා!`, promotion });
  } catch (error) {
    console.error("Deactivate කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Deactivate කිරීම අසාර්ථකයි" });
  }
});

// 6. Promotion එකක් මකා දැමීම
router.delete("/delete/:id", requireAdmin, async (req, res) => {
  try {
    await Promotion.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Promotion එක මකා දැමුවා! 🗑️" });
  } catch (error) {
    console.error("මකා දැමීම අසාර්ථකයි", error);
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි" });
  }
});

module.exports = router;