'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

let db = null;
let dbPath = null;
let userDataDir = null;

const DEFAULT_SETTINGS = {
  company_name: 'Nama Perusahaan',
  company_address: '',
  auto_sync_enabled: '1',
  auto_sync_interval: '15', // menit
  live_capture_enabled: '1',
  duplicate_window: '60', // detik; scan berulang dalam rentang ini diabaikan
  window_before_hours: '6', // toleransi scan sebelum jam masuk shift
  window_after_hours: '6', // toleransi scan setelah jam pulang shift
  auto_backup_enabled: '1',
  auto_backup_keep: '14', // jumlah backup otomatis yang disimpan
  backup_folder: '', // kosong = folder bawaan di dalam data aplikasi
  report_footer: '',
  report_signer: '',
  report_signer_title: 'HRD',
};

function seed(database) {
  const shiftCount = database.prepare('SELECT COUNT(*) AS n FROM shifts').get().n;
  if (shiftCount === 0) {
    const ins = database.prepare(`
      INSERT INTO shifts (code, name, start_time, end_time, break_minutes,
                          late_tolerance, early_tolerance, overtime_after, is_off, color)
      VALUES (@code, @name, @start_time, @end_time, @break_minutes,
              @late_tolerance, @early_tolerance, @overtime_after, @is_off, @color)
    `);
    const rows = [
      { code: 'P', name: 'Pagi', start_time: '08:00', end_time: '17:00', break_minutes: 60, late_tolerance: 10, early_tolerance: 0, overtime_after: 30, is_off: 0, color: '#4f7cff' },
      { code: 'S', name: 'Siang', start_time: '14:00', end_time: '22:00', break_minutes: 60, late_tolerance: 10, early_tolerance: 0, overtime_after: 30, is_off: 0, color: '#f59e0b' },
      { code: 'M', name: 'Malam', start_time: '22:00', end_time: '06:00', break_minutes: 60, late_tolerance: 10, early_tolerance: 0, overtime_after: 30, is_off: 0, color: '#6366f1' },
      { code: 'OFF', name: 'Libur', start_time: '00:00', end_time: '00:00', break_minutes: 0, late_tolerance: 0, early_tolerance: 0, overtime_after: 0, is_off: 1, color: '#94a3b8' },
    ];
    const tx = database.transaction((list) => list.forEach((r) => ins.run(r)));
    tx(rows);
  }

  const leaveCount = database.prepare('SELECT COUNT(*) AS n FROM leave_types').get().n;
  if (leaveCount === 0) {
    const ins = database.prepare(
      'INSERT INTO leave_types (code, name, counts_as_present, is_paid, color) VALUES (?, ?, ?, ?, ?)'
    );
    const tx = database.transaction(() => {
      ins.run('C', 'Cuti', 0, 1, '#8b5cf6');
      ins.run('S', 'Sakit', 0, 1, '#ef4444');
      ins.run('I', 'Izin', 0, 1, '#f59e0b');
      ins.run('DL', 'Dinas Luar', 1, 1, '#10b981');
      ins.run('CTG', 'Cuti Tanpa Gaji', 0, 0, '#64748b');
    });
    tx();
  }

  // Jadwal bawaan: Senin-Jumat shift Pagi, Sabtu & Minggu libur.
  const dowCount = database.prepare('SELECT COUNT(*) AS n FROM default_schedule').get().n;
  if (dowCount === 0) {
    const pagi = database.prepare("SELECT id FROM shifts WHERE code = 'P'").get();
    const off = database.prepare("SELECT id FROM shifts WHERE code = 'OFF'").get();
    const ins = database.prepare('INSERT INTO default_schedule (dow, shift_id) VALUES (?, ?)');
    const tx = database.transaction(() => {
      for (let dow = 0; dow <= 6; dow++) {
        const isWeekend = dow === 0 || dow === 6;
        ins.run(dow, isWeekend ? (off && off.id) || null : (pagi && pagi.id) || null);
      }
    });
    tx();
  }

  const insSetting = database.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  const tx = database.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
  });
  tx();
}

/**
 * Kolom yang ditambahkan setelah versi pertama dirilis.
 *
 * schema.sql memakai CREATE TABLE IF NOT EXISTS, jadi tabel yang sudah ada di
 * database lama tidak ikut berubah. Kolom baru harus ditambahkan di sini agar
 * pengguna yang sudah memakai aplikasi tidak kehilangan datanya saat upgrade.
 */
const MIGRATIONS = [
  ['employees', 'card', 'INTEGER NOT NULL DEFAULT 0'],
  ['employees', 'privilege', 'INTEGER NOT NULL DEFAULT 0'],
  ['employees', 'device_password', 'TEXT'],
  ['device_users', 'finger_count', 'INTEGER DEFAULT 0'],
  ['device_users', 'base_name', 'TEXT'],
  ['device_users', 'base_card', 'INTEGER'],
  ['device_users', 'base_privilege', 'INTEGER'],
  ['device_users', 'base_at', 'TEXT'],
  ['device_users', 'password', 'TEXT'],
  ['devices', 'fp_support', 'INTEGER'],
];

function migrate(database) {
  for (const [table, column, definition] of MIGRATIONS) {
    const exists = database
      .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column).n;
    if (!exists) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function init(baseDir) {
  if (db) return db;
  userDataDir = baseDir;
  const dir = path.join(baseDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'absensi.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  seed(db);
  return db;
}

function get() {
  if (!db) throw new Error('Database belum diinisialisasi');
  return db;
}

function getPath() {
  return dbPath;
}

/** Folder data aplikasi; dipakai layanan backup untuk menaruh salinannya. */
function getUserDataDir() {
  return userDataDir;
}

/**
 * Berkas pendamping mode WAL. Keduanya wajib ikut dibuang saat database
 * diganti, kalau tidak SQLite akan menggabungkan sisa transaksi database lama
 * ke dalam berkas hasil pemulihan.
 */
function sidecarFiles() {
  return dbPath ? [dbPath + '-wal', dbPath + '-shm'] : [];
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

/** Salin database ke lokasi lain (fitur backup). */
function backupTo(targetPath) {
  return get().backup(targetPath);
}

module.exports = { init, get, getPath, getUserDataDir, sidecarFiles, close, backupTo };
