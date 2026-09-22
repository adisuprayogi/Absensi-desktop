'use strict';

const fs = require('node:fs');

const db = require('../db');
const { relinkLogs } = require('./masters');
const { insertLogs } = require('./attendance');
const { toDateStr, toDateTimeStr, dateRange, addDays } = require('../util/datetime');

/**
 * Impor data dari database software bawaan ZKTeco: Att2000 / ZKTime /
 * "Attendance Management" (berkas att2000.mdb, Microsoft Access).
 *
 * Dibaca dengan mdb-reader (JavaScript murni): tidak perlu Microsoft Access
 * atau driver ODBC di komputer pengguna.
 *
 * Yang diimpor: departemen, karyawan, log scan, shift, jenis izin, izin/cuti,
 * dan hari libur. Data yang sudah ada tidak ditimpa — PIN yang sudah terdaftar
 * dilewati, scan yang sudah tersimpan tidak digandakan. Jadwal shift bergilir
 * Att2000 dan sidik jari tidak diimpor (lihat catatan di preview).
 */

const WAJIB = ['USERINFO', 'CHECKINOUT', 'DEPARTMENTS'];

/** Kode yang dipakai status rekap; tidak boleh jadi kode jenis izin. */
const KODE_STATUS_REKAP = new Set(['H', 'T', 'TL', 'A', 'L', 'LN', '-']);

/** Hak akses Att2000 (0 pengguna, 1 pendaftar, 2 manajer, 3 admin) → kode mesin. */
const PRIVILEGE = { 0: 0, 1: 2, 2: 12, 3: 14 };

/** Id sistem Att2000 untuk "dinas luar" (公出) di tabel LeaveClass1. */
const ATT_DINAS_LUAR = 999;

// ------------------------------------------------------------ pembacaan

/**
 * Sumber data: berkas .mdb sungguhan, atau objek tiruan di pengujian dengan
 * bentuk yang sama ({ has, rows, count }).
 */
async function openFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('Berkas tidak ditemukan.');
  let reader;
  try {
    const { default: MDBReader } = await import('mdb-reader');
    reader = new MDBReader(fs.readFileSync(filePath));
  } catch (err) {
    throw new Error(`Berkas tidak bisa dibaca sebagai database Access (.mdb): ${err.message}`);
  }
  const names = new Set(reader.getTableNames());
  return {
    has: (n) => names.has(n),
    rows: (n) => (names.has(n) ? reader.getTable(n).getData() : []),
    count: (n) => (names.has(n) ? reader.getTable(n).rowCount : 0),
  };
}

const teks = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Jam di Access tidak punya zona waktu; mdb-reader mengembalikannya sebagai
 * Date UTC. Komponen UTC-nya adalah jam dinding yang tercatat di mesin —
 * dipakai apa adanya, supaya scan 08:05 tetap 08:05 (bukan bergeser 7 jam).
 */
function jamDinding(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

const tanggal = (d) => {
  const j = jamDinding(d);
  return j ? toDateStr(j) : null;
};

const jamMenit = (d) => {
  const j = jamDinding(d);
  return j ? `${String(j.getHours()).padStart(2, '0')}:${String(j.getMinutes()).padStart(2, '0')}` : null;
};

/** Warna Access (angka BGR) → '#rrggbb'. */
function warna(v, cadangan) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return cadangan;
  const r = n & 255;
  const g = (n >> 8) & 255;
  const b = (n >> 16) & 255;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function pinDari(user) {
  return teks(user.Badgenumber);
}

/** Departemen puncak (SUPDEPTID 0) adalah perusahaan itu sendiri, bukan departemen. */
const deptPuncak = (d) => !Number(d.SUPDEPTID);

function periksaStruktur(src) {
  const hilang = WAJIB.filter((t) => !src.has(t));
  if (hilang.length) {
    throw new Error(`Berkas ini bukan database Att2000/ZKTime (tabel ${hilang.join(', ')} tidak ada).`);
  }
}

// ------------------------------------------------------------- pratinjau

/** Ringkasan isi berkas sebelum diimpor. */
function inspect(src) {
  periksaStruktur(src);
  const d = db.get();
  const pinAda = new Set(d.prepare('SELECT pin FROM employees').all().map((r) => String(r.pin)));

  const users = src.rows('USERINFO');
  const pinUser = new Map(users.map((u) => [Number(u.USERID), pinDari(u)]));
  const denganPin = users.filter((u) => pinDari(u));
  const baru = denganPin.filter((u) => !pinAda.has(pinDari(u))).length;

  let dari = null;
  let sampai = null;
  let tanpaKaryawan = 0;
  const logs = src.rows('CHECKINOUT');
  for (const l of logs) {
    const j = jamDinding(l.CHECKTIME);
    if (!j) continue;
    if (!pinUser.get(Number(l.USERID))) tanpaKaryawan += 1;
    const ts = toDateTimeStr(j);
    if (!dari || ts < dari) dari = ts;
    if (!sampai || ts > sampai) sampai = ts;
  }

  return {
    departments: src.rows('DEPARTMENTS').filter((x) => !deptPuncak(x) && teks(x.DEPTNAME)).length,
    employees: { total: denganPin.length, baru, sudahAda: denganPin.length - baru, tanpaPin: users.length - denganPin.length },
    logs: { total: logs.length, dari, sampai, tanpaKaryawan },
    shifts: src.count('SchClass'),
    leaveTypes: src.count('LeaveClass'),
    leaves: src.count('USER_SPEDAY'),
    holidays: src.count('HOLIDAYS'),
    fingerprints: src.count('TEMPLATE'),
    schedules: src.count('USER_OF_RUN') + src.count('USER_TEMP_SCH'),
    machines: src.count('Machines'),
  };
}

// ------------------------------------------------------------------ impor

/**
 * Impor seluruhnya. `onProgress(fase, current, total)` dipanggil berkala;
 * log scan dikerjakan per potongan supaya aplikasi tetap responsif.
 */
async function importAll(src, { onProgress = () => {} } = {}) {
  periksaStruktur(src);
  const d = db.get();
  const hasil = {
    departments: 0, employees: 0, employeesSkipped: 0, shifts: 0, leaveTypes: 0,
    leaves: 0, holidays: 0, logs: 0, logsDuplicate: 0, logsUnknown: 0,
  };

  // ---- departemen: dipasangkan lewat nama bila sudah ada
  onProgress('Departemen');
  const deptId = new Map(); // DEPTID Att2000 -> id aplikasi
  const deptByName = new Map(d.prepare('SELECT id, name FROM departments').all().map((r) => [r.name.toLowerCase(), r.id]));
  const insDept = d.prepare('INSERT INTO departments (name) VALUES (?)');
  d.transaction(() => {
    for (const x of src.rows('DEPARTMENTS')) {
      const nama = teks(x.DEPTNAME);
      if (deptPuncak(x) || !nama) continue;
      let id = deptByName.get(nama.toLowerCase());
      if (!id) {
        id = insDept.run(nama).lastInsertRowid;
        deptByName.set(nama.toLowerCase(), id);
        hasil.departments += 1;
      }
      deptId.set(Number(x.DEPTID), id);
    }
  })();

  // ---- karyawan: PIN = Badgenumber; PIN yang sudah ada tidak ditimpa
  onProgress('Karyawan');
  const users = src.rows('USERINFO');
  const pinUser = new Map(); // USERID Att2000 -> PIN
  const insEmp = d.prepare(`
    INSERT INTO employees (pin, nip, name, card, privilege, device_password, department_id, position, phone, email, join_date, active)
    VALUES (@pin, @nip, @name, @card, @privilege, @device_password, @department_id, @position, @phone, NULL, @join_date, @active)
    ON CONFLICT(pin) DO NOTHING
  `);
  d.transaction(() => {
    for (const u of users) {
      const pin = pinDari(u);
      if (!pin) continue;
      pinUser.set(Number(u.USERID), pin);
      const kartu = Number(teks(u.CardNo)) || 0;
      const sandi = teks(u.PASSWORD);
      const info = insEmp.run({
        pin,
        nip: teks(u.SSN) || null,
        name: teks(u.Name) || `Karyawan ${pin}`,
        card: kartu > 0 && kartu <= 0xffffffff && Number.isInteger(kartu) ? kartu : 0,
        privilege: PRIVILEGE[Number(u.privilege)] || 0,
        device_password: /^\d{1,8}$/.test(sandi) ? sandi : null,
        department_id: deptId.get(Number(u.DEFAULTDEPTID)) || null,
        position: teks(u.TITLE) || null,
        phone: teks(u.OPHONE) || teks(u.FPHONE) || teks(u.PAGER) || null,
        join_date: tanggal(u.HIREDDAY),
        // ATT = 0 di Att2000 berarti karyawan tidak dihitung absensinya.
        active: Number(u.ATT) === 0 ? 0 : 1,
      });
      if (info.changes) hasil.employees += 1;
      else hasil.employeesSkipped += 1;
    }
  })();

  // ---- shift (SchClass): dipasangkan lewat nama bila sudah ada
  onProgress('Shift');
  const kodeShift = new Set(d.prepare('SELECT code FROM shifts').all().map((r) => r.code));
  const namaShift = new Set(d.prepare('SELECT name FROM shifts').all().map((r) => r.name.toLowerCase()));
  const insShift = d.prepare(`
    INSERT INTO shifts (code, name, start_time, end_time, break_minutes, late_tolerance, early_tolerance, overtime_after, is_off, color, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 30, 0, ?, 1)
  `);
  d.transaction(() => {
    for (const s of src.rows('SchClass')) {
      const nama = teks(s.schName);
      const mulai = jamMenit(s.StartTime);
      const selesai = jamMenit(s.EndTime);
      if (!nama || !mulai || !selesai || namaShift.has(nama.toLowerCase())) continue;
      const akar = (nama.match(/[A-Za-z0-9]+/g) || ['SH']).map((w) => w[0]).join('').toUpperCase().slice(0, 5) || 'SH';
      let kode = akar;
      for (let i = 2; kodeShift.has(kode); i++) kode = `${akar}${i}`;
      const [h1, m1] = mulai.split(':').map(Number);
      const [h2, m2] = selesai.split(':').map(Number);
      let durasi = h2 * 60 + m2 - (h1 * 60 + m1);
      if (durasi <= 0) durasi += 1440;
      const kerja = Number(s.WorkMins) || 0;
      insShift.run(
        kode, nama, mulai, selesai,
        kerja > 0 && kerja < durasi ? Math.round(durasi - kerja) : 0,
        Math.max(0, Number(s.LateMinutes) || 0),
        Math.max(0, Number(s.EarlyMinutes) || 0),
        warna(s.Color, '#4f7cff')
      );
      kodeShift.add(kode);
      namaShift.add(nama.toLowerCase());
      hasil.shifts += 1;
    }
  })();

  // ---- jenis izin (LeaveClass) + "dinas luar" sistem Att2000
  onProgress('Jenis izin');
  const jenisId = new Map(); // LeaveId Att2000 -> id aplikasi
  const jenisAda = d.prepare('SELECT id, code, name FROM leave_types').all();
  const kodeIzin = new Set(jenisAda.map((t) => t.code));
  const namaIzin = new Map(jenisAda.map((t) => [t.name.toLowerCase(), t.id]));
  const dl = jenisAda.find((t) => t.code === 'DL');
  if (dl) jenisId.set(ATT_DINAS_LUAR, dl.id);
  const insJenis = d.prepare('INSERT INTO leave_types (code, name, counts_as_present, is_paid, color) VALUES (?, ?, 0, 1, ?)');
  d.transaction(() => {
    for (const t of src.rows('LeaveClass')) {
      const nama = teks(t.LeaveName);
      if (!nama) continue;
      let id = namaIzin.get(nama.toLowerCase());
      if (!id) {
        const simbol = teks(t.ReportSymbol).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        let kode = simbol && !KODE_STATUS_REKAP.has(simbol) ? simbol : `I${t.LeaveId}`;
        for (let i = 2; kodeIzin.has(kode); i++) kode = `${simbol || 'I'}${i}`;
        id = insJenis.run(kode, nama, warna(t.Color, '#8b5cf6')).lastInsertRowid;
        kodeIzin.add(kode);
        namaIzin.set(nama.toLowerCase(), id);
        hasil.leaveTypes += 1;
      }
      jenisId.set(Number(t.LeaveId), id);
    }
  })();

  // ---- izin/cuti karyawan (USER_SPEDAY), status disetujui
  onProgress('Izin & cuti');
  const empId = new Map(d.prepare('SELECT id, pin FROM employees').all().map((r) => [String(r.pin), r.id]));
  const adaIzin = d.prepare('SELECT 1 FROM leaves WHERE employee_id = ? AND leave_type_id = ? AND start_date = ? AND end_date = ?');
  const insIzin = d.prepare(`INSERT INTO leaves (employee_id, leave_type_id, start_date, end_date, note, status) VALUES (?, ?, ?, ?, ?, 'disetujui')`);
  d.transaction(() => {
    for (const s of src.rows('USER_SPEDAY')) {
      const emp = empId.get(pinUser.get(Number(s.USERID)) || '');
      const jenis = jenisId.get(Number(s.DATEID));
      let mulai = tanggal(s.STARTSPECDAY);
      let akhir = tanggal(s.ENDSPECDAY) || mulai;
      if (!emp || !jenis || !mulai) continue;
      if (akhir < mulai) [mulai, akhir] = [akhir, mulai];
      if (adaIzin.get(emp, jenis, mulai, akhir)) continue;
      insIzin.run(emp, jenis, mulai, akhir, teks(s.YUANYING) || null);
      hasil.leaves += 1;
    }
  })();

  // ---- hari libur (HOLIDAYS): STARTTIME + DURATION hari
  onProgress('Hari libur');
  const insLibur = d.prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO NOTHING');
  d.transaction(() => {
    for (const h of src.rows('HOLIDAYS')) {
      const mulai = tanggal(h.STARTTIME);
      const nama = teks(h.HOLIDAYNAME);
      if (!mulai || !nama) continue;
      const lama = Math.max(1, Math.min(60, Number(h.DURATION) || 1));
      const akhir = addDays(mulai, lama - 1);
      for (const tgl of dateRange(mulai, akhir)) hasil.holidays += insLibur.run(tgl, nama).changes;
    }
  })();

  // ---- log scan (CHECKINOUT), per potongan
  const logs = src.rows('CHECKINOUT');
  const sudah = new Set(d.prepare('SELECT user_pin, ts FROM attendance_logs').all().map((r) => `${r.user_pin}|${r.ts}`));
  const POTONGAN = 5000;
  for (let i = 0; i < logs.length; i += POTONGAN) {
    onProgress('Log scan', i, logs.length);
    const catatan = [];
    for (const l of logs.slice(i, i + POTONGAN)) {
      const pin = pinUser.get(Number(l.USERID));
      const j = jamDinding(l.CHECKTIME);
      if (!pin || !j) {
        hasil.logsUnknown += 1;
        continue;
      }
      const kunci = `${pin}|${toDateTimeStr(j)}`;
      if (sudah.has(kunci)) {
        hasil.logsDuplicate += 1;
        continue;
      }
      sudah.add(kunci);
      const tipe = teks(l.CHECKTYPE).toUpperCase();
      catatan.push({
        userId: pin,
        timestamp: j,
        status: Number.isFinite(Number(l.VERIFYCODE)) ? Number(l.VERIFYCODE) : 0,
        punch: tipe === 'O' ? 1 : /^\d$/.test(tipe) ? Number(tipe) : 0,
      });
    }
    const r = insertLogs(null, catatan, 'impor');
    hasil.logs += r.inserted;
    hasil.logsDuplicate += r.duplicate;
    // Beri kesempatan antarmuka menggambar kemajuan.
    await new Promise((res) => setImmediate(res));
  }
  onProgress('Log scan', logs.length, logs.length);

  relinkLogs();
  return hasil;
}

module.exports = {
  att2000: {
    openFile,
    inspect,
    importAll,
    async inspectFile(filePath) {
      return inspect(await openFile(filePath));
    },
    async importFile(filePath, opts) {
      return importAll(await openFile(filePath), opts);
    },
  },
  _internal: { jamDinding, warna },
};
