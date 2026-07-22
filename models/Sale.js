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

    // 🆕 PROFESSIONAL SEQUENTIAL INVOICE NUMBER (e.g. INV-20260719-0001)
    // sparse: true -> මේ field එක නැති පරණ Sales වලට Unique constraint එක apply වෙන්නේ නෑ
    invoiceNo: { type: String, unique: true, sparse: true },

    // 🆕 RETURN / REFUND / EXCHANGE TRACKING
    status: { type: String, enum: ['Completed', 'PartiallyReturned', 'Returned', 'Voided'], default: 'Completed' },
    returnedAmount: { type: Number, default: 0 }, // මේ බිලෙන් මේ දක්වා Refund කරපු මුළු එකතුව
    isExchange: { type: Boolean, default: false }, // මේ Sale එක Exchange එකකින් ආපු අලුත් items sale එකක්ද
    originalSaleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null }, // Exchange නම්, පරණ බිල මොකක්ද
    linkedExchangeSaleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null }, // පරණ බිල මත, Exchange එකෙන් හැදුනු අලුත් බිල මොකක්ද

    items: [
        {
            productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null }, // 🆕 Stock return කරන්න/expiry check කරන්න
            name: { type: String, required: true },
            marketPrice: { type: Number, required: true }, // සාමාන්‍ය මිල
            price: { type: Number, required: true },       // අපේ මිල (Discount අඩු කරලා)
            costPrice: { type: Number, required: true, default: 0 },
            qty: { type: Number, required: true },
            returnedQty: { type: Number, default: 0 } // 🆕 මේ item එකෙන් මේ දක්වා Return කරපු ප්‍රමාණය
        }
    ],
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Sale', SaleSchema);