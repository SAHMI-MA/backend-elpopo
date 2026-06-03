// ============================================================================
// backend/routes/paypal.js
// ----------------------------------------------------------------------------
// PayPal Orders v2 over REST. No SDK needed - just fetch.
//
//   POST /api/checkout/paypal          - create order, return approveUrl
//   GET  /api/checkout/paypal/capture  - PayPal redirects here after approval
//                                        we capture, then redirect to success/cancel
//
// Verification rule: the price comes from products.js on the server, NEVER
// from the request body. The capture step re-checks the captured amount
// against the catalog before marking the order paid.
// ============================================================================

const express = require('express');
const products = require('../data/products');
const orders = require('./orders');

const router = express.Router();

function apiBase() {
  return (process.env.PAYPAL_MODE || 'sandbox') === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function getAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing.');
  const auth = Buffer.from(id + ':' + secret).toString('base64');
  const r = await fetch(apiBase() + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('PayPal auth failed: ' + r.status + ' ' + txt);
  }
  const data = await r.json();
  return data.access_token;
}

function dollars(cents) {
  return (cents / 100).toFixed(2);
}

function backendBaseUrl(req) {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, '');
  return req.protocol + '://' + req.get('host');
}

// ----- 1. Create order ------------------------------------------------------
router.post('/api/checkout/paypal', async (req, res) => {
  try {
    const { productKey, name, email } = req.body || {};
    if (!productKey || typeof productKey !== 'string') {
      return res.status(400).json({ error: 'Missing productKey.' });
    }
    const product = products.byId(productKey);
    if (!product) return res.status(400).json({ error: 'Unknown product.' });
    if (product.applyOnly) {
      return res.status(400).json({ error: 'This product is by application only.' });
    }
    const cleanName = String(name || '').trim().slice(0, 80);
    const cleanEmail = String(email || '').trim().slice(0, 120);
    if (!cleanName) return res.status(400).json({ error: 'Name is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }

    const token = await getAccessToken();
    const currency = (product.currency || 'usd').toUpperCase();
    const returnUrl = backendBaseUrl(req) + '/api/checkout/paypal/capture';
    const cancelUrl = process.env.CANCEL_URL || (backendBaseUrl(req) + '/cancel.html');

    const r = await fetch(apiBase() + '/v2/checkout/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: product.id,
            description: product.name.slice(0, 127),
            amount: {
              currency_code: currency,
              value: dollars(product.amountCents),
            },
          },
        ],
        application_context: {
          brand_name: process.env.BUSINESS_NAME || 'Store',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('PayPal create order failed:', r.status, data);
      return res.status(502).json({ error: 'PayPal could not create the order.' });
    }

    const approve = (data.links || []).find((l) => l.rel === 'approve');
    if (!approve) {
      return res.status(502).json({ error: 'PayPal approve URL missing.' });
    }

    orders.saveOrder({
      provider: 'paypal',
      providerOrderId: data.id,
      productKey: product.id,
      productName: product.name,
      amountCents: product.amountCents,
      currency: product.currency || 'usd',
      customer: { name: cleanName, email: cleanEmail },
      status: 'pending',
    });

    res.json({ id: data.id, approveUrl: approve.href });
  } catch (err) {
    console.error('checkout/paypal error:', err && err.message);
    res.status(500).json({ error: 'Could not start PayPal checkout.' });
  }
});

// ----- 2. Capture (PayPal redirects here after the buyer approves) ----------
router.get('/api/checkout/paypal/capture', async (req, res) => {
  const orderId = req.query.token;
  const successUrl = process.env.SUCCESS_URL || '/success.html';
  const cancelUrl = process.env.CANCEL_URL || '/cancel.html';
  try {
    if (!orderId) return res.redirect(cancelUrl);

    const stored = orders.findOrder({ provider: 'paypal', providerOrderId: orderId });
    if (!stored) {
      console.warn('PayPal capture: unknown order', orderId);
      return res.redirect(cancelUrl);
    }

    const token = await getAccessToken();
    const r = await fetch(apiBase() + '/v2/checkout/orders/' + orderId + '/capture', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('PayPal capture failed:', r.status, data);
      orders.updateOrder(
        { provider: 'paypal', providerOrderId: orderId },
        { status: 'failed' }
      );
      return res.redirect(cancelUrl);
    }

    // Backend-side amount verification. The capture object lives at
    // purchase_units[0].payments.captures[0].amount.
    const pu = (data.purchase_units || [])[0] || {};
    const cap = ((pu.payments && pu.payments.captures) || [])[0] || {};
    const paidValue = cap.amount && cap.amount.value;
    const paidCurrency = (cap.amount && cap.amount.currency_code || '').toLowerCase();
    const expectedValue = dollars(stored.amountCents);
    const expectedCurrency = (stored.currency || 'usd').toLowerCase();

    if (
      data.status !== 'COMPLETED' ||
      paidValue !== expectedValue ||
      paidCurrency !== expectedCurrency
    ) {
      console.warn('PayPal capture mismatch:', { orderId, paidValue, paidCurrency, expectedValue, expectedCurrency, status: data.status });
      orders.updateOrder(
        { provider: 'paypal', providerOrderId: orderId },
        { status: 'failed', failureReason: 'amount-mismatch-or-not-completed' }
      );
      return res.redirect(cancelUrl);
    }

    orders.updateOrder(
      { provider: 'paypal', providerOrderId: orderId },
      { status: 'paid', paidAt: new Date().toISOString(), captureId: cap.id }
    );
    res.redirect(successUrl);
  } catch (err) {
    console.error('paypal capture error:', err && err.message);
    res.redirect(cancelUrl);
  }
});

module.exports = { router };
