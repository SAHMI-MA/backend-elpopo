// ============================================================================
// backend/routes/stripe.js
// ============================================================================

const express = require('express');
const Stripe = require('stripe');
const products = require('../data/products');
const orders = require('./orders');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

// ✅ SENDGRID
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: {
    user: 'apikey',
    pass: process.env.SENDGRID_API_KEY,
  },
});

const router = express.Router();
const webhookRouter = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing - check Railway Variables');
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
  const secret = process.env.DOWNLOAD_SECRET;
  if (!secret) throw new Error('DOWNLOAD_SECRET missing - check Railway Variables');
  const token = jwt.sign({ file: fileKey }, secret, { expiresIn: '24h' });
  const backendUrl = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
  return `${backendUrl}/download/verify?token=${token}`;
}

async function sendDownloadEmail(email, productKey) {
  console.log('[MAIL] sendDownloadEmail() called for', email, '/ productKey:', productKey);

  // Sanity checks BEFORE touching SendGrid, so we know exactly what's missing
  if (!process.env.SENDGRID_API_KEY) {
    console.error('[MAIL][FATAL] SENDGRID_API_KEY is missing in env.');
    throw new Error('SENDGRID_API_KEY missing');
  }
  if (!process.env.EMAIL_FROM) {
    console.error('[MAIL][FATAL] EMAIL_FROM is missing in env.');
    throw new Error('EMAIL_FROM missing');
  }
  if (!process.env.DOWNLOAD_SECRET) {
    console.error('[MAIL][FATAL] DOWNLOAD_SECRET is missing in env.');
    throw new Error('DOWNLOAD_SECRET missing');
  }
  if (!process.env.BACKEND_URL) {
    console.warn('[MAIL][WARN] BACKEND_URL is empty - the download link will be malformed.');
  }

  const product = products.byId(productKey);
  if (!product) {
    console.error('[MAIL][FATAL] No product found for productKey:', productKey);
    throw new Error('Unknown productKey: ' + productKey);
  }

  const fileKey = product.fileKey || productKey;
  console.log('[MAIL] resolved fileKey:', fileKey);

  let link;
  try {
    link = await generateDownloadLink(fileKey);
    console.log('[MAIL] download link generated OK:', link);
  } catch (err) {
    console.error('[MAIL][FATAL] generateDownloadLink failed:', err && err.message);
    throw err;
  }

  try {
    console.log('[MAIL] attempting transporter.sendMail() ->', email);
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: 'Your ELPOPO Academy access link',
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
    console.log('[MAIL][SENT] to:', email, '| messageId:', info && info.messageId);
    console.log('[MAIL][SENT] response:', info && info.response);
  } catch (err) {
    // This is the most likely place the real error is hiding (SendGrid auth,
    // unverified sender, bad API key, network egress blocked, etc.)
    console.error('[MAIL][FATAL] transporter.sendMail() threw:', err && err.message);
    if (err && err.response) {
      console.error('[MAIL][FATAL] SMTP response:', err.response);
    }
    if (err && err.responseCode) {
      console.error('[MAIL][FATAL] SMTP responseCode:', err.responseCode);
    }
    throw err;
  }

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

    console.log('[stripe] PaymentIntent created:', intent.id, '| metadata:', JSON.stringify(intent.metadata));

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('create-payment-intent error:', err && err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ----------- 3. Webhook handler ---------------------------------------------
async function handleWebhook(req, res) {
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

  console.log('[stripe] event reçu:', event.type);

  // ✅ RÉPONDRE IMMÉDIATEMENT à Stripe
  res.json({ received: true });

  console.log('[DEBUG] event.type =', event.type);
  console.log('[DEBUG] event.data.object =', JSON.stringify(event.data.object).substring(0, 300));

  // ✅ Traiter l'événement APRÈS avoir répondu à Stripe.
  // IMPORTANT: chaque branche a son propre try/catch interne en plus du
  // try/catch global, pour qu'une erreur dans un "case" ne soit jamais
  // avalée silencieusement et soit toujours loggée avec un message clair.
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        orders.updateOrder(
          { provider: 'stripe', providerOrderId: session.id },
          { status: 'paid', paidAt: new Date().toISOString() }
        );
        console.log('[stripe] checkout.session.completed', session.id);

        const emailSession = session.customer_email;
        const productKeySession = session.metadata?.productKey;
        console.log('[DEBUG] session email:', emailSession, '| productKey:', productKeySession);

        if (emailSession && productKeySession) {
          try {
            await sendDownloadEmail(emailSession, productKeySession);
          } catch (mailErr) {
            console.error('[ERROR] sendDownloadEmail failed for checkout.session.completed:', mailErr && mailErr.message);
          }
        } else {
          console.warn('[WARN] Missing email or productKey in session metadata');
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

        const emailPi = pi.receipt_email || pi.metadata?.email;
        const productKeyPi = pi.metadata?.productKey;
        console.log('[DEBUG] pi.receipt_email:', pi.receipt_email, '| pi.metadata:', JSON.stringify(pi.metadata));

        if (emailPi && productKeyPi) {
          try {
            await sendDownloadEmail(emailPi, productKeyPi);
          } catch (mailErr) {
            console.error('[ERROR] sendDownloadEmail failed for payment_intent.succeeded:', mailErr && mailErr.message);
          }
        } else {
          console.warn('[WARN] Missing email or productKey in payment_intent metadata. emailPi=', emailPi, 'productKeyPi=', productKeyPi);
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
        console.log('[stripe] unhandled event:', event.type);
    }
  } catch (err) {
    console.error('[ERROR] webhook processing failed:', err && err.message, err && err.stack);
  }
}

// Webhook router (compatibilité - non monté dans server.js actuellement,
// conservé pour ne pas casser d'éventuels imports existants)
webhookRouter.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

module.exports = { router, webhookRouter, handleWebhook };
