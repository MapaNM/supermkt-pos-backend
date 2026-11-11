const mongoose = require("mongoose");

// 🧾 Append-only audit trail. There is deliberately NO update or delete route for this collection - the only way to read it is
// GET /api/audit (admin only). Every sensitive action (void, return, price/stock change, permission change, denied attempt...) writes one row.
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true }, // e.g. "bill_voided", "return_processed", "permissions_changed"
    category: { type: String, default: "general", index: true }, // sales | stock | suppliers | customers | users | security | promotions | shifts
    severity: { type: String, enum: ["info", "warning", "critical"], default: "info" },
    actor: { type: String, default: "system", index: true }, // username
    actorRole: { type: String, default: "" },
    summary: { type: String, required: true }, // one human-readable line
    targetType: { type: String, default: "" }, // Product | Sale | User | Customer | Supplier | Promotion | GRN ...
    targetId: { type: String, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: null }, // before/after values etc.
    ip: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);