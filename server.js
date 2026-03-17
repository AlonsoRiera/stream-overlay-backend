/**
 * stream-overlay-backend / server.js  v4
 * Adds NSFW check via Cloudflare Worker before queuing image events.
 *
 * New env vars:
 *   NSFW_WORKER_URL    — your deployed worker URL e.g. https://rekshot-nsfw.YOUR.workers.dev
 *   NSFW_WORKER_SECRET — shared secret between backend and worker
 */

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');

const app = express();

const PORT               = process.env.PORT               || 3000;
const OVERLAY_URL        = process.env.OVERLAY_URL        || 'http://localhost:3847';
const SECRET             = process.env.OVERLAY_SECRET     || '';
const DELAY_MS           = parseInt(process.env.DELAY_MS  || '5000', 10);
const NSFW_WORKER_URL    = process.env.NSFW_WORKER_URL    || '';
const NSFW_WORKER_SECRET = process.env.NSFW_WORKER_SECRET || '';

const RATE_LIMIT     = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const submissionCounts = new Map();

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

function isRateLimited(ip) {
  const now = Date.now();
  const entry = submissionCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    submissionCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

async function checkNSFW(imageBase64) {
  if (!NSFW_WORKER_URL) return { safe: true, reason: 'no_worker' };
  try {
    const resp = await fetch(`${NSFW_WORKER_URL}/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(NSFW_WORKER_SECRET ? { 'X-Worker-Secret': NSFW_WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ image: imageBase64 }),
      signal: AbortSignal.timeout(8000), // 8s timeout
    });
    return await resp.json();
  } catch (e) {
    console.error('[nsfw] check failed:', e.message);
    return { safe: true, reason: 'check_failed' }; // fail open
  }
}

async function forwardToOverlay(body) {
  const raw = JSON.stringify(body);
  const url = new URL('/event', OVERLAY_URL);
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(raw),
      ...(SECRET ? { 'X-Overlay-Secret': SECRET } : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', version: '4.0', delay: DELAY_MS, nsfw_check: !!NSFW_WORKER_URL });
});

app.post('/event', upload.single('image'), async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  const type    = (req.body.type || '').trim();
  const payload = req.body.payload
    ? (typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload)
    : { ...req.body };

  delete payload.type;

  if (!type) return res.status(400).json({ error: 'event type is required' });

  if ((type === 'steam_message' || type === 'whatsapp_message') && !payload.message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Attach image if uploaded
  let imageBase64 = null;
  if (req.file) {
    imageBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    payload.image = imageBase64;
  }

  // NSFW check — only if image present
  if (imageBase64) {
    const nsfwResult = await checkNSFW(imageBase64);
    if (!nsfwResult.safe) {
      console.log(`[nsfw] blocked image from ${ip} — reason: ${nsfwResult.reason}`);
      return res.status(400).json({ error: 'Image could not be accepted.' });
    }
  }

  // Acknowledge immediately
  res.json({ status: 'queued', type, delay: DELAY_MS });

  setTimeout(async () => {
    try {
      await forwardToOverlay({ type, payload });
      console.log(`[event] [${type}] forwarded`);
    } catch (err) {
      console.error(`[event] forward failed:`, err.message);
    }
  }, DELAY_MS);
});

app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large. Max 2MB.' });
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`[server] v4.0 on port ${PORT}`);
  console.log(`[server] NSFW check: ${NSFW_WORKER_URL || 'disabled'}`);
  console.log(`[server] Forwarding to: ${OVERLAY_URL}`);
});
