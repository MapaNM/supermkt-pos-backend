const mongoose = require("mongoose");

const batchSchema = new mongoose.Schema(
  {
    batchId: { type: String, required: true }, // e.g. "B-1", "B-2" හෝ "2026-08-A"
    label: { type: String, default: "" }, // 🆕 MULTI-PRICE POPUP: "පැරණි මිල" / "නව මිල" වගේ Cashier ට පේන name එක (Optional)
    price: { type: Number, required: true },
    costPrice: { type: Number, default: 0 },
    marketPrice: { type: Number, default: 0 },
    discount: { type: Number, default: 0 }, // 🆕 මේ Batch එකටම ආවේණික වට්ටම % එක - වාර්තා වලදී නිවැරදි ලාභ ගණනය සඳහා
    stock: { type: Number, default: 0 },
    expiryDate: { type: Date, default: null },
  },
  { timestamps: true }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true }, // Default / Latest Price
    marketPrice: { type: Number, default: 0 },
    costPrice: { type: Number, default: 0 },
    stock: { type: Number, required: true, default: 0 }, // Total Stock across all batches
    discount: { type: Number, default: 0 },
    barcode: { type: String, default: "" },
    unit: { type: String, default: "Kg" },
    category: { 
      type: String, 
      enum: ["Grocery", "Vegetables", "Fruits", "Beverages", "Snacks", "Sweets", "Biscuits", "Dairy", "Bakery", "Cosmetics", "Household", "Other"], 
      default: "Grocery" 
    },
    minStockLevel: { type: Number, default: 5 },  // Reorder Alert Level
    preferredSupplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    expiryDate: { type: Date, default: null },
    
    // 🏷️ MULTI-PRICE & BATCH TRACKING
    batches: [batchSchema]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);