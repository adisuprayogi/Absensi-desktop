'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Pembaruan struktur database antar versi aplikasi.
 *
 * Nomor skema disimpan di dalam berkas database sendiri (PRAGMA user_version).
 * Saat aplikasi dibuka, setiap migrasi bernomor lebih besar dari nomor itu
 * dijalankan berurutan, masing-masing TEPAT SEKALI dan di dalam transaksi:
 * bila gagal, langkah itu dibatalkan seluruhnya dan database tetap seperti
 * sebelum langkah tersebut. Sebelum migrasi pertama berjalan, database
 * disalin utuh ke folder backup.
 *
 * Menambah perubahan struktur di versi berikutnya:
 *   1. ubah schema.sql (dipakai untuk database baru), dan
 *   2. tambahkan langkah bernomor berikutnya di MIGRATIONS (untuk database lama).
 * Jangan pernah mengubah langkah yang sudah dirilis.
 */

/** Kolom yang ditambahkan sebelum migrasi bernomor ada (database skema v0). */
const LEGACY_COLUMNS = [
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

const MIGRATIONS = [
  {
    version: 1,
    name: 'skema dasar 1.1.0 (login, catatan aktivitas, kartu RFID, sidik jari)',
    // Menyamakan database lama mana pun ke titik awal yang sama. Aman diulang:
    // hanya menambahkan yang belum ada, tidak pernah mengubah atau menghapus.
    up(db, { schemaSql }) {
      for (const [table, column, definition] of LEGACY_COLUMNS) {
        if (tableExists(db, table) && !hasColumn(db, table, column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      db.exec(schemaSql);
    },
  },

  // Contoh langkah berikutnya (jangan dihapus; salin polanya):
  //
  // {
  //   version: 2,
  //   name: 'relasi jadwal ke shift: hapus shift tidak lagi menghapus jadwal',
  //   rebuild: true, // wajib bila memakai rebuildTable
  //   up(db, { rebuildTable }) {
  //     rebuildTable('schedules', (nama) => `CREATE TABLE ${nama} (... ON DELETE SET NULL ...)`);
  //   },
  // },
];

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

class DatabaseVersionError extends Error {}
class MigrationError extends Error {}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function hasColumn(db, table, column) {
  return db.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?').get(table, column).n > 0;
}

const columnsOf = (db, table) =>
  db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name);

/**
 * Bangun ulang tabel dengan definisi baru — satu-satunya cara di SQLite untuk
 * mengubah relasi (foreign key), tipe, atau aturan kolom. Mengikuti prosedur
 * resmi SQLite: buat tabel baru, salin data, buang yang lama, ganti nama.
 *
 * Hanya boleh dipakai di migrasi bertanda `rebuild: true`: foreign key
 * dimatikan selama langkah itu (kalau tidak, membuang tabel lama ikut
 * menghapus baris anak lewat ON DELETE CASCADE), lalu diperiksa ulang
 * sebelum disimpan.
 *
 * @param {string} table
 * @param {(nama: string) => string} createSql  CREATE TABLE dengan nama sementara
 * @param {object} [opsi]
 * @param {string[]} [opsi.columns]  kolom yang disalin; bawaan: yang ada di keduanya
 * @param {string[]} [opsi.indexes] index untuk tabel baru; bawaan: index lama dibuat ulang
 */
function rebuildTable(db, table, createSql, { columns = null, indexes = null } = {}) {
  const sementara = `${table}__baru`;
  const indexLama = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table)
    .map((r) => r.sql);

  db.exec(`DROP TABLE IF EXISTS "${sementara}"`);
  db.exec(createSql(sementara));
  const baru = columnsOf(db, sementara);
  const salin = columns || columnsOf(db, table).filter((c) => baru.includes(c));
  const daftar = salin.map((c) => `"${c}"`).join(', ');
  db.exec(`INSERT INTO "${sementara}" (${daftar}) SELECT ${daftar} FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${sementara}" RENAME TO "${table}"`);
  for (const sql of indexes || indexLama) db.exec(sql);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Bawa database ke skema terbaru.
 *
 * @param db           koneksi better-sqlite3 (foreign_keys sudah ON)
 * @param schemaSql    isi schema.sql
 * @param backupDir    folder untuk salinan sebelum upgrade
 * @param migrations   daftar langkah (bisa diganti di pengujian)
 * @returns {{from:number, to:number, fresh:boolean, backup:string|null}}
 */
function migrate(db, { schemaSql, backupDir, migrations = MIGRATIONS }) {
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  const current = db.pragma('user_version', { simple: true });

  // Versi aplikasi yang lebih lama tidak boleh menyentuh database versi baru:
  // ia tidak tahu arti tabel & kolom barunya dan bisa merusaknya.
  if (current > latest) {
    throw new DatabaseVersionError(
      `Database ini dibuat oleh versi aplikasi yang lebih baru (skema v${current}), ` +
        `sedangkan aplikasi ini hanya mengenal sampai skema v${latest}. ` +
        'Pasang versi aplikasi terbaru. Database tidak diubah sama sekali.'
    );
  }

  // Database baru: langsung skema terbaru, tanpa perlu menapaki migrasi.
  if (!tableExists(db, 'employees')) {
    db.transaction(() => {
      db.exec(schemaSql);
      db.pragma(`user_version = ${latest}`);
    })();
    return { from: 0, to: latest, fresh: true, backup: null };
  }
  if (current === latest) return { from: current, to: latest, fresh: false, backup: null };

  // Salinan utuh sebelum apa pun diubah. VACUUM INTO menghasilkan berkas
  // database yang rapi dan konsisten, termasuk isi berkas WAL.
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `sebelum-upgrade-v${current}-ke-v${latest}-${stamp()}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

  for (const m of migrations.filter((x) => x.version > current)) {
    // PRAGMA foreign_keys tidak berpengaruh di dalam transaksi, jadi diatur di luar.
    if (m.rebuild) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        m.up(db, {
          schemaSql,
          rebuildTable: (table, createSql, opsi) => rebuildTable(db, table, createSql, opsi),
        });
        if (m.rebuild) {
          const rusak = db.pragma('foreign_key_check');
          if (rusak.length) {
            throw new Error(`${rusak.length} baris di tabel ${rusak[0].table} kehilangan pasangan relasinya`);
          }
        }
        db.pragma(`user_version = ${m.version}`);
      })();
    } catch (err) {
      throw new MigrationError(
        `Pembaruan database ke skema v${m.version} (${m.name}) gagal: ${err.message}\n\n` +
          'Langkah itu dibatalkan seluruhnya, jadi data tidak rusak. ' +
          `Salinan database sebelum pembaruan tersimpan di:\n${backup}`
      );
    } finally {
      if (m.rebuild) db.pragma('foreign_keys = ON');
    }
  }
  return { from: current, to: latest, fresh: false, backup };
}

module.exports = {
  migrate,
  rebuildTable,
  MIGRATIONS,
  LATEST,
  DatabaseVersionError,
  MigrationError,
};
