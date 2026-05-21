// Vercel Node Function: /api/blob-upload
// Server-side proxy upload: client POSTs multipart/form-data with
// { token, file }, server verifies the token, uploads to Vercel Blob via
// the server SDK, and returns the public URL.
//
// Note: Vercel Functions limit request body to 4.5MB by default. Bigger
// files will need a different path (Blob client SDK + delegation, or
// chunked uploads). We enforce that limit explicitly here.

import { put } from '@vercel/blob';

const VERIFY_URL = 'https://nftroles.xyz/api/public/verify/check';
const YUME_COLLECTION = '0x7011ee079f579eb313012bddb92fd6f06fa43335';
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB to stay safely under Vercel's 4.5MB cap
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

export const config = { api: { bodyParser: false } };

async function getVerifiedAddress(token) {
  if (!token) return null;
  const r = await fetch(`${VERIFY_URL}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.valid) return null;
  if ((data.collection || '').toLowerCase() !== YUME_COLLECTION) return null;
  return String(data.address || '').toLowerCase();
}

async function readRequestBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES + 1024) {
        reject(Object.assign(new Error('file too large (max 4 MB)'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parse a simple single-file multipart/form-data body. Expects fields:
//   token: <string>
//   file: <binary blob>
function parseMultipart(buf, boundary) {
  const sep = Buffer.from('--' + boundary);
  const closing = Buffer.from('--' + boundary + '--');
  const out = { token: '', file: null, filename: '', contentType: '' };
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf(sep, i);
    if (start === -1) break;
    let end = buf.indexOf(sep, start + sep.length);
    if (end === -1) end = buf.indexOf(closing, start + sep.length);
    if (end === -1) break;
    const partRaw = buf.slice(start + sep.length, end);
    // \r\n at the start, \r\n at the end of part body
    const headerEnd = partRaw.indexOf('\r\n\r\n');
    if (headerEnd === -1) { i = end; continue; }
    const headers = partRaw.slice(0, headerEnd).toString('utf8');
    const body = partRaw.slice(headerEnd + 4, partRaw.length - 2); // strip trailing \r\n
    const dispMatch = headers.match(/Content-Disposition:[^\r\n]*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!dispMatch) { i = end; continue; }
    const fieldName = dispMatch[1];
    const filename = dispMatch[2] || '';
    const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const contentType = ctMatch ? ctMatch[1].trim() : '';
    if (filename) {
      out.file = body;
      out.filename = filename;
      out.contentType = contentType;
    } else {
      out[fieldName] = body.toString('utf8');
    }
    i = end;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const ct = req.headers['content-type'] || '';
  const m = ct.match(/multipart\/form-data;\s*boundary=(.+)$/i);
  if (!m) { res.status(400).json({ error: 'expected multipart/form-data' }); return; }
  const boundary = m[1].trim().replace(/^"|"$/g, '');

  let body;
  try {
    body = await readRequestBody(req);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
    return;
  }

  const parsed = parseMultipart(body, boundary);
  if (!parsed.file) { res.status(400).json({ error: 'no file field' }); return; }
  if (parsed.file.length > MAX_BYTES) { res.status(413).json({ error: 'file too large (max 4 MB)' }); return; }
  if (!ALLOWED_CONTENT_TYPES.has(parsed.contentType)) {
    res.status(400).json({ error: 'unsupported content-type: ' + (parsed.contentType || 'unknown') });
    return;
  }

  let address;
  try { address = await getVerifiedAddress(parsed.token); }
  catch { address = null; }
  if (!address) { res.status(401).json({ error: 'verification required (yume holder only)' }); return; }

  const safeName = (parsed.filename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  const pathname = `guestbook/${address}/${Date.now()}-${safeName}`;

  try {
    const result = await put(pathname, parsed.file, {
      access: 'public',
      contentType: parsed.contentType,
      addRandomSuffix: false,
    });
    res.status(200).json({ url: result.url, contentType: parsed.contentType });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'upload failed' });
  }
}
