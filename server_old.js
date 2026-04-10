/**
 * stream-overlay-backend / server.js  v5
 *
 * NSFW images go into pending_reviews table instead of being rejected.
 * Viewer gets "pending review" response.
 * Admin approves/discards from admin panel.
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
const SB_URL             = process.env.SB_URL             || '';
const SB_SERVICE_KEY     = process.env.SB_SERVICE_KEY     || '';

const RATE_LIMIT     = 20;  // 20 requests
const RATE_WINDOW_MS = 2 * 60 * 1000;  // per 2 minutes
const submissionCounts = new Map();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'] }));
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
      signal: AbortSignal.timeout(8000),
    });
    return await resp.json();
  } catch (e) {
    console.error('[nsfw] check failed:', e.message);
    // Return failed so it goes to review queue
    return { safe: false, reason: 'check_failed' };
  }
}

async function saveToPendingReview(type, payload, image, nsfwReason) {
  if (!SB_URL || !SB_SERVICE_KEY) return null;
  try {
    const resp = await fetch(`${SB_URL}/rest/v1/pending_reviews`, {
      method: 'POST',
      headers: {
        'apikey':        SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify({ type, payload, image, nsfw_reason: nsfwReason }),
    });
    const data = await resp.json();
    return data?.[0]?.id || null;
  } catch(e) {
    console.error('[review] save failed:', e.message);
    return null;
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

// ── Health check ──────────────────────────────────────────────
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', version: '5.0', delay: DELAY_MS, nsfw_check: !!NSFW_WORKER_URL });
});

// ── Approve a pending review (called from admin panel) ────────
app.post('/approve/:id', async (req, res) => {
  const adminSecret = req.headers['x-overlay-secret'];
  if (SECRET && (!adminSecret || adminSecret !== SECRET)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { id } = req.params;

  // Fetch from Supabase
  if (!SB_URL || !SB_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const fetchResp = await fetch(`${SB_URL}/rest/v1/pending_reviews?id=eq.${id}&select=*`, {
      headers: {
        'apikey':        SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
      },
    });
    const rows = await fetchResp.json();
    if (!rows || !rows.length) {
      return res.status(404).json({ error: 'Review not found' });
    }

    const review = rows[0];
    const payload = { ...review.payload };
    if (review.image) payload.image = review.image;

    // Delete from pending
    await fetch(`${SB_URL}/rest/v1/pending_reviews?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        'apikey':        SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
      },
    });

    // Queue to overlay with delay
    res.json({ status: 'approved', delay: DELAY_MS });

    setTimeout(async () => {
      try {
        await forwardToOverlay({ type: review.type, payload });
        console.log(`[approve] forwarded review ${id}`);
      } catch(err) {
        console.error('[approve] forward failed:', err.message);
      }
    }, DELAY_MS);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Discard a pending review ──────────────────────────────────
app.delete('/review/:id', async (req, res) => {
  const adminSecret = req.headers['x-overlay-secret'];
  if (SECRET && (!adminSecret || adminSecret !== SECRET)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { id } = req.params;
  try {
    await fetch(`${SB_URL}/rest/v1/pending_reviews?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        'apikey':        SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
      },
    });
    res.json({ status: 'discarded' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Main event endpoint ───────────────────────────────────────
app.post('/event', upload.single('image'), async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  const type    = (req.body.type || '').trim();
  const payload = { ...req.body };
  delete payload.type;
  delete payload.image;

  if (!type) return res.status(400).json({ error: 'event type is required' });

  const MESSAGE_TYPES = ['steam_message','whatsapp_message','discord_message','linkedin_message','mercadolibre_message'];
  if (MESSAGE_TYPES.includes(type) && !payload.message) {
    return res.status(400).json({ error: 'message is required' });
  }

  let imageBase64 = null;
  if (req.file) {
    imageBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }

  // Images — check whitelist first, otherwise manual review
  if (imageBase64) {
    const userId = payload.user_id || null;
    let whitelisted = false;

    if (userId && SB_URL && SB_SERVICE_KEY) {
      try {
        const wlResp = await fetch(
          `${SB_URL}/rest/v1/whitelist?user_id=eq.${userId}&select=user_id`,
          { headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': `Bearer ${SB_SERVICE_KEY}` } }
        );
        const wlData = await wlResp.json();
        whitelisted = Array.isArray(wlData) && wlData.length > 0;
      } catch(e) {
        console.error('[whitelist] check failed:', e.message);
      }
    }

    if (whitelisted) {
      // Trusted user — skip review, queue directly
      payload.image = imageBase64;
      console.log(`[whitelist] user ${userId} bypassed review`);
    } else {
      // Unknown user — send to manual review
      const reviewId = await saveToPendingReview(type, payload, imageBase64, 'manual_review');
      console.log(`[review] image queued for manual review id:${reviewId}`);
      return res.status(202).json({
        status: 'pending_review',
        message: 'Your image is under review and will appear once approved.',
      });
    }
  }

  // No image — queue normally
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
  console.log(`[server] v5.0 on port ${PORT}`);
  console.log(`[server] NSFW check: ${NSFW_WORKER_URL || 'disabled'}`);
  console.log(`[server] Review queue: ${SB_URL ? 'enabled' : 'disabled'}`);
  console.log(`[server] Forwarding to: ${OVERLAY_URL}`);
});
