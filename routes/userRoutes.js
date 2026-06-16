const express = require('express');
const router = express.Router();
const User = require('../models/User');

// 1. අලුත් පරිශීලකයෙක් ඇතුලත් කිරීම (Register API)
router.post('/register', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        const newUser = new User({ username, password, role });
        await newUser.save();
        res.status(201).json({ success: true, message: "පරිශීලකයා සාර්ථකව ඇතුලත් කලා! ✅", user: newUser });
    } catch (error) {
        res.status(500).json({ message: "ඇතුලත් කිරීමේදී දෝෂයක්", error });
    }
});

// Login API
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password });
        if (user) {
            res.status(200).json({ 
                success: true, 
                message: "ලොග් වීම සාර්ථකයි! ✅", 
                user: { username: user.username, role: user.role } 
            });
        } else {
            res.status(401).json({ success: false, message: "Username හෝ Password වැරදියි! ❌" });
        }
    } catch (error) {
        res.status(500).json({ message: "සර්වර් දෝෂයක්", error });
    }
});

module.exports = router;