const mongoose = require("mongoose");

// 🆕 PROFESSIONAL GRN (Goods Received Note) MODEL
// කලින් GRN කියන්නෙ Supplier.ledger එකේ "purchase" entry එකක් විතරයි - standalone document එකක් තිබුණේ නෑ.
// දැන් හැම Stock ලැබීමක්ම තමන්ගේම numbered document එකක් විදිහට (GRN-20260101-0001 වගේ) සටහන් වෙනවා,
// Print/PDF කරන්න පුලුවන්, History එකේ search/filter කරන්න පුලුවන්, Ordered vs Received වෙනස (Discrepancy)
// track කරන්න පුලුවන් විදිහට.

const grnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true }, // 🔐 denormalized - Product එක පස්සේ rename/delete උනත් GRN history එක නිවැරදිව පෙන්වන්න
    unit: { type: String, default: "Kg" },

    // 🆕 Ordered vs Received - Supplier Invoice/PO එකේ ඉල්ලපු ප්‍රමාණයට සාපේක්ෂව ඇත්තටම ලැබුණු ප්‍රමාණය
    orderedQty: { type: Number, default: 0 }, // 0 = "Order Qty" නොදන්නා/සටහන් නොකල අවස්ථාවක් (discrepancy check එකෙන් නිකුත් කෙරේ)
    receivedQty: { type: Number, required: true },

    costPrice: { type: Number, required: true },
    subtotal: { type: Number, required: true }, // receivedQty * costPrice

    expiryDate: { type: Date, default: null }, // 🆕 මේ Batch එකේ Expiry Date එක
    batchId: { type: String, default: "" }, // මේ ලැබීමෙන් Product.batches[] එකේ හැදුන batch එකේ id එක (traceability)
    stockMode: { type: String, enum: ["add", "set"], default: "add" },

    // 🆕 Line-level discrepancy flag - orderedQty සටහන් කරලා, ඒකට වඩා අඩුවෙන්/වැඩියෙන් ලැබුනොත් true
    hasDiscrepancy: { type: Boolean, default: false },
  },
  { _id: false }
);

const grnSchema = new mongoose.Schema(
  {
    grnNo: { type: String, required: true, unique: true }, // GRN-20260101-0001

    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    supplierName: { type: String, required: true }, // denormalized

    supplierInvoiceRef: { type: String, default: "" }, // 🆕 සැපයුම්කරුගේ Invoice/Delivery Note අංකය
    notes: { type: String, default: "" },

    items: [grnItemSchema],
    grandTotal: { type: Number, required: true },

    // 🆕 Status: Received = සියල්ල ඉල්ලූ ප්‍රමාණයටම ලැබුණා, Partially Received = අඩුවෙන් ලැබුණු item එකක් හෝ තියෙනවා,
    // Discrepancy = ඉල්ලූවාට වඩා වැඩියෙන් හෝ, qty mismatch වෙනත් ආකාරයක තියෙනවා
    status: {
      type: String,
      enum: ["Received", "Partially Received", "Discrepancy"],
      default: "Received",
    },
    hasDiscrepancy: { type: Boolean, default: false },

    receivedBy: { type: String, default: "" }, // admin username ගේ සටහන

    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

grnSchema.index({ supplierId: 1, date: -1 });
grnSchema.index({ grnNo: 1 });

module.exports = mongoose.model("GRN", grnSchema);