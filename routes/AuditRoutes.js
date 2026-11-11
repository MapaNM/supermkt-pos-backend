const express = require("express");
const router = express.Router();
const AuditLog = require("../models/Auditlog");

const escapeRegex = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/audit  (protect + requireAdmin are applied in server.js - the audit trail can never be delegated)
// Query: category, severity, action, actor, q (text in the summary), from, to (ISO dates), limit (<=200), before (cursor = createdAt ISO of the last row)
router.get("/", async (req, res) => {
  try {
    const { category, severity, action, actor, q, from, to, before } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const filter = {};
    if (category) filter.category = category;
    if (severity) filter.severity = severity;
    if (action) filter.action = action;
    if (actor) filter.actor = actor;
    if (q) filter.summary = { $regex: escapeRegex(q.trim()), $options: "i" };
    const range = {};
    if (from) { const d = new Date(from); if (!isNaN(d)) range.$gte = d; }
    if (to) { const d = new Date(to); if (!isNaN(d)) { d.setHours(23, 59, 59, 999); range.$lte = d; } }
    if (before) { const d = new Date(before); if (!isNaN(d)) range.$lt = d; }
    if (Object.keys(range).length) filter.createdAt = range;

    const logs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit + 1).lean();
    const hasMore = logs.length > limit;
    const page = hasMore ? logs.slice(0, limit) : logs;
    res.status(200).json({ logs: page, nextCursor: hasMore ? page[page.length - 1].createdAt : null });
  } catch (error) {
    console.error("Audit fetch failed", error);
    res.status(500).json({ message: "Failed to fetch the audit log" });
  }
});

module.exports = router;