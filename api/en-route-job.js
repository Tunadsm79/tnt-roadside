// Marks a job "en_route" -- the technician has left to head to the
// customer. This is the step that triggers the customer-facing "on the
// way" notification/copy (index.html's tracking screen watches job
// status and updates its message accordingly -- no separate notification
// system needed, it's just a status change like accept-job.js). Only
// allowed from status 'dispatched' (the tech must have already accepted
// the job before they can be en route to it); calling this from any other
// status is rejected. Same service-role-key approach as the other
// job-mutation endpoints -- see complete-job.js's comment for why.
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

    const { job_id } = req.body || {};
    if (!job_id) {
      res.status(400).json({ error: 'Missing job_id' });
      return;
    }

    const jobs = await supabaseRequest(`/jobs?id=eq.${job_id}&select=id,status`);
    const job = jobs && jobs[0];
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status !== 'dispatched') {
      res.status(400).json({ error: `Job is ${job.status} -- accept it before heading en route` });
      return;
    }

    await supabaseRequest(`/jobs?id=eq.${job_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'en_route' })
    });

    res.status(200).json({ status: 'en_route' });
  } catch (err) {
    console.error('en-route-job error:', err);
    res.status(500).json({ error: 'Could not update job to en route' });
  }
};
