const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Customer = require('../models/Customer');
const Return = require('../models/Return');
const Counter = require('../models/Counter');

// 🆕 PROFESSIONAL SEQUENTIAL INVOICE NUMBER GENERATOR
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

// 1. භාණ්ඩයක් ඇතුලත් කිරීම (Default Batch එකක් සමඟ)
router.post("/add", async (req, res) => {
  try {
    const { name, price, marketPrice, costPrice, stock, discount, barcode, unit, category, minStockLevel, preferredSupplierId, expiryDate, batches } = req.body;

    const parsedPrice = parseFloat(price) || 0;
    const parsedCost = parseFloat(costPrice) || 0;
    const parsedMarket = parseFloat(marketPrice) || parsedPrice;
    const parsedStock = parseFloat(stock) || 0;

    // Batches එවා නැත්නම් default initial batch එකක් සාදයි
    const initialBatches = (batches && Array.isArray(batches) && batches.length > 0)
      ? batches
      : [{
          batchId: "B-1",
          price: parsedPrice,
          costPrice: parsedCost,
          marketPrice: parsedMarket,
          stock: parsedStock,
          expiryDate: expiryDate || null
        }];

    const newProduct = new Product({
      name,
      price: parsedPrice,
      marketPrice: parsedMarket,
      costPrice: parsedCost,
      stock: parsedStock,
      discount: parseFloat(discount) || 0,
      barcode: barcode || "",
      unit: unit || "Kg",
      category: category || "Grocery",
      minStockLevel: parseFloat(minStockLevel) || 5,
      preferredSupplierId: preferredSupplierId || null,
      expiryDate: expiryDate || null,
      batches: initialBatches
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
    res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි", error: error.message });
  }
});

// 3. භාණ්ඩයක් යාවත්කාලීන කිරීම
router.put("/update/:id", async (req, res) => {
  try {
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
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි", error: error.message });
  }
});

// 4.5 EXPIRING / EXPIRED PRODUCTS LIST
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

// 5. CHECKOUT ROUTE (BATCH-WISE STOCK & MULTI-PRICE SUPPORT)
router.post('/checkout', async (req, res) => {
  try {
    const { cartItems, cashierName, paymentMethod, customerId, cashReceived, balanceAmount, amountPaid } = req.body;

    let totalAmount = 0;
    let totalProfit = 0;
    let totalCustomerSavings = 0;
    const saleItems = [];

    for (const item of cartItems) {
      if (!item._id || item._id.toString().startsWith("temp_")) {
        const tempOriginalP = parseFloat(item.price);
        const tempQty = parseFloat(item.qty || 0);
        totalAmount += tempOriginalP * tempQty;
        totalProfit += (tempOriginalP * 0.15) * tempQty;
        saleItems.push({
          productId: null,
          batchId: item.batchId || "Temp",
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
        const qtyToReduce = parseFloat(item.qty);

        // මුළු Stock එක අඩු කිරීම
        product.stock = Math.max(0, parseFloat(product.stock) - qtyToReduce);

        // 🏷️ Batch-wise Stock එක අඩු කිරීම
        if (item.batchId && product.batches && product.batches.length > 0) {
          const batchIndex = product.batches.findIndex(b => b.batchId === item.batchId);
          if (batchIndex !== -1) {
            product.batches[batchIndex].stock = Math.max(0, product.batches[batchIndex].stock - qtyToReduce);
          }
        }
        await product.save();

        const itemDiscount = parseFloat(item.discount || 0);
        const soldPrice = parseFloat(item.price);
        const finalPriceAfterDiscount = soldPrice - itemDiscount;
        const itemCostPrice = parseFloat(item.costPrice || product.costPrice || 0);

        const itemTotal = finalPriceAfterDiscount * qtyToReduce;
        const itemCost = itemCostPrice * qtyToReduce;
        const itemProfit = itemTotal - itemCost;
        const itemSavings = ((parseFloat(item.marketPrice) || soldPrice) - finalPriceAfterDiscount) * qtyToReduce;

        totalAmount += itemTotal;
        totalProfit += itemProfit;
        totalCustomerSavings += itemSavings;

        saleItems.push({
          productId: product._id,
          batchId: item.batchId || "Default",
          name: item.name,
          marketPrice: item.marketPrice || soldPrice,
          price: finalPriceAfterDiscount,
          costPrice: itemCostPrice,
          qty: qtyToReduce,
          discount: itemDiscount
        });
      }
    }

    let creditToRecord = 0;
    if (customerId) {
      const paid = parseFloat(amountPaid) || 0;
      if (paid < totalAmount) {
        creditToRecord = totalAmount - paid;
        const customer = await Customer.findById(customerId);
        if (customer) {
          customer.creditBalance += creditToRecord;
          if (!customer.creditHistory) customer.creditHistory = [];
          customer.creditHistory.push({
            amount: creditToRecord,
            date: new Date(),
            description: `ණයට ගැනීම (Bill Total: රු.${totalAmount.toFixed(2)}, Paid: රු.${paid.toFixed(2)})`
          });
          await customer.save();
        }
      }
    }

    const invoiceNo = await generateInvoiceNo();

    const newSale = new Sale({
      cashier: cashierName || "Unknown",
      invoiceNo,
      totalAmount,
      totalProfit,
      customerSavings: totalCustomerSavings,
      paymentMethod: paymentMethod || "Cash",
      customerId: customerId || null,
      items: saleItems,
      cashReceived: cashReceived || 0,
      balanceAmount: balanceAmount || 0,
      amountPaid: amountPaid || totalAmount,
      amountDue: creditToRecord
    });
    await newSale.save();

    res.status(200).json({ message: "බිල සාර්ථකව නිම කලා! ✅", amountDue: creditToRecord, saleId: newSale._id, invoiceNo });
  } catch (error) {
    res.status(500).json({ message: "Checkout දෝෂයක්!", error: error.message });
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
    res.status(500).json({ message: "වාර්තා ලබාගැනීම අසාර්ථකයි", error: error.message });
  }
});

// 7. VOID SALE
router.post('/void-sale/:id', async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) return res.status(404).json({ message: "බිල්පත සොයාගත නොහැක" });
    if (sale.status === 'Voided') return res.status(400).json({ message: "මෙම බිල්පත දැනටමත් අවලංගු කර ඇත!" });

    for (const item of sale.items) {
      const notReturnedQty = item.qty - (item.returnedQty || 0);
      if (notReturnedQty <= 0) continue;

      if (item.productId) {
        const prod = await Product.findById(item.productId);
        if (prod) {
          prod.stock += notReturnedQty;
          if (item.batchId && prod.batches && prod.batches.length > 0) {
            const bIdx = prod.batches.findIndex(b => b.batchId === item.batchId);
            if (bIdx !== -1) prod.batches[bIdx].stock += notReturnedQty;
          }
          await prod.save();
        }
      }
    }

    if (sale.paymentMethod === 'Credit' && sale.customerId) {
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
    res.status(500).json({ message: "අවලංගු කිරීම අසාර්ථකයි", error: error.message });
  }
});

// 8. SEARCH INVOICE FOR RETURN
router.get('/invoice/:id', async (req, res) => {
  try {
    const idParam = req.params.id.trim().replace(/[^a-zA-Z0-9-]/g, "");
    let sale = await Sale.findOne({ invoiceNo: idParam.toUpperCase() }).populate('customerId');

    if (!sale && /^[a-fA-F0-9]{24}$/.test(idParam)) {
      sale = await Sale.findById(idParam).populate('customerId');
    }

    if (!sale) {
      return res.status(404).json({ message: "මෙම බිල්පත් අංකය සොයාගත නොහැක! ❌" });
    }
    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: "දත්ත සෙවීමේදී දෝෂයක් ඇති විය!" });
  }
});

// 9. RETURN / REFUND
router.post('/return', async (req, res) => {
  try {
    const { saleId, cashierName, refundMethod, items } = req.body;
    if (!saleId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "අවම වශයෙන් Return කරන භාණ්ඩයක් තෝරන්න!" });
    }

    const sale = await Sale.findById(saleId);
    if (!sale) return res.status(404).json({ message: "බිල සොයාගත නොහැක!" });
    if (sale.status === 'Voided') return res.status(400).json({ message: "අවලංගු කරන ලද බිලකට Return කළ නොහැක!" });

    let totalRefundAmount = 0;
    const returnedItemsLog = [];

    for (const reqItem of items) {
      const returnQty = parseFloat(reqItem.returnQty);
      if (!returnQty || returnQty <= 0) continue;

      const saleItem = sale.items.id(reqItem.itemId);
      if (!saleItem) continue;

      const alreadyReturned = saleItem.returnedQty || 0;
      const availableToReturn = saleItem.qty - alreadyReturned;

      if (returnQty > availableToReturn) {
        return res.status(400).json({ message: `"${saleItem.name}" සඳහා Return කළ හැක්කේ ${availableToReturn} පමණි!` });
      }

      const refundAmount = saleItem.price * returnQty;
      totalRefundAmount += refundAmount;

      // Stock සහ Batch Stock නැවත එකතු කිරීම
      if (saleItem.productId) {
        const prod = await Product.findById(saleItem.productId);
        if (prod) {
          prod.stock += returnQty;
          if (saleItem.batchId && prod.batches && prod.batches.length > 0) {
            const bIdx = prod.batches.findIndex(b => b.batchId === saleItem.batchId);
            if (bIdx !== -1) prod.batches[bIdx].stock += returnQty;
          }
          await prod.save();
        }
      }

      saleItem.returnedQty = alreadyReturned + returnQty;
      returnedItemsLog.push({
        name: saleItem.name,
        qty: returnQty,
        refundAmount,
        reason: reqItem.reason || "සඳහන් කර නැත"
      });
    }

    if (totalRefundAmount <= 0) return res.status(400).json({ message: "වලංගු Return ප්‍රමාණයක් හමු නොවුනි!" });

    if ((refundMethod === 'StoreCredit' || refundMethod === 'CreditAdjust') && sale.customerId) {
      const customer = await Customer.findById(sale.customerId);
      if (customer) {
        customer.creditBalance -= totalRefundAmount;
        customer.creditHistory.push({
          amount: -totalRefundAmount,
          date: new Date(),
          description: `Return/Refund (Bill #${sale.invoiceNo || sale._id.toString().slice(-6)})`
        });
        await customer.save();
      }
    }

    if (sale.paymentMethod === 'Credit') {
      sale.amountDue = Math.max(0, (sale.amountDue || 0) - totalRefundAmount);
    }

    sale.returnedAmount = (sale.returnedAmount || 0) + totalRefundAmount;
    const allFullyReturned = sale.items.every(it => (it.returnedQty || 0) >= it.qty);
    sale.status = allFullyReturned ? 'Returned' : 'PartiallyReturned';
    await sale.save();

    const returnRecord = new Return({
      saleId: sale._id,
      invoiceNo: sale.invoiceNo || null,
      type: 'Return',
      cashier: cashierName || "Unknown",
      customerId: sale.customerId || null,
      items: returnedItemsLog,
      totalRefundAmount,
      refundMethod: refundMethod || 'Cash'
    });
    await returnRecord.save();

    res.status(200).json({
      message: `Return එක සාර්ථකයි! ✅ Refund: රු.${totalRefundAmount.toFixed(2)}`,
      totalRefundAmount,
      saleStatus: sale.status
    });
  } catch (error) {
    res.status(500).json({ message: "Return ක්‍රියාවලිය අසාර්ථකයි!", error: error.message });
  }
});

// 10. EXCHANGE
router.post('/exchange', async (req, res) => {
  try {
    const { saleId, cashierName, refundMethod, returnItems, newItems, extraPaymentMethod, extraCashReceived } = req.body;

    const sale = await Sale.findById(saleId);
    if (!sale) return res.status(404).json({ message: "පැරණි බිල සොයාගත නොහැක!" });

    let totalRefundAmount = 0;
    const returnedItemsLog = [];

    for (const reqItem of returnItems) {
      const returnQty = parseFloat(reqItem.returnQty);
      if (!returnQty || returnQty <= 0) continue;

      const saleItem = sale.items.id(reqItem.itemId);
      if (!saleItem) continue;

      const alreadyReturned = saleItem.returnedQty || 0;
      const refundAmount = saleItem.price * returnQty;
      totalRefundAmount += refundAmount;

      if (saleItem.productId) {
        const prod = await Product.findById(saleItem.productId);
        if (prod) {
          prod.stock += returnQty;
          if (saleItem.batchId && prod.batches && prod.batches.length > 0) {
            const bIdx = prod.batches.findIndex(b => b.batchId === saleItem.batchId);
            if (bIdx !== -1) prod.batches[bIdx].stock += returnQty;
          }
          await prod.save();
        }
      }

      saleItem.returnedQty = alreadyReturned + returnQty;
      returnedItemsLog.push({ name: saleItem.name, qty: returnQty, refundAmount, reason: reqItem.reason || "Exchange" });
    }

    let newItemsTotal = 0;
    let newItemsProfit = 0;
    const newSaleItems = [];

    for (const item of newItems) {
      const qty = parseFloat(item.qty);
      const product = await Product.findById(item._id);
      if (product) {
        product.stock -= qty;
        if (item.batchId && product.batches && product.batches.length > 0) {
          const bIdx = product.batches.findIndex(b => b.batchId === item.batchId);
          if (bIdx !== -1) product.batches[bIdx].stock = Math.max(0, product.batches[bIdx].stock - qty);
        }
        await product.save();
      }

      const itemTotal = parseFloat(item.price) * qty;
      newItemsTotal += itemTotal;
      newItemsProfit += (itemTotal - (parseFloat(item.costPrice || 0) * qty));

      newSaleItems.push({
        productId: item._id || null,
        batchId: item.batchId || "Default",
        name: item.name,
        marketPrice: item.marketPrice || item.price,
        price: item.price,
        costPrice: item.costPrice || 0,
        qty,
        discount: 0
      });
    }

    const exchangeDifference = newItemsTotal - totalRefundAmount;

    const newSale = new Sale({
      cashier: cashierName || "Unknown",
      invoiceNo: await generateInvoiceNo(),
      totalAmount: newItemsTotal,
      totalProfit: newItemsProfit,
      paymentMethod: extraPaymentMethod || 'Cash',
      customerId: sale.customerId || null,
      items: newSaleItems,
      cashReceived: extraCashReceived || 0,
      balanceAmount: 0,
      amountPaid: exchangeDifference > 0 ? exchangeDifference : newItemsTotal,
      amountDue: 0,
      isExchange: true,
      originalSaleId: sale._id
    });
    await newSale.save();

    res.status(200).json({
      message: "Exchange එක සාර්ථකයි! ✅",
      exchangeDifference,
      newSaleId: newSale._id,
      totalRefundAmount,
      newItemsTotal
    });
  } catch (error) {
    res.status(500).json({ message: "Exchange අසාර්ථකයි!", error: error.message });
  }
});

// 11. RETURN HISTORY
router.get('/returns', async (req, res) => {
  try {
    const returns = await Return.find().sort({ createdAt: -1 }).populate('customerId');
    res.status(200).json(returns);
  } catch (error) {
    res.status(500).json({ message: "Return ඉතිහාසය ලබාගැනීම අසාර්ථකයි", error: error.message });
  }
});

module.exports = router;