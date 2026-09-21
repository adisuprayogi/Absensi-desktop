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
const { diagnose } = require('./zk/diagnose');
const { todayStr, currentMonthStr } = require('./util/datetime');
const { AUTHOR, COPYRIGHT } = require('./util/branding');

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
      today: todayStr(),
      month: currentMonthStr(),
      platform: process.platform,
      electron: process.versions.electron,
    }),

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
    'device.pushEmployees': ({ id, employeeIds }) => manager.pushEmployees(id, employeeIds),
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
      await manager.stopLive(id).catch(() => {});
      return diagnose({ ip: d.ip, port: d.port, commKey: d.comm_key, protocol: d.protocol });
    },
    'device.syncUsers': ({ id }) => manager.syncUsers(id),
    'device.pull': ({ id }) => manager.pull(id),
    'device.pullAll': () => manager.pullAll(),
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
    'export.monthlyExcel': async (p) => {
      const file = await saveDialog(`Rekap-Absensi-${p.month}.xlsx`, [{ name: 'Excel', extensions: ['xlsx'] }]);
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
      const file = await saveDialog(`Rekap-Absensi-${p.month}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
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
      const file = await saveDialog(`Kartu-Absensi-${p.month}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
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

      await manager.shutdown();
      exporter.closePdfWindow();

      const hasil = await backup.restore(filePath);
      if (!hasil.ok) return hasil;

      setTimeout(() => {
        app.relaunch({ args: process.argv.slice(1) });
        app.exit(0);
      }, 400);
      return hasil;
    },
  };
}

function register(manager, getWindow) {
  const handlers = buildHandlers(manager, getWindow);

  ipcMain.handle('api:call', async (_event, name, payload) => {
    const handler = handlers[name];
    if (!handler) return { ok: false, error: `Perintah tidak dikenal: ${name}` };
    try {
      const data = await handler(payload || {});
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
