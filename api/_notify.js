// Best-effort SMS notifications via Twilio's REST API (plain fetch, no
// SDK -- keeps this consistent with the rest of this project's "no
// framework" serverless functions). Used by the job-status endpoints
// (accept/en-route/arrived/complete/cancel) to text the customer and
// text admin (Demian) whenever a job's status changes -- before this,
// neither side got any notification beyond whatever was actively open
// on screen at that moment (the customer's tracking page polling, or
// admin manually refreshing admin.html).
//
// The underscore prefix on this filename is deliberate -- Vercel's
// zero-config /api routing skips any file/folder starting with "_", so
// this is a shared helper module, not its own callable endpoint, same
// idea as a lib file.
//
// Deliberately does nothing (silently, logs only) until
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are all
// set as Vercel env vars -- a missing/incomplete Twilio setup must never
// break the actual job-status update it's attached to. To turn this on:
// 1. Sign up for Twilio (twilio.com), verify your own phone, buy a
//    Twilio phone number (a few dollars/month, real texts are a fraction
//    of a cent each in the US).
// 2. In Vercel -> this project -> Settings -> Environment Variables, add:
//    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (the
//    Twilio number you bought, e.g. +12285551234), and
//    ADMIN_PHONE_NUMBER (your own cell, e.g. +12285559999).
// 3. Redeploy (env vars only apply to deployments built after they're
//    added -- see the Vercel env var gotcha noted elsewhere in this
//    project). Nothing else needs to change; every job-status endpoint
//    already calls this.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER;

async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.log('SMS skipped (Twilio not configured yet) -- would have sent:', to, body);
    return;
  }
  if (!to) {
    console.log('SMS skipped (no recipient number on file):', body);
    return;
  }
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body });
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      }
    );
    if (!response.ok) {
      const text = await response.text();
      console.error('Twilio SMS failed:', response.status, text);
    }
  } catch (err) {
    // Never let a notification failure break the actual job-status
    // update it's attached to -- every caller in api/ awaits this
    // without its own try/catch on the assumption this never throws.
    console.error('Twilio SMS error:', err);
  }
}

const SERVICE_LABELS = {
  flat_tire: 'flat tire',
  dead_battery: 'dead battery',
  lockout: 'lockout',
  fuel_delivery: 'fuel delivery'
};

function serviceLabel(serviceType) {
  return SERVICE_LABELS[serviceType] || serviceType || 'job';
}

// job is {service_type, ...}; customer is {name, phone} or null/undefined
// (the nested object PostgREST returns from a `customers(name,phone)`
// select embed -- see any of the job-status endpoints for the query).
async function notifyStatusChange(event, job, customer) {
  const label = serviceLabel(job && job.service_type);
  const custName = (customer && customer.name) || 'Customer';

  const customerMessages = {
    dispatched: `T&T Roadside: your ${label} request has been accepted -- a tech is getting ready to head your way.`,
    en_route: `T&T Roadside: your tech is on the way for your ${label}!`,
    arrived: `T&T Roadside: your tech has arrived.`,
    completed: `T&T Roadside: job complete. Thanks for choosing us!`,
    cancelled: `T&T Roadside: your ${label} job has been cancelled. Your card was not charged.`
  };
  const adminMessages = {
    dispatched: `${custName}'s ${label} job was accepted by a tech.`,
    en_route: `${custName}'s ${label} job is now en route.`,
    arrived: `${custName}'s ${label} job: tech has arrived on site.`,
    completed: `${custName}'s ${label} job completed.`,
    cancelled: `${custName}'s ${label} job was cancelled.`
  };

  const tasks = [];
  if (customer && customer.phone && customerMessages[event]) {
    tasks.push(sendSms(customer.phone, customerMessages[event]));
  }
  if (ADMIN_PHONE_NUMBER && adminMessages[event]) {
    tasks.push(sendSms(ADMIN_PHONE_NUMBER, adminMessages[event]));
  }
  await Promise.all(tasks);
}

module.exports = { sendSms, notifyStatusChange };
