const express = require('express');
const mongoose = require('mongoose'); // 🔐 needed for session/transaction support
const router = express.Router();
const Customer = require('../models/Customer');
const RouteError = require('../utils/RouteError');
const { requireAdmin } = require('../middleware/auth'); // 🔐 note: `protect` already applied at /api/customers in server.js

// 1. අලුත් පාරිභෝගිකයෙක් ඇතුලත් කිරීම
router.post('/add', async (req, res) => {
    try {
        const { name, phone, isLoyaltyMember } = req.body;
        const existing = await Customer.findOne({ phone });
        if (existing) return res.status(400).json({ message: "මෙම දුරකථන අංකය දැනටමත් පද්ධතියේ ඇත! ❌" });

        // 🆕 BILL-LEVEL DISCOUNT: Loyalty Card Holder flag එකත් සේව් කරයි
        const newCustomer = new Customer({ name, phone, isLoyaltyMember: isLoyaltyMember || false });
        await newCustomer.save();
        res.status(201).json({ message: "පාරිභෝගිකයා සාර්ථකව ඇතුලත් කලා! 👤", customer: newCustomer });
    } catch (error) {
        console.error("ඇතුලත් කිරීම අසාර්ථකයි", error);
        res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි" });
    }
});

// 🛠️ UPDATED: පාරිභෝගික විස්තර යාවත්කාලීන කිරීමේ Route එක
router.put("/update/:id", requireAdmin, async (req, res) => {
  try {
    const updatedCustomer = await Customer.findByIdAndUpdate(
      req.params.id, // Frontend එකෙන් එන ID එක මෙතනින් ලබාගනී
      req.body,
      { returnDocument: 'after', runValidators: true }
    );

    if (!updatedCustomer) {
      return res.status(404).json({ message: "පාරිභෝගිකයා සොයාගත නොහැක" });
    }

    res.json({ message: "විස්තර යාවත්කාලීන කිරීම සාර්ථකයි! 🔄", customer: updatedCustomer });
  } catch (error) {
    console.error("යාවත්කාලීන කිරීම අසාර්ථකයි", error);
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි" });
  }
});

// 2. සියලුම පාරිභෝගිකයන් ලබාගැනීම
router.get('/', async (req, res) => {
    try {
        const customers = await Customer.find().sort({ name: 1 });
        res.status(200).json(customers);
    } catch (error) {
        console.error("දත්ත ලබාගැනීම අසාර්ථකයි", error);
        res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි" });
    }
});

// 3. පාරිභෝගිකයෙකු දුරකථන අංකයෙන් සෙවීම
// 🔍 🛠️ UPDATED: SEARCH CUSTOMER BY NAME OR PHONE
// customerRoutes.js
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get("/search/:query", async (req, res) => {
  try {
    const { query } = req.params;

    if (!query || query.trim().length === 0) {
      return res.json([]);
    }

    const safeQuery = escapeRegex(query.trim());

    const customers = await Customer.find({
      $or: [
        { name: { $regex: safeQuery, $options: "i" } },
        { phone: { $regex: safeQuery, $options: "i" } }
      ]
    }).limit(10);

    res.json(customers);
  } catch (error) {
    console.error("සෙවීම අසාර්ථකයි", error);
    res.status(500).json({ message: "සෙවීම අසාර්ථකයි" });
  }
});

// 🛠️ UPDATED: පාරිභෝගිකයෙකු මකා දැමීමේ Route එක
router.delete("/delete/:id", requireAdmin, async (req, res) => {
  try {
    const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);

    if (!deletedCustomer) {
      return res.status(404).json({ message: "පාරිභෝගිකයා සොයාගත නොහැක" });
    }

    res.json({ message: "මකා දැමීම සාර්ථකයි! 🗑️" });
  } catch (error) {
    console.error("මකා දැමීම අසාර්ථකයි", error);
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි" });
  }
});

// 4. ණය මුදල් පියවීම (Pay/Settle Credit)
// 🐛 BUG FIX: කලින් customer ණයට ඉතිරිව තියෙන ප්‍රමාණයට වඩා වැඩි මුදලක් (e.g. ණය රු.500ක් තියෙද්දී
// රු.1000ක් cashier වැරදීමකින් ඇතුලත් කලොත්) ගෙවුවොත්, creditBalance 0ට clamp කලත්, ledger එකේ
// "-1000" කියලාම සටහන් වුනා - ඇත්තටම ණයට යෙදුනේ 500ක් විතරයි, ඉතුරු 500 ගැන record එකක්ම තිබුණේ නෑ
// (cashier ඒ මුදල customer ට ආපහු දෙන්න ඕනද, නැත්නම් වැරදීමක්ද කියලා පස්සේ බලන්න විදිහක් තිබුණේ නෑ).
router.post('/pay-credit/:id', async (req, res) => {
    const { amount } = req.body;
    const paidAmount = Number(amount);
    if (!paidAmount || paidAmount <= 0) {
        return res.status(400).json({ message: "නිවැරදි මුදලක් ඇතුලත් කරන්න!" });
    }

    // 🔐 TRANSACTIONS: checkout/return/exchange/record-purchase වගේම, මේකත් session.withTransaction()
    // එකකින් wrap කලා. Single document එකක් update කරනවා වුනත්, "customer කෙනෙක්ගේ ණය counter
    // දෙකකින් (Till 1, Till 2) එකවර settle කරනවා" වගේ race එකක් උනොත් - transaction එකෙන් DB එකටම
    // write conflict එක detect කරලා, එකක් automatic ව retry කරනවා. (read-then-save pattern
    // transaction එකක් නැතුව race එකක් උනොත් "lost update" එකක් වෙන්න පුළුවන් - දෙවෙනි payment එක
    // පළවෙනි එකේ වෙනස්කම් overwrite කරලා.)
    const session = await mongoose.startSession();
    let responsePayload = null;

    try {
        await session.withTransaction(async () => {
            const customer = await Customer.findById(req.params.id).session(session);
            if (!customer) throw new RouteError(404, "පාරිභෝගිකයා සොයාගත නොහැක");

            const currentDue = customer.creditBalance || 0;
            // ණයට ඇත්තටම යෙදෙන්නේ, ගෙවපු මුදලෙන් ණයට ඉතිරිව තියෙන ප්‍රමාණය දක්වා විතරයි
            const appliedAmount = Math.round(Math.min(paidAmount, currentDue) * 100) / 100;
            // ඉතුරු (ණයට වඩා ගෙවපු) මුදල - customer ට ආපසු දෙන්න ඕන "change" එක
            const changeGiven = Math.round((paidAmount - appliedAmount) * 100) / 100;

            customer.creditBalance = Math.max(0, Math.round((currentDue - appliedAmount) * 100) / 100);

            // 🆕 ගෙවීම creditHistory (ledger) එකට සටහන් කරයි - ණයට ඇත්තටම යෙදුන ගණනයි (negative),
            // ගෙවපු සම්පූර්ණ ගණනයි, ඉතුරු (change) ගණනයි වෙන වෙනම track කරයි
            if (!customer.creditHistory) customer.creditHistory = [];
            customer.creditHistory.push({
                amount: -appliedAmount,
                paidAmount,
                changeGiven,
                date: new Date(),
                description: changeGiven > 0
                    ? `ණය මුදල් ගෙවීමක් සිදු කලා (ලැබුණු මුදල: රු.${paidAmount.toFixed(2)}, ණයට යෙදුවේ: රු.${appliedAmount.toFixed(2)}, ආපසු දුන් මුදල: රු.${changeGiven.toFixed(2)})`
                    : "ණය මුදල් ගෙවීමක් සිදු කලා (Payment Received)"
            });

            await customer.save({ session });

            responsePayload = {
                message: changeGiven > 0
                    ? `ණය මුදල සාර්ථකව යාවත්කාලීන කලා! ✅ ආපසු දෙන්න ඕන මුදල: රු.${changeGiven.toFixed(2)}`
                    : "ණය මුදල සාර්ථකව යාවත්කාලීන කලා! ✅",
                customer,
                appliedAmount,
                changeGiven
            };
        });

        res.status(200).json(responsePayload);
    } catch (error) {
        if (error instanceof RouteError) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error("පියවීම අසාර්ථකයි", error);
        res.status(500).json({ message: "පියවීම අසාර්ථකයි" });
    } finally {
        await session.endSession();
    }
});

module.exports = router;