const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    creditBalance: { type: Number, default: 0 },
    // 🛠️ UPDATED LINE: ණය ගත් ඉතිහාසය (මුදල සහ දිනය) වෙන වෙනම තබා ගැනීමට Array එකක් එකතු කලා
    creditHistory: [
      {
        amount: { type: Number, required: true },
        date: { type: Date, default: Date.now },
        description: { type: String, default: "ණයට ගැනීම (Bill Purchase)" }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);