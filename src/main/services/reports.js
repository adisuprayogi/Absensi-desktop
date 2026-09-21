'use strict';

const db = require('../db');
const { resolveShifts } = require('./schedules');
const { bindAll, placeholders } = require('../util/sql');
const {
  toDateStr,
  parseDateTime,
  timeToMinutes,
  minutesToTime,
  dateRange,
  addDays,
  monthBounds,
  todayStr,
} = require('../util/datetime');

const STATUS = {
  HADIR: { code: 'H', label: 'Hadir', color: '#10b981' },
  TERLAMBAT: { code: 'T', label: 'Terlambat', color: '#f59e0b' },
  TIDAK_LENGKAP: { code: 'TL', label: 'Tidak Lengkap', color: '#f97316' },
  ALPHA: { code: 'A', label: 'Alpha', color: '#ef4444' },
  LIBUR: { code: 'L', label: 'Libur', color: '#94a3b8' },
  LIBUR_NASIONAL: { code: 'LN', label: 'Libur Nasional', color: '#64748b' },
  BELUM: { code: '-', label: 'Belum', color: '#cbd5e1' },
};

function settingNumber(key, fallback) {
  const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Rentang menit shift relatif tengah malam tanggal jadwal.
 * Shift lintas hari (mis. 22:00-06:00) menghasilkan end > 1440.
 */
function shiftBounds(shift) {
  const start = timeToMinutes(shift.start_time);
  let end = timeToMinutes(shift.end_time);
  if (end <= start) end += 1440;
  return { start, end, crossDay: end > 1440 };
}

/**
 * Hitung rekap kehadiran untuk rentang tanggal.
 *
 * Aturan penempatan log ke tanggal jadwal: sebuah scan milik tanggalnya
 * sendiri, KECUALI hari sebelumnya berjadwal shift lintas hari yang jendela
 * kerjanya masih mencakup scan itu (kasus shift malam pulang dini hari).
 */
function computeRange({
  from,
  to,
  employeeIds = null,
  departmentId = null,
  search = '',
  includeInactive = false,
  now = new Date(),
}) {
  const database = db.get();
  const beforeWindow = settingNumber('window_before_hours', 6) * 60;
  const afterWindow = settingNumber('window_after_hours', 6) * 60;

  // ---- karyawan
  const where = [];
  const params = {};
  if (!includeInactive) where.push('e.active = 1');
  if (employeeIds && employeeIds.length) {
    where.push(`e.id IN (${placeholders(employeeIds)})`);
  }
  if (departmentId) {
    where.push('e.department_id = @dept');
    params.dept = departmentId;
  }
  if (search) {
    where.push("(e.name LIKE @q OR e.pin LIKE @q OR IFNULL(e.nip, '') LIKE @q)");
    params.q = `%${search}%`;
  }
  const empSql = `
    SELECT e.id, e.pin, e.nip, e.name, e.position, d.name AS department_name
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.name
  `;
  const employees = bindAll(database.prepare(empSql), employeeIds && employeeIds.length ? employeeIds : [], params);

  if (!employees.length) return { dates: dateRange(from, to), rows: [], employees: [] };

  const ids = employees.map((e) => e.id);
  const idSet = new Set(ids);

  // ---- jadwal, libur, cuti
  const scheduleFrom = addDays(from, -1);
  const shiftMap = resolveShifts(ids, scheduleFrom, to);

  const holidays = new Map(
    database.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?')
      .all(from, to).map((r) => [r.date, r.name])
  );

  const leaveRows = database.prepare(`
    SELECT l.employee_id, l.start_date, l.end_date, l.note,
           t.code, t.name, t.color, t.counts_as_present
    FROM leaves l JOIN leave_types t ON t.id = l.leave_type_id
    WHERE l.status = 'disetujui' AND l.end_date >= ? AND l.start_date <= ?
      AND l.employee_id IN (${placeholders(ids)})
  `).all(from, to, ...ids);

  const leaveMap = new Map(); // `${empId}|${date}` -> leave
  for (const lv of leaveRows) {
    for (const d of dateRange(
      lv.start_date < from ? from : lv.start_date,
      lv.end_date > to ? to : lv.end_date
    )) {
      leaveMap.set(`${lv.employee_id}|${d}`, lv);
    }
  }

  // ---- log mentah (diperlebar sehari di kedua sisi untuk shift lintas hari)
  const logs = database.prepare(`
    SELECT employee_id, ts, punch, status, device_id
    FROM attendance_logs
    WHERE log_date BETWEEN ? AND ? AND employee_id IN (${placeholders(ids)})
    ORDER BY ts
  `).all(addDays(from, -1), addDays(to, 1), ...ids);

  // ---- tempatkan tiap log ke tanggal jadwalnya
  const byKey = new Map(); // `${empId}|${date}` -> [{minutes, ts}]
  for (const log of logs) {
    if (!idSet.has(log.employee_id)) continue;
    const at = parseDateTime(log.ts);
    if (!at) continue;
    const ownDate = toDateStr(at);
    const minutesOfDay = at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;

    let targetDate = ownDate;
    const prevDate = addDays(ownDate, -1);
    const prevShift = shiftMap.get(`${log.employee_id}|${prevDate}`);
    if (prevShift && !prevShift.is_off) {
      const b = shiftBounds(prevShift);
      if (b.crossDay) {
        const offsetFromPrev = minutesOfDay + 1440;
        if (offsetFromPrev >= b.start - beforeWindow && offsetFromPrev <= b.end + afterWindow) {
          targetDate = prevDate;

          // Jendela shift kemarin bisa bertumpuk dengan shift hari ini (mis.
          // Malam lalu Pagi): scan 07:55 adalah masuk Pagi, bukan pulang Malam.
          // Bila keduanya mungkin, pilih yang batasnya paling dekat.
          const ownShift = shiftMap.get(`${log.employee_id}|${ownDate}`);
          if (ownShift && !ownShift.is_off) {
            const c = shiftBounds(ownShift);
            if (minutesOfDay >= c.start - beforeWindow && minutesOfDay <= c.end + afterWindow) {
              const jarakKePulangKemarin = Math.abs(offsetFromPrev - b.end);
              const jarakKeMasukHariIni = Math.abs(minutesOfDay - c.start);
              if (jarakKeMasukHariIni < jarakKePulangKemarin) targetDate = ownDate;
            }
          }
        }
      }
    }

    const offset = targetDate === ownDate ? minutesOfDay : minutesOfDay + 1440;
    const key = `${log.employee_id}|${targetDate}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ offset, ts: log.ts });
  }

  // ---- susun baris rekap
  const today = toDateStr(now);
  const dates = dateRange(from, to);
  const rows = [];

  for (const emp of employees) {
    for (const date of dates) {
      const shift = shiftMap.get(`${emp.id}|${date}`) || null;
      const leave = leaveMap.get(`${emp.id}|${date}`) || null;
      const holidayName = holidays.get(date) || null;
      const punches = (byKey.get(`${emp.id}|${date}`) || []).sort((a, b) => a.offset - b.offset);

      const row = {
        employee_id: emp.id,
        pin: emp.pin,
        nip: emp.nip,
        employee_name: emp.name,
        department_name: emp.department_name,
        position: emp.position,
        date,
        shift_id: shift ? shift.id : null,
        shift_code: shift ? shift.code : null,
        shift_name: shift ? shift.name : null,
        shift_time: shift && !shift.is_off ? `${shift.start_time} - ${shift.end_time}` : null,
        is_off: shift ? !!shift.is_off : true,
        holiday: holidayName,
        leave_code: leave ? leave.code : null,
        leave_name: leave ? leave.name : null,
        leave_color: leave ? leave.color : null,
        check_in: null,
        check_out: null,
        punch_count: punches.length,
        late_minutes: 0,
        early_minutes: 0,
        work_minutes: 0,
        overtime_minutes: 0,
        status: STATUS.BELUM.code,
        status_label: STATUS.BELUM.label,
        status_color: STATUS.BELUM.color,
      };

      const inPunch = punches.length ? punches[0] : null;
      const outPunch = punches.length > 1 ? punches[punches.length - 1] : null;
      // Shift yang jam pulangnya belum lewat (termasuk shift malam kemarin yang
      // berakhir pagi ini): belum pulang atau belum scan belum tentu masalah.
      let shiftBerjalan = false;

      if (shift && !shift.is_off) {
        const b = shiftBounds(shift);
        shiftBerjalan = now.getTime() < parseDateTime(date).getTime() + b.end * 60000;

        // Satu scan saja: tebak masuk atau pulang dari posisinya di rentang shift.
        let effectiveIn = inPunch;
        let effectiveOut = outPunch;
        if (inPunch && !outPunch) {
          const midpoint = (b.start + b.end) / 2;
          if (inPunch.offset > midpoint) {
            effectiveIn = null;
            effectiveOut = inPunch;
          }
        }

        if (effectiveIn) row.check_in = minutesToTime(effectiveIn.offset);
        if (effectiveOut) row.check_out = minutesToTime(effectiveOut.offset);

        if (effectiveIn) {
          row.late_minutes = Math.max(0, Math.round(effectiveIn.offset - (b.start + shift.late_tolerance)));
        }
        if (effectiveOut) {
          row.early_minutes = Math.max(0, Math.round(b.end - shift.early_tolerance - effectiveOut.offset));
          const over = effectiveOut.offset - b.end;
          if (over >= shift.overtime_after && shift.overtime_after >= 0 && over > 0) {
            row.overtime_minutes = Math.round(over);
          }
        }
        if (effectiveIn && effectiveOut) {
          row.work_minutes = Math.max(
            0,
            Math.round(effectiveOut.offset - effectiveIn.offset - (shift.break_minutes || 0))
          );
        }
      }

      // ---- tentukan status akhir
      if (punches.length && (!shift || shift.is_off)) {
        // Masuk di hari libur: catat sebagai hadir + seluruh durasi jadi lembur.
        row.check_in = minutesToTime(punches[0].offset);
        if (punches.length > 1) {
          row.check_out = minutesToTime(punches[punches.length - 1].offset);
          row.overtime_minutes = Math.round(punches[punches.length - 1].offset - punches[0].offset);
          row.work_minutes = row.overtime_minutes;
        }
        setStatus(row, STATUS.HADIR);
        row.status_label = holidayName ? 'Hadir (Libur Nasional)' : 'Hadir (Hari Libur)';
      } else if (leave && !punches.length) {
        applyLeave(row, leave);
      } else if (holidayName && !punches.length) {
        setStatus(row, STATUS.LIBUR_NASIONAL);
        row.status_label = holidayName;
      } else if (!shift || shift.is_off) {
        setStatus(row, STATUS.LIBUR);
      } else if (row.check_in && row.check_out) {
        setStatus(row, row.late_minutes > 0 ? STATUS.TERLAMBAT : STATUS.HADIR);
      } else if (row.check_in && !row.check_out && shiftBerjalan) {
        // Sudah masuk, jam pulang belum tiba: hadir, bukan "tidak lengkap".
        setStatus(row, row.late_minutes > 0 ? STATUS.TERLAMBAT : STATUS.HADIR);
        row.status_label += ' (belum pulang)';
        row.in_progress = true;
      } else if (row.check_in || row.check_out) {
        setStatus(row, STATUS.TIDAK_LENGKAP);
      } else if (date > today) {
        setStatus(row, STATUS.BELUM);
      } else if (shiftBerjalan) {
        // Shift belum selesai: belum scan bukan berarti alpha.
        setStatus(row, STATUS.BELUM);
      } else {
        setStatus(row, STATUS.ALPHA);
      }

      rows.push(row);
    }
  }

  return { dates, rows, employees };
}

/** Batas rentang rekap: cukup untuk setahun penuh, mencegah hitungan kebablasan. */
const MAX_RANGE_DAYS = 366;

function checkRange(from, to) {
  const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  if (!valid(from) || !valid(to)) throw new Error('Isi tanggal awal dan akhir periode rekap.');
  if (from > to) throw new Error('Tanggal awal tidak boleh setelah tanggal akhir.');
  if (dateRange(from, to).length > MAX_RANGE_DAYS) {
    throw new Error(`Rentang rekap maksimal ${MAX_RANGE_DAYS} hari.`);
  }
}

/**
 * Status dari izin/cuti yang disetujui. Ditandai `is_leave` supaya ringkasan
 * tidak bergantung pada kodenya — kode buatan pengguna bisa saja sama dengan
 * kode status rekap.
 */
function applyLeave(row, leave) {
  row.status = leave.code;
  row.status_label = leave.name;
  row.status_color = leave.color || '#8b5cf6';
  row.is_leave = true;
  row.leave_counts_present = !!leave.counts_as_present;
}

function setStatus(row, s) {
  row.status = s.code;
  row.status_label = s.label;
  row.status_color = s.color;
}

/** Ringkas baris harian menjadi total per karyawan. */
function summarize(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.employee_id)) {
      map.set(r.employee_id, {
        employee_id: r.employee_id,
        pin: r.pin,
        nip: r.nip,
        employee_name: r.employee_name,
        department_name: r.department_name,
        position: r.position,
        hadir: 0,
        terlambat: 0,
        tidak_lengkap: 0,
        alpha: 0,
        libur: 0,
        cuti: 0,
        sakit: 0,
        izin: 0,
        dinas_luar: 0,
        izin_lain: 0,
        late_minutes: 0,
        early_minutes: 0,
        work_minutes: 0,
        overtime_minutes: 0,
      });
    }
    const s = map.get(r.employee_id);
    s.late_minutes += r.late_minutes;
    s.early_minutes += r.early_minutes;
    s.work_minutes += r.work_minutes;
    s.overtime_minutes += r.overtime_minutes;

    if (r.is_leave) {
      // Jenis izin bertanda "dihitung hadir" (mis. Dinas Luar) ikut menambah hadir.
      if (r.leave_counts_present) s.hadir += 1;
      const kolom = { C: 'cuti', S: 'sakit', I: 'izin', DL: 'dinas_luar' }[r.leave_code] || 'izin_lain';
      s[kolom] += 1;
      continue;
    }

    switch (r.status) {
      case 'H':
        s.hadir += 1;
        break;
      case 'T':
        s.hadir += 1;
        s.terlambat += 1;
        break;
      case 'TL':
        s.tidak_lengkap += 1;
        break;
      case 'A':
        s.alpha += 1;
        break;
      case 'L':
      case 'LN':
        s.libur += 1;
        break;
      default:
        break;
    }
  }
  return [...map.values()];
}

const reports = {
  /** Rekap satu hari untuk semua karyawan. */
  daily({ date, departmentId = null, search = '' }) {
    const { rows } = computeRange({ from: date, to: date, departmentId, search });
    return rows;
  },

  /** Rekap bulanan: baris harian + total per karyawan. */
  monthly({ month, departmentId = null, search = '', employeeIds = null }) {
    const { start, end } = monthBounds(month);
    const { rows, dates } = computeRange({ from: start, to: end, departmentId, search, employeeIds });
    return { month, start, end, dates, rows, summary: summarize(rows) };
  },

  /** Rekap rentang tanggal bebas, mis. periode gaji 21 Agustus - 20 September. */
  range({ from, to, departmentId = null, search = '', employeeIds = null }) {
    checkRange(from, to);
    const { rows, dates } = computeRange({ from, to, departmentId, search, employeeIds });
    return { from, to, dates, rows, summary: summarize(rows) };
  },

  /** Rekap satu karyawan (kartu absensi). */
  employeeCard({ employeeId, from, to }) {
    const { rows } = computeRange({ from, to, employeeIds: [employeeId], includeInactive: true });
    return { rows, summary: summarize(rows)[0] || null };
  },

  /** Angka ringkas untuk dashboard hari ini. */
  dashboard(date = todayStr()) {
    const rows = computeRange({ from: date, to: date }).rows;
    const stat = {
      date,
      total_karyawan: rows.length,
      hadir: 0,
      terlambat: 0,
      belum_absen: 0,
      tidak_lengkap: 0,
      izin_cuti: 0,
      libur: 0,
      alpha: 0,
    };
    for (const r of rows) {
      if (r.is_leave) {
        if (r.leave_counts_present) stat.hadir += 1;
        else stat.izin_cuti += 1;
        continue;
      }
      if (r.status === 'H') stat.hadir += 1;
      else if (r.status === 'T') {
        stat.hadir += 1;
        stat.terlambat += 1;
      } else if (r.status === 'TL') stat.tidak_lengkap += 1;
      else if (r.status === 'A') stat.alpha += 1;
      else if (r.status === 'L' || r.status === 'LN') stat.libur += 1;
      else if (r.status === '-') stat.belum_absen += 1;
    }

    const scans = db.get().prepare(`
      SELECT COUNT(*) AS n FROM attendance_logs WHERE log_date = ?
    `).get(date).n;
    stat.scan_hari_ini = scans;
    stat.rows = rows;
    return stat;
  },
};

module.exports = { reports, computeRange, summarize, STATUS };
