const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { hasPermission } = require("../utils/Permissions");
const { audit } = require("../utils/audit");

// 🔐 protect: verifies the JWT and attaches the logged-in user (without the password) to req.user.
// The user is re-read from the database on EVERY request, so a permission change or a disabled account takes effect immediately
// (nothing is cached in the token except the user id).
const protect = async (req, res, next) => {
  try {
    let token;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ message: "You must be logged in for this action! (Unauthorized)" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({ message: "User not found - please log in again" });
    }
    if (user.active === false) {
      return res.status(401).json({ message: "This account has been disabled - please contact the admin" });
    }

    req.user = user; // { _id, username, role, preset, permissions, limits, active }
    next();
  } catch (error) {
    // Expired token, malformed token, wrong secret, etc. all land here
    return res.status(401).json({ message: "Your session is no longer valid - please log in again" });
  }
};

// 🔐 requireAdmin: chain after protect - 403 unless role is 'admin'. Used for things that can never be delegated
// (user & permission management, audit log, destructive "clear all" actions).
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Only an Admin can do this! (Forbidden)" });
  }
  next();
};

const deny = (req, res, needed) => {
  audit(req, {
    action: "permission_denied",
    category: "security",
    severity: "warning",
    summary: `${req.user?.username || "unknown"} tried ${req.method} ${req.originalUrl.split("?")[0]} without permission (${needed})`,
    details: { needed },
  });
  return res.status(403).json({ message: "You do not have permission to do this. Ask the admin to enable it for your account.", code: "PERMISSION_DENIED", needed });
};

// 🔐 requirePermission('void_bill'): chain after protect. Admin always passes.
const requirePermission = (key) => (req, res, next) => {
  if (hasPermission(req.user, key)) return next();
  return deny(req, res, key);
};

// 🔐 requireAnyPermission(['a','b']): passes when the user has at least one of them.
const requireAnyPermission = (keys) => (req, res, next) => {
  if (keys.some((k) => hasPermission(req.user, k))) return next();
  return deny(req, res, keys.join(" | "));
};

module.exports = { protect, requireAdmin, requirePermission, requireAnyPermission };