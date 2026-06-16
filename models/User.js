const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // සරලව තේරුම් ගන්න අපි දැනට plain text දාමු
    role: { type: String, enum: ['admin', 'cashier'], default: 'cashier' } // admin හෝ cashier පමණි
});

module.exports = mongoose.model('User', UserSchema);