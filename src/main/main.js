'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');

const db = require('./db');
const ipc = require('./ipc');
const exporter = require('./services/exporter');
const backup = require('./services/backup');
const { DeviceManager } = require('./zk/manager');
const { COPYRIGHT } = require('./util/branding');

const isDev = process.argv.includes('--dev');

let mainWindow = null;
let manager = null;
let autoBackupTimer = null;

// Satu instansi saja: dua proses menulis ke SQLite yang sama akan bentrok.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f172a',
    title: 'Absensi Karyawan',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Jendela cetak tersembunyi sengaja dibiarkan hidup: membongkarnya bisa
    // mematikan proses di tengah pembersihan (lihat catatan di exporter.js).
    // Karena jendela itu menahan 'window-all-closed', keluarnya diminta di sini.
    app.quit();
  });

  // Tautan luar dibuka di peramban, bukan di dalam aplikasi.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function buildMenu() {
  const template = [
    {
      label: 'Berkas',
      submenu: [
        {
          label: 'Backup Sekarang',
          click: () => mainWindow && mainWindow.webContents.send('event:menu', 'backup'),
        },
        {
          label: 'Backup ke Lokasi Lain...',
          click: () => mainWindow && mainWindow.webContents.send('event:menu', 'backup-as'),
        },
        {
          label: 'Kelola Backup & Pemulihan',
          click: () => mainWindow && mainWindow.webContents.send('event:menu', 'backup-manage'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Keluar' },
      ],
    },
    {
      label: 'Tampilan',
      submenu: [
        { role: 'reload', label: 'Muat Ulang' },
        { role: 'resetZoom', label: 'Ukuran Normal' },
        { role: 'zoomIn', label: 'Perbesar' },
        { role: 'zoomOut', label: 'Perkecil' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Layar Penuh' },
        ...(isDev ? [{ role: 'toggleDevTools', label: 'Alat Pengembang' }] : []),
      ],
    },
    {
      label: 'Bantuan',
      submenu: [
        {
          label: 'Lokasi Data',
          click: () => shell.showItemInFolder(db.getPath()),
        },
        {
          label: 'Tentang Aplikasi',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Tentang',
              message: `Absensi Karyawan v${app.getVersion()}`,
              detail:
                'Manajemen absensi, shift, dan rekap karyawan.\n' +
                'Mendukung mesin fingerprint Solution X105 / X401 (protokol ZKTeco) melalui jaringan LAN.\n\n' +
                `${COPYRIGHT}\n\n` +
                `Database: ${db.getPath()}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    db.init(app.getPath('userData'));
    // Catatan "pulihkan backup" yang dititipkan sebelum aplikasi dibuka ulang.
    require('./services/audit').audit.flushPending();
  } catch (err) {
    dialog.showErrorBox(
      'Gagal membuka database',
      `Aplikasi tidak dapat membuka berkas database.\n\n${err.message}`
    );
    app.exit(1);
    return;
  }

  manager = new DeviceManager();
  ipc.register(manager, () => mainWindow);

  buildMenu();
  createWindow();

  // Auto-sync dan live capture dijalankan setelah jendela siap.
  manager.startAutoSync();
  manager.syncLiveConnections().catch(() => {});

  // Backup otomatis harian: sekali saat dibuka, lalu diperiksa berkala supaya
  // komputer yang tidak pernah dimatikan tetap kebagian backup harian.
  const jalankanBackup = () => {
    backup.runAuto().catch((err) => console.error('[backup otomatis]', err.message));
  };
  setTimeout(jalankanBackup, 5000);
  autoBackupTimer = setInterval(jalankanBackup, 6 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (!manager) return;
  const m = manager;
  manager = null;
  event.preventDefault();
  try {
    await m.shutdown();
  } catch {
    /* abaikan, tetap tutup */
  }
  if (autoBackupTimer) clearInterval(autoBackupTimer);

  // Database ditutup lebih dulu supaya datanya pasti rapi, baru proses
  // dihentikan langsung. app.exit() dipilih daripada app.quit() agar Chromium
  // tidak sempat membongkar jendela cetak — jalur yang bisa mematikan proses
  // secara tidak terkendali.
  db.close();
  app.exit(0);
});

process.on('uncaughtException', (err) => {
  // Kegagalan jaringan ke mesin tidak boleh mematikan aplikasi.
  console.error('[uncaughtException]', err);
});
