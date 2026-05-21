// Vercel Node Function: /api/blob-upload
// Server-side proxy upload: client POSTs multipart/form-data with
// { token, file }, server verifies the token, uploads to Vercel Blob via
// the server SDK, returns the public URL.
//
// Vercel functions limit request body to ~4.5MB; we cap files at 4MB.

import { put } from '@vercel/blob';
import Busboy from 'busboy';

const VERIFY_URL = 'https://nftroles.xyz/api/public/verify/check';
const YUME_COLLECTION = '0x7011ee079f579eb313012bddb92fd6f06fa43335';
const MAX_BYTES = 4 * 1024 * 1024;
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

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_BYTES, files: 1, fields: 5, fieldSize: 8192 },
    });
    const fields = {};
    let file = null;
    let fileTooBig = false;
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { fileTooBig = true; stream.resume(); });
      stream.on('end', () => {
        file = { name: info.filename, contentType: info.mimeType, data: Buffer.concat(chunks) };
      });
    });
    bb.on('close', () => {
      if (fileTooBig) return reject(Object.assign(new Error('file too large (max 4 MB)'), { status: 413 }));
      resolve({ fields, file });
    });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let parsed;
  try {
    parsed = await parseMultipart(req);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'bad multipart body' });
    return;
  }

  if (!parsed.file) { res.status(400).json({ error: 'no file field' }); return; }
  if (parsed.file.data.length > MAX_BYTES) { res.status(413).json({ error: 'file too large (max 4 MB)' }); return; }
  if (!ALLOWED_CONTENT_TYPES.has(parsed.file.contentType)) {
    res.status(400).json({ error: 'unsupported content-type: ' + (parsed.file.contentType || 'unknown') });
    return;
  }

  let address;
  try { address = await getVerifiedAddress(parsed.fields.token); }
  catch { address = null; }
  if (!address) { res.status(401).json({ error: 'verification required (yume holder only)' }); return; }

  const safeName = (parsed.file.name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  const pathname = `guestbook/${address}/${Date.now()}-${safeName}`;

  try {
    const result = await put(pathname, parsed.file.data, {
      access: 'private',
      contentType: parsed.file.contentType,
      addRandomSuffix: false,
    });
    res.status(200).json({
      url: result.url,
      downloadUrl: result.downloadUrl,
      contentType: parsed.file.contentType,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'upload failed' });
  }
}
