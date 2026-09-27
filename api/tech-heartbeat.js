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
const { signToken, verifyPin, requireRole } = require('./_auth');

// Step 2 of the security plan (claude/TNT-Roadside-Security-Architecture-Plan.md):
// the technician roster and where each one's PIN hash lives. Two technicians
// today -- add a line here (and the matching TECH_PIN_HASH_<NAME> env var in
// Vercel) if a third one ever joins.
const TECH_PIN_HASHES = {
  Demian: process.env.TECH_PIN_HASH_DEMIAN,
  Jonathan: process.env.TECH_PIN_HASH_JONATHAN
};

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Step 2 addition: a login call. Distinguished from every existing
    // heartbeat/on-duty/GPS call by carrying a `pin` field instead of a
    // `tech_name` -- today's tech.html never sends `pin`, so this branch
    // is unreachable by anything currently deployed and changes no
    // existing behavior. It exists so a later step (plan step 5) can
    // switch tech.html to send the PIN here instead of resolving the
    // technician's name from the client-side TECH_PINS table.
    if (req.body && req.body.pin) {
      const { pin } = req.body;
      let matchedName = null;
      for (const [name, hash] of Object.entries(TECH_PIN_HASHES)) {
        if (verifyPin(pin, hash)) {
          matchedName = name;
          break;
        }
      }
      if (!matchedName) {
        res.status(401).json({ error: 'Invalid PIN' });
        return;
      }
      const token = signToken({ role: 'tech', tech_name: matchedName });
      res.status(200).json({ token, tech_name: matchedName });
      return;
    }

    // Step 7 of the security plan: REAL enforcement (Step 7 of the
    // session's rollout). Deliberately placed after the login branch
    // above -- and its own early `return` -- so a PIN-login call, which
    // by definition has no token yet, is completely unaffected: this
    // line is only ever reached by an actual duty/GPS-update call, which
    // tech.html and admin.html both already attach a real token to (see
    // setDutyStatus()/pushLocation() in tech.html, the On Duty override
    // in admin.html). Same authorization model as complete-job.js and
    // cancel-job.js: any valid tech or admin token, no ownership check.
    const auth = requireRole('tech-heartbeat', req, res, ['tech', 'admin']);
    if (!auth) return;

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
