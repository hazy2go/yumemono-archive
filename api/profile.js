// Vercel Node Function: /api/profile
//   GET  ?address=0x...   -> { address, avatar, displayName }
//   POST { token, ... }   -> update caller's profile
//     - avatar: pass tokenId + image + name to set
//     - displayName: pass displayName (1-32 chars, or empty string to clear)
//   DELETE { token, field } -> 'avatar' | 'name' | undefined (=avatar, legacy)
//
// KV layout:
//   hash "profile:avatar"  -> { [address]: JSON { tokenId, image, name, ts } }
//   hash "profile:name"    -> { [address]: <displayName> }
//
// Names are stored ONLY here (not embedded in guestbook entries), so
// changing a name automatically updates every past entry the user posted.

const VERIFY_URL = 'https://nftroles.xyz/api/public/verify/check';
const YUME_COLLECTION = '0x7011ee079f579eb313012bddb92fd6f06fa43335';
const MAX_NAME_LEN = 32;

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

function sanitizeName(s){
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

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
async function readName(address){
  try { return (await kv('HGET', 'profile:name', address)) || null; } catch { return null; }
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET'){
    const address = (req.query?.address || '').toString().toLowerCase();
    if (!isAddress(address)) { res.status(400).json({ error: 'invalid address' }); return; }
    try{
      const [avatar, displayName] = await Promise.all([readAvatar(address), readName(address)]);
      res.status(200).json({ address, avatar, displayName });
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
    let address;
    try { address = await verifyTokenAddress(token); }
    catch { address = null; }
    if (!address){ res.status(401).json({ error: 'token invalid or expired' }); return; }

    // displayName-only update
    if (typeof body.displayName === 'string' && body.tokenId === undefined && body.image === undefined){
      const name = sanitizeName(body.displayName);
      try{
        if (name) await kv('HSET', 'profile:name', address, name);
        else      await kv('HDEL', 'profile:name', address);
        res.status(200).json({ address, displayName: name || null });
      } catch (e){ res.status(500).json({ error: e.message }); }
      return;
    }

    // Avatar update (tokenId + image required)
    const tokenId = String(body.tokenId ?? '').slice(0, 80);
    const image = typeof body.image === 'string' ? body.image.slice(0, 1000) : '';
    const name = typeof body.name === 'string' ? body.name.slice(0, 120) : '';
    if (!tokenId || !image){ res.status(400).json({ error: 'tokenId + image required (or displayName)' }); return; }
    if (!/^https?:\/\//i.test(image)){ res.status(400).json({ error: 'image must be http(s) url' }); return; }
    const entry = { tokenId, image, name, ts: new Date().toISOString() };
    try{
      await kv('HSET', 'profile:avatar', address, JSON.stringify(entry));
      res.status(200).json({ address, avatar: entry });
    } catch (e){ res.status(500).json({ error: e.message }); }
    return;
  }

  if (req.method === 'DELETE'){
    let address;
    try { address = await verifyTokenAddress(body.token || ''); }
    catch { address = null; }
    if (!address){ res.status(401).json({ error: 'token invalid or expired' }); return; }
    const field = (body.field || 'avatar').toString();
    try{
      if (field === 'name') {
        await kv('HDEL', 'profile:name', address);
        res.status(200).json({ address, displayName: null });
      } else {
        await kv('HDEL', 'profile:avatar', address);
        res.status(200).json({ address, avatar: null });
      }
    } catch (e){ res.status(500).json({ error: e.message }); }
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  res.status(405).json({ error: 'method not allowed' });
}
