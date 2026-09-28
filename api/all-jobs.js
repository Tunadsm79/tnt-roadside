// Returns jobs for the admin/tech list views. Two modes, merged into one
// file on 2026-09-26 to stay under Vercel Hobby's 12-serverless-function
// cap (this project was sitting at exactly 12; adding the new chat
// endpoints separately would have pushed it to 14 and broken every
// deploy -- see the messages.js merge for the other half of that fix).
//
// Default (no query, or ?scope=all): EVERY job regardless of status --
// active, completed, and cancelled together -- for admin.html's
// dashboard. Capped at the most recent 500.
//
// ?scope=history: completed jobs only, for tech.html's "Completed Jobs"
// view (which also sums a running total client-side). Capped at 200 and
// returns fewer columns -- this is deliberately the same shape
// job-history.js used to return, so tech.html didn't need any changes
// beyond the URL.
//
// Same service-role-key pattern as every other job endpoint in this
// project -- see complete-job.js's comment for the full reasoning. Keeps
// `jobs`/`customers` unreadable by the public anon key; no new RLS/GRANT
// changes needed.
const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { signToken, verifyPin, requireRole, ALLOWED_ORIGIN } = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Step 2 addition (see claude/TNT-Roadside-Security-Architecture-Plan.md):
  // admin login. admin.html never POSTs here today -- it only GETs job
  // lists -- so this branch is unreachable by anything currently deployed
  // and changes no existing behavior. Folded into this file rather than a
  // new one to stay under Vercel's 12-function cap, same reasoning as the
  // file's own header comment about the 2026-09-26 merge.
  if (req.method === 'POST') {
    try {
      const { pin } = req.body || {};
      if (!verifyPin(pin, process.env.ADMIN_PIN_HASH)) {
        res.status(401).json({ error: 'Invalid PIN' });
        return;
      }
      const token = signToken({ role: 'admin' });
      res.status(200).json({ token });
    } catch (err) {
      console.error('all-jobs admin-login error:', err);
      res.status(500).json({ error: 'Could not log in' });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Step 8 of the security plan: REAL enforcement (Step 8 of the session's
  // rollout). Only reached for the GET path above (job lists) -- the
  // POST/login branch already returned above, since a login call is what
  // establishes the token in the first place and by definition has none
  // yet. Only ever called (GET) by tech.html and admin.html, both of
  // which already send a real token on this call. No customer-facing
  // caller exists for this endpoint.
  const auth = requireRole('all-jobs (GET)', req, res, ['tech', 'admin']);
  if (!auth) return;

  try {
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    const isHistory = req.query && req.query.scope === 'history';

    const url = isHistory
      ? `${SUPABASE_URL}/rest/v1/jobs` +
        `?status=eq.completed` +
        `&select=id,service_type,price,completed_at,customers(name,phone)` +
        `&order=completed_at.desc` +
        `&limit=200`
      : `${SUPABASE_URL}/rest/v1/jobs` +
        // technician_id added 2026-09-26 so admin.html's job-detail panel
        // can show who's currently assigned (needed for the Cancel/
        // Reassign controls added there the same day).
        `?select=id,service_type,price,status,payment_status,created_at,accepted_at,completed_at,customer_address,technician_id,distance_miles,eta_minutes,customers(name,phone)` +
        `&order=created_at.desc` +
        `&limit=500`;

    const response = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : [];
    if (!response.ok) {
      throw new Error(`Supabase jobs query failed: ${response.status} ${text}`);
    }

    res.status(200).json({ jobs: data });
  } catch (err) {
    console.error('all-jobs error:', err);
    res.status(500).json({ error: 'Could not load jobs' });
  }
};
