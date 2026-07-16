const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    marketPrice: { type: Number },
    costPrice: { type: Number },
    stock: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    barcode: { type: String },
    // 🛠️ UPDATED LINE: Unit එක Database එකේ සේව් කරගැනීමට Schema එකට ඇතුලත් කලා
    unit: { type: String, default: "Kg" },
    category: { type: String, enum: ["Grocery", "Vegetables", "Fruits", "Beverages", "Dairy", "Bakery", "Cosmetics", "Household", "Other"], default: "Grocery"}
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);