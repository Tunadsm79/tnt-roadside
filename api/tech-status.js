// Read-only: returns every technician row (name, on-duty flag, last known
// position, when it was last updated) for admin.html's on-duty/live-map
// section. Same service-role-key pattern as all-jobs.js -- keeps
// `technicians` off the public anon key's read surface, consistent with
// how this project treats `jobs`/`customers` (see the RLS + GRANT notes
// in the project doc).
//
// 2026-09-26 (Piece 1 of the dispatch-routing fix, finally unblocked now
// that jobs.accepted_at exists and api/accept-job.js actually sets
// technician_id/accepted_at at accept time -- see that file's comment):
// also returns each on-duty tech's CURRENT job, if they have one, so
// admin.html's tech-detail panel can show "what are they working, since
// when" instead of "coming soon". A tech can technically have more than
// one non-terminal job (stacking is allowed, see the project doc's
// dispatch-routing decision) -- this returns the most recently accepted
// one plus a count of any others, rather than guessing which "the" job
// is.
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

    const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    const [techResponse, jobsResponse] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/technicians?select=id,name,on_duty,current_lat,current_lng,location_updated_at&order=name.asc`,
        { headers }
      ),
      // Every non-terminal job that's actually been accepted by someone
      // (technician_id gets set at accept time now, not just guessed at
      // creation -- see api/accept-job.js), newest-accepted first so the
      // first one found per tech below is their most recent.
      fetch(
        `${SUPABASE_URL}/rest/v1/jobs` +
          `?select=technician_id,service_type,status,accepted_at,customer_address,customers(name)` +
          `&status=in.(dispatched,en_route,arrived)` +
          `&technician_id=not.is.null` +
          `&order=accepted_at.desc.nullslast`,
        { headers }
      )
    ]);

    const techText = await techResponse.text();
    const technicians = techText ? JSON.parse(techText) : [];
    if (!techResponse.ok) {
      throw new Error(`Supabase technicians fetch failed: ${techResponse.status} ${techText}`);
    }

    const jobsText = await jobsResponse.text();
    const jobs = jobsText ? JSON.parse(jobsText) : [];
    if (!jobsResponse.ok) {
      throw new Error(`Supabase jobs fetch failed: ${jobsResponse.status} ${jobsText}`);
    }

    const jobsByTech = new Map();
    for (const job of jobs) {
      const list = jobsByTech.get(job.technician_id) || [];
      list.push(job);
      jobsByTech.set(job.technician_id, list);
    }

    const result = technicians.map(t => {
      const techJobs = jobsByTech.get(t.id) || [];
      const current_job = techJobs.length
        ? {
            service_type: techJobs[0].service_type,
            status: techJobs[0].status,
            accepted_at: techJobs[0].accepted_at,
            customer_address: techJobs[0].customer_address,
            customer_name: techJobs[0].customers ? techJobs[0].customers.name : null,
            other_jobs_count: techJobs.length - 1
          }
        : null;
      return { ...t, current_job };
    });

    res.status(200).json({ technicians: result });
  } catch (err) {
    console.error('tech-status error:', err);
    res.status(500).json({ error: 'Could not load technician status' });
  }
};
