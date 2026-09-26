// Writes one chat message (customer <-> tech) to a job's thread. Same
// service-role-key approach as accept-job.js/active-jobs.js -- the `messages`
// table has RLS on with zero anon policies, so this is the only way either
// side's message ever reaches the database. Deliberately no auth beyond
// "you know the job_id" (a random UUID, not guessable) -- same security
// bar as the rest of this app (see project docs), not meant to survive a
// determined attacker, just keep casual snooping out.
const SUPABASE_URL = 'https://psqzoyjszykdgjkcbrrt.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_BODY_LENGTH = 500;

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

    const { job_id, sender, body } = req.body || {};

    if (!job_id) {
      res.status(400).json({ error: 'Missing job_id' });
      return;
    }
    if (sender !== 'customer' && sender !== 'tech') {
      res.status(400).json({ error: "sender must be 'customer' or 'tech'" });
      return;
    }
    const trimmed = typeof body === 'string' ? body.trim() : '';
    if (!trimmed) {
      res.status(400).json({ error: 'Message is empty' });
      return;
    }
    if (trimmed.length > MAX_BODY_LENGTH) {
      res.status(400).json({ error: `Message is too long (max ${MAX_BODY_LENGTH} characters)` });
      return;
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ job_id, sender, body: trimmed })
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`Supabase insert failed: ${response.status} ${text}`);
    }

    res.status(200).json({ message: data && data[0] });
  } catch (err) {
    console.error('send-message error:', err);
    res.status(500).json({ error: 'Could not send message' });
  }
};
