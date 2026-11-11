const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect, requireAdmin } = require('../middleware/auth');
const { PERMISSIONS, PRESETS, DEFAULT_PRESET, sanitizePermissions, effectivePermissions, publicUser } = require('../utils/Permissions');
const { audit } = require('../utils/Audit');

const generateToken = (user) => {
    return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
};

// 🔐 Basic in-memory brute-force guard on login (per IP). Good enough for a single-shop
// POS behind one public IP; swap for express-rate-limit + Redis if you ever scale up.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOGIN_MAX_ATTEMPTS = 10;

function loginRateLimiter(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
        return next();
    }
    entry.count += 1;
    if (entry.count > LOGIN_MAX_ATTEMPTS) {
        return res.status(429).json({ message: "Too many failed attempts! Please try again in 15 minutes." });
    }
    next();
}

// 1. Add a new user (Register API)
// 🔐 Only if an Admin is logged in - a cashier cannot create another user.
// (To create the first admin account, use scripts/createAdmin.js - see the note below)
router.post('/register', protect, requireAdmin, async (req, res) => {
    const { username, password, role, preset, permissions, limits } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ message: "Both Username and Password are required!" });
        }
        // 🔐 SECURITY FIX: Previously this route had no password strength check at all - an admin could
        // create a Cashier account even with a password like "1". scripts/createAdmin.js
        // (the CLI script that creates the first admin account) already enforces a minimum limit of 8 characters -
        // now the same rule is applied to this route too, so that a weak password
        // cannot be registered even by bypassing the Frontend validation.
        if (password.length < 8) {
            return res.status(400).json({ message: "Password must be at least 8 characters long!" });
        }
        const newUser = new User({ username, password, role });
        if (newUser.role === 'cashier') {
            // 🆕 Start from a preset (default: Cashier) unless the admin ticked an explicit list
            const presetKey = PRESETS[preset] ? preset : (Array.isArray(permissions) ? 'custom' : DEFAULT_PRESET);
            newUser.preset = presetKey;
            newUser.permissions = Array.isArray(permissions) ? sanitizePermissions(permissions) : [...PRESETS[presetKey].permissions];
            const maxReturn = parseFloat(limits?.maxReturnAmount);
            newUser.limits = { maxReturnAmount: maxReturn > 0 ? maxReturn : null };
        }
        await newUser.save();
        audit(req, { action: "user_created", category: "users", severity: "warning", summary: `Created ${newUser.role} account "${newUser.username}"`, targetType: "User", targetId: newUser._id, details: { role: newUser.role, preset: newUser.preset, permissions: newUser.permissions } });
        res.status(201).json({
            success: true,
            message: "User added successfully! ✅",
            user: { username: newUser.username, role: newUser.role } // the password hash is never in the response
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: "This Username is already in use!" });
        }
        res.status(500).json({ message: "An error occurred while adding the user" });
    }
});

// 1.5 🆕 Get all Staff accounts (for the "Cashier Accounts" List in the Admin Panel)
// 🔐 Admin-only. The password hash is never in the response.
router.get('/', protect, requireAdmin, async (req, res) => {
    try {
        const users = await User.find().select('-password').sort({ role: 1, username: 1 });
        // 🆕 Each account also carries its EFFECTIVE permission list (legacy accounts without a list show the Cashier preset)
        res.status(200).json(users.map((u) => ({ ...u.toObject(), effectivePermissions: effectivePermissions(u) })));
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch data" });
    }
});

// 1.55 🆕 The logged-in user's own FRESH profile + effective permissions (the frontend polls this so a permission change
// or a disabled account is picked up within a minute, without logging out)
router.get('/me', protect, (req, res) => {
    res.status(200).json({ user: publicUser(req.user) });
});

// 1.56 🆕 The permission catalog + presets (to build the permission editor in the Admin panel)
router.get('/permissions/catalog', protect, requireAdmin, (req, res) => {
    res.status(200).json({ permissions: PERMISSIONS, presets: PRESETS });
});

// 1.57 🆕 Change a cashier's permissions / limits / active flag. Admin-only and NOT delegable (otherwise a trusted cashier
// could promote themselves). Every change is written to the audit log with what was added / removed.
router.put('/:id/permissions', protect, requireAdmin, async (req, res) => {
    try {
        const target = await User.findById(req.params.id);
        if (!target) return res.status(404).json({ message: "User not found" });
        if (target.role === 'admin') {
            return res.status(400).json({ message: "An Admin always has every permission - nothing to change here." });
        }
        const { preset, permissions, limits, active } = req.body;

        if (active !== undefined && active === false && target._id.toString() === req.user._id.toString()) {
            return res.status(400).json({ message: "You cannot disable your own account!" });
        }

        const before = effectivePermissions(target);
        const beforeActive = target.active !== false;
        const beforeLimit = target.limits?.maxReturnAmount ?? null;

        if (preset !== undefined || permissions !== undefined) {
            const presetKey = PRESETS[preset] ? preset : 'custom';
            target.preset = presetKey;
            target.permissions = Array.isArray(permissions)
                ? sanitizePermissions(permissions)
                : (PRESETS[presetKey] ? [...PRESETS[presetKey].permissions] : before);
        }
        if (limits !== undefined) {
            const maxReturn = parseFloat(limits?.maxReturnAmount);
            target.limits = { maxReturnAmount: maxReturn > 0 ? maxReturn : null };
        }
        if (active !== undefined) target.active = !!active;
        await target.save();

        const after = effectivePermissions(target);
        const added = after.filter((k) => !before.includes(k));
        const removed = before.filter((k) => !after.includes(k));
        const afterLimit = target.limits?.maxReturnAmount ?? null;
        const parts = [];
        if (added.length) parts.push(`granted: ${added.join(", ")}`);
        if (removed.length) parts.push(`revoked: ${removed.join(", ")}`);
        if (beforeLimit !== afterLimit) parts.push(`return limit ${beforeLimit ?? "none"} -> ${afterLimit ?? "none"}`);
        if (beforeActive !== (target.active !== false)) parts.push(target.active === false ? "account DISABLED" : "account enabled");
        if (parts.length > 0) {
            audit(req, {
                action: "permissions_changed", category: "users", severity: "warning",
                summary: `Changed access for "${target.username}" - ${parts.join("; ")}`,
                targetType: "User", targetId: target._id,
                details: { preset: target.preset, added, removed, limitBefore: beforeLimit, limitAfter: afterLimit, active: target.active !== false },
            });
        }
        res.status(200).json({ message: "Access updated! ✅", user: { ...target.toObject(), password: undefined, effectivePermissions: after } });
    } catch (error) {
        console.error("Permission update failed", error);
        res.status(500).json({ message: "Failed to update permissions" });
    }
});

// 1.6 🆕 Delete a Staff account
// 🔐 Admin-only. You cannot delete your own account (prevents accidental lockout), and the last
// admin account in the system cannot be deleted either (chicken/egg - there would be nobody left to create a new admin).
router.delete('/:id', protect, requireAdmin, async (req, res) => {
    try {
        if (req.params.id === req.user._id.toString()) {
            return res.status(400).json({ message: "You cannot delete your own account!" });
        }

        const target = await User.findById(req.params.id);
        if (!target) {
            return res.status(404).json({ message: "User not found" });
        }

        if (target.role === 'admin') {
            const adminCount = await User.countDocuments({ role: 'admin' });
            if (adminCount <= 1) {
                return res.status(400).json({ message: "The only Admin account in the system cannot be deleted!" });
            }
        }

        await User.findByIdAndDelete(req.params.id);
        audit(req, { action: "user_deleted", category: "users", severity: "critical", summary: `Deleted ${target.role} account "${target.username}"`, targetType: "User", targetId: target._id });
        res.status(200).json({ message: "Account deleted successfully! 🗑️" });
    } catch (error) {
        res.status(500).json({ message: "Failed to delete" });
    }
});

// 2. Login API - this is the only public route
router.post('/login', loginRateLimiter, async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ success: false, message: "Please enter both Username and Password!" });
        }

        const user = await User.findOne({ username });
        if (user && user.active === false) {
            audit(req, { actor: username, action: "login_blocked", category: "security", severity: "warning", summary: `Login attempt on disabled account "${username}"` });
            return res.status(401).json({ success: false, message: "This account has been disabled - please contact the admin" });
        }
        // Run the comparePassword call even when the user does not exist, to keep the response time the same
        // (to prevent a username enumeration timing attack)
        const isMatch = user ? await user.comparePassword(password) : await bcrypt_dummy();

        if (user && isMatch) {
            const token = generateToken(user);
            audit(req, { actor: user.username, actorRole: user.role, action: "login", category: "security", summary: `${user.username} logged in` });
            res.status(200).json({
                success: true,
                message: "Login successful! ✅",
                token,
                user: publicUser(user)
            });
        } else {
            audit(req, { actor: String(username).slice(0, 60), action: "login_failed", category: "security", severity: "warning", summary: `Failed login for "${String(username).slice(0, 60)}"` });
            res.status(401).json({ success: false, message: "Incorrect Username or Password! ❌" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
});

// dummy hash compare so the login timing looks the same whether or not the username exists
const bcrypt = require('bcryptjs');
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
function bcrypt_dummy() {
    return bcrypt.compare('irrelevant', DUMMY_HASH);
}

module.exports = router;