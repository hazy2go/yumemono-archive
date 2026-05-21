// Vercel Node Function: /api/guestbook
//   GET  -> { entries: [{ id, address, message, ts }], total }
//   POST -> { token, message }  (token from nftroles.xyz/api/public/verify/check)
//
// Storage: Upstash Redis REST API (works with either Vercel KV's
// KV_REST_API_* env vars or Upstash's UPSTASH_REDIS_REST_* env vars).
//
// Anti-spam: max 1 entry per address per 24h (Redis SET NX EX gate).

const VERIFY_URL = 'https://nftroles.xyz/api/public/verify/check';
const YUME_COLLECTION = '0x7011ee079f579eb313012bddb92fd6f06fa43335';
const LIST_KEY = 'guestbook:entries';
const MAX_ENTRIES = 5000;
const MAX_MESSAGE_LEN = 280;
const RATE_LIMIT_SECONDS = 24 * 60 * 60;
const ADMIN_ADDRESSES = new Set(['0x9aa8f40bff01e953fe278179c3888ae8195b839b']);
const MAX_MEDIA_PER_ENTRY = 4;
const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

function isAllowedBlobUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /\.public\.blob\.vercel-storage\.com$/.test(url.host);
  } catch { return false; }
}

function sanitizeMedia(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const m of arr.slice(0, MAX_MEDIA_PER_ENTRY)) {
    if (!m || typeof m !== 'object') continue;
    const url = typeof m.url === 'string' ? m.url : '';
    const contentType = typeof m.contentType === 'string' ? m.contentType : '';
    if (!isAllowedBlobUrl(url)) continue;
    if (!ALLOWED_MEDIA_TYPES.has(contentType)) continue;
    out.push({ url, contentType });
  }
  return out;
}

function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV/Upstash REST creds not configured');
  return { url, token };
}

async function kv(cmd, ...args) {
  const { url, token } = kvEnv();
  const body = JSON.stringify([cmd, ...args]);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`kv ${cmd} ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.result;
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function sanitize(msg) {
  let out = '';
  for (const ch of String(msg)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 && code !== 0x0a && code !== 0x09) continue;
    if (code === 0x7f) continue;
    out += ch;
  }
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_MESSAGE_LEN);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const raw = await kv('LRANGE', LIST_KEY, 0, 199);
      const entries = (raw || [])
        .map((s) => {
          try { return JSON.parse(s); } catch { return null; }
        })
        .filter(Boolean);
      const total = await kv('LLEN', LIST_KEY).catch(() => entries.length);

      // Decorate with each author's current avatar (1 KV call, not N).
      try {
        const unique = [...new Set(entries.map((e) => e.address).filter(Boolean))];
        if (unique.length) {
          const avatarRaw = await kv('HMGET', 'profile:avatar', ...unique);
          const map = {};
          unique.forEach((addr, i) => {
            const v = avatarRaw?.[i];
            if (!v) return;
            try { map[addr] = JSON.parse(v); } catch { /* skip */ }
          });
          for (const e of entries) {
            const a = map[e.address];
            if (a) e.avatar = { image: a.image, tokenId: a.tokenId };
          }
        }
      } catch { /* non-fatal; entries render without avatars */ }

      res.status(200).json({ entries, total });
    } catch (e) {
      res.status(500).json({ error: e.message || 'kv error' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};
    const token = typeof body.token === 'string' ? body.token : '';
    const entryId = typeof body.id === 'string' ? body.id : '';
    if (!token || !entryId) { res.status(400).json({ error: 'missing token or id' }); return; }

    let verify;
    try {
      const r = await fetch(`${VERIFY_URL}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
      if (!r.ok) { res.status(401).json({ error: 'token check failed' }); return; }
      verify = await r.json();
    } catch (e) { res.status(502).json({ error: 'token check upstream error' }); return; }
    if (!verify.valid) { res.status(401).json({ error: 'token invalid or expired' }); return; }
    const address = String(verify.address || '').toLowerCase();
    if (!ADMIN_ADDRESSES.has(address)) { res.status(403).json({ error: 'admin only' }); return; }

    try {
      const raw = await kv('LRANGE', LIST_KEY, 0, MAX_ENTRIES - 1);
      let removed = 0;
      for (const s of raw || []) {
        try {
          const e = JSON.parse(s);
          if (e && e.id === entryId) {
            await kv('LREM', LIST_KEY, 1, s);
            removed++;
            break;
          }
        } catch { /* skip */ }
      }
      res.status(200).json({ removed });
    } catch (e) {
      res.status(500).json({ error: e.message || 'delete failed' });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const token = typeof body.token === 'string' ? body.token : '';
  const messageRaw = typeof body.message === 'string' ? body.message : '';
  const media = sanitizeMedia(body.media);
  if (!token) { res.status(400).json({ error: 'missing token' }); return; }
  if (messageRaw.length > MAX_MESSAGE_LEN * 4) {
    res.status(413).json({ error: 'message too long' }); return;
  }
  const message = sanitize(messageRaw);
  if (!message && !media.length) { res.status(400).json({ error: 'message or media required' }); return; }

  let verify;
  try {
    const r = await fetch(`${VERIFY_URL}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!r.ok) { res.status(401).json({ error: 'token check failed' }); return; }
    verify = await r.json();
  } catch (e) {
    res.status(502).json({ error: 'token check upstream error' }); return;
  }
  if (!verify.valid) { res.status(401).json({ error: 'token invalid or expired' }); return; }
  if ((verify.collection || '').toLowerCase() !== YUME_COLLECTION) {
    res.status(403).json({ error: 'wrong collection' }); return;
  }
  if ((verify.chain || '') !== 'ethereum') {
    res.status(403).json({ error: 'wrong chain' }); return;
  }

  const address = String(verify.address).toLowerCase();

  const gateKey = `guestbook:rl:${address}`;
  try {
    const setRes = await kv('SET', gateKey, '1', 'NX', 'EX', RATE_LIMIT_SECONDS);
    if (!setRes) { res.status(429).json({ error: 'already signed in the last 24h' }); return; }
  } catch (e) {
    res.status(500).json({ error: 'kv error' }); return;
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    address,
    addressShort: shortAddr(address),
    message,
    media,
    ts: new Date().toISOString(),
  };

  try {
    await kv('LPUSH', LIST_KEY, JSON.stringify(entry));
    await kv('LTRIM', LIST_KEY, 0, MAX_ENTRIES - 1);
  } catch (e) {
    await kv('DEL', gateKey).catch(() => {});
    res.status(500).json({ error: 'kv write failed' }); return;
  }

  res.status(200).json({ entry });
}
