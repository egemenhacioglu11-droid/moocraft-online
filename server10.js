/**
 * MooCraft Ultimate 3D - Çok Oyunculu Sunucu (server.js)
 * Özellikler:
 *  - Gecikmesiz (0ms) anlık hareket senkronizasyonu (perMessageDeflate: false)
 *  - Anlık PvP hasar, geri itme (knockback), ölüm ve yeniden doğma takibi
 *  - Tam karakter & özel 64x64 kostüm (skin) + elde tutulan eşya senkronizasyonu
 *  - Kalıcı OP (Yönetici) ve Ban sistemi (ops.json, bans.json, accounts.json)
 *  - Tüm OP komutları (/server:03622, /op, /deop, /ban, /unban, /damage, /kill, /tp, /time, /weather, /gamemode, /give)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const OP_SECRET_CODE = process.env.OP_SECRET_CODE || '03622';
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;

// Kalıcı veri dosyaları
const DATA_DIR = path.join(__dirname, 'server_data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const OPS_FILE = path.join(DATA_DIR, 'ops.json');
const BANS_FILE = path.join(DATA_DIR, 'bans.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback) {
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

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Veri Yazma Hatası] ${filePath}:`, err.message);
  }
}

let accounts = readJsonFile(ACCOUNTS_FILE, {});
let opsList = readJsonFile(OPS_FILE, []); // Küçük harfli kullanıcı adları listesi
let bansMap = readJsonFile(BANS_FILE, {}); // { [usernameLower]: { originalName, reason, bannedBy, date } }

// Ortam değişkeninden başlangıç OP'leri ekle (örn: INITIAL_OPS="admin,kurucu")
if (process.env.INITIAL_OPS) {
  process.env.INITIAL_OPS.split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .forEach(name => {
      if (!opsList.includes(name)) opsList.push(name);
    });
  writeJsonFile(OPS_FILE, opsList);
}

function isNameOp(name) {
  if (!name) return false;
  return opsList.includes(String(name).trim().toLowerCase());
}

function setNameOp(name, makeOp) {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return;
  if (makeOp) {
    if (!opsList.includes(clean)) {
      opsList.push(clean);
      writeJsonFile(OPS_FILE, opsList);
    }
  } else {
    opsList = opsList.filter(op => op !== clean);
    writeJsonFile(OPS_FILE, opsList);
  }
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

// İstemci HTML dosyasını ve statik dosyaları sun
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const files = fs.readdirSync(__dirname);
  const htmlFile = files.find(f => f.toLowerCase().endsWith('.html'));
  if (htmlFile) {
    return res.sendFile(path.join(__dirname, htmlFile));
  }
  res.send('MooCraft Çok Oyunculu Sunucusu Aktif!');
});

// Sunucu listesi endpoint'i
app.get('/api/servers', (req, res) => {
  const host = req.get('host') || `localhost:${PORT}`;
  res.json([
    {
      id: 'moocraft_main',
      name: 'MooCraft Resmi Sunucu',
      address: host,
      motd: 'Gecikmesiz PvP & Tam Karakter Senkronizasyonu',
      maxPlayers: MAX_PLAYERS,
      online: players.size,
      status: 'online',
      ping: 12,
      version: '1.1',
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

  return res.json({ success: true, user });
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
  writeJsonFile(ACCOUNTS_FILE, accounts);
  return res.json({ success: true, user: newUser });
});

// =========================================================================
// SOCKET.IO & OYUN DURUMU
// =========================================================================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 10 * 1024 * 1024, // Özel 64x64 skin paketleri için 10MB
  perMessageDeflate: false, // Gecikmesiz anlık paket iletimi
  pingInterval: 10000,
  pingTimeout: 5000
});

// Aktif oyuncular: Map<socketId, PlayerState>
const players = new Map();
// Dünya durumu
const worldState = {
  time: 1000,
  weather: 'clear',
  blocks: new Map() // "x,y,z" -> blockData
};
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
  if (!data) return;
  let charObj = null;
  if (data.character && typeof data.character === 'object') {
    charObj = data.character;
  } else if (typeof data.character === 'string') {
    try { charObj = JSON.parse(data.character); } catch (e) {}
  }

  const skinStr = data.customSkin || data.skin || (charObj && charObj.customSkin) || null;
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
}

function buildPublicPlayerPayload(p) {
  return {
    id: p.id,
    clientId: p.clientId,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    character: p.character,
    customSkin: p.customSkin,
    skin: p.skin,
    heldItem: p.heldItem,
    health: p.health,
    gamemode: p.gamemode,
    isOp: p.isOp
  };
}

// =========================================================================
// PvP HASAR İŞLEME (ANLIK / GECİKMESİZ)
// =========================================================================
function processPvpDamage(senderSocket, data) {
  if (!data) return;
  if (data.hitId) {
    if (recentHitIds.has(data.hitId)) return;
    recentHitIds.add(data.hitId);
    if (recentHitIds.size > 500) {
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
    damage
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
    // Hedef doğrudan bulunamazsa tüm diğer istemcilere yayınla
    senderSocket.broadcast.emit('player-damage', enrichedPayload);
  }
}

// =========================================================================
// BAN & OP İŞLEMLERİ
// =========================================================================
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
  const senderPlayer = players.get(senderSocket.id);
  const banInfo = {
    originalName: String(banData.originalName).trim(),
    reason: banData.reason || 'Bir yönetici (OP) tarafından sunucudan yasaklandınız.',
    bannedBy: banData.bannedBy || (senderPlayer && senderPlayer.name) || 'OP',
    date: banData.date || new Date().toLocaleString('tr-TR')
  };

  bansMap[targetLower] = banInfo;
  writeJsonFile(BANS_FILE, bansMap);

  // Herkese anında ban bildirimini yayınla
  io.emit('player-banned', banInfo);
  io.emit('ban-player', banInfo);

  // Hedef oyuncunun bağlantısını hemen kes
  const targets = findSocketsByName(banInfo.originalName);
  targets.forEach(({ sid, sock }) => {
    players.delete(sid);
    io.emit('player-left', sid);
    setTimeout(() => {
      try { sock.disconnect(true); } catch (e) {}
    }, 150);
  });
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
    sock.emit('op-status', { isOp: makeOp });
  });

  io.emit('chat-message', {
    name: 'Sistem',
    text: `[OP_UPDATE]:${targetName}:${makeOp ? 'true' : 'false'}`
  });
}

// =========================================================================
// BAĞLANTI DİNLEYİCİLERİ
// =========================================================================
io.on('connection', (socket) => {
  // 1. Oyuncu Katılımı
  socket.on('player-join', (data) => {
    if (!data) return;
    const playerName = String(data.name || 'Oyuncu').trim();
    const nameLower = playerName.toLowerCase();

    // Banlı kullanıcı kontrolü
    if (bansMap[nameLower]) {
      const banInfo = bansMap[nameLower];
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
          // Aynı istemcinin eski hayalet bağlantısını temizle
          players.delete(sid);
          io.emit('player-left', sid);
        } else {
          // Eski bağlantıyı sonlandır veya yeni girişi uyar
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

    const opStatus = isNameOp(playerName);
    const playerState = {
      id: socket.id,
      clientId: data.clientId || null,
      name: playerName,
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 40,
      z: Number.isFinite(data.z) ? data.z : 0,
      yaw: Number.isFinite(data.yaw) ? data.yaw : 0,
      character: null,
      customSkin: null,
      skin: null,
      heldItem: data.heldItem || null,
      health: 20,
      gamemode: 'survival',
      isOp: opStatus
    };

    mergeCharacterData(playerState, data);
    players.set(socket.id, playerState);

    // Oyuncuya kendi OP durumunu sessizce bildir
    socket.emit('op-status', { isOp: opStatus });

    // Mevcut dünya zamanı ve hava durumunu gönder
    socket.emit('world-time', { time: worldState.time });
    socket.emit('weather-change', { weather: worldState.weather });

    // Değiştirilmiş blokları yeni katılan oyuncuya gönder
    if (worldState.blocks.size > 0) {
      worldState.blocks.forEach((blk) => {
        socket.emit('block-update', blk);
      });
    }

    // Tüm aktif oyuncuların tam karakter ve konum durumunu yeni oyuncuya gönder
    const allPlayersObj = {};
    for (const [sid, p] of players.entries()) {
      if (sid !== socket.id) {
        allPlayersObj[sid] = buildPublicPlayerPayload(p);
      }
    }
    socket.emit('players-state', allPlayersObj);

    // Diğer tüm oyunculara yeni katılan oyuncuyu tam karakteriyle bildir
    socket.broadcast.emit('player-joined', buildPublicPlayerPayload(playerState));
  });

  // 2. Gecikmesiz Anlık Hareket Senkronizasyonu
  socket.on('player-move', (data) => {
    if (!data) return;
    let p = players.get(socket.id);
    if (!p) {
      p = {
        id: socket.id,
        clientId: data.clientId || null,
        name: data.name || 'Oyuncu',
        x: 0,
        y: 40,
        z: 0,
        yaw: 0,
        character: null,
        customSkin: null,
        skin: null,
        heldItem: null,
        health: 20,
        gamemode: 'survival',
        isOp: isNameOp(data.name)
      };
      players.set(socket.id, p);
    }

    if (Number.isFinite(data.x)) p.x = data.x;
    if (Number.isFinite(data.y)) p.y = data.y;
    if (Number.isFinite(data.z)) p.z = data.z;
    if (Number.isFinite(data.yaw)) p.yaw = data.yaw;
    if (data.heldItem !== undefined) p.heldItem = data.heldItem;
    if (data.character || data.customSkin || data.skin) {
      mergeCharacterData(p, data);
    }

    // Gecikmesiz doğrudan yayın (tam karakter + konum + elde tutulan eşya)
    socket.broadcast.emit('player-moved', {
      ...data,
      id: socket.id,
      clientId: p.clientId || data.clientId,
      name: p.name,
      character: p.character || data.character || null,
      customSkin: p.customSkin || data.customSkin || null,
      skin: p.skin || data.skin || null,
      heldItem: p.heldItem
    });
  });

  // 3. Karakter & Kostüm (Skin) Senkronizasyonu
  const handleSkinEvent = (data) => {
    if (!data) return;
    const p = players.get(socket.id);
    if (p) {
      mergeCharacterData(p, data);
    }
    const payload = {
      ...data,
      id: socket.id,
      clientId: (p && p.clientId) || data.clientId || null,
      name: (p && p.name) || data.name || 'Oyuncu',
      character: (p && p.character) || data.character || null,
      customSkin: (p && p.customSkin) || data.customSkin || null,
      skin: (p && p.skin) || data.skin || null
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
        socket.emit('player-skin', buildPublicPlayerPayload(found.player));
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
    if (p) p.health = 20;
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
    if (!data || String(data.code) !== OP_SECRET_CODE) return;
    const p = players.get(socket.id);
    const targetName = (p && p.name) || data.name;
    if (targetName) {
      setNameOp(targetName, true);
    }
    if (p) {
      p.isOp = true;
    }
    socket.emit('op-status', { isOp: true });
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
      writeJsonFile(BANS_FILE, bansMap);
      io.emit('unban-player', { target: data.target });
    }
  });

  // 7. OP Oyun Modu, Zaman, Hava Durumu, Işınlanma ve Eşya Verme
  socket.on('gamemode-change', (data) => {
    if (!data) return;
    const p = players.get(socket.id);
    if (p) {
      p.gamemode = data.mode === 'creative' ? 'creative' : 'survival';
    }
    socket.broadcast.emit('gamemode-change', {
      id: socket.id,
      name: p ? p.name : null,
      mode: data.mode
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
    if (!data || !data.target) return;
    const sender = players.get(socket.id);
    const targets = findSocketsByName(data.target);
    targets.forEach(({ sock }) => {
      sock.emit('player-tp', {
        target: data.target,
        by: (sender && sender.name) || 'Bir oyuncu'
      });
    });
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

  // 9. Sohbet & Fallback Relay Filtresi ([PVP_DAMAGE], [PLAYER_BAN], [OP_UPDATE], [SKIN_DATA])
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

    socket.broadcast.emit('chat-message', data);
  });

  // 10. Çıkış & Bağlantı Kopması
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

server.listen(PORT, () => {
  console.log(`MooCraft Çok Oyunculu Sunucusu http://localhost:${PORT} adresinde çalışıyor.`);
});
