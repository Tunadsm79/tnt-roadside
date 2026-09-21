const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Captures a previously-authorized PaymentIntent -- this is the step that
// actually charges the card. Not yet called from anywhere in the app;
// intended for a future "mark job complete" action.
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
    const { payment_intent_id, amount_to_capture } = req.body || {};
    if (!payment_intent_id) {
      res.status(400).json({ error: 'Missing payment_intent_id' });
      return;
    }

    const captureParams = {};
    if (amount_to_capture) {
      captureParams.amount_to_capture = Math.round(Number(amount_to_capture));
    }

    const paymentIntent = await stripe.paymentIntents.capture(payment_intent_id, captureParams);

    res.status(200).json({
      status: paymentIntent.status,
      amountCaptured: paymentIntent.amount_received
    });
  } catch (err) {
    console.error('capture-payment error:', err);
    res.status(500).json({ error: 'Could not capture payment' });
  }
};
