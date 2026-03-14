/**
 * stream-overlay-backend / server.js  v2
 *
 * Lightweight version — NSFW checking is done in the viewer's browser.
 * This server only:
 *  1. Accepts image + message submissions
 *  2. Validates input
 *  3. Rate limits per IP
 *  4. Holds messages for DELAY_MS
 *  5. Forwards to your local PC via Cloudflare Tunnel → /notify
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const http = require('http');
const https = require('https');

const app = express();

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://announces-clarke-excerpt-pod.trycloudflare.com';
const SECRET = process.env.OVERLAY_SECRET || 'rekshot_secret_123';
const DELAY_MS = parseInt(process.env.DELAY_MS || '5000', 10);

// Rate limiting — 5 submissions per IP per 10 minutes
const submissionCounts = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10mb' }));

// Multer — memory storage, max 2MB images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────
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

async function forwardToOverlay(payload) {
  const body = JSON.stringify(payload);
  const url = new URL('/notify', OVERLAY_URL);
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(SECRET ? { 'X-Overlay-Secret': SECRET } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', version: '2.0', delay: DELAY_MS });
});

/**
 * POST /submit
 * Multipart form: title (string), message (string), image (optional file)
 *
 * NSFW checking is done client-side in the browser via NsfwJS.
 * This endpoint trusts that the browser already rejected bad images,
 * but adds rate limiting and a delay buffer as safety layers.
 */
app.post('/submit', upload.single('image'), async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions. Please wait a few minutes.' });
  }

  const title = (req.body.title || '').trim().slice(0, 32);
  const message = (req.body.message || '').trim().slice(0, 200);

  if (!title || !message) {
    return res.status(400).json({ error: 'Name and message are required.' });
  }

  // Convert image to base64 data URL if present
  let imageDataUrl = null;
  if (req.file) {
    imageDataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }

  // Acknowledge immediately
  res.json({ status: 'queued', delay: DELAY_MS });

  // Delay then forward
  setTimeout(async () => {
    try {
      await forwardToOverlay({ title, message, image: imageDataUrl });
      console.log(`[queue] Forwarded: "${title}" → "${message.slice(0, 50)}"`);
    } catch (err) {
      console.error('[queue] Forward failed:', err.message);
    }
  }, DELAY_MS);
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large. Max 2MB.' });
  res.status(500).json({ error: err.message || 'Internal error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Forwarding to: ${OVERLAY_URL}`);
  console.log(`[server] Delay: ${DELAY_MS}ms`);
  console.log(`[server] NSFW checking: browser-side (NsfwJS)`);
});