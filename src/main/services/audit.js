'use strict';

const fs = require('node:fs');
const path = require('node:path');

const db = require('../db');
const { bindGet } = require('../util/sql');

/** Catatan aktivitas: siapa melakukan tindakan penting, dan kapan. */
const audit = {
  log(user, action, detail = null) {
    db.get()
      .prepare('INSERT INTO audit_log (user_id, username, action, detail) VALUES (?, ?, ?, ?)')
      .run(user ? user.id : null, user ? user.username : null, action, detail ? String(detail).slice(0, 500) : null);
  },

  /**
   * Satu halaman catatan, terbaru lebih dulu, beserta jumlah seluruhnya.
   * `limit` null = semua (dipakai pilihan "Semua" di tabel).
   */
  list({ search = '', limit = 50, offset = 0 } = {}) {
    const q = String(search || '').trim();
    const where = q ? 'WHERE username LIKE @q OR action LIKE @q OR detail LIKE @q' : '';
    const cari = q ? { q: `%${q}%` } : {};
    const total = bindGet(db.get().prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`), [], cari).n;
    const rows = db.get()
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      // LIMIT -1 di SQLite berarti tanpa batas.
      .all({ ...cari, limit: limit == null ? -1 : Math.max(1, Number(limit) || 50), offset: Math.max(0, Number(offset) || 0) });
    return { rows, total };
  },

  /**
   * Pemulihan backup mengganti seluruh database, termasuk catatan ini. Catatan
   * "pulihkan backup" karena itu dititipkan ke berkas, lalu ditulis ke
   * database hasil pemulihan saat aplikasi dibuka kembali.
   */
  savePending(entries) {
    fs.writeFileSync(pendingPath(), JSON.stringify(entries));
  },

  flushPending() {
    const file = pendingPath();
    if (!fs.existsSync(file)) return 0;
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* berkas rusak: dibuang saja */
    }
    const stmt = db.get().prepare(
      'INSERT INTO audit_log (at, user_id, username, action, detail) VALUES (?, ?, ?, ?, ?)'
    );
    for (const e of Array.isArray(entries) ? entries : []) {
      stmt.run(e.at, e.user_id || null, e.username || null, String(e.action || ''), e.detail || null);
    }
    fs.unlinkSync(file);
    return entries.length;
  },
};

function pendingPath() {
  return path.join(db.getUserDataDir(), 'pending-audit.json');
}

module.exports = { audit };
