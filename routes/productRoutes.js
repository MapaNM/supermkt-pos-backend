const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Customer = require('../models/Customer');

// 1. භාණ්ඩයක් ඇතුලත් කිරීම (Discount ද සමඟ)
router.post("/add", async (req, res) => {
  try {
    // 🛠️ UPDATED: req.body එකෙන් 'unit' අගයද වෙන් කර ලබා ගනී
    const { name, price, marketPrice, costPrice, stock, discount, barcode, unit } = req.body;

    const newProduct = new Product({
      name,
      price,
      marketPrice,
      costPrice,
      stock,
      discount,
      barcode,
      unit // 🛠️ UPDATED: නව භාණ්ඩය සමඟ Unit එක සේව් කරයි
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
    // 🛠️ UPDATED: req.body එක කෙලින්ම update කිරීමට දීමෙන් unit එකද ඇතුලත්ව සියල්ල update වේ
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
    res.status(500).json({ message: "යාවत्කාලීන කිරීම අසාර්ථකයි", error: error.message });
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

        const newSale = new Sale({
            cashier: cashierName || "Unknown",
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

        res.status(200).json({ message: "බිල සාර්ථකව නිම කලා! ✅", amountDue: creditToRecord });
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

// 7. VOID SALE
router.post('/void-sale/:id', async (req, res) => {
    try {
        const sale = await Sale.findById(req.params.id);
        if (!sale) return res.status(404).json({ message: "බිල්පත සොයාගත නොහැක" });

        for (const item of sale.items) {
            await Product.findOneAndUpdate(
                { name: item.name },
                { $inc: { stock: item.qty } }
            );
        }

        if (sale.paymentMethod === 'Credit' && sale.customerId) {
            await Customer.findByIdAndUpdate(sale.customerId, {
                $inc: { creditBalance: -sale.totalAmount }
            });
        }

        await Sale.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "බිල්පත සාර්ථකව අවලංගු කලා සහ තොග නැවත එකතු කලා! 🔄" });
    } catch (error) {
        res.status(500).json({ message: "අවලංගු කිරීම අසාර්ථකයි", error });
    }
});

// 🔍 1. බිල්පත් අංකයෙන් පැරණි බිල සෙවීමේ API එක
router.get('/invoice/:id', async (req, res) => {
  try {
    // ඔයාගේ සැබෑ Sale/Order Model එකේ නම (උදා: Sale) මෙතනට දාන්න
    const sale = await Sale.findById(req.params.id).populate('customerId'); 
    
    if (!sale) {
      return res.status(404).json({ message: "මෙම බිල්පත් අංකය සොයාගත නොහැක! ❌" });
    }
    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ error: "දත්ත සෙවීමේදී දෝෂයක් ඇති විය!" });
  }
});

// 🔄 2. භාණ්ඩ Return කිරීම සහ Stock එක Update කිරීමේ API එක
router.post('/return-item', async (req, res) => {
  const { saleId, productId, returnQty, refundAmount } = req.body;

  try {
    // අදාළ බිල සොයා ගැනීම
    const sale = await Sale.findById(saleId);
    if (!sale) return res.status(404).json({ message: "බිල සොයාගත නොහැක!" });

    // බිලේ ඇති අදාළ භාණ්ඩය (Item) සොයා ගැනීම
    const item = sale.cartItems.find(p => p._id.toString() === productId);
    if (!item) return res.status(404).json({ message: "මෙම භාණ්ඩය බිල්පතේ නොමැත!" });

    // දැනට මිලදී ගෙන ඇති ප්‍රමාණයට වඩා Return ප්‍රමාණය වැඩිදැයි බැලීම
    if (returnQty > item.qty) {
      return res.status(400).json({ message: "මිලදී ගත් ප්‍රමාණයට වඩා Return ප්‍රමාණය වැඩි විය නොහැක!" });
    }

    // 📉 පියවර A: සැබෑ Product එකේ Stock එක නැවත වැඩි කිරීම
    // (item.isTemporary නොවන සැබෑ භාණ්ඩ සඳහා පමණක්)
    if (productId) {
      await Product.findByIdAndUpdate(productId, {
        $inc: { stock: returnQty } 
      });
    }

    // 📝 පියවර B: පැරණි බිලේ තොරතුරු වෙනස් කිරීම
    item.qty -= returnQty; // බිලේ ඇති ප්‍රමාණය අඩු කරයි
    sale.totalAmount -= refundAmount; // බිලේ මුළු එකතුව අඩු කරයි
    
    // බිලේ සියලුම භාණ්ඩ වල ප්‍රමාණය 0 වුවහොත් බිල සෘජුවම Void (අවලංගු) කල හැක
    if (sale.totalAmount <= 0) {
      sale.status = "Voided";
    }

    await sale.save();

    res.status(200).json({ message: "භාණ්ඩය සාර්ථකව Return කලා සහ Stock එක අලුත් කලා! ✅🔄" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Return ක්‍රියාවලිය අසාර්ථකයි!" });
  }
});

module.exports = router;