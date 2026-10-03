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
        return res.status(429).json({ message: "බොහෝ වාරයක් වැරදි උත්සාහයන්! විනාඩි 15කින් නැවත උත්සාහ කරන්න." });
    }
    next();
}

// 1. අලුත් පරිශීලකයෙක් ඇතුලත් කිරීම (Register API)
// 🔐 Admin කෙනෙක් ලොග් වෙලා ඉන්නවනම් විතරක් - cashier කෙනෙක්ට තව user කෙනෙක් හදන්න බෑ.
// (පළමු admin account එක හදාගන්න scripts/createAdmin.js පාවිච්චි කරන්න - පහත සටහන බලන්න)
router.post('/register', protect, requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ message: "Username සහ Password දෙකම අවශ්‍යයි!" });
        }
        const newUser = new User({ username, password, role });
        await newUser.save();
        res.status(201).json({
            success: true,
            message: "පරිශීලකයා සාර්ථකව ඇතුලත් කලා! ✅",
            user: { username: newUser.username, role: newUser.role } // password hash එක කවදාවත් response එකේ නෑ
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: "මෙම Username එක දැනටමත් පාවිච්චි වෙනවා!" });
        }
        res.status(500).json({ message: "ඇතුලත් කිරීමේදී දෝෂයක්" });
    }
});

// 2. Login API - මෙක විතරයි public route එක
router.post('/login', loginRateLimiter, async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ success: false, message: "Username සහ Password දෙකම ඇතුලත් කරන්න!" });
        }

        const user = await User.findOne({ username });
        // user නැති උනත් comparePassword call එක run කරලා response time එකම තියාගන්න
        // (username enumeration timing attack එකක් වළක්වන්න)
        const isMatch = user ? await user.comparePassword(password) : await bcrypt_dummy();

        if (user && isMatch) {
            const token = generateToken(user);
            res.status(200).json({
                success: true,
                message: "ලොග් වීම සාර්ථකයි! ✅",
                token,
                user: { username: user.username, role: user.role }
            });
        } else {
            res.status(401).json({ success: false, message: "Username හෝ Password වැරදියි! ❌" });
        }
    } catch (error) {
        res.status(500).json({ message: "සර්වර් දෝෂයක්" });
    }
});

// dummy hash compare so the login timing looks the same whether or not the username exists
const bcrypt = require('bcryptjs');
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
function bcrypt_dummy() {
    return bcrypt.compare('irrelevant', DUMMY_HASH);
}

module.exports = router;