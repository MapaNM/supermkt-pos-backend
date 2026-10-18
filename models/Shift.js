const mongoose = require("mongoose");

// 🆕 SHIFT / CASH DRAWER RECONCILIATION
// Cashier කෙනෙක් කවුන්ටරයේ වැඩ පටන් ගන්න කලින් (Opening Float එකක් සටහන් කරලා) Shift එකක් "open"
// කරනවා, වැඩ ඉවර උනාම (actual counted cash එක ඇතුලත් කරලා) "close" කරනවා. Close කරන වෙලාවේ
// backend එකම ඒ Shift කාලය තුළ වුනු Cash Sales + Cash Refunds වලින් "Expected Cash" එක ගණනය කරලා,
// cashier ගේ Counted Cash එකත් සමග compare කරලා Over/Short එක පෙන්වනවා - End-of-day cash
// accountability එකට.
const ShiftSchema = new mongoose.Schema(
  {
    cashier: { type: String, required: true }, // username - Sale.cashier එකේම convention එක

    openingFloat: { type: Number, required: true, default: 0 }, // Shift එක පටන් ගන්න වෙලාවේ Drawer එකේ තිබිච්ච මුදල
    openedAt: { type: Date, default: Date.now },

    status: { type: String, enum: ["open", "closed"], default: "open" },

    // 🆕 Close කරන වෙලාවේ විතරක් පුරවනු ලැබේ
    closedAt: { type: Date, default: null },
    cashSales: { type: Number, default: 0 }, // මේ Shift එක තුළ Cash payment method එකෙන් වුනු Sales එකතුව
    cashRefunds: { type: Number, default: 0 }, // මේ Shift එක තුළ Cash refund method එකෙන් දුන් Returns එකතුව
    // 🆕 SHIFT RECONCILIATION (Customer/Supplier): Cash වලින් විතරක් ලැබුණු Customer Credit Payments
    // සහ Cash වලින් විතරක් ගෙව්ව Supplier Payments මේ Shift එක තුළ කොච්චරද කියලා වෙනම track කරයි -
    // Admin කෙනෙකුට Shift History එකේදී මේ breakdown එක පැහැදිලිව පේන්න ඕන (transparency).
    creditPaymentsCashIn: { type: Number, default: 0 }, // Customer ගෙන් Cash වලින් ලැබුණු ණය ගෙවීම් එකතුව
    supplierPaymentsCashOut: { type: Number, default: 0 }, // Supplier ට Cash වලින් ගෙව්ව මුදල් එකතුව
    creditGiven: { type: Number, default: 0 }, // 🆕 මේ Shift එකේදී ණයට (Customer Credit) ලබා දුන් මුදල (Info විතරයි, Expected Cash එකට බලපෑමක් නෑ)
    creditGivenGross: { type: Number, default: 0 }, // 🆕 Return වලට කලින් ණයට දුන් මුළු මුදල
    creditReturned: { type: Number, default: 0 }, // 🆕 Return වලින් ණය පොතෙන් අඩු කළ මුදල (creditGiven = creditGivenGross − creditReturned)
    creditBillCount: { type: Number, default: 0 }, // 🆕 ණයට දුන් බිල් ගණන
    expectedCash: { type: Number, default: 0 }, // openingFloat + cashSales - cashRefunds + creditPaymentsCashIn - supplierPaymentsCashOut
    closingCountedCash: { type: Number, default: null }, // Cashier ඇත්තටම ගාණ කරලා report කරපු මුදල
    overShort: { type: Number, default: 0 }, // closingCountedCash - expectedCash (+ නම් වැඩි, - නම් අඩු)

    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

ShiftSchema.index({ cashier: 1, status: 1 });
ShiftSchema.index({ openedAt: -1 });

module.exports = mongoose.model("Shift", ShiftSchema);