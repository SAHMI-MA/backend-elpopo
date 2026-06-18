// ============================================================================
// backend/routes/stripe.js
// ============================================================================

const express = require('express');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const products = require('../data/products');
const orders = require('./orders');
const jwt = require('jsonwebtoken');

const router = express.Router();
const webhookRouter = express.Router();

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

// ======================= SEND EMAIL (SendGrid HTTP API) =======================
async function sendDownloadEmail(email, productKey) {
  console.log('[MAIL] START', email, productKey);

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY missing');

  const product = products.byId(productKey);
  if (!product) throw new Error('Invalid productKey');

  const fileKey = product.fileKey || productKey;
  const link = await generateDownloadLink(fileKey);

  console.log('[MAIL] LINK OK:', link);

  sgMail.setApiKey(apiKey);

const msg = {
  from: 'admin@reframelayers.com',
  to: email,
  subject: 'Your Product Is Ready to Download',
  html: `
    <div style="font-family: Arial, sans-serif; line-height: 1.7; color: #333;">
      <p>Hi,</p>

      <p>Thank you for your purchase.</p>

      <p>Your product is now ready to download.</p>

      <p>
        You can access it here:<br><br>
        <a href="${link}" 
           style="display:inline-block; padding:12px 20px; background:#000; color:#fff; text-decoration:none; border-radius:6px;">
          Download Your Product
        </a>
      </p>

      <p>
        <strong>Important:</strong> this download link is available for 24 hours only.
      </p>

      <p>
        Please download and save your file before the link expires.
        After 24 hours, access may no longer be available through this link.
      </p>

      <p>
        If you have any issue accessing your product, contact us through the website contact form and we’ll help you as soon as possible.
      </p>

      <p>
        Thank you for trusting <strong>Elpopo Academy</strong>.
      </p>
    </div>
  `,
};

  console.log('[MAIL] SENDING TO:', email);

  const [response] = await sgMail.send(msg);

  console.log('[MAIL] SENT OK — status:', response.statusCode);

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
    console.error('[CHECKOUT ERROR]', err.message);
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
    console.error('[PAYMENT INTENT ERROR]', err.message);
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
    console.error('[WEBHOOK] Signature error:', err.message);
    return res.status(400).send('Webhook error');
  }

  console.log('[STRIPE EVENT]', event.type);

  // Respond to Stripe immediately — processing happens in background
  res.json({ received: true });

  setImmediate(async () => {
    try {
      switch (event.type) {

        // ================= PAYMENT INTENT =================
        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          const email = pi.metadata?.email;
          const productKey = pi.metadata?.productKey;

          console.log('[DEBUG] PI email:', email, '| productKey:', productKey);

          if (!email || !productKey) {
            console.warn('[WEBHOOK] Missing email or productKey in payment_intent metadata');
            return;
          }

          await sendDownloadEmail(email, productKey);
          break;
        }

        // ================= CHECKOUT SESSION =================
        case 'checkout.session.completed': {
          const session = event.data.object;
          const email = session.metadata?.email;
          const productKey = session.metadata?.productKey;

          console.log('[DEBUG] Checkout email:', email, '| productKey:', productKey);

          if (!email || !productKey) {
            console.warn('[WEBHOOK] Missing email or productKey in checkout.session metadata');
            return;
          }

          await sendDownloadEmail(email, productKey);
          break;
        }

        default:
          console.log('[STRIPE] Ignored event:', event.type);
      }
    } catch (err) {
      console.error('[WEBHOOK ERROR]', err.message);
      // Log SendGrid-specific error body if available
      if (err.response?.body) {
        console.error('[SENDGRID ERROR BODY]', JSON.stringify(err.response.body, null, 2));
      }
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
