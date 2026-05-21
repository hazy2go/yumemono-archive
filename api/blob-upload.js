// Vercel Node Function: /api/blob-upload
// Issues a short-lived client upload token for Vercel Blob.
//
// Client posts the standard handleUpload body shape; we authenticate the
// caller via their nftroles verify token (must be a Yume holder) and let
// the user upload up to 50MB directly browser→blob.

import { handleUpload } from '@vercel/blob/client';

const VERIFY_URL = 'https://nftroles.xyz/api/public/verify/check';
const YUME_COLLECTION = '0x7011ee079f579eb313012bddb92fd6f06fa43335';
const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
];

async function getVerifiedAddress(token) {
  if (!token) return null;
  const r = await fetch(`${VERIFY_URL}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.valid) return null;
  if ((data.collection || '').toLowerCase() !== YUME_COLLECTION) return null;
  return String(data.address || '').toLowerCase();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayloadStr) => {
        // clientPayload: JSON string with { verifyToken }
        let payload = {};
        try { payload = clientPayloadStr ? JSON.parse(clientPayloadStr) : {}; } catch {}
        const address = await getVerifiedAddress(payload.verifyToken);
        if (!address) throw new Error('verification required (yume holder only)');
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ address, ts: Date.now() }),
        };
      },
      onUploadCompleted: async () => { /* no-op; we record media URLs on the guestbook entry POST */ },
    });
    res.status(200).json(jsonResponse);
  } catch (e) {
    res.status(400).json({ error: e?.message || 'upload init failed' });
  }
}
