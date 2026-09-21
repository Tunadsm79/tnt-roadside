const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Cancels (releases) a previously-authorized PaymentIntent that was never
// captured -- this is the step for a cancelled/no-show job. Not yet
// called from anywhere in the app; intended for a future "cancel job"
// action.
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
    const { payment_intent_id } = req.body || {};
    if (!payment_intent_id) {
      res.status(400).json({ error: 'Missing payment_intent_id' });
      return;
    }

    const paymentIntent = await stripe.paymentIntents.cancel(payment_intent_id, {
      cancellation_reason: 'requested_by_customer'
    });

    res.status(200).json({ status: paymentIntent.status });
  } catch (err) {
    console.error('release-payment error:', err);
    res.status(500).json({ error: 'Could not release payment' });
  }
};
