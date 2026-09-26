// Marks a job "dispatched" -- the technician has actively acknowledged a
// new job, as opposed to it just silently sitting there. Only allowed
// from status 'requested' (a fresh, unaccepted dispatch); accepting an
// already-accepted, completed, or cancelled job is rejected. No money
// moves here -- this is purely a status change so both sides (tech and
// customer) know a human actually saw and accepted the job, not just
// software matching them up. Also texts the customer and admin (see
// api/_notify.js -- no-ops until Twilio env vars are set). Same
// service-role-key approach as complete-job.js/cancel-job.js -- see
// complete-job.js's comment for why.
//
// 2026-09-26: now also records WHICH tech actually accepted. Jobs are a
// shared pool -- any on-duty tech can accept any open job -- and
// `technician_id` used to only ever get set once, at job creation, to
// whichever tech selectTechnicianForDispatch() suggested. If a different
// on-duty tech was the one who actually tapped Accept, `technician_id`
// stayed wrong for that job's whole life (wrong "busy" counts in
// available-technicians.js, wrong tech shown on the customer's live
// tracking screen). This now overwrites `technician_id` with whoever
// really accepted, and stamps `accepted_at` for admin's job-detail view.
// tech.html sends `tech_name` (same field it already sends to
// tech-heartbeat.js) so this can look up that tech's id.
const { notifyStatusChange } = require('./_notify');

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

    const { job_id, tech_name } = req.body || {};
    if (!job_id) {
      res.status(400).json({ error: 'Missing job_id' });
      return;
    }
    if (!tech_name) {
      res.status(400).json({ error: 'Missing tech_name' });
      return;
    }

    const jobs = await supabaseRequest(`/jobs?id=eq.${job_id}&select=id,status,service_type,customers(name,phone)`);
    const job = jobs && jobs[0];
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status !== 'requested') {
      res.status(400).json({ error: `Job is already ${job.status} -- can't accept it again` });
      return;
    }

    const techs = await supabaseRequest(`/technicians?name=eq.${encodeURIComponent(tech_name)}&select=id`);
    const tech = techs && techs[0];
    if (!tech) {
      res.status(400).json({ error: `No technician named "${tech_name}" found` });
      return;
    }

    await supabaseRequest(`/jobs?id=eq.${job_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'dispatched',
        technician_id: tech.id,
        accepted_at: new Date().toISOString()
      })
    });

    await notifyStatusChange('dispatched', job, job.customers);

    res.status(200).json({ status: 'dispatched' });
  } catch (err) {
    console.error('accept-job error:', err);
    res.status(500).json({ error: 'Could not accept job' });
  }
};
