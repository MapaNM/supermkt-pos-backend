const mongoose = require('mongoose');

const ReturnSchema = new mongoose.Schema({
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
    invoiceNo: { type: String, default: null }, // 🆕 Report/History එකේ ලේසියෙන් පෙන්වන්න original Invoice No එකේ Copy එකක්
    type: { type: String, enum: ['Return', 'Exchange'], default: 'Return' },
    cashier: { type: String, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },

    items: [
        {
            name: { type: String, required: true },
            qty: { type: Number, required: true },
            refundAmount: { type: Number, required: true },
            reason: { type: String, default: "සඳහන් කර නැත" }
        }
    ],

    totalRefundAmount: { type: Number, required: true, default: 0 },
    refundMethod: { type: String, enum: ['Cash', 'Card', 'StoreCredit', 'CreditAdjust'], default: 'Cash' },

    // 🆕 EXCHANGE දත්ත - Exchange කිරීමකදී පමණක් පුරවනු ලැබේ
    exchangeNewSaleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    newItemsTotal: { type: Number, default: 0 },
    exchangeDifference: { type: Number, default: 0 }, // + නම් පාරිභෝගිකයා තව ගෙවිය යුතුයි, - නම් අමතර මුදල Refund කලා

    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Return', ReturnSchema);