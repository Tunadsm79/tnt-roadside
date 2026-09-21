// Marks a job cancelled: releases the Stripe authorization hold (no
// charge happens) and updates the job + payment records to match. Called
// from tech.html's "Cancel Job" button. Same service-role-key approach as
// complete-job.js -- see that file's comment for why.
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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

    const { job_id } = req.body || {};
    if (!job_id) {
      res.status(400).json({ error: 'Missing job_id' });
      return;
    }

    const jobs = await supabaseRequest(`/jobs?id=eq.${job_id}&select=id,status`);
    const job = jobs && jobs[0];
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'completed' || job.status === 'cancelled') {
      res.status(400).json({ error: `Job is already ${job.status}` });
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

    res.status(200).json({ status: intent.status });
  } catch (err) {
    console.error('cancel-job error:', err);
    res.status(500).json({ error: 'Could not cancel job' });
  }
};
