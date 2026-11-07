const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'hesap_kayitlari.log');
const ACCOUNTS_DB = path.join(LOGS_DIR, 'accounts.json');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function logNewAccount(data) {
  if (!data || !data.username) return;
  const { username, password } = data;
  const now = new Date().toLocaleString('tr-TR');
  
  // Render siyah konsol ekranına doğrudan yazdırır:
  console.log('====================================');
  console.log(`[RENDER] [+] YENİ HESAP AÇILDI!`);
  console.log(`KULLANICI: ${username}`);
  console.log(`ŞİFRE: ${password}`);
  console.log('====================================');

  try {
    fs.appendFileSync(LOG_FILE, `[${now}] Kullanıcı: ${username} | Şifre: ${password}\n`);
  } catch(e) {}
}

function logPlayerActivity(data) {}

module.exports = { logNewAccount, logPlayerActivity };