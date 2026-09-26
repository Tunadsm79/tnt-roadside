// Returns every message in one job's chat thread, oldest first -- polled
// every 15s by index.html's tracking screen and every 10s by tech.html's
// job detail view (same cadence each page already polls at for other
// things). Same service-role-key read pattern as active-jobs.js.
const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    const jobId = req.query && req.query.job_id;
    if (!jobId) {
      res.status(400).json({ error: 'Missing job_id' });
      return;
    }

    const url = `${SUPABASE_URL}/rest/v1/messages` +
      `?job_id=eq.${jobId}` +
      `&select=id,sender,body,created_at` +
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
      throw new Error(`Supabase messages query failed: ${response.status} ${text}`);
    }

    res.status(200).json({ messages: data });
  } catch (err) {
    console.error('job-messages error:', err);
    res.status(500).json({ error: 'Could not load messages' });
  }
};
