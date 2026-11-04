const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const app = express();
const server = http.createServer(app);

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
      socket.disconnect(true);
      return;
    }

    const isUserOp = opPlayers.includes(playerName);

    players[socket.id] = {
      id: socket.id,
      name: playerName,
      x: 0, y: 30, z: 0, yaw: 0,
      isOp: isUserOp
    };

    socket.emit('op-status', { isOp: isUserOp });
    socket.emit('world-init', worldState);
    io.emit('players-state', players);
  });

  socket.on('player-move', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].z = data.z;
      players[socket.id].yaw = data.yaw;
      socket.broadcast.emit('player-moved', players[socket.id]);
    }
  });

  socket.on('command', (data) => {
    const player = players[socket.id];
    if (!player || !player.isOp) {
      socket.emit('chat-message', { name: 'Sistem', text: 'Bu komutu kullanmak için OP yetkiniz yok!' });
      return;
    }
    const cmdText = data.text.trim();
    io.emit('chat-message', { name: 'Konsol', text: `${player.name} komutu çalıştırdı: ${cmdText}` });
  });

  socket.on('chat-message', (data) => {
    io.emit('chat-message', { name: data.name, text: data.text });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit('player-left', socket.id);
    }
  });
});

// Render ortamı dinamik PORT değişkenini otomatik atar
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[MooCraft Sunucu] Çalışıyor. Port: ${PORT}`);
});