// ============================================================================
// backend/middleware/security.js
// Helmet + CORS + rate limiting. Wired in server.js with app.use(...).
// ============================================================================

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const isProd = process.env.NODE_ENV === 'production';
// Read FRONTEND_URL lazily inside the cors callback - server.js resolves it
// from PUBLIC_BASE_URL after this module is required, so we must NOT cache it here.

const helmetMiddleware = helmet({
  // The CSP that ships with helmet by default blocks Stripe.js, PayPal,
  // YouTube embeds, and Google Fonts. Either disable it (recommended for
  // a static marketing site that loads its own third-parties) or extend
  // the directives. Here we disable it and rely on the other helmet
  // headers (X-Frame-Options, HSTS, NoSniff, etc.).
  contentSecurityPolicy: false,
  // Allow PayPal/Stripe popups during checkout.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
});

const corsMiddleware = cors({
  origin: function (origin, cb) {
    const allowed = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    // Allow same-origin (no Origin header) and the configured frontend URL.
    if (!origin) return cb(null, true);
    if (!allowed) return cb(null, true); // permissive when FRONTEND_URL is not set
    if (origin.replace(/\/+$/, '') === allowed) return cb(null, true);
    return cb(new Error('CORS: origin not allowed - ' + origin));
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
});

// Per-IP rate limit. Tight on payment endpoints, looser elsewhere.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,            // 15 min
  max: isProd ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,            // 10 min
  max: isProd ? 20 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please wait a few minutes.' },
});

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  apiLimiter,
  checkoutLimiter,
};
