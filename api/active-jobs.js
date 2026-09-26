// Returns every open job (status 'requested', 'dispatched', 'en_route',
// or 'arrived' -- i.e. anything not yet completed/cancelled) for
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

    const url = `${SUPABASE_URL}/rest/v1/jobs` +
      `?status=in.(requested,dispatched,en_route,arrived)` +
      `&select=id,service_type,price,status,payment_status,created_at,customer_lat,customer_lng,customer_address,vehicle_year,vehicle_make,vehicle_model,customers(name,phone)` +
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
