// Customer <-> tech chat thread. Merged GET (list) + POST (send) into one
// file on 2026-09-26 -- originally two separate files (job-messages.js,
// send-message.js), combined to stay under Vercel Hobby's 12-serverless-
// function cap (see all-jobs.js's comment for the other half of this
// fix). Behavior is otherwise unchanged from the original two files.
//
// GET  /api/messages?job_id=... -> { messages: [...] }, oldest first.
//      Polled every 15s by index.html's tracking screen and every 10s by
//      tech.html's job detail view (same cadence each page already polls
//      at for other things), and by admin.html's job-detail panel.
// POST /api/messages { job_id, body } -> writes one message.
//
// Same service-role-key approach as every other job endpoint in this
// project -- the `messages` table has RLS on with zero anon policies, so
// this is the only way either side's message ever reaches the database.
//
// 2026-09-28 (T&T Dispatch chat / sender-authentication fix): POST used
// to also accept a client-supplied `sender` field, trusting it as long
// as it was 'customer' or 'tech' -- meaning a customer's own job token
// could POST { sender: 'tech', ... } and it would insert (and render)
// as a technician message, and vice versa. requireJobAccess() below
// only ever checked that the job_id belonged to the caller, never that
// the caller WAS who `sender` claimed. Fixed by deriving `sender`
// entirely from the verified token claims requireJobAccess() returns,
// below -- the request body's `sender` field (if a caller still sends
// one) is no longer read at all. This is also what makes T&T Dispatch
// possible as a third participant: an admin-role token derives to
// 'dispatch', which was previously not a reachable value at all (the
// old code's allowlist was only 'customer'/'tech').
const { requireJobAccess, ALLOWED_ORIGIN } = require('./_auth');

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

// Derives the ONLY sender value this message can legitimately be
// stored as, from the verified token claims -- never from anything
// the client sent. `auth` is whatever requireJobAccess() returned:
// { role: 'admin', ... }, { role: 'tech', tech_name, ... }, or
// { job_id, ... } with no role at all for a customer's job token.
// requireJobAccess() has already confirmed a customer's token's
// job_id matches the job being posted to, so by the time this runs,
// any of the three outcomes below is a caller who is genuinely
// allowed to post into THIS job's conversation as THAT identity --
// there's nothing left for the client to spoof.
function deriveSender(auth) {
  if (auth.role === 'admin') return 'dispatch';
  if (auth.role === 'tech') return 'tech';
  return 'customer';
}

async function handlePost(req, res, auth) {
  const { job_id, body } = req.body || {};

  if (!job_id) {
    res.status(400).json({ error: 'Missing job_id' });
    return;
  }
  const sender = deriveSender(auth);
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
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
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

  // Step 10 of the security plan (last endpoint in the original plan):
  // REAL enforcement, via requireJobAccess() instead of requireRole()
  // like every other endpoint -- this is the one file two different
  // kinds of caller legitimately hit. A tech/admin role token works
  // here same as anywhere else; a customer's job token (now stored and
  // sent by index.html as of the same change that added this check)
  // only ever grants access to the one job_id it was minted for. The
  // job_id itself lives in a different place depending on method (query
  // string on GET, body on POST), so it's pulled out before the auth
  // check runs, rather than inside handleGet/handlePost as before.
  const jobId = req.method === 'GET'
    ? (req.query && req.query.job_id)
    : (req.body && req.body.job_id);

  const auth = requireJobAccess('messages', req, res, jobId);
  if (!auth) return;

  try {
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    if (req.method === 'GET') {
      await handleGet(req, res);
    } else {
      await handlePost(req, res, auth);
    }
  } catch (err) {
    console.error('messages error:', err);
    res.status(500).json({ error: 'Could not process message request' });
  }
};
