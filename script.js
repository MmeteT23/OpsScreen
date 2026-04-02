// Socket
const socket = io();

// ===== Konuşan duyuru / hatırlatma (TTS) =====
let ttsVoices = [];
let reminderScrollPos = 0;
let remScrollRAF = null; 
let remScrollTimeout = null;

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  ttsVoices = window.speechSynthesis.getVoices() || [];
}
if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickTurkishVoice() {
  return (
    ttsVoices.find(v => (v.lang || "").toLowerCase().startsWith("tr")) ||
    ttsVoices.find(v => (v.lang || "").toLowerCase().includes("tr")) ||
    ttsVoices.find(v => /turkish|türkçe|turk/i.test(v.name || "")) ||
    null
  );
}
function hasTurkishVoice() {
  return !!pickTurkishVoice();
}

// ✅ Windows 8/8.1 tespiti (kısa yol)
function isWindows8Like() {
  const ua = navigator.userAgent || "";
  return ua.includes("Windows NT 6.2") || ua.includes("Windows NT 6.3");
}

// ✅ Bu cihazda TTS aktif mi?
// - Win8 ise kapat
// - ayrıca TR voice yoksa kapat
function isTTSEnabledHere() {
  if (!("speechSynthesis" in window)) return false;
  if (isWindows8Like()) return false;
  return hasTurkishVoice();
}

function normalizeTextForTurkishTTS(text = "") {
  let t = String(text);

  const map = [
    [/\bgate\b/gi, "geyt"],
    [/\bboarding\b/gi, "bording"],
    [/\bfinal call\b/gi, "faynıl kol"],
    [/\bcheck[- ]?in\b/gi, "çekin"],
    [/\bcrew\b/gi, "kru"],
    [/\bcaptain\b/gi, "kaptın"],
    [/\bslot\b/gi, "slot"],
    [/\bdelay\b/gi, "diley"],
    [/\bon time\b/gi, "on taym"],
    [/\btransfer\b/gi, "transfır"],
    [/\bsecurity\b/gi, "sikyuriti"],
    [/\bpassport\b/gi, "pasport"],
    [/\bstand\b/gi, "stend"],
    [/\bpushback\b/gi, "puşbek"],
    [/\bloadsheet\b/gi, "loadsit"],
    [/\bfuel\b/gi, "füel"],
    [/\bwifi\b/gi, "vayfay"],
    [/\bwi-fi\b/gi, "vayfay"],
    [/\brouter\b/gi, "rauter"],
    [/\bserver\b/gi, "servır"],
    [/\bupdate\b/gi, "apdeyt"],
    [/\bbackup\b/gi, "bekap"],
    [/\badmin\b/gi, "admin"],
    [/\bpanel\b/gi, "panel"],
    [/\bmobile\b/gi, "mobayl"],
    [/\bphone\b/gi, "fon"],
    [/\bqr\b/gi, "kü ar"],
    [/\bscan\b/gi, "sken"],
    [/\blink\b/gi, "link"],
    [/\bwarning\b/gi, "vorning"],
    [/\bcritical\b/gi, "kritik"],
    [/\bterminal\b/gi, "terminal"],
    [/\bcounter\b/gi, "kauntır"],
    [/\bstatus\b/gi, "siteytıs"],
    [/\bopen\b/gi, "ovpın"],
    [/\bclose\b/gi, "kıloz"],
    [/\bclosed\b/gi, "kılozd"],
  ];

  map.forEach(([regex, repl]) => {
    t = t.replace(regex, repl);
  });

  t = t.replace(/\b[A-ZÇĞİÖŞÜ]{2,}\b/g, m => m.toLowerCase());
  return t;
}

function speakTR(text, rate = 0.70, label = "TTS") {
  try {
    if (!isTTSEnabledHere()) return;

    const finalText = normalizeTextForTurkishTTS(text);

    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
    }

    setTimeout(() => {
      try {
        const msg = new SpeechSynthesisUtterance(finalText);
        msg.lang = "tr-TR";
        msg.rate = rate;
        msg.pitch = 1.0;
        msg.volume = 1.0;

        const trVoice = pickTurkishVoice();
        if (trVoice) msg.voice = trVoice;

        msg.onerror = (e) => console.warn(`${label} onerror:`, e);
        window.speechSynthesis.speak(msg);
      } catch (e) {
        console.warn(`${label} iç hata:`, e);
      }
    }, 140);
  } catch (err) {
    console.warn(`${label} hatası:`, err);
  }
}

function speakAnnouncement(text, type = "info") {
  if (!isTTSEnabledHere()) return;

  let prefix = "Yeni duyuru paylaşıldı.";
  let rate = 0.70;

  if (type === "warning") {
    prefix = "Dikkat, önemli duyuru.";
    rate = 0.70;
  }
  if (type === "critical") {
    prefix = "Kritik duyuru.";
    rate = 0.70;
  }

  let fullText = `${prefix} ${text}`;
  if (type === "warning") fullText = `${prefix} ... ${text}`;
  if (type === "critical") fullText = `${prefix} ... ... ${text}`;

  speakTR(fullText, rate, "Duyuru TTS");
}

function speakReminder(text, mode = "added") {
  if (!isTTSEnabledHere()) return;

  const prefix = mode === "read" ? "Hatırlatma okunuyor." : "Hatırlatma eklendi.";
  speakTR(`${prefix} ... ${text}`, 0.99, "Hatırlatma TTS");
}

// DOM
const clockEl         = document.getElementById('clock');
const weatherEl       = document.getElementById('weather');
const newsEl          = document.getElementById('news-ticker');
const announcementEl  = document.getElementById('announcement');
const soundEl         = document.getElementById('notification-sound');
const remindersListEl = document.getElementById('remindersList');

let highlightedReminderId = null;
let reminderHighlightTimer = null;

// ===== Reminders Auto Scroll (yavaş git-gel) =====

let remScrollDir = 1;              // 1 aşağı, -1 yukarı
let remScrollPauseUntil = 0;
let remScrollLastTs = 0;

// Bu değişkenler fonksiyonun DIŞINDA, en üstte durmalı

// 1. Değişkenleri en üstte, fonksiyonların dışında tanımla
 // 🔴 YENİ: Zamanlayıcıyı takip etmek için

// 2. Durdurma fonksiyonunu güncelle
function stopRemindersAutoScroll() {
  if (remScrollRAF) {
    cancelAnimationFrame(remScrollRAF);
    remScrollRAF = null;
  }
  if (remScrollTimeout) {
    clearTimeout(remScrollTimeout); // 🔴 KRİTİK: Bekleyen zamanlayıcıyı iptal et
    remScrollTimeout = null;
  }
}

// 3. Başlatma fonksiyonunu güncelle
function startRemindersAutoScroll() {
  // Önce her şeyi (hem animasyonu hem bekleyen timer'ı) durdur
  stopRemindersAutoScroll();

  const el = document.getElementById('remindersList');
  if (!el) return;

  // Sıfırlama
  el.dataset.isCloned = "false";
  el.scrollTop = 0;
  reminderScrollPos = 0;

  // Yeni zamanlayıcıyı değişkene ata
  remScrollTimeout = setTimeout(() => {
    const originalHeight = el.scrollHeight;
    const containerHeight = el.clientHeight;

    // Taşma yoksa çalışma
    if (originalHeight <= containerHeight + 10) return;

    // Klonlama
    if (el.dataset.isCloned !== "true") {
      el.innerHTML += el.innerHTML;
      el.dataset.isCloned = "true";
    }

    const speed = 0.2; // Sabit hız

    const step = () => {
      reminderScrollPos += speed;

      if (reminderScrollPos >= originalHeight) {
        reminderScrollPos = 0;
      }

      el.scrollTop = reminderScrollPos;
      remScrollRAF = requestAnimationFrame(step);
    };

    remScrollRAF = requestAnimationFrame(step);
  }, 400); // DOM'un tam oturması için ideal süre
}
function triggerReminderHighlight(id) {
  highlightedReminderId = Number(id);
  loadReminders();

  if (reminderHighlightTimer) clearTimeout(reminderHighlightTimer);
  reminderHighlightTimer = setTimeout(() => {
    highlightedReminderId = null;
    loadReminders();
  }, 5000);
}

function applyAnnouncementStyle(type) {
  announcementEl.classList.remove('info', 'warning', 'critical');
  announcementEl.classList.add(type || 'info');
}

// QR
async function loadAdminQR() {
  try {
    const img = document.getElementById("adminQR");
    if (!img) return;
    const r = await fetch("/api/admin-qr", { cache: "no-store" });
    const j = await r.json();
    if (j && j.qr) img.src = j.qr;
  } catch {}
}
setInterval(loadAdminQR, 10000);
loadAdminQR();

// Saat
function tickClock() {
  const now = new Date();
  const local = now.toLocaleTimeString('tr-TR', { hour12: false });
  const utc = now.toUTCString().split(' ')[4];
  clockEl.textContent = `${local} •  ${utc}`;
}
setInterval(tickClock, 1000);
tickClock();

// Hava
const WMO = {
  0:'☀️', 1:'🌤️', 2:'⛅', 3:'☁️', 45:'🌫️', 48:'🌫️',
  51:'🌦️', 53:'🌦️', 55:'🌧️', 61:'🌧️', 63:'🌧️', 65:'🌧️',
  71:'❄️', 73:'❄️', 75:'❄️', 95:'⛈️', 96:'⛈️', 99:'⛈️'
};

async function fetchWeather() {
  try {
    const lat = 36.8841, lon = 30.7056;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`);
    const j = await r.json();
    const t = Math.round(j?.current?.temperature_2m ?? 0);
    const c = j?.current?.weather_code;
    const icon = WMO[c] || '🌡️';
    weatherEl.textContent = `Antalya: ${t}°C ${icon}`;
  } catch {
    weatherEl.textContent = 'Antalya: --°C';
  }
}
fetchWeather();
setInterval(fetchWeather, 10 * 60 * 1000);

// Haber
async function fetchNews() {
  try {
    const res = await fetch('/proxy');
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const items = [...doc.querySelectorAll('item')].slice(0, 20);
    const titles = items.map(i => i.querySelector('title')?.textContent?.trim()).filter(Boolean);
    newsEl.textContent = titles.join('  ●  ');
  } catch {
    newsEl.textContent = 'Haberler alınamadı';
  }
}
fetchNews();
setInterval(fetchNews, 2* 60 * 1000);
async function loadLatestAnnouncement() {
  try {
    const res = await fetch('/api/duyurular');
    const list = await res.json();
    if (list && list.length > 0) {
      const duyuru = list[0]; // En son duyuru
      announcementEl.textContent = duyuru.text;
      announcementEl.classList.add('breathing');
      applyAnnouncementStyle(duyuru.type);
      setTimeout(() => { fitAnnouncementText(announcementEl); }, 10);
    }
  } catch (e) {
    console.error("Duyuru yüklenemedi:", e);
  }
}
loadLatestAnnouncement();

function syncNewsTicker() {
  if (newsTickerWidth > 0) {
    const containerWidth = window.innerWidth;
    const totalWidth = newsTickerWidth + containerWidth;
    const speed = 0.05; // Hız ayarı
    
    // Date.now() kullanarak her cihazda aynı ofseti hesapla
    const timeOffset = (Date.now() * speed) % totalWidth;
    newsTickerOffset = containerWidth - timeOffset;
    
    newsEl.style.transform = `translateX(${newsTickerOffset}px)`;
  }
  requestAnimationFrame(syncNewsTicker);
}

fetchNews();
setInterval(fetchNews, 2 * 60 * 1000);
requestAnimationFrame(syncNewsTicker);


// Medya
async function loadCurrentMedia() {
  try {
    const j = await (await fetch('/api/current-image')).json();
    const img = document.getElementById('custom-image');
    const vid = document.getElementById('custom-video');
    if (img) { img.style.display = 'none'; img.src = ''; }
    if (vid) { vid.style.display = 'none'; vid.src = ''; }
    if (!j?.url) return;
    if (j.mediaType === 'video') {
      if (vid) { vid.src = j.url; vid.style.display = 'block'; vid.play().catch(() => {}); }
    } else {
      if (img) { img.src = j.url; img.style.display = 'block'; }
    }
  } catch {}
}
// Hatırlatmalar (render + auto-scroll)
async function loadReminders() {
  try {
    const r = await fetch('/api/reminders');
    const list = await r.json();

    remindersListEl.innerHTML = '';

    if (!list.length) {
      remindersListEl.innerHTML = '<div class="reminder-item ghost">Henüz hatırlatma yok.</div>';
      stopRemindersAutoScroll();
      return;
    }

    list.forEach(it => {
      const div = document.createElement('div');
      div.className = 'reminder-item';
      div.textContent = it.text;

      if (Number(it.id) === highlightedReminderId) {
        div.classList.add('highlight-reminder');
      }

      remindersListEl.appendChild(div);
    });

    // ✅ liste basıldıktan sonra otomatik scroll başlat
    startRemindersAutoScroll();

  } catch {
    remindersListEl.innerHTML = '<div class="reminder-item ghost">Hatırlatmalar yüklenemedi.</div>';
    stopRemindersAutoScroll();
  }
}
loadReminders();
setInterval(loadReminders, 60 * 1000);

// === GÖRSEL / VIDEO (KUTUSUZ)
async function loadCurrentMedia() {
  try {
    const j = await (await fetch('/api/current-image')).json();

    const img = document.getElementById('custom-image');
    const vid = document.getElementById('custom-video');

    if (img) {
      img.style.display = 'none';
      img.removeAttribute('src');
    }

    if (vid) {
      try { vid.pause(); } catch {}
      vid.style.display = 'none';
      vid.removeAttribute('src');
      vid.load();
    }

    if (!j?.url) return;

    const mediaType = j.mediaType || 'image';
    const versionedUrl = `${j.url}?v=${Date.now()}`;

    if (mediaType === 'video') {
      if (vid) {
        vid.src = versionedUrl;
        vid.style.display = 'block';
        vid.play().catch(err => console.warn('Video autoplay hatası:', err));
      }
    } else {
      if (img) {
        img.src = versionedUrl;
        img.style.display = 'block';
      }
    }
  } catch (e) {
    console.warn('Medya yükleme hatası:', e);
  }
}
loadCurrentMedia();
socket.on('imageUpdated', loadCurrentMedia);

// Duyuru
// 🔴 YAZIYI KUTUYA SIĞDIRAN FONKSİYON
function fitAnnouncementText(el) {
  let fontSize = 48; // En büyük font boyutu (CSS'teki ile aynı olmalı)
  el.style.fontSize = fontSize + 'px';

  // Yazı kutunun yüksekliğinden (clientHeight) büyük olduğu sürece fontu küçült
  // Alt limit olarak 18px belirledik (okunabilirlik için)
  while (el.scrollHeight > el.clientHeight && fontSize > 18) {
    fontSize -= 2;
    el.style.fontSize = fontSize + 'px';
  }
}

// 🔴 SOCKET OLAYINI GÜNCELLEYİN
socket.on('yeniDuyuru', (duyuru) => {
  announcementEl.textContent = duyuru.text;
  announcementEl.classList.add('breathing');
  applyAnnouncementStyle(duyuru.type);

  // Yazıyı sığdırmak için fonksiyonu çağır
  // DOM'un güncellenmesi için milisaniyelik bir gecikme iyidir
  setTimeout(() => {
    fitAnnouncementText(announcementEl);
  }, 10);

  // Ses ve TTS işlemleri aynı kalabilir...
  try {
    if (soundEl) {
      soundEl.currentTime = 0;
      soundEl.play().catch(err => console.warn("Ses çalmadı:", err));
    }
  } catch (e) {}

  setTimeout(() => {
    speakAnnouncement(duyuru.text, duyuru.type);
  }, 250);
});
function resetAnnouncement() {
  announcementEl.textContent = 'Duyuru bekleniyor...';
  announcementEl.classList.remove('breathing');
  applyAnnouncementStyle('info');
}
socket.on('duyurularGuncellendi', resetAnnouncement);

// Hatırlatma eventleri
socket.on('remindersChanged', loadReminders);
socket.on('reminderAdded', (reminder) => {
  if (reminder?.id) triggerReminderHighlight(reminder.id);
  if (reminder?.text) speakReminder(reminder.text, "added");
});
socket.on('reminderSpeak', (reminder) => {
  if (reminder?.id) triggerReminderHighlight(reminder.id);
  if (reminder?.text) speakReminder(reminder.text, "read");
});

// Sabit çözünürlük ölçekleme
(function stageScaleV2() {
  const BASE_W = 1920, BASE_H = 1080;
  if (!document.getElementById('announcement')) return;
  if (document.getElementById('app-stage')) return;

  function setup() {
    const body = document.body;
    const scripts = Array.from(body.querySelectorAll('script'));
    const moveThese = Array.from(body.childNodes).filter(
      n => !(n.nodeType === 1 && n.tagName === 'SCRIPT')
    );

    const frame = document.createElement('div');
    frame.id = 'app-frame';
    frame.style.position = 'fixed';
    frame.style.inset = '0';
    frame.style.overflow = 'hidden';
    frame.style.zIndex = '0';

    const stage = document.createElement('div');
    stage.id = 'app-stage';
    stage.style.position = 'absolute';
    stage.style.width = BASE_W + 'px';
    stage.style.height = BASE_H + 'px';
    stage.style.transformOrigin = 'top left';
    stage.style.willChange = 'transform';

    moveThese.forEach(n => stage.appendChild(n));
    frame.appendChild(stage);
    body.insertBefore(frame, scripts[0] || null);

    const ticker = stage.querySelector('.news-ticker');
    if (ticker) {
      ticker.style.position = 'absolute';
      ticker.style.left = '0';
      ticker.style.right = '0';
      ticker.style.bottom = '0';
      ticker.style.width = BASE_W + 'px';
    }

    body.style.margin = '0';

    function onResize() {
      const rw = window.innerWidth / BASE_W;
      const rh = window.innerHeight / BASE_H;
      const scale = Math.min(rw, rh);

      stage.style.transform = `scale(${scale})`;

      const x = (window.innerWidth - BASE_W * scale) / 2;
      const y = (window.innerHeight - BASE_H * scale) / 2;

      stage.style.left = `${x}px`;
      stage.style.top = `${y}px`;
    }

    window.addEventListener('resize', onResize);
    onResize();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();

// Ses izinleri warm-up
document.addEventListener("click", () => {
  try {
    if (soundEl) {
      soundEl.muted = true;
      soundEl.play()
        .then(() => {
          soundEl.pause();
          soundEl.currentTime = 0;
          soundEl.muted = false;
        })
        .catch(() => {
          soundEl.muted = false;
        });
    }

    if (isTTSEnabledHere()) {
      const warmup = new SpeechSynthesisUtterance(" ");
      warmup.volume = 0;
      window.speechSynthesis.speak(warmup);
      window.speechSynthesis.cancel();
    }
  } catch {}
}, { once: true });
