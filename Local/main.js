/**
 * stream-overlay / main.js  (updated)
 *
 * Changes from v1:
 *  - Optional X-Overlay-Secret header check so only your backend can push notifications
 *  - OVERLAY_SECRET env var support
 */

const { app, BrowserWindow, screen } = require('electron');
const express = require('express');
const http = require('http');
const path = require('path');

let overlayWindow = null;
const PORT = process.env.OVERLAY_PORT || 3847;
const SECRET = process.env.OVERLAY_SECRET || 'rekshot_secret_123';   // set this + same value in backend env

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function startAPIServer() {
  const expressApp = express();
  expressApp.use(express.json({ limit: '10mb' }));   // images come as base64

  expressApp.get('/ping', (_req, res) => res.json({ status: 'ok' }));

  expressApp.post('/notify', (req, res) => {
    // Validate secret if configured
    if (SECRET) {
      const incoming = req.headers['x-overlay-secret'];
      if (!incoming || incoming !== SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const { image, message, title } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    if (overlayWindow) {
      overlayWindow.webContents.send('steam-notification', {
        image: image || null,
        message,
        title: title || 'Steam',
        timestamp: Date.now(),
      });
    }
    res.json({ status: 'queued' });
  });

  http.createServer(expressApp).listen(PORT, 'localhost', () => {
    console.log(`[overlay] API listening on http://localhost:${PORT}`);
    if (SECRET) console.log('[overlay] Secret auth: enabled');
    else console.log('[overlay] Secret auth: disabled (set OVERLAY_SECRET to enable)');
  });
}

app.whenReady().then(() => {
  createOverlayWindow();
  startAPIServer();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
