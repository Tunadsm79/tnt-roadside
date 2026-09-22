// Called by tech.html the moment a tech logs in (on_duty: true), the
// moment they log out (on_duty: false), and on every throttled GPS tick
// while they're logged in (lat/lng). One endpoint handles all three since
// they're all just "update this technician's row" -- whichever fields are
// present in the request body get updated, nothing else.
//
// Routed through the service-role key (server-side) rather than the old
// anon-key direct-table-write pattern the single-technician version of
// this app used to use. Deliberate: with two technician rows now instead
// of one, the anon RLS policy that gated the old write is scoped to
// `active = true`, which only covers the one "dispatchable" technician
// (see complete-job.js's comment style / RLS + GRANT notes in the project
// doc for why a second row without RLS visibility would silently match
// zero rows on a WHERE-filtered UPDATE -- the exact bug class this
// project hit once before with GPS writes). Going through the service
// role sidesteps that entirely: no new RLS policy needed for Jonathan's
// row to work correctly.
const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase ${path} failed: ${response.status} ${text}`);
  }
  return data;
}

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
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    const { tech_name, on_duty, lat, lng } = req.body || {};
    if (!tech_name) {
      res.status(400).json({ error: 'Missing tech_name' });
      return;
    }

    const update = {};
    if (typeof on_duty === 'boolean') {
      update.on_duty = on_duty;
    }
    if (typeof lat === 'number' && typeof lng === 'number') {
      update.current_lat = lat;
      update.current_lng = lng;
      update.location_updated_at = new Date().toISOString();
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'Nothing to update -- pass on_duty and/or lat+lng' });
      return;
    }

    const updated = await supabaseRequest(`/technicians?name=eq.${encodeURIComponent(tech_name)}`, {
      method: 'PATCH',
      body: JSON.stringify(update)
    });

    if (!updated || updated.length === 0) {
      res.status(404).json({ error: `No technician named "${tech_name}" found` });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('tech-heartbeat error:', err);
    res.status(500).json({ error: 'Could not update technician status' });
  }
};
