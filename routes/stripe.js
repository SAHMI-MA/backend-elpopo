// ============================================================================
// backend/routes/stripe.js
// ============================================================================

const express = require('express');
const Stripe = require('stripe');
const products = require('../data/products');
const orders = require('./orders');
console.log("STRIPE KEY =", process.env.STRIPE_SECRET_KEY);
console.log("SECRET =", process.env.STRIPE_SECRET_KEY.substring(0, 8));

const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// ✅ SENDGRID — remplace Gmail
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: {
    user: 'apikey',                          // toujours "apikey" mot pour mot
    pass: process.env.SENDGRID_API_KEY,      // votre clé SG.xxxxxxx
  },
});

const axios = require("axios");

const router = express.Router();
const webhookRouter = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing - check backend/.env');
  return new Stripe(key);
}

function validateOrderInput(req, res) {
  const { productKey, name, email } = req.body || {};
  if (!productKey || typeof productKey !== 'string') {
    res.status(400).json({ error: 'Missing productKey.' });
    return null;
  }
  const product = products.byId(productKey);
  if (!product) {
    res.status(400).json({ error: 'Unknown product.' });
    return null;
  }
  if (product.applyOnly) {
    res.status(400).json({ error: 'This product is by application only.' });
    return null;
  }
  if (typeof name !== 'string' || typeof email !== 'string') {
    res.status(400).json({ error: 'Name and email are required.' });
    return null;
  }
  const cleanName = name.trim().slice(0, 80);
  const cleanEmail = email.trim().slice(0, 120);
  if (!cleanName) {
    res.status(400).json({ error: 'Name is required.' });
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    res.status(400).json({ error: 'A valid email is required.' });
    return null;
  }
  return { product, name: cleanName, email: cleanEmail };
}

async function generateDownloadLink(fileKey) {
  const token = jwt.sign(
    { file: fileKey },
    process.env.DOWNLOAD_SECRET,
    { expiresIn: "24h" }
  );
  return `${process.env.BACKEND_URL}/download/verify?token=${token}`;
}

// ✅ Fonction centralisée d'envoi email — utilisée par les deux events
async function sendDownloadEmail(email, productKey) {
  const product = products.byId(productKey);
  const fileKey = product?.fileKey || productKey;
  const link = await generateDownloadLink(fileKey);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,   // votre variable Railway EMAIL_FROM
    to: email,
    subject: "Your ELPOPO Academy access link",
    html: `
      <div style="font-family: Arial, sans-serif; line-height:1.6;">
        <h2>Payment confirmed ✅</h2>
        <p>Thank you for your purchase.</p>
        <p>Your secure download link (valid 24h):</p>
        <p>
          <a href="${link}" target="_blank" style="color:#d4af37;">
            Download your product here
          </a>
        </p>
        <hr />
        <p style="font-size:12px;color:#888;">
          If you have any issue, contact support.
        </p>
      </div>
    `,
  });

  console.log('[EMAIL SENT]', email);
  console.log('[DOWNLOAD LINK]', link);
  return link;
}

// ----------- 1. Stripe Checkout Session (redirect flow) ---------------------
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
              description: product.description || undefined,
              images: product.image ? [product.image] : undefined,
            },
          },
        },
      ],
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: {
        productKey: product.id,
        customerName: name,
        email,
      },
    });

    orders.saveOrder({
      provider: 'stripe',
      providerOrderId: session.id,
      productKey: product.id,
      productName: product.name,
      amountCents: product.amountCents,
      currency: product.currency || 'usd',
      customer: { name, email },
      status: 'pending',
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('checkout/stripe error:', err && err.message);
    res.status(500).json({ error: 'Could not start Stripe checkout.' });
  }
});

// ----------- 2. PaymentIntent (in-page Elements flow) -----------------------
router.post('/api/create-payment-intent', async (req, res) => {
  try {
    const v = validateOrderInput(req, res);
    if (!v) return;
    const { product, name, email } = v;

    const stripe = getStripe();
    const intent = await stripe.paymentIntents.create({
      amount: product.amountCents,
      currency: product.currency || 'usd',
      payment_method_types: ['card'],
      receipt_email: email,
      description: product.name,
      metadata: {
        productKey: product.id,
        productName: product.name,
        customerName: name,
        email,
      },
    });

    orders.saveOrder({
      provider: 'stripe',
      providerOrderId: intent.id,
      productKey: product.id,
      productName: product.name,
      amountCents: product.amountCents,
      currency: product.currency || 'usd',
      customer: { name, email },
      status: 'pending',
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('create-payment-intent FULL ERROR:', err);
    console.error('MESSAGE:', err && err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ----------- 3. Webhook ----------------------------------------------------
webhookRouter.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.warn('STRIPE_WEBHOOK_SECRET missing - rejecting webhook.');
      return res.status(500).send('Webhook secret not configured.');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Stripe webhook signature failed:', err.message);
      return res.status(400).send('Webhook Error: ' + err.message);
    }

    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        orders.updateOrder(
          { provider: 'stripe', providerOrderId: session.id },
          { status: 'paid', paidAt: new Date().toISOString() }
        );
        console.log('[stripe] checkout.session.completed', session.id);

        try {
          const email = session.customer_email;
          const productKey = session.metadata?.productKey;
          if (email && productKey) {
            await sendDownloadEmail(email, productKey);
          } else {
            console.log('[WARN] Missing email or productKey in metadata');
          }
        } catch (err) {
          console.error('[ERROR] email sending failed:', err.message);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        orders.updateOrder(
          { provider: 'stripe', providerOrderId: pi.id },
          { status: 'paid', paidAt: new Date().toISOString() }
        );
        console.log('[stripe] payment_intent.succeeded', pi.id);

        try {
          const email = pi.receipt_email || pi.metadata?.email;
          const productKey = pi.metadata?.productKey;
          if (email && productKey) {
            // ✅ Envoi email réel (était seulement console.log avant !)
            await sendDownloadEmail(email, productKey);
          } else {
            console.log('[WARN] Missing email or productKey');
          }
        } catch (err) {
          console.error('[ERROR] generating/sending download link:', err.message);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        orders.updateOrder(
          { provider: 'stripe', providerOrderId: pi.id },
          { status: 'failed' }
        );
        console.log('[stripe] payment_intent.payment_failed', pi.id);
        break;
      }

      case 'charge.refunded': {
        console.log('[stripe] charge.refunded', event.data.object.id);
        break;
      }

      default:
        console.log('[stripe] unhandled event', event.type);
    }

    res.json({ received: true });
  }
);

module.exports = { router, webhookRouter };
