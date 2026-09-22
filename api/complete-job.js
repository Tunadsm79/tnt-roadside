// Marks a job complete: captures the Stripe authorization hold (this is
// the step that actually charges the customer's card) and updates the
// job + payment records to match. Called from tech.html's "Complete Job"
// button. Also texts the customer and admin (see api/_notify.js --
// no-ops until Twilio env vars are set).
//
// Only allowed once the job is marked 'arrived' -- the tech has to
// actually be on location (see arrived-job.js) before the card can be
// charged. This used to allow completing from any non-terminal status;
// tightened so a job can't be captured before the tech is on site.
//
// Uses the Supabase SERVICE ROLE key (server-side only, never sent to the
// browser) instead of the public anon key, because this function needs to
// read the jobs/payments tables and write to them directly -- neither is
// readable/writable by the public anon key on purpose (keeps customer and
// payment data from being exposed through the key that's sitting in plain
// text in index.html/tech.html's source).
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { notifyStatusChange } = require('./_notify');

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    const { job_id, final_amount_cents } = req.body || {};
    if (!job_id) {
      res.status(400).json({ error: 'Missing job_id' });
      return;
    }
    // Only present for after-hours jobs -- the tech enters real hours
    // worked in tech.html, which computes this. Flat-rate jobs omit it
    // entirely and just capture the full original hold, same as before.
    if (final_amount_cents != null && (!Number.isInteger(final_amount_cents) || final_amount_cents <= 0)) {
      res.status(400).json({ error: 'final_amount_cents must be a positive integer' });
      return;
    }

    const jobs = await supabaseRequest(`/jobs?id=eq.${job_id}&select=id,status,service_type,customers(name,phone)`);
    const job = jobs && jobs[0];
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status !== 'arrived') {
      res.status(400).json({ error: `Job is ${job.status} -- mark it arrived before completing it` });
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

    const captureOptions = final_amount_cents != null ? { amount_to_capture: final_amount_cents } : undefined;
    const intent = await stripe.paymentIntents.capture(payment.stripe_payment_intent_id, captureOptions);

    const now = new Date().toISOString();
    const jobUpdate = { status: 'completed', payment_status: 'captured', completed_at: now };
    // For after-hours jobs, jobs.price started out null (no flat price --
    // see showPrice() in index.html). Now that we know what actually got
    // captured, record the real final price instead of leaving it null.
    if (final_amount_cents != null) {
      jobUpdate.price = intent.amount_received / 100;
    }
    await supabaseRequest(`/jobs?id=eq.${job_id}`, {
      method: 'PATCH',
      body: JSON.stringify(jobUpdate)
    });
    await supabaseRequest(`/payments?job_id=eq.${job_id}`, {
      method: 'PATCH',
      // amount started out as the authorized hold (the full after-hours
      // ceiling, for an after-hours job); now that the card's actually
      // been charged, record what really moved instead.
      body: JSON.stringify({ status: 'captured', captured_at: now, amount: intent.amount_received / 100 })
    });

    await notifyStatusChange('completed', job, job.customers);

    res.status(200).json({ status: intent.status, amountCaptured: intent.amount_received });
  } catch (err) {
    console.error('complete-job error:', err);
    if (err.code === 'amount_too_large' || /amount_to_capture/i.test(err.message || '')) {
      res.status(400).json({
        error: 'That amount is more than the original hold on this card -- the job ran ' +
          'longer than the pre-authorized limit. Contact the customer to arrange payment ' +
          'for the difference; this job has NOT been marked complete.'
      });
      return;
    }
    res.status(500).json({ error: 'Could not complete job' });
  }
};
