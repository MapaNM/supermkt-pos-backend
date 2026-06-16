const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
require('./config/backup'); // Backup සකසන කොඩ් එක Import කරගන්න

const app = express();

// 🛠️ Frontend එක වෙනත් සර්වර් එකක (Vercel) ඇති නිසා මෙයට අවසර දිය යුතුය
app.use(cors({
    origin: "*", // නැතහොත් ඔබේ Vercel URL එක මෙතනට දෙන්න (e.g., 'https://mypos.vercel.app')
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

// URL එකක් විදිහට පාවිච්චි කරන්න සම්බන්ධ කිරීම
app.use('/api/products', productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/customers', customerRoutes);

// Server එක Start කිරීම (Render.com එකට ගැළපෙන සේ dynamic කර ඇත)
const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`Server එක Port ${PORT} එකේ වැඩ කරගෙන යනවා... 🔥`);
});