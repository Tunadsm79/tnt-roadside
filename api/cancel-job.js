// Marks a job cancelled: releases the Stripe authorization hold (no
// charge happens) and updates the job + payment records to match.
// Callable from three places: tech.html's "Cancel Job" button, admin.html's
// "Cancel Job & Release Hold" button, and (2026-09-28) index.html's
// customer-facing "Cancel Service" flow on the tracking screen. Also texts
// the customer and admin (see api/_notify.js -- no-ops until Twilio env
// vars are set).
// Same service-role-key approach as complete-job.js -- see that file's
// comment for why.
//
// 2026-09-28 (customer cancellation): auth switched from requireRole
// (tech/admin only) to requireJobAccess, the same primitive api/messages.js
// already uses -- a tech/admin role token works exactly as before, and a
// customer's job token (minted at dispatch time in
// create-payment-intent.js, carries only { job_id }, no role) is now also
// accepted, but ONLY for the one job_id it was minted for. This isn't a
// list of allowed jobs to maintain -- it's structurally impossible for a
// customer's token to match any job_id but their own.
//
// A customer is additionally blocked from cancelling once the job reaches
// 'arrived' (see the isCustomer + status === 'arrived' check below) --
// per Demian, a technician already on site has real costs (time, fuel,
// other jobs turned down) that a silent app-side cancel doesn't account
// for. Staff (tech/admin) keep the existing broader allowance -- this is
// an operational override path, e.g. a customer calls and asks staff to
// cancel after the tech has arrived. This check is enforced here,
// server-side, not just by hiding the button in index.html -- a stale
// customer page that still thinks the job is 'dispatched' (poll hasn't
// landed yet) gets a fresh, correct rejection based on the job's actual
// current status, not what the stale page believes.
//
// Deliberately UNCHANGED in this round: the hardcoded
// cancellation_reason: 'requested_by_customer' below is sent for every
// caller (customer, tech, or admin) exactly as it was before this change
// -- per Demian, don't invent a reason code for staff cancellations that
// may not accurately describe why they cancelled. Cancellation
// attribution/metadata is a separate future improvement, not part of
// this round.
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { notifyStatusChange } = require('./_notify');
const { requireJobAccess, ALLOWED_ORIGIN } = require('./_auth');

const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase ${path} failed: ${response.status} ${text}`);
  }
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Step 7 of the security plan, extended 2026-09-28 for customer
  // cancellation (see the header comment above). job_id is pulled out
  // before the auth check, same as messages.js does, since a customer's
  // job token is only valid for the ONE job_id it names -- requireJobAccess
  // needs that value to check the match. A staff (tech/admin) token isn't
  // job_id-scoped at all, so it's authenticated the same way regardless of
  // what job_id was sent -- the explicit "missing job_id" check further
  // down still catches a genuinely absent value for either caller type.
  const { job_id } = req.body || {};
  const auth = requireJobAccess('cancel-job', req, res, job_id);
  if (!auth) return;
  // A customer's job token carries { job_id } only, no role -- see
  // requireJobAccess's own comment in _auth.js. Staff tokens always have
  // a role ('tech' or 'admin').
  const isCustomer = !auth.role;

  try {
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    if (!job_id) {
      res.status(400).json({ error: 'Missing job_id' });
      return;
    }

    const jobs = await supabaseRequest(`/jobs?id=eq.${job_id}&select=id,status,service_type,customers(name,phone)`);
    const job = jobs && jobs[0];
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'completed' || job.status === 'cancelled') {
      res.status(400).json({ error: `Job is already ${job.status}` });
      return;
    }
    // Customer-only restriction (see header comment) -- staff can still
    // cancel an 'arrived' job (the broader status guard above already
    // covers them; this check simply doesn't apply when isCustomer is
    // false). 409 Conflict: the request is well-formed and the caller is
    // authorized for this job, but the job's current state doesn't allow
    // this specific action anymore.
    if (isCustomer && job.status === 'arrived') {
      res.status(409).json({ error: 'Your technician has already arrived. Please message them if you need to cancel.' });
      return;
    }

    const payments = await supabaseRequest(
      `/payments?job_id=eq.${job_id}&select=id,stripe_payment_intent_id&order=created_at.desc&limit=1`
    );
    const payment = payments && payments[0];
    if (!payment || !payment.stripe_payment_intent_id) {
      res.status(400).json({ error: 'No payment record found for this job' });
      return;
    }

    const intent = await stripe.paymentIntents.cancel(payment.stripe_payment_intent_id, {
      cancellation_reason: 'requested_by_customer'
    });

    const now = new Date().toISOString();
    await supabaseRequest(`/jobs?id=eq.${job_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled', payment_status: 'released' })
    });
    await supabaseRequest(`/payments?job_id=eq.${job_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'released' })
    });

    await notifyStatusChange('cancelled', job, job.customers);

    res.status(200).json({ status: intent.status });
  } catch (err) {
    console.error('cancel-job error:', err);
    res.status(500).json({ error: 'Could not cancel job' });
  }
};
