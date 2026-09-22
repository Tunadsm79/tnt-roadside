// Returns EVERY job regardless of status -- active, completed, and
// cancelled all together -- for the new admin dashboard (admin.html).
// This is deliberately different from active-jobs.js (open jobs only)
// and job-history.js (completed jobs only): the admin view's whole
// point is to show the business at a glance, not just one slice of it.
//
// Same service-role-key pattern as every other job endpoint in this
// project -- see complete-job.js's comment for the full reasoning.
// Keeps `jobs`/`customers` unreadable by the public anon key; no new
// RLS/GRANT changes needed.
//
// Capped at the most recent 500 -- plenty for a single-technician
// operation for a long while; revisit if that ever stops being true
// (same note as job-history.js's 200 cap).
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

    const url = `${SUPABASE_URL}/rest/v1/jobs` +
      `?select=id,service_type,price,status,payment_status,created_at,completed_at,customer_address,customers(name,phone)` +
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
