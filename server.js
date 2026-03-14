const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');

const app = express();

const PORT        = process.env.PORT        || 3000;
const OVERLAY_URL = process.env.OVERLAY_URL || 'http://localhost:3847';
const SECRET      = process.env.OVERLAY_SECRET || '';
const DELAY_MS    = parseInt(process.env.DELAY_MS || '15000', 10);

const submissionCounts = new Map();
const RATE_LIMIT       = 5;
const RATE_WINDOW_MS   = 10 * 60 * 1000;

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
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

async function forwardToOverlay(payload) {
  const body    = JSON.stringify(payload);
  const url     = new URL('/notify', OVERLAY_URL);
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

app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', version: '2.1', delay: DELAY_MS });
});

app.post('/submit', upload.single('image'), async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions. Please wait a few minutes.' });
  }

  const title   = (req.body.title   || '').trim().slice(0, 32);
  const message = (req.body.message || '').trim().slice(0, 200);
  const style   = ['steam', 'whatsapp'].includes(req.body.style) ? req.body.style : 'steam';

  if (!title || !message) {
    return res.status(400).json({ error: 'Name and message are required.' });
  }

  let imageDataUrl = null;
  if (req.file) {
    imageDataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }

  res.json({ status: 'queued', delay: DELAY_MS });

  setTimeout(async () => {
    try {
      await forwardToOverlay({ title, message, image: imageDataUrl, style });
      console.log(`[queue] [${style}] "${title}" → "${message.slice(0, 50)}"`);
    } catch (err) {
      console.error('[queue] Forward failed:', err.message);
    }
  }, DELAY_MS);
});

app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large. Max 2MB.' });
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`[server] v2.1 listening on port ${PORT}`);
  console.log(`[server] Forwarding to: ${OVERLAY_URL}`);
  console.log(`[server] Delay: ${DELAY_MS}ms`);
});
