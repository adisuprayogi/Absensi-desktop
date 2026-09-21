'use strict';

const db = require('../db');
const { bindAll, placeholders } = require('../util/sql');

// ------------------------------------------------------------- pengaturan

const settings = {
  all() {
    const rows = db.get().prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  get(key, fallback = null) {
    const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },
  set(key, value) {
    db.get()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value === null || value === undefined ? '' : String(value));
    return true;
  },
  setMany(obj) {
    const stmt = db
      .get()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const tx = db.get().transaction((entries) => {
      for (const [k, v] of entries) stmt.run(k, v === null || v === undefined ? '' : String(v));
    });
    tx(Object.entries(obj));
    return true;
  },
};

// -------------------------------------------------------------- departemen

const departments = {
  list() {
    return db
      .get()
      .prepare(`
        SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS employee_count
        FROM departments d ORDER BY d.name
      `)
      .all();
  },
  create(name) {
    const info = db.get().prepare('INSERT INTO departments (name) VALUES (?)').run(String(name).trim());
    return info.lastInsertRowid;
  },
  update(id, name) {
    db.get().prepare('UPDATE departments SET name = ? WHERE id = ?').run(String(name).trim(), id);
    return true;
  },
  remove(id) {
    db.get().prepare('DELETE FROM departments WHERE id = ?').run(id);
    return true;
  },
};

// --------------------------------------------------------------- karyawan

const EMPLOYEE_SELECT = `
  SELECT e.*, d.name AS department_name, s.name AS default_shift_name, s.code AS default_shift_code,
         (SELECT COUNT(*) FROM fingerprints f WHERE f.user_pin = e.pin AND f.valid = 1) AS finger_count
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN shifts s ON s.id = e.default_shift_id
`;

const employees = {
  list({ search = '', departmentId = null, activeOnly = false } = {}) {
    const where = [];
    const params = {};
    if (search) {
      where.push("(e.name LIKE @q OR e.pin LIKE @q OR IFNULL(e.nip, '') LIKE @q)");
      params.q = `%${search}%`;
    }
    if (departmentId) {
      where.push('e.department_id = @dept');
      params.dept = departmentId;
    }
    if (activeOnly) where.push('e.active = 1');
    const sql = `${EMPLOYEE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.name`;
    return bindAll(db.get().prepare(sql), [], params);
  },

  find(id) {
    return db.get().prepare(`${EMPLOYEE_SELECT} WHERE e.id = ?`).get(id);
  },

  findByPin(pin) {
    return db.get().prepare('SELECT * FROM employees WHERE pin = ?').get(String(pin));
  },

  create(data) {
    const stmt = db.get().prepare(`
      INSERT INTO employees (pin, nip, name, card, privilege, device_password, department_id, position,
                             phone, email, join_date, default_shift_id, active, note)
      VALUES (@pin, @nip, @name, @card, @privilege, @device_password, @department_id, @position,
              @phone, @email, @join_date, @default_shift_id, @active, @note)
    `);
    const info = stmt.run(normalizeEmployee(data));
    // Log lama dengan PIN yang sama langsung disambungkan, supaya absensi yang
    // sudah ditarik sebelum karyawan didaftarkan tetap masuk rekap.
    relinkLogs();
    return info.lastInsertRowid;
  },

  update(id, data) {
    const stmt = db.get().prepare(`
      UPDATE employees SET
        pin = @pin, nip = @nip, name = @name, card = @card, privilege = @privilege,
        device_password = @device_password, department_id = @department_id,
        position = @position, phone = @phone, email = @email, join_date = @join_date,
        default_shift_id = @default_shift_id, active = @active, note = @note,
        updated_at = datetime('now','localtime')
      WHERE id = @id
    `);
    stmt.run({ ...normalizeEmployee(data), id });
    // Log lama yang belum terpaut karyawan ini bisa langsung disambungkan.
    relinkLogs();
    return true;
  },

  remove(id) {
    db.get().prepare('DELETE FROM employees WHERE id = ?').run(id);
    return true;
  },

  /**
   * Hitung akibat penghapusan sejumlah karyawan, supaya admin tahu persis apa
   * yang hilang sebelum menekan Hapus.
   *
   * Log absensi TIDAK ikut terhapus (kolomnya ON DELETE SET NULL) — hanya
   * kehilangan kaitan, dan tersambung lagi sendiri bila PIN yang sama
   * didaftarkan ulang. Jadwal shift dan catatan izin ikut terhapus permanen.
   */
  impactOf(ids) {
    if (!ids || !ids.length) return { employees: 0, logs: 0, schedules: 0, leaves: 0, names: [] };
    const tanda = placeholders(ids);
    const satu = (sql) => db.get().prepare(sql).get(...ids).n;
    return {
      employees: ids.length,
      names: db.get()
        .prepare(`SELECT name FROM employees WHERE id IN (${tanda}) ORDER BY name`)
        .all(...ids)
        .map((r) => r.name),
      logs: satu(`SELECT COUNT(*) AS n FROM attendance_logs WHERE employee_id IN (${tanda})`),
      schedules: satu(`SELECT COUNT(*) AS n FROM schedules WHERE employee_id IN (${tanda})`),
      leaves: satu(`SELECT COUNT(*) AS n FROM leaves WHERE employee_id IN (${tanda})`),
    };
  },

  /** Hapus banyak karyawan sekaligus dalam satu transaksi. */
  removeMany(ids) {
    if (!ids || !ids.length) return { removed: 0 };
    const stmt = db.get().prepare('DELETE FROM employees WHERE id = ?');
    let removed = 0;
    const tx = db.get().transaction((daftar) => {
      for (const id of daftar) removed += stmt.run(id).changes;
    });
    tx(ids);
    return { removed };
  },

  /** Aktifkan atau nonaktifkan banyak karyawan sekaligus. */
  setActiveMany(ids, active) {
    if (!ids || !ids.length) return { changed: 0 };
    const stmt = db.get().prepare(
      "UPDATE employees SET active = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    );
    let changed = 0;
    const tx = db.get().transaction((daftar) => {
      for (const id of daftar) changed += stmt.run(active ? 1 : 0, id).changes;
    });
    tx(ids);
    return { changed };
  },

  setActive(id, active) {
    db.get()
      .prepare("UPDATE employees SET active = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(active ? 1 : 0, id);
    return true;
  },

  /**
   * Buat karyawan dari daftar user mesin yang belum terdaftar.
   * @param {Array<{user_pin:string,name:string}>} rows
   */
  importFromDevice(rows, { departmentId = null, defaultShiftId = null } = {}) {
    const exists = db.get().prepare('SELECT id FROM employees WHERE pin = ?');
    const insert = db.get().prepare(`
      INSERT INTO employees (pin, name, card, privilege, device_password, department_id, default_shift_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    let created = 0;
    let skipped = 0;
    const tx = db.get().transaction((list) => {
      for (const r of list) {
        const pin = String(r.user_pin || r.userId || '').trim();
        if (!pin) continue;
        if (exists.get(pin)) {
          skipped += 1;
          continue;
        }
        insert.run(
          pin,
          String(r.name || `Karyawan ${pin}`).trim(),
          Number(r.card) || 0,
          Number(r.privilege) || 0,
          r.password ? String(r.password).trim() : null,
          departmentId,
          defaultShiftId
        );
        created += 1;
      }
    });
    tx(rows);
    relinkLogs();
    return { created, skipped };
  },
};

function normalizeEmployee(d) {
  return {
    pin: String(d.pin || '').trim(),
    nip: d.nip ? String(d.nip).trim() : null,
    name: String(d.name || '').trim(),
    card: Number(d.card) || 0,
    privilege: Number(d.privilege) || 0,
    device_password: d.device_password ? String(d.device_password).trim() : null,
    department_id: d.department_id || null,
    position: d.position || null,
    phone: d.phone || null,
    email: d.email || null,
    join_date: d.join_date || null,
    default_shift_id: d.default_shift_id || null,
    active: d.active === 0 || d.active === false ? 0 : 1,
    note: d.note || null,
  };
}

/** Sambungkan log absensi ke karyawan berdasarkan PIN. */
function relinkLogs() {
  db.get().exec(`
    UPDATE attendance_logs
    SET employee_id = (SELECT e.id FROM employees e WHERE e.pin = attendance_logs.user_pin)
    WHERE employee_id IS NULL
       OR employee_id <> IFNULL((SELECT e.id FROM employees e WHERE e.pin = attendance_logs.user_pin), -1)
  `);
}

// ------------------------------------------------------------------ shift

const shifts = {
  list({ activeOnly = false } = {}) {
    const sql = `SELECT * FROM shifts ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY is_off, start_time, name`;
    return db.get().prepare(sql).all();
  },
  find(id) {
    return db.get().prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  },
  create(data) {
    const info = db.get().prepare(`
      INSERT INTO shifts (code, name, start_time, end_time, break_minutes, late_tolerance,
                          early_tolerance, overtime_after, min_work_minutes, is_off, color, active)
      VALUES (@code, @name, @start_time, @end_time, @break_minutes, @late_tolerance,
              @early_tolerance, @overtime_after, @min_work_minutes, @is_off, @color, @active)
    `).run(normalizeShift(data));
    return info.lastInsertRowid;
  },
  update(id, data) {
    db.get().prepare(`
      UPDATE shifts SET code=@code, name=@name, start_time=@start_time, end_time=@end_time,
        break_minutes=@break_minutes, late_tolerance=@late_tolerance, early_tolerance=@early_tolerance,
        overtime_after=@overtime_after, min_work_minutes=@min_work_minutes, is_off=@is_off,
        color=@color, active=@active
      WHERE id=@id
    `).run({ ...normalizeShift(data), id });
    return true;
  },
  remove(id) {
    db.get().prepare('DELETE FROM shifts WHERE id = ?').run(id);
    return true;
  },
};

function normalizeShift(d) {
  const num = (v, def = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    code: String(d.code || '').trim().toUpperCase(),
    name: String(d.name || '').trim(),
    start_time: d.start_time || '08:00',
    end_time: d.end_time || '17:00',
    break_minutes: num(d.break_minutes, 0),
    late_tolerance: num(d.late_tolerance, 0),
    early_tolerance: num(d.early_tolerance, 0),
    overtime_after: num(d.overtime_after, 0),
    min_work_minutes: num(d.min_work_minutes, 0),
    is_off: d.is_off ? 1 : 0,
    color: d.color || '#4f7cff',
    active: d.active === 0 || d.active === false ? 0 : 1,
  };
}

// -------------------------------------------------------- izin, cuti, dll

const leaveTypes = {
  list() {
    return db.get().prepare('SELECT * FROM leave_types ORDER BY name').all();
  },
  create(d) {
    const info = db.get().prepare(`
      INSERT INTO leave_types (code, name, counts_as_present, is_paid, color)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(d.code || '').trim().toUpperCase(),
      String(d.name || '').trim(),
      d.counts_as_present ? 1 : 0,
      d.is_paid ? 1 : 0,
      d.color || '#8b5cf6'
    );
    return info.lastInsertRowid;
  },
  update(id, d) {
    db.get().prepare(`
      UPDATE leave_types SET code=?, name=?, counts_as_present=?, is_paid=?, color=? WHERE id=?
    `).run(
      String(d.code || '').trim().toUpperCase(),
      String(d.name || '').trim(),
      d.counts_as_present ? 1 : 0,
      d.is_paid ? 1 : 0,
      d.color || '#8b5cf6',
      id
    );
    return true;
  },
  remove(id) {
    db.get().prepare('DELETE FROM leave_types WHERE id = ?').run(id);
    return true;
  },
};

const leaves = {
  list({ from = null, to = null, employeeId = null, search = '' } = {}) {
    const where = [];
    const params = {};
    if (from) {
      where.push('l.end_date >= @from');
      params.from = from;
    }
    if (to) {
      where.push('l.start_date <= @to');
      params.to = to;
    }
    if (employeeId) {
      where.push('l.employee_id = @emp');
      params.emp = employeeId;
    }
    if (search) {
      where.push('(e.name LIKE @q OR e.pin LIKE @q)');
      params.q = `%${search}%`;
    }
    const sql = `
      SELECT l.*, e.name AS employee_name, e.pin AS employee_pin,
             t.name AS leave_type_name, t.code AS leave_type_code, t.color AS leave_type_color,
             t.counts_as_present,
             (julianday(l.end_date) - julianday(l.start_date) + 1) AS days
      FROM leaves l
      JOIN employees e ON e.id = l.employee_id
      JOIN leave_types t ON t.id = l.leave_type_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.start_date DESC, e.name
    `;
    return bindAll(db.get().prepare(sql), [], params);
  },

  create(d) {
    const info = db.get().prepare(`
      INSERT INTO leaves (employee_id, leave_type_id, start_date, end_date, note, status)
      VALUES (@employee_id, @leave_type_id, @start_date, @end_date, @note, @status)
    `).run(normalizeLeave(d));
    return info.lastInsertRowid;
  },

  update(id, d) {
    db.get().prepare(`
      UPDATE leaves SET employee_id=@employee_id, leave_type_id=@leave_type_id,
        start_date=@start_date, end_date=@end_date, note=@note, status=@status
      WHERE id=@id
    `).run({ ...normalizeLeave(d), id });
    return true;
  },

  remove(id) {
    db.get().prepare('DELETE FROM leaves WHERE id = ?').run(id);
    return true;
  },
};

function normalizeLeave(d) {
  let start = d.start_date;
  let end = d.end_date || d.start_date;
  if (end < start) [start, end] = [end, start];
  return {
    employee_id: d.employee_id,
    leave_type_id: d.leave_type_id,
    start_date: start,
    end_date: end,
    note: d.note || null,
    status: d.status || 'disetujui',
  };
}

const holidays = {
  list({ year = null } = {}) {
    if (year) {
      return db.get()
        .prepare("SELECT * FROM holidays WHERE date LIKE ? ORDER BY date")
        .all(`${year}-%`);
    }
    return db.get().prepare('SELECT * FROM holidays ORDER BY date').all();
  },
  create(date, name) {
    const info = db.get()
      .prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name')
      .run(date, String(name).trim());
    return info.lastInsertRowid;
  },
  remove(id) {
    db.get().prepare('DELETE FROM holidays WHERE id = ?').run(id);
    return true;
  },
};

module.exports = {
  settings,
  departments,
  employees,
  shifts,
  leaveTypes,
  leaves,
  holidays,
  relinkLogs,
};
