'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const db = require('../db');
const { LATEST } = require('../db/migrations');
const { settings } = require('./masters');

/** Tabel yang wajib ada agar sebuah berkas diakui sebagai database aplikasi ini. */
const REQUIRED_TABLES = ['employees', 'shifts', 'attendance_logs', 'settings'];

const PREFIX_AUTO = 'otomatis';
const PREFIX_MANUAL = 'manual';
const PREFIX_SAFETY = 'sebelum-pulih';
// Dibuat otomatis tepat sebelum database diperbarui ke skema versi baru.
const PREFIX_UPGRADE = 'sebelum-upgrade';

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Folder tujuan backup: bisa diubah pengguna, bawaannya di dalam folder data. */
function folder() {
  const custom = settings.get('backup_folder', '');
  const dir = custom && custom.trim() ? custom.trim() : path.join(db.getUserDataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} byte`;
}

/**
 * Periksa sebuah berkas sebelum dipercaya sebagai backup.
 *
 * Ini yang membedakan pemulihan yang aman dari yang merusak: berkas dibuka
 * read-only, diperiksa keutuhannya, dipastikan punya tabel yang benar, lalu
 * isinya diringkas supaya pengguna tahu persis apa yang akan dipulihkan.
 */
function inspect(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'Berkas tidak ditemukan.' };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 512) {
    return { ok: false, error: 'Berkas terlalu kecil untuk sebuah database.' };
  }

  // Berkas SQLite selalu diawali penanda ini.
  const head = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1', 0, 15) !== 'SQLite format 3') {
    return { ok: false, error: 'Berkas ini bukan database SQLite.' };
  }

  let probe = null;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });

    const cek = probe.pragma('quick_check', { simple: true });
    if (String(cek) !== 'ok') {
      return { ok: false, error: `Database rusak (${cek}).` };
    }

    const tables = new Set(
      probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    // Backup dari versi aplikasi yang lebih baru tidak bisa dipakai di sini:
    // setelah dipulihkan, aplikasi ini akan menolak membukanya.
    const skema = probe.pragma('user_version', { simple: true });
    if (skema > LATEST) {
      return {
        ok: false,
        error: `Backup ini dibuat oleh versi aplikasi yang lebih baru (skema v${skema}; aplikasi ini sampai v${LATEST}). Perbarui aplikasi dulu sebelum memulihkannya.`,
      };
    }

    const hilang = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (hilang.length) {
      return {
        ok: false,
        error: `Database ini bukan milik aplikasi Absensi Karyawan (tabel ${hilang.join(', ')} tidak ada).`,
      };
    }

    const hitung = (sql, fallback = 0) => {
      try {
        const row = probe.prepare(sql).get();
        return row ? Object.values(row)[0] : fallback;
      } catch {
        return fallback;
      }
    };

    return {
      ok: true,
      filePath,
      fileName: path.basename(filePath),
      size: stat.size,
      sizeText: humanSize(stat.size),
      modified: stat.mtime.toISOString(),
      employees: hitung('SELECT COUNT(*) FROM employees'),
      logs: hitung('SELECT COUNT(*) FROM attendance_logs'),
      devices: hitung('SELECT COUNT(*) FROM devices'),
      schemaVersion: skema,
      firstLog: hitung('SELECT MIN(ts) FROM attendance_logs', null),
      lastLog: hitung('SELECT MAX(ts) FROM attendance_logs', null),
      company: (() => {
        try {
          const row = probe.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
          return row ? row.value : '';
        } catch {
          return '';
        }
      })(),
    };
  } catch (err) {
    return { ok: false, error: `Tidak bisa membaca berkas: ${err.message}` };
  } finally {
    if (probe) {
      try {
        probe.close();
      } catch {
        /* sudah tertutup */
      }
    }
  }
}

/** Jenis backup dibaca dari awalan nama berkasnya. */
function kindOf(name) {
  if (name.startsWith(PREFIX_AUTO)) return 'otomatis';
  if (name.startsWith(PREFIX_SAFETY) || name.startsWith(PREFIX_UPGRADE)) return 'pengaman';
  return 'manual';
}

/** Daftar backup di folder tujuan, terbaru lebih dulu. */
function list() {
  const dir = folder();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.db'));
  } catch {
    return { folder: dir, items: [] };
  }

  const items = names
    .map((name) => {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      return {
        name,
        filePath: full,
        size: stat.size,
        sizeText: humanSize(stat.size),
        modified: stat.mtime.toISOString(),
        modifiedMs: stat.mtimeMs,
        kind: kindOf(name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.modifiedMs - a.modifiedMs);

  return { folder: dir, items };
}

/**
 * Nama berkas yang dijamin belum terpakai.
 *
 * Cap waktu hanya sampai detik, jadi dua backup yang dibuat berturut-turut
 * dalam detik yang sama akan bertabrakan dan saling menimpa tanpa peringatan.
 */
function uniquePath(candidate) {
  if (!fs.existsSync(candidate)) return candidate;
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const base = path.basename(candidate, ext);
  for (let i = 2; i < 1000; i++) {
    const next = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  throw new Error('Terlalu banyak backup dengan nama serupa.');
}

/**
 * Buat satu backup. `targetPath` diisi bila pengguna memilih lokasi sendiri;
 * bila kosong, disimpan ke folder backup dengan nama bertanggal.
 */
async function create({ targetPath = null, auto = false } = {}) {
  // Lokasi pilihan pengguna dipakai apa adanya: menimpa di sana adalah
  // keputusannya sendiri, dan dialog simpan sudah menanyakannya.
  const file = targetPath
    ? targetPath
    : uniquePath(path.join(folder(), `${auto ? PREFIX_AUTO : PREFIX_MANUAL}-${stamp()}.db`));
  fs.mkdirSync(path.dirname(file), { recursive: true });

  await db.backupTo(file);

  const stat = fs.statSync(file);
  if (!auto) settings.set('last_manual_backup', new Date().toISOString());
  settings.set('last_backup_at', new Date().toISOString());

  return {
    ok: true,
    filePath: file,
    fileName: path.basename(file),
    size: stat.size,
    sizeText: humanSize(stat.size),
  };
}

/**
 * Buang backup otomatis yang paling lama, sisakan sejumlah `keep`.
 * Backup manual dan salinan pengaman tidak pernah dihapus otomatis — keduanya
 * dibuat atas keputusan pengguna, bukan oleh penjadwal.
 */
function prune(keep = null) {
  const batas = Math.max(1, Number(keep != null ? keep : settings.get('auto_backup_keep', '14')) || 14);
  const otomatis = list().items.filter((i) => i.kind === 'otomatis');
  const dibuang = otomatis.slice(batas);
  for (const item of dibuang) {
    try {
      fs.unlinkSync(item.filePath);
    } catch {
      /* mungkin sedang dipakai; coba lagi lain waktu */
    }
  }
  return { removed: dibuang.length, kept: Math.min(otomatis.length, batas) };
}

/**
 * Backup otomatis harian. Dipanggil saat aplikasi dibuka dan berkala setelahnya;
 * dilewati bila hari ini sudah pernah dibuat.
 */
async function runAuto() {
  if (settings.get('auto_backup_enabled', '1') !== '1') return { ok: false, skipped: 'nonaktif' };

  const terakhir = settings.get('last_auto_backup', '');
  const hariIni = new Date().toDateString();
  if (terakhir && new Date(terakhir).toDateString() === hariIni) {
    return { ok: false, skipped: 'sudah ada hari ini' };
  }

  const hasil = await create({ auto: true });
  settings.set('last_auto_backup', new Date().toISOString());
  prune();
  return hasil;
}

/**
 * Pulihkan database dari sebuah backup.
 *
 * Urutannya sengaja: periksa dulu, buat salinan pengaman, baru menimpa. Dengan
 * begitu berkas yang salah ditolak sebelum merusak apa pun, dan kalaupun hasil
 * pemulihannya tidak sesuai harapan, data sebelumnya masih bisa dikembalikan.
 *
 * Pemanggil bertanggung jawab menghentikan koneksi mesin dan menutup jendela
 * cetak lebih dulu, lalu menjalankan ulang aplikasi setelah ini selesai.
 */
async function restore(filePath) {
  const periksa = inspect(filePath);
  if (!periksa.ok) return { ok: false, error: periksa.error };

  const target = db.getPath();
  if (path.resolve(filePath) === path.resolve(target)) {
    return { ok: false, error: 'Berkas yang dipilih adalah database yang sedang dipakai.' };
  }

  let safety = null;
  try {
    safety = uniquePath(path.join(folder(), `${PREFIX_SAFETY}-${stamp()}.db`));
    await db.backupTo(safety);
  } catch (err) {
    return { ok: false, error: `Gagal membuat salinan pengaman: ${err.message}` };
  }

  db.close();
  for (const extra of db.sidecarFiles()) {
    try {
      if (fs.existsSync(extra)) fs.unlinkSync(extra);
    } catch {
      /* akan tertimpa saat database dibuka lagi */
    }
  }

  try {
    fs.copyFileSync(filePath, target);
  } catch (err) {
    // Kembalikan keadaan semula supaya aplikasi tetap bisa dibuka.
    try {
      fs.copyFileSync(safety, target);
    } catch {
      /* salinan pengaman tetap tersimpan di folder backup */
    }
    return { ok: false, error: `Gagal menyalin berkas: ${err.message}`, safety };
  }

  return { ok: true, safety, info: periksa };
}

function remove(filePath) {
  const dir = folder();
  // Hanya berkas di dalam folder backup yang boleh dihapus lewat aplikasi.
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) {
    throw new Error('Hanya berkas di folder backup yang bisa dihapus dari sini.');
  }
  fs.unlinkSync(filePath);
  return true;
}

module.exports = { folder, list, create, inspect, restore, remove, prune, runAuto, humanSize };
