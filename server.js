import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import multer from 'multer';
import basicAuth from "express-basic-auth";
import QRCode from "qrcode";
import { spawn } from "child_process";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

const IS_RENDER = Boolean(process.env.RENDER);
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  (process.env.RENDER_EXTERNAL_URL ? `https://${process.env.RENDER_EXTERNAL_URL}` : null);

// === ADMIN KORUMA
const ADMIN_USER = process.env.ADMIN_USER || "celebi";
const ADMIN_PASS = process.env.ADMIN_PASS || "chs2026*";

const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true
});

let tunnelURL = null;
let tunnelProc = null;

// === TRY CLOUDFLARE
function startTryCloudflare() {
  if (tunnelProc) return;

  tunnelProc = spawn("cloudflared", ["tunnel", "--url", "http://localhost:3000"], {
    shell: true,
    windowsHide: true
  });

  const onData = (buf) => {
    const s = buf.toString();
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m) tunnelURL = m[0];
  };

  tunnelProc.stdout.on("data", onData);
  tunnelProc.stderr.on("data", onData);

  tunnelProc.on("close", () => {
    tunnelProc = null;
    tunnelURL = null;
    setTimeout(startTryCloudflare, 5000);
  });
}
if (!IS_RENDER && !PUBLIC_BASE_URL) startTryCloudflare();

app.get("/api/admin-qr", async (_req, res) => {
  try {
    const baseUrl = PUBLIC_BASE_URL || tunnelURL;
    if (!baseUrl) return res.json({ url: null, qr: null, status: "waiting_tunnel" });

    const adminURL = baseUrl + "/admin.html";
    const qr = await QRCode.toDataURL(adminURL, { margin: 1, width: 220 });
    return res.json({ url: adminURL, qr, status: "ok" });
  } catch {
    return res.status(500).json({ url: null, qr: null, status: "qr_failed" });
  }
});

app.get("/api/tunnel-url", (_req, res) => {
  res.json({ url: PUBLIC_BASE_URL || tunnelURL });
});

// /admin korumalı
app.use(["/admin", "/admin.html"], adminAuth);

// Admin API koruması (TV ekranında gereken GET'ler açık)
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/admin-qr")) return next();

  const openGets = [
    "/duyurular",
    "/reminders",
    "/current-image",
    "/media-list",
    "/media-settings",
    "/tunnel-url",
    "/tts"
  ];

  if (req.method === "GET" && openGets.some(p => req.path.startsWith(p))) {
    return next();
  }

  return adminAuth(req, res, next);
});

const server = createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname));

// === Dosyalar
const DUYURULAR_PATH      = path.join(__dirname, 'duyurular.json');
const REMINDERS_PATH      = path.join(__dirname, 'reminders.json');
const CURRENT_IMAGE_JSON  = path.join(__dirname, 'current-image.json'); // geriye uyum için
const MEDIA_LIST_PATH     = path.join(__dirname, 'media-playlist.json');
const MEDIA_SETTINGS_PATH = path.join(__dirname, 'media-settings.json');
const UPLOAD_DIR          = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readJSON(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Başlangıç
if (!fs.existsSync(DUYURULAR_PATH)) writeJSON(DUYURULAR_PATH, []);
if (!fs.existsSync(REMINDERS_PATH)) writeJSON(REMINDERS_PATH, []);
if (!fs.existsSync(MEDIA_LIST_PATH)) writeJSON(MEDIA_LIST_PATH, []);
if (!fs.existsSync(MEDIA_SETTINGS_PATH)) {
  writeJSON(MEDIA_SETTINGS_PATH, {
    enabled: true,
    intervalSec: 12,
    activeId: null,
    lastSwitchAt: Date.now()
  });
}
if (!fs.existsSync(CURRENT_IMAGE_JSON)) {
  writeJSON(CURRENT_IMAGE_JSON, { url: null, mediaType: "image" });
}

// Multer (resim + video)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = path.basename(file.originalname || "media", ext)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype || "";
    if (mime.startsWith("image/") || mime.startsWith("video/")) return cb(null, true);
    cb(new Error("Sadece resim veya video yüklenebilir"));
  }
});

// Yardımcılar
function getMediaSettings() {
  return readJSON(MEDIA_SETTINGS_PATH, {
    enabled: true,
    intervalSec: 12,
    activeId: null,
    lastSwitchAt: Date.now()
  });
}
function setMediaSettings(patch = {}) {
  const curr = getMediaSettings();
  const next = { ...curr, ...patch };
  writeJSON(MEDIA_SETTINGS_PATH, next);
  return next;
}
function getMediaList() {
  return readJSON(MEDIA_LIST_PATH, []);
}

function getActiveMedia() {
  const list = getMediaList();
  const settings = getMediaSettings();

  if (!list.length) return null;

  let active = list.find(x => String(x.id) === String(settings.activeId));
  if (!active) active = list[0];

  return active;
}

function syncCurrentMediaCompat() {
  const active = getActiveMedia();
  if (!active) {
    writeJSON(CURRENT_IMAGE_JSON, { url: null, mediaType: "image" });
    return null;
  }

  const compat = {
    url: active.url,
    mediaType: active.mediaType || "image",
    mime: active.mime || "",
    uploadedAt: active.createdAt || Date.now(),
    id: active.id
  };
  writeJSON(CURRENT_IMAGE_JSON, compat);
  return compat;
}

function emitMediaUpdate() {
  const active = syncCurrentMediaCompat();
  io.emit("imageUpdated", active || { url: null, mediaType: "image" });
  io.emit("mediaPlaylistUpdated", {
    activeId: active?.id || null,
    settings: getMediaSettings()
  });
}

function rotateMediaIfNeeded() {
  const list = getMediaList();
  if (list.length < 2) return;

  const settings = getMediaSettings();
  if (!settings.enabled) return;

  const intervalMs = Math.max(3, Number(settings.intervalSec) || 12) * 1000;
  const now = Date.now();
  const last = Number(settings.lastSwitchAt) || 0;

  if (now - last < intervalMs) return;

  let idx = list.findIndex(x => String(x.id) === String(settings.activeId));
  if (idx < 0) idx = 0;

  const nextIdx = (idx + 1) % list.length;
  const nextItem = list[nextIdx];

  setMediaSettings({
    activeId: nextItem.id,
    lastSwitchAt: now
  });

  emitMediaUpdate();
}
setInterval(rotateMediaIfNeeded, 1000);

// === SAYFALAR
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// === DUYURULAR
app.get('/api/duyurular', (_req, res) => {
  res.json(readJSON(DUYURULAR_PATH, []));
});

app.post('/api/duyurular', (req, res) => {
  const { text, type } = req.body || {};
  if (!text || !type) return res.status(400).json({ error: 'text ve type zorunludur' });

  const list = readJSON(DUYURULAR_PATH, []);
  const yeni = {
    id: Date.now(),
    text: String(text).trim(),
    type,
    createdAt: new Date().toISOString()
  };

  list.unshift(yeni);
  writeJSON(DUYURULAR_PATH, list);

  io.emit('yeniDuyuru', yeni);
  res.json({ ok: true, item: yeni });
});

app.delete('/api/duyurular/:id', (req, res) => {
  const id = String(req.params.id);
  const list = readJSON(DUYURULAR_PATH, []);
  const filtered = list.filter(x => String(x.id) !== id);

  writeJSON(DUYURULAR_PATH, filtered);
  io.emit('duyurularGuncellendi');

  res.json({ ok: true });
});

// === HATIRLATMALAR
app.get('/api/reminders', (_req, res) => {
  res.json(readJSON(REMINDERS_PATH, []));
});

app.post('/api/reminders', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text zorunlu' });

  const list = readJSON(REMINDERS_PATH, []);
  const item = {
    id: Date.now(),
    text: String(text).trim(),
    createdAt: new Date().toISOString()
  };

  list.unshift(item);
  writeJSON(REMINDERS_PATH, list);

  io.emit('remindersChanged');
  io.emit('reminderAdded', item);

  res.json({ ok: true, item });
});

app.delete('/api/reminders/:id', (req, res) => {
  const id = String(req.params.id);
  const list = readJSON(REMINDERS_PATH, []);
  const filtered = list.filter(x => String(x.id) !== id);

  writeJSON(REMINDERS_PATH, filtered);
  io.emit('remindersChanged');

  res.json({ ok: true });
});

app.post('/api/reminders/:id/speak', (req, res) => {
  const id = String(req.params.id);
  const list = readJSON(REMINDERS_PATH, []);
  const item = list.find(x => String(x.id) === id);

  if (!item) return res.status(404).json({ ok: false, error: 'Hatırlatma bulunamadı' });

  io.emit('reminderSpeak', item);
  res.json({ ok: true, item });
});

// === MEDYA PLAYLIST
app.get('/api/media-list', (_req, res) => {
  res.json({
    items: getMediaList(),
    settings: getMediaSettings()
  });
});

app.get('/api/media-settings', (_req, res) => {
  res.json(getMediaSettings());
});

app.post('/api/media-settings', (req, res) => {
  let { enabled, intervalSec } = req.body || {};
  const patch = {};

  if (typeof enabled === "boolean") patch.enabled = enabled;
  if (intervalSec !== undefined) {
    const n = Math.max(3, Math.min(600, Number(intervalSec) || 12));
    patch.intervalSec = n;
  }

  patch.lastSwitchAt = Date.now();

  const next = setMediaSettings(patch);
  io.emit("mediaPlaylistUpdated", { settings: next, activeId: next.activeId });

  res.json({ ok: true, settings: next });
});

app.post('/api/media-upload', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Dosya yüklenemedi' });

  const mime = req.file.mimetype || "";
  const mediaType = mime.startsWith("video/") ? "video" : "image";

  const item = {
    id: Date.now(),
    name: req.file.originalname || req.file.filename,
    fileName: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    mime,
    mediaType,
    createdAt: Date.now()
  };

  const list = getMediaList();
  list.unshift(item);
  writeJSON(MEDIA_LIST_PATH, list);

  const settings = getMediaSettings();
  if (!settings.activeId) {
    setMediaSettings({ activeId: item.id, lastSwitchAt: Date.now() });
  }

  emitMediaUpdate();

  res.json({ ok: true, item });
});

app.post('/api/media-list/:id/activate', (req, res) => {
  const id = String(req.params.id);
  const list = getMediaList();
  const item = list.find(x => String(x.id) === id);

  if (!item) return res.status(404).json({ ok: false, error: 'Medya bulunamadı' });

  const settings = setMediaSettings({
    activeId: item.id,
    lastSwitchAt: Date.now()
  });

  emitMediaUpdate();
  res.json({ ok: true, item, settings });
});

app.delete('/api/media-list/:id', (req, res) => {
  const id = String(req.params.id);
  const list = getMediaList();
  const item = list.find(x => String(x.id) === id);
  const filtered = list.filter(x => String(x.id) !== id);

  writeJSON(MEDIA_LIST_PATH, filtered);

  if (item?.fileName) {
    const p = path.join(UPLOAD_DIR, item.fileName);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  const settings = getMediaSettings();
  if (!filtered.length) {
    setMediaSettings({ activeId: null, lastSwitchAt: Date.now() });
  } else if (String(settings.activeId) === id) {
    setMediaSettings({ activeId: filtered[0].id, lastSwitchAt: Date.now() });
  }

  emitMediaUpdate();
  res.json({ ok: true });
});

// Geriye uyumluluk (eski upload endpoint)
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Dosya yüklenemedi' });

  const mime = req.file.mimetype || "";
  const mediaType = mime.startsWith("video/") ? "video" : "image";

  const item = {
    id: Date.now(),
    name: req.file.originalname || req.file.filename,
    fileName: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    mime,
    mediaType,
    createdAt: Date.now()
  };

  const list = getMediaList();
  list.unshift(item);
  writeJSON(MEDIA_LIST_PATH, list);

  setMediaSettings({ activeId: item.id, lastSwitchAt: Date.now() });
  emitMediaUpdate();

  res.json({ ok: true, url: item.url, mediaType, item });
});

app.get('/api/current-image', (_req, res) => {
  const active = syncCurrentMediaCompat();
  res.json(active || { url: null, mediaType: "image" });
});

// (Opsiyonel) eSpeak endpoint duruyor ama artık tablet istemcisi kullanmıyor
const TTS_DIR = path.join(__dirname, "tts-cache");
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });

const ESPEAK_BIN =
  process.env.ESPEAK_BIN ||
  "C:\\Program Files (x86)\\eSpeak\\command_line\\espeak.exe";

app.get("/api/tts", (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    const rate = Math.max(0.6, Math.min(1.15, Number(req.query.rate || 0.95)));

    if (!text) return res.status(400).json({ ok: false, error: "text zorunlu" });

    const key = crypto
      .createHash("sha1")
      .update(`espeak-tr|${rate}|${text}`)
      .digest("hex");

    const outFile = path.join(TTS_DIR, `${key}.wav`);

    if (fs.existsSync(outFile)) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return fs.createReadStream(outFile).pipe(res);
    }

    const speed = Math.round(175 * rate);

    const args = [
      "-v", "tr",
      "-s", String(speed),
      "-w", outFile,
      text
    ];

    const p = spawn(ESPEAK_BIN, args, { windowsHide: true });

    let stderr = "";
    p.stderr.on("data", d => (stderr += d.toString()));

    p.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(outFile)) {
        return res.status(500).json({
          ok: false,
          error: "espeak_failed",
          detail: stderr.slice(0, 600)
        });
      }

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      fs.createReadStream(outFile).pipe(res);
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: "tts_error" });
  }
});

// === Döviz
app.get('/api/doviz', async (_req, res) => {
  try {
    const r = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=TRY,EUR');
    const j = await r.json();
    const usd = j?.rates?.TRY, eur = j?.rates?.EUR;

    if (typeof usd !== 'number' || typeof eur !== 'number') {
      return res.status(502).json({ error: 'Kur bilgisi alınamadı' });
    }

    res.json({ usd, eur });
  } catch {
    res.status(500).json({ error: 'Döviz bilgisi hatası' });
  }
});

// === Haber proxy
app.get('/proxy', async (_req, res) => {
  const url = 'https://www.trthaber.com/manset_articles.rss';
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send('RSS alınamadı');

    const xml = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(xml);
  } catch {
    res.status(500).send('RSS hatası');
  }
});

// === Socket
io.on('connection', (socket) => {
  socket.emit("mediaPlaylistUpdated", {
    activeId: getMediaSettings().activeId,
    settings: getMediaSettings()
  });
});

// İlk medya sync
syncCurrentMediaCompat();

// === Sunucu
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server started on port ${PORT}`);
  if (PUBLIC_BASE_URL) {
    console.log(`🌍 Public URL: ${PUBLIC_BASE_URL}`);
  }
});