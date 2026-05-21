// Vercel Node Function: /api/profile
//   GET  ?address=0x...           -> { address, avatar: { tokenId, image, name } | null }
//   POST { token, tokenId, image, name } -> set caller's avatar (token-gated)
//   DELETE { token }              -> clear caller's avatar
//
// KV: hash key "profile:avatar" → { [address]: { tokenId, image, name, ts } }

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

function isAddress(a){ return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }

async function verifyTokenAddress(token){
  if (!token) return null;
  const r = await fetch(`${VERIFY_URL}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.valid) return null;
  if ((data.collection || '').toLowerCase() !== YUME_COLLECTION) return null;
  return String(data.address || '').toLowerCase();
}

async function readAvatar(address){
  try{
    const raw = await kv('HGET', 'profile:avatar', address);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET'){
    const address = (req.query?.address || '').toString().toLowerCase();
    if (!isAddress(address)) { res.status(400).json({ error: 'invalid address' }); return; }
    try{
      const avatar = await readAvatar(address);
      res.status(200).json({ address, avatar });
    } catch (e){
      res.status(500).json({ error: e.message });
    }
    return;
  }

  let body = req.body;
  if (typeof body === 'string'){
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  if (req.method === 'POST'){
    const token = typeof body.token === 'string' ? body.token : '';
    const tokenId = String(body.tokenId ?? '').slice(0, 80);
    const image = typeof body.image === 'string' ? body.image.slice(0, 1000) : '';
    const name = typeof body.name === 'string' ? body.name.slice(0, 120) : '';

    if (!tokenId || !image){ res.status(400).json({ error: 'tokenId + image required' }); return; }
    if (!/^https?:\/\//i.test(image)){ res.status(400).json({ error: 'image must be http(s) url' }); return; }

    let address;
    try { address = await verifyTokenAddress(token); }
    catch (e){ res.status(502).json({ error: 'token check failed' }); return; }
    if (!address){ res.status(401).json({ error: 'token invalid or expired' }); return; }

    const entry = { tokenId, image, name, ts: new Date().toISOString() };
    try{
      await kv('HSET', 'profile:avatar', address, JSON.stringify(entry));
      res.status(200).json({ address, avatar: entry });
    } catch (e){
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (req.method === 'DELETE'){
    let address;
    try { address = await verifyTokenAddress(body.token || ''); }
    catch { address = null; }
    if (!address){ res.status(401).json({ error: 'token invalid or expired' }); return; }
    try{
      await kv('HDEL', 'profile:avatar', address);
      res.status(200).json({ address, avatar: null });
    } catch (e){
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  res.status(405).json({ error: 'method not allowed' });
}
