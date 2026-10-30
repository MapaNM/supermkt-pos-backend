const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
require('./config/backup'); // Import the code that sets up Backups
const { protect, requireAdmin } = require('./middleware/auth'); // 🔐 Auth middleware

if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET is missing from .env! Stopping the Server - auth cannot work without it.");
  process.exit(1);
}

const app = express();

// 🛠️ Since the Frontend is on a different server (Vercel), it must be allowed here
// 🔐 UPDATED: FRONTEND_URL can now hold multiple comma-separated origins - to allow both the production
// Vercel URL and local dev (localhost:5173) at the same time; "*" is never used
// ("*" cannot be used together with credentials:true). In .env:
//   FRONTEND_URL=https://supermkt-pos-frontend.vercel.app,http://localhost:5173
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
      // origin is undefined - server-to-server calls, curl, Postman (the origin header is only sent with requests made by a browser)
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

// Middleware (to read JSON Data)
app.use(express.json()); 

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Database connected successfully! ✅"))
  .catch((err) => console.log("Database connection error: ❌", err));

// A simple Route to check whether the server is working
app.get('/', (req, res) => {
  res.send("Grocery POS Backend is running! 🚀");
});

// 🛠️ Import all Routes in order in one place
const productRoutes = require('./routes/productRoutes');
const userRoutes = require('./routes/userRoutes');
const customerRoutes = require('./routes/customerRoutes'); // (the line that was above has been correctly included here)
const supplierRoutes = require('./routes/supplierRoutes');
const promotionRoutes = require('./routes/promotionRoutes');
const shiftRoutes = require('./routes/shiftRoutes'); // 🆕 Shift / Cash Drawer Reconciliation

// Connecting them for use as URLs
// 🔐 UPDATED: Being logged in (protect) is mandatory for everything except /api/users.
//    Admin-only actions (add/update/delete product, void sale, etc.) are further restricted inside each route file
//    with requireAdmin. Suppliers is entirely Admin-only.
app.use('/api/products', protect, productRoutes);
app.use('/api/users', userRoutes); // login is public inside; register requires protect+requireAdmin inside
app.use('/api/customers', protect, customerRoutes);
app.use('/api/suppliers', protect, requireAdmin, supplierRoutes); // whole module: admin only
app.use('/api/promotions', protect, promotionRoutes);
// 🆕 Shift open/close/current - any logged-in user (cashier/admin) can manage their own Shift - only history is admin-only (requireAdmin inside the route itself)
app.use('/api/shifts', protect, shiftRoutes);

// 🔐 404 - if no defined route matches
app.use((req, res) => {
  res.status(404).json({ message: "This API path was not found" });
});

// 🔐 SAFETY NET: An error that Claude/code forgot to catch inside a route
// (bad JSON body, unexpected exception, etc.) is caught here, the stack trace is printed only
// in the server log, and only a generic message is sent to the client.
// (Express 5 es async handler errors automatically forward here)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: "An unexpected error occurred! Please try again." });
});

// Start the Server (made dynamic to suit Render.com)
const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`Server is running on Port ${PORT}... 🔥`);
});