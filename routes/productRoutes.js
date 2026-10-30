const express = require('express');
const mongoose = require('mongoose'); // 🔐 needed for session/transaction support
const router = express.Router();
const RouteError = require('../utils/RouteError');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Return = require('../models/Return');
const Counter = require('../models/Counter');
const Promotion = require('../models/Promotion'); // 🔐 needed to verify bill-level discounts server-side
const { requireOpenShift } = require('../middleware/requireShift'); // 🔐 Enforce Shift requirement
const { requireAdmin } = require('../middleware/auth'); // 🔐 note: `protect` is already applied to the whole /api/products path in server.js

// 🆕 Net Revenue/Profit per bill (deducting returned quantities and accounting for Bill-level discounts) - used by both Sales Summary and
// Dashboard so they share one calculation: use this helper. Profit = Revenue − (Cost of the items that are not deducted).
// (Previously the Bill-level Occasion discount was not deducted from Profit, so profit on discounted bills appeared higher than it was.)
function saleNetFigures(sale) {
  const items = sale.items || [];
  let gross = 0, keptGross = 0, keptCost = 0;
  for (const it of items) {
    const qty = Number(it.qty) || 0;
    const kept = Math.max(0, qty - (Number(it.returnedQty) || 0));
    const price = Number(it.price) || 0;
    gross += price * qty;
    keptGross += price * kept;
    keptCost += (Number(it.costPrice) || 0) * kept;
  }
  const factor = gross > 0 ? (Number(sale.totalAmount) || 0) / gross : 1; // Bill-level discount ratio
  const isReturned = sale.status === 'Returned' || sale.status === 'PartiallyReturned';
  const revenue = isReturned ? keptGross * factor : (Number(sale.totalAmount) || 0);
  return { revenue, profit: revenue - keptCost, cost: keptCost };
}

// 🛠️ NEW: To correct JavaScript Floating-Point Precision Errors (such as 0.1 + 0.2 = 0.30000000000000004)
// Round with this wherever Stock is Added/Subtracted, to prevent Dirty Values (such as 3.5500000000000007) from being Saved to the DB
const roundQty = (num) => Math.round((parseFloat(num) || 0) * 1000) / 1000;

// 🆕 PROFESSIONAL SEQUENTIAL INVOICE NUMBER GENERATOR
// 🔐 `session` (optional) - when checkout runs inside a transaction, the invoice number's
// counter increment also joins that same transaction - if the transaction rolls back, the counter
// rolls back too; otherwise an "invoice number skip" pattern would occur.
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

// 1. Add an item (with a Default Batch)
router.post("/add", requireAdmin, async (req, res) => {
  try {
    const { name, price, marketPrice, costPrice, stock, discount, barcode, unit, category, minStockLevel, preferredSupplierId, expiryDate, batches } = req.body;

    const parsedPrice = parseFloat(price) || 0;
    const parsedCost = parseFloat(costPrice) || 0;
    const parsedMarket = parseFloat(marketPrice) || parsedPrice;
    const parsedStock = roundQty(stock);

    // If no Batches are sent, creates a default initial batch
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
      unit: unit ?? "Kg", // 🛠️ FIX: so that "" (no Unit, intentional) is not forced to "Kg" - fall back only for undefined/null
      category: category || "Grocery",
      minStockLevel: parseFloat(minStockLevel) || 5,
      preferredSupplierId: preferredSupplierId || null,
      expiryDate: expiryDate || null,
      batches: initialBatches
    });

    await newProduct.save();
    res.status(201).json({ message: "Item added successfully! ✅", product: newProduct });
  } catch (error) {
    console.error("Failed to add item", error);
    res.status(500).json({ message: "Failed to add item" });
  }
});

// 2. Get all items
router.get('/', async (req, res) => {
  try {
    const products = await Product.find();
    res.status(200).json(products);
  } catch (error) {
    console.error("Failed to fetch data", error);
    res.status(500).json({ message: "Failed to fetch data" });
  }
});

// 3. Update an item
// 🔐 SECURITY FIX: Previously the whole req.body was passed to the DB update as-is (Mass-Assignment
// Vulnerability) - if extra fields not sent by the Edit Form were added to the request body
// and sent, they would be updated too. Now only the fields the Edit Product Form actually sends are allow-listed,
// and only those are passed to the DB.
router.put("/update/:id", requireAdmin, async (req, res) => {
  try {
    const {
      name, marketPrice, price, costPrice, stock, discount, barcode,
      unit, category, minStockLevel, preferredSupplierId, expiryDate, batches,
    } = req.body;

    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (marketPrice !== undefined) updateFields.marketPrice = marketPrice;
    if (price !== undefined) updateFields.price = price;
    if (costPrice !== undefined) updateFields.costPrice = costPrice;
    if (stock !== undefined) updateFields.stock = stock;
    if (discount !== undefined) updateFields.discount = discount;
    if (barcode !== undefined) updateFields.barcode = barcode;
    if (unit !== undefined) updateFields.unit = unit;
    if (category !== undefined) updateFields.category = category;
    if (minStockLevel !== undefined) updateFields.minStockLevel = minStockLevel;
    if (preferredSupplierId !== undefined) updateFields.preferredSupplierId = preferredSupplierId;
    if (expiryDate !== undefined) updateFields.expiryDate = expiryDate;
    if (batches !== undefined) updateFields.batches = batches;

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { returnDocument: 'after', runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ message: "Item not found" });
    }

    res.json({ message: "Updated successfully! 🔄", product: updatedProduct });
  } catch (error) {
    console.error("Update failed", error);
    res.status(500).json({ message: "Update failed" });
  }
});

// 4. Delete an item
router.delete('/delete/:id', requireAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Item deleted successfully! 🗑️" });
  } catch (error) {
    console.error("Delete failed", error);
    res.status(500).json({ message: "Delete failed" });
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
    console.error("Failed to fetch Expiry data", error);
    res.status(500).json({ message: "Failed to fetch Expiry data" });
  }
});

// 5. CHECKOUT ROUTE (BATCH-WISE STOCK & MULTI-PRICE SUPPORT)
// 🔐 UPDATED: Checkout no longer trusts the price/discount sent by the client - the server itself validates against the actual Product/Batch price
// stored in the DB and the active Occasion Promotion, and rejects the entire checkout if they do not match.
// The client's price is trusted only for "temp_" (manually typed)
// items - because they have no DB record.
const PRICE_TOLERANCE = 0.01; // floating-point rounding allowance, differences of less than Rs.1 cent only

router.post('/checkout', requireOpenShift(), async (req, res) => {
  const { cartItems, cashierName, paymentMethod, customerId, cashReceived, balanceAmount, amountPaid, billDiscountSource, billDiscountPercent: clientBillDiscountPercent } = req.body;

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ message: "The bill is empty!" });
  }

  // 🔐 TRANSACTIONS: The entire checkout (reducing stock + customer credit + creating the Sale record)
  // runs as one atomic unit - if any step fails midway (stock insufficient,
  // server crash, DB error), no partial changes are saved to the DB and everything is rolled back.
  // (⚠️ This requires a MongoDB Replica Set - MongoDB Atlas is a replica set by default, so
  // it is not a problem in production. On a purely local standalone mongod, transactions
  // will not work.)
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      // === PASS 1: Before reducing any stock, validate every item against the DB ===
      const resolvedItems = [];

      for (const item of cartItems) {
        const qty = parseFloat(item.qty);
        if (!qty || qty <= 0) {
          throw new RouteError(400, `Invalid quantity for "${item.name}"!`);
        }

        // Manual typed (ad-hoc) items - full validation is not possible for these because they have no DB record
        if (!item._id || item._id.toString().startsWith("temp_")) {
          resolvedItems.push({ item, qty, product: null, batch: null, canonical: null });
          continue;
        }

        const product = await Product.findById(item._id).session(session);
        if (!product) {
          throw new RouteError(404, `Item "${item.name}" not found - please refresh the list and try again!`);
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
          throw new RouteError(409, `The price of "${item.name}" has changed! Please refresh the list and try again.`);
        }
        if (Math.abs(submittedDiscount - canonical.discountAmount) > PRICE_TOLERANCE) {
          throw new RouteError(409, `The discount on "${item.name}" has changed! Please refresh the list and try again.`);
        }
        if (qty > canonical.stock + 0.001) {
          throw new RouteError(400, `Insufficient stock for "${item.name}"! (Available: ${canonical.stock})`);
        }

        resolvedItems.push({ item, qty, product, batch, canonical });
      }

      // 🐛 FIX: Previously, if an active Occasion promo existed, the server automatically reduced the % even when the cashier had not clicked "Apply" -
      // so the amount shown on the Receipt/collected as cash (without the discount) and the amount in the Sales Report
      // (with the discount) differed (e.g. 1650 vs 1485 = exactly 10%). Now the discount is applied only if the cashier actually
      // clicks Apply (billDiscountSource === "occasion"). The % from the client is not
      // trusted - the % of the active promo in the DB is used, but if the % shown by the client
      // and the DB do not match (the promo changed midway), the bill is rejected.
      let billDiscountPercent = 0;
      let billDiscountName = null;
      if (billDiscountSource === "occasion") {
        const activePromo = await Promotion.findOne({ type: "occasion", isActive: true }).session(session);
        if (!activePromo) {
          throw new RouteError(409, "The Bill Discount Promotion is no longer Active! Please refresh the Cart and try again.");
        }
        if (Math.abs((parseFloat(clientBillDiscountPercent) || 0) - (activePromo.discountPercent || 0)) > 0.001) {
          throw new RouteError(409, "The Bill Discount % has changed! Please refresh the Cart and try again.");
        }
        billDiscountPercent = activePromo.discountPercent || 0;
        billDiscountName = activePromo.name;
      }

      // === PASS 2: validation passed - now reduce stock with ATOMIC, race-safe decrements and create the Sale ===
      // 🔐 RACE CONDITION FIX: Previously the "read product -> subtract in JS -> save" pattern was used -
      // if two people checked out the very last item at the same time, both saw sufficient stock and
      // both were able to sell it (selling more than the actual stock and going negative). Now we tell the DB itself,
      // in a single atomic query, to "reduce only if stock is sufficient" - the second
      // request sees from the DB itself at that very moment that there is not enough stock, so there is no round-trip race.
      let totalAmount = 0;
      let totalProfit = 0;
      let totalCustomerSavings = 0;
      const saleItems = [];

      for (const { item, qty, product, batch, canonical } of resolvedItems) {
        if (!product) {
          // Manual typed item - as before, the client's price is used
          const tempOriginalP = parseFloat(item.price);
          totalAmount += Math.round(tempOriginalP * qty * 100) / 100;
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
          // In the meantime (after PASS 1 validation) the stock may have been reduced by another checkout -
          // abort the whole transaction and tell the cashier to refresh the list.
          throw new RouteError(409, `The stock of "${item.name}" has just changed (another sale occurred at the same time)! Please refresh the list and try again.`);
        }

        const finalPriceAfterDiscount = canonical.price - canonical.discountAmount;
        const itemTotal = Math.round(finalPriceAfterDiscount * qty * 100) / 100; // 🛠️ line total to 2 decimal places (the client does the same)
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

      // 🐛 BUG FIX: Previously this Bill-level Occasion Discount (billDiscountPercent) was never
      // deducted from totalAmount anywhere in the backend - it was only shown on the Receipt, while the actual
      // calculation was done on the Full Price! Now the server-verified % is deducted from the actual total.
      totalAmount = Math.round(totalAmount * 100) / 100;
      const billDiscountAmount = Math.round(((totalAmount * billDiscountPercent) / 100) * 100) / 100;
      totalAmount = Math.max(0, Math.round((totalAmount - billDiscountAmount) * 100) / 100);
      totalCustomerSavings += billDiscountAmount;
      totalProfit -= billDiscountAmount; // 🛠️ The Bill-level discount must also be deducted from profit (previously it was not)

      const paid = parseFloat(amountPaid);
      const safePaid = isNaN(paid) ? totalAmount : paid;

      // 🔐 Selling on credit without a linked customer is not allowed - previously this was only checked on the frontend
      if (safePaid < totalAmount - PRICE_TOLERANCE && !customerId) {
        throw new RouteError(400, "An outstanding balance remains! Please link a customer. 👤");
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
            description: `Credit purchase (Bill Total: Rs.${totalAmount.toFixed(2)}, Paid: Rs.${safePaid.toFixed(2)})`
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
        message: billDiscountName ? `Bill completed successfully! 🎉 "${billDiscountName}" (${billDiscountPercent}%) deducted` : "Bill completed successfully! ✅",
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
    console.error("Checkout error:", error); // full details in the server log - the client only gets a generic message
    res.status(500).json({ message: "Checkout error! Please try again." });
  } finally {
    await session.endSession();
  }
});

// 6.1 🆕 SMART DASHBOARD (Admin) - ?days=7|14|30 (default 14). Today/yesterday, selected period vs the previous equivalent period,
// daily, by hour, payment methods, Top Products, Cashier Performance, credit/payables (Void bills are excluded from Revenue).
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const days = [7, 14, 30].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 14;
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const ymd = (d) => {
      const x = new Date(d);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const periodStart = new Date(todayStart); periodStart.setDate(periodStart.getDate() - (days - 1));
    const prevStart = new Date(periodStart); prevStart.setDate(prevStart.getDate() - days);
    const now = new Date();

    const sales = await Sale.find({ createdAt: { $gte: prevStart, $lte: now } })
      .select('cashier totalAmount totalProfit paymentMethod status createdAt items.name items.qty items.price items.costPrice items.returnedQty')
      .lean();

    const blank = () => ({ revenue: 0, profit: 0, bills: 0 });
    const periodTotals = blank(), prevTotals = blank(), todayTotals = blank(), yesterdayTotals = blank();
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const dailyMap = {};
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayStart); d.setDate(d.getDate() - i);
      const key = ymd(d);
      dailyMap[key] = { date: key, revenue: 0, profit: 0, billCount: 0 };
      daily.push(dailyMap[key]);
    }
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, revenue: 0, billCount: 0 }));
    const payMap = {};
    const productMap = {};
    const cashierMap = {};
    const getCashier = (n) => (cashierMap[n || 'Unknown'] ||= { cashier: n || 'Unknown', billCount: 0, totalRevenue: 0, voidCount: 0, returnCount: 0 });
    let voids = { count: 0, amount: 0 }, returns = { count: 0, amount: 0 };

    const add = (t, rev, prof) => { t.revenue += rev; t.profit += prof; t.bills += 1; };

    for (const sale of sales) {
      const created = new Date(sale.createdAt);
      const inPeriod = created >= periodStart;

      if (sale.status === 'Voided') {
        if (inPeriod) { voids.count += 1; voids.amount += Number(sale.totalAmount) || 0; getCashier(sale.cashier).voidCount += 1; }
        continue;
      }

      const { revenue, profit } = saleNetFigures(sale);

      if (!inPeriod) { add(prevTotals, revenue, profit); continue; }

      add(periodTotals, revenue, profit);
      if (created >= todayStart) add(todayTotals, revenue, profit);
      else if (created >= yesterdayStart) add(yesterdayTotals, revenue, profit);

      const day = dailyMap[ymd(created)];
      if (day) { day.revenue += revenue; day.profit += profit; day.billCount += 1; }
      hourly[created.getHours()].revenue += revenue;
      hourly[created.getHours()].billCount += 1;

      const pm = (payMap[sale.paymentMethod || 'Cash'] ||= { method: sale.paymentMethod || 'Cash', amount: 0, count: 0 });
      pm.amount += revenue; pm.count += 1;

      const cp = getCashier(sale.cashier);
      cp.billCount += 1; cp.totalRevenue += revenue;
      if (sale.status === 'Returned' || sale.status === 'PartiallyReturned') {
        cp.returnCount += 1; returns.count += 1;
        const returnedValue = (sale.items || []).reduce((t, it) => t + (Number(it.price) || 0) * (Number(it.returnedQty) || 0), 0);
        returns.amount += returnedValue;
      }

      // Top Products (deducting returned quantities, and accounting for the Bill discount ratio)
      const gross = (sale.items || []).reduce((t, it) => t + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
      const factor = gross > 0 ? (Number(sale.totalAmount) || 0) / gross : 1;
      for (const it of sale.items || []) {
        const kept = Math.max(0, (Number(it.qty) || 0) - (Number(it.returnedQty) || 0));
        if (kept <= 0) continue;
        const key = (it.name || '').trim() || 'Unknown';
        const pr = (productMap[key] ||= { name: key, qty: 0, revenue: 0, profit: 0 });
        const rev = (Number(it.price) || 0) * kept * factor;
        pr.qty += kept; pr.revenue += rev; pr.profit += rev - (Number(it.costPrice) || 0) * kept;
      }
    }

    const fin = (t) => ({
      revenue: round2(t.revenue), profit: round2(t.profit), bills: t.bills,
      avgBill: t.bills > 0 ? round2(t.revenue / t.bills) : 0,
      margin: t.revenue > 0 ? round2((t.profit / t.revenue) * 100) : 0,
    });

    const customersWithDebt = await Customer.find({ creditBalance: { $gt: 0 } }).select('name phone creditBalance').sort({ creditBalance: -1 }).lean();
    const suppliersWithDue = await Supplier.find({ balanceDue: { $gt: 0 } }).select('name phone balanceDue').sort({ balanceDue: -1 }).lean();

    res.status(200).json({
      days,
      period: fin(periodTotals),
      previous: fin(prevTotals),
      today: fin(todayTotals),
      yesterday: fin(yesterdayTotals),
      daily: daily.map((d) => ({ ...d, revenue: round2(d.revenue), profit: round2(d.profit) })),
      hourly: hourly.map((h) => ({ ...h, revenue: round2(h.revenue) })),
      paymentMix: Object.values(payMap).map((p) => ({ ...p, amount: round2(p.amount) })).sort((a, b) => b.amount - a.amount),
      topProducts: Object.values(productMap)
        .map((p) => ({ ...p, qty: round2(p.qty), revenue: round2(p.revenue), profit: round2(p.profit) }))
        .sort((a, b) => b.revenue - a.revenue).slice(0, 8),
      cashiers: Object.values(cashierMap)
        .map((c) => ({ ...c, totalRevenue: round2(c.totalRevenue), avgBillValue: c.billCount > 0 ? round2(c.totalRevenue / c.billCount) : 0 }))
        .sort((a, b) => b.totalRevenue - a.totalRevenue),
      voids: { count: voids.count, amount: round2(voids.amount) },
      returns: { count: returns.count, amount: round2(returns.amount) },
      credit: {
        outstanding: round2(customersWithDebt.reduce((t, c) => t + c.creditBalance, 0)),
        customerCount: customersWithDebt.length,
        top: customersWithDebt.slice(0, 5).map((c) => ({ name: c.name, phone: c.phone, balance: round2(c.creditBalance) })),
      },
      payables: {
        total: round2(suppliersWithDue.reduce((t, x) => t + x.balanceDue, 0)),
        supplierCount: suppliersWithDue.length,
        top: suppliersWithDue.slice(0, 5).map((x) => ({ name: x.name, phone: x.phone, balance: round2(x.balanceDue) })),
      },
    });
  } catch (error) {
    console.error('Failed to fetch Dashboard data', error);
    res.status(500).json({ message: 'Failed to fetch Dashboard data' });
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

    // 🆕 DASHBOARD: Daily Revenue/Profit/Bills for the last 14 days (including today, in oldest -> newest order)
    // and Performance by Cashier. Voided bills are not counted in Revenue (counted only in voidCount),
    // Returned/PartiallyReturned bills use the NET value (after deducting the returned quantity).
    const ymd = (d) => {
      const x = new Date(d);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    const dailyMap = {};
    const dailySales = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = ymd(d);
      dailyMap[key] = { date: key, revenue: 0, profit: 0, billCount: 0 };
      dailySales.push(dailyMap[key]);
    }
    const cashierMap = {};
    const getCashier = (name) => {
      const key = name || 'Unknown';
      if (!cashierMap[key]) cashierMap[key] = { cashier: key, billCount: 0, totalRevenue: 0, avgBillValue: 0, voidCount: 0, returnCount: 0 };
      return cashierMap[key];
    };

    sales.forEach(sale => {
      // 🛠️ FIX: a Voided sale never actually happened financially — it must NOT
      // count toward revenue/profit/breakdown, even though it still appears in the
      // "sales" list below (the frontend log needs it there for the audit trail).
      if (sale.status === 'Voided') { getCashier(sale.cashier).voidCount += 1; return; }

      // 🛠️ FIX: for a Returned/PartiallyReturned sale, sale.totalAmount/totalProfit
      // are the ORIGINAL figures from before the refund — using them as-is silently
      // counts money that was actually given back to the customer. Recompute the NET
      // (what the customer actually kept, after returns) from the line items instead,
      // using each item's own returnedQty — which we already track precisely.
      const { revenue: netRevenue, profit: netProfit } = saleNetFigures(sale);

      totalRevenue += netRevenue;
      totalProfit += netProfit;

      const dayStat = dailyMap[ymd(sale.createdAt)];
      if (dayStat) { dayStat.revenue += netRevenue; dayStat.profit += netProfit; dayStat.billCount += 1; }
      const cp = getCashier(sale.cashier);
      cp.billCount += 1;
      cp.totalRevenue += netRevenue;
      if (sale.status === 'Returned' || sale.status === 'PartiallyReturned') cp.returnCount += 1;

      if (sale.paymentMethod === 'Cash') cashSales += netRevenue;
      else if (sale.paymentMethod === 'Card') cardSales += netRevenue;
      else if (sale.paymentMethod === 'QR') qrSales += netRevenue;
      else if (sale.paymentMethod === 'Credit') creditSales += netRevenue;
    });

    const round2 = (n) => Math.round(n * 100) / 100;
    dailySales.forEach(d => { d.revenue = round2(d.revenue); d.profit = round2(d.profit); });
    const cashierPerformance = Object.values(cashierMap)
      .map(c => ({ ...c, totalRevenue: round2(c.totalRevenue), avgBillValue: c.billCount > 0 ? round2(c.totalRevenue / c.billCount) : 0 }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    res.status(200).json({
      dailySales,
      cashierPerformance,
      totalSalesCount: sales.filter(s => s.status !== 'Voided').length, // 🛠️ FIX: a voided bill isn't a completed sale
      totalRevenue,
      totalProfit,
      breakdown: { cashSales, cardSales, qrSales, creditSales },
      sales // 🆕 unfiltered list still goes to the frontend — the log view needs Voided/Returned rows for its audit trail
    });
  } catch (error) {
    console.error("Failed to fetch reports", error);
    res.status(500).json({ message: "Failed to fetch reports" });
  }
});

// 6.5 🆕 SALES HISTORY - CLEAR ALL (Real-world Pro: Type-to-confirm guard on frontend, hard delete on backend)
// ⚠️ This permanently deletes the Sale records - it does not affect Product Stock/Customer Credit
// (Stock/Credit are already the result of a completed Transaction - Clearing the History log does not Undo them)
router.delete('/sales/clear-all', requireAdmin, async (req, res) => {
  try {
    const result = await Sale.deleteMany({});
    res.status(200).json({ message: `Sales history cleared completely! 🧹 (${result.deletedCount} Records)`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("Clear failed", error);
    res.status(500).json({ message: "Clear failed" });
  }
});

// 7. VOID SALE
router.post('/void-sale/:id', requireAdmin, async (req, res) => {
  // 🔐 TRANSACTIONS: Restoring Stock, setting the Sale status to "Voided", and adjusting Customer credit -
  // all three must succeed together. If a crash occurs midway, an inconsistent state such as "stock restored
  // but the sale still Completed" cannot arise.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findById(req.params.id).session(session);
      if (!sale) throw new RouteError(404, "Bill not found");
      if (sale.status === 'Voided') throw new RouteError(400, "This bill has already been voided!");

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
          // Even if batchId does not match (e.g. the batch was deleted later), at least restores the top-level stock
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

    res.status(200).json({ message: "Bill voided successfully and stock restored! 🔄" });
  } catch (error) {
    if (error instanceof RouteError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Void sale error:", error);
    res.status(500).json({ message: "Void failed" });
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
      return res.status(404).json({ message: "This bill number was not found! ❌" });
    }
    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: "An error occurred while searching for data!" });
  }
});

// 9. RETURN / REFUND
router.post('/return', requireOpenShift(), async (req, res) => {
  const { saleId, cashierName, refundMethod, items } = req.body;
  if (!saleId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Please select at least one item to Return!" });
  }

  // 🔐 TRANSACTIONS: Sale update + Stock restore + Customer credit + Return record - all in
  // one atomic unit. If an error occurs midway, an account/stock mismatch such as "refund logged
  // but stock not restored" cannot arise.
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findById(saleId).session(session);
      if (!sale) throw new RouteError(404, "Bill not found!");
      if (sale.status === 'Voided') throw new RouteError(400, "A Return cannot be made on a voided bill!");

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
          throw new RouteError(400, `Only ${availableToReturn} of "${saleItem.name}" can be Returned!`);
        }

        const refundAmount = saleItem.price * returnQty;
        totalRefundAmount += refundAmount;

        // Restore Stock and Batch Stock (atomic $inc - race-safe)
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
          reason: reqItem.reason || "Not specified"
        });
      }

      if (totalRefundAmount <= 0) throw new RouteError(400, "No valid Return quantity found!");

      // 🆕 When refunding a CREDIT bill via Cash/Card, no more Cash/Card can be returned than the portion the
      // customer actually paid (amountPaid) - the Refund for the portion bought on credit must only be made
      // via "Deduct from credit ledger" (CreditAdjust); otherwise money that was never actually received in the drawer would be handed back.
      // The amount already refunded by Cash/Card on this bill is taken from the Return records themselves to work out the remainder.
      if (sale.paymentMethod === 'Credit' && (refundMethod === 'Cash' || refundMethod === 'Card' || !refundMethod)) {
        const priorCashAgg = await Return.aggregate([
          { $match: { saleId: sale._id, refundMethod: { $in: ['Cash', 'Card'] } } },
          { $group: { _id: null, total: { $sum: '$totalRefundAmount' } } },
        ]).session(session);
        const priorCashRefunded = priorCashAgg[0]?.total || 0;
        const maxCashRefund = Math.max(0, Math.round(((sale.amountPaid || 0) - priorCashRefunded) * 100) / 100);
        if (totalRefundAmount > maxCashRefund + 0.004) {
          throw new RouteError(
            400,
            `On this credit bill, a maximum of Rs.${maxCashRefund.toFixed(2)} can be refunded by Cash/Card (the portion paid by the customer). Please refund the remaining amount as "Deduct from credit ledger".`
          );
        }
      }

      // 🛠️ FIX: Previously, when a Credit bill was refunded by Cash, sale.amountDue was reduced but the Customer's
      // creditBalance was not (the credit shown on the bill and the credit ledger did not match). Now amountDue is reduced only
      // when the credit ledger is also actually reduced (CreditAdjust/StoreCredit) - the two always change together.
      let creditAdjusted = false;
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
          creditAdjusted = true;
        }
      }

      if (sale.paymentMethod === 'Credit' && creditAdjusted) {
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
        message: `Return completed successfully! ✅ Refund: Rs.${totalRefundAmount.toFixed(2)}`,
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
    res.status(500).json({ message: "Return process failed!" });
  } finally {
    await session.endSession();
  }
});

// 10. EXCHANGE
router.post('/exchange', requireOpenShift(), async (req, res) => {
  const { saleId, cashierName, refundMethod, returnItems, newItems, extraPaymentMethod, extraCashReceived } = req.body;

  // 🔐 TRANSACTIONS: Old sale update + stock restore (returned items) + stock decrement (new
  // items) + new Sale creation - all in a single atomic unit.
  const session = await mongoose.startSession();
  let responsePayload = null;

  try {
    await session.withTransaction(async () => {
      const sale = await Sale.findById(saleId).session(session);
      if (!sale) throw new RouteError(404, "Original bill not found!");

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

      // 🔐 PASS 1 (new items): As in the earlier checkout, the price and stock of the new items
      // taken in the exchange are validated against the DB - the client's price is not trusted.
      const resolvedNewItems = [];
      for (const item of newItems) {
        const qty = parseFloat(item.qty);
        if (!qty || qty <= 0) throw new RouteError(400, `Invalid quantity for "${item.name}"!`);

        if (!item._id) {
          resolvedNewItems.push({ item, qty, product: null, batch: null, canonical: null });
          continue;
        }

        const product = await Product.findById(item._id).session(session);
        if (!product) throw new RouteError(404, `Item "${item.name}" not found!`);

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
          throw new RouteError(409, `The price of "${item.name}" has changed! Please try again.`);
        }
        if (qty > canonical.stock + 0.001) {
          throw new RouteError(400, `Insufficient stock for "${item.name}"! (Available: ${canonical.stock})`);
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
          throw new RouteError(409, `The stock of "${item.name}" has just changed! Please try again.`);
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

      // 🆕 BONUS FIX: The `linkedExchangeSaleId` field that already existed in the Sale schema was never
      // set before - so it was not possible to navigate from the old bill to the new Exchange bill. Now it is linked.
      sale.linkedExchangeSaleId = newSale._id;
      await sale.save({ session });

      responsePayload = {
        message: "Exchange completed successfully! ✅",
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
    res.status(500).json({ message: "Exchange failed!" });
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
    console.error("Failed to fetch Return history", error);
    res.status(500).json({ message: "Failed to fetch Return history" });
  }
});

// 12. 🆕 RETURN/EXCHANGE HISTORY - CLEAR ALL
// ⚠️ This permanently deletes the Return log entries - it does not affect the returnedQty/status in the Sale document
router.delete('/returns/clear-all', requireAdmin, async (req, res) => {
  try {
    const result = await Return.deleteMany({});
    res.status(200).json({ message: `Return/Exchange history cleared completely! 🧹 (${result.deletedCount} Records)`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("Clear failed", error);
    res.status(500).json({ message: "Clear failed" });
  }
});

module.exports = router;