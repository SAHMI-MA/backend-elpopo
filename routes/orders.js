// ============================================================================
// backend/routes/orders.js
// ----------------------------------------------------------------------------
// Tiny JSON-file order store + a small HTTP route for inspection.
// Swap saveOrder/updateOrder/loadOrders for real DB calls in production.
// ============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORDERS_FILE = path.join(__dirname, '..', 'data', 'orders.json');

function ensureFile() {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
  }
}

function loadOrders() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')) || [];
  } catch (e) {
    console.error('orders.json parse error - resetting file. Reason:', e.message);
    fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
    return [];
  }
}

function writeOrders(list) {
  ensureFile();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function saveOrder(order) {
  const list = loadOrders();
  const entry = Object.assign(
    {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
    },
    order
  );
  list.push(entry);
  writeOrders(list);
  return entry;
}

function updateOrder(matcher, patch) {
  const list = loadOrders();
  let updated = null;
  for (const o of list) {
    let hit = true;
    for (const k of Object.keys(matcher)) {
      if (o[k] !== matcher[k]) { hit = false; break; }
    }
    if (hit) {
      Object.assign(o, patch, { updatedAt: new Date().toISOString() });
      updated = o;
      break;
    }
  }
  if (updated) writeOrders(list);
  return updated;
}

function findOrder(matcher) {
  return loadOrders().find((o) => {
    for (const k of Object.keys(matcher)) {
      if (o[k] !== matcher[k]) return false;
    }
    return true;
  }) || null;
}

// ----- Route -----
const router = express.Router();

// Admin-protected summary. Requires an x-admin-token header that matches the
// ADMIN_TOKEN env var. If ADMIN_TOKEN is unset, the endpoint is disabled
// (returns 503) - this is the safe default for fresh deployments.
function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'Admin endpoint not configured. Set ADMIN_TOKEN in .env to enable.' });
  }
  const provided = req.headers['x-admin-token'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

router.get('/api/orders/summary', adminOnly, (_req, res) => {
  const list = loadOrders();
  res.json({
    total: list.length,
    paid: list.filter((o) => o.status === 'paid').length,
    pending: list.filter((o) => o.status === 'pending').length,
    failed: list.filter((o) => o.status === 'failed').length,
  });
});

module.exports = {
  router,
  saveOrder,
  updateOrder,
  findOrder,
  loadOrders,
};
