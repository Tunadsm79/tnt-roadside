// Returns completed jobs (service type, price, completed_at, and the
// customer's name/phone) for tech.html's "Completed Jobs" view, so the
// tech can see what's been done and the frontend can sum a running total.
// Read-only, but still goes through the service-role key server-side
// rather than exposing a new SELECT policy to the anon key -- same
// reasoning as api/active-jobs.js: keeps `jobs`/`customers` unreadable by
// the anon key, doesn't require any new RLS/GRANT changes (nothing for
// Demian to run in the SQL Editor), just a new server-side lookup.
// Capped at the most recent 200 -- plenty for a single-technician
// operation for a long while; revisit if that ever stops being true.
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
      `?status=eq.completed` +
      `&select=id,service_type,price,completed_at,customers(name,phone)` +
      `&order=completed_at.desc` +
      `&limit=200`;

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
    console.error('job-history error:', err);
    res.status(500).json({ error: 'Could not load job history' });
  }
};
