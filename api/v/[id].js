// Vercel Edge Function: GET /v/{id}
// Proxies a Drive file so <video> can embed it cross-origin.
// Forwards Range headers; strips the hostile response headers (CORP, CSP,
// content-disposition: attachment) that prevent inline playback.
//
// Buffers the body to an ArrayBuffer before responding. This is necessary
// because Vercel's Edge Runtime drops Content-Length on ReadableStream
// bodies, and Safari refuses to play video without Content-Length set.
// Archive media fits comfortably in memory (largest clip ~9 MB).

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
  const keep = new Set([
    'content-type',
    'content-range',
    'last-modified',
    'etag',
  ]);
  for (const [k, v] of upstreamRes.headers) {
    if (keep.has(k.toLowerCase())) out.set(k, v);
  }
  out.set('Content-Disposition', 'inline');
  out.set('Accept-Ranges', 'bytes');
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  out.set('Cross-Origin-Resource-Policy', 'cross-origin');
  out.set('Cache-Control', 'public, max-age=3600, must-revalidate');

  if (req.method === 'HEAD' || !upstreamRes.ok && upstreamRes.status !== 206) {
    return new Response(null, { status: upstreamRes.status, headers: out });
  }

  // Buffer the response bytes so the runtime auto-populates Content-Length.
  const buf = await upstreamRes.arrayBuffer();
  return new Response(buf, { status: upstreamRes.status, headers: out });
}
