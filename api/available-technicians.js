// Returns every ON-DUTY technician (id, name, live position, and whether
// they're already on a job) for index.html's dispatch routing logic --
// which on-duty tech a new job should be offered to -- and, later, for
// admin's per-technician job detail view.
//
// This replaces the old technician_locations view + `active = true`
// lookup that index.html used to use for this decision: `active` isn't
// tied to whether a tech is actually working right now (that's `on_duty`,
// set by tech-heartbeat.js at login/logout), and the old query had no
// distance or busy-status logic at all -- it just grabbed one row with
// .limit(1) and no ordering, which in practice always came back as the
// same technician (Demian) no matter who was actually on shift. See the
// project doc's "Dispatch routing fix" section for the full story.
//
// Same service-role-key pattern as tech-status.js -- keeps `technicians`
// off the public anon key's read surface.
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

    const [techResponse, jobsResponse] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/technicians?select=id,name,current_lat,current_lng,location_updated_at&on_duty=eq.true`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      ),
      // "Busy" = has a job that's been assigned and isn't finished yet.
      // Deliberately excludes 'requested' jobs -- those haven't been
      // accepted by anyone, so they shouldn't count against whichever
      // technician they happened to be suggested to at creation.
      fetch(
        `${SUPABASE_URL}/rest/v1/jobs?select=technician_id&status=in.(dispatched,en_route,arrived)&technician_id=not.is.null`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      )
    ]);

    const techText = await techResponse.text();
    const technicians = techText ? JSON.parse(techText) : [];
    if (!techResponse.ok) {
      throw new Error(`Supabase technicians fetch failed: ${techResponse.status} ${techText}`);
    }

    const jobsText = await jobsResponse.text();
    const busyJobs = jobsText ? JSON.parse(jobsText) : [];
    if (!jobsResponse.ok) {
      throw new Error(`Supabase jobs fetch failed: ${jobsResponse.status} ${jobsText}`);
    }

    const busyIds = new Set(busyJobs.map(j => j.technician_id));

    const result = technicians.map(t => ({
      id: t.id,
      name: t.name,
      current_lat: t.current_lat,
      current_lng: t.current_lng,
      location_updated_at: t.location_updated_at,
      busy: busyIds.has(t.id)
    }));

    res.status(200).json({ technicians: result });
  } catch (err) {
    console.error('available-technicians error:', err);
    res.status(500).json({ error: 'Could not load available technicians' });
  }
};
