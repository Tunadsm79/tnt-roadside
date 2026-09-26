// Returns every ON-DUTY technician (id, name, live position, whether
// they're already on a job, and now -- as of the 2026-09-26 ETA-realism
// pass -- how many minutes of work they likely have left on their
// current job(s)) for index.html's dispatch routing logic and, now, its
// pre-payment ETA estimate too.
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

// Default on-site service time per job type, in minutes. Used to
// estimate how much longer a busy technician needs on their CURRENT
// job(s) before they could realistically head to a new one.
//
// Honest limitation, not a bug: the `jobs` table has no timestamp for
// when a job entered its current status (no `en_route_at`/`arrived_at`
// column), only `created_at`/`completed_at`. So this can't discount
// for time already spent in the current status -- a job that's 2
// minutes into "arrived" and one that's 14 minutes in both count as
// the full default duration remaining. That's a deliberate
// simplification, not a silent guess: worth adding real per-status
// timestamps later if the estimate needs to get tighter.
const DEFAULT_SERVICE_MINUTES = {
  dead_battery: 10,
  fuel_delivery: 10,
  lockout: 15,
  flat_tire: 20
};
const FALLBACK_SERVICE_MINUTES = 15; // any future/unrecognized service_type

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
      // `service_type` added (2026-09-26) so remaining-time-on-current-
      // job can be estimated per the default-duration table above --
      // previously this query only selected technician_id.
      fetch(
        `${SUPABASE_URL}/rest/v1/jobs?select=technician_id,service_type&status=in.(dispatched,en_route,arrived)&technician_id=not.is.null`,
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

    // Sum default duration across every non-terminal job a technician
    // currently has (a tech can legitimately have more than one queued
    // up -- stacking is allowed, see the project doc's dispatch-routing
    // decision) rather than just counting one.
    const remainingMinutesByTech = new Map();
    for (const job of busyJobs) {
      const minutes = DEFAULT_SERVICE_MINUTES[job.service_type] ?? FALLBACK_SERVICE_MINUTES;
      remainingMinutesByTech.set(
        job.technician_id,
        (remainingMinutesByTech.get(job.technician_id) || 0) + minutes
      );
    }

    const result = technicians.map(t => {
      const remaining_minutes = remainingMinutesByTech.get(t.id) || 0;
      return {
        id: t.id,
        name: t.name,
        current_lat: t.current_lat,
        current_lng: t.current_lng,
        location_updated_at: t.location_updated_at,
        busy: remaining_minutes > 0,
        remaining_minutes
      };
    });

    res.status(200).json({ technicians: result });
  } catch (err) {
    console.error('available-technicians error:', err);
    res.status(500).json({ error: 'Could not load available technicians' });
  }
};
