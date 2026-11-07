const fs = require('fs');
const path = require('path');

// Render diskinde kalıcı log ve yedek klasörü
const LOGS_DIR = path.join(__dirname, 'logs');
const HESAPLAR_DIR = path.join(LOGS_DIR, 'hesaplar');
const ACTIVITY_LOG = path.join(LOGS_DIR, 'oyun_ve_hesap_hareketleri.log');
const MASTER_DB = path.join(LOGS_DIR, 'accounts.json');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(HESAPLAR_DIR)) fs.mkdirSync(HESAPLAR_DIR, { recursive: true });

function getDB() {
  if (fs.existsSync(MASTER_DB)) {
    try { return JSON.parse(fs.readFileSync(MASTER_DB, 'utf8') || '{}'); } catch (e) { return {}; }
  }
  return {};
}

function saveDB(db) {
  fs.writeFileSync(MASTER_DB, JSON.stringify(db, null, 2), 'utf8');
}

// 1. YENİ AÇILAN HESABI KAYDEDEN VE LOGLAYAN FONKSİYON
function logNewAccount(data) {
  const { username, password, character, worlds, servers, settings } = data;
  if (!username) return;

  const db = getDB();
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const isoTime = new Date().toISOString();
  const safeName = username.replace(/[^a-zA-Z0-9_\-]/g, '_');

  const accountObj = {
    username,
    pass: password || '',
    registeredAt: isoTime,
    lastActiveAt: isoTime,
    character: character || null,
    worlds: worlds || [],
    servers: servers || [],
    settings: settings || { ram: '2', renderDist: '1', showFps: true }
  };

  // A) Ana accounts.json dosyasına yaz
  db[username] = accountObj;
  saveDB(db);

  // B) logs/hesaplar/<kullanici>_hesap.json olarak tekil dosya yaz
  const singleFile = path.join(HESAPLAR_DIR, `${safeName}_hesap.json`);
  fs.writeFileSync(singleFile, JSON.stringify(accountObj, null, 2), 'utf8');

  // C) logs/oyun_ve_hesap_hareketleri.log dosyasına dökümü ekle
  const logEntry = `================================================================================
[${now}] [RENDER LOG] [YENİ HESAP AÇILDI]
Kullanıcı Adı : ${username}
Şifre         : ${password}
Kayıt Tarihi  : ${isoTime}
Dosya Konumu  : logs/hesaplar/${safeName}_hesap.json

HESAP KODLARI (RAW JSON):
${JSON.stringify(accountObj, null, 2)}
================================================================================\n\n`;

  fs.appendFileSync(ACTIVITY_LOG, logEntry, 'utf8');
  console.log(`[RENDER] [+] Yeni hesap oluşturuldu: ${username} (Şifre: ${password})`);
}

// 2. OYUNCUNUN YAPTIKLARINI (BLOKLAR, DÜNYA, KARAKTER) ANINDA KAYDEDEN VE KORUYAN FONKSİYON
function logPlayerActivity(data) {
  const { username, worlds, character, servers, settings } = data;
  if (!username) return;

  const db = getDB();
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const isoTime = new Date().toISOString();
  const safeName = username.replace(/[^a-zA-Z0-9_\-]/g, '_');

  if (!db[username]) {
    db[username] = { username, pass: '', registeredAt: isoTime };
  }

  // Değişen dünyaları, blokları ve karakteri hesaba işle
  if (worlds) db[username].worlds = worlds;
  if (character) db[username].character = character;
  if (servers) db[username].servers = servers;
  if (settings) db[username].settings = settings;
  db[username].lastActiveAt = isoTime;

  saveDB(db);

  // Tekil hesap dosyasını da güncelle
  const singleFile = path.join(HESAPLAR_DIR, `${safeName}_hesap.json`);
  fs.writeFileSync(singleFile, JSON.stringify(db[username], null, 2), 'utf8');

  // Blok ve dünya ilerlemesini log dosyasına yaz
  let totalBlocks = 0;
  if (Array.isArray(worlds)) {
    worlds.forEach(w => {
      if (w.customBlocks) totalBlocks += Object.keys(w.customBlocks).length;
    });
  }

  const actLog = `[${now}] [OYUN KAYDI] Oyuncu: ${username} | Toplam Dünya: ${worlds ? worlds.length : 0} | Yerleştirilen/Kırılan Özel Blok: ${totalBlocks}\n`;
  fs.appendFileSync(ACTIVITY_LOG, actLog, 'utf8');
  console.log(`[RENDER] [✓] ${username} adlı oyuncunun ilerlemesi (dünyalar/bloklar) kaydedildi.`);
}

module.exports = {
  logNewAccount,
  logPlayerActivity,
  LOG_FILE: ACTIVITY_LOG,
  MASTER_DB
};
