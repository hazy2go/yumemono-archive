// Vercel Node Function: /api/register
// Idempotent: client calls this immediately after verify so the address
// is counted in /api/stats even before they post or set anything else.
// Validates the token against nftroles to prevent fake registrations.

const VERIFY_URL = 'https://nftroles.xyz/api/public/verify/check';
const YUME_COLLECTION = '0x7011ee079f579eb313012bddb92fd6f06fa43335';

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
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) { res.status(400).json({ error: 'missing token' }); return; }
  try {
    const r = await fetch(`${VERIFY_URL}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!r.ok) { res.status(401).json({ error: 'token check failed' }); return; }
    const data = await r.json();
    if (!data.valid) { res.status(401).json({ error: 'token invalid or expired' }); return; }
    if ((data.collection || '').toLowerCase() !== YUME_COLLECTION) {
      res.status(403).json({ error: 'wrong collection' }); return;
    }
    const address = String(data.address || '').toLowerCase();
    await kv('SADD', 'verified:addresses', address);
    res.status(200).json({ ok: true, address });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'register failed' });
  }
}
