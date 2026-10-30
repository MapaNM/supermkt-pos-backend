const express = require("express");
const router = express.Router();
const Promotion = require("../models/Promotion");
const { requireAdmin } = require("../middleware/auth"); // 🔐 note: `protect` already applied at /api/promotions in server.js

// 1. Get all Promotions (for both the Billing Screen and the Admin Panel)
router.get("/", async (req, res) => {
  try {
    const promotions = await Promotion.find().sort({ type: 1, createdAt: -1 });
    res.status(200).json(promotions);
  } catch (error) {
    console.error("Failed to fetch data", error);
    res.status(500).json({ message: "Failed to fetch data" });
  }
});

// 2. Add a new Promotion
router.post("/add", requireAdmin, async (req, res) => {
  try {
    const { type, name, discountPercent } = req.body;
    if (!["occasion", "loyalty"].includes(type)) {
      return res.status(400).json({ message: "Type must be either 'occasion' or 'loyalty'" });
    }
    const newPromotion = new Promotion({ type, name, discountPercent, isActive: false });
    await newPromotion.save();
    res.status(201).json({ message: "Promotion added successfully! 🎉", promotion: newPromotion });
  } catch (error) {
    console.error("Failed to add", error);
    res.status(500).json({ message: "Failed to add" });
  }
});

// 3. Update a Promotion
// 🔐 SECURITY FIX: Previously the whole req.body was passed into the DB update (Mass-Assignment
// Vulnerability) - by adding an extra field (e.g. isActive) to the request body, the "Activate/Deactivate"
// routes could be bypassed and multiple Promotions of the same type could be activated at once. Now only the fields
// this Form actually sends (name, discountPercent, type) are allow-listed, and isActive
// is controlled only by the /activate and /deactivate routes.
router.put("/update/:id", requireAdmin, async (req, res) => {
  try {
    const { name, discountPercent, type } = req.body;
    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (discountPercent !== undefined) updateFields.discountPercent = discountPercent;
    if (type !== undefined) updateFields.type = type;

    const updated = await Promotion.findByIdAndUpdate(req.params.id, updateFields, { returnDocument: "after", runValidators: true });
    if (!updated) return res.status(404).json({ message: "Promotion not found" });
    res.json({ message: "Updated successfully! 🔄", promotion: updated });
  } catch (error) {
    console.error("Failed to update", error);
    res.status(500).json({ message: "Failed to update" });
  }
});

// 4. Activate a Promotion (all others of the same type are auto-deactivated - only one can be active at a time)
router.put("/activate/:id", requireAdmin, async (req, res) => {
  try {
    const promotion = await Promotion.findById(req.params.id);
    if (!promotion) return res.status(404).json({ message: "Promotion not found" });

    // 🛠️ Deactivates all other Promotions of the same Type (occasion/loyalty)
    await Promotion.updateMany({ type: promotion.type, _id: { $ne: promotion._id } }, { isActive: false });

    promotion.isActive = true;
    await promotion.save();

    res.json({ message: `"${promotion.name}" Activated! ✅`, promotion });
  } catch (error) {
    console.error("Failed to Activate", error);
    res.status(500).json({ message: "Failed to Activate" });
  }
});

// 5. Deactivate a Promotion
router.put("/deactivate/:id", requireAdmin, async (req, res) => {
  try {
    const promotion = await Promotion.findByIdAndUpdate(req.params.id, { isActive: false }, { returnDocument: "after" });
    if (!promotion) return res.status(404).json({ message: "Promotion not found" });
    res.json({ message: `"${promotion.name}" Deactivated!`, promotion });
  } catch (error) {
    console.error("Failed to Deactivate", error);
    res.status(500).json({ message: "Failed to Deactivate" });
  }
});

// 6. Delete a Promotion
router.delete("/delete/:id", requireAdmin, async (req, res) => {
  try {
    await Promotion.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Promotion deleted! 🗑️" });
  } catch (error) {
    console.error("Failed to delete", error);
    res.status(500).json({ message: "Failed to delete" });
  }
});

module.exports = router;