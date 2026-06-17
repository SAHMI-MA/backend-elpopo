// ============================================================================
// backend/routes/stripe.js (PRODUCTION FIXED FULL VERSION)
// ============================================================================

const express = require('express');
const Stripe = require('stripe');
const products = require('../data/products');
const orders = require('./orders');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');

const router = express.Router();
const webhookRouter = express.Router();

// ======================= SENDGRID =======================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ======================= STRIPE INIT =======================
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key);
}

// ======================= VALIDATION =======================
function validateInput(req, res) {
  const { productKey, name, email } = req.body || {};

  if (!productKey || !name || !email) {
    res.status(400).json({ error: 'Missing fields' });
    return null;
  }

  const product = products.byId(productKey);
  if (!product) {
    res.status(400).json({ error: 'Invalid product' });
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

  const product = products.byId(productKey);
  if (!product) throw new Error('Invalid productKey');

  const fileKey = product.fileKey || productKey;

  const link = await generateDownloadLink(fileKey);

  console.log('[MAIL] LINK GENERATED');

  const msg = {
    to: email,
    from: "contact@sahmi.ma",
    subject: "Your ELPOPO Academy access",
    html: `
      <h2>Payment confirmed ✅</h2>
      <p>Your download link is ready:</p>
      <a href="${link}">Download your product</a>
      <p>Valid 24h</p>
    `,
  };

  console.log('[MAIL] SENDING TO:', email);

  try {
    const result = await sgMail.send(msg);

    console.log('[MAIL][SUCCESS]');
    console.log('[MAIL] status:', result[0]?.statusCode);

    return link;

  } catch (err) {
    console.error('[MAIL][ERROR]');
    console.error(err.response?.body || err.message);
    throw err;
  }
}

// ======================= STRIPE CHECKOUT =======================
router.post('/api/checkout/stripe', async (req, res) => {
  try {
    const v = validateInput(req, res);
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
        productKey,
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
    console.error('[CHECKOUT ERROR]', err.message);
    res.status(500).json({ error: 'checkout failed' });
  }
});

// ======================= PAYMENT INTENT =======================
router.post('/api/create-payment-intent', async (req, res) => {
  try {
    const v = validateInput(req, res);
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

  // SAFE BACKGROUND EXECUTION
  setImmediate(async () => {
    try {

      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;

        const email = pi.metadata?.email;
        const productKey = pi.metadata?.productKey;

        console.log('[DEBUG EMAIL]', email);

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

// ======================= ROUTES EXPORT =======================
webhookRouter.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

module.exports = {
  router,
  webhookRouter,
  handleWebhook,
};
