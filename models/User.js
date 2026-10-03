const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // 🔐 bcrypt hash එකක් විදිහට store වේ - plain text කවදාවත් නෑ
    role: { type: String, enum: ['admin', 'cashier'], default: 'cashier' } // admin හෝ cashier පමණි
});

// 🔐 Save කරන්න කලින් password එක වෙනස් වෙලා තියෙනවනම් (අලුත් user කෙනෙක් හෝ password reset) hash කරයි
// note: async middleware වලදී `next` parameter එකක් අරන් call කරන්න එපා - modern Mongoose
// (v6/v7+) වල ඒක "next is not a function" error එකකට හේතු වෙනවා. Promise එක resolve වුනාම
// Mongoose ම ඊළඟට යනවා.
UserSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// 🔐 Login වෙලාවේදී plain text password එක DB එකේ hash එකට සමානද කියලා පරීක්ෂා කරන්න
UserSchema.methods.comparePassword = function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);