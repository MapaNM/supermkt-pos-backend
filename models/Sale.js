const mongoose = require('mongoose');

const SaleSchema = new mongoose.Schema({
    cashier: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    totalProfit: { type: Number, required: true, default: 0 },
    customerSavings: { type: Number, default: 0 }, // පාරිභෝගිකයාගේ ලාභය
    cashReceived: { type: Number },
    amountPaid: { type: Number },
    amountDue: { type: Number }, // පාරිභෝගිකයාට තව ගෙවිය යුතු මුදල (උදා: ණය මුදල)
    balanceAmount: { type: Number },
    paymentMethod: { type: String, enum: ['Cash', 'Card', 'QR', 'Credit'], default: 'Cash' }, 
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    items: [
        {
            name: { type: String, required: true },
            marketPrice: { type: Number, required: true }, // සාමාන්‍ය මිල
            price: { type: Number, required: true },       // අපේ මිල
            costPrice: { type: Number, required: true, default: 0 },
            qty: { type: Number, required: true }
        }
    ],
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Sale', SaleSchema);