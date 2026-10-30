const mongoose = require("mongoose");

const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String },

    // 🛠️ The total amount we (the Shop) must pay the Supplier (Accounts Payable)
    balanceDue: { type: Number, default: 0 },

    // 🛠️ Both Purchases (stock received) and Payments are recorded in the same ledger
    ledger: [
      {
        type: { type: String, enum: ["purchase", "payment"], required: true },
        amount: { type: Number, required: true }, // the amount actually applied to balanceDue (applied amount)
        // 🆕 When a Payment is made, tracks the amount actually given and the remainder (Overpayment) separately
        paidAmount: { type: Number, default: null },
        changeGiven: { type: Number, default: 0 },
        // 🆕 SHIFT RECONCILIATION: Records who made this payment + by which method (Cash/Card/Bank) -
        // only "Cash" payments (type: "payment") are deducted from the Cash Drawer calculation when a Shift is Closed.
        cashier: { type: String, default: "" },
        paymentMethod: { type: String, enum: ["Cash", "Card", "Bank Transfer", "Other"], default: "Cash" },
        description: { type: String },
        // 🛠️ NEW (Step 2 - GRN Multi-item): Multiple Products received on the same Invoice/GRN are tracked here
        items: [
          {
            productName: { type: String },
            quantity: { type: Number },
            costPrice: { type: Number },
            subtotal: { type: Number },
            // 🛠️ NEW: An audit trail of whether stock was "added" or "set" (overwritten) for this item
            stockMode: { type: String, enum: ["add", "set"], default: "add" },
          },
        ],
        date: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Supplier", supplierSchema);