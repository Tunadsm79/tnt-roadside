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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
        `?select=id,service_type,price,status,payment_status,created_at,completed_at,customer_address,technician_id,customers(name,phone)` +
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
