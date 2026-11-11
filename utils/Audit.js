const AuditLog = require("../models/Auditlog");

// audit(req, { action, category, severity, summary, targetType, targetId, details })
// Fire-and-forget: a failure to write the log must never break the real operation, so errors are only printed to the server log.
// `req` may be null (system events) or a request without req.user (e.g. a failed login - pass `actor` explicitly).
function audit(req, entry) {
  try {
    const actor = entry.actor || req?.user?.username || "system";
    const doc = {
      action: entry.action,
      category: entry.category || "general",
      severity: entry.severity || "info",
      actor,
      actorRole: entry.actorRole || req?.user?.role || "",
      summary: String(entry.summary || entry.action).slice(0, 500),
      targetType: entry.targetType || "",
      targetId: entry.targetId ? String(entry.targetId) : "",
      details: entry.details ?? null,
      ip: req?.ip || "",
    };
    return AuditLog.create(doc).catch((e) => console.error("Audit log write failed:", e.message));
  } catch (e) {
    console.error("Audit log write failed:", e.message);
    return Promise.resolve();
  }
}

module.exports = { audit };