// 🔐 One-time setup script - run this ONCE to create your very first admin account,
// since /api/users/register now requires an existing admin to be logged in (chicken/egg).
//
// Usage (from the backend folder):
//   node scripts/createAdmin.js <username> <password>
// Example:
//   node scripts/createAdmin.js shopowner MyStrongPassword123
//
// After this, log in with that account and use /register (as admin) to create cashier accounts.

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

async function main() {
  const [, , username, password] = process.argv;

  if (!username || !password) {
    console.error("❌ Usage: node scripts/createAdmin.js <username> <password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("❌ Password එක අවම වශයෙන් character 8ක් තිබිය යුතුයි.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ username });
  if (existing) {
    console.error(`❌ "${username}" කියන username එක දැනටමත් තියෙනවා.`);
    process.exit(1);
  }

  const admin = new User({ username, password, role: "admin" }); // pre-save hook hashes this
  await admin.save();

  console.log(`✅ Admin account "${username}" සාර්ථකව හැදුවා! දැන් login කරන්න පුළුවන්.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Script එක fail උනා:", err.message);
  process.exit(1);
});