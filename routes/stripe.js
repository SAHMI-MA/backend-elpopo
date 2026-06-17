// ============================================================================
// backend/routes/stripe.js (CLEAN PRODUCTION VERSION)
// ============================================================================

const express = require('express');
const Stripe = require('stripe');
const products = require('../data/products');
const orders = require('./orders');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const router = express.Router();
const webhookRouter = express.Router();

// ======================= SENDGRID =======================
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: {
    user: 'apikey',
    pass: process.env.SENDGRID_API_KEY,
  },
});

// ======================= STRIPE =======================
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
  return new Stripe(key);
}

// ======================= DOWNLOAD LINK =======================
async function generateDownloadLink(fileKey) {
  const secret = process.env.DOWNLOAD_SECRET;
  if (!secret) throw new Error('Missing DOWNLOAD_SECRET');

  const token = jwt.sign({ file: fileKey }, secret, { expiresIn: '24h' });

  const baseUrl = (process.env.BACKEND_URL || '').replace(/\/+$/, '');

  return `${baseUrl}/download/verify?token=${token}`;
}

// ======================= EMAIL =======================
async function sendDownloadEmail(email, productKey) {
  console.log('[MAIL] START', email, productKey);

  const product = products.byId(productKey);
  if (!product) throw new Error('Invalid productKey');

  const fileKey = product.fileKey || productKey;

  const link = await generateDownloadLink(fileKey);

  console.log('[MAIL] LINK READY');

  const mailOptions = {
    from: "contact@sahmi.ma",
    to: email,
    subject: "Your access link",
    html: `
      <h2>Payment confirmed ✅</h2>
      <p>Here is your download link:</p>
      <a href="${link}">Download</a>
      <p>Valid 24h</p>
    `,
  };

  console.log('[MAIL] SENDING TO:', email);

  try {
    const result = await transporter.sendMail(mailOptions);

    console.log('[MAIL][SUCCESS]');
    console.log('[MAIL] messageId:', result.messageId);

    return link;

  } catch (err) {
    console.error('[MAIL][ERROR]', err.message);
    throw err;
  }
}

// ======================= CHECKOUT =======================
router.post('/api/checkout/stripe', async (req, res) => {
  try {
    const { productKey, name, email } = req.body;

    const product = products.byId(productKey);
    if (!product) return res.status(400).json({ error: 'Invalid product' });

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
        productKey,
        email,
        customerName: name,
      },
    });

    res.json({ id: session.id, url: session.url });

  } catch (err) {
    console.error('[CHECKOUT ERROR]', err.message);
    res.status(500).json({ error: 'checkout failed' });
  }
});

// ======================= PAYMENT INTENT =======================
router.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { productKey, name, email } = req.body;

    const product = products.byId(productKey);
    if (!product) return res.status(400).json({ error: 'Invalid product' });

    const stripe = getStripe();

    const intent = await stripe.paymentIntents.create({
      amount: product.amountCents,
      currency: product.currency || 'usd',
      receipt_email: email,
      metadata: {
        productKey,
        email,
        customerName: name,
      },
    });

    res.json({ clientSecret: intent.client_secret });

  } catch (err) {
    console.error('[PI ERROR]', err.message);
    res.status(500).json({ error: 'payment intent failed' });
  }
});

// ======================= WEBHOOK =======================
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(400).send('Webhook error');
  }

  console.log('[STRIPE EVENT]', event.type);

  res.json({ received: true });

  // 🔥 SAFE BACKGROUND EXECUTION
  setImmediate(async () => {
    try {

      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;

        const email = pi.metadata?.email;
        const productKey = pi.metadata?.productKey;

        console.log('[DEBUG] email:', email);

        if (!email || !productKey) return;

        await sendDownloadEmail(email, productKey);
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        const email = session.metadata?.email;
        const productKey = session.metadata?.productKey;

        if (!email || !productKey) return;

        await sendDownloadEmail(email, productKey);
      }

    } catch (err) {
      console.error('[WEBHOOK PROCESS ERROR]', err.message);
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
