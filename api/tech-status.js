// Read-only: returns every technician row (name, on-duty flag, last known
// position, when it was last updated) for admin.html's on-duty/live-map
// section. Same service-role-key pattern as all-jobs.js -- keeps
// `technicians` off the public anon key's read surface, consistent with
// how this project treats `jobs`/`customers` (see the RLS + GRANT notes
// in the project doc).
const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

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

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/technicians?select=name,on_duty,current_lat,current_lng,location_updated_at&order=name.asc`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        }
      }
    );
    const text = await response.text();
    const data = text ? JSON.parse(text) : [];
    if (!response.ok) {
      throw new Error(`Supabase technicians fetch failed: ${response.status} ${text}`);
    }

    res.status(200).json({ technicians: data || [] });
  } catch (err) {
    console.error('tech-status error:', err);
    res.status(500).json({ error: 'Could not load technician status' });
  }
};
