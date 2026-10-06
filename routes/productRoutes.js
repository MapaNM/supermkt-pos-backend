const express = require('express');
const mongoose = require('mongoose'); // 🔐 needed for session/transaction support
const router = express.Router();
const RouteError = require('../utils/RouteError');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Customer = require('../models/Customer');
const Return = require('../models/Return');
const Counter = require('../models/Counter');
const Promotion = require('../models/Promotion'); // 🔐 needed to verify bill-level discounts server-side
const { requireAdmin } = require('../middleware/auth'); // 🔐 note: `protect` is already applied to the whole /api/products path in server.js

// 🛠️ NEW: JavaScript Floating-Point Precision Errors (0.1 + 0.2 = 0.30000000000000004 වගේ) නිවැරදි කිරීමට
// Stock එකට Add/Subtract කරන හැම තැනකම මේකෙන් Round කර, Dirty Values (3.5500000000000007 වගේ) DB එකට Save වීම වළක්වයි
const roundQty = (num) => Math.round((parseFloat(num) || 0) * 1000) / 1000;

// 🆕 PROFESSIONAL SEQUENTIAL INVOICE NUMBER GENERATOR
// 🔐 `session` (optional) - checkout එක transaction එකක් ඇතුලේ run කරද්දී, invoice number එකේ
// counter increment එකත් ඒ transaction එකටම join කරගන්න - transaction එක rollback උනොත් counter
// එකත් rollback වෙනවා, නැත්තම් "invoice number skip" වෙන pattern එකක් හැදෙනවා.
async function generateInvoiceNo(session = null) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const counterId = `invoice-${dateStr}`;

  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );

  return `INV-${dateStr}-${String(counter.seq).padStart(4, "0")}`;
}

// 1. භාණ්ඩයක් ඇතුලත් කිරීම (Default Batch එකක් සමඟ)
router.post("/add", requireAdmin, async (req, res) => {
  try {
    const { name, price, marketPrice, costPrice, stock, discount, barcode, unit, category, minStockLevel, preferredSupplierId, expiryDate, batches } = req.body;

    const parsedPrice = parseFloat(price) || 0;
    const parsedCost = parseFloat(costPrice) || 0;
    const parsedMarket = parseFloat(marketPrice) || parsedPrice;
    const parsedStock = roundQty(stock);

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
      unit: unit ?? "Kg", // 🛠️ FIX: "" (Unit නැත, intentional) වලට "Kg" force නොවෙන්න - undefined/null වලට විතරක් fallback
      category: category || "Grocery",
      minStockLevel: parseFloat(minStockLevel) || 5,
      preferredSupplierId: preferredSupplierId || null,
      expiryDate: expiryDate || null,
      batches: initialBatches
    });

    await newProduct.save();
    res.status(201).json({ message: "භාණ්ඩය සාර්ථකව ඇතුලත් කලා! ✅", product: newProduct });
  } catch (error) {
    console.error("ඇතුලත් කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි" });
  }
});

// 2. සියලුම භාණ්ඩ ලබාගැනීම
router.get('/', async (req, res) => {
  try {
    const products = await Product.find();
    res.status(200).json(products);
  } catch (error) {
    console.error("දත්ත ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි" });
  }
});

// 3. භාණ්ඩයක් යාවත්කාලීන කිරීම
router.put("/update/:id", requireAdmin, async (req, res) => {
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
    console.error("යාවත්කාලීන කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි" });
  }
});

// 4. භාණ්ඩයක් මකා දැමීම
router.delete('/delete/:id', requireAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "භාණ්ඩය සාර්ථකව මකා දැමුවා! 🗑️" });
  } catch (error) {
    console.error("මකා දැමීම අසාර්ථකයි", error);
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි" });
  }
});

// 4.5 EXPIRING / EXPIRED PRODUCTS LIST
router.get('/expiring', requireAdmin, async (req, res) => {
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
    console.error("Expiry දත්ත ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Expiry දත්ත ලබාගැනීම අසාර්ථකයි" });
  }
});

// 5. CHECKOUT ROUTE (BATCH-WISE STOCK & MULTI-PRICE SUPPORT)
// 🔐 UPDATED: Checkout එකේ මිල/වට්ටම දැන් client එකෙන් එවන දේම විශ්වාස කරන්නේ නෑ - DB එකේ
// තියෙන සැබෑ Product/Batch මිලට සහ active Occasion Promotion එකට සාපේක්ෂව server එකෙන්ම
// validate කරලා, ගැලපෙන්නේ නැත්නම් මුළු checkout එකම reject කරයි. "temp_" (manual typed)
// items වලට පමණයි client එකේ price එක ම විශ්වාස කරන්නේ - ඒවාට DB record එකක් නැති නිසා.
const PRICE_TOLERANCE = 0.01; // floating-point rounding allowance, රු.1 cent ට අඩු වෙනස්කම් විතරයි

router.post('/checkout', async (req, res) => {
  const { cartItems, cashierName, paymentMethod, customerId, cashReceived, balanceAmount, amountPaid } = req.body;

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ message: "බිල හිස්ව පවතී!" });
  }

  // 🔐 TRANSACTIONS: සම්පූර්ණ checkout එකම (stock අඩු කිරීම + customer credit + Sale record
  // හැදීම) එක atomic unit එකක් විදිහට run කරයි - මැදදී step එකක් fail උනොත් (stock insufficient,
  // server crash, DB error) කිසිම අර්ධ වෙනසක් DB එකේ save වෙන්නේ නෑ, සියල්ලම rollback වෙනවා.
  // (⚠️ මේකට MongoDB Replica Set එකක් ඕන - MongoDB Atlas default එකෙන්ම replica set, ඒ නිසා
  // production එකේ problem එකක් නෑ. සම්පූර්ණයෙන්ම local standalone mongod එකක නම් transactions
  // වැඩ කරන්නේ නෑ.)
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      // === PASS 1: කිසිම stock එකක් අඩු කරන්න කලින්, හැම item එකක්ම DB එකට සාපේක්ෂව validate කරයි ===
      const resolvedItems = [];

      for (const item of cartItems) {
        const qty = parseFloat(item.qty);
        if (!qty || qty <= 0) {
          throw new RouteError(400, `"${item.name}" සඳහා නිවැරදි ප්‍රමාණයක් නැත!`);
        }

        // Manual typed (ad-hoc) items - DB record එකක් නැති නිසා මේවට සම්පූර්ණ validation කරන්න බෑ
        if (!item._id || item._id.toString().startsWith("temp_")) {
          resolvedItems.push({ item, qty, product: null, batch: null, canonical: null });
          continue;
        }

        const product = await Product.findById(item._id).session(session);
        if (!product) {
          throw new RouteError(404, `"${item.name}" භාණ්ඩය සොයාගත නොහැක - List එක Refresh කරලා නැවත උත්සාහ කරන්න!`);
        }

        let batch = null;
        if (item.batchId && Array.isArray(product.batches) && product.batches.length > 0) {
          batch = product.batches.find((b) => b.batchId === item.batchId) || null;
        }

        const canonicalPrice = batch ? batch.price : product.price;
        const canonicalDiscountPercent = (batch ? batch.discount : product.discount) || 0;
        const canonicalDiscountAmount = Math.round(((canonicalPrice * canonicalDiscountPercent) / 100) * 100) / 100;
        const canonicalStock = batch ? parseFloat(batch.stock) || 0 : parseFloat(product.stock) || 0;

        const canonical = {
          price: canonicalPrice,
          discountAmount: canonicalDiscountAmount,
          costPrice: (batch ? batch.costPrice : product.costPrice) || 0,
          marketPrice: (batch ? batch.marketPrice : product.marketPrice) || 0,
          stock: canonicalStock,
        };

        const submittedPrice = parseFloat(item.price);
        const submittedDiscount = parseFloat(item.discount || 0);

        if (Math.abs(submittedPrice - canonical.price) > PRICE_TOLERANCE) {
          throw new RouteError(409, `"${item.name}" හි මිල වෙනස් වී ඇත! List එක Refresh කරලා නැවත උත්සාහ කරන්න.`);
        }
        if (Math.abs(submittedDiscount - canonical.discountAmount) > PRICE_TOLERANCE) {
          throw new RouteError(409, `"${item.name}" හි වට්ටම වෙනස් වී ඇත! List එක Refresh කරලා නැවත උත්සාහ කරන්න.`);
        }
        if (qty > canonical.stock + 0.001) {
          throw new RouteError(400, `"${item.name}" සඳහා ප්‍රමාණවත් තොගයක් නැත! (ඇත්තේ: ${canonical.stock})`);
        }

        resolvedItems.push({ item, qty, product, batch, canonical });
      }

      // 🔐 Bill-level (Occasion) Promotion එකේ % එකත් client එක විශ්වාස කරන්නේ නෑ - DB එකේ
      // මේ වෙලාවේ ඇත්තටම active promotion එකක් තියෙනවද බලලා, එකේම % එකම පාවිච්චි කරයි.
      let billDiscountPercent = 0;
      let billDiscountName = null;
      const activePromo = await Promotion.findOne({ type: "occasion", isActive: true }).session(session);
      if (activePromo) {
        billDiscountPercent = activePromo.discountPercent || 0;
        billDiscountName = activePromo.name;
      }

      // === PASS 2: validate උනා - දැන් ATOMIC, race-safe decrements වලින් stock එක අඩු කරලා Sale එක හදයි ===
      // 🔐 RACE CONDITION FIX: කලින් "read product -> subtract in JS -> save" pattern එක පාවිච්චි
      // කලේ - දෙන්නෙක් එකම අන්තිම item එක එකවර checkout කලොත්, දෙන්නටම stock ප්‍රමාණවත් බව පෙනිලා
      // දෙන්නම sell කරගන්න පුළුවන් උනා (actual stock එකට වඩා විකුණලා negative යනවා). දැන් DB එකටම
      // "stock ප්‍රමාණවත් නම් විතරක් අඩු කරන්න" කියලා එකම atomic query එකකින් කියනවා - දෙවෙනි
      // request එකට ඒ moment එකේදීම ප්‍රමාණවත් stock නැති බව DB එකෙන්ම පේනවා, round-trip race නැහැ.
      let totalAmount = 0;
      let totalProfit = 0;
      let totalCustomerSavings = 0;
      const saleItems = [];

      for (const { item, qty, product, batch, canonical } of resolvedItems) {
        if (!product) {
          // Manual typed item - කලින් හැටියටම client එකේ price එකම පාවිච්චි කරයි
          const tempOriginalP = parseFloat(item.price);
          totalAmount += tempOriginalP * qty;
          totalProfit += (tempOriginalP * 0.15) * qty;
          saleItems.push({
            productId: null,
            batchId: item.batchId || "Temp",
            name: item.name,
            marketPrice: item.marketPrice || item.price,
            price: tempOriginalP,
            costPrice: item.costPrice || (tempOriginalP * 0.85),
            qty,
            discount: 0
          });
          continue;
        }

        const filter = { _id: product._id };
        const inc = { stock: -qty };
        if (batch) {
          filter["batches.batchId"] = batch.batchId;
          filter["batches.stock"] = { $gte: qty };
          inc["batches.$.stock"] = -qty;
        } else {
          filter.stock = { $gte: qty };
        }

        const updatedProduct = await Product.findOneAndUpdate(filter, { $inc: inc }, { session, new: true });
        if (!updatedProduct) {
          // මීට අතර (PASS 1 validate උනාට පස්සේ) stock එක වෙනත් checkout එකකින් අඩු වෙලා ඇති -
          // whole transaction එකම abort කරලා, cashier ට list එක refresh කරන්න කියයි.
          throw new RouteError(409, `"${item.name}" හි තොගය දැන් වෙනස් වී ඇත (වෙනත් විකිණීමක් එකවර සිදු විය)! List එක Refresh කරලා නැවත උත්සාහ කරන්න.`);
        }

        const finalPriceAfterDiscount = canonical.price - canonical.discountAmount;
        const itemTotal = finalPriceAfterDiscount * qty;
        const itemCost = canonical.costPrice * qty;
        const itemProfit = itemTotal - itemCost;
        const itemSavings = ((canonical.marketPrice || canonical.price) - finalPriceAfterDiscount) * qty;

        totalAmount += itemTotal;
        totalProfit += itemProfit;
        totalCustomerSavings += itemSavings;

        saleItems.push({
          productId: product._id,
          batchId: batch ? batch.batchId : "Default",
          name: item.name,
          marketPrice: canonical.marketPrice || finalPriceAfterDiscount,
          price: finalPriceAfterDiscount,
          costPrice: canonical.costPrice,
          qty,
          discount: canonical.discountAmount
        });
      }

      // 🐛 BUG FIX: කලින් මේ Bill-level Occasion Discount එක (billDiscountPercent) backend එකේ
      // කිසි තැනකදී totalAmount එකෙන් අඩු වුනේම නෑ - Receipt එකේ විතරක් පෙන්නුවා, ඇත්තටම
      // ගණන් හදලා තිබුනේ Full Price එකටම! දැන් server-verified % එකෙන් actual total එකෙන් අඩු කරයි.
      const billDiscountAmount = Math.round(((totalAmount * billDiscountPercent) / 100) * 100) / 100;
      totalAmount = Math.max(0, totalAmount - billDiscountAmount);
      totalCustomerSavings += billDiscountAmount;

      const paid = parseFloat(amountPaid);
      const safePaid = isNaN(paid) ? totalAmount : paid;

      // 🔐 පාරිභෝගිකයෙක් සම්බන්ධ කර නැතුව ණයට විකුණන්න බෑ - කලින් මේක frontend එකේ විතරක් check කලේ
      if (safePaid < totalAmount - PRICE_TOLERANCE && !customerId) {
        throw new RouteError(400, "හිඟ මුදලක් පවතී! කරුණාකර පාරිභෝගිකයෙකු සම්බන්ධ කරන්න. 👤");
      }

      let creditToRecord = 0;
      if (customerId && safePaid < totalAmount - PRICE_TOLERANCE) {
        creditToRecord = Math.round((totalAmount - safePaid) * 100) / 100;
        const customer = await Customer.findById(customerId).session(session);
        if (customer) {
          customer.creditBalance += creditToRecord;
          if (!customer.creditHistory) customer.creditHistory = [];
          customer.creditHistory.push({
            amount: creditToRecord,
            date: new Date(),
            description: `ණයට ගැනීම (Bill Total: රු.${totalAmount.toFixed(2)}, Paid: රු.${safePaid.toFixed(2)})`
          });
          await customer.save({ session });
        }
      }

      const invoiceNo = await generateInvoiceNo(session);

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
        amountPaid: safePaid,
        amountDue: creditToRecord
      });
      await newSale.save({ session });

      responsePayload = {
        message: billDiscountName ? `බිල සාර්ථකව නිම කලා! 🎉 "${billDiscountName}" (${billDiscountPercent}%) අයින් කලා` : "බිල සාර්ථකව නිම කලා! ✅",
        amountDue: creditToRecord,
        saleId: newSale._id,
        invoiceNo
      };
    });

    res.status(200).json(responsePayload);
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Checkout error:", error); // server log එකේ full details - client ට generic message එකක් විතරයි
    res.status(500).json({ message: "Checkout දෝෂයක්! නැවත උත්සාහ කරන්න." });
  } finally {
    await session.endSession();
  }
});

// 6. DASHBOARD SUMMARY
router.get('/sales-summary', requireAdmin, async (req, res) => {
  try {
    const sales = await Sale.find().sort({ createdAt: -1 });
    let totalRevenue = 0;
    let totalProfit = 0;
    let cashSales = 0;
    let cardSales = 0;
    let qrSales = 0;
    let creditSales = 0;

    // 🆕 DASHBOARD: පසුගිය දින 14ක Daily Sales Graph එකට - දවස් 14ම 0 කරලාම pre-seed කරයි,
    // ඒ දවසට Sale එකක්වත් නැතත් Graph එකේ "gap" එකක් නැතුව, 0 height bar එකක් විදිහටම පෙන්වයි.
    const DAYS_BACK = 14;
    const dayKey = (d) => {
      const dt = new Date(d);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    };
    const dailyMap = new Map();
    const todayForChart = new Date();
    for (let i = DAYS_BACK - 1; i >= 0; i--) {
      const d = new Date(todayForChart);
      d.setDate(d.getDate() - i);
      dailyMap.set(dayKey(d), { date: dayKey(d), revenue: 0, profit: 0, billCount: 0 });
    }

    // 🆕 DASHBOARD: Cashier කෙනෙක් කෙනෙක් වෙනම Performance (bills, revenue, profit, avg bill,
    // void/return count) - Accountability සහ fraud-pattern (නිතර void කරන කෙනෙක්) identify කරගන්න.
    const cashierMap = new Map();
    const getCashierStat = (name) => {
      const key = name || "Unknown";
      if (!cashierMap.has(key)) {
        cashierMap.set(key, { cashier: key, billCount: 0, totalRevenue: 0, totalProfit: 0, voidCount: 0, returnCount: 0 });
      }
      return cashierMap.get(key);
    };

    sales.forEach(sale => {
      const cashierStat = getCashierStat(sale.cashier);

      // 🛠️ FIX: a Voided sale never actually happened financially — it must NOT
      // count toward revenue/profit/breakdown, even though it still appears in the
      // "sales" list below (the frontend log needs it there for the audit trail).
      if (sale.status === 'Voided') {
        cashierStat.voidCount += 1; // 🆕 track per-cashier, even though it's excluded from revenue below
        return;
      }

      // 🛠️ FIX: for a Returned/PartiallyReturned sale, sale.totalAmount/totalProfit
      // are the ORIGINAL figures from before the refund — using them as-is silently
      // counts money that was actually given back to the customer. Recompute the NET
      // (what the customer actually kept, after returns) from the line items instead,
      // using each item's own returnedQty — which we already track precisely.
      let netRevenue = sale.totalAmount;
      let netProfit = sale.totalProfit;

      if (sale.status === 'Returned' || sale.status === 'PartiallyReturned') {
        cashierStat.returnCount += 1; // 🆕
        netRevenue = 0;
        netProfit = 0;
        for (const item of sale.items) {
          const keptQty = Math.max(0, item.qty - (item.returnedQty || 0));
          netRevenue += item.price * keptQty;
          netProfit += (item.price - item.costPrice) * keptQty;
        }
      }

      totalRevenue += netRevenue;
      totalProfit += netProfit;

      cashierStat.billCount += 1;
      cashierStat.totalRevenue += netRevenue;
      cashierStat.totalProfit += netProfit;

      if (sale.paymentMethod === 'Cash') cashSales += netRevenue;
      else if (sale.paymentMethod === 'Card') cardSales += netRevenue;
      else if (sale.paymentMethod === 'QR') qrSales += netRevenue;
      else if (sale.paymentMethod === 'Credit') creditSales += netRevenue;

      // 🆕 Daily bucket (පසුගිය දින 14ට ඇතුලත් නම් විතරයි - පරණ Sale එකක් උනත් totals වලින් අයින් වෙන්නේ නෑ)
      const key = dayKey(sale.createdAt);
      if (dailyMap.has(key)) {
        const bucket = dailyMap.get(key);
        bucket.revenue += netRevenue;
        bucket.profit += netProfit;
        bucket.billCount += 1;
      }
    });

    // 🆕 Revenue අනුව වැඩිම විකුණපු cashier මුලින්ම පේන්න sort කරයි
    const cashierPerformance = Array.from(cashierMap.values())
      .map(c => ({ ...c, avgBillValue: c.billCount > 0 ? Math.round((c.totalRevenue / c.billCount) * 100) / 100 : 0 }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    res.status(200).json({
      totalSalesCount: sales.filter(s => s.status !== 'Voided').length, // 🛠️ FIX: a voided bill isn't a completed sale
      totalRevenue,
      totalProfit,
      breakdown: { cashSales, cardSales, qrSales, creditSales },
      dailySales: Array.from(dailyMap.values()), // 🆕 Dashboard graph එකට, දින 14 chronological order එකේ
      cashierPerformance, // 🆕 Dashboard cashier performance table එකට
      sales // 🆕 unfiltered list still goes to the frontend — the log view needs Voided/Returned rows for its audit trail
    });
  } catch (error) {
    console.error("වාර්තා ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "වාර්තා ලබාගැනීම අසාර්ථකයි" });
  }
});

// 6.5 🆕 SALES HISTORY - CLEAR ALL (Real-world Pro: Type-to-confirm guard on frontend, hard delete on backend)
// ⚠️ මේකෙන් Sale records ටික permanently delete වේ - Product Stock/Customer Credit වලට effect කරන්නේ නැත
// (Stock/Credit දැනටමත් සිදුවූ Transaction එකක ප්‍රතිඵලයක් - History log එක Clear කිරීම ඒවා Undo කරන්නේ නැත)
router.delete('/sales/clear-all', requireAdmin, async (req, res) => {
  try {
    const result = await Sale.deleteMany({});
    res.status(200).json({ message: `විකුණුම් ඉතිහාසය සම්පූර්ණයෙන් Clear කලා! 🧹 (${result.deletedCount} Records)`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("Clear කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Clear කිරීම අසාර්ථකයි" });
  }
});

// 7. VOID SALE
router.post('/void-sale/:id', requireAdmin, async (req, res) => {
  // 🔐 TRANSACTIONS: Stock restore කරන එකත්, Sale status "Voided" කරන එකත්, Customer credit
  // adjust කරන එකත් - තුනම එකටම succeed වෙන්න ඕන. මැදදී crash එකක් උනොත් "stock restore වුනා
  // ඒත් sale තාම Completed" වගේ inconsistent state එකක් හැදෙන්න බෑ.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findById(req.params.id).session(session);
      if (!sale) throw new RouteError(404, "බිල්පත සොයාගත නොහැක");
      if (sale.status === 'Voided') throw new RouteError(400, "මෙම බිල්පත දැනටමත් අවලංගු කර ඇත!");

      for (const item of sale.items) {
        const notReturnedQty = item.qty - (item.returnedQty || 0);
        if (notReturnedQty <= 0) continue;

        if (item.productId) {
          const inc = { stock: notReturnedQty };
          const filter = { _id: item.productId };
          if (item.batchId) {
            filter["batches.batchId"] = item.batchId;
            inc["batches.$.stock"] = notReturnedQty;
          }
          // batchId match නොවුනත් (e.g. batch පස්සේ delete වුනා) අවම වශයෙන් top-level stock එක restore කරයි
          const updated = await Product.findOneAndUpdate(filter, { $inc: inc }, { session, new: true });
          if (!updated && item.batchId) {
            await Product.findByIdAndUpdate(item.productId, { $inc: { stock: notReturnedQty } }, { session });
          }
        }
      }

      if (sale.paymentMethod === 'Credit' && sale.customerId) {
        const remainingCredit = (sale.amountDue || 0);
        if (remainingCredit > 0) {
          await Customer.findByIdAndUpdate(sale.customerId, { $inc: { creditBalance: -remainingCredit } }, { session });
        }
      }

      sale.status = 'Voided';
      await sale.save({ session });
    });

    res.status(200).json({ message: "බිල්පත සාර්ථකව අවලංගු කලා සහ තොග නැවත එකතු කලා! 🔄" });
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Void sale error:", error);
    res.status(500).json({ message: "අවලංගු කිරීම අසාර්ථකයි" });
  } finally {
    await session.endSession();
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
  const { saleId, cashierName, refundMethod, items } = req.body;
  if (!saleId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "අවම වශයෙන් Return කරන භාණ්ඩයක් තෝරන්න!" });
  }

  // 🔐 TRANSACTIONS: Sale update + Stock restore + Customer credit + Return record - සියල්ලම
  // එකම atomic unit එකක්. අතරමැද error එකක් උනොත් "refund logged ඒත් stock restore වුනේ නෑ"
  // වගේ account/stock mismatch එකක් හැදෙන්න බෑ.
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findById(saleId).session(session);
      if (!sale) throw new RouteError(404, "බිල සොයාගත නොහැක!");
      if (sale.status === 'Voided') throw new RouteError(400, "අවලංගු කරන ලද බිලකට Return කළ නොහැක!");

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
          throw new RouteError(400, `"${saleItem.name}" සඳහා Return කළ හැක්කේ ${availableToReturn} පමණි!`);
        }

        const refundAmount = saleItem.price * returnQty;
        totalRefundAmount += refundAmount;

        // Stock සහ Batch Stock නැවත එකතු කිරීම (atomic $inc - race-safe)
        if (saleItem.productId) {
          const filter = { _id: saleItem.productId };
          const inc = { stock: returnQty };
          if (saleItem.batchId) {
            filter["batches.batchId"] = saleItem.batchId;
            inc["batches.$.stock"] = returnQty;
          }
          const updated = await Product.findOneAndUpdate(filter, { $inc: inc }, { session, new: true });
          if (!updated && saleItem.batchId) {
            await Product.findByIdAndUpdate(saleItem.productId, { $inc: { stock: returnQty } }, { session });
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

      if (totalRefundAmount <= 0) throw new RouteError(400, "වලංගු Return ප්‍රමාණයක් හමු නොවුනි!");

      if ((refundMethod === 'StoreCredit' || refundMethod === 'CreditAdjust') && sale.customerId) {
        const customer = await Customer.findById(sale.customerId).session(session);
        if (customer) {
          customer.creditBalance -= totalRefundAmount;
          customer.creditHistory.push({
            amount: -totalRefundAmount,
            date: new Date(),
            description: `Return/Refund (Bill #${sale.invoiceNo || sale._id.toString().slice(-6)})`
          });
          await customer.save({ session });
        }
      }

      if (sale.paymentMethod === 'Credit') {
        sale.amountDue = Math.max(0, (sale.amountDue || 0) - totalRefundAmount);
      }

      sale.returnedAmount = (sale.returnedAmount || 0) + totalRefundAmount;
      const allFullyReturned = sale.items.every(it => (it.returnedQty || 0) >= it.qty);
      sale.status = allFullyReturned ? 'Returned' : 'PartiallyReturned';
      await sale.save({ session });

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
      await returnRecord.save({ session });

      responsePayload = {
        message: `Return එක සාර්ථකයි! ✅ Refund: රු.${totalRefundAmount.toFixed(2)}`,
        totalRefundAmount,
        saleStatus: sale.status
      };
    });

    res.status(200).json(responsePayload);
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Return error:", error);
    res.status(500).json({ message: "Return ක්‍රියාවලිය අසාර්ථකයි!" });
  } finally {
    await session.endSession();
  }
});

// 10. EXCHANGE
router.post('/exchange', async (req, res) => {
  const { saleId, cashierName, refundMethod, returnItems, newItems, extraPaymentMethod, extraCashReceived } = req.body;

  // 🔐 TRANSACTIONS: Old sale update + stock restore (returned items) + stock decrement (new
  // items) + new Sale creation - සියල්ලම එකම atomic unit එකක්.
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findById(saleId).session(session);
      if (!sale) throw new RouteError(404, "පැරණි බිල සොයාගත නොහැක!");

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
          const filter = { _id: saleItem.productId };
          const inc = { stock: returnQty };
          if (saleItem.batchId) {
            filter["batches.batchId"] = saleItem.batchId;
            inc["batches.$.stock"] = returnQty;
          }
          const updated = await Product.findOneAndUpdate(filter, { $inc: inc }, { session, new: true });
          if (!updated && saleItem.batchId) {
            await Product.findByIdAndUpdate(saleItem.productId, { $inc: { stock: returnQty } }, { session });
          }
        }

        saleItem.returnedQty = alreadyReturned + returnQty;
        returnedItemsLog.push({ name: saleItem.name, qty: returnQty, refundAmount, reason: reqItem.reason || "Exchange" });
      }

      // 🔐 PASS 1 (new items): කලින් checkout එකේ කලානම් ම, exchange එකේ අරගන්න අලුත් items
      // වලත් price එකත් stock එකත් DB එකට සාපේක්ෂව validate කරයි - client එකේ price එක විශ්වාස කරන්නේ නෑ.
      const resolvedNewItems = [];
      for (const item of newItems) {
        const qty = parseFloat(item.qty);
        if (!qty || qty <= 0) throw new RouteError(400, `"${item.name}" සඳහා නිවැරදි ප්‍රමාණයක් නැත!`);

        if (!item._id) {
          resolvedNewItems.push({ item, qty, product: null, batch: null, canonical: null });
          continue;
        }

        const product = await Product.findById(item._id).session(session);
        if (!product) throw new RouteError(404, `"${item.name}" භාණ්ඩය සොයාගත නොහැක!`);

        let batch = null;
        if (item.batchId && Array.isArray(product.batches) && product.batches.length > 0) {
          batch = product.batches.find((b) => b.batchId === item.batchId) || null;
        }

        const canonicalPrice = batch ? batch.price : product.price;
        const canonical = {
          price: canonicalPrice,
          costPrice: (batch ? batch.costPrice : product.costPrice) || 0,
          marketPrice: (batch ? batch.marketPrice : product.marketPrice) || 0,
          stock: batch ? parseFloat(batch.stock) || 0 : parseFloat(product.stock) || 0,
        };

        if (Math.abs(parseFloat(item.price) - canonical.price) > PRICE_TOLERANCE) {
          throw new RouteError(409, `"${item.name}" හි මිල වෙනස් වී ඇත! නැවත උත්සාහ කරන්න.`);
        }
        if (qty > canonical.stock + 0.001) {
          throw new RouteError(400, `"${item.name}" සඳහා ප්‍රමාණවත් තොගයක් නැත! (ඇත්තේ: ${canonical.stock})`);
        }

        resolvedNewItems.push({ item, qty, product, batch, canonical });
      }

      let newItemsTotal = 0;
      let newItemsProfit = 0;
      const newSaleItems = [];

      for (const { item, qty, product, batch, canonical } of resolvedNewItems) {
        if (!product) {
          const itemTotal = parseFloat(item.price) * qty;
          newItemsTotal += itemTotal;
          newItemsProfit += itemTotal - (parseFloat(item.costPrice || 0) * qty);
          newSaleItems.push({
            productId: null, batchId: item.batchId || "Temp", name: item.name,
            marketPrice: item.marketPrice || item.price, price: item.price,
            costPrice: item.costPrice || 0, qty, discount: 0
          });
          continue;
        }

        const filter = { _id: product._id };
        const inc = { stock: -qty };
        if (batch) {
          filter["batches.batchId"] = batch.batchId;
          filter["batches.stock"] = { $gte: qty };
          inc["batches.$.stock"] = -qty;
        } else {
          filter.stock = { $gte: qty };
        }
        const updatedProduct = await Product.findOneAndUpdate(filter, { $inc: inc }, { session, new: true });
        if (!updatedProduct) {
          throw new RouteError(409, `"${item.name}" හි තොගය දැන් වෙනස් වී ඇත! නැවත උත්සාහ කරන්න.`);
        }

        const itemTotal = canonical.price * qty;
        newItemsTotal += itemTotal;
        newItemsProfit += itemTotal - (canonical.costPrice * qty);

        newSaleItems.push({
          productId: product._id,
          batchId: batch ? batch.batchId : "Default",
          name: item.name,
          marketPrice: canonical.marketPrice || canonical.price,
          price: canonical.price,
          costPrice: canonical.costPrice,
          qty,
          discount: 0
        });
      }

      const exchangeDifference = newItemsTotal - totalRefundAmount;

      const newSale = new Sale({
        cashier: cashierName || "Unknown",
        invoiceNo: await generateInvoiceNo(session),
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
      await newSale.save({ session });

      // 🆕 BONUS FIX: Sale schema එකේම තිබ්බ `linkedExchangeSaleId` field එක කලින් කවදාවත්
      // set කලේ නෑ - පරණ බිල එකෙන් අලුත් Exchange බිලට navigate වෙන්න බෑ තිබුණේ. දැන් link කරයි.
      sale.linkedExchangeSaleId = newSale._id;
      await sale.save({ session });

      responsePayload = {
        message: "Exchange එක සාර්ථකයි! ✅",
        exchangeDifference,
        newSaleId: newSale._id,
        totalRefundAmount,
        newItemsTotal
      };
    });

    res.status(200).json(responsePayload);
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Exchange error:", error);
    res.status(500).json({ message: "Exchange අසාර්ථකයි!" });
  } finally {
    await session.endSession();
  }
});

// 11. RETURN HISTORY
router.get('/returns', requireAdmin, async (req, res) => {
  try {
    const returns = await Return.find().sort({ createdAt: -1 }).populate('customerId');
    res.status(200).json(returns);
  } catch (error) {
    console.error("Return ඉතිහාසය ලබාගැනීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Return ඉතිහාසය ලබාගැනීම අසාර්ථකයි" });
  }
});

// 12. 🆕 RETURN/EXCHANGE HISTORY - CLEAR ALL
// ⚠️ මේකෙන් Return log entries ටික permanently delete වේ - Sale document එකේ තියෙන returnedQty/status වලට effect කරන්නේ නැත
router.delete('/returns/clear-all', requireAdmin, async (req, res) => {
  try {
    const result = await Return.deleteMany({});
    res.status(200).json({ message: `Return/Exchange ඉතිහාසය සම්පූර්ණයෙන් Clear කලා! 🧹 (${result.deletedCount} Records)`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("Clear කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "Clear කිරීම අසාර්ථකයි" });
  }
});

module.exports = router;