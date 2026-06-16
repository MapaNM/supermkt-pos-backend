const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');

// 1. අලුත් පාරිභෝගිකයෙක් ඇතුලත් කිරීම
router.post('/add', async (req, res) => {
    try {
        const { name, phone } = req.body;
        const existing = await Customer.findOne({ phone });
        if (existing) return res.status(400).json({ message: "මෙම දුරකථන අංකය දැනටමත් පද්ධතියේ ඇත! ❌" });

        const newCustomer = new Customer({ name, phone });
        await newCustomer.save();
        res.status(201).json({ message: "පාරිභෝගිකයා සාර්ථකව ඇතුලත් කලා! 👤", customer: newCustomer });
    } catch (error) {
        res.status(500).json({ message: "ඇතුලත් කිරීම අසාර්ථකයි", error });
    }
});

// 🛠️ UPDATED: පාරිභෝගික විස්තර යාවත්කාලීන කිරීමේ Route එක
router.put("/update/:id", async (req, res) => {
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
    res.status(500).json({ message: "යාවත්කාලීන කිරීම අසාර්ථකයි", error: error.message });
  }
});

// 2. සියලුම පාරිභෝගිකයන් ලබාගැනීම
router.get('/', async (req, res) => {
    try {
        const customers = await Customer.find().sort({ name: 1 });
        res.status(200).json(customers);
    } catch (error) {
        res.status(500).json({ message: "දත්ත ලබාගැනීම අසාර්ථකයි", error });
    }
});

// 3. පාරිභෝගිකයෙකු දුරකථන අංකයෙන් සෙවීම
// 🔍 🛠️ UPDATED: SEARCH CUSTOMER BY NAME OR PHONE
router.get("/search/:query", async (req, res) => {
  try {
    const { query } = req.params;

    const customer = await Customer.findOne({
      $or: [
        { name: { $regex: new RegExp("^" + query + "$", "i") } }, // නම ගැලපේ දැයි බලයි
        { phone: { $regex: new RegExp("^" + query + "$", "i") } } // දුරකථන අංකය ගැලපේ දැයි බලයි
      ]
    });

    if (!customer) {
      return res.status(404).json({ message: "පාරිභෝගිකයෙකු සොයාගත නොහැක!" });
    }
    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: "සෙවීම අසාර්ථකයි", error: error.message });
  }
});

// 🛠️ UPDATED: පාරිභෝගිකයෙකු මකා දැමීමේ Route එක
router.delete("/delete/:id", async (req, res) => {
  try {
    const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);

    if (!deletedCustomer) {
      return res.status(404).json({ message: "පාරිභෝගිකයා සොයාගත නොහැක" });
    }

    res.json({ message: "මකා දැමීම සාර්ථකයි! 🗑️" });
  } catch (error) {
    res.status(500).json({ message: "මකා දැමීම අසාර්ථකයි", error: error.message });
  }
});

// 4. ණය මුදල් පියවීම (Pay/Settle Credit)
router.post('/pay-credit/:id', async (req, res) => {
    try {
        const { amount } = req.body; // පියවන මුදල
        const customer = await Customer.findById(req.params.id);
        if (!customer) return res.status(404).json({ message: "පාරිභෝගිකයා සොයාගත නොහැක" });

        customer.creditBalance -= Number(amount);
        if (customer.creditBalance < 0) customer.creditBalance = 0;
        await customer.save();

        res.status(200).json({ message: "ණය මුදල සාර්ථකව යාවත්කාලීන කලා! ✅", customer });
    } catch (error) {
        res.status(500).json({ message: "පියවීම අසාර්ථකයි", error });
    }
});

module.exports = router;