// api/save-config.js
// Accepts a base64 config string and stores it under a short 8-char hex ID in Redis.
// Returns { id, shortUrl } for use in the configuration UI.

import { randomBytes } from 'crypto';

let _redis = null;

async function getRedis() {
  if (_redis) return _redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return _redis;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const { config } = req.body ?? {};
  if (!config || typeof config !== 'string' || !config.trim()) {
    res.status(400).json({ error: 'Missing or invalid config.' });
    return;
  }

  const redis = await getRedis();
  if (!redis) {
    res.status(503).json({ error: 'Short URL service unavailable.' });
    return;
  }

  const id = randomBytes(6).toString('hex'); // 12 hex chars
  await redis.set(`shorturl:${id}`, config.trim(), { ex: 31_536_000, nx: true }); // 1 year TTL, no overwrite

  const protocol = (req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
  const host     = req.headers.host ?? 'unified-stream.vercel.app';
  const shortUrl = `${protocol}://${host}/stremio/${id}/manifest.json`;

  res.status(200).json({ id, shortUrl });
}
