// ============================================================================
// backend/server.js
// ----------------------------------------------------------------------------
// Wires middleware + routes + (optionally) serves the frontend statically.
//
// Endpoints exposed:
//   POST /api/checkout/stripe         - create Stripe Checkout Session
//   POST /api/create-payment-intent   - in-page Stripe Elements flow
//   POST /webhook/stripe              - Stripe webhook (raw body)
//   POST /api/checkout/paypal         - create PayPal order
//   GET  /api/checkout/paypal/capture - PayPal return URL, captures + redirects
//   GET  /api/products                - public catalog (no secrets)
//   GET  /api/orders/summary          - order counts (no PII)
//   GET  /api/config                  - frontend bootstrap config (publishable keys)
//
// In production, set FRONTEND_URL in .env so CORS only allows that origin.
// ============================================================================

// Load .env from backend/ first, fall back to the project root .env so a
// user who already had .env at the repo root before the restructure does
// not have to move the file.
const path = require('path');
const fs = require('fs');
const localEnv = path.join(__dirname, '.env');
const parentEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(localEnv)) {
  require('dotenv').config({ path: localEnv });
} else if (fs.existsSync(parentEnv)) {
  require('dotenv').config({ path: parentEnv });
  console.log('[env] loaded parent .env (' + parentEnv + ') — consider moving it to backend/.env');
} else {
  require('dotenv').config();
}

const express = require('express');

const {
  helmetMiddleware,
  corsMiddleware,
  apiLimiter,
  checkoutLimiter,
} = require('./middleware/security');

const products = require('./data/products');
const stripeRoutes = require('./routes/stripe');
const paypalRoutes = require('./routes/paypal');
const ordersRoutes = require('./routes/orders');

const PORT = Number(process.env.PORT || 5000);
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ---------------------------------------------------------------------------
// Domain configuration - everything is driven by env. PUBLIC_BASE_URL is the
// single source of truth for the public-facing URL of the deployed site.
// FRONTEND_URL, BACKEND_URL, SUCCESS_URL, CANCEL_URL inherit from it unless
// explicitly overridden (useful for split-deployment setups).
// ---------------------------------------------------------------------------
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function derive(suffix) {
  return PUBLIC_BASE_URL ? PUBLIC_BASE_URL + suffix : '';
}

// Write the resolved values back to process.env so every route reads a
// consistent set of URLs without each one re-implementing the fallback chain.
process.env.FRONTEND_URL = process.env.FRONTEND_URL || PUBLIC_BASE_URL;
process.env.BACKEND_URL  = process.env.BACKEND_URL  || PUBLIC_BASE_URL;
process.env.SUCCESS_URL  = process.env.SUCCESS_URL  || derive('/success.html');
process.env.CANCEL_URL   = process.env.CANCEL_URL   || derive('/cancel.html');

const app = express();

// Trust the first proxy hop in production (Render/Heroku/etc.) so rate
// limiting and req.protocol are correct.
app.set('trust proxy', 1);

// Security headers first.
app.use(helmetMiddleware);
app.use(corsMiddleware);

// Stripe webhook needs the RAW body. Mount BEFORE express.json().
app.use(stripeRoutes.webhookRouter);

// JSON parser for everything else.
app.use(express.json({ limit: '16kb' }));

// Light rate limit on all /api routes, tighter on the checkout creators.
app.use('/api', apiLimiter);
app.use('/api/checkout', checkoutLimiter);
app.use('/api/create-payment-intent', checkoutLimiter);

// --- API routes ---
app.use(stripeRoutes.router);
app.use(paypalRoutes.router);
app.use(ordersRoutes.router);

// Public catalog (no secrets) - handy for the frontend to display prices
// after a config refresh without re-deploying.
app.get('/api/products', (_req, res) => {
  const list = products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    amountCents: p.amountCents,
    currency: p.currency || 'usd',
    image: p.image || '',
    video: p.video || '',
    category: p.category || '',
    applyOnly: !!p.applyOnly,
  }));
  res.json(list);
});

// Frontend bootstrap config (publishable values ONLY).
app.get('/api/config', (_req, res) => {
  res.json({
    businessName: process.env.BUSINESS_NAME || '',
    businessEmail: process.env.BUSINESS_EMAIL || '',
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    paypalMode: process.env.PAYPAL_MODE || 'sandbox',
    publicBaseUrl: PUBLIC_BASE_URL,
    successUrl: process.env.SUCCESS_URL || '',
    cancelUrl: process.env.CANCEL_URL || '',
  });
});

// --- Static frontend (single-server deploy) ---------------------------------
// If you prefer running the frontend on a separate port/host, you can delete
// this block and serve frontend/ with any static server.
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));

// --- 404 + error handlers ---------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.status(404).sendFile(path.join(FRONTEND_DIR, 'cancel.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ---------------------------------------------------------------------------
// Production sanity check - warns/exits if .env looks unsafe for production.
// Triggered only when NODE_ENV=production so local dev is not affected.
// ---------------------------------------------------------------------------
function productionSanityCheck() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return;

  const problems = [];
  if (!PUBLIC_BASE_URL || /^https?:\/\/localhost|127\.0\.0\.1/i.test(PUBLIC_BASE_URL)) {
    problems.push('PUBLIC_BASE_URL must be a real https URL in production (got: ' + (PUBLIC_BASE_URL || '<empty>') + ').');
  } else if (!/^https:\/\//i.test(PUBLIC_BASE_URL)) {
    problems.push('PUBLIC_BASE_URL must use https in production (got: ' + PUBLIC_BASE_URL + ').');
  }
  if ((process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')) {
    problems.push('STRIPE_SECRET_KEY is a TEST key (sk_test_...). Swap to a live key (sk_live_...) for production.');
  }
  if ((process.env.STRIPE_PUBLISHABLE_KEY || '').startsWith('pk_test_')) {
    problems.push('STRIPE_PUBLISHABLE_KEY is a TEST key. Swap to pk_live_... AND update frontend/js/config.js to match.');
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    problems.push('STRIPE_WEBHOOK_SECRET is missing - webhooks will be rejected.');
  }
  if (process.env.PAYPAL_MODE !== 'live' && (process.env.PAYPAL_CLIENT_ID || '').length > 0) {
    problems.push('PAYPAL_MODE is "' + (process.env.PAYPAL_MODE || 'sandbox') + '" but PayPal credentials are set - set PAYPAL_MODE=live for production.');
  }
  if (!process.env.ADMIN_TOKEN) {
    problems.push('ADMIN_TOKEN is not set - the /api/orders/summary endpoint will be disabled in production.');
  }

  if (problems.length) {
    console.warn('');
    console.warn('================ PRODUCTION CONFIG WARNINGS ================');
    problems.forEach((p) => console.warn('  ! ' + p));
    console.warn('============================================================');
    console.warn('');
  }
}

app.listen(PORT, () => {
  const businessName = process.env.BUSINESS_NAME || 'Store';
  if (PUBLIC_BASE_URL) {
    console.log(`[${businessName}] listening on port ${PORT} (public URL: ${PUBLIC_BASE_URL})`);
  } else {
    console.log(`[${businessName}] listening on port ${PORT}`);
    console.warn('[env] PUBLIC_BASE_URL is not set. Set it in .env before deploying so redirect URLs and CORS resolve correctly.');
  }
  productionSanityCheck();
});
