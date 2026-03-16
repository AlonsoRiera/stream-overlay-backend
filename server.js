/**
 * stream-overlay-backend / server.js  v3
 *
 * General /event endpoint — backend never needs to change for new features.
 * Just add new event types to the frontend and overlay.
 *
 * POST /event
 * {
 *   "type": "steam_message" | "whatsapp_message" | anything you add later,
 *   "payload": { ...any data the overlay needs }
 * }
 */

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');

const app = express();

const PORT        = process.env.PORT           || 3000;
const OVERLAY_URL = process.env.OVERLAY_URL    || 'http://localhost:3847';
const SECRET      = process.env.OVERLAY_SECRET || '';
const DELAY_MS    = parseInt(process.env.DELAY_MS || '5000', 10);

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
  const now   = Date.now();
  const entry = submissionCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    submissionCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

async function forwardToOverlay(body) {
  const raw = JSON.stringify(body);
  const url = new URL('/event', OVERLAY_URL);
  const options = {
    method:   'POST',
    hostname: url.hostname,
    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
    path:     url.pathname,
    headers: {
      'Content-Type':   'application/json',
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', version: '3.0', delay: DELAY_MS });
});

// ── General event endpoint ────────────────────────────────────────────────────
// Accepts multipart (with optional image file) or JSON
app.post('/event', upload.single('image'), async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  // Support both multipart and JSON bodies
  const type    = (req.body.type    || '').trim();
  const payload = req.body.payload
    ? (typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload)
    : req.body;

  if (!type) {
    return res.status(400).json({ error: 'event type is required' });
  }

  // Attach image as base64 if uploaded
  if (req.file) {
    payload.image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }

  // Basic validation per known event types
  if ((type === 'steam_message' || type === 'whatsapp_message') && !payload.message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Acknowledge immediately
  res.json({ status: 'queued', type, delay: DELAY_MS });

  // Delay then forward
  setTimeout(async () => {
    try {
      await forwardToOverlay({ type, payload });
      console.log(`[event] [${type}] queued → overlay`);
    } catch (err) {
      console.error(`[event] forward failed:`, err.message);
    }
  }, DELAY_MS);
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large. Max 2MB.' });
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`[server] v3.0 on port ${PORT}`);
  console.log(`[server] Forwarding to: ${OVERLAY_URL}`);
  console.log(`[server] Delay: ${DELAY_MS}ms`);
});
