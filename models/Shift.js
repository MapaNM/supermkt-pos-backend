const mongoose = require("mongoose");

// 🆕 SHIFT / CASH DRAWER RECONCILIATION
// Before a Cashier starts work at the counter, they "open" a Shift (recording an Opening Float),
// and "close" it when work is finished (entering the actual counted cash). At Close time
// the backend itself calculates the "Expected Cash" from the Cash Sales + Cash Refunds during that Shift period,
// compares it with the cashier's Counted Cash and shows the Over/Short - for End-of-day cash
// accountability.
const ShiftSchema = new mongoose.Schema(
  {
    cashier: { type: String, required: true }, // username - same convention as Sale.cashier

    openingFloat: { type: Number, required: true, default: 0 }, // Amount in the Drawer at the time the Shift started
    openedAt: { type: Date, default: Date.now },

    status: { type: String, enum: ["open", "closed"], default: "open" },

    // 🆕 Filled only at Close time
    closedAt: { type: Date, default: null },
    cashSales: { type: Number, default: 0 }, // Total Sales made via the Cash payment method during this Shift
    cashRefunds: { type: Number, default: 0 }, // Total Returns refunded via the Cash refund method during this Shift
    // 🆕 SHIFT RECONCILIATION (Customer/Supplier): Separately tracks how much Customer Credit Payments were received only in Cash
    // and how much Supplier Payments were paid only in Cash during this Shift -
    // an Admin should be able to see this breakdown clearly in the Shift History (transparency).
    creditPaymentsCashIn: { type: Number, default: 0 }, // Total credit payments received in Cash from Customers
    supplierPaymentsCashOut: { type: Number, default: 0 }, // Total amount paid in Cash to Suppliers
    creditGiven: { type: Number, default: 0 }, // 🆕 Amount given on credit (Customer Credit) during this Shift (Info only, does not affect Expected Cash)
    creditGivenGross: { type: Number, default: 0 }, // 🆕 Total amount given on credit before Returns
    creditReturned: { type: Number, default: 0 }, // 🆕 Amount deducted from the credit ledger via Returns (creditGiven = creditGivenGross − creditReturned)
    creditBillCount: { type: Number, default: 0 }, // 🆕 Number of bills given on credit
    expectedCash: { type: Number, default: 0 }, // openingFloat + cashSales - cashRefunds + creditPaymentsCashIn - supplierPaymentsCashOut
    closingCountedCash: { type: Number, default: null }, // Amount the Cashier actually counted and reported
    overShort: { type: Number, default: 0 }, // closingCountedCash - expectedCash (+ means over, - means short)

    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

ShiftSchema.index({ cashier: 1, status: 1 });
ShiftSchema.index({ openedAt: -1 });

module.exports = mongoose.model("Shift", ShiftSchema);