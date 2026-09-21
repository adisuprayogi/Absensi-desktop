'use strict';

const db = require('../db');
const { dateRange, dayOfWeek, monthBounds } = require('../util/datetime');
const { bindAll, placeholders } = require('../util/sql');

/** Jadwal bawaan mingguan (dipakai bila tidak ada jadwal eksplisit). */
const defaultSchedule = {
  list() {
    return db.get().prepare(`
      SELECT ds.dow, ds.shift_id, s.name AS shift_name, s.code AS shift_code, s.is_off
      FROM default_schedule ds LEFT JOIN shifts s ON s.id = ds.shift_id
      ORDER BY ds.dow
    `).all();
  },
  set(dow, shiftId) {
    db.get()
      .prepare('INSERT INTO default_schedule (dow, shift_id) VALUES (?, ?) ON CONFLICT(dow) DO UPDATE SET shift_id = excluded.shift_id')
      .run(dow, shiftId || null);
    return true;
  },
};

/**
 * Peta shift efektif untuk sekumpulan karyawan pada rentang tanggal.
 *
 * Urutan prioritas:
 *  1. Jadwal eksplisit di halaman Jadwal Shift — selalu menang.
 *  2. Jadwal mingguan menentukan apakah hari itu HARI KERJA. Bila hari itu
 *     ditandai libur (atau tidak dijadwalkan), karyawan libur — shift bawaannya
 *     tidak membuatnya jadi masuk kerja di akhir pekan.
 *  3. Pada hari kerja, shift bawaan karyawan menentukan shift mana yang dipakai;
 *     bila kosong, dipakai shift dari jadwal mingguan.
 *
 * @returns {Map<string, object|null>} kunci `${employeeId}|${date}`
 */
function resolveShifts(employeeIds, from, to) {
  const database = db.get();
  const shifts = new Map(database.prepare('SELECT * FROM shifts').all().map((s) => [s.id, s]));

  const weekly = new Map(
    database.prepare('SELECT dow, shift_id FROM default_schedule').all().map((r) => [r.dow, r.shift_id])
  );

  const empDefaults = new Map(
    database
      .prepare(`SELECT id, default_shift_id FROM employees WHERE id IN (${placeholders(employeeIds)})`)
      .all(...employeeIds)
      .map((r) => [r.id, r.default_shift_id])
  );

  const explicit = new Map();
  if (employeeIds.length) {
    const rows = database
      .prepare(`
        SELECT employee_id, work_date, shift_id FROM schedules
        WHERE work_date BETWEEN ? AND ? AND employee_id IN (${placeholders(employeeIds)})
      `)
      .all(from, to, ...employeeIds);
    for (const r of rows) explicit.set(`${r.employee_id}|${r.work_date}`, r.shift_id);
  }

  const dates = dateRange(from, to);
  const out = new Map();
  for (const empId of employeeIds) {
    for (const date of dates) {
      const key = `${empId}|${date}`;
      let shiftId;
      if (explicit.has(key)) {
        shiftId = explicit.get(key);
      } else {
        const weeklyId = weekly.get(dayOfWeek(date)) || null;
        const weeklyShift = weeklyId ? shifts.get(weeklyId) : null;
        const isRestDay = !weeklyShift || weeklyShift.is_off;
        shiftId = isRestDay ? weeklyId : empDefaults.get(empId) || weeklyId;
      }
      out.set(key, shiftId ? shifts.get(shiftId) || null : null);
    }
  }
  return out;
}

const schedules = {
  /** Matriks jadwal satu bulan untuk tabel jadwal. */
  matrix({ month, departmentId = null, search = '' }) {
    const { start, end } = monthBounds(month);
    const where = ['e.active = 1'];
    const params = {};
    if (departmentId) {
      where.push('e.department_id = @dept');
      params.dept = departmentId;
    }
    if (search) {
      where.push('(e.name LIKE @q OR e.pin LIKE @q)');
      params.q = `%${search}%`;
    }
    const empSql = `
      SELECT e.id, e.pin, e.name, d.name AS department_name
      FROM employees e LEFT JOIN departments d ON d.id = e.department_id
      WHERE ${where.join(' AND ')} ORDER BY e.name
    `;
    const emps = bindAll(db.get().prepare(empSql), [], params);

    const ids = emps.map((e) => e.id);
    const resolved = ids.length ? resolveShifts(ids, start, end) : new Map();

    const explicitKeys = new Set();
    if (ids.length) {
      const rows = db.get()
        .prepare(`SELECT employee_id, work_date FROM schedules WHERE work_date BETWEEN ? AND ? AND employee_id IN (${placeholders(ids)})`)
        .all(start, end, ...ids);
      for (const r of rows) explicitKeys.add(`${r.employee_id}|${r.work_date}`);
    }

    const dates = dateRange(start, end);
    const holidaySet = new Set(
      db.get().prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?').all(start, end).map((r) => r.date)
    );

    return {
      dates,
      holidays: [...holidaySet],
      employees: emps.map((e) => ({
        ...e,
        days: dates.map((date) => {
          const shift = resolved.get(`${e.id}|${date}`);
          return {
            date,
            shift_id: shift ? shift.id : null,
            code: shift ? shift.code : null,
            name: shift ? shift.name : null,
            color: shift ? shift.color : null,
            is_off: shift ? shift.is_off : 0,
            explicit: explicitKeys.has(`${e.id}|${date}`),
          };
        }),
      })),
    };
  },

  /** Set / hapus jadwal satu hari. shiftId null = kembali ke jadwal bawaan. */
  setDay(employeeId, date, shiftId) {
    if (shiftId === null || shiftId === undefined || shiftId === '') {
      db.get().prepare('DELETE FROM schedules WHERE employee_id = ? AND work_date = ?').run(employeeId, date);
    } else {
      db.get().prepare(`
        INSERT INTO schedules (employee_id, work_date, shift_id) VALUES (?, ?, ?)
        ON CONFLICT(employee_id, work_date) DO UPDATE SET shift_id = excluded.shift_id
      `).run(employeeId, date, shiftId);
    }
    return true;
  },

  /**
   * Buat jadwal massal dari pola shift berulang.
   * @param {number[]} employeeIds
   * @param {string} from 'YYYY-MM-DD'
   * @param {string} to
   * @param {Array<number|null>} pattern siklus shift; null = libur
   * @param {boolean} skipHolidays lewati tanggal libur nasional
   * @param {boolean} overwrite timpa jadwal yang sudah ada
   * @param {number} offset geser titik awal pola, dalam hari
   * @param {boolean} stagger beri tiap karyawan geseran berbeda secara berurutan
   *
   * `offset` dan `stagger` inilah yang membuat shift bergilir (satpam, operator
   * pabrik) bisa dibuat: satu pola yang sama dipakai semua regu, tetapi tiap
   * regu memulainya dari titik berbeda sehingga tidak pernah kosong.
   */
  generate({
    employeeIds,
    from,
    to,
    pattern,
    skipHolidays = true,
    overwrite = true,
    offset = 0,
    stagger = false,
  }) {
    if (!employeeIds || !employeeIds.length) throw new Error('Pilih minimal satu karyawan');
    if (!pattern || !pattern.length) throw new Error('Pola shift belum diisi');

    const dates = dateRange(from, to);
    const holidaySet = new Set(
      db.get().prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map((r) => r.date)
    );
    const offShift = db.get().prepare('SELECT id FROM shifts WHERE is_off = 1 ORDER BY id LIMIT 1').get();
    // Entri "libur" pada pola dipetakan ke shift libur agar tampil eksplisit
    // di tabel jadwal, bukan sekadar sel kosong "tidak dijadwalkan".
    const offId = offShift ? offShift.id : null;

    const insert = db.get().prepare(`
      INSERT INTO schedules (employee_id, work_date, shift_id) VALUES (?, ?, ?)
      ON CONFLICT(employee_id, work_date) DO UPDATE SET shift_id = excluded.shift_id
    `);
    const insertKeep = db.get().prepare(
      'INSERT OR IGNORE INTO schedules (employee_id, work_date, shift_id) VALUES (?, ?, ?)'
    );
    const stmt = overwrite ? insert : insertKeep;

    const baseOffset = Number(offset) || 0;
    let count = 0;
    const tx = db.get().transaction(() => {
      employeeIds.forEach((empId, empIndex) => {
        // Tiap regu digeser satu langkah pola dari regu sebelumnya.
        const shift = baseOffset + (stagger ? empIndex : 0);
        dates.forEach((date, i) => {
          // Modulo dijaga tetap positif agar offset negatif tetap sah.
          const step = (((i + shift) % pattern.length) + pattern.length) % pattern.length;
          let shiftId = pattern[step] || offId;
          if (skipHolidays && holidaySet.has(date)) {
            shiftId = offId;
          }
          stmt.run(empId, date, shiftId || null);
          count += 1;
        });
      });
    });
    tx();
    return { assigned: count, days: dates.length, employees: employeeIds.length };
  },

  /** Hapus jadwal eksplisit pada rentang (kembali ke jadwal bawaan). */
  clearRange({ employeeIds, from, to }) {
    if (!employeeIds || !employeeIds.length) return { removed: 0 };
    const info = db.get()
      .prepare(`DELETE FROM schedules WHERE work_date BETWEEN ? AND ? AND employee_id IN (${placeholders(employeeIds)})`)
      .run(from, to, ...employeeIds);
    return { removed: info.changes };
  },
};

module.exports = { schedules, defaultSchedule, resolveShifts };
