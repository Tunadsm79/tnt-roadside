const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { signToken } = require('./_auth');

// Creates a Stripe PaymentIntent in manual-capture mode -- this places an
// authorization hold on the customer's card without charging it. The hold
// is captured later via api/complete-job.js (job completed, full or partial
// amount) or released via api/cancel-job.js (job cancelled, full release).
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
    const { amount, service_type, job_id } = req.body || {};

    const amountCents = Math.round(Number(amount));
    if (!amountCents || amountCents < 50) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      capture_method: 'manual',
      metadata: {
        job_id: job_id || '',
        service_type: service_type || ''
      }
    });

    // Step 2 addition (see claude/TNT-Roadside-Security-Architecture-Plan.md):
    // mint the customer's job-access token here, since this is the one
    // server round trip that already happens with job_id in hand before
    // the jobs row exists. Wrapped in its own try/catch so a token-minting
    // problem (e.g. TNT_AUTH_SECRET briefly unset) never breaks the actual
    // payment authorization -- jobToken just comes back null and the
    // existing flow proceeds exactly as it does today. index.html doesn't
    // read this field yet, so adding it changes nothing about current
    // behavior.
    let jobToken = null;
    if (job_id) {
      try {
        jobToken = signToken({ job_id });
      } catch (tokenErr) {
        console.error('create-payment-intent token-mint error:', tokenErr);
      }
    }

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      jobToken
    });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(500).json({ error: 'Could not create payment intent' });
  }
};
