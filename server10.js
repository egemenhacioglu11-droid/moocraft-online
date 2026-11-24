/**
 * MooCraft Ultimate 3D - Gelişmiş Yüksek FPS & Sıfır Gecikmeli Çok Oyunculu Sunucu (server.js)
 *
 * Öne Çıkan Özellikler:
 *  - 60 Hz (16.67ms) sabit adımlı yüksek çözünürlüklü anlık hareket & snapshot döngüsü
 *  - Otomatik kinematik hesaplama (vx, vy, vz, hız, yawRate, pitch, zıplama, düşme, eğilme, koşu, uçuş, kol savurma)
 *  - Karakter duruş şekli (pose) & ekipman (zırh, kalkan, eldeki eşya) tam senkronizasyonu
 *  - Akıllı 64x64 kostüm (skin) önbellekleme: hareket paketlerinden ağır base64 verisini ayıklayarak
 *    yüksek FPS ve minimum ağ gecikmesi sağlar; kostüm değiştiğinde veya periyodik anahtar karede senkronize eder
 *  - Gecikmesiz WebSocket iletimi (perMessageDeflate: false, httpCompression: false)
 *  - Tam yetkili OP sistemi: /server:03622 (gizli kod + socket + sohbet komutu yakalama) ile tam erişim (Seviye 4 OP)
 *  - Bloklamayan (asenkron atomik) kalıcı veri kaydı (ops.json, bans.json, accounts.json, world_blocks.json)
 *  - Anlık PvP hasar, geri itme (knockback), ölüm/yeniden doğma ve hitId tekilleştirme
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// =========================================================================
// YAPILANDIRMA & SABİTLER
// =========================================================================
const PORT = Number(process.env.PORT) || 3000;
const OP_SECRET_CODE = String(process.env.OP_SECRET_CODE || '03622').trim();
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;
const TICK_RATE = Math.min(120, Math.max(20, Number(process.env.TICK_RATE) || 60)); // Varsayılan 60 Hz (FPS)
const TICK_MS = 1000 / TICK_RATE;
const SKIN_KEYFRAME_INTERVAL_MS = 6000; // Geç gelen veya önbelleği düşen istemciler için güvenli tazeleme
const SNAPSHOT_HISTORY_SIZE = 20;

// Kalıcı veri dosyaları
const DATA_DIR = path.join(__dirname, 'server_data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const OPS_FILE = path.join(DATA_DIR, 'ops.json');
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const WORLD_BLOCKS_FILE = path.join(DATA_DIR, 'world_blocks.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// =========================================================================
// ASENKRON ATOMİK JSON DEPOLAMA (EVENT LOOP BLOKLAMAZ)
// =========================================================================
function readJsonFileSync(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[Veri Okuma Hatası] ${filePath}:`, err.message);
  }
  return fallback;
}

const pendingWrites = new Map();
function scheduleJsonWrite(filePath, dataGetter, delayMs = 250) {
  if (pendingWrites.has(filePath)) {
    clearTimeout(pendingWrites.get(filePath).timer);
  }
  const timer = setTimeout(async () => {
    pendingWrites.delete(filePath);
    const tmpPath = `${filePath}.tmp`;
    try {
      const payload = typeof dataGetter === 'function' ? dataGetter() : dataGetter;
      await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      console.error(`[Veri Yazma Hatası] ${filePath}:`, err.message);
    }
  }, delayMs);
  pendingWrites.set(filePath, { timer });
}

let accounts = readJsonFileSync(ACCOUNTS_FILE, {});
let opsList = readJsonFileSync(OPS_FILE, []); // Küçük harfli kullanıcı adları listesi
let bansMap = readJsonFileSync(BANS_FILE, {}); // { [usernameLower]: { originalName, reason, bannedBy, date } }
const savedBlocksObj = readJsonFileSync(WORLD_BLOCKS_FILE, {});

// Ortam değişkeninden başlangıç OP'leri ekle (örn: INITIAL_OPS="admin,kurucu")
if (process.env.INITIAL_OPS) {
  let changed = false;
  process.env.INITIAL_OPS.split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .forEach(name => {
      if (!opsList.includes(name)) {
        opsList.push(name);
        changed = true;
      }
    });
  if (changed) {
    scheduleJsonWrite(OPS_FILE, () => opsList, 50);
  }
}

function isNameOp(name) {
  if (!name) return false;
  return opsList.includes(String(name).trim().toLowerCase());
}

function setNameOp(name, makeOp) {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return false;
  if (makeOp) {
    if (!opsList.includes(clean)) {
      opsList.push(clean);
      scheduleJsonWrite(OPS_FILE, () => opsList, 50);
    }
    return true;
  }
  const prevLen = opsList.length;
  opsList = opsList.filter(op => op !== clean);
  if (opsList.length !== prevLen) {
    scheduleJsonWrite(OPS_FILE, () => opsList, 50);
  }
  return false;
}

// =========================================================================
// YARDIMCI MATEMATİK & KİNEMATİK FONKSİYONLARI
// =========================================================================
function clampNum(val, fallback = 0) {
  return Number.isFinite(Number(val)) ? Number(val) : fallback;
}

function roundCoord(val, decimals = 4) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function shortHash(str) {
  if (!str) return null;
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 12);
}

function normalizeAngleDelta(curr, prev) {
  let d = curr - prev;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Oyuncunun mevcut kinematik ve durum verisinden ortak karakter duruşunu (pose) türetir.
 * Böylece karşı taraf yürüyüş, koşu, zıplama, düşme, eğilme (sneak), uçuş ve vuruş
 * duruşlarını birebir aynı şekilde görebilir.
 */
function resolvePlayerPose(p, incoming = {}) {
  const isSneaking = Boolean(
    incoming.isSneaking ?? incoming.sneaking ?? incoming.isCrouching ?? incoming.crouching ?? p.isSneaking
  );
  const isFlying = Boolean(
    incoming.isFlying ?? incoming.flying ?? p.isFlying
  );
  const isSwimming = Boolean(
    incoming.isSwimming ?? incoming.swimming ?? p.isSwimming
  );
  const isSwinging = Boolean(
    incoming.isSwinging ?? incoming.swinging ?? incoming.armSwing ?? p.isSwinging
  );
  const horizSpeed = Math.hypot(p.vx || 0, p.vz || 0);
  const isMoving = incoming.isMoving !== undefined ? Boolean(incoming.isMoving) : (horizSpeed > 0.08);
  const isSprinting = Boolean(
    incoming.isSprinting ?? incoming.sprinting ?? (horizSpeed > 5.6 && !isSneaking)
  );
  const onGround = incoming.onGround !== undefined
    ? Boolean(incoming.onGround)
    : (Math.abs(p.vy || 0) < 0.15);
  const isJumping = Boolean(incoming.isJumping ?? (!onGround && (p.vy || 0) > 0.45));
  const isFalling = Boolean(incoming.isFalling ?? (!onGround && (p.vy || 0) < -0.65));

  let pose = incoming.pose || null;
  if (!pose) {
    if (isFlying) pose = 'fly';
    else if (isSwimming) pose = 'swim';
    else if (isSneaking) pose = horizSpeed > 0.15 ? 'sneak_walk' : 'sneak';
    else if (isJumping) pose = 'jump';
    else if (isFalling) pose = 'fall';
    else if (isSprinting && horizSpeed > 0.25) pose = 'sprint';
    else if (horizSpeed > 0.12) pose = 'walk';
    else pose = 'idle';
  }

  return {
    pose,
    isMoving,
    isSneaking,
    isCrouching: isSneaking,
    isSprinting,
    isJumping,
    isFalling,
    onGround,
    isFlying,
    isSwimming,
    isSwinging,
    swingProgress: clampNum(incoming.swingProgress, p.swingProgress || 0),
    walkCycle: clampNum(incoming.walkCycle, p.walkCycle || 0)
  };
}

// =========================================================================
// EXPRESS & HTTP API
// =========================================================================
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS desteği (yerel HTML veya farklı portlardan bağlantılar için)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const files = fs.readdirSync(__dirname);
  const htmlFile =
    files.find(f => f.toLowerCase() === 'moocraft.pc.html') ||
    files.find(f => f.toLowerCase().endsWith('.html'));
  if (htmlFile) {
    return res.sendFile(path.join(__dirname, htmlFile));
  }
  res.send('MooCraft Çok Oyunculu Sunucusu (60 Hz) Aktif!');
});

// Sunucu performans & sağlık metriği
let serverTickCount = 0;
let measuredTps = TICK_RATE;

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    tickRate: TICK_RATE,
    measuredTps: roundCoord(measuredTps, 2),
    onlinePlayers: players.size,
    maxPlayers: MAX_PLAYERS,
    uptimeSec: Math.floor(process.uptime())
  });
});

// Sunucu listesi endpoint'i
app.get('/api/servers', (req, res) => {
  const host = req.get('host') || `localhost:${PORT}`;
  res.json([
    {
      id: 'moocraft_main',
      name: 'MooCraft Resmi Sunucu (60Hz Ultra Akıcı)',
      address: host,
      motd: '60 Hz Sıfır Gecikmeli Senkronizasyon & Tam Duruş Desteği',
      maxPlayers: MAX_PLAYERS,
      online: players.size,
      status: 'online',
      ping: 8,
      tickRate: TICK_RATE,
      version: '1.2',
      isServer: true
    }
  ]);
});

// Hesap Giriş API
app.post('/api/login', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) {
    return res.json({ success: false, message: 'Kullanıcı adı ve şifre gereklidir.' });
  }

  const key = username.toLowerCase();
  const banInfo = bansMap[key];
  if (banInfo) {
    return res.json({
      success: false,
      banned: true,
      banInfo,
      message: `Sunucudan yasaklandınız! Sebep: ${banInfo.reason || 'Yönetici kararı'}`
    });
  }

  const user = accounts[key];
  if (!user || user.pass !== password) {
    return res.json({ success: false, message: 'Hatalı kullanıcı adı veya şifre!' });
  }

  return res.json({
    success: true,
    user: {
      ...user,
      isOp: isNameOp(username)
    }
  });
});

// Hesap Kayıt API
app.post('/api/register', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || password.length < 3) {
    return res.json({ success: false, message: 'Geçerli kullanıcı adı ve en az 3 karakterli şifre girin.' });
  }

  const key = username.toLowerCase();
  if (accounts[key]) {
    return res.json({ success: false, message: 'Bu kullanıcı adı zaten kayıtlı!' });
  }

  const newUser = {
    username,
    pass: password,
    character: (req.body && req.body.character) || null,
    worlds: (req.body && req.body.worlds) || [],
    servers: (req.body && req.body.servers) || [],
    createdAt: new Date().toISOString()
  };

  accounts[key] = newUser;
  scheduleJsonWrite(ACCOUNTS_FILE, () => accounts, 100);
  return res.json({ success: true, user: newUser });
});

// =========================================================================
// SOCKET.IO & OYUN DURUMU
// =========================================================================
const server = http.createServer(app);
// TCP Nagle algoritmasını devre dışı bırak (her paket anında gönderilir)
server.on('connection', (tcpSocket) => {
  try {
    tcpSocket.setNoDelay(true);
  } catch (e) {}
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  maxHttpBufferSize: 10 * 1024 * 1024, // Özel 64x64 skin paketleri için 10MB
  perMessageDeflate: false, // Gecikmesiz anlık paket iletimi
  httpCompression: false,
  pingInterval: 5000,
  pingTimeout: 10000
});

// Aktif oyuncular: Map<socketId, PlayerState>
const players = new Map();

// Dünya durumu
const worldState = {
  time: 1000,
  weather: 'clear',
  blocks: new Map(Object.entries(savedBlocksObj || {})) // "x,y,z" -> blockData
};

function persistWorldBlocks() {
  scheduleJsonWrite(WORLD_BLOCKS_FILE, () => Object.fromEntries(worldState.blocks), 500);
}

// Tekrarlanan PvP vuruşlarını engellemek için kısa süreli hitId önbelleği
const recentHitIds = new Set();

function findPlayerByTarget(targetId, targetClientId, targetName) {
  if (targetId && players.has(targetId)) {
    return { socketId: targetId, player: players.get(targetId) };
  }
  const cleanName = targetName ? String(targetName).trim().toLowerCase() : '';
  for (const [sid, p] of players.entries()) {
    if (targetClientId && p.clientId === targetClientId) {
      return { socketId: sid, player: p };
    }
    if (cleanName && p.name && p.name.trim().toLowerCase() === cleanName) {
      return { socketId: sid, player: p };
    }
  }
  return null;
}

function findSocketsByName(targetName) {
  const clean = String(targetName || '').trim().toLowerCase();
  const matched = [];
  for (const [sid, p] of players.entries()) {
    if (p.name && p.name.trim().toLowerCase() === clean) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) matched.push({ sid, sock, player: p });
    }
  }
  return matched;
}

function isSocketOp(socket) {
  const p = players.get(socket.id);
  return Boolean(p && (p.isOp || isNameOp(p.name)));
}

function mergeCharacterData(existingPlayer, data) {
  if (!data) return false;
  let charObj = null;
  if (data.character && typeof data.character === 'object') {
    charObj = data.character;
  } else if (typeof data.character === 'string') {
    try { charObj = JSON.parse(data.character); } catch (e) {}
  }

  const skinStr = data.customSkin || data.skin || (charObj && charObj.customSkin) || null;
  const prevHash = existingPlayer.skinHash;

  if (charObj) {
    existingPlayer.character = charObj;
    if (skinStr && !existingPlayer.character.customSkin) {
      existingPlayer.character.customSkin = skinStr;
    }
  } else if (skinStr) {
    if (!existingPlayer.character || typeof existingPlayer.character !== 'object') {
      existingPlayer.character = {};
    }
    existingPlayer.character.customSkin = skinStr;
  }

  if (skinStr) {
    existingPlayer.customSkin = skinStr;
    existingPlayer.skin = skinStr;
  }

  const nextHash = shortHash(
    (existingPlayer.customSkin || '') + '|' + (existingPlayer.character ? JSON.stringify(existingPlayer.character) : '')
  );
  existingPlayer.skinHash = nextHash;
  return prevHash !== nextHash;
}

function buildPublicPlayerPayload(p, includeSkin = true) {
  const payload = {
    id: p.id,
    clientId: p.clientId,
    name: p.name,
    x: roundCoord(p.x, 4),
    y: roundCoord(p.y, 4),
    z: roundCoord(p.z, 4),
    vx: roundCoord(p.vx || 0, 3),
    vy: roundCoord(p.vy || 0, 3),
    vz: roundCoord(p.vz || 0, 3),
    yaw: roundCoord(p.yaw, 4),
    pitch: roundCoord(p.pitch || 0, 4),
    yawRate: roundCoord(p.yawRate || 0, 3),
    pose: p.pose || 'idle',
    isMoving: Boolean(p.isMoving),
    isSneaking: Boolean(p.isSneaking),
    isCrouching: Boolean(p.isSneaking),
    isSprinting: Boolean(p.isSprinting),
    isJumping: Boolean(p.isJumping),
    isFalling: Boolean(p.isFalling),
    onGround: p.onGround !== undefined ? Boolean(p.onGround) : true,
    isFlying: Boolean(p.isFlying),
    isSwimming: Boolean(p.isSwimming),
    isSwinging: Boolean(p.isSwinging),
    swingProgress: roundCoord(p.swingProgress || 0, 3),
    walkCycle: roundCoord(p.walkCycle || 0, 3),
    heldItem: p.heldItem || null,
    armor: p.armor || null,
    shield: p.shield || null,
    health: p.health,
    gamemode: p.gamemode,
    isOp: Boolean(p.isOp),
    opLevel: p.isOp ? 4 : 0,
    skinHash: p.skinHash || null,
    seq: p.seq || 0,
    serverTime: Date.now(),
    serverTick: serverTickCount
  };

  if (includeSkin) {
    payload.character = p.character || null;
    payload.customSkin = p.customSkin || null;
    payload.skin = p.skin || null;
  }
  return payload;
}

function createDefaultPlayerState(socketId, data = {}) {
  const playerName = String(data.name || 'Oyuncu').trim() || 'Oyuncu';
  const opStatus = isNameOp(playerName);
  return {
    id: socketId,
    clientId: data.clientId || null,
    name: playerName,
    x: clampNum(data.x, 0),
    y: clampNum(data.y, 40),
    z: clampNum(data.z, 0),
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: clampNum(data.yaw, 0),
    pitch: clampNum(data.pitch, 0),
    yawRate: 0,
    pose: data.pose || 'idle',
    isMoving: Boolean(data.isMoving),
    isSneaking: Boolean(data.isSneaking || data.sneaking),
    isCrouching: Boolean(data.isSneaking || data.sneaking),
    isSprinting: Boolean(data.isSprinting || data.sprinting),
    isJumping: Boolean(data.isJumping),
    isFalling: Boolean(data.isFalling),
    onGround: data.onGround !== undefined ? Boolean(data.onGround) : true,
    isFlying: Boolean(data.isFlying),
    isSwimming: Boolean(data.isSwimming),
    isSwinging: Boolean(data.isSwinging),
    swingProgress: clampNum(data.swingProgress, 0),
    walkCycle: clampNum(data.walkCycle, 0),
    character: null,
    customSkin: null,
    skin: null,
    skinHash: null,
    heldItem: data.heldItem || null,
    armor: data.armor || null,
    shield: data.shield || null,
    health: 20,
    gamemode: 'survival',
    isOp: opStatus,
    opLevel: opStatus ? 4 : 0,
    seq: 0,
    lastMoveHrNs: process.hrtime.bigint(),
    lastSkinKeyframeAt: Date.now(),
    dirtyMove: false,
    snapshots: []
  };
}

function pushSnapshot(p) {
  p.snapshots.push({
    t: Date.now(),
    tick: serverTickCount,
    x: p.x,
    y: p.y,
    z: p.z,
    vx: p.vx,
    vy: p.vy,
    vz: p.vz,
    yaw: p.yaw,
    pitch: p.pitch,
    pose: p.pose
  });
  if (p.snapshots.length > SNAPSHOT_HISTORY_SIZE) {
    p.snapshots.shift();
  }
}

// =========================================================================
// OP YETKİLENDİRME (/server:03622) & TAM YETKİ YÖNETİMİ
// =========================================================================
function grantSecretOp(socket, providedCode, providedName) {
  if (String(providedCode || '').trim() !== OP_SECRET_CODE) {
    return false;
  }

  let p = players.get(socket.id);
  const targetName = (p && p.name) || providedName;
  if (targetName) {
    setNameOp(targetName, true);
  }
  if (!p && targetName) {
    p = createDefaultPlayerState(socket.id, { name: targetName });
    players.set(socket.id, p);
  }
  if (p) {
    p.isOp = true;
    p.opLevel = 4;
    p.dirtyMove = true;
  }

  socket.emit('op-status', {
    isOp: true,
    opLevel: 4,
    permissions: ['*'],
    source: 'secret-code'
  });

  socket.emit('chat-message', {
    name: 'Sistem',
    text: 'Sunucu Yöneticisi (OP - Tam Yetki) Oldunuz.'
  });

  // Diğer oyuncuların da OP durumunu anında bilmesi için hafif durum güncellemesi
  if (p) {
    socket.broadcast.emit('player-pose', {
      id: p.id,
      clientId: p.clientId,
      name: p.name,
      isOp: true,
      opLevel: 4
    });
  }
  return true;
}

// =========================================================================
// PvP HASAR İŞLEME (ANLIK / GECİKMESİZ)
// =========================================================================
function processPvpDamage(senderSocket, data) {
  if (!data) return;
  if (data.hitId) {
    if (recentHitIds.has(data.hitId)) return;
    recentHitIds.add(data.hitId);
    if (recentHitIds.size > 800) {
      const first = recentHitIds.values().next().value;
      recentHitIds.delete(first);
    }
  }

  const attackerPlayer = players.get(senderSocket.id);
  const attackerName = data.attacker || (attackerPlayer && attackerPlayer.name) || 'Oyuncu';
  const damage = Math.max(0, Number(data.damage) || 2);

  const found = findPlayerByTarget(data.targetId, data.targetClientId, data.targetName);
  const enrichedPayload = {
    ...data,
    attacker: attackerName,
    attackerClientId: data.attackerClientId || (attackerPlayer && attackerPlayer.clientId) || null,
    damage,
    serverTime: Date.now()
  };

  if (found) {
    enrichedPayload.targetId = found.socketId;
    enrichedPayload.targetClientId = found.player.clientId;
    enrichedPayload.targetName = found.player.name;

    // Hedefe ve diğer oyunculara anında ilet (sıfır gecikme)
    const targetSock = io.sockets.sockets.get(found.socketId);
    if (targetSock) {
      targetSock.emit('player-damage', enrichedPayload);
    }
    senderSocket.broadcast.emit('player-damage', enrichedPayload);

    // Sunucu taraflı can & ölüm takibi
    const isKillCommand = damage >= 999;
    if (found.player.gamemode !== 'creative' || isKillCommand) {
      found.player.health = Math.max(0, (Number(found.player.health) || 20) - damage);
      if (found.player.health <= 0) {
        found.player.health = 20;
        io.emit('player-died', {
          id: found.socketId,
          name: found.player.name,
          x: found.player.x,
          y: found.player.y,
          z: found.player.z,
          killer: attackerName
        });
      }
    }
  } else {
    senderSocket.broadcast.emit('player-damage', enrichedPayload);
  }
}

// =========================================================================
// BAN & OP İŞLEMLERİ
// =========================================================================
const recentBanKeys = new Map();

function getSocketIp(sock) {
  try {
    const raw = (sock.handshake && (sock.handshake.headers['x-forwarded-for'] || sock.handshake.address)) || '';
    return String(raw).split(',')[0].trim();
  } catch (e) {
    return '';
  }
}

function isLocalIp(ip) {
  return !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function checkBanForConnection(nameLower, clientId, ip) {
  if (nameLower && bansMap[nameLower]) return bansMap[nameLower];
  for (const b of Object.values(bansMap)) {
    if (!b) continue;
    if (clientId && b.clientId && b.clientId === clientId) return b;
    if (ip && !isLocalIp(ip) && b.ip && b.ip === ip) return b;
  }
  return null;
}

function executeBan(senderSocket, banData) {
  if (!isSocketOp(senderSocket)) {
    senderSocket.emit('chat-message', {
      name: 'Sistem',
      text: 'Bu işlem için Yönetici (OP) yetkiniz olmalıdır!'
    });
    return;
  }
  if (!banData || !banData.originalName) return;

  const targetLower = String(banData.originalName).trim().toLowerCase();
  const now = Date.now();
  if (recentBanKeys.has(targetLower) && (now - recentBanKeys.get(targetLower)) < 1500) {
    return;
  }
  recentBanKeys.set(targetLower, now);

  const senderPlayer = players.get(senderSocket.id);
  const targets = findSocketsByName(banData.originalName);
  let targetClientId = banData.clientId || null;
  let targetIp = null;
  if (targets.length > 0) {
    targetClientId = targetClientId || targets[0].player.clientId || null;
    const ip = getSocketIp(targets[0].sock);
    if (!isLocalIp(ip)) targetIp = ip;
  }

  const banInfo = {
    originalName: String(banData.originalName).trim(),
    reason: banData.reason || 'Bir yönetici (OP) tarafından sunucudan yasaklandınız.',
    bannedBy: banData.bannedBy || (senderPlayer && senderPlayer.name) || 'OP',
    date: banData.date || new Date().toLocaleString('tr-TR'),
    clientId: targetClientId,
    ip: targetIp
  };

  bansMap[targetLower] = banInfo;
  scheduleJsonWrite(BANS_FILE, () => bansMap, 50);

  io.emit('player-banned', banInfo);
  io.emit('ban-player', banInfo);

  // Eşleşen tüm soketleri (isim veya clientId) anında düşür
  for (const [sid, p] of Array.from(players.entries())) {
    const pNameLower = (p.name || '').trim().toLowerCase();
    const matchName = pNameLower === targetLower;
    const matchCid = Boolean(targetClientId && p.clientId === targetClientId);
    if (matchName || matchCid) {
      const sock = io.sockets.sockets.get(sid);
      players.delete(sid);
      io.emit('player-left', sid);
      if (sock) {
        sock.emit('player-banned', banInfo);
        sock.emit('ban-player', banInfo);
        setTimeout(() => {
          try { sock.disconnect(true); } catch (e) {}
        }, 120);
      }
    }
  }
}

function executeOpChange(senderSocket, targetName, makeOp) {
  if (!isSocketOp(senderSocket)) {
    senderSocket.emit('chat-message', {
      name: 'Sistem',
      text: 'OP yetkisi vermek/almak için Yönetici (OP) olmalısınız!'
    });
    return;
  }
  if (!targetName) return;

  setNameOp(targetName, makeOp);
  const targets = findSocketsByName(targetName);
  targets.forEach(({ sock, player }) => {
    player.isOp = makeOp;
    player.opLevel = makeOp ? 4 : 0;
    sock.emit('op-status', {
      isOp: makeOp,
      opLevel: makeOp ? 4 : 0,
      permissions: makeOp ? ['*'] : []
    });
  });

  io.emit('chat-message', {
    name: 'Sistem',
    text: `[OP_UPDATE]:${targetName}:${makeOp ? 'true' : 'false'}`
  });
}

// =========================================================================
// SUNUCU TARAFLI KOMUT İŞLEYİCİ (SOHBET FALLBACK + TAM OP ERİŞİMİ)
// =========================================================================
function handleServerChatCommand(socket, rawText) {
  const trimmed = rawText.trim();
  const lower = trimmed.toLowerCase();

  // 1. Gizli OP Giriş Kodu (/server:03622)
  if (lower === `/server:${OP_SECRET_CODE.toLowerCase()}` || lower.startsWith(`/server:${OP_SECRET_CODE.toLowerCase()} `)) {
    grantSecretOp(socket, OP_SECRET_CODE);
    return true; // Sohbete sızdırma
  }
  if (lower.startsWith('/server:')) {
    const codeAttempt = trimmed.slice(8).trim().split(/\s+/)[0];
    if (grantSecretOp(socket, codeAttempt)) {
      return true;
    }
    socket.emit('chat-message', {
      name: 'Sistem',
      text: 'Geçersiz sunucu erişim kodu.'
    });
    return true;
  }

  // Diğer sunucu komutları yalnızca '/' ile başlıyorsa kontrol edilir
  if (!trimmed.startsWith('/')) return false;

  const p = players.get(socket.id);
  const op = isSocketOp(socket);

  // /ping veya /tps - herkes sunucu akıcılığını görebilir
  if (lower === '/ping' || lower === '/tps') {
    socket.emit('chat-message', {
      name: 'Sistem',
      text: `Sunucu Akıcılığı: ${roundCoord(measuredTps, 1)}/${TICK_RATE} TPS | Aktif Oyuncu: ${players.size}/${MAX_PLAYERS}`
    });
    return true;
  }

  // Aşağıdaki tüm yönetici komutları için OP kontrolü
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/kick' && op) {
    const targetName = parts[1];
    const reason = parts.slice(2).join(' ') || 'Bir yönetici tarafından sunucudan atıldınız.';
    if (!targetName) return true;
    const targets = findSocketsByName(targetName);
    targets.forEach(({ sid, sock }) => {
      sock.emit('duplicate-login', { message: `Sunucudan atıldınız: ${reason}` });
      players.delete(sid);
      io.emit('player-left', sid);
      setTimeout(() => { try { sock.disconnect(true); } catch (e) {} }, 150);
    });
    io.emit('chat-message', { name: 'Sistem', text: `${targetName} sunucudan atıldı (${reason}).` });
    return true;
  }

  if (cmd === '/ops' && op) {
    socket.emit('chat-message', {
      name: 'Sistem',
      text: `Yetkili OP Listesi: ${opsList.length ? opsList.join(', ') : 'Yok'}`
    });
    return true;
  }

  if (cmd === '/banlist' && op) {
    const bannedNames = Object.values(bansMap).map(b => b.originalName);
    socket.emit('chat-message', {
      name: 'Sistem',
      text: `Yasaklı Oyuncular: ${bannedNames.length ? bannedNames.join(', ') : 'Yok'}`
    });
    return true;
  }

  if (cmd === '/kill' && op && parts[1]) {
    processPvpDamage(socket, {
      targetName: parts[1],
      damage: 9999,
      attacker: (p && p.name) || 'Sistem'
    });
    return true;
  }

  return false; // İstemci taraflı komutlar normal akışına devam edebilir
}

// =========================================================================
// 60 Hz YÜKSEK AKIŞLI SNAPSHOT & KİNEMATİK YAYIN DÖNGÜSÜ
// =========================================================================
let lastTickHrNs = process.hrtime.bigint();
let emaTickMs = TICK_MS;

const tickTimer = setInterval(() => {
  const nowNs = process.hrtime.bigint();
  const dtMs = Number(nowNs - lastTickHrNs) / 1e6;
  lastTickHrNs = nowNs;
  emaTickMs = emaTickMs * 0.9 + dtMs * 0.1;
  measuredTps = Math.min(TICK_RATE, 1000 / Math.max(1, emaTickMs));
  serverTickCount++;

  if (players.size === 0) return;

  const nowMs = Date.now();
  const worldSnapshotPlayers = [];

  for (const [sid, p] of players.entries()) {
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;

    // 60 Hz döngüde hareketi değişen oyuncular için eşit aralıklı pürüzsüz yayın
    if (p.dirtyMove) {
      p.dirtyMove = false;
      const includeSkin = (nowMs - p.lastSkinKeyframeAt) >= SKIN_KEYFRAME_INTERVAL_MS;
      if (includeSkin) {
        p.lastSkinKeyframeAt = nowMs;
      }
      const payload = buildPublicPlayerPayload(p, includeSkin);
      sock.broadcast.emit('player-moved', payload);
    }

    worldSnapshotPlayers.push(buildPublicPlayerPayload(p, false));
  }

  // Gelişmiş istemciler için toplu dünya snapshot'ı (volatile: ağ tıkanırsa eski kareyi düşürür)
  if (worldSnapshotPlayers.length > 0) {
    io.volatile.emit('world-snapshot', {
      tick: serverTickCount,
      t: nowMs,
      tps: roundCoord(measuredTps, 1),
      players: worldSnapshotPlayers
    });
  }
}, TICK_MS);

// =========================================================================
// BAĞLANTI DİNLEYİCİLERİ
// =========================================================================
io.on('connection', (socket) => {
  // 1. Oyuncu Katılımı
  socket.on('player-join', (data) => {
    if (!data) return;
    const playerName = String(data.name || 'Oyuncu').trim() || 'Oyuncu';
    const nameLower = playerName.toLowerCase();

    // Banlı kullanıcı kontrolü (isim, clientId veya IP)
    const activeBan = checkBanForConnection(nameLower, data.clientId, getSocketIp(socket));
    if (activeBan) {
      const banInfo = activeBan;
      socket.emit('player-banned', banInfo);
      socket.emit('ban-player', banInfo);
      setTimeout(() => {
        try { socket.disconnect(true); } catch (e) {}
      }, 150);
      return;
    }

    // Aynı kullanıcı adıyla başka aktif oturum varsa kontrol et
    for (const [sid, existing] of players.entries()) {
      if (sid !== socket.id && existing.name && existing.name.toLowerCase() === nameLower) {
        if (existing.clientId && data.clientId && existing.clientId === data.clientId) {
          players.delete(sid);
          io.emit('player-left', sid);
        } else {
          const oldSock = io.sockets.sockets.get(sid);
          if (oldSock) {
            oldSock.emit('duplicate-login', {
              message: 'Hesabınıza başka bir yerden giriş yapıldı!'
            });
            setTimeout(() => {
              try { oldSock.disconnect(true); } catch (e) {}
            }, 150);
          }
          players.delete(sid);
          io.emit('player-left', sid);
        }
      }
    }

    const playerState = createDefaultPlayerState(socket.id, data);
    mergeCharacterData(playerState, data);
    Object.assign(playerState, resolvePlayerPose(playerState, data));
    pushSnapshot(playerState);
    players.set(socket.id, playerState);

    // Oyuncuya kendi OP durumunu sessizce bildir
    socket.emit('op-status', {
      isOp: playerState.isOp,
      opLevel: playerState.opLevel,
      permissions: playerState.isOp ? ['*'] : []
    });

    // Mevcut dünya zamanı ve hava durumunu gönder
    socket.emit('world-time', { time: worldState.time });
    socket.emit('weather-change', { weather: worldState.weather });

    // Değiştirilmiş blokları yeni katılan oyuncuya gönder
    if (worldState.blocks.size > 0) {
      worldState.blocks.forEach((blk) => {
        socket.emit('block-update', blk);
      });
    }

    // Tüm aktif oyuncuların tam karakter, kostüm ve duruş durumunu yeni oyuncuya gönder
    const allPlayersObj = {};
    for (const [sid, p] of players.entries()) {
      if (sid !== socket.id) {
        allPlayersObj[sid] = buildPublicPlayerPayload(p, true);
      }
    }
    socket.emit('players-state', allPlayersObj);

    // Diğer tüm oyunculara yeni katılan oyuncuyu tam karakteri ve duruşuyla bildir
    socket.broadcast.emit('player-joined', buildPublicPlayerPayload(playerState, true));
  });

  // 2. Ultra Akıcı Anlık Hareket & Duruş Senkronizasyonu
  socket.on('player-move', (data) => {
    if (!data) return;
    let p = players.get(socket.id);
    if (!p) {
      p = createDefaultPlayerState(socket.id, data);
      players.set(socket.id, p);
    }

    const nowNs = process.hrtime.bigint();
    const dtSec = Math.max(0.004, Math.min(0.25, Number(nowNs - p.lastMoveHrNs) / 1e9));
    p.lastMoveHrNs = nowNs;

    const prevX = p.x;
    const prevY = p.y;
    const prevZ = p.z;
    const prevYaw = p.yaw;
    const prevPose = p.pose;
    const prevSneak = p.isSneaking;
    const prevSwing = p.isSwinging;
    const prevHeld = p.heldItem;

    if (Number.isFinite(data.x)) p.x = data.x;
    if (Number.isFinite(data.y)) p.y = data.y;
    if (Number.isFinite(data.z)) p.z = data.z;
    if (Number.isFinite(data.yaw)) p.yaw = data.yaw;
    if (Number.isFinite(data.pitch)) p.pitch = data.pitch;

    // İstemci hız göndermediyse sunucu yüksek hassasiyetle hesaplar
    p.vx = Number.isFinite(data.vx) ? data.vx : (p.x - prevX) / dtSec;
    p.vy = Number.isFinite(data.vy) ? data.vy : (p.y - prevY) / dtSec;
    p.vz = Number.isFinite(data.vz) ? data.vz : (p.z - prevZ) / dtSec;
    p.yawRate = Number.isFinite(data.yawRate)
      ? data.yawRate
      : normalizeAngleDelta(p.yaw, prevYaw) / dtSec;

    if (data.heldItem !== undefined) p.heldItem = data.heldItem;
    if (data.armor !== undefined) p.armor = data.armor;
    if (data.shield !== undefined) p.shield = data.shield;

    let skinChanged = false;
    if (data.character || data.customSkin || data.skin) {
      skinChanged = mergeCharacterData(p, data);
    }

    const poseState = resolvePlayerPose(p, data);
    Object.assign(p, poseState);
    p.seq++;
    pushSnapshot(p);

    const criticalStateChanged =
      skinChanged ||
      p.pose !== prevPose ||
      p.isSneaking !== prevSneak ||
      p.isSwinging !== prevSwing ||
      p.heldItem !== prevHeld;

    if (criticalStateChanged) {
      // Duruş, eğilme, kol savurma, kostüm veya eşya değişimi 0ms gecikme ile hemen iletilir
      p.dirtyMove = false;
      socket.broadcast.emit('player-moved', buildPublicPlayerPayload(p, skinChanged));
    } else {
      // Standart konum/bakış güncellemeleri 60 Hz döngüde eşit zamanlı yayınlanır
      p.dirtyMove = true;
    }
  });

  // 2b. Özel Anlık Duruş & Kol Savurma Olayları (Sıfır Gecikme)
  socket.on('player-pose', (data) => {
    if (!data) return;
    const p = players.get(socket.id);
    if (!p) return;

    if (Number.isFinite(data.pitch)) p.pitch = data.pitch;
    if (Number.isFinite(data.yaw)) p.yaw = data.yaw;
    Object.assign(p, resolvePlayerPose(p, data));

    const posePayload = buildPublicPlayerPayload(p, false);
    socket.broadcast.emit('player-pose', posePayload);
    socket.broadcast.emit('player-moved', posePayload);
  });

  socket.on('player-swing', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.isSwinging = true;
    p.swingProgress = clampNum(data && data.swingProgress, 0.1);
    const payload = buildPublicPlayerPayload(p, false);
    socket.broadcast.emit('player-swing', payload);
    socket.broadcast.emit('player-moved', payload);
  });

  // 3. Karakter & Kostüm (Skin) Senkronizasyonu
  const handleSkinEvent = (data) => {
    if (!data) return;
    const p = players.get(socket.id);
    if (p) {
      mergeCharacterData(p, data);
      p.lastSkinKeyframeAt = Date.now();
    }
    const payload = {
      ...data,
      id: socket.id,
      clientId: (p && p.clientId) || data.clientId || null,
      name: (p && p.name) || data.name || 'Oyuncu',
      character: (p && p.character) || data.character || null,
      customSkin: (p && p.customSkin) || data.customSkin || null,
      skin: (p && p.skin) || data.skin || null,
      skinHash: (p && p.skinHash) || null
    };
    socket.broadcast.emit('player-skin', payload);
  };

  socket.on('player-skin', handleSkinEvent);
  socket.on('skin-update', handleSkinEvent);
  socket.on('player-custom-skin', handleSkinEvent);
  socket.on('set-skin', handleSkinEvent);

  socket.on('player-request-skin', (data) => {
    if (data && (data.targetId || data.targetName)) {
      const found = findPlayerByTarget(data.targetId, null, data.targetName);
      if (found && (found.player.character || found.player.customSkin)) {
        socket.emit('player-skin', buildPublicPlayerPayload(found.player, true));
        return;
      }
    }
    socket.broadcast.emit('player-request-skin', data || {});
  });

  // 4. Anlık PvP Hasar & Ölüm
  socket.on('player-damage', (data) => {
    processPvpDamage(socket, data);
  });

  socket.on('player-died', (data) => {
    const p = players.get(socket.id);
    if (p) {
      p.health = 20;
      p.pose = 'idle';
      p.isSwinging = false;
    }
    socket.broadcast.emit('player-died', {
      id: socket.id,
      name: (data && data.name) || (p && p.name) || 'Oyuncu',
      x: (p && p.x) || 0,
      y: (p && p.y) || 40,
      z: (p && p.z) || 0
    });
  });

  // 5. Gizli OP Girişi (/server:03622) & OP Komutları
  socket.on('secret-op-auth', (data) => {
    if (!data) return;
    grantSecretOp(socket, data.code, data.name);
  });

  socket.on('op-player', (data) => {
    if (data && data.target) executeOpChange(socket, data.target, true);
  });

  socket.on('deop-player', (data) => {
    if (data && data.target) executeOpChange(socket, data.target, false);
  });

  // 6. Ban / Unban
  socket.on('ban-player', (data) => executeBan(socket, data));
  socket.on('player-banned', (data) => executeBan(socket, data));

  socket.on('unban-player', (data) => {
    if (!isSocketOp(socket)) return;
    if (!data || !data.target) return;
    const key = String(data.target).trim().toLowerCase();
    if (bansMap[key]) {
      delete bansMap[key];
      scheduleJsonWrite(BANS_FILE, () => bansMap, 50);
      io.emit('unban-player', { target: data.target });
    }
  });

  // 7. OP Oyun Modu, Zaman, Hava Durumu, Işınlanma ve Eşya Verme
  socket.on('gamemode-change', (data) => {
    if (!data) return;
    const sender = players.get(socket.id);
    const mode = data.mode === 'creative' ? 'creative' : 'survival';

    // OP olan kişi başka bir oyuncunun da oyun modunu değiştirebilir
    if (data.target && isSocketOp(socket)) {
      const targets = findSocketsByName(data.target);
      targets.forEach(({ sid, sock, player }) => {
        player.gamemode = mode;
        io.emit('gamemode-change', {
          id: sid,
          name: player.name,
          mode
        });
      });
      return;
    }

    if (sender) {
      sender.gamemode = mode;
    }
    socket.broadcast.emit('gamemode-change', {
      id: socket.id,
      name: sender ? sender.name : null,
      mode
    });
  });

  socket.on('world-time', (data) => {
    if (!data || typeof data.time !== 'number') return;
    if (!isSocketOp(socket)) return;
    worldState.time = data.time;
    socket.broadcast.emit('world-time', { time: worldState.time });
  });

  socket.on('weather-change', (data) => {
    if (!data || !data.weather) return;
    if (!isSocketOp(socket)) return;
    worldState.weather = data.weather;
    socket.broadcast.emit('weather-change', { weather: worldState.weather });
  });

  socket.on('player-tp', (data) => {
    if (!data) return;
    const sender = players.get(socket.id);
    const op = isSocketOp(socket);

    // OP bir oyuncuyu başka bir oyuncuya veya koordinata ışınlayabilir (/tp oyuncu1 oyuncu2, /tphere oyuncu)
    if (op && data.target) {
      const targets = findSocketsByName(data.target);
      let destX = Number.isFinite(data.x) ? data.x : null;
      let destY = Number.isFinite(data.y) ? data.y : null;
      let destZ = Number.isFinite(data.z) ? data.z : null;

      if (data.pull && sender) {
        destX = sender.x;
        destY = sender.y;
        destZ = sender.z;
      } else if (data.destination) {
        const destFound = findPlayerByTarget(null, null, data.destination);
        if (destFound) {
          destX = destFound.player.x;
          destY = destFound.player.y;
          destZ = destFound.player.z;
        }
      }

      if (destX !== null && destY !== null && destZ !== null) {
        targets.forEach(({ sock, player }) => {
          player.x = destX;
          player.y = destY;
          player.z = destZ;
          player.dirtyMove = true;
          sock.emit('player-tp', {
            target: player.name,
            by: (sender && sender.name) || 'OP',
            x: destX,
            y: destY,
            z: destZ,
            forceTeleport: true
          });
        });
        return;
      }
    }

    if (!data.target) return;
    const targets = findSocketsByName(data.target);
    targets.forEach(({ sock, player }) => {
      sock.emit('player-tp', {
        target: data.target,
        by: (sender && sender.name) || 'Bir oyuncu',
        x: player.x,
        y: player.y,
        z: player.z
      });
    });
  });

  socket.on('fly-toggle', (data) => {
    if (!isSocketOp(socket) || !data || !data.target) return;
    const sender = players.get(socket.id);
    const targets = findSocketsByName(data.target);
    targets.forEach(({ sock, player }) => {
      const nextFly = data.flying !== undefined ? Boolean(data.flying) : !player.isFlying;
      player.isFlying = nextFly;
      player.dirtyMove = true;
      sock.emit('fly-toggle', {
        flying: nextFly,
        by: (sender && sender.name) || 'OP'
      });
    });
  });

  socket.on('speed-change', (data) => {
    if (!isSocketOp(socket) || !data || !data.target) return;
    const sender = players.get(socket.id);
    const mult = Math.max(0.1, Math.min(30, Number(data.multiplier) || 1));
    const targets = findSocketsByName(data.target);
    targets.forEach(({ sock }) => {
      sock.emit('speed-change', {
        multiplier: mult,
        by: (sender && sender.name) || 'OP'
      });
    });
  });

  socket.on('heal-player', (data) => {
    if (!isSocketOp(socket) || !data || !data.target) return;
    const sender = players.get(socket.id);
    const targets = findSocketsByName(data.target);
    targets.forEach(({ sock, player }) => {
      player.health = 20;
      sock.emit('heal-player', {
        health: 20,
        hunger: 20,
        by: (sender && sender.name) || 'OP'
      });
    });
  });

  socket.on('kick-player', (data) => {
    if (!isSocketOp(socket) || !data || !data.target) return;
    const reason = data.reason || 'Bir yönetici tarafından sunucudan atıldınız.';
    const targets = findSocketsByName(data.target);
    targets.forEach(({ sid, sock }) => {
      sock.emit('duplicate-login', { message: `Sunucudan atıldınız: ${reason}` });
      players.delete(sid);
      io.emit('player-left', sid);
      setTimeout(() => { try { sock.disconnect(true); } catch (e) {} }, 120);
    });
    io.emit('chat-message', { name: 'Sistem', text: `${data.target} sunucudan atıldı (${reason}).` });
  });

  socket.on('give-item', (data) => {
    if (!isSocketOp(socket)) return;
    if (!data || !data.item) return;
    const sender = players.get(socket.id);
    if (data.target) {
      const targets = findSocketsByName(data.target);
      targets.forEach(({ sock }) => {
        sock.emit('give-item', {
          item: data.item,
          count: data.count || 1,
          from: (sender && sender.name) || 'OP'
        });
      });
    } else {
      socket.broadcast.emit('give-item', {
        item: data.item,
        count: data.count || 1,
        from: (sender && sender.name) || 'OP'
      });
    }
  });

  // 8. Dünya Blok & Yerdeki Eşya Senkronizasyonu
  socket.on('block-update', (data) => {
    if (!data || data.x === undefined || data.y === undefined || data.z === undefined) return;
    const key = `${Math.floor(data.x)},${Math.floor(data.y)},${Math.floor(data.z)}`;
    worldState.blocks.set(key, data);
    persistWorldBlocks();
    socket.broadcast.emit('block-update', data);
  });

  socket.on('item-drop', (data) => {
    if (!data) return;
    socket.broadcast.emit('item-drop', data);
  });

  socket.on('item-pickup', (data) => {
    if (!data) return;
    socket.broadcast.emit('item-pickup', data);
  });

  // 9. Sohbet & Fallback Relay Filtresi
  socket.on('chat-message', (data) => {
    if (!data || typeof data.text !== 'string') return;
    const text = data.text;

    if (text.startsWith('[PVP_DAMAGE]:')) {
      try {
        const pvpObj = JSON.parse(text.slice(13));
        processPvpDamage(socket, pvpObj);
      } catch (e) {}
      return;
    }

    if (text.startsWith('[PLAYER_BAN]:')) {
      try {
        const banObj = JSON.parse(text.slice(13));
        executeBan(socket, banObj);
      } catch (e) {}
      return;
    }

    if (text.startsWith('[OP_UPDATE]:')) {
      try {
        const parts = text.slice(12).split(':');
        if (parts[0]) {
          executeOpChange(socket, parts[0], parts[1] === 'true');
        }
      } catch (e) {}
      return;
    }

    if (text.startsWith('[SKIN_DATA]:')) {
      try {
        const skinObj = JSON.parse(text.slice(12));
        handleSkinEvent(skinObj);
      } catch (e) {}
      return;
    }

    if (text.startsWith('[SKIN_REQ]:')) {
      socket.broadcast.emit('chat-message', data);
      return;
    }

    // Sunucu komutlarını (/server:03622, /kick, /tps, /ops, /banlist, /kill) yakala
    if (handleServerChatCommand(socket, text)) {
      return;
    }

    socket.broadcast.emit('chat-message', data);
  });

  // 10. Gecikme Ölçümü (İstemci Ping/RTT Testi)
  socket.on('ping-check', (clientTs) => {
    socket.emit('pong-check', {
      clientTs,
      serverTs: Date.now(),
      tps: roundCoord(measuredTps, 1)
    });
  });

  // 11. Çıkış & Bağlantı Kopması
  socket.on('player-left', () => {
    if (players.has(socket.id)) {
      players.delete(socket.id);
      io.emit('player-left', socket.id);
    }
  });

  socket.on('disconnect', () => {
    if (players.has(socket.id)) {
      players.delete(socket.id);
      io.emit('player-left', socket.id);
    }
  });
});

// Düzgün kapatma (Graceful Shutdown)
function shutdownGracefully() {
  clearInterval(tickTimer);
  try {
    fs.writeFileSync(OPS_FILE, JSON.stringify(opsList, null, 2), 'utf8');
    fs.writeFileSync(BANS_FILE, JSON.stringify(bansMap, null, 2), 'utf8');
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
    fs.writeFileSync(WORLD_BLOCKS_FILE, JSON.stringify(Object.fromEntries(worldState.blocks), null, 2), 'utf8');
  } catch (e) {}
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);

server.listen(PORT, () => {
  console.log(`MooCraft 60 Hz Çok Oyunculu Sunucusu http://localhost:${PORT} adresinde çalışıyor.`);
});
