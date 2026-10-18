const express = require("express");
const router = express.Router();
const RouteError = require("../utils/RouteError");
const Shift = require("../models/Shift");
const Sale = require("../models/Sale");
const Return = require("../models/Return");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const { requireAdmin } = require("../middleware/auth"); // 🔐 note: `protect` already applied at /api/shifts in server.js

const round2 = (num) => Math.round((parseFloat(num) || 0) * 100) / 100;

// 🆕 Shift එකක (openedAt → until) Cash figures ගණනය කරන shared helper - Close කරද්දීත්, History table
// එකේ Open shift එකක Live figures පෙන්වද්දීත් එකම logic එක පාවිච්චි වෙනවා.
async function computeShiftFigures(shift, closedAt) {
    // 📊 Shift කාලය තුළ (openedAt → closedAt) මේ cashier ගේ Cash Sales + Cash Refunds එකතු කරයි
    // 🛠️ FIX: කලින් paymentMethod === "Cash" බිල් විතරයි ගත්තේ. ඒත් "Credit" බිලක් (උදා: රු.5000 බිලට
    // රු.3000 ගෙවලා රු.2000 ණයට) සඳහා ගෙවපු රු.3000 Cash Drawer එකට ඇත්තටම ආවා - ඒක Cash Sales වලට
    // ඇතුලත් වෙන්නේ නැතුව Expected Cash එක රු.3000 ක් අඩුවෙන් ගණනය වුනා. දැන් Cash බිලේ මුළු මුදලත්,
    // Credit බිලේ ගෙවපු කොටසත් (amountPaid, බිල් මුදලට වඩා වැඩි නොවෙන්න) Cash Sales ට එකතු වෙනවා.
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
    // 🆕 මේ Shift එකේදී ණයට (Customer Credit) ලබා දුන් මුදල - Informational විතරයි, Expected Cash එකට
    // කිසිම බලපෑමක් නෑ (ඇත්තටම Drawer එකට ආපු මුදලක් නෙවෙයි, ණය පොතට එකතු වුන මුදල).
    const creditGivenAgg = await Sale.aggregate([
      {
        $match: {
          cashier: shift.cashier,
          paymentMethod: "Credit",
          status: { $ne: "Voided" },
          createdAt: { $gte: shift.openedAt, $lte: closedAt },
        },
      },
      // 🛠️ amountDue එක Return කරද්දී අඩු වෙන නිසා (පසුව වුන Return එකකින් වුනත්) මුල් ණය මුදල
      // (totalAmount − amountPaid) ඇතුලේ නැවත ගණනය කරයි - Return වුන ණය වෙනම "ණය Return" එකෙන් අඩු වේ.
      {
        $group: {
          _id: null,
          total: { $sum: { $max: [0, { $subtract: ["$totalAmount", { $ifNull: ["$amountPaid", 0] }] }] } },
          count: { $sum: { $cond: [{ $gt: [{ $subtract: ["$totalAmount", { $ifNull: ["$amountPaid", 0] }] }, 0.004] }, 1, 0] } },
        },
      },
    ]);
    // 🆕 මේ Shift එකේදී මේ cashier කරපු Return වලින් "ණය පොතෙන් අඩු කළ" (CreditAdjust/StoreCredit) ඒවා -
    // මේවායේදී Cash drawer එකෙන් මුදල් ගියේ නෑ, ණය ශේෂය විතරක් අඩු වුනා (Cash Refund නම් Cash Refunds එකට යයි).
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

    // 🆕 Customer Credit Payments (Cash විතරක්) - creditHistory array එක Unwind කරලා, Shift
    // කාලය තුළ මේ cashier ගේ "Cash" payment entries (amount < 0, Overpayment Change-Return
    // entries නෙවෙයි) හොයාගෙන ඒවායේ Math.abs(amount) එකතු කරයි
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

    // 🆕 Supplier Payments (Cash විතරක්) - ledger array එක Unwind කරලා, Shift කාලය තුළ මේ
    // cashier ගේ "payment" type, "Cash" entries හොයාගෙන ඒවායේ amount එකතු කරයි
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
    const creditGiven = round2(creditGivenGross - creditReturned); // Net ණයට දුන් මුදල
    const creditBillCount = creditGivenAgg[0]?.count || 0;
    return { cashSales, cashRefunds, creditPaymentsCashIn, supplierPaymentsCashOut, expectedCash, creditGiven, creditGivenGross, creditReturned, creditBillCount };
}

// 1. 🆕 දැනට Login වී සිටින Cashier ට Open Shift එකක් තියෙනවද බලන්න (Login/App load වෙලාවේ call කරයි)
router.get("/current", async (req, res) => {
  try {
    const shift = await Shift.findOne({ cashier: req.user.username, status: "open" }).sort({ openedAt: -1 });
    res.status(200).json(shift || null);
  } catch (error) {
    console.error("Shift ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Shift එක ලබාගැනීම අසාර්ථකයි" });
  }
});

// 2. 🆕 Shift එකක් Open කිරීම (Opening Float එක සටහන් කරලා)
router.post("/open", async (req, res) => {
  try {
    const openingFloat = parseFloat(req.body.openingFloat);
    if (isNaN(openingFloat) || openingFloat < 0) {
      return res.status(400).json({ message: "නිවැරදි Opening Float මුදලක් ඇතුලත් කරන්න (0 හෝ ඊට වැඩි)!" });
    }

    // 🔐 කැෂියර් කෙනෙකුට එකවර Open Shift එකකට වඩා තියෙන්න බෑ - කලින් එක Close කරන්න ඕන මුලින්ම
    const existingOpen = await Shift.findOne({ cashier: req.user.username, status: "open" });
    if (existingOpen) {
      return res.status(409).json({ message: "ඔබට දැනටමත් Active Shift එකක් තියෙනවා! මුලින් ඒක Close කරන්න.", shift: existingOpen });
    }

    const newShift = await Shift.create({
      cashier: req.user.username,
      openingFloat,
      openedAt: new Date(),
      status: "open",
    });

    res.status(201).json({ message: "Shift එක සාර්ථකව Open කලා! 🟢", shift: newShift });
  } catch (error) {
    console.error("Shift Open කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Shift එක Open කිරීම අසාර්ථකයි" });
  }
});

// 3. 🆕 Shift එකක් Close කිරීම - Expected Cash එක Backend එකම Sale/Return/Customer/Supplier data
// වලින් ගණනය කරයි (Client එකෙන් එවන ගණනයක් කවදාවත් විශ්වාස කරන්නේ නෑ - Cash Drawer accountability
// එකේ core point එකම cashier ගේ control එකෙන් පිටත, independent විදිහට expected cash එක ගණනය වෙන එක).
//
// 📊 FORMULA: Expected Cash = Opening Float
//                            + Cash Sales (checkout, paymentMethod="Cash", status != Voided)
//                            − Cash Refunds (returns, refundMethod="Cash")
//                            + Customer Credit Payments Received in Cash (pay-credit, paymentMethod="Cash")
//                            − Supplier Payments Made in Cash (pay, paymentMethod="Cash")
//
// 🔐 Customer/Supplier payment entries දෙකෙහිම "amount"/"appliedAmount" field එකම Overpayment/
// Change-Given එකත් සමග net වෙච්ච නිවැරදි cash-impact එක නිසා (paidAmount − changeGiven = appliedAmount
// දෙපැත්තෙන්ම), changeReturn/isChangeReturn entries මෙතනින් වෙනම add කරන්න ඕන නෑ - ඒවා
// double-counting කරයි.
router.post("/close/:id", async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    if (!shift) throw new RouteError(404, "Shift එක සොයාගත නොහැක");
    if (shift.status !== "open") throw new RouteError(400, "මෙම Shift එක දැනටමත් Close කර ඇත");

    // 🔐 තමන්ගේම Shift එක විතරයි Close කරන්න පුළුවන් - Admin කෙනෙකුට විතරක් වෙනත් කෙනෙකුගේ Shift එකක් Close කරන්න ඉඩ දෙයි
    if (shift.cashier !== req.user.username && req.user.role !== "admin") {
      throw new RouteError(403, "ඔබගේම Shift එක විතරක් Close කරන්න පුළුවන්!");
    }

    const closingCountedCash = parseFloat(req.body.closingCountedCash);
    if (isNaN(closingCountedCash) || closingCountedCash < 0) {
      throw new RouteError(400, "නිවැරදි Counted Cash මුදලක් ඇතුලත් කරන්න (0 හෝ ඊට වැඩි)!");
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
          ? "Shift එක සාර්ථකව Close කලා! Cash Drawer එක Exact ගැලපෙනවා! ✅"
          : overShort > 0
          ? `Shift එක Close කලා! Drawer එකේ රු.${overShort.toFixed(2)} වැඩි තියෙනවා (Over). ⚠️`
          : `Shift එක Close කලා! Drawer එකේ රු.${Math.abs(overShort).toFixed(2)} අඩුයි (Short). ⚠️`,
      shift,
    });
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Shift Close කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Shift එක Close කිරීම අසාර්ථකයි" });
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
    // 🆕 History table එකේ figures හැමවෙලේම Sale/Return/Customer/Supplier records වලින්ම (shift එකේ
    // openedAt → closedAt, Open නම් දැන් වෙනකම්) නැවත ගණනය කරනවා. කලින් Close කරද්දී Shift document
    // එකේ save කරපු අගයන්ම පෙන්නුවා - ඒවා save නොවුනොත්/පරණ Shift.js schema එකකදී drop වුනොත් Close
    // කරාට පස්සේ ණය ගෙවීම්/සැපයුම්කරු ගෙවීම් 0 විදිහට පෙනුනා. Open shift වලට isLive: true.
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
    console.error("Shift History ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Shift History ලබාගැනීම අසාර්ථකයි" });
  }
});

module.exports = router;