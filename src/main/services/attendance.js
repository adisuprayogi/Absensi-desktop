'use strict';

const db = require('../db');
const { bindAll } = require('../util/sql');
const { toDateStr, toDateTimeStr, parseDateTime } = require('../util/datetime');
const { VERIFY_MODE, PUNCH_STATE } = require('../zk/const');

/**
 * Simpan log scan ke database.
 * Duplikat ditangani dua lapis: UNIQUE(device_id, user_pin, ts) untuk scan yang
 * benar-benar sama, dan `duplicate_window` untuk scan beruntun dalam hitungan
 * detik (jari ditempel dua kali).
 */
function insertLogs(deviceId, records, source = 'tarik') {
  if (!records || !records.length) return { inserted: 0, duplicate: 0, unknown: 0 };

  const database = db.get();
  const dupWindowRow = database.prepare("SELECT value FROM settings WHERE key = 'duplicate_window'").get();
  const dupWindow = Math.max(0, Number(dupWindowRow ? dupWindowRow.value : 60) || 0);

  const empByPin = new Map(
    database.prepare('SELECT id, pin FROM employees').all().map((e) => [String(e.pin), e.id])
  );

  const insert = database.prepare(`
    INSERT OR IGNORE INTO attendance_logs
      (device_id, user_pin, employee_id, ts, log_date, status, punch, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const nearby = database.prepare(`
    SELECT ts FROM attendance_logs
    WHERE user_pin = ? AND ts BETWEEN ? AND ? LIMIT 1
  `);

  let inserted = 0;
  let duplicate = 0;
  let unknown = 0;

  const tx = database.transaction((list) => {
    for (const rec of list) {
      const pin = String(rec.userId != null ? rec.userId : rec.user_pin || '').trim();
      if (!pin) continue;

      const at = rec.timestamp instanceof Date ? rec.timestamp : parseDateTime(rec.timestamp);
      if (!at || Number.isNaN(at.getTime())) continue;

      const ts = toDateTimeStr(at);
      const logDate = toDateStr(at);
      const employeeId = empByPin.get(pin) || null;
      if (!employeeId) unknown += 1;

      if (dupWindow > 0) {
        const lo = toDateTimeStr(new Date(at.getTime() - dupWindow * 1000));
        const hi = toDateTimeStr(new Date(at.getTime() + dupWindow * 1000));
        if (nearby.get(pin, lo, hi)) {
          duplicate += 1;
          continue;
        }
      }

      const info = insert.run(
        deviceId,
        pin,
        employeeId,
        ts,
        logDate,
        rec.status != null ? rec.status : 0,
        rec.punch != null ? rec.punch : 0,
        source
      );
      if (info.changes > 0) inserted += 1;
      else duplicate += 1;
    }
  });
  tx(records);

  return { inserted, duplicate, unknown, fetched: records.length };
}

const attendance = {
  /** Daftar log mentah dengan filter dan paging. */
  list({ from = null, to = null, employeeId = null, deviceId = null, search = '', unknownOnly = false, limit = 500, offset = 0 } = {}) {
    const where = [];
    const params = {};
    if (from) {
      where.push('l.log_date >= @from');
      params.from = from;
    }
    if (to) {
      where.push('l.log_date <= @to');
      params.to = to;
    }
    if (employeeId) {
      where.push('l.employee_id = @emp');
      params.emp = employeeId;
    }
    if (deviceId) {
      where.push('l.device_id = @dev');
      params.dev = deviceId;
    }
    if (unknownOnly) where.push('l.employee_id IS NULL');
    if (search) {
      where.push("(IFNULL(e.name, '') LIKE @q OR l.user_pin LIKE @q)");
      params.q = `%${search}%`;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = bindAll(
      db.get().prepare(`
        SELECT l.*, e.name AS employee_name, e.nip, d.name AS device_name
        FROM attendance_logs l
        LEFT JOIN employees e ON e.id = l.employee_id
        LEFT JOIN devices d ON d.id = l.device_id
        ${whereSql}
        ORDER BY l.ts DESC, l.id DESC
        LIMIT @limit OFFSET @offset
      `),
      [],
      { ...params, limit: Math.min(Number(limit) || 500, 5000), offset: Number(offset) || 0 }
    );

    const totalRow = bindAll(
      db.get().prepare(`
        SELECT COUNT(*) AS n FROM attendance_logs l
        LEFT JOIN employees e ON e.id = l.employee_id
        ${whereSql}
      `),
      [],
      params
    )[0];

    return {
      total: totalRow ? totalRow.n : 0,
      rows: rows.map((r) => ({
        ...r,
        verify_label: VERIFY_MODE[r.status] || 'Lainnya',
        punch_label: PUNCH_STATE[r.punch] || '-',
      })),
    };
  },

  /** Scan terbaru untuk panel realtime di dashboard. */
  recent(limit = 20) {
    return db.get().prepare(`
      SELECT l.*, e.name AS employee_name, d.name AS device_name
      FROM attendance_logs l
      LEFT JOIN employees e ON e.id = l.employee_id
      LEFT JOIN devices d ON d.id = l.device_id
      ORDER BY l.ts DESC, l.id DESC LIMIT ?
    `).all(Math.min(Number(limit) || 20, 200));
  },

  /** Tambah scan manual (koreksi HRD). */
  addManual({ employeeId, ts, note = null }) {
    const emp = db.get().prepare('SELECT pin FROM employees WHERE id = ?').get(employeeId);
    if (!emp) throw new Error('Karyawan tidak ditemukan');
    const at = parseDateTime(ts);
    if (!at) throw new Error('Format waktu tidak valid');
    const info = db.get().prepare(`
      INSERT OR IGNORE INTO attendance_logs
        (device_id, user_pin, employee_id, ts, log_date, status, punch, source)
      VALUES (NULL, ?, ?, ?, ?, 255, 255, 'manual')
    `).run(emp.pin, employeeId, toDateTimeStr(at), toDateStr(at));
    if (info.changes === 0) throw new Error('Scan pada waktu tersebut sudah ada');
    if (note) {
      db.get().prepare('UPDATE attendance_logs SET source = ? WHERE id = ?')
        .run(`manual: ${note}`.slice(0, 200), info.lastInsertRowid);
    }
    return info.lastInsertRowid;
  },

  remove(id) {
    db.get().prepare('DELETE FROM attendance_logs WHERE id = ?').run(id);
    return true;
  },

  /** Hapus log pada rentang tanggal (mis. membersihkan data uji coba). */
  removeRange({ from, to }) {
    const info = db.get()
      .prepare('DELETE FROM attendance_logs WHERE log_date BETWEEN ? AND ?')
      .run(from, to);
    return { removed: info.changes };
  },

  /** PIN yang muncul di log tapi belum ada karyawannya. */
  unknownPins() {
    return db.get().prepare(`
      SELECT l.user_pin, COUNT(*) AS scans, MIN(l.ts) AS first_seen, MAX(l.ts) AS last_seen
      FROM attendance_logs l
      WHERE l.employee_id IS NULL
      GROUP BY l.user_pin ORDER BY scans DESC
    `).all();
  },

  stats() {
    const d = db.get();
    return {
      total: d.prepare('SELECT COUNT(*) AS n FROM attendance_logs').get().n,
      unknown: d.prepare('SELECT COUNT(*) AS n FROM attendance_logs WHERE employee_id IS NULL').get().n,
      first: d.prepare('SELECT MIN(ts) AS v FROM attendance_logs').get().v,
      last: d.prepare('SELECT MAX(ts) AS v FROM attendance_logs').get().v,
    };
  },
};

module.exports = { attendance, insertLogs };
