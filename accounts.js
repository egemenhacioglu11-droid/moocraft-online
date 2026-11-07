/**
 * MooCraft - Kalıcı Hesap ve Oturum Yönetim Modülü (Render & Node.js Uyumlu)
 * accounts.js
 * 
 * Bu dosya:
 * 1. Oyundaki tüm hesapları 'accounts.json' dosyasına kalıcı olarak yazar.
 * 2. Yeni bir hesap açıldığında anında dosyaya kaydeder.
 * 3. Girilen kullanıcı adı ve şifreyi doğrulayarak doğru hesaba yönlendirir.
 * 4. Dünyaları, blokları ve karakter kostümlerini sunucuda senkronize tutar.
 */

const fs = require('fs');
const path = require('path');

// Hesapların tutulacağı JSON veritabanı dosyası
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// Varsayılan hesap şablonu ve ilk yükleme
let accountsCache = {};

function initAccountsFile() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      // Dosya yoksa temiz bir veritabanı oluştur
      const initialDb = {
        _info: "MooCraft Oyuncu Hesapları Veritabanı",
        _lastUpdated: new Date().toISOString(),
        users: {}
      };
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(initialDb, null, 2), 'utf-8');
      accountsCache = initialDb.users;
      console.log(`[MooCraft Auth] '${ACCOUNTS_FILE}' oluşturuldu.`);
    } else {
      const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      accountsCache = parsed.users || {};
      console.log(`[MooCraft Auth] ${Object.keys(accountsCache).length} kayıtlı hesap yüklendi.`);
    }
  } catch (err) {
    console.error('[MooCraft Auth] accounts.json yüklenirken hata:', err.message);
    accountsCache = {};
  }
}

// Hesapları diskteki accounts.json dosyasına atomik ve güvenli kaydeder
function saveAccountsToDisk() {
  try {
    const dataToWrite = {
      _info: "MooCraft Oyuncu Hesapları Veritabanı",
      _lastUpdated: new Date().toISOString(),
      totalUsers: Object.keys(accountsCache).length,
      users: accountsCache
    };

    const tempFile = `${ACCOUNTS_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(dataToWrite, null, 2), 'utf-8');
    fs.renameSync(tempFile, ACCOUNTS_FILE);
    return true;
  } catch (err) {
    console.error('[MooCraft Auth] accounts.json kaydedilirken hata:', err.message);
    return false;
  }
}

// İlk açılışta dosyayı oku
initAccountsFile();

/**
 * Yeni Kullanıcı Kaydı (Register)
 * @param {string} username - Kullanıcı adı
 * @param {string} password - Şifre
 * @param {object} initialData - İlk dünya ve karakter verileri (opsiyonel)
 */
function registerAccount(username, password, initialData = {}) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '').trim();

  if (!cleanUser || !cleanPass) {
    return { success: false, message: 'Kullanıcı adı ve şifre boş bırakılamaz!' };
  }

  if (cleanPass.length < 3) {
    return { success: false, message: 'Şifre en az 3 karakter olmalıdır!' };
  }

  // Büyük/küçük harf duyarsız kontrol
  const userKeyLower = cleanUser.toLowerCase();
  for (const existingUser in accountsCache) {
    if (existingUser.toLowerCase() === userKeyLower) {
      return { success: false, message: 'Bu kullanıcı adı zaten kayıtlı! Lütfen giriş yapın.' };
    }
  }

  // Yeni hesabı oluştur
  const now = new Date().toISOString();
  accountsCache[cleanUser] = {
    username: cleanUser,
    password: cleanPass,
    registeredAt: now,
    lastLoginAt: now,
    character: initialData.character || {
      skinColor: '#c68642', eyeColor: '#2b5797', hairStyle: 'steve',
      hairColor: '#4a2e00', facialHair: 'mustache', shirtStyle: 'tshirt',
      shirtColor: '#008080', pantColor: '#1a237e', shoeColor: '#333333', accessory: 'none'
    },
    worlds: initialData.worlds || [
      { id: "w_yeni", name: "Yeni Dünya", date: "28.10.2026 13:20", mode: "creative", difficulty: "normal", allowCommands: true, seed: "99999", version: "26.3", customBlocks: {} },
      { id: "w_survival", name: "New World", date: "15.10.2026 16:42", mode: "survival", difficulty: "normal", allowCommands: false, seed: "12345", version: "26.3", customBlocks: {} }
    ],
    servers: initialData.servers || [],
    settings: initialData.settings || { ram: '2', renderDist: '1', showFps: true }
  };

  // accounts.json dosyasına yaz
  saveAccountsToDisk();
  console.log(`[MooCraft Auth] Yeni hesap oluşturuldu ve accounts.json dosyasına yazıldı: ${cleanUser}`);

  return {
    success: true,
    message: 'Hesap başarıyla oluşturuldu!',
    user: accountsCache[cleanUser]
  };
}

/**
 * Kullanıcı Girişi (Login & Authentication)
 * @param {string} username - Kullanıcı adı
 * @param {string} password - Şifre
 */
function loginAccount(username, password) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '').trim();

  if (!cleanUser || !cleanPass) {
    return { success: false, message: 'Lütfen kullanıcı adı ve şifrenizi girin!' };
  }

  // Dosyadaki en güncel hali kontrol et
  initAccountsFile();

  const userKeyLower = cleanUser.toLowerCase();
  let foundUser = null;
  let exactUserName = cleanUser;

  for (const existingUser in accountsCache) {
    if (existingUser.toLowerCase() === userKeyLower) {
      foundUser = accountsCache[existingUser];
      exactUserName = existingUser;
      break;
    }
  }

  if (!foundUser) {
    return { success: false, message: 'Böyle bir kullanıcı hesabı bulunamadı!' };
  }

  if (foundUser.password !== cleanPass) {
    return { success: false, message: 'Hatalı şifre girdiniz! Lütfen tekrar deneyin.' };
  }

  // Başarılı giriş: son giriş tarihini güncelle ve kaydet
  foundUser.lastLoginAt = new Date().toISOString();
  saveAccountsToDisk();

  console.log(`[MooCraft Auth] Giriş başarılı: ${exactUserName}`);

  return {
    success: true,
    message: 'Giriş başarılı! Hesabınızdaki tüm dünyalar ve veriler yüklendi.',
    user: foundUser
  };
}

/**
 * Hesap Verilerini Güncelleme (Sync Worlds, Character, Settings)
 * @param {string} username - Kullanıcı adı
 * @param {object} updatedData - Güncel dünyalar, bloklar veya kostüm
 */
function syncAccountData(username, updatedData = {}) {
  const cleanUser = String(username || '').trim();
  const userKeyLower = cleanUser.toLowerCase();

  for (const existingUser in accountsCache) {
    if (existingUser.toLowerCase() === userKeyLower) {
      const u = accountsCache[existingUser];
      u.lastActiveAt = new Date().toISOString();

      if (updatedData.character) u.character = updatedData.character;
      if (updatedData.worlds && Array.isArray(updatedData.worlds)) u.worlds = updatedData.worlds;
      if (updatedData.servers && Array.isArray(updatedData.servers)) u.servers = updatedData.servers;
      if (updatedData.settings) u.settings = updatedData.settings;

      saveAccountsToDisk();
      return { success: true, message: 'Hesap verileri güncellendi.' };
    }
  }

  return { success: false, message: 'Kullanıcı bulunamadı.' };
}

/**
 * Express Router Entegrasyonu
 * Render server.js içerisinde 'app.use('/api', accountsRouter)' şeklinde kullanılır
 */
function createExpressAuthRouter(express) {
  const router = express.Router();

  // 1. Kayıt API Endpoint'i: POST /api/register
  router.post('/register', (req, res) => {
    const { username, password, character, worlds, servers, settings } = req.body || {};
    const result = registerAccount(username, password, { character, worlds, servers, settings });
    res.json(result);
  });

  // 2. Giriş API Endpoint'i: POST /api/login
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const result = loginAccount(username, password);
    res.json(result);
  });

  // 3. Veri Senkronizasyon Endpoint'i: POST /api/sync
  router.post('/sync', (req, res) => {
    const { username, character, worlds, servers, settings } = req.body || {};
    const result = syncAccountData(username, { character, worlds, servers, settings });
    res.json(result);
  });

  // 4. Hesap Verisini Getir: GET /api/user/:username
  router.get('/user/:username', (req, res) => {
    const userKeyLower = String(req.params.username || '').toLowerCase();
    for (const existingUser in accountsCache) {
      if (existingUser.toLowerCase() === userKeyLower) {
        const u = Object.assign({}, accountsCache[existingUser]);
        delete u.password; // Güvenlik için şifreyi gizle
        return res.json({ success: true, user: u });
      }
    }
    res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });
  });

  return router;
}

/**
 * Socket.io Entegrasyonu
 * server.js içerisindeki 'io.on("connection", socket => ...)' içine bağlanır
 */
function attachSocketIOAuth(io, socket) {
  // Socket üzerinden kayıt olma
  socket.on('account-register', (data, callback) => {
    const { username, password, initialData } = data || {};
    const result = registerAccount(username, password, initialData);
    if (typeof callback === 'function') callback(result);
  });

  // Socket üzerinden giriş yapma
  socket.on('account-login', (data, callback) => {
    const { username, password } = data || {};
    const result = loginAccount(username, password);
    if (typeof callback === 'function') callback(result);
  });

  // Socket üzerinden anlık veri eşitleme
  socket.on('account-sync', (data, callback) => {
    const { username, updatedData } = data || {};
    const result = syncAccountData(username, updatedData);
    if (typeof callback === 'function') callback(result);
  });
}

module.exports = {
  registerAccount,
  loginAccount,
  syncAccountData,
  getAllAccounts: () => accountsCache,
  createExpressAuthRouter,
  attachSocketIOAuth
};