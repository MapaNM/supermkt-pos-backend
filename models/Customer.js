const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    isLoyaltyMember: { type: Boolean, default: false },
    creditBalance: { type: Number, default: 0 },
    // 🛠️ UPDATED LINE: Added an Array to keep the credit history (amount and date) separately
    creditHistory: [
      {
        amount: { type: Number, required: true }, // Amount applied to credit (actual applied amount, negative = payment)
        // 🆕 When a Payment is made, separately tracks the amount actually applied and the remaining (Overpayment) amount -
        // these are not relevant to "Credit purchase" entries, they are filled only for payment entries.
        paidAmount: { type: Number, default: null },
        changeGiven: { type: Number, default: 0 },
        // 🆕 SHIFT RECONCILIATION: Records which Cashier received this payment and by which Payment Method (Cash/Card/
        // Bank Transfer/Other) - these are needed so that only "Cash" payments are included in the Cash Drawer calculation
        // (Expected Cash) at the cashier's Shift Close.
        cashier: { type: String, default: null },
        paymentMethod: { type: String, enum: ["Cash", "Card", "Bank Transfer", "Other"], default: "Cash" },
        date: { type: Date, default: Date.now },
        description: { type: String, default: "Credit purchase (Bill Purchase)" }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);