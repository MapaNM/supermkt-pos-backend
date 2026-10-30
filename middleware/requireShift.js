const mongoose = require("mongoose");
const Shift = require("../models/Shift");

// 🔐 ENFORCE SHIFT: Without an Open Shift, transactions that affect the Cash Drawer (billing, Return/Exchange,
// credit payments, supplier payments) cannot be made - otherwise that money would not be included in any Shift's Expected Cash,
// and a cashier could steal money from the drawer. Since the Frontend block can be bypassed,
// this is enforced on the server itself.
//
// options.onlyIfCash: true  => if the paymentMethod is Card/Bank Transfer/Other (a payment that does not
//                              affect the Cash Drawer) a Shift is not required (for credit/supplier payments).
//
// 📴 OFFLINE SYNC: When Offline bills are Synced, the cashier's Shift may already be Closed.
// So the shiftId saved on the Offline bill is also accepted (if it is a Shift of that same cashier, either Open or Closed within
// the last 48 hours). But if the Sale's time is outside the Shift, it shows up in the "Transactions without a Shift" report.
const OFFLINE_SHIFT_GRACE_MS = 48 * 60 * 60 * 1000;
const NON_CASH_METHODS = ["Card", "Bank Transfer", "Other"];

const requireOpenShift = (options = {}) => async (req, res, next) => {
  try {
    if (options.onlyIfCash && NON_CASH_METHODS.includes(req.body?.paymentMethod)) return next();

    const username = req.user?.username;
    if (!username) return res.status(401).json({ message: "You must be logged in!" });

    let shift = await Shift.findOne({ cashier: username, status: "open" });

    // 👑 The Admin (Owner) is allowed to bill/transact even without an Open Shift. But those transactions
    // show up in the "Transactions without a Shift" report (along with an Admin badge), so control is not lost.
    if (!shift && req.user?.role === "admin") {
      if (req.body && typeof req.body === "object" && "cashierName" in req.body) req.body.cashierName = username;
      return next();
    }

    if (!shift && req.body?.shiftId && mongoose.isValidObjectId(req.body.shiftId)) {
      const offlineShift = await Shift.findOne({ _id: req.body.shiftId, cashier: username });
      if (
        offlineShift &&
        (offlineShift.status === "open" ||
          (offlineShift.closedAt && Date.now() - new Date(offlineShift.closedAt).getTime() <= OFFLINE_SHIFT_GRACE_MS))
      ) {
        shift = offlineShift;
      }
    }

    if (!shift) {
      return res.status(403).json({
        code: "SHIFT_REQUIRED",
        message: "⛔ No Shift is Open! Please Open a Shift before doing this (record the Opening Float).",
      });
    }

    req.shift = shift;
    // 🔐 The cashier name on a Sale/Return must be the name of the person actually logged in, rather than what the client sends
    // (the name of the Shift's cashier) - billing under another cashier's name is not allowed.
    if (req.body && typeof req.body === "object" && "cashierName" in req.body) {
      req.body.cashierName = username;
    }
    next();
  } catch (error) {
    console.error("Shift check failed", error);
    res.status(500).json({ message: "Shift check failed" });
  }
};

module.exports = { requireOpenShift };