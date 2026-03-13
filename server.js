/**
 * stream-overlay-backend / server.js
 *
 * Responsibilities:
 *  1. Accept image + message submissions from viewers (multipart form)
 *  2. Run NsfwJS check on every uploaded image
 *  3. Also expose /check-image for the client-side pre-check
 *  4. Hold clean messages in a delay queue (default 15s)
 *  5. Forward to your local PC via Cloudflare Tunnel → /notify
 *
 * Deploy free on Render.com or Railway.app
 * Set env vars: OVERLAY_URL, SUBMIT_SECRET, DELAY_MS (optional)
 */

require('@tensorflow/tfjs-node');           // must be first import
const nsfwjs  = require('nsfwjs');
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const sharp   = require('sharp');
const http    = require('http');
const https   = require('https');

const app = express();

// ── Config ──────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const OVERLAY_URL = process.env.OVERLAY_URL || 'http://localhost:3847';  // Your CF Tunnel URL or localhost
const SECRET      = process.env.SUBMIT_SECRET || '';                      // Optional shared secret
const DELAY_MS    = parseInt(process.env.DELAY_MS || '15000', 10);       // 15s delay before showing on stream

// NsfwJS thresholds — tune these if you get too many false positives
const NSFW_THRESHOLDS = {
  Porn:      0.60,   // explicit sexual content
  Sexy:      0.80,   // suggestive but not explicit — higher threshold, less strict
  Hentai:    0.60,   // drawn sexual content
  // Neutral and Drawing are allowed
};

// Rate limiting (simple in-memory, resets on server restart)
const submissionCounts = new Map();  // ip → { count, resetAt }
const RATE_LIMIT       = 5;          // max submissions per window
const RATE_WINDOW_MS   = 10 * 60 * 1000; // 10 minutes

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',   // tighten this to your frontend domain in production
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '10mb' }));

// Multer: memory storage, max 2MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ── NsfwJS model (loads once at startup) ─────────────────────────────────────
let model = null;
async function loadModel() {
  console.log('[NSFW] Loading NsfwJS model...');
  model = await nsfwjs.load('MobileNetV2');
  console.log('[NSFW] Model ready.');
}

// ── NSFW check helper ─────────────────────────────────────────────────────────
async function checkImageBuffer(buffer) {
  if (!model) throw new Error('Model not loaded yet');

  // Resize to 224x224 for MobileNet, convert to RGB
  const resized = await sharp(buffer)
    .resize(224, 224, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer();

  const tf   = require('@tensorflow/tfjs-node');
  const tensor = tf.tensor3d(new Uint8Array(resized), [224, 224, 3]);
  const predictions = await model.classify(tensor);
  tensor.dispose();

  // predictions = [{ className: 'Porn', probability: 0.92 }, ...]
  const result = { safe: true, reason: null, scores: {} };
  for (const p of predictions) {
    result.scores[p.className] = p.probability;
    const threshold = NSFW_THRESHOLDS[p.className];
    if (threshold !== undefined && p.probability >= threshold) {
      result.safe   = false;
      result.reason = `${p.className} content detected (${(p.probability * 100).toFixed(0)}%)`;
    }
  }
  return result;
}

// ── Rate limiting helper ──────────────────────────────────────────────────────
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

// ── Forward to local overlay ──────────────────────────────────────────────────
async function forwardToOverlay(payload) {
  const body    = JSON.stringify(payload);
  const url     = new URL('/notify', OVERLAY_URL);
  const options = {
    method:   'POST',
    hostname: url.hostname,
    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
    path:     url.pathname,
    headers: {
      'Content-Type':   'application/json',
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

// Health check
app.get('/ping', (_req, res) => res.json({ status: 'ok', model: model ? 'loaded' : 'loading' }));

/**
 * POST /check-image
 * Body: { image: "data:image/png;base64,..." }
 * Used by the frontend for real-time pre-check before submitting the form.
 */
app.post('/check-image', async (req, res) => {
  const { image } = req.body;
  if (!image || !image.startsWith('data:image/')) {
    return res.status(400).json({ safe: false, reason: 'Invalid image data' });
  }

  if (!model) {
    // Model still loading — tell client to proceed, submit will re-check
    return res.json({ safe: true, reason: null, note: 'model_loading' });
  }

  try {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const result = await checkImageBuffer(buffer);
    res.json(result);
  } catch (err) {
    console.error('[check-image] Error:', err.message);
    res.status(500).json({ safe: false, reason: 'Image check failed' });
  }
});

/**
 * POST /submit
 * Multipart form: title, message, image (optional file)
 * Full pipeline: validate → NSFW check → delay → forward to overlay
 */
app.post('/submit', upload.single('image'), async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

  // Rate limit
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions. Please wait a few minutes.' });
  }

  const title   = (req.body.title   || '').trim().slice(0, 32);
  const message = (req.body.message || '').trim().slice(0, 200);

  if (!title || !message) {
    return res.status(400).json({ error: 'Name and message are required.' });
  }

  // NSFW check on uploaded image
  let imageDataUrl = null;
  if (req.file) {
    if (!model) {
      return res.status(503).json({ error: 'Image checking service is still starting up. Try again in a moment.' });
    }

    try {
      const nsfwResult = await checkImageBuffer(req.file.buffer);
      if (!nsfwResult.safe) {
        console.log(`[NSFW] Blocked submission from ${ip}: ${nsfwResult.reason}`);
        return res.status(400).json({ error: `Image rejected: ${nsfwResult.reason}` });
      }
      // Convert to base64 data URL for the overlay
      const mime = req.file.mimetype;
      imageDataUrl = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
    } catch (err) {
      console.error('[submit] NSFW check error:', err.message);
      return res.status(500).json({ error: 'Image check failed. Try a different image.' });
    }
  }

  // Immediately acknowledge to the viewer
  res.json({ status: 'queued', delay: DELAY_MS });

  // Delay then forward to overlay
  setTimeout(async () => {
    try {
      await forwardToOverlay({ title, message, image: imageDataUrl });
      console.log(`[queue] Forwarded: "${title}" → "${message.slice(0, 40)}..."`);
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
app.listen(PORT, async () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Will forward to overlay at: ${OVERLAY_URL}`);
  console.log(`[server] Delay: ${DELAY_MS}ms`);
  try {
    await loadModel();
  } catch (err) {
    console.error('[server] Failed to load NSFW model:', err.message);
    console.error('[server] Image uploads will be rejected until model loads.');
  }
});
