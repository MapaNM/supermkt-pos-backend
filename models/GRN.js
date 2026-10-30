const mongoose = require("mongoose");

// 🆕 PROFESSIONAL GRN (Goods Received Note) MODEL
// Previously, a GRN was just a "purchase" entry in Supplier.ledger - there was no standalone document.
// Now every Stock receipt is recorded as its own numbered document (like GRN-20260101-0001),
// which can be Printed/PDF'd, searched/filtered in History, and used to
// track the difference between Ordered vs Received (Discrepancy).

const grnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true }, // 🔐 denormalized - so the GRN history still displays correctly even if the Product is later renamed/deleted
    unit: { type: String, default: "Kg" },

    // 🆕 Ordered vs Received - the quantity actually received relative to the quantity requested on the Supplier Invoice/PO
    orderedQty: { type: Number, default: 0 }, // 0 = a case where the "Order Qty" is unknown/not recorded (excluded from the discrepancy check)
    receivedQty: { type: Number, required: true },

    costPrice: { type: Number, required: true },
    subtotal: { type: Number, required: true }, // receivedQty * costPrice

    expiryDate: { type: Date, default: null }, // 🆕 The Expiry Date of this Batch
    batchId: { type: String, default: "" }, // the id of the batch created in Product.batches[] from this receipt (traceability)
    stockMode: { type: String, enum: ["add", "set"], default: "add" },

    // 🆕 Line-level discrepancy flag - if orderedQty is recorded, true when the quantity received is lower/higher than it
    hasDiscrepancy: { type: Boolean, default: false },
  },
  { _id: false }
);

const grnSchema = new mongoose.Schema(
  {
    grnNo: { type: String, required: true, unique: true }, // GRN-20260101-0001

    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    supplierName: { type: String, required: true }, // denormalized

    supplierInvoiceRef: { type: String, default: "" }, // 🆕 The Supplier's Invoice/Delivery Note number
    notes: { type: String, default: "" },

    items: [grnItemSchema],
    grandTotal: { type: Number, required: true },

    // 🆕 Status: Received = everything received in the exact quantity requested, Partially Received = at least one item received short,
    // Discrepancy = received more than requested, or a qty mismatch of some other kind
    status: {
      type: String,
      enum: ["Received", "Partially Received", "Discrepancy"],
      default: "Received",
    },
    hasDiscrepancy: { type: Boolean, default: false },

    receivedBy: { type: String, default: "" }, // admin username's note

    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// 🛠️ { unique: true } on grnNo already creates an index - there is no need to index { grnNo: 1 } again here
// (that is what showed the "Duplicate schema index" warning in the deploy log - harmless, but let us clean it up)
grnSchema.index({ supplierId: 1, date: -1 });

module.exports = mongoose.model("GRN", grnSchema);