const jwt = require("jsonwebtoken");
const User = require("../models/User");

// 🔐 protect: JWT token එකක් valid ද කියලා පරීක්ෂා කර req.user එකට logged-in user ගේ
// details (password හැර) attach කරයි. Token නැත්තම් / වැරදි නම් 401 return කරයි.
// සියලුම protected route එකකට පාවිච්චි කරන්න: router.get('/x', protect, handler)
const protect = async (req, res, next) => {
  try {
    let token;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ message: "මෙම ක්‍රියාව සඳහා ලොග් වී සිටිය යුතුයි! (Unauthorized)" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({ message: "පරිශීලකයා සොයාගත නොහැක - නැවත ලොග් වන්න" });
    }

    req.user = user; // { _id, username, role }
    next();
  } catch (error) {
    // Expired token, malformed token, wrong secret, etc. all land here
    return res.status(401).json({ message: "Session එක වලංගු නැත - නැවත ලොග් වන්න" });
  }
};

// 🔐 requireAdmin: protect ට පස්සේ chain කරන්න - role 'admin' නොවේ නම් 403.
// router.delete('/x', protect, requireAdmin, handler)
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "මෙම ක්‍රියාව සිදු කළ හැක්කේ Admin ට පමණි! (Forbidden)" });
  }
  next();
};

module.exports = { protect, requireAdmin };