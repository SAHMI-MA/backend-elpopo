const express = require('express');
const Stripe = require('stripe');
const products = require('../data/products');
const orders = require('./orders');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');

const router = express.Router();
const webhookRouter = express.Router();

// ======================= SENDGRID API (FIX IMPORTANT) =======================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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

  const msg = {
    to: email,
    from: "contact@sahmi.ma",
    subject: "Your access link",
    html: `
      <h2>Payment confirmed ✅</h2>
      <p>Here is your download link:</p>
      <a href="${link}">Download your product</a>
      <p>Valid for 24h</p>
    `,
  };

  console.log('[MAIL] SENDING TO:', email);

  try {
    const result = await sgMail.send(msg);

    console.log('[MAIL][SUCCESS]');
    console.log('[MAIL] response:', result[0]?.statusCode);

    return link;

  } catch (err) {
    console.error('[MAIL][ERROR]');
    console.error(err.response?.body || err.message);
    throw err;
  }
}

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

  // 🔥 background safe execution
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
