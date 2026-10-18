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
        // 🆕 SHIFT RECONCILIATION: මේ ගෙවීම ගත්ත Cashier කව්ද, මොන Payment Method එකෙන්ද (Cash/Card/
        // Bank Transfer/Other) කියලා සටහන් කරයි - cashier ගේ Shift Close එකේ Cash Drawer ගණනයට
        // (Expected Cash) "Cash" ගෙවීම් විතරක් ඇතුලත් කරගන්න මේවා අවශ්‍යයි.
        cashier: { type: String, default: null },
        paymentMethod: { type: String, enum: ["Cash", "Card", "Bank Transfer", "Other"], default: "Cash" },
        date: { type: Date, default: Date.now },
        description: { type: String, default: "ණයට ගැනීම (Bill Purchase)" }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);