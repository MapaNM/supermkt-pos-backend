const mongoose = require('mongoose');

// 🆕 INVOICE NUMBER COUNTER
// Sequential Invoice Numbers ලබාදෙන්න (INV-20260719-0001 වගේ) Atomic Counter එකක් විදිහට පාවිච්චි කරයි.
// _id එක "invoice-YYYYMMDD" වගේ දවසකට එකක් - ඒ නිසා දවසකට 0001 ඉඳන් ආපහු ගණන් කරයි (Real POS Receipt Style).
const CounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 }
});

module.exports = mongoose.model('Counter', CounterSchema);