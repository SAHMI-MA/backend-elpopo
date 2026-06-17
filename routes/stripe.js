// ============================================================================
// backend/routes/stripe.js (PRODUCTION FIXED VERSION)
// ============================================================================

const express = require('express');
const Stripe = require('stripe');
const products = require('../data/products');
const orders = require('./orders');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const router = express.Router();
const webhookRouter = express.Router();

// ======================= SENDGRID TRANSPORT =======================
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: {
    user: 'apikey',
    pass: process.env.SENDGRID_API_KEY,
  },
});

// ======================= STRIPE INIT =======================
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key);
}

// ======================= VALIDATION =======================
function validateOrderInput(req, res) {
  const { productKey, name, email } = req.body || {};

  if (!productKey || typeof productKey !== 'string') {
    res.status(400).json({ error: 'Missing productKey' });
    return null;
  }

  const product = products.byId(productKey);
  if (!product) {
    res.status(400).json({ error: 'Unknown product' });
    return null;
  }

  if (!name || !email) {
    res.status(400).json({ error: 'Name and email required' });
    return null;
  }

  return {
    product,
    name: name.trim(),
    email: email.trim(),
  };
}

// ======================= DOWNLOAD LINK =======================
async function generateDownloadLink(fileKey) {
  const secret = process.env.DOWNLOAD_SECRET;
  if (!secret) throw new Error('DOWNLOAD_SECRET missing');

  const token = jwt.sign({ file: fileKey }, secret, { expiresIn: '24h' });

  const baseUrl = (process.env.BACKEND_URL || '').replace(/\/+$/, '');

  return `${baseUrl}/download/verify?token=${token}`;
}

// ======================= SEND EMAIL =======================
async function sendDownloadEmail(email, productKey) {
  console.log('[MAIL] START', email, productKey);

  if (!process.env.SENDGRID_API_KEY) throw new Error('SENDGRID_API_KEY missing');

  const product = products.byId(productKey);
  if (!product) throw new Error('Invalid productKey');

  const fileKey = product.fileKey || productKey;

  let link = await generateDownloadLink(fileKey);

  console.log('[MAIL] LINK OK:', link);

  const mailOptions = {
    from: "contact@sahmi.ma",
    to: email,
    subject: "Your download is ready",
    html: `
      <h2>Payment confirmed ✅</h2>
      <p>Here is your access link:</p>
      <a href="${link}">Download your product</a>
      <p>This link expires in 24h</p>
    `,
  };

  console.log('[MAIL] SENDING TO:', email);

  const result = await transporter.sendMail(mailOptions);

  console.log('[MAIL] SENT OK:', result.messageId);

  return link;
}

// ======================= CHECKOUT =======================
router.post('/api/checkout/stripe', async (req, res) => {
  try {
    const v = validateOrderInput(req, res);
    if (!v) return;

    const { product, name, email } = v;
    const stripe = getStripe();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: product.currency || 'usd',
            unit_amount: product.amountCents,
            product_data: {
              name: product.name,
            },
          },
        },
      ],
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: {
        productKey: product.id,
        email,
        customerName: name,
      },
    });

    orders.saveOrder({
      provider: 'stripe',
      providerOrderId: session.id,
      productKey: product.id,
      status: 'pending',
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'checkout error' });
  }
});

// ======================= PAYMENT INTENT =======================
router.post('/api/create-payment-intent', async (req, res) => {
  try {
    const v = validateOrderInput(req, res);
    if (!v) return;

    const { product, name, email } = v;
    const stripe = getStripe();

    const intent = await stripe.paymentIntents.create({
      amount: product.amountCents,
      currency: product.currency || 'usd',
      receipt_email: email,
      metadata: {
        productKey: product.id,
        email,
        customerName: name,
      },
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'payment intent error' });
  }
});

// ======================= WEBHOOK =======================
async function handleWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send('Webhook error');
  }

  console.log('[STRIPE EVENT]', event.type);

  res.json({ received: true });

  // 🔥 SAFE BACKGROUND EXECUTION
  setImmediate(async () => {
    try {
      switch (event.type) {

        // ================= PAYMENT INTENT =================
        case 'payment_intent.succeeded': {
          const pi = event.data.object;

          const email = pi.metadata?.email;
          const productKey = pi.metadata?.productKey;

          console.log('[DEBUG] PI email:', email);

          if (!email || !productKey) return;

          await sendDownloadEmail(email, productKey);
          break;
        }

        // ================= CHECKOUT =================
        case 'checkout.session.completed': {
          const session = event.data.object;

          const email = session.metadata?.email;
          const productKey = session.metadata?.productKey;

          if (!email || !productKey) return;

          await sendDownloadEmail(email, productKey);
          break;
        }

        default:
          console.log('[STRIPE] ignored:', event.type);
      }
    } catch (err) {
      console.error('[WEBHOOK ERROR]', err.message);
    }
  });
}

// ======================= ROUTES =======================
webhookRouter.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

module.exports = { router, webhookRouter, handleWebhook };
