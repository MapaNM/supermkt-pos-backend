const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Customer = require('../models/Customer');
const Return = require('../models/Return');
const Counter = require('../models/Counter');

// 🆕 PROFESSIONAL SEQUENTIAL INVOICE NUMBER GENERATOR
// Format: INV-YYYYMMDD-0001 (දවසකට 0001 ඉඳන් නැවත ගණන් කරයි - Real POS Receipt Style)
// $inc + upsert භාවිතා කරන්නේ Atomic විදිහට - එකවරම Checkout දෙකක් ආවත්, එකම අංකයක් දෙකට නොලැබෙන්න
async function generateInvoiceNo() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const counterId = `invoice-${dateStr}`;

  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );

  return `INV-${dateStr}-${String(counter.seq).padStart(4, "0")}`;
}

// 1. භාණ්ඩයක් ඇතුලත් කිරීම (Discount ද සමඟ)
router.post("/add", async (req, res) => {
  try {
    // 🛠️ UPDATED: 'expiryDate' ද වෙන් කර ලබා ගනී
    const { name, price, marketPrice, costPrice, stock, discount, barcode, unit, category, minStockLevel, preferredSupplierId, expiryDate } = req.body;

    const newProduct = new Product({
      name,
      price,
      marketPrice,
      costPrice,
      stock,
      discount,
      barcode,
      unit,
      category,
      minStockLevel,           // 🛠️ Reorder Alert Level
      preferredSupplierId: preferredSupplierId || null, // 🛠️ Reorder Suggestion සඳහා
      expiryDate: expiryDate || null // 🆕 Expiry Date
    });

    await newProduct.save();
    res.status(201).json({ message: "භාණ්ඩය සාර්ථකව ඇතුලත් කලා! ✅", product: newProduct });
  } catch (error) {
    res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි", error: error.message });
  }
});

// 2. සියලුම භාණ්ඩ ලබාගැනීම
router.get('/', async (req, res) => {
    try {
        const products = await Product.find();
        res.status(200).json(products);
    } catch (error) {
        res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි", error });
    }
});

// 3. භාණ්ඩයක් යාවත්කාලීන කිරීම
router.put("/update/:id", async (req, res) => {
  try {
    // req.body එක කෙලින්ම update කිරීමට දීමෙන් minStockLevel/preferredSupplierId/expiryDate ඇතුලුව සියල්ල update වේ
    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { returnDocument: 'after', runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ message: "භාණ්ඩය සොයාගත නොහැක" });
    }

    res.json({ message: "යාවත්කාලීන කිරීම සාර්ථකයි! 🔄", product: updatedProduct });
  } catch (error) {
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි", error: error.message });
  }
});

// 4. භාණ්ඩයක් මකා දැමීම
router.delete('/delete/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "භාණ්ඩය සාර්ථකව මකා දැමුවා! 🗑️" });
    } catch (error) {
        res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි", error });
    }
});

// 🆕 4.5 EXPIRING / EXPIRED PRODUCTS LIST (Admin Dashboard Alert එකට)
// ?days=7 -> ඉදිරි දවස් 7ක් ඇතුලත Expire වෙන සහ දැනටමත් Expire වෙච්ච සියල්ල return කරයි
router.get('/expiring', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const now = new Date();
        const futureDate = new Date();
        futureDate.setDate(now.getDate() + days);

        const products = await Product.find({
            expiryDate: { $ne: null, $lte: futureDate }
        }).sort({ expiryDate: 1 });

        const result = products.map(p => {
            const isExpired = new Date(p.expiryDate) < now;
            return {
                ...p.toObject(),
                expiryStatus: isExpired ? "expired" : "expiring"
            };
        });

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Expiry දත්ත ලබාගැනීම අසාර්ථකයි", error: error.message });
    }
});

// 5. CHECKOUT ROUTE WITH DISCOUNTS (UPDATED WITH CREDIT HISTORY LOGS)
router.post('/checkout', async (req, res) => {
    try {
        // amountPaid (පාරිභෝගිකයා ගෙවූ මුදල) එකතු කරගන්නවා
        const { cartItems, cashierName, paymentMethod, customerId, cashReceived, balanceAmount, amountPaid } = req.body;

        let totalAmount = 0;
        let totalProfit = 0;
        let totalCustomerSavings = 0;
        const saleItems = [];

        for (const item of cartItems) {
            // 🚨 dynamic unsaved items සදහා database එකෙන් සෙවීම skip කරයි
            if (!item._id || item._id.toString().startsWith("temp_")) {
                const tempOriginalP = parseFloat(item.price);
                const tempQty = parseFloat(item.qty || 0);
                totalAmount += tempOriginalP * tempQty;
                totalProfit += (tempOriginalP * 0.15) * tempQty; // Dummy profit margin for temp items
                saleItems.push({
                    productId: null, // 🆕 Temp items වලට සැබෑ Product reference එකක් නැත
                    name: item.name,
                    marketPrice: item.marketPrice || item.price,
                    price: tempOriginalP,
                    costPrice: item.costPrice || (tempOriginalP * 0.85),
                    qty: tempQty,
                    discount: 0
                });
                continue;
            }

            const product = await Product.findById(item._id);
            if (product) {
                // කිරන බඩු සඳහා දශම සංඛ්‍යා අඩු වීමට ඉඩ සලසයි
                product.stock = parseFloat(product.stock) - parseFloat(item.qty);
                if (product.stock < 0) product.stock = 0;
                await product.save();

                const itemDiscount = product.discount || 0;
                const finalPriceAfterDiscount = item.price - itemDiscount;

                const itemTotal = finalPriceAfterDiscount * parseFloat(item.qty);
                const itemCost = (product.costPrice || 0) * parseFloat(item.qty);
                const itemProfit = itemTotal - itemCost;

                const itemSavings = ((product.marketPrice || item.price) - finalPriceAfterDiscount) * parseFloat(item.qty);

                totalAmount += itemTotal;
                totalProfit += itemProfit;
                totalCustomerSavings += itemSavings;

                saleItems.push({
                    productId: product._id, // 🆕 Return/Exchange වලදී Stock නැවත එකතු කරන්න මේක ඕන
                    name: item.name,
                    marketPrice: product.marketPrice || item.price,
                    price: finalPriceAfterDiscount,
                    costPrice: product.costPrice || 0,
                    qty: parseFloat(item.qty),
                    discount: itemDiscount
                });
            }
        }

        // 📝 PART PAYMENT / CREDIT BOOK LOGIC
        // පාරිභෝගිකයෙක් සම්බන්ධ කරලා තියෙනවා නම් සහ බිල මුළුමනින්ම හෝ කොටසක් ණයට දෙනවා නම්
        let creditToRecord = 0;
        if (customerId) {
            const paid = parseFloat(amountPaid) || 0;
            if (paid < totalAmount) {
                creditToRecord = totalAmount - paid; // ණය මුදල = මුළු බිල - ගෙවූ මුදල
                
                const customer = await Customer.findById(customerId);
                if (customer) {
                    customer.creditBalance += creditToRecord; // ණය පොතට එකතු කිරීම
                    
                    // 🛠️ UPDATED LINE: ණය ගත් ඉතිහාසය (Logs) වෙන වෙනම සටහන් කරගැනීම මෙතැනදී සිදුවේ
                    if (!customer.creditHistory) {
                        customer.creditHistory = []; // වැරදීමකින් හෝ Array එකක් නැත්නම් අලුතින් සාදයි
                    }
                    
                    customer.creditHistory.push({
                        amount: creditToRecord,
                        date: new Date(),
                        description: `ණයට ගැනීම (Bill Total: රු.${totalAmount.toFixed(2)}, Paid: රු.${paid.toFixed(2)})`
                    });

                    await customer.save();
                }
            }
        }

        const invoiceNo = await generateInvoiceNo(); // 🆕 Professional Sequential Invoice Number

        const newSale = new Sale({
            cashier: cashierName || "Unknown",
            invoiceNo, // 🆕
            totalAmount: totalAmount,
            totalProfit: totalProfit,
            customerSavings: totalCustomerSavings,
            paymentMethod: paymentMethod || "Cash",
            customerId: customerId || null,
            items: saleItems,
            cashReceived: cashReceived || 0,
            balanceAmount: balanceAmount || 0,
            amountPaid: amountPaid || totalAmount, // බිලට සේව් වන ගෙවූ මුදල
            amountDue: creditToRecord             // බිලට සේව් වන ණය මුදල
        });
        await newSale.save();

        res.status(200).json({ message: "බිල සාර්ථකව නිම කලා! ✅", amountDue: creditToRecord, saleId: newSale._id, invoiceNo });
    } catch (error) {
        res.status(500).json({ message: "Checkout දෝෂයක්!", error });
    }
});

// 6. DASHBOARD SUMMARY
router.get('/sales-summary', async (req, res) => {
    try {
        const sales = await Sale.find().sort({ createdAt: -1 });
        let totalRevenue = 0;
        let totalProfit = 0;
        let cashSales = 0;
        let cardSales = 0;
        let qrSales = 0;
        let creditSales = 0;

        sales.forEach(sale => {
            totalRevenue += sale.totalAmount;
            totalProfit += sale.totalProfit;
            if (sale.paymentMethod === 'Cash') cashSales += sale.totalAmount;
            else if (sale.paymentMethod === 'Card') cardSales += sale.totalAmount;
            else if (sale.paymentMethod === 'QR') qrSales += sale.totalAmount;
            else if (sale.paymentMethod === 'Credit') creditSales += sale.totalAmount;
        });

        res.status(200).json({
            totalSalesCount: sales.length,
            totalRevenue,
            totalProfit,
            breakdown: { cashSales, cardSales, qrSales, creditSales },
            sales
        });
    } catch (error) {
        res.status(500).json({ message: "වාර්තා ලබාගැනීම අසාර්ථකයි", error });
    }
});

// 7. VOID SALE (මුළු බිලම අවලංගු කිරීම)
router.post('/void-sale/:id', async (req, res) => {
    try {
        const sale = await Sale.findById(req.params.id);
        if (!sale) return res.status(404).json({ message: "බිල්පත සොයාගත නොහැක" });

        if (sale.status === 'Voided') {
            return res.status(400).json({ message: "මෙම බිල්පත දැනටමත් අවලංගු කර ඇත!" });
        }

        for (const item of sale.items) {
            // 🛠️ UPDATED: හැකි නම් productId එකෙන්ම Stock එක නැවත එකතු කරයි (namekින් වඩා විශ්වාසදායී), නැත්නම් name එකෙන්
            const notReturnedQty = item.qty - (item.returnedQty || 0);
            if (notReturnedQty <= 0) continue; // දැනටමත් සම්පූර්ණයෙන් Return කර ඇති item

            if (item.productId) {
                await Product.findByIdAndUpdate(item.productId, { $inc: { stock: notReturnedQty } });
            } else {
                await Product.findOneAndUpdate({ name: item.name }, { $inc: { stock: notReturnedQty } });
            }
        }

        if (sale.paymentMethod === 'Credit' && sale.customerId) {
            // ඉතිරිව තියෙන ණය මුදල විතරක් customer ගෙන් අඩු කරයි (කලින් Return කරපු ප්‍රමාණයට credit දැනටමත් adjust වෙලා ඇති)
            const remainingCredit = (sale.amountDue || 0);
            if (remainingCredit > 0) {
                await Customer.findByIdAndUpdate(sale.customerId, {
                    $inc: { creditBalance: -remainingCredit }
                });
            }
        }

        sale.status = 'Voided';
        await sale.save();

        res.status(200).json({ message: "බිල්පත සාර්ථකව අවලංගු කලා සහ තොග නැවත එකතු කලා! 🔄" });
    } catch (error) {
        res.status(500).json({ message: "අවලංගු කිරීම අසාර්ථකයි", error });
    }
});

// 🔍 8. බිල්පත් අංකයෙන් පැරණි බිල සෙවීමේ API එක (Return/Exchange Screen එකට)
// 🛠️ UPDATED: සම්පූර්ණ Mongo ID එක හෝ Receipt එකේ print වන කෙටි Reference අංකය (අන්තිම අකුරු 8) දෙකින්ම සෙවිය හැක
router.get('/invoice/:id', async (req, res) => {
  try {
    // 🛠️ FIX: Search කරන කලින් # සලකුණ, Space ඉවත් කරලා Clean කරගන්නවා (Hyphen "-" තියෙනවා Invoice No එකේ නිසා තියාගන්නවා)
    const idParam = req.params.id.trim().replace(/[^a-zA-Z0-9-]/g, "");

    let sale = null;

    // 1️⃣ PRIMARY: අලුත් Professional Invoice Number එකෙන් සෙවීම (e.g. INV-20260719-0001)
    sale = await Sale.findOne({ invoiceNo: idParam.toUpperCase() }).populate('customerId');

    // 2️⃣ FALLBACK: සම්පූර්ණ Mongo Database ID එකකින් සෙවීම (invoiceNo නැති පරණ Sales සඳහා)
    if (!sale) {
      const isFullMongoId = /^[a-fA-F0-9]{24}$/.test(idParam);
      if (isFullMongoId) {
        sale = await Sale.findById(idParam).populate('customerId');
      }
    }

    // 3️⃣ FALLBACK: Mongo ID එකේ අන්තිම අකුරු වලින් සෙවීම (invoiceNo නැති, ඉතාම පරණ Sales සඳහා)
    if (!sale && idParam.length >= 4) {
      const suffix = idParam.toLowerCase();
      const candidates = await Sale.find().sort({ createdAt: -1 }).limit(2000).select('_id').lean();
      const match = candidates.find(c => c._id.toString().toLowerCase().endsWith(suffix));
      if (match) {
        sale = await Sale.findById(match._id).populate('customerId');
      }
    }

    if (!sale) {
      return res.status(404).json({ message: "මෙම බිල්පත් අංකය සොයාගත නොහැක! ❌" });
    }
    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: "දත්ත සෙවීමේදී දෝෂයක් ඇති විය!" });
  }
});

// 🔄 9. RETURN / REFUND (කොටසක් හෝ සම්පූර්ණ බිලක් Return කිරීම)
// body: { saleId, cashierName, refundMethod: 'Cash'|'Card'|'StoreCredit'|'CreditAdjust',
//         items: [{ itemId (sale.items subdocument _id), returnQty, reason }] }
router.post('/return', async (req, res) => {
  try {
    const { saleId, cashierName, refundMethod, items } = req.body;

    if (!saleId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "අවම වශයෙන් Return කරන භාණ්ඩයක් තෝරන්න!" });
    }

    const sale = await Sale.findById(saleId);
    if (!sale) return res.status(404).json({ message: "බිල සොයාගත නොහැක!" });
    if (sale.status === 'Voided') {
      return res.status(400).json({ message: "අවලංගු කරන ලද බිලකට Return කළ නොහැක!" });
    }

    let totalRefundAmount = 0;
    const returnedItemsLog = [];

    for (const reqItem of items) {
      const returnQty = parseFloat(reqItem.returnQty);
      if (!returnQty || returnQty <= 0) continue;

      const saleItem = sale.items.id(reqItem.itemId);
      if (!saleItem) {
        return res.status(404).json({ message: "එක් භාණ්ඩයක් මෙම බිල්පතේ සොයාගත නොහැක!" });
      }

      const alreadyReturned = saleItem.returnedQty || 0;
      const availableToReturn = saleItem.qty - alreadyReturned;

      if (returnQty > availableToReturn) {
        return res.status(400).json({
          message: `"${saleItem.name}" සඳහා Return කළ හැක්කේ ${availableToReturn} ${''} පමණි (දැනටමත් ${alreadyReturned} Return කර ඇත)!`
        });
      }

      const refundAmount = saleItem.price * returnQty;
      totalRefundAmount += refundAmount;

      // 📦 Stock එක නැවත වැඩි කිරීම (Real Product එකක් නම් පමණි)
      if (saleItem.productId) {
        await Product.findByIdAndUpdate(saleItem.productId, { $inc: { stock: returnQty } });
      }

      saleItem.returnedQty = alreadyReturned + returnQty;

      returnedItemsLog.push({
        name: saleItem.name,
        qty: returnQty,
        refundAmount,
        reason: reqItem.reason || "සඳහන් කර නැත"
      });
    }

    if (totalRefundAmount <= 0) {
      return res.status(400).json({ message: "වලංගු Return ප්‍රමාණයක් හමු නොවුනි!" });
    }

    // 💰 REFUND METHOD HANDLING
    if ((refundMethod === 'StoreCredit' || refundMethod === 'CreditAdjust') && sale.customerId) {
      const customer = await Customer.findById(sale.customerId);
      if (customer) {
        // StoreCredit -> Shop එකෙන් Customer ට ණයයි (creditBalance අඩු කරයි, negative වුනත් කමක් නෑ)
        // CreditAdjust -> මුල් බිල Credit බිලක් නම්, ඒ ණයෙන් මේ අගය අඩු කරයි
        customer.creditBalance -= totalRefundAmount;
        customer.creditHistory.push({
          amount: -totalRefundAmount,
          date: new Date(),
          description: `Return/Refund - ${refundMethod === 'StoreCredit' ? 'Store Credit' : 'Credit Adjustment'} (Bill #${sale._id.toString().slice(-6)})`
        });
        await customer.save();
      }
    }

    // ණයට දුන් බිලක් නම්, ඉතුරු ණය මුදලෙන් Refund කරන ප්‍රමාණය අඩු කරයි
    if (sale.paymentMethod === 'Credit') {
      sale.amountDue = Math.max(0, (sale.amountDue || 0) - totalRefundAmount);
    }

    sale.returnedAmount = (sale.returnedAmount || 0) + totalRefundAmount;

    // 📌 STATUS UPDATE: සියලුම items සම්පූර්ණයෙන් Return වුනාද කියලා බලයි
    const allFullyReturned = sale.items.every(it => (it.returnedQty || 0) >= it.qty);
    sale.status = allFullyReturned ? 'Returned' : 'PartiallyReturned';

    await sale.save();

    // 📝 Return Log එකක් සටහන් කරයි (Audit/Reporting සඳහා)
    const returnRecord = new Return({
      saleId: sale._id,
      invoiceNo: sale.invoiceNo || null, // 🆕
      type: 'Return',
      cashier: cashierName || "Unknown",
      customerId: sale.customerId || null,
      items: returnedItemsLog,
      totalRefundAmount,
      refundMethod: refundMethod || 'Cash'
    });
    await returnRecord.save();

    res.status(200).json({
      message: `Return එක සාර්ථකයි! ✅ Refund කරන ලද මුදල: රු.${totalRefundAmount.toFixed(2)}`,
      totalRefundAmount,
      saleStatus: sale.status
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Return ක්‍රියාවලිය අසාර්ථකයි!", error: error.message });
  }
});

// 🔁 10. EXCHANGE (Return + අලුත් භාණ්ඩ එකවර සිදු කිරීම)
// body: { saleId, cashierName, refundMethod, returnItems: [{itemId, returnQty, reason}],
//         newItems: [{ _id/productId, name, price, marketPrice, costPrice, qty, discount }],
//         extraPaymentMethod: 'Cash'|'Card'|'QR'|'Credit', extraCashReceived }
router.post('/exchange', async (req, res) => {
  try {
    const { saleId, cashierName, refundMethod, returnItems, newItems, extraPaymentMethod, extraCashReceived } = req.body;

    if (!saleId || !Array.isArray(returnItems) || returnItems.length === 0) {
      return res.status(400).json({ message: "අවම වශයෙන් Return කරන භාණ්ඩයක් තෝරන්න!" });
    }
    if (!Array.isArray(newItems) || newItems.length === 0) {
      return res.status(400).json({ message: "Exchange කරන අලුත් භාණ්ඩ තෝරන්න!" });
    }

    const sale = await Sale.findById(saleId);
    if (!sale) return res.status(404).json({ message: "පැරණි බිල සොයාගත නොහැක!" });
    if (sale.status === 'Voided') {
      return res.status(400).json({ message: "අවලංගු කරන ලද බිලකට Exchange කළ නොහැක!" });
    }

    // --- STEP A: RETURN OLD ITEMS ---
    let totalRefundAmount = 0;
    const returnedItemsLog = [];

    for (const reqItem of returnItems) {
      const returnQty = parseFloat(reqItem.returnQty);
      if (!returnQty || returnQty <= 0) continue;

      const saleItem = sale.items.id(reqItem.itemId);
      if (!saleItem) {
        return res.status(404).json({ message: "එක් භාණ්ඩයක් මෙම බිල්පතේ සොයාගත නොහැක!" });
      }

      const alreadyReturned = saleItem.returnedQty || 0;
      const availableToReturn = saleItem.qty - alreadyReturned;
      if (returnQty > availableToReturn) {
        return res.status(400).json({ message: `"${saleItem.name}" සඳහා Return කළ හැක්කේ ${availableToReturn} පමණි!` });
      }

      const refundAmount = saleItem.price * returnQty;
      totalRefundAmount += refundAmount;

      if (saleItem.productId) {
        await Product.findByIdAndUpdate(saleItem.productId, { $inc: { stock: returnQty } });
      }

      saleItem.returnedQty = alreadyReturned + returnQty;
      returnedItemsLog.push({ name: saleItem.name, qty: returnQty, refundAmount, reason: reqItem.reason || "Exchange" });
    }

    // --- STEP B: SELL NEW ITEMS ---
    let newItemsTotal = 0;
    let newItemsProfit = 0;
    const newSaleItems = [];

    for (const item of newItems) {
      if (!item._id || item._id.toString().startsWith("temp_")) {
        const p = parseFloat(item.price);
        const q = parseFloat(item.qty || 0);
        newItemsTotal += p * q;
        newItemsProfit += (p * 0.15) * q;
        newSaleItems.push({
          productId: null, name: item.name, marketPrice: item.marketPrice || item.price,
          price: p, costPrice: item.costPrice || (p * 0.85), qty: q, discount: 0
        });
        continue;
      }

      const product = await Product.findById(item._id);
      if (!product) continue;

      const qty = parseFloat(item.qty);
      if (qty > product.stock) {
        return res.status(400).json({ message: `🚫 තොග නොමැත! "${product.name}" තොගයේ ඇත්තේ: ${product.stock}` });
      }

      product.stock -= qty;
      await product.save();

      const itemDiscount = product.discount || 0;
      const finalPrice = item.price - itemDiscount;
      const itemTotal = finalPrice * qty;
      const itemCost = (product.costPrice || 0) * qty;

      newItemsTotal += itemTotal;
      newItemsProfit += (itemTotal - itemCost);

      newSaleItems.push({
        productId: product._id, name: item.name, marketPrice: product.marketPrice || item.price,
        price: finalPrice, costPrice: product.costPrice || 0, qty, discount: itemDiscount
      });
    }

    // --- STEP C: CALCULATE DIFFERENCE ---
    // positive = පාරිභෝගිකයා තව ගෙවිය යුතුයි, negative = අමතර මුදල ආපසු දිය යුතුයි
    const exchangeDifference = newItemsTotal - totalRefundAmount;

    // Old sale update
    if (sale.paymentMethod === 'Credit') {
      sale.amountDue = Math.max(0, (sale.amountDue || 0) - totalRefundAmount);
    }
    sale.returnedAmount = (sale.returnedAmount || 0) + totalRefundAmount;
    const allFullyReturned = sale.items.every(it => (it.returnedQty || 0) >= it.qty);
    sale.status = allFullyReturned ? 'Returned' : 'PartiallyReturned';

    // New sale for the exchanged items
    const paymentMethodForNew = extraPaymentMethod || (exchangeDifference <= 0 ? 'Cash' : 'Cash');
    let creditToRecord = 0;
    if (exchangeDifference > 0 && paymentMethodForNew === 'Credit' && sale.customerId) {
      const customer = await Customer.findById(sale.customerId);
      if (customer) {
        creditToRecord = exchangeDifference;
        customer.creditBalance += creditToRecord;
        customer.creditHistory.push({
          amount: creditToRecord,
          date: new Date(),
          description: `Exchange - අමතර ණය මුදල (Bill #${sale._id.toString().slice(-6)})`
        });
        await customer.save();
      }
    } else if (exchangeDifference < 0 && (refundMethod === 'StoreCredit' || refundMethod === 'CreditAdjust') && sale.customerId) {
      // අමතර මුදල Store Credit විදිහට customer ට ආපහු දෙයි
      const customer = await Customer.findById(sale.customerId);
      if (customer) {
        customer.creditBalance -= Math.abs(exchangeDifference);
        customer.creditHistory.push({
          amount: -Math.abs(exchangeDifference),
          date: new Date(),
          description: `Exchange - අමතර මුදල Store Credit (Bill #${sale._id.toString().slice(-6)})`
        });
        await customer.save();
      }
    }

    const newSale = new Sale({
      cashier: cashierName || "Unknown",
      invoiceNo: await generateInvoiceNo(), // 🆕 Exchange එකෙන් හැදෙන අලුත් Sale එකටත් තමන්ගේම Invoice No එකක්
      totalAmount: newItemsTotal,
      totalProfit: newItemsProfit,
      paymentMethod: paymentMethodForNew,
      customerId: sale.customerId || null,
      items: newSaleItems,
      cashReceived: extraCashReceived || 0,
      balanceAmount: 0,
      amountPaid: exchangeDifference > 0 ? (paymentMethodForNew === 'Credit' ? 0 : exchangeDifference) : newItemsTotal,
      amountDue: creditToRecord,
      isExchange: true,
      originalSaleId: sale._id
    });
    await newSale.save();

    sale.linkedExchangeSaleId = newSale._id;
    await sale.save();

    // 📝 Return/Exchange Log
    const returnRecord = new Return({
      saleId: sale._id,
      invoiceNo: sale.invoiceNo || null, // 🆕
      type: 'Exchange',
      cashier: cashierName || "Unknown",
      customerId: sale.customerId || null,
      items: returnedItemsLog,
      totalRefundAmount,
      refundMethod: refundMethod || 'Cash',
      exchangeNewSaleId: newSale._id,
      newItemsTotal,
      exchangeDifference
    });
    await returnRecord.save();

    res.status(200).json({
      message: "Exchange එක සාර්ථකව සම්පූර්ණ කලා! ✅🔁",
      exchangeDifference,
      newSaleId: newSale._id,
      totalRefundAmount,
      newItemsTotal
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Exchange ක්‍රියාවලිය අසාර්ථකයි!", error: error.message });
  }
});

// 📜 11. RETURN / EXCHANGE HISTORY (Admin Reporting සඳහා)
router.get('/returns', async (req, res) => {
  try {
    const returns = await Return.find().sort({ createdAt: -1 }).populate('customerId');
    res.status(200).json(returns);
  } catch (error) {
    res.status(500).json({ message: "Return ඉතිහාසය ලබාගැනීම අසාර්ථකයි", error: error.message });
  }
});

module.exports = router;