// SmartStore - permission catalog (single source of truth).
//
// Model:
//   - Admin (role "admin") always has every permission and is the only one who can manage users / permissions / the audit log.
//   - A cashier (role "cashier") gets the permissions the admin ticked for them (a preset + optional per-user changes).
//   - "Baseline" features need no permission at all, because a till cannot work without them: billing, hold/resume bills,
//     searching/adding customers, opening/closing your OWN shift, looking up / reprinting a bill, reading active promotions.
//   - Some limits can be attached to a permission (e.g. the biggest refund a cashier may approve alone).
//
// Everything here is enforced on the SERVER (middleware/auth.js -> requirePermission). The frontend only hides what you cannot use.

const PERMISSIONS = [
  // ── Sales desk ──
  { key: "process_return", group: "Sales desk", label: "Returns & exchanges", hint: "Refund or exchange items on an earlier bill. Can be capped with a maximum refund amount.", risk: "medium", limit: "maxReturnAmount" },
  { key: "void_bill", group: "Sales desk", label: "Void a bill", hint: "Cancel a whole completed bill and put the stock back.", risk: "high" },
  { key: "collect_credit_payment", group: "Sales desk", label: "Collect customer credit payments", hint: "Record payments against a customer's credit balance.", risk: "medium" },
  { key: "manage_customers", group: "Sales desk", label: "Edit / delete customers", hint: "Change customer details or remove a customer (adding customers is always allowed).", risk: "medium" },

  // ── Insights ──
  { key: "view_dashboard", group: "Insights", label: "Dashboard", hint: "Today's sales, profit, trends, receivables and payables. Shows PROFIT figures.", risk: "medium" },
  { key: "view_reports", group: "Insights", label: "Sales log & reports", hint: "All bills, returns history, unregistered items. Shows PROFIT figures.", risk: "medium" },
  { key: "view_cost_price", group: "Insights", label: "See cost prices", hint: "Purchase / cost price of items. Hidden from the till and the API for everyone without this.", risk: "high" },
  { key: "view_shift_history", group: "Insights", label: "Shift history & outside-shift report", hint: "Cash reconciliation of every cashier's shifts.", risk: "medium" },

  // ── Stock & suppliers ──
  { key: "manage_products", group: "Stock & suppliers", label: "Add / edit / delete products", hint: "Change items, prices, stock levels and batches.", risk: "high" },
  { key: "view_stock_alerts", group: "Stock & suppliers", label: "Low-stock, reorder & expiry alerts", hint: "See what needs re-ordering or is about to expire.", risk: "low" },
  { key: "manage_promotions", group: "Stock & suppliers", label: "Manage promotions", hint: "Create, activate and delete occasion discounts.", risk: "high" },
  { key: "receive_stock", group: "Stock & suppliers", label: "Receive stock (GRN)", hint: "Record goods received and GRN history. Can set new selling prices.", risk: "high" },
  { key: "manage_suppliers", group: "Stock & suppliers", label: "Manage suppliers", hint: "Add, edit and delete suppliers.", risk: "medium" },
  { key: "pay_supplier", group: "Stock & suppliers", label: "Pay suppliers", hint: "Record payments to suppliers.", risk: "high" },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

// Presets. "cashier" is exactly what a cashier could already do before permissions existed, so nothing changes for
// existing accounts until the admin edits them.
const PRESETS = {
  cashier: {
    label: "Cashier",
    description: "Billing, returns and credit payments only.",
    permissions: ["process_return", "collect_credit_payment"],
  },
  senior_cashier: {
    label: "Senior Cashier",
    description: "Cashier + stock alerts and customer management.",
    permissions: ["process_return", "collect_credit_payment", "manage_customers", "view_stock_alerts"],
  },
  supervisor: {
    label: "Supervisor",
    description: "Senior Cashier + voids, reports and shift history (no cost prices, no stock editing).",
    permissions: ["process_return", "collect_credit_payment", "manage_customers", "view_stock_alerts", "void_bill", "view_reports", "view_shift_history", "view_dashboard"],
  },
  manager: {
    label: "Manager",
    description: "Everything the admin can do except managing users and the audit log.",
    permissions: [...ALL_KEYS],
  },
};

const DEFAULT_PRESET = "cashier";

const sanitizePermissions = (list) => [...new Set((Array.isArray(list) ? list : []).filter((k) => ALL_KEYS.includes(k)))];

// Effective permission list of a user document / plain object.
// Legacy cashier accounts (no permissions field yet) fall back to the Cashier preset.
function effectivePermissions(user) {
  if (!user) return [];
  if (user.role === "admin") return [...ALL_KEYS];
  if (Array.isArray(user.permissions)) return sanitizePermissions(user.permissions);
  return [...PRESETS[DEFAULT_PRESET].permissions];
}

const hasPermission = (user, key) => !!user && (user.role === "admin" || effectivePermissions(user).includes(key));

// null / undefined / 0 limit = "no limit". Returns an error message, or null when the amount is allowed.
function checkReturnLimit(user, amount) {
  if (!user || user.role === "admin") return null;
  const limit = parseFloat(user.limits?.maxReturnAmount);
  if (!isFinite(limit) || limit <= 0) return null;
  if (amount > limit + 0.004) {
    return `This refund (Rs.${amount.toFixed(2)}) is above your limit of Rs.${limit.toFixed(2)}. Ask a manager/admin to process it.`;
  }
  return null;
}

// What the frontend receives about a user.
const publicUser = (user) => ({
  username: user.username,
  role: user.role,
  preset: user.preset || DEFAULT_PRESET,
  permissions: effectivePermissions(user),
  limits: { maxReturnAmount: user.limits?.maxReturnAmount ?? null },
});

module.exports = { PERMISSIONS, ALL_KEYS, PRESETS, DEFAULT_PRESET, sanitizePermissions, effectivePermissions, hasPermission, checkReturnLimit, publicUser };