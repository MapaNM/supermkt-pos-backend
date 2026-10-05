const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
require('./config/backup'); // Backup සකසන කොඩ් එක Import කරගන්න
const { protect, requireAdmin } = require('./middleware/auth'); // 🔐 Auth middleware

if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET .env එකේ නැත! Server එක නවත්වනවා - මේක නැතුව auth එක වැඩ කරන්නෙ නෑ.");
  process.exit(1);
}

const app = express();

// 🛠️ Frontend එක වෙනත් සර්වර් එකක (Vercel) ඇති නිසා මෙයට අවසර දිය යුතුය
// 🔐 UPDATED: FRONTEND_URL එකේ comma-separated origins කිහිපයක් දාන්න පුළුවන් දැන් - production
// Vercel URL එකත්, local dev (localhost:5173) එකත් දෙකම එකවර allow කරගන්න, "*" කවදාවත් පාවිච්චි කරන්නේ නෑ
// (credentials:true එක්ක "*" පාවිච්චි කරන්න බැහැ). .env එකේ:
//   FRONTEND_URL=https://supermkt-pos-frontend.vercel.app,http://localhost:5173
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
      // origin undefined - server-to-server calls, curl, Postman (browser සෑදෙන requests වලට විතරක් origin header එක එන්නේ)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`CORS blocked: ${origin} not in allowed list [${allowedOrigins.join(", ")}]`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

// Middleware (JSON Data කියවීමට)
app.use(express.json()); 

// MongoDB එකට සම්බන්ධ වීම
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Database එක සාර්ථකව සම්බන්ධ කලා! ✅"))
  .catch((err) => console.log("Database සම්බන්ධතා දෝෂයක්: ❌", err));

// සර්වර් එක වැඩදැයි බැලීමට සරල Route එකක්
app.get('/', (req, res) => {
  res.send("Grocery POS Backend එක වැඩ කරනවා! 🚀");
});

// 🛠️ සියලුම Routes එකම තැනක පිළිවෙලට Import කරගැනීම
const productRoutes = require('./routes/productRoutes');
const userRoutes = require('./routes/userRoutes');
const customerRoutes = require('./routes/customerRoutes'); // (ඉහළ තිබූ පේලිය මෙතැනට නිවැරදිව ඇතුලත් කලා)
const supplierRoutes = require('./routes/supplierRoutes');
const promotionRoutes = require('./routes/promotionRoutes');

// URL එකක් විදිහට පාවිච්චි කරන්න සම්බන්ධ කිරීම
// 🔐 UPDATED: /api/users හැර අනිත් සියල්ලටම ලොග් වී සිටීම අනිවාර්යයි (protect).
//    Admin-only actions (add/update/delete product, void sale, etc.) ඒ ඒ route file එක ඇතුලේම
//    requireAdmin එකෙන් තව සීමා කර ඇත. Suppliers සම්පූර්ණයෙන්ම Admin-only.
app.use('/api/products', protect, productRoutes);
app.use('/api/users', userRoutes); // login is public inside; register requires protect+requireAdmin inside
app.use('/api/customers', protect, customerRoutes);
app.use('/api/suppliers', protect, requireAdmin, supplierRoutes); // whole module: admin only
app.use('/api/promotions', protect, promotionRoutes);

// 🔐 404 - define කරපු route එකකවත් match නොවුනොත්
app.use((req, res) => {
  res.status(404).json({ message: "මේ API path එක සොයාගත නොහැක" });
});

// 🔐 SAFETY NET: Route එකක් ඇතුලේ Claude/code එකක් catch කරන්න අමතක වුනු error එකක්
// (bad JSON body, unexpected exception, etc.) මෙතනින් catch වෙලා, stack trace එක server
// log එකේ විතරක් print කරලා, client ට generic message එකක් විතරක් යවයි.
// (Express 5 es async handler errors automatically forward here)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: "අනපේක්ෂිත දෝෂයක් ඇති විය! නැවත උත්සාහ කරන්න." });
});

// Server එක Start කිරීම (Render.com එකට ගැළපෙන සේ dynamic කර ඇත)
const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`Server එක Port ${PORT} එකේ වැඩ කරගෙන යනවා... 🔥`);
});