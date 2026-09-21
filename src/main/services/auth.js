'use strict';

const crypto = require('node:crypto');

const db = require('../db');

/**
 * Pengguna aplikasi, password, kode pemulihan, dan hak akses.
 *
 * Aplikasi desktop ini hanya punya satu sesi pada satu waktu (satu jendela,
 * satu instansi), jadi "sesi" cukup berupa pengguna yang sedang masuk dan
 * disimpan di proses utama — bukan token yang dibawa halaman.
 */

const ROLES = { admin: 'Admin', operator: 'Operator' };
const MIN_PASSWORD = 8;
const USERNAME = /^[a-zA-Z0-9._-]{3,32}$/;

// Parameter scrypt ikut disimpan di hash, supaya bisa dinaikkan kelak tanpa
// membuat password lama tidak bisa dipakai.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifySecret(secret, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(secret), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// ------------------------------------------------------ kode pemulihan

// Tanpa huruf/angka yang mudah tertukar saat dicatat tangan (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function metaGet(key) {
  const row = db.get().prepare('SELECT value FROM auth_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function metaSet(key, value) {
  db.get()
    .prepare('INSERT INTO auth_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** Buat kode pemulihan baru; yang lama langsung tidak berlaku. */
function rotateRecoveryCode() {
  const code = newRecoveryCode();
  metaSet('recovery_code_hash', hashSecret(normalizeCode(code)));
  metaSet('recovery_code_at', new Date().toISOString());
  return code;
}

// --------------------------------------------- pembatas salah password

// Disimpan di memori saja: cukup untuk menghentikan tebakan beruntun dari
// layar login, dan otomatis bersih saat aplikasi ditutup.
const MAX_FAILS = 5;
const LOCK_MS = 2 * 60 * 1000;
const failures = new Map();

function checkLock(key) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) {
    const detik = Math.ceil((f.until - Date.now()) / 1000);
    throw new Error(`Terlalu banyak percobaan gagal. Coba lagi dalam ${detik} detik.`);
  }
}

function recordFail(key) {
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) {
    f.count = 0;
    f.until = Date.now() + LOCK_MS;
  }
  failures.set(key, f);
}

const clearFails = (key) => failures.delete(key);

// ------------------------------------------------------------- pengguna

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    role_label: ROLES[row.role] || row.role,
    active: row.active,
    must_change_password: row.must_change_password,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

const findRow = (id) => db.get().prepare('SELECT * FROM app_users WHERE id = ?').get(id);
const findByUsername = (username) =>
  db.get().prepare('SELECT * FROM app_users WHERE username = ?').get(String(username || '').trim());

function checkPassword(password) {
  if (String(password || '').length < MIN_PASSWORD) {
    throw new Error(`Password minimal ${MIN_PASSWORD} karakter.`);
  }
}

function checkUsername(username) {
  if (!USERNAME.test(String(username || '').trim())) {
    throw new Error('Nama pengguna 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda minus.');
  }
}

function checkRole(role) {
  if (!ROLES[role]) throw new Error('Peran pengguna tidak dikenal.');
}

const countActiveAdmins = () =>
  db.get().prepare("SELECT COUNT(*) AS n FROM app_users WHERE role = 'admin' AND active = 1").get().n;

function insertUser({ username, fullName, role, password, mustChange }) {
  checkUsername(username);
  checkRole(role);
  checkPassword(password);
  const name = String(fullName || '').trim();
  if (!name) throw new Error('Nama lengkap wajib diisi.');
  if (findByUsername(username)) throw new Error('Nama pengguna tersebut sudah dipakai.');
  const info = db.get()
    .prepare(`
      INSERT INTO app_users (username, full_name, role, password_hash, must_change_password)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(String(username).trim(), name, role, hashSecret(password), mustChange ? 1 : 0);
  return publicUser(findRow(info.lastInsertRowid));
}

const auth = {
  ROLES,
  MIN_PASSWORD,

  needsSetup() {
    return db.get().prepare('SELECT COUNT(*) AS n FROM app_users').get().n === 0;
  },

  /** Pengguna aktif terbaru dari database; null bila sudah dinonaktifkan. */
  current(userId) {
    const row = userId ? findRow(userId) : null;
    return row && row.active ? publicUser(row) : null;
  },

  /**
   * Pembuatan Admin pertama. Hanya bisa sekali: setelah ada pengguna, pintu ini
   * tertutup, supaya siapa pun tidak bisa membuat Admin baru dari layar awal.
   */
  setup({ username, fullName, password }) {
    if (!auth.needsSetup()) throw new Error('Akun Admin sudah pernah dibuat.');
    const user = insertUser({ username, fullName, role: 'admin', password, mustChange: false });
    return { user, recoveryCode: rotateRecoveryCode() };
  },

  login({ username, password }) {
    const key = `login:${String(username || '').trim().toLowerCase()}`;
    checkLock(key);
    const row = findByUsername(username);
    // Pesan sengaja sama untuk nama salah dan password salah.
    if (!row || !verifySecret(password, row.password_hash)) {
      recordFail(key);
      throw new Error('Nama pengguna atau password salah.');
    }
    if (!row.active) throw new Error('Akun ini dinonaktifkan. Hubungi Admin.');
    clearFails(key);
    db.get().prepare("UPDATE app_users SET last_login_at = datetime('now','localtime') WHERE id = ?").run(row.id);
    return publicUser(findRow(row.id));
  },

  /**
   * Atur ulang password Admin memakai kode pemulihan. Kode lama hangus dan
   * kode baru diberikan, supaya kode yang sudah terpakai tidak bisa diulang.
   */
  recover({ username, code, newPassword }) {
    const key = 'recover';
    checkLock(key);
    const row = findByUsername(username);
    const stored = metaGet('recovery_code_hash');
    const cocok = stored && verifySecret(normalizeCode(code), stored);
    if (!cocok || !row || row.role !== 'admin') {
      recordFail(key);
      throw new Error('Kode pemulihan atau nama pengguna Admin salah.');
    }
    checkPassword(newPassword);
    clearFails(key);
    db.get()
      .prepare('UPDATE app_users SET password_hash = ?, must_change_password = 0, active = 1 WHERE id = ?')
      .run(hashSecret(newPassword), row.id);
    return { user: publicUser(findRow(row.id)), recoveryCode: rotateRecoveryCode() };
  },

  changePassword(userId, { oldPassword, newPassword }) {
    const row = findRow(userId);
    if (!row || !verifySecret(oldPassword, row.password_hash)) throw new Error('Password lama salah.');
    checkPassword(newPassword);
    if (oldPassword === newPassword) throw new Error('Password baru harus berbeda dari yang lama.');
    db.get()
      .prepare('UPDATE app_users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashSecret(newPassword), userId);
    return publicUser(findRow(userId));
  },

  /** Buat ulang kode pemulihan; Admin wajib memasukkan password-nya lagi. */
  regenerateRecoveryCode(adminId, password) {
    const row = findRow(adminId);
    if (!row || !verifySecret(password, row.password_hash)) throw new Error('Password salah.');
    return rotateRecoveryCode();
  },

  recoveryCodeInfo() {
    return { createdAt: metaGet('recovery_code_at') };
  },

  // ------------------------------------------- manajemen pengguna (Admin)

  list() {
    return db.get()
      .prepare('SELECT * FROM app_users ORDER BY active DESC, role, username')
      .all()
      .map(publicUser);
  },

  /** Pengguna baru wajib mengganti password sementara dari Admin saat pertama masuk. */
  create({ username, fullName, role, password }) {
    return insertUser({ username, fullName, role, password, mustChange: true });
  },

  update(actorId, id, { fullName, role, active }) {
    const row = findRow(id);
    if (!row) throw new Error('Pengguna tidak ditemukan.');
    const name = String(fullName || '').trim();
    if (!name) throw new Error('Nama lengkap wajib diisi.');
    checkRole(role);
    const aktif = active === 0 || active === false ? 0 : 1;

    if (Number(id) === Number(actorId) && (!aktif || role !== 'admin')) {
      throw new Error('Anda tidak bisa menonaktifkan atau menurunkan peran akun sendiri.');
    }
    const kehilanganAdmin = row.role === 'admin' && row.active && (role !== 'admin' || !aktif);
    if (kehilanganAdmin && countActiveAdmins() <= 1) {
      throw new Error('Harus selalu ada minimal satu Admin aktif.');
    }

    db.get()
      .prepare('UPDATE app_users SET full_name = ?, role = ?, active = ? WHERE id = ?')
      .run(name, role, aktif, id);
    return publicUser(findRow(id));
  },

  /** Admin memberi password sementara; pengguna wajib menggantinya saat masuk. */
  resetPassword(id, newPassword) {
    const row = findRow(id);
    if (!row) throw new Error('Pengguna tidak ditemukan.');
    checkPassword(newPassword);
    db.get()
      .prepare('UPDATE app_users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(hashSecret(newPassword), id);
    clearFails(`login:${row.username.toLowerCase()}`);
    return publicUser(findRow(id));
  },
};

// ------------------------------------------------------------ hak akses

/** Boleh dipanggil sebelum masuk: layar login dan pembuatan Admin pertama. */
const PUBLIC = new Set(['app.info', 'auth.status', 'auth.setup', 'auth.login', 'auth.recover']);

/** Tetap boleh saat pengguna masih wajib mengganti password. */
const DURING_FORCED_CHANGE = new Set(['auth.logout', 'auth.changePassword']);

/**
 * Hanya Admin. Operator tetap bisa bekerja sehari-hari (tarik data, izin,
 * scan manual, jadwal, rekap), tetapi tidak bisa menghapus data, mengubah
 * konfigurasi mesin/sistem, memulihkan backup, atau mengelola pengguna.
 */
const ADMIN_ONLY = new Set([
  'settings.save',
  'departments.remove',
  'employees.remove',
  'employees.removeMany',
  'shifts.remove',
  'leaveTypes.remove',
  'leaves.remove',
  'devices.create',
  'devices.update',
  'devices.remove',
  'device.removeUsers',
  'device.clearAttendance',
  'device.restart',
  'fingerprints.remove',
  'attendance.remove',
  'attendance.removeRange',
  'backup.restore',
  'backup.remove',
  'backup.prune',
  'backup.chooseFolder',
  'users.list',
  'users.create',
  'users.update',
  'users.resetPassword',
  'users.regenerateRecovery',
  'audit.list',
]);

/**
 * Putuskan apakah `user` boleh menjalankan perintah `name`.
 * @returns {null|{code:string, message:string}} null = boleh
 */
function authorize(name, user) {
  if (PUBLIC.has(name)) return null;
  if (!user) return { code: 'AUTH_REQUIRED', message: 'Silakan masuk terlebih dahulu.' };
  if (user.must_change_password && !DURING_FORCED_CHANGE.has(name)) {
    return { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Ganti password Anda terlebih dahulu.' };
  }
  if (ADMIN_ONLY.has(name) && user.role !== 'admin') {
    return { code: 'FORBIDDEN', message: 'Hanya Admin yang boleh melakukan tindakan ini.' };
  }
  return null;
}

module.exports = { auth, authorize, hashSecret, verifySecret, ADMIN_ONLY };
