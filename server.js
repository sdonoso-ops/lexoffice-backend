/**
 * LexOffice — Backend API
 * Node.js + Express + Flow.cl
 * 
 * Endpoints:
 *   POST /api/payment/create          → Cobro único (servicios legales)
 *   POST /api/subscription/create     → Suscripción mensual (oficina virtual)
 *   POST /api/payment/confirm         → Webhook Flow (pago único confirmado)
 *   POST /api/subscription/callback   → Webhook Flow (eventos de suscripción)
 *   GET  /api/payment/status/:token   → Consulta estado de pago
 *   POST /api/quote/request           → Solicitud de cotización
 *   GET  /confirmacion                → Redirect post-pago
 */

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const path     = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CORS ─────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST']
}));

// ─── CONFIG ────────────────────────────────────────────────────
const IS_PROD     = process.env.NODE_ENV === 'production';
const FLOW_BASE = process.env.FLOW_SANDBOX === 'true' ? 'https://sandbox.flow.cl/api' : 'https://www.flow.cl/api';
const FLOW_KEY    = process.env.FLOW_API_KEY;
const FLOW_SECRET = process.env.FLOW_SECRET;
const BASE_URL    = process.env.BASE_URL || 'http://localhost:3001';
const PORT        = process.env.PORT || 3001;

// ─── FLOW SIGNATURE ────────────────────────────────────────────
/**
 * Flow requires all params to be sorted alphabetically, then
 * concatenated as key+value (no separator), and signed with HMAC-SHA256.
 * The signature is added as param 's'.
 */
function flowSign(params) {
  // Remove undefined/null values
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
  
  // Sort alphabetically
  const sorted = Object.keys(clean).sort().reduce((obj, key) => {
    obj[key] = clean[key];
    return obj;
  }, {});

  // Build string to sign: key1value1key2value2...
  const toSign = Object.entries(sorted).map(([k, v]) => `${k}${v}`).join('');

  // HMAC-SHA256
  const sig = crypto.createHmac('sha256', FLOW_SECRET).update(toSign).digest('hex');
  return { ...sorted, s: sig };
}

/**
 * Perform a Flow API call (POST with form-urlencoded or GET with query string)
 */
async function flowRequest(endpoint, params, method = 'POST') {
  const signed   = flowSign(params);
  const formData = new URLSearchParams(signed);

  let url = `${FLOW_BASE}${endpoint}`;
  const options = { method };

  if (method === 'GET') {
    url += '?' + formData.toString();
  } else {
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    options.body    = formData;
  }

  const res  = await fetch(url, options);
  const json = await res.json();
  return json;
}

// ─── GENERATE ORDER ID ──────────────────────────────────────────
function orderId(prefix = 'ORD') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
}

// ─── PLAN MAP (Oficina Virtual) ─────────────────────────────────
// These planId values must be created once in your Flow account.
// The server will auto-create them if they don't exist.
const PLANS = {
  'Plan Esencial':    { id: 'LEXOFFICE_ESENCIAL',    amount: 15990, currency: 'CLP' },
  'Plan Profesional': { id: 'LEXOFFICE_PROFESIONAL',  amount: 29990, currency: 'CLP' },
  'Plan Executive':   { id: 'LEXOFFICE_EXECUTIVE',    amount: 59990, currency: 'CLP' },
};

// ─────────────────────────────────────────────────────────────────
//  1. PAGO ÚNICO — Servicios Legales
// ─────────────────────────────────────────────────────────────────
app.post('/api/payment/create', async (req, res) => {
  try {
    const { subject, amount, email, name, rut, phone } = req.body;

    if (!subject || !amount || !email) {
      return res.status(400).json({ error: 'Faltan campos requeridos: subject, amount, email' });
    }

    const oid = orderId('ORD');

    const params = {
      apiKey:         FLOW_KEY,
      subject:        subject,
      commerceOrder:  oid,
      amount:         Math.round(amount),   // CLP must be integer
      email:          email,
      currency:       'CLP',
      paymentMethod:  9,                    // 9 = all methods (cards + transfer)
      urlConfirmation: `${BASE_URL}/api/payment/confirm`,
      urlReturn:       `${BASE_URL}/confirmacion?order=${oid}`,
      // Store extra info (optional, max 255 chars)
      optional: JSON.stringify({ name, rut: rut?.slice(0,15), phone })
    };

    const data = await flowRequest('/payment/create', params);

    if (data.url && data.token) {
      // Log the order (in production: save to DB here)
      console.log(`[PAYMENT] Created: ${oid} | ${subject} | $${amount} | ${email}`);
      return res.json({ url: `${data.url}?token=${data.token}`, orderId: oid });
    }

    console.error('[PAYMENT] Flow error:', data);
    return res.status(400).json({ error: data.message || 'Flow rechazó el pago' });

  } catch (err) {
    console.error('[PAYMENT] Error:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  2. SUSCRIPCIÓN MENSUAL — Oficina Virtual
// ─────────────────────────────────────────────────────────────────
app.post('/api/subscription/create', async (req, res) => {
  try {
    const { subject, amount, email, name, rut, phone } = req.body;

    if (!subject || !email) {
      return res.status(400).json({ error: 'Faltan campos requeridos: subject, email' });
    }

    const plan  = PLANS[subject] || { id: `LEXOFFICE_CUSTOM_${amount}`, amount, currency: 'CLP' };
    const subId = orderId('SUB');
    const custId = rut ? 'CUST_' + rut.replace(/[^0-9kK]/gi, '').slice(0, 15) : `CUST_${Date.now()}`;

    // Step 1 — Ensure plan exists in Flow
    await ensurePlan(plan, subject);

    // Step 2 — Create customer in Flow, get Flow-generated customerId
    const flowCustomerId = await ensureCustomer({ email, name });
    if (!flowCustomerId) {
      return res.status(500).json({ error: 'No se pudo crear el cliente en Flow' });
    }

    // Step 3 — Create subscription using Flow customerId
    const params = {
      apiKey:          FLOW_KEY,
      planId:          plan.id,
      customerId:      flowCustomerId,
      subscriptionId:  subId,
      email:           email,
      urlConfirmation: `${BASE_URL}/api/subscription/callback`,
      urlReturn:       `${BASE_URL}/confirmacion?sub=${subId}`,
    };

    const data = await flowRequest('/subscription/create', params);

    if (data.url && data.token) {
      console.log(`[SUBSCRIPTION] Created: ${subId} | ${subject} | ${email}`);
      return res.json({ url: `${data.url}?token=${data.token}`, subscriptionId: subId });
    }

    // Flow may return a direct subscription without redirect (already subscribed)
    if (data.subscriptionId || data.status) {
      console.log(`[SUBSCRIPTION] Direct: ${subId} | ${subject} | ${email}`);
      return res.json({ url: `${BASE_URL}/confirmacion?sub=${subId}`, subscriptionId: subId });
    }

    console.error('[SUBSCRIPTION] Flow error:', data);
    return res.status(400).json({ error: data.message || 'Flow rechazó la suscripción' });

  } catch (err) {
    console.error('[SUBSCRIPTION] Error:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

async function ensureCustomer({ email, name }) {
  // Step A — try to create customer
  try {
    const params = {
      apiKey: FLOW_KEY,
      email:  email,
      name:   name || email,
    };
    const result = await flowRequest('/customer/create', params);
    console.log(`[CUSTOMER] Raw response:`, JSON.stringify(result));

    if (result.customerId) {
      console.log(`[CUSTOMER] Created: ${result.customerId}`);
      return result.customerId;
    }

    // Flow may return customerId inside different fields
    if (result.id) return result.id;

    // If customer already exists Flow returns an error code — try to get by email
    console.log(`[CUSTOMER] Create failed, trying to get existing...`);
    return await getCustomerByEmail(email);

  } catch (e) {
    console.log(`[CUSTOMER] Create exception: ${e.message}`);
    return await getCustomerByEmail(email);
  }
}

async function getCustomerByEmail(email) {
  try {
    const params = { apiKey: FLOW_KEY, filter: email, start: 0, limit: 1 };
    const result = await flowRequest('/customer/list', params, 'GET');
    console.log(`[CUSTOMER] List response:`, JSON.stringify(result));

    if (result.data && result.data.length > 0) {
      const custId = result.data[0].customerId;
      console.log(`[CUSTOMER] Found existing: ${custId}`);
      return custId;
    }
    console.log(`[CUSTOMER] Not found in list either`);
    return null;
  } catch (e) {
    console.log(`[CUSTOMER] List exception: ${e.message}`);
    return null;
  }
}

async function ensurePlan(plan, name) {
  try {
    const params = {
      apiKey:             FLOW_KEY,
      planId:             plan.id,
      name:               name,
      amount:             plan.amount,
      currency:           plan.currency || 'CLP',
      interval:           2,   // 1=day 2=month 3=year
      interval_count:     1,
      trial_period_days:  0,
      urlCallback:        `${BASE_URL}/api/subscription/callback`
    };
    await flowRequest('/plans/create', params);
    console.log(`[PLAN] Ensured: ${plan.id}`);
  } catch (e) {
    // If plan already exists Flow returns an error — we ignore it
    console.log(`[PLAN] Already exists or error (ok): ${plan.id}`);
  }
}

// ─────────────────────────────────────────────────────────────────
//  3. WEBHOOK — Confirmación de pago único
// ─────────────────────────────────────────────────────────────────
app.post('/api/payment/confirm', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token requerido' });

    // Query Flow for real payment status
    const payment = await flowRequest('/payment/getStatus', { apiKey: FLOW_KEY, token }, 'GET');

    console.log(`[WEBHOOK] Payment status: ${payment.status} | Order: ${payment.commerceOrder} | Amount: ${payment.amount}`);

    /**
     * Flow status codes:
     *  1 = pending
     *  2 = paid ✅
     *  3 = rejected ❌
     *  4 = cancelled
     */
    if (payment.status === 2) {
      // ✅ PAYMENT CONFIRMED
      // TODO: update your database, activate service, send confirmation email
      await activateService(payment);
    }

    return res.json({ status: 'ok' });

  } catch (err) {
    console.error('[WEBHOOK] Error:', err);
    return res.status(500).json({ error: 'Webhook error' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  4. WEBHOOK — Eventos de suscripción
// ─────────────────────────────────────────────────────────────────
app.post('/api/subscription/callback', (req, res) => {
  const event = req.body;
  console.log('[SUB WEBHOOK]', JSON.stringify(event, null, 2));
  // Events: subscription.active, subscription.cancel, subscription.charge_failed, etc.
  // TODO: handle each event type in your database
  return res.json({ status: 'ok' });
});

// ─────────────────────────────────────────────────────────────────
//  5. CONSULTA DE ESTADO (útil para la página de confirmación)
// ─────────────────────────────────────────────────────────────────
app.get('/api/payment/status/:token', async (req, res) => {
  try {
    const payment = await flowRequest('/payment/getStatus', {
      apiKey: FLOW_KEY,
      token:  req.params.token
    }, 'GET');
    return res.json(payment);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando estado' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  6. SOLICITUD DE COTIZACIÓN
// ─────────────────────────────────────────────────────────────────
app.post('/api/quote/request', async (req, res) => {
  try {
    const { name, rut, email, service, description } = req.body;

    if (!name || !email || !description) {
      return res.status(400).json({ error: 'Nombre, email y descripción son requeridos' });
    }

    // Log (in production: save to DB + send email notification to team)
    console.log(`[QUOTE] New request from ${name} <${email}>`);
    console.log(`        Service: ${service}`);
    console.log(`        RUT: ${rut}`);
    console.log(`        Description: ${description.slice(0, 120)}...`);

    // TODO: Send email to hola@lexoffice.cl with the quote request
    // await sendEmail({ to: 'hola@lexoffice.cl', subject: `Nueva cotización de ${name}`, ... });

    return res.json({ status: 'received' });

  } catch (err) {
    console.error('[QUOTE] Error:', err);
    return res.status(500).json({ error: 'Error procesando cotización' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  7. REDIRECT — Post-pago de Flow → Frontend
// ─────────────────────────────────────────────────────────────────
app.get('/confirmacion', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  res.redirect(301, `${frontendUrl}/confirmacion.html?${qs}`);
});

app.post('/confirmacion', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  res.redirect(301, `${frontendUrl}/confirmacion.html?${qs}`);
});

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
async function activateService(payment) {
  /**
   * Called when a payment is confirmed by Flow.
   * Add your business logic here:
   *  - Update database record (order status → paid)
   *  - Provision virtual office (add client to your CRM/management system)
   *  - Send confirmation email with boleta
   *  - Trigger document generation for legal services
   */
  console.log(`✅ Service activated for order: ${payment.commerceOrder}`);

  // Example: send confirmation email via SendGrid / Resend
  // await sendConfirmationEmail({
  //   to:      payment.payer,
  //   service: payment.subject,
  //   amount:  payment.amount,
  //   orderId: payment.commerceOrder,
  // });
}

// ─────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 LexOffice Backend running on port ${PORT}`);
  console.log(`   Mode:      ${IS_PROD ? '🔴 PRODUCTION' : '🟡 SANDBOX'}`);
  console.log(`   Flow API:  ${FLOW_BASE}`);
  console.log(`   Base URL:  ${BASE_URL}\n`);
});
