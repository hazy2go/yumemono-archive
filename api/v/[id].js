// Vercel Edge Function: GET /v/{id}
// Streams a Drive video through this origin so <video> can embed it
// cross-origin (strips Drive's `cross-origin-resource-policy: same-site`).
// Forwards Range headers so seek + partial content work.

export const config = { runtime: 'edge' };

const ID_RE = /^[A-Za-z0-9_-]{10,80}$/;

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.pathname.split('/').filter(Boolean).pop() || '';
  if (!ID_RE.test(id)) {
    return new Response('bad id', { status: 400 });
  }
  const upstream = `https://drive.usercontent.google.com/download?id=${id}&export=download`;

  const fwd = new Headers();
  const range = req.headers.get('range');
  if (range) fwd.set('Range', range);

  const upstreamRes = await fetch(upstream, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: fwd,
    redirect: 'follow',
  });

  const out = new Headers();
  for (const [k, v] of upstreamRes.headers) {
    const kl = k.toLowerCase();
    if (kl === 'cross-origin-resource-policy') continue;
    if (kl === 'cross-origin-embedder-policy') continue;
    if (kl === 'cross-origin-opener-policy') continue;
    if (kl === 'content-security-policy') continue;
    if (kl === 'x-content-security-policy') continue;
    out.set(k, v);
  }
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Cross-Origin-Resource-Policy', 'cross-origin');
  out.set('Cache-Control', 'public, max-age=86400, immutable');

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out });
}
