// middleware/auth.js
const jwt = require('jsonwebtoken');

function verifyToken(tokenOrReq, res, next) {
  // Works both as Express middleware AND as a utility function (WebSocket auth)
  if (typeof tokenOrReq === 'string') {
    return jwt.verify(tokenOrReq, process.env.JWT_SECRET);
  }
  // Express middleware mode
  const req = tokenOrReq;
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signTokens(userId) {
  const access = jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refresh = jwt.sign(
    { sub: userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { access, refresh };
}

module.exports = { verifyToken, signTokens };
