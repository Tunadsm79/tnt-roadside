// Returns open jobs (status 'requested', 'dispatched', 'en_route', or
// 'arrived' -- i.e. anything not yet completed/cancelled) for
// tech.html's job list/detail view -- including the customer's name and
// phone number, joined server-side with the service-role key. This
// replaces tech.html's previous direct anon-key read of
// `active_jobs_view`, which had no server-side gate at all (anyone with
// the public anon key could read every open job's address with a plain
// REST call, PIN or no PIN). Routing this through a serverless function
// doesn't fix that same-gap for this new endpoint either -- job_id/PIN
// aren't checked here, only the *kind* of data exposed changes -- but it
// does mean `customers` itself stays fully unreadable by the anon key,
// which is the one hard line the rest of this app's security has been
// built around (see project docs, RLS + GRANT section). Worth a proper
// auth pass later if this app grows past one technician.
//
// 2026-09-28: a technician's own request is now scoped server-side to
// THEIR OWN assigned jobs (technician_id matches, or is null -- a
// defensive fallback for any orphaned job with no assignment, which
// shouldn't occur under the current dispatch flow but keeps the old
// "anyone can pick it up" behavior for that edge case rather than
// hiding the job from every tech). A job is now decided (and stored)
// at dispatch time, before any tech ever sees it -- see accept-job.js's
// same-day comment -- so the old shared-pool model, where this endpoint
// handed every open job to every on-duty tech, is gone. requireRole()
// already decodes which tech is calling (claims.tech_name, from their
// login token -- see _auth.js), so this is enforced here, server-side,
// not just hidden client-side: a different tech's browser never
// receives another tech's job data at all. Admin's own calls (role
// 'admin') are NOT scoped -- admin sees every job, same as always,
// since admin.html is where reassignment/oversight happens.
const { requireRole, ALLOWED_ORIGIN } = require('./_auth');

const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
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

  // Step 8 of the security plan: REAL enforcement (Step 8 of the session's
  // rollout). Only ever called by tech.html, which already sends a real
  // token on this call (see the security plan's Step 8 write-up for the
  // caller audit). No customer-facing caller exists for this endpoint.
  const auth = requireRole('active-jobs', req, res, ['tech', 'admin']);
  if (!auth) return;

  try {
    if (!SERVICE_KEY) {
      res.status(500).json({ error: 'Server is not configured (missing SUPABASE_SERVICE_ROLE_KEY)' });
      return;
    }

    // For a tech (not admin), look up their own technician id so the
    // jobs query below can be scoped to it. Same name->id lookup
    // accept-job.js already does.
    let techScopeFilter = '';
    if (auth.role === 'tech') {
      const techLookup = await fetch(
        `${SUPABASE_URL}/rest/v1/technicians?name=eq.${encodeURIComponent(auth.tech_name)}&select=id`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      );
      const techLookupText = await techLookup.text();
      const techRows = techLookupText ? JSON.parse(techLookupText) : [];
      const myTech = techRows && techRows[0];
      if (!myTech) {
        // Token names a technician that no longer exists in the table --
        // fail closed (empty list) rather than silently showing every
        // job, same "fail closed" spirit as requireRole() itself.
        res.status(200).json({ jobs: [] });
        return;
      }
      techScopeFilter = `&or=(technician_id.eq.${myTech.id},technician_id.is.null)`;
    }

    const url = `${SUPABASE_URL}/rest/v1/jobs` +
      `?status=in.(requested,dispatched,en_route,arrived)` +
      techScopeFilter +
      `&select=id,service_type,price,status,payment_status,created_at,customer_lat,customer_lng,customer_address,vehicle_year,vehicle_make,vehicle_model,technician_id,customers(name,phone)` +
      `&order=created_at.asc`;

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
    console.error('active-jobs error:', err);
    res.status(500).json({ error: 'Could not load active jobs' });
  }
};
