// ============================================================================
// backend/middleware/security.js
// Helmet + CORS + rate limiting (PRODUCTION SAFE VERSION)
// ============================================================================

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const isProd = process.env.NODE_ENV === 'production';

// -------------------- Helmet --------------------
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
});

// -------------------- Allowed Origins --------------------
const allowedOrigins = [
  "https://www.reframelayers.com",
  "https://reframelayers.com",
  "http://localhost:3000"
];

// -------------------- CORS SAFE MIDDLEWARE --------------------
const corsMiddleware = cors({
  origin: function (origin, cb) {
    // Allow server-to-server / curl / Stripe webhooks
    if (!origin) return cb(null, true);

    const normalize = (o) => (o || '').replace(/\/+$/, '');

    const normalizedOrigin = normalize(origin);

    const allowed = allowedOrigins.some(o => normalize(o) === normalizedOrigin);

    if (allowed) {
      return cb(null, true);
    }

    // ❗ DO NOT crash server in production
    console.log('[CORS BLOCKED]', origin);
    return cb(null, false);
  },

  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
});

// -------------------- Rate limit (API) --------------------
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// -------------------- Rate limit (Checkout stricter) --------------------
const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: isProd ? 20 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please wait a few minutes.' },
});

// -------------------- EXPORT --------------------
module.exports = {
  helmetMiddleware,
  corsMiddleware,
  apiLimiter,
  checkoutLimiter,
};
