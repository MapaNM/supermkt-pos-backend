const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect, requireAdmin } = require('../middleware/auth');

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
    const { username, password, role } = req.body;
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
        await newUser.save();
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
        res.status(200).json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch data" });
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
        // Run the comparePassword call even when the user does not exist, to keep the response time the same
        // (to prevent a username enumeration timing attack)
        const isMatch = user ? await user.comparePassword(password) : await bcrypt_dummy();

        if (user && isMatch) {
            const token = generateToken(user);
            res.status(200).json({
                success: true,
                message: "Login successful! ✅",
                token,
                user: { username: user.username, role: user.role }
            });
        } else {
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