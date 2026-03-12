# Stream Overlay — Full System Setup Guide

```
[Viewer] → form on Netlify/Vercel (free)
               ↓  POST /submit  (multipart with image)
         [Backend on Render] ← NsfwJS checks image here
               ↓  15s delay
         [Cloudflare Tunnel] → your PC localhost:3847
               ↓
         [Electron Overlay] → notification on screen
```

---

## Part 1 — Deploy the Backend (Render.com, free)

### 1. Push to GitHub
```bash
cd backend/
git init && git add . && git commit -m "init"
gh repo create stream-overlay-backend --public --push
# or push manually to github.com
```

### 2. Create a Web Service on Render
- Go to https://render.com → New → Web Service
- Connect your GitHub repo
- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Instance type:** Free

### 3. Set Environment Variables on Render
| Variable         | Value                                      |
|------------------|--------------------------------------------|
| `OVERLAY_URL`    | Your Cloudflare Tunnel URL (see Part 3)    |
| `OVERLAY_SECRET` | A random secret, e.g. `mySecret123`        |
| `DELAY_MS`       | `15000` (15 seconds — adjust to your taste)|

> ⚠️ Free Render instances sleep after 15 min of inactivity and take ~30s to wake.
> Upgrade to the $7/mo "Starter" plan if you want instant response every time.

---

## Part 2 — Deploy the Frontend (Netlify, free)

### 1. Edit frontend/index.html
Change line near the top:
```js
const BACKEND_URL = 'https://YOUR-BACKEND.onrender.com';
```
Replace with your actual Render service URL.

### 2. Deploy
```bash
# Option A: Netlify drag-and-drop
# Just drag the frontend/ folder to app.netlify.com/drop

# Option B: Netlify CLI
npm install -g netlify-cli
cd frontend/
netlify deploy --prod --dir .
```

Share the resulting URL with your viewers in chat!

---

## Part 3 — Cloudflare Tunnel (exposes your local PC)

### 1. Install cloudflared
```bash
# Windows (winget)
winget install Cloudflare.cloudflared

# Mac
brew install cloudflare/cloudflare/cloudflared

# Linux
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared-linux-amd64
sudo mv cloudflared-linux-amd64 /usr/local/bin/cloudflared
```

### 2. Login
```bash
cloudflared tunnel login
```
A browser window opens. Log in to your free Cloudflare account.

### 3. Create tunnel
```bash
cloudflared tunnel create stream-overlay
# Note the tunnel ID it prints
```

### 4. Configure
Create `~/.cloudflared/config.yml`:
```yaml
tunnel: YOUR-TUNNEL-ID
credentials-file: /home/YOUR_USER/.cloudflared/YOUR-TUNNEL-ID.json

ingress:
  - hostname: overlay.yourdomain.com   # OR use a free trycloudflare.com URL (see below)
    service: http://localhost:3847
  - service: http_status:404
```

> **No domain?** Use a quick tunnel instead (no config needed, URL changes each run):
> ```bash
> cloudflared tunnel --url http://localhost:3847
> ```
> It'll print a URL like `https://random-words.trycloudflare.com` — use that as `OVERLAY_URL` in Render.
> Run this every time you stream and update the env var. (A bit annoying — getting a free domain is easier.)

### 5. Free domain options
- **Freenom** (.tk, .ml domains — free)
- **duckdns.org** — free subdomain, needs a CNAME trick
- Buy a cheap `.xyz` domain for ~$1/year on Namecheap

### 6. Run tunnel (auto-start with Windows)
```bash
cloudflared tunnel run stream-overlay

# Auto-start on Windows
cloudflared service install
```

---

## Part 4 — Update & Run the Overlay

### 1. Replace main.js in your stream-overlay folder
Copy `overlay-update/main.js` → `stream-overlay/main.js`

### 2. Set OVERLAY_SECRET (must match Render env var)
```bash
# Windows — set in a .env file or run as:
set OVERLAY_SECRET=mySecret123 && npm start

# Mac/Linux
OVERLAY_SECRET=mySecret123 npm start
```

Or create a `.env` file in the stream-overlay folder and use `dotenv`:
```
OVERLAY_SECRET=mySecret123
OVERLAY_PORT=3847
```

---

## Part 5 — Test the full pipeline

```bash
# 1. Start overlay
cd stream-overlay/ && npm start

# 2. Run Cloudflare Tunnel
cloudflared tunnel run stream-overlay

# 3. Test end-to-end
curl -X POST https://YOUR-BACKEND.onrender.com/submit \
  -F "title=TestUser" \
  -F "message=Hello from the pipeline!"

# Should appear on screen after DELAY_MS milliseconds
```

---

## NSFW Tuning

Edit in `backend/server.js`:
```js
const NSFW_THRESHOLDS = {
  Porn:   0.60,  // lower = stricter
  Sexy:   0.80,  // raise if too many false positives on avatars
  Hentai: 0.60,
};
```

**Common false positives:** swimsuit avatars, beach photos. Raise `Sexy` threshold to 0.90 if needed.

NsfwJS categories:
- `Porn` — explicit sexual content
- `Sexy` — suggestive/revealing
- `Hentai` — drawn adult content
- `Neutral` — safe (always allowed)
- `Drawing` — art/illustration (always allowed)

---

## Architecture Summary

```
frontend/index.html      Viewer form — host on Netlify (free)
backend/server.js        NsfwJS + delay queue — host on Render (free)
overlay-update/main.js   Updated Electron overlay with secret auth
cloudflared              Exposes localhost:3847 to the internet
```

Total monthly cost: **$0** (or $7/mo if you want Render to never sleep)
