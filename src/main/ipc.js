'use strict';

const path = require('node:path');
const { ipcMain, dialog, shell, app } = require('electron');

const db = require('./db');
const { settings, departments, employees, shifts, leaveTypes, leaves, holidays, relinkLogs } = require('./services/masters');
const { schedules, defaultSchedule } = require('./services/schedules');
const { devices } = require('./services/devices');
const { attendance } = require('./services/attendance');
const { reports } = require('./services/reports');
const exporter = require('./services/exporter');
const backup = require('./services/backup');
const { fingerprints } = require('./services/fingerprints');
const { att2000 } = require('./services/att2000');
const { auth, authorize } = require('./services/auth');
const { audit } = require('./services/audit');
const { diagnose } = require('./zk/diagnose');
const { todayStr, currentMonthStr, toDateTimeStr } = require('./util/datetime');
const { AUTHOR, COPYRIGHT } = require('./util/branding');

/**
 * Pengguna yang sedang masuk. Satu instansi aplikasi = satu sesi, jadi cukup
 * disimpan di sini; halaman tidak pernah memegang token apa pun.
 */
const session = { user: null };

/**
 * Semua fungsi yang boleh dipanggil dari halaman aplikasi.
 * Renderer memanggilnya lewat satu pintu: window.api.call('nama', payload).
 */
function buildHandlers(manager, getWindow) {
  const saveDialog = async (defaultName, filters) => {
    const result = await dialog.showSaveDialog(getWindow(), {
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters,
    });
    return result.canceled ? null : result.filePath;
  };

  const afterExport = async (filePath, extra = {}) => ({ ok: true, filePath, ...extra });

  return {
    // ------------------------------------------------------------- aplikasi
    'app.info': () => ({
      version: app.getVersion(),
      name: app.getName(),
      author: AUTHOR,
      copyright: COPYRIGHT,
      dbPath: db.getPath(),
      // Nama perusahaan untuk layar login; pengaturan lain baru bisa dibaca setelah masuk.
      companyName: settings.get('company_name', ''),
      today: todayStr(),
      month: currentMonthStr(),
      platform: process.platform,
      electron: process.versions.electron,
    }),

    // ------------------------------------------------------ masuk & keluar
    'auth.status': () => ({
      needsSetup: auth.needsSetup(),
      user: session.user,
      minPassword: auth.MIN_PASSWORD,
    }),
    'auth.setup': (p) => {
      const hasil = auth.setup(p);
      session.user = hasil.user;
      audit.log(hasil.user, 'Buat Admin pertama', hasil.user.username);
      return hasil;
    },
    'auth.login': (p) => {
      try {
        session.user = auth.login(p);
      } catch (err) {
        audit.log(null, 'Gagal masuk', `nama pengguna: ${String((p && p.username) || '').slice(0, 40)}`);
        throw err;
      }
      audit.log(session.user, 'Masuk');
      return session.user;
    },
    'auth.logout': ({ reason = null } = {}) => {
      if (session.user) audit.log(session.user, reason === 'idle' ? 'Terkunci otomatis' : 'Keluar');
      session.user = null;
      return true;
    },
    'auth.recover': (p) => {
      const hasil = auth.recover(p);
      session.user = hasil.user;
      audit.log(hasil.user, 'Atur ulang password dengan kode pemulihan');
      return hasil;
    },
    'auth.changePassword': (p) => {
      session.user = auth.changePassword(session.user.id, p);
      audit.log(session.user, 'Ganti password sendiri');
      return session.user;
    },

    // ------------------------------------------- pengguna (khusus Admin)
    'users.list': () => ({ users: auth.list(), recovery: auth.recoveryCodeInfo() }),
    'users.create': (p) => {
      const user = auth.create(p);
      audit.log(session.user, 'Tambah pengguna', `${user.username} (${user.role_label})`);
      return user;
    },
    'users.update': ({ id, ...rest }) => {
      const user = auth.update(session.user.id, id, rest);
      audit.log(
        session.user,
        'Ubah pengguna',
        `${user.username}: ${user.role_label}, ${user.active ? 'aktif' : 'nonaktif'}`
      );
      return user;
    },
    'users.resetPassword': ({ id, password }) => {
      const user = auth.resetPassword(id, password);
      audit.log(session.user, 'Reset password pengguna', user.username);
      return user;
    },
    'users.regenerateRecovery': ({ password }) => {
      const code = auth.regenerateRecoveryCode(session.user.id, password);
      audit.log(session.user, 'Buat ulang kode pemulihan');
      return { recoveryCode: code };
    },
    'audit.list': (p = {}) => audit.list(p),

    // ---------------------------------------------------------- pengaturan
    'settings.all': () => settings.all(),
    'settings.save': async (payload) => {
      settings.setMany(payload || {});
      await manager.applySettings();
      return true;
    },

    // ---------------------------------------------------------- departemen
    'departments.list': () => departments.list(),
    'departments.create': ({ name }) => departments.create(name),
    'departments.update': ({ id, name }) => departments.update(id, name),
    'departments.remove': ({ id }) => departments.remove(id),

    // ------------------------------------------------------------ karyawan
    'employees.list': (p = {}) => employees.list(p),
    'employees.find': ({ id }) => employees.find(id),
    'employees.create': (p) => employees.create(p),
    'employees.update': ({ id, ...rest }) => employees.update(id, rest),
    'employees.remove': ({ id }) => employees.remove(id),
    'employees.setActive': ({ id, active }) => employees.setActive(id, active),

    // ------------------------------------------- operasi banyak sekaligus
    'employees.impact': ({ ids }) => employees.impactOf(ids),
    'employees.removeMany': ({ ids }) => employees.removeMany(ids),
    'employees.setActiveMany': ({ ids, active }) => employees.setActiveMany(ids, active),
    'employees.importFromDevice': ({ rows, departmentId, defaultShiftId }) =>
      employees.importFromDevice(rows, { departmentId, defaultShiftId }),
    'employees.nextPin': () => employees.nextPin(),
    'employees.pinConflicts': ({ pin, id = null }) => employees.pinConflicts(pin, id),
    'employees.relinkLogs': () => {
      relinkLogs();
      return true;
    },

    // --------------------------------------------------------------- shift
    'shifts.list': (p = {}) => shifts.list(p),
    'shifts.create': (p) => shifts.create(p),
    'shifts.update': ({ id, ...rest }) => shifts.update(id, rest),
    'shifts.remove': ({ id }) => shifts.remove(id),

    // -------------------------------------------------------------- jadwal
    'schedules.matrix': (p) => schedules.matrix(p),
    'schedules.setDay': ({ employeeId, date, shiftId }) => schedules.setDay(employeeId, date, shiftId),
    'schedules.generate': (p) => schedules.generate(p),
    'schedules.clearRange': (p) => schedules.clearRange(p),
    'defaultSchedule.list': () => defaultSchedule.list(),
    'defaultSchedule.set': ({ dow, shiftId }) => defaultSchedule.set(dow, shiftId),

    // --------------------------------------------------------- izin & cuti
    'leaveTypes.list': () => leaveTypes.list(),
    'leaveTypes.create': (p) => leaveTypes.create(p),
    'leaveTypes.update': ({ id, ...rest }) => leaveTypes.update(id, rest),
    'leaveTypes.remove': ({ id }) => leaveTypes.remove(id),
    'leaves.list': (p = {}) => leaves.list(p),
    'leaves.create': (p) => leaves.create(p),
    'leaves.update': ({ id, ...rest }) => leaves.update(id, rest),
    'leaves.remove': ({ id }) => leaves.remove(id),

    // -------------------------------------------------------- hari libur
    'holidays.list': (p = {}) => holidays.list(p),
    'holidays.create': ({ date, name }) => holidays.create(date, name),
    'holidays.remove': ({ id }) => holidays.remove(id),

    // ------------------------------------------------------ mesin absensi
    'devices.list': () => devices.list(),
    'devices.find': ({ id }) => devices.find(id),
    'devices.create': (p) => devices.create(p),
    'devices.update': ({ id, ...rest }) => devices.update(id, rest),
    'devices.remove': async ({ id }) => {
      await manager.stopLive(id);
      return devices.remove(id);
    },
    'devices.users': ({ deviceId = null } = {}) => devices.deviceUsers(deviceId),
    'devices.syncHistory': ({ limit } = {}) => devices.syncHistory(limit),
    'devices.reconcile': ({ deviceId }) => devices.reconcile(deviceId),
    'devices.adoptFromDevice': ({ deviceId, pins }) => devices.adoptFromDevice(deviceId, pins),

    // --------------------------------- kirim data karyawan ke mesin
    'device.pushEmployees': ({ id, employeeIds, overwrite = false, skipPins = [] }) =>
      manager.pushEmployees(id, employeeIds, { overwrite, skipPins }),
    /** pins = null berarti hapus SELURUH user di mesin. */
    'device.removeUsers': ({ id, pins = null }) => manager.removeDeviceUsers(id, pins),
    // Sidik jari ikut otomatis: dibaca saat "Baca Ulang dari Mesin",
    // dipasang saat "Kirim ke Mesin". Tidak ada perintah terpisah lagi.
    'fingerprints.stats': () => fingerprints.stats(),
    'fingerprints.remove': ({ pins = null }) => fingerprints.remove(pins),

    'device.test': ({ id }) => manager.testConnection(id),

    /** Pemeriksaan mendalam saat koneksi gagal: pindai port dan beri saran. */
    'device.diagnose': async ({ id }) => {
      const d = devices.find(id);
      if (!d) throw new Error('Mesin absensi tidak ditemukan');
      // Live dihentikan supaya pemindaian tidak berebut socket dengan
      // koneksi realtime, lalu dinyalakan lagi apa pun hasilnya (tanpa
      // ditunggu: mesin yang bermasalah bisa butuh sampai timeout).
      await manager.stopLive(id).catch(() => {});
      try {
        return await diagnose({ ip: d.ip, port: d.port, commKey: d.comm_key, protocol: d.protocol });
      } finally {
        manager.resumeLive(id).catch(() => {});
      }
    },
    'device.syncUsers': ({ id }) => manager.syncUsers(id),
    'device.pull': ({ id, from = null, to = null }) => manager.pull(id, { from, to }),
    'device.pullAll': ({ from = null, to = null } = {}) => manager.pullAll({ from, to }),
    'device.setTime': ({ id }) => manager.setDeviceTime(id, new Date()),
    'device.clearAttendance': ({ id }) => manager.clearDeviceAttendance(id),
    'device.restart': ({ id }) => manager.restartDevice(id),
    'device.startLive': ({ id }) => manager.startLive(id),
    'device.stopLive': ({ id }) => manager.stopLive(id),
    'device.liveStatus': () => manager.liveStatus(),
    'device.applySettings': () => manager.applySettings(),

    // ------------------------------------------------------- log absensi
    'attendance.list': (p = {}) => attendance.list(p),
    'attendance.recent': ({ limit } = {}) => attendance.recent(limit),
    'attendance.addManual': (p) => attendance.addManual(p),
    'attendance.remove': ({ id }) => attendance.remove(id),
    'attendance.removeRange': (p) => attendance.removeRange(p),
    'attendance.unknownPins': () => attendance.unknownPins(),
    'attendance.stats': () => attendance.stats(),

    // -------------------------------------------------------------- rekap
    'reports.dashboard': ({ date } = {}) => reports.dashboard(date || todayStr()),
    'reports.daily': (p) => reports.daily(p),
    'reports.monthly': (p) => reports.monthly(p),
    'reports.range': (p) => reports.range(p),
    'reports.employeeCard': (p) => reports.employeeCard(p),

    // ------------------------------------------------------------- ekspor
    // Rekap ringkasan dan kartu absensi menerima `month` atau `from`/`to`.
    'export.monthlyExcel': async (p) => {
      const file = await saveDialog(`Rekap-Absensi-${periodName(p)}.xlsx`, [{ name: 'Excel', extensions: ['xlsx'] }]);
      if (!file) return { ok: false, canceled: true };
      const res = await exporter.monthlyExcel(file, p);
      return afterExport(file, res);
    },
    'export.dailyExcel': async (p) => {
      const file = await saveDialog(`Absensi-Harian-${p.date}.xlsx`, [{ name: 'Excel', extensions: ['xlsx'] }]);
      if (!file) return { ok: false, canceled: true };
      const res = await exporter.dailyExcel(file, p);
      return afterExport(file, res);
    },
    'export.logsExcel': async (p = {}) => {
      const file = await saveDialog(`Log-Absensi-${todayStr()}.xlsx`, [{ name: 'Excel', extensions: ['xlsx'] }]);
      if (!file) return { ok: false, canceled: true };
      const res = await exporter.logsExcel(file, p);
      return afterExport(file, res);
    },
    'export.monthlyPdf': async (p) => {
      const file = await saveDialog(`Rekap-Absensi-${periodName(p)}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
      if (!file) return { ok: false, canceled: true };
      const res = await exporter.htmlToPdf(exporter.monthlyPdfHtml(p), file, { landscape: true });
      return afterExport(file, res);
    },
    'export.dailyPdf': async (p) => {
      const file = await saveDialog(`Absensi-Harian-${p.date}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
      if (!file) return { ok: false, canceled: true };
      const res = await exporter.htmlToPdf(exporter.dailyPdfHtml(p), file, { landscape: true });
      return afterExport(file, res);
    },
    'export.employeeCardPdf': async (p) => {
      const file = await saveDialog(`Kartu-Absensi-${periodName(p)}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
      if (!file) return { ok: false, canceled: true };
      const res = await exporter.htmlToPdf(exporter.employeeCardPdfHtml(p), file, { landscape: false });
      return afterExport(file, res);
    },

    // ------------------------------------------------------------ berkas
    'file.open': ({ filePath }) => shell.openPath(filePath),
    'file.showInFolder': ({ filePath }) => {
      shell.showItemInFolder(filePath);
      return true;
    },

    // ------------------------------------- impor dari Att2000 / ZKTime (.mdb)
    /** Pilih berkas att2000.mdb lalu tampilkan ringkasan isinya. */
    'att2000.choose': async () => {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: 'Pilih Database Att2000 / ZKTime',
        properties: ['openFile'],
        filters: [{ name: 'Database Access', extensions: ['mdb'] }],
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
      const filePath = result.filePaths[0];
      return { ok: true, filePath, preview: await att2000.inspectFile(filePath) };
    },
    /** Impor setelah pengguna menyetujui ringkasan. Backup dibuat lebih dulu. */
    'att2000.import': async ({ filePath }) => {
      const cadangan = await backup.create({});
      const kirim = (payload) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('event:progress', payload);
      };
      const judul = 'Impor dari Att2000';
      try {
        const hasil = await att2000.importFile(filePath, {
          onProgress: (fase, current = null, total = null) => kirim({ judul, fase, current, total, label: '', done: false }),
        });
        kirim({ judul, fase: 'Selesai', done: true });
        return { ok: true, ...hasil, backup: cadangan.fileName };
      } catch (err) {
        kirim({ judul, fase: 'Gagal', done: true });
        throw err;
      }
    },

    // ------------------------------------------------- backup & pemulihan
    'backup.list': () => backup.list(),
    'backup.folder': () => backup.folder(),
    'backup.openFolder': () => shell.openPath(backup.folder()),
    'backup.inspect': ({ filePath }) => backup.inspect(filePath),
    'backup.remove': ({ filePath }) => backup.remove(filePath),
    'backup.prune': ({ keep } = {}) => backup.prune(keep),

    /** Backup cepat ke folder backup, tanpa dialog. */
    'backup.now': () => backup.create({}),

    /** Backup ke lokasi pilihan pengguna (mis. flashdisk). */
    'backup.saveAs': async () => {
      const stampName = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const file = await saveDialog(`absensi-${stampName}.db`, [{ name: 'Database SQLite', extensions: ['db'] }]);
      if (!file) return { ok: false, canceled: true };
      return backup.create({ targetPath: file });
    },

    /** Pilih berkas backup dari luar folder backup, lalu periksa isinya. */
    'backup.choose': async () => {
      const result = await dialog.showOpenDialog(getWindow(), {
        properties: ['openFile'],
        filters: [{ name: 'Database SQLite', extensions: ['db'] }],
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
      return backup.inspect(result.filePaths[0]);
    },

    'backup.chooseFolder': async () => {
      const result = await dialog.showOpenDialog(getWindow(), {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Pilih Folder Penyimpanan Backup',
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
      settings.set('backup_folder', result.filePaths[0]);
      return { ok: true, folder: result.filePaths[0] };
    },

    /**
     * Pemulihan. Berkas diperiksa dan salinan pengaman dibuat di dalam
     * backup.restore(); di sini hanya urusan menutup koneksi dan menjalankan
     * ulang aplikasi setelahnya.
     */
    'backup.restore': async ({ filePath }) => {
      const periksa = backup.inspect(filePath);
      if (!periksa.ok) return { ok: false, error: periksa.error };

      // Tercatat di database lama (ikut ke salinan pengaman) DAN dititipkan
      // untuk database hasil pemulihan, yang belum punya catatan ini.
      const detail = `${path.basename(filePath)} (${periksa.employees} karyawan, ${periksa.logs} log)`;
      audit.log(session.user, 'Pulihkan backup', detail);

      await manager.shutdown();
      exporter.closePdfWindow();

      const hasil = await backup.restore(filePath);
      if (!hasil.ok) return hasil;
      audit.savePending([
        {
          at: toDateTimeStr(new Date()),
          user_id: session.user && session.user.id,
          username: session.user && session.user.username,
          action: 'Pulihkan backup',
          detail,
        },
      ]);

      setTimeout(() => {
        app.relaunch({ args: process.argv.slice(1) });
        app.exit(0);
      }, 400);
      return hasil;
    },
  };
}

/**
 * Tindakan penting yang otomatis tercatat di catatan aktivitas. Keterangannya
 * disusun SEBELUM perintah dijalankan, supaya nama data yang dihapus masih
 * bisa dibaca.
 */
const AUDITED = {
  'attendance.addManual': ['Tambah scan manual', (p) => `${employeeLabel(p.employeeId)} — ${p.ts}${p.note ? ` (${p.note})` : ''}`],
  'attendance.remove': ['Hapus log scan', (p) => logLabel(p.id)],
  'attendance.removeRange': ['Hapus log scan per rentang', (p) => `${p.from} s/d ${p.to}`],
  'employees.remove': ['Hapus karyawan', (p) => employeeLabel(p.id)],
  'employees.removeMany': ['Hapus karyawan massal', (p) => listLabel((p.ids || []).map(employeeLabel))],
  'leaves.remove': ['Hapus izin/cuti', (p) => `#${p.id}`],
  'devices.remove': ['Hapus mesin absensi', (p) => deviceLabel(p.id)],
  'device.removeUsers': ['Hapus user di mesin', (p) =>
    `${deviceLabel(p.id)}: ${p.pins ? `${p.pins.length} user (PIN ${listLabel(p.pins)})` : 'SEMUA user'}`],
  'device.clearAttendance': ['Kosongkan log di mesin', (p) => deviceLabel(p.id)],
  'fingerprints.remove': ['Hapus sidik jari tersimpan', (p) => (p.pins ? `PIN ${listLabel(p.pins)}` : 'semua')],
  'settings.save': ['Ubah pengaturan', (p) => Object.keys(p || {}).join(', ')],
  'att2000.import': ['Impor dari Att2000', (p) => require('node:path').basename(String(p.filePath || ''))],
};

function employeeLabel(id) {
  const e = employees.find(id);
  return e ? `${e.pin} — ${e.name}` : `#${id}`;
}

function deviceLabel(id) {
  const d = devices.find(id);
  return d ? `${d.name} (${d.ip})` : `#${id}`;
}

function logLabel(id) {
  const l = db.get().prepare('SELECT user_pin, ts FROM attendance_logs WHERE id = ?').get(id);
  return l ? `PIN ${l.user_pin} — ${l.ts}` : `#${id}`;
}

function listLabel(items) {
  return items.length > 10 ? `${items.slice(0, 10).join(', ')}, … (+${items.length - 10})` : items.join(', ');
}

function register(manager, getWindow) {
  const handlers = buildHandlers(manager, getWindow);

  ipcMain.handle('api:call', async (_event, name, payload) => {
    const handler = handlers[name];
    if (!handler) return { ok: false, error: `Perintah tidak dikenal: ${name}` };

    // Selalu dibaca ulang: akun yang baru dinonaktifkan langsung kehilangan akses.
    if (session.user) session.user = auth.current(session.user.id);
    const ditolak = authorize(name, session.user);
    if (ditolak) return { ok: false, error: ditolak.message, code: ditolak.code };

    const catat = AUDITED[name];
    let detail = null;
    if (catat) {
      try {
        detail = catat[1](payload || {});
      } catch {
        detail = null;
      }
    }

    try {
      const data = await handler(payload || {});
      if (catat && !(data && data.canceled)) {
        const gagal = data && data.ok === false ? ` (gagal: ${data.error || 'tidak diketahui'})` : '';
        audit.log(session.user, catat[0], `${detail || ''}${gagal}`);
      }
      return { ok: true, data };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      return { ok: false, error: translateError(message) };
    }
  });

  // Teruskan kejadian dari mesin absensi ke halaman aplikasi.
  const forward = (event) => (payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(`event:${event}`, payload);
  };
  for (const evt of ['live-scan', 'live-status', 'sync-start', 'sync-done', 'sync-error', 'device-status', 'users-synced', 'autosync-status', 'progress']) {
    manager.on(evt, forward(evt));
  }
}

/** Potongan nama berkas ekspor: '2026-09' atau '2026-08-21_sd_2026-09-20'. */
function periodName(p) {
  return p.from && p.to ? `${p.from}_sd_${p.to}` : p.month;
}

/** Terjemahkan galat SQLite yang sering muncul menjadi bahasa manusia. */
function translateError(message) {
  if (message.includes('UNIQUE constraint failed: employees.pin')) {
    return 'PIN tersebut sudah dipakai karyawan lain.';
  }
  if (message.includes('UNIQUE constraint failed: shifts.code')) {
    return 'Kode shift tersebut sudah ada.';
  }
  if (message.includes('UNIQUE constraint failed: departments.name')) {
    return 'Nama departemen tersebut sudah ada.';
  }
  if (message.includes('UNIQUE constraint failed: devices.ip')) {
    return 'Mesin dengan IP dan port tersebut sudah terdaftar.';
  }
  if (message.includes('UNIQUE constraint failed: leave_types.code')) {
    return 'Kode jenis izin tersebut sudah ada.';
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return 'Data ini masih dipakai oleh data lain, hapus keterkaitannya lebih dulu.';
  }
  if (message.includes('NOT NULL constraint failed')) {
    return 'Ada kolom wajib yang belum diisi.';
  }
  return message;
}

module.exports = { register };
