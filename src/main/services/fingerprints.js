'use strict';

const db = require('../db');
const { placeholders } = require('../util/sql');

/**
 * Simpanan template sidik jari di aplikasi.
 *
 * Template adalah data biner milik algoritma mesin — tidak bisa dibuat dari
 * komputer, hanya bisa diunduh dari mesin lalu dipasang kembali. Menyimpannya
 * di sini membuat sidik jari punya cadangan (ikut masuk backup database) dan
 * bisa dipasang ke mesin lain tanpa mesin asalnya harus menyala.
 *
 * Kuncinya PIN, bukan uid: nomor internal berbeda-beda di tiap mesin.
 */
const fingerprints = {
  /** Simpan sekumpulan template; yang sudah ada dengan jari sama ditimpa. */
  saveMany(rows, { deviceId = null, deviceName = null } = {}) {
    if (!rows || !rows.length) return { saved: 0, pins: 0 };

    const stmt = db.get().prepare(`
      INSERT INTO fingerprints (user_pin, finger_id, template, size, valid,
                                source_device_id, source_name, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(user_pin, finger_id) DO UPDATE SET
        template = excluded.template, size = excluded.size, valid = excluded.valid,
        source_device_id = excluded.source_device_id, source_name = excluded.source_name,
        captured_at = excluded.captured_at
    `);

    let saved = 0;
    const pins = new Set();
    const tx = db.get().transaction((list) => {
      for (const r of list) {
        const pin = String(r.user_pin || '').trim();
        if (!pin || !r.template || !r.template.length) continue;
        stmt.run(
          pin,
          Number(r.finger_id) || 0,
          r.template,
          r.template.length,
          r.valid === 0 ? 0 : 1,
          deviceId,
          deviceName
        );
        saved += 1;
        pins.add(pin);
      }
    });
    tx(rows);
    return { saved, pins: pins.size };
  },

  /** Semua template milik daftar PIN tertentu, siap dipasang ke mesin. */
  forPins(pins) {
    if (!pins || !pins.length) return [];
    return db.get()
      .prepare(`
        SELECT user_pin, finger_id, template, valid
        FROM fingerprints
        WHERE valid = 1 AND user_pin IN (${placeholders(pins)})
        ORDER BY user_pin, finger_id
      `)
      .all(...pins.map(String));
  },

  /** Seluruh PIN yang punya sidik jari tersimpan, beserta jumlahnya. */
  countByPin() {
    const rows = db.get()
      .prepare('SELECT user_pin, COUNT(*) AS n FROM fingerprints WHERE valid = 1 GROUP BY user_pin')
      .all();
    return new Map(rows.map((r) => [String(r.user_pin), r.n]));
  },

  /** PIN yang punya sidik jari tersimpan di aplikasi. */
  pinsWithTemplates() {
    return db.get()
      .prepare('SELECT DISTINCT user_pin FROM fingerprints WHERE valid = 1 ORDER BY user_pin')
      .all()
      .map((r) => String(r.user_pin));
  },

  /** Ringkasan untuk ditampilkan di halaman. */
  stats() {
    const r = db.get()
      .prepare(`
        SELECT COUNT(*) AS templates, COUNT(DISTINCT user_pin) AS pins,
               SUM(size) AS bytes, MAX(captured_at) AS terakhir
        FROM fingerprints WHERE valid = 1
      `)
      .get();
    const sumber = db.get()
      .prepare(`
        SELECT IFNULL(source_name, '(tidak diketahui)') AS nama, COUNT(*) AS n
        FROM fingerprints WHERE valid = 1 GROUP BY source_name ORDER BY n DESC
      `)
      .all();
    return {
      templates: r.templates || 0,
      pins: r.pins || 0,
      bytes: r.bytes || 0,
      terakhir: r.terakhir || null,
      sumber,
    };
  },

  /** Hapus template milik PIN tertentu, atau seluruhnya bila pins null. */
  remove(pins = null) {
    if (pins === null) {
      const n = db.get().prepare('SELECT COUNT(*) AS n FROM fingerprints').get().n;
      db.get().prepare('DELETE FROM fingerprints').run();
      return { removed: n };
    }
    if (!pins.length) return { removed: 0 };
    const info = db.get()
      .prepare(`DELETE FROM fingerprints WHERE user_pin IN (${placeholders(pins)})`)
      .run(...pins.map(String));
    return { removed: info.changes };
  },
};

module.exports = { fingerprints };
