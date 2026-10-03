const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    isLoyaltyMember: { type: Boolean, default: false },
    creditBalance: { type: Number, default: 0 },
    // 🛠️ UPDATED LINE: ණය ගත් ඉතිහාසය (මුදල සහ දිනය) වෙන වෙනම තබා ගැනීමට Array එකක් එකතු කලා
    creditHistory: [
      {
        amount: { type: Number, required: true }, // ණයට යෙදුන ගණන (actual applied amount, negative = payment)
        // 🆕 Payment එකක් වෙද්දී ඇත්තටම අත ගහපු මුදල සහ ඉතුරු (Overpayment) මුදල වෙනම track කරයි -
        // මේවා "ණයට ගැනීම" entries වලට අදාල නැත, payment entries වලට විතරයි පුරවන්නේ.
        paidAmount: { type: Number, default: null },
        changeGiven: { type: Number, default: 0 },
        date: { type: Date, default: Date.now },
        description: { type: String, default: "ණයට ගැනීම (Bill Purchase)" }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);