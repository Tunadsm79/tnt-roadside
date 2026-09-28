// Two modes, selected by whether a `job_id` query param is present.
// Both are still fully unauthenticated -- this endpoint is called by
// index.html, i.e. customers who are never logged in, by design.
//
// Step 9 continuation (2026-09-28) / "Step 10" of the security plan:
// this replaces the single "return every on-duty tech's full identity
// and live GPS to anyone" shape that Steps 4-8 flagged as unfixable by
// a simple requireRole() swap. The fix isn't auth -- it's narrowing
// each mode to only what its caller actually needs, per the
// call-by-call trace done in Step 8 (see the project doc's
// "available-technicians.js: does the customer browser actually need
// raw technician identity and live GPS?" section):
//
//   - No job_id (dispatch ranking / pre-payment ETA / homepage duty
//     count) -- these three uses never read a technician's name, only
//     coordinates, busy status, and id. So this mode now omits `name`
//     and `location_updated_at` entirely.
//   - `?job_id=<uuid>` (a customer already mid-job, tracking the one
//     technician assigned to THEIR job) -- this is the only case that
//     legitimately needs a name. Scoped server-side to that one job's
//     assigned technician, not the whole on-duty roster. Same severity
//     as the existing unauthenticated `active_jobs_view` status poll
//     the security plan already accepted as fine as-is: you have to
//     already possess the job's UUID, and this returns detail about
//     that one job only, not a bulk read of everyone.
//
// No requireRole() here, and none is planned -- unlike every other
// endpoint touched in Steps 5-9, this one has a real customer-facing
// caller (index.html) that will never carry a token. logTokenCheck is
// kept purely for observability (was it ever called with staff traffic
// by mistake), not because enforcement is coming.
const { logTokenCheck } = require('./_auth');

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

async function supabaseGet(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase ${path} failed: ${response.status} ${text}`);
  }
  return data;
}

// job_id-scoped mode: who is assigned to THIS job, if anyone currently
// on duty. Mirrors the same "leave the display as-is, don't error" shape
// index.html's fetchAssignedTechnician() already expects -- not found,
// no technician assigned yet, job already over, or that technician isn't
// on duty right now all come back as `{ technician: null }`, 200, not an
// error. Same on_duty requirement the old single-list shape enforced
// implicitly (a tech who logged off simply wasn't in the array).
async function getAssignedTechnicianForJob(jobId, res) {
  const jobs = await supabaseGet(
    `/jobs?id=eq.${jobId}&select=technician_id,status`
  );
  const job = jobs && jobs[0];
  if (!job || !job.technician_id || job.status === 'completed' || job.status === 'cancelled') {
    res.status(200).json({ technician: null });
    return;
  }

  const techs = await supabaseGet(
    `/technicians?id=eq.${job.technician_id}&on_duty=eq.true&select=id,name,current_lat,current_lng,location_updated_at`
  );
  const tech = techs && techs[0];
  res.status(200).json({ technician: tech || null });
}

// No-job_id mode: the full on-duty roster, anonymized -- coordinates,
// busy status, and id only. This is the shape refineEtaForCustomer(),
// selectTechnicianForDispatch(), and refreshDutyIndicator() in
// index.html actually consume; none of the three ever reads `name` or
// `location_updated_at`, confirmed against the live code in Step 8.
async function getAnonymizedRoster(res) {
  const [technicians, busyJobs] = await Promise.all([
    supabaseGet(`/technicians?select=id,current_lat,current_lng&on_duty=eq.true`),
    // "Busy" = has a job that's been assigned and isn't finished yet.
    // Deliberately excludes 'requested' jobs -- those haven't been
    // accepted by anyone, so they shouldn't count against whichever
    // technician they happened to be suggested to at creation.
    supabaseGet(
      `/jobs?select=technician_id,service_type&status=in.(dispatched,en_route,arrived)&technician_id=not.is.null`
    )
  ]);

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
      current_lat: t.current_lat,
      current_lng: t.current_lng,
      busy: remaining_minutes > 0,
      remaining_minutes
    };
  });

  res.status(200).json({ technicians: result });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  logTokenCheck('available-technicians', req);

  try {
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    const jobId = req.query && req.query.job_id;
    if (jobId) {
      await getAssignedTechnicianForJob(jobId, res);
    } else {
      await getAnonymizedRoster(res);
    }
  } catch (err) {
    console.error('available-technicians error:', err);
    res.status(500).json({ error: 'Could not load available technicians' });
  }
};
