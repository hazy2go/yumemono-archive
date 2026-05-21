// Vercel Node Function: /api/stats
//   GET -> { verified: <number>, entries: <number> }
//
// Counts:
//   verified: SCARD of the "verified:addresses" set (populated whenever a
//             holder performs an authenticated action — guestbook post,
//             profile name, avatar set).
//   entries:  LLEN of the guestbook list.

function kvEnv(){
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV not configured');
  return { url, token };
}

async function kv(cmd, ...args){
  const { url, token } = kvEnv();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args]),
  });
  if (!res.ok) throw new Error(`kv ${cmd} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const [verified, entries] = await Promise.all([
      kv('SCARD', 'verified:addresses').catch(() => 0),
      kv('LLEN', 'guestbook:entries').catch(() => 0),
    ]);
    res.status(200).json({ verified: Number(verified) || 0, entries: Number(entries) || 0 });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
