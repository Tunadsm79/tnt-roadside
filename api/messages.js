// Customer <-> tech chat thread. Merged GET (list) + POST (send) into one
// file on 2026-09-26 -- originally two separate files (job-messages.js,
// send-message.js), combined to stay under Vercel Hobby's 12-serverless-
// function cap (see all-jobs.js's comment for the other half of this
// fix). Behavior is otherwise unchanged from the original two files.
//
// GET  /api/messages?job_id=... -> { messages: [...] }, oldest first.
//      Polled every 15s by index.html's tracking screen and every 10s by
//      tech.html's job detail view (same cadence each page already polls
//      at for other things).
// POST /api/messages { job_id, sender, body } -> writes one message.
//
// Same service-role-key approach as every other job endpoint in this
// project -- the `messages` table has RLS on with zero anon policies, so
// this is the only way either side's message ever reaches the database.
// Deliberately no auth beyond "you know the job_id" (a random UUID, not
// guessable) -- same security bar as the rest of this app (see project
// docs), not meant to survive a determined attacker, just keep casual
// snooping out.
const { logTokenCheck } = require('./_auth');

const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_BODY_LENGTH = 500;

async function handleGet(req, res) {
  const jobId = req.query && req.query.job_id;
  if (!jobId) {
    res.status(400).json({ error: 'Missing job_id' });
    return;
  }

  const url = `${SUPABASE_URL}/rest/v1/messages` +
    `?job_id=eq.${jobId}` +
    `&select=id,sender,body,created_at` +
    `&order=created_at.asc`;

  const response = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`Supabase messages query failed: ${response.status} ${text}`);
  }

  res.status(200).json({ messages: data });
}

async function handlePost(req, res) {
  const { job_id, sender, body } = req.body || {};

  if (!job_id) {
    res.status(400).json({ error: 'Missing job_id' });
    return;
  }
  if (sender !== 'customer' && sender !== 'tech') {
    res.status(400).json({ error: "sender must be 'customer' or 'tech'" });
    return;
  }
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) {
    res.status(400).json({ error: 'Message is empty' });
    return;
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    res.status(400).json({ error: `Message is too long (max ${MAX_BODY_LENGTH} characters)` });
    return;
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({ job_id, sender, body: trimmed })
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase insert failed: ${response.status} ${text}`);
  }

  res.status(200).json({ message: data && data[0] });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Step 4 of the security plan: log-only, never changes the response.
  // A customer's calls here still won't carry any token at all -- the
  // customer job token exists (minted in create-payment-intent.js since
  // Step 2) but index.html was never wired up to store or send it (that
  // remains a separate, not-yet-done item -- see "WHAT MUST CHANGE" in
  // the plan doc). So logs from this endpoint will show a real token on
  // tech/admin calls and "no token" on customer calls until that's done.
  logTokenCheck('messages', req);

  try {
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    if (req.method === 'GET') {
      await handleGet(req, res);
    } else {
      await handlePost(req, res);
    }
  } catch (err) {
    console.error('messages error:', err);
    res.status(500).json({ error: 'Could not process message request' });
  }
};
