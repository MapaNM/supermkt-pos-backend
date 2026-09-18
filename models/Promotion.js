const mongoose = require("mongoose");

const promotionSchema = new mongoose.Schema(
  {
    // 🆕 "occasion" - විශේෂ අවස්ථා (New Year, Festival ආදී) සඳහා, "loyalty" - Loyalty Card Holders සඳහා
    type: { type: String, enum: ["occasion", "loyalty"], required: true },
    name: { type: String, required: true }, // උදා: "අවුරුදු උත්සවය 2026", "Loyalty Member Discount"
    discountPercent: { type: Number, required: true }, // Bill Total එකෙන් අඩු කරන % එක
    isActive: { type: Boolean, default: false }, // එකවර එකම type එකකින් එකක් විතරයි active විය හැක (Route එකෙන් enforce කරයි)
  },
  { timestamps: true }
);

module.exports = mongoose.model("Promotion", promotionSchema);