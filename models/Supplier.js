const mongoose = require("mongoose");

const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String },

    // 🛠️ අපි (Shop එක) Supplier ට ගෙවන්න ඕන මුළු මුදල (Accounts Payable)
    balanceDue: { type: Number, default: 0 },

    // 🛠️ Purchase (stock ලැබීම) සහ Payment (ගෙවීම) දෙකම එකම ලෙජරයක සටහන් වේ
    ledger: [
      {
        type: { type: String, enum: ["purchase", "payment"], required: true },
        amount: { type: Number, required: true },
        description: { type: String },
        // 🛠️ NEW (Step 2 - GRN Multi-item): එකම Invoice/GRN එකකින් ලැබුණු Products කිහිපයම මෙතනින් track වේ
        items: [
          {
            productName: { type: String },
            quantity: { type: Number },
            costPrice: { type: Number },
            subtotal: { type: Number },
            // 🛠️ NEW: මේ item එකේදී stock එක "add" කලාද "set" (overwrite) කලාද කියලා audit trail එකක්
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