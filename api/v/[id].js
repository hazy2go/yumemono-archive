// Vercel Node Function: GET /v/{id}
// Proxies a Drive file so <video> can embed it cross-origin.
// Explicitly sets Content-Length (Safari and iOS refuse to play video
// without it). Vercel's Edge runtime strips Content-Length on all
// responses, so this must run on Node.

const ID_RE = /^[A-Za-z0-9_-]{10,80}$/;

export default async function handler(req, res) {
  const id = (req.query && req.query.id) || '';
  if (!ID_RE.test(id)) {
    res.status(400).send('bad id');
    return;
  }
  const upstreamUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download`;

  const headers = {};
  if (req.headers.range) headers['Range'] = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
    });
  } catch (err) {
    res.status(502).send('upstream error: ' + (err && err.message));
    return;
  }

  // Copy through only safe/useful headers from upstream.
  const ct = upstream.headers.get('content-type');
  const cr = upstream.headers.get('content-range');
  const lm = upstream.headers.get('last-modified');
  const et = upstream.headers.get('etag');

  if (ct) res.setHeader('Content-Type', ct);
  if (cr) res.setHeader('Content-Range', cr);
  if (lm) res.setHeader('Last-Modified', lm);
  if (et) res.setHeader('ETag', et);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');

  if (req.method === 'HEAD') {
    res.status(upstream.status).end();
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Length', String(buf.length));
  res.status(upstream.status).end(buf);
}
