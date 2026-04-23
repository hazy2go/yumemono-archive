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
    // Strip headers that either break cross-origin embedding OR force download.
    if (kl === 'cross-origin-resource-policy') continue;
    if (kl === 'cross-origin-embedder-policy') continue;
    if (kl === 'cross-origin-opener-policy') continue;
    if (kl === 'content-security-policy') continue;
    if (kl === 'x-content-security-policy') continue;
    if (kl === 'content-disposition') continue; // was forcing download instead of inline playback
    if (kl === 'x-frame-options') continue;
    out.set(k, v);
  }

  // Safari and many mobile browsers require Content-Length on streamed video.
  // Vercel's Response constructor drops it when the body is a ReadableStream,
  // so set it explicitly from upstream's value (or derive from Content-Range).
  const upLen = upstreamRes.headers.get('content-length');
  const upRange = upstreamRes.headers.get('content-range'); // e.g. "bytes 0-1023/876575"
  if (upLen) {
    out.set('Content-Length', upLen);
  } else if (upRange) {
    const m = upRange.match(/bytes\s+(\d+)-(\d+)\//i);
    if (m) out.set('Content-Length', String(+m[2] - +m[1] + 1));
  }

  out.set('Content-Disposition', 'inline');
  out.set('Accept-Ranges', 'bytes');
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  out.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // Short cache + must-revalidate so a bad deploy is never permanently stuck
  // in a client cache.
  out.set('Cache-Control', 'public, max-age=3600, must-revalidate');

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out });
}
