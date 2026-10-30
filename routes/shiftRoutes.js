const express = require("express");
const router = express.Router();
const RouteError = require("../utils/routeError");
const Shift = require("../models/Shift");
const Sale = require("../models/Sale");
const Return = require("../models/Return");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const User = require("../models/User");
const { requireAdmin } = require("../middleware/auth"); // 🔐 note: `protect` already applied at /api/shifts in server.js

const round2 = (num) => Math.round((parseFloat(num) || 0) * 100) / 100;

// 🆕 Shared helper that calculates Cash figures for a Shift (openedAt → until) - the same logic is used when closing a shift and when the History table
// shows Live figures for an Open shift.
async function computeShiftFigures(shift, closedAt) {
    // 📊 Sums this cashier's Cash Sales + Cash Refunds during the Shift period (openedAt → closedAt)
    // 🛠️ FIX: Previously only bills with paymentMethod === "Cash" were counted. But for a "Credit" bill (e.g. a Rs.5000 bill where
    // Rs.3000 was paid and Rs.2000 was put on credit), the Rs.3000 paid actually went into the Cash Drawer - since it was not included in Cash Sales,
    // Expected Cash was calculated Rs.3000 too low. Now the full amount of a Cash bill and
    // the paid portion of a Credit bill (amountPaid, capped at the bill amount) are both added to Cash Sales.
    const cashSalesAgg = await Sale.aggregate([
      {
        $match: {
          cashier: shift.cashier,
          paymentMethod: { $in: ["Cash", "Credit"] },
          status: { $ne: "Voided" },
          createdAt: { $gte: shift.openedAt, $lte: closedAt },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $eq: ["$paymentMethod", "Cash"] },
                "$totalAmount",
                { $min: [{ $ifNull: ["$amountPaid", 0] }, "$totalAmount"] },
              ],
            },
          },
        },
      },
    ]);
    // 🆕 Amount given on credit (Customer Credit) during this Shift - Informational only, it has no effect
    // on Expected Cash (it is not money that actually came into the Drawer, it is the amount added to the credit book).
    const creditGivenAgg = await Sale.aggregate([
      {
        $match: {
          cashier: shift.cashier,
          paymentMethod: "Credit",
          status: { $ne: "Voided" },
          createdAt: { $gte: shift.openedAt, $lte: closedAt },
        },
      },
      // 🛠️ Since amountDue decreases when a Return is made (even a Return made later), the original credit amount
      // is recalculated as (totalAmount − amountPaid) - credit that was returned is deducted separately as "Credit Return".
      {
        $group: {
          _id: null,
          total: { $sum: { $max: [0, { $subtract: ["$totalAmount", { $ifNull: ["$amountPaid", 0] }] }] } },
          count: { $sum: { $cond: [{ $gt: [{ $subtract: ["$totalAmount", { $ifNull: ["$amountPaid", 0] }] }, 0.004] }, 1, 0] } },
        },
      },
    ]);
    // 🆕 Among the Returns made by this cashier during this Shift, those that were "deducted from the credit book" (CreditAdjust/StoreCredit) -
    // for these, no money left the Cash drawer, only the credit balance was reduced (a Cash Refund goes into Cash Refunds).
    const creditReturnsAgg = await Return.aggregate([
      {
        $match: {
          cashier: shift.cashier,
          refundMethod: { $in: ["CreditAdjust", "StoreCredit"] },
          createdAt: { $gte: shift.openedAt, $lte: closedAt },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalRefundAmount" } } },
    ]);
    const cashRefundsAgg = await Return.aggregate([
      {
        $match: {
          cashier: shift.cashier,
          refundMethod: "Cash",
          createdAt: { $gte: shift.openedAt, $lte: closedAt },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalRefundAmount" } } },
    ]);

    // 🆕 Customer Credit Payments (Cash only) - Unwinds the creditHistory array, and within the Shift
    // period finds this cashier's "Cash" payment entries (amount < 0, excluding Overpayment Change-Return
    // entries) and sums their Math.abs(amount)
    const creditPaymentsAgg = await Customer.aggregate([
      { $match: { "creditHistory.cashier": shift.cashier } },
      { $unwind: "$creditHistory" },
      {
        $match: {
          "creditHistory.cashier": shift.cashier,
          "creditHistory.paymentMethod": "Cash",
          "creditHistory.isChangeReturn": { $ne: true },
          "creditHistory.amount": { $lt: 0 },
          "creditHistory.date": { $gte: shift.openedAt, $lte: closedAt },
        },
      },
      { $group: { _id: null, total: { $sum: { $abs: "$creditHistory.amount" } } } },
    ]);

    // 🆕 Supplier Payments (Cash only) - Unwinds the ledger array, and within the Shift period finds this
    // cashier's "payment" type, "Cash" entries and sums their amount
    const supplierPaymentsAgg = await Supplier.aggregate([
      { $match: { "ledger.cashier": shift.cashier } },
      { $unwind: "$ledger" },
      {
        $match: {
          "ledger.cashier": shift.cashier,
          "ledger.type": "payment",
          "ledger.paymentMethod": "Cash",
          "ledger.date": { $gte: shift.openedAt, $lte: closedAt },
        },
      },
      { $group: { _id: null, total: { $sum: "$ledger.amount" } } },
    ]);

    const cashSales = round2(cashSalesAgg[0]?.total || 0);
    const cashRefunds = round2(cashRefundsAgg[0]?.total || 0);
    const creditPaymentsCashIn = round2(creditPaymentsAgg[0]?.total || 0);
    const supplierPaymentsCashOut = round2(supplierPaymentsAgg[0]?.total || 0);
    const expectedCash = round2(
      shift.openingFloat + cashSales - cashRefunds + creditPaymentsCashIn - supplierPaymentsCashOut
    );
    const creditGivenGross = round2(creditGivenAgg[0]?.total || 0);
    const creditReturned = round2(creditReturnsAgg[0]?.total || 0);
    const creditGiven = round2(creditGivenGross - creditReturned); // Net amount given on credit
    const creditBillCount = creditGivenAgg[0]?.count || 0;
    return { cashSales, cashRefunds, creditPaymentsCashIn, supplierPaymentsCashOut, expectedCash, creditGiven, creditGivenGross, creditReturned, creditBillCount };
}

// 1. 🆕 Check whether the currently logged-in Cashier has an Open Shift (called at Login/App load time)
router.get("/current", async (req, res) => {
  try {
    const shift = await Shift.findOne({ cashier: req.user.username, status: "open" }).sort({ openedAt: -1 });
    res.status(200).json(shift || null);
  } catch (error) {
    console.error("Failed to fetch Shift", error);
    res.status(500).json({ message: "Failed to fetch the Shift" });
  }
});

// 2. 🆕 Open a Shift (recording the Opening Float)
router.post("/open", async (req, res) => {
  try {
    const openingFloat = parseFloat(req.body.openingFloat);
    if (isNaN(openingFloat) || openingFloat < 0) {
      return res.status(400).json({ message: "Please enter a valid Opening Float amount (0 or more)!" });
    }

    // 🔐 A cashier cannot have more than one Open Shift at a time - the previous one must be Closed first
    const existingOpen = await Shift.findOne({ cashier: req.user.username, status: "open" });
    if (existingOpen) {
      return res.status(409).json({ message: "You already have an Active Shift! Please Close it first.", shift: existingOpen });
    }

    const newShift = await Shift.create({
      cashier: req.user.username,
      openingFloat,
      openedAt: new Date(),
      status: "open",
    });

    res.status(201).json({ message: "Shift opened successfully! 🟢", shift: newShift });
  } catch (error) {
    console.error("Failed to Open Shift", error);
    res.status(500).json({ message: "Failed to Open the Shift" });
  }
});

// 3. 🆕 Close a Shift - The Backend itself calculates Expected Cash from Sale/Return/Customer/Supplier data
// (a figure sent by the Client is never trusted - the core point of Cash Drawer accountability
// is that expected cash is calculated independently, outside the cashier's control).
//
// 📊 FORMULA: Expected Cash = Opening Float
//                            + Cash Sales (checkout, paymentMethod="Cash", status != Voided)
//                            − Cash Refunds (returns, refundMethod="Cash")
//                            + Customer Credit Payments Received in Cash (pay-credit, paymentMethod="Cash")
//                            − Supplier Payments Made in Cash (pay, paymentMethod="Cash")
//
// 🔐 In both Customer/Supplier payment entries, the "amount"/"appliedAmount" field is already the correct cash impact, net of Overpayment/
// Change-Given (paidAmount − changeGiven = appliedAmount
// on both sides), so changeReturn/isChangeReturn entries do not need to be added separately here - they would
// cause double-counting.
router.post("/close/:id", async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    if (!shift) throw new RouteError(404, "Shift not found");
    if (shift.status !== "open") throw new RouteError(400, "This Shift has already been Closed");

    // 🔐 You can only Close your own Shift - only an Admin is allowed to Close someone else's Shift
    if (shift.cashier !== req.user.username && req.user.role !== "admin") {
      throw new RouteError(403, "You can only Close your own Shift!");
    }

    const closingCountedCash = parseFloat(req.body.closingCountedCash);
    if (isNaN(closingCountedCash) || closingCountedCash < 0) {
      throw new RouteError(400, "Please enter a valid Counted Cash amount (0 or more)!");
    }

    const closedAt = new Date();

    const { cashSales, cashRefunds, creditPaymentsCashIn, supplierPaymentsCashOut, expectedCash, creditGiven, creditGivenGross, creditReturned, creditBillCount } =
      await computeShiftFigures(shift, closedAt);
    const overShort = round2(closingCountedCash - expectedCash);

    shift.status = "closed";
    shift.closedAt = closedAt;
    shift.cashSales = cashSales;
    shift.cashRefunds = cashRefunds;
    shift.creditPaymentsCashIn = creditPaymentsCashIn;
    shift.supplierPaymentsCashOut = supplierPaymentsCashOut;
    shift.creditGiven = creditGiven;
    shift.creditGivenGross = creditGivenGross;
    shift.creditReturned = creditReturned;
    shift.creditBillCount = creditBillCount;
    shift.expectedCash = expectedCash;
    shift.closingCountedCash = closingCountedCash;
    shift.overShort = overShort;
    shift.notes = req.body.notes || "";
    await shift.save();

    res.status(200).json({
      message:
        overShort === 0
          ? "Shift closed successfully! The Cash Drawer matches exactly! ✅"
          : overShort > 0
          ? `Shift closed! The Drawer is Rs.${overShort.toFixed(2)} over (Over). ⚠️`
          : `Shift closed! The Drawer is Rs.${Math.abs(overShort).toFixed(2)} short (Short). ⚠️`,
      shift,
    });
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Failed to Close Shift", error);
    res.status(500).json({ message: "Failed to Close the Shift" });
  }
});

// 4. 🆕 Shift History (Admin-only) - Filter: cashier, from, to
router.get("/history", requireAdmin, async (req, res) => {
  try {
    const { cashier, from, to } = req.query;
    const filter = {};
    if (cashier) filter.cashier = cashier;
    if (from || to) {
      filter.openedAt = {};
      if (from) filter.openedAt.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filter.openedAt.$lte = toDate;
      }
    }

    const shifts = await Shift.find(filter).sort({ openedAt: -1 }).limit(300);
    // 🆕 The figures in the History table are always recalculated from the Sale/Return/Customer/Supplier records themselves (the shift's
    // openedAt → closedAt, up to now if Open). Previously, the values saved in the Shift document at Close time
    // were displayed - if they were not saved, or were dropped under an old Shift.js schema, then after Close
    // the credit payments/supplier payments appeared as 0. Open shifts get isLive: true.
    const now = new Date();
    const result = await Promise.all(
      shifts.map(async (shift) => {
        const obj = shift.toObject();
        const isOpen = shift.status === "open";
        const figures = await computeShiftFigures(shift, isOpen ? now : shift.closedAt || now);
        Object.assign(obj, figures);
        if (isOpen) {
          obj.isLive = true;
        } else if (typeof shift.closingCountedCash === "number") {
          obj.overShort = round2(shift.closingCountedCash - figures.expectedCash);
        }
        return obj;
      })
    );
    res.status(200).json(result);
  } catch (error) {
    console.error("Failed to fetch Shift History", error);
    res.status(500).json({ message: "Failed to fetch Shift History" });
  }
});

// 5. 🆕 REPORT of transactions with NO SHIFT (Admin-only) - Finds transactions affecting the Cash
// Drawer that happened while the Cashier did not have an Open Shift (bills, Returns, credit payments, supplier payments).
// Transactions made before Shifts were made mandatory, Offline Sync bills, and bypass attempts
// are visible here. Filters: cashier, from, to (default: last 7 days)
router.get("/outside-activity", requireAdmin, async (req, res) => {
  try {
    const { cashier } = req.query;
    const now = new Date();
    const start = req.query.from ? new Date(req.query.from) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (!req.query.from) start.setHours(0, 0, 0, 0);
    const end = req.query.to ? new Date(req.query.to) : now;
    if (req.query.to) end.setHours(23, 59, 59, 999);

    // All Shifts within the Range (grouped by cashier)
    const shifts = await Shift.find({
      openedAt: { $lte: end },
      $or: [{ closedAt: null }, { closedAt: { $gte: start } }],
    }).lean();
    const shiftsByCashier = {};
    for (const s of shifts) (shiftsByCashier[s.cashier] ||= []).push(s);
    const inShift = (name, when) =>
      (shiftsByCashier[name] || []).some((s) => when >= new Date(s.openedAt) && when <= new Date(s.closedAt || now));

    // 👑 Since Admins are allowed to transact without a Shift, those are shown with an Admin badge
    // (if includeAdmin=false, Admin transactions are removed and only Cashier transactions are shown)
    const adminNames = new Set((await User.find({ role: "admin" }).select("username").lean()).map((u) => u.username));
    const includeAdmin = req.query.includeAdmin !== "false";

    const rows = [];
    const push = (row) => {
      if (cashier && row.cashier !== cashier) return;
      row.isAdmin = adminNames.has(row.cashier);
      if (row.isAdmin && !includeAdmin) return;
      if (inShift(row.cashier, new Date(row.at))) return;
      rows.push(row);
    };

    // 🧾 Bills
    const sales = await Sale.find({ createdAt: { $gte: start, $lte: end } })
      .select("cashier invoiceNo totalAmount amountPaid paymentMethod status createdAt").lean();
    for (const s of sales) {
      const cashIn =
        s.paymentMethod === "Cash" ? s.totalAmount : s.paymentMethod === "Credit" ? Math.min(s.amountPaid || 0, s.totalAmount) : 0;
      push({
        type: "Sale", typeLabel: "Bill", cashier: s.cashier || "Unknown", ref: s.invoiceNo || String(s._id).slice(-8).toUpperCase(),
        method: s.paymentMethod, amount: round2(s.totalAmount), cashImpact: round2(s.status === "Voided" ? 0 : cashIn),
        status: s.status || "", at: s.createdAt,
      });
    }

    // 🔄 Returns
    const returns = await Return.find({ createdAt: { $gte: start, $lte: end } })
      .select("cashier invoiceNo totalRefundAmount refundMethod type createdAt").lean();
    for (const r of returns) {
      push({
        type: "Return", typeLabel: r.type === "Exchange" ? "Exchange" : "Return", cashier: r.cashier || "Unknown", ref: r.invoiceNo || "-",
        method: r.refundMethod, amount: round2(r.totalRefundAmount), cashImpact: r.refundMethod === "Cash" ? -round2(r.totalRefundAmount) : 0,
        status: "", at: r.createdAt,
      });
    }

    // 💵 Customer credit payments (old entries without cashier/paymentMethod recorded are not included)
    const creditPays = await Customer.aggregate([
      { $unwind: "$creditHistory" },
      {
        $match: {
          "creditHistory.amount": { $lt: 0 },
          "creditHistory.date": { $gte: start, $lte: end },
          $or: [{ "creditHistory.cashier": { $exists: true, $ne: null } }, { "creditHistory.paymentMethod": { $exists: true, $ne: null } }],
        },
      },
      { $project: { name: 1, entry: "$creditHistory" } },
    ]);
    for (const c of creditPays) {
      if (c.entry.isChangeReturn) continue;
      push({
        type: "CreditPayment", typeLabel: "Credit Payment", cashier: c.entry.cashier || "(Unknown)", ref: c.name,
        method: c.entry.paymentMethod || "Cash", amount: round2(Math.abs(c.entry.amount)),
        cashImpact: (c.entry.paymentMethod || "Cash") === "Cash" ? round2(Math.abs(c.entry.amount)) : 0, status: "", at: c.entry.date,
      });
    }

    // 🚚 Supplier payments
    const supplierPays = await Supplier.aggregate([
      { $unwind: "$ledger" },
      {
        $match: {
          "ledger.type": "payment",
          "ledger.date": { $gte: start, $lte: end },
          $or: [{ "ledger.cashier": { $nin: [null, ""] } }, { "ledger.paymentMethod": { $exists: true, $ne: null } }],
        },
      },
      { $project: { name: 1, entry: "$ledger" } },
    ]);
    for (const p of supplierPays) {
      push({
        type: "SupplierPayment", typeLabel: "Supplier Payment", cashier: p.entry.cashier || "(Unknown)", ref: p.name,
        method: p.entry.paymentMethod || "Cash", amount: round2(p.entry.amount),
        cashImpact: (p.entry.paymentMethod || "Cash") === "Cash" ? -round2(p.entry.amount) : 0, status: "", at: p.entry.date,
      });
    }

    rows.sort((a, b) => new Date(b.at) - new Date(a.at));
    const limited = rows.slice(0, 500);
    const totals = {
      count: rows.length,
      cashIn: round2(rows.filter((r) => r.cashImpact > 0).reduce((t, r) => t + r.cashImpact, 0)),
      cashOut: round2(rows.filter((r) => r.cashImpact < 0).reduce((t, r) => t + Math.abs(r.cashImpact), 0)),
    };
    res.status(200).json({ items: limited, totals, truncated: rows.length > limited.length, from: start, to: end });
  } catch (error) {
    console.error("Failed to generate the no-Shift transactions report", error);
    res.status(500).json({ message: "Failed to fetch the Report" });
  }
});

module.exports = router;