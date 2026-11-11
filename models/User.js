const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // 🔐 stored as a bcrypt hash - never plain text
    role: { type: String, enum: ['admin', 'cashier'], default: 'cashier' }, // admin always has every permission

    // 🆕 PERMISSIONS (cashier accounts). `preset` is only the label of the template the admin started from;
    // `permissions` is the real list that is enforced. undefined (legacy accounts) = the "cashier" preset - see utils/permissions.js
    preset: { type: String, enum: ['cashier', 'senior_cashier', 'supervisor', 'manager', 'custom'], default: 'cashier' },
    permissions: { type: [String], default: undefined },
    limits: {
        maxReturnAmount: { type: Number, default: null }, // biggest refund this user may process alone (null = no limit)
    },

    // 🆕 A disabled account cannot log in and its token stops working at once (use this instead of deleting a former employee)
    active: { type: Boolean, default: true },
});

// 🔐 Hash the password before saving when it changed (a new user or a password reset).
// note: do not take a `next` parameter in an async middleware - modern Mongoose (v6/v7+) throws "next is not a function";
// Mongoose continues by itself once the Promise resolves.
UserSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// 🔐 At login, compare the plain-text password with the stored hash
UserSchema.methods.comparePassword = function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);