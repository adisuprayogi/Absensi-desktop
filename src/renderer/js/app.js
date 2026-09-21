/* Titik masuk aplikasi: minta masuk, lalu pasang navigasi, indikator realtime, dan halaman awal. */
'use strict';

(async function bootstrap() {
  const { $, $$, callSafe, toast, go, refresh, formDialog } = window.App;
  const Auth = window.Auth;

  // ---- navigasi sidebar
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.page));
  });

  // ---- identitas aplikasi (boleh dibaca sebelum masuk)
  const info = await callSafe('app.info', {}, {});
  if (info && info.version) {
    $('#appVersion').textContent = `Versi ${info.version}`;
  }
  if (info && info.copyright) {
    $('#appCopyright').textContent = info.copyright;
    $('#appCopyright').title = info.copyright;
  }

  // ---- pengguna yang sedang masuk
  async function afterLogin(user) {
    window.App.setUser(user);
    $('#userName').textContent = user.full_name;
    $('#userRole').textContent = `${user.username} · ${user.role_label}`;

    const settings = await callSafe('settings.all', {}, {});
    if (settings && settings.company_name) {
      $('#brandCompany').textContent = settings.company_name;
      $('#brandCompany').title = settings.company_name;
    }
    Auth.setIdleMinutes(settings ? settings.auto_lock_minutes : 15);
    await refreshLiveStatus();
    await go('dashboard');
  }
  Auth.setOnUnlock(afterLogin);

  $('#btnLogout').addEventListener('click', () => Auth.lock());
  $('#btnChangePassword').addEventListener('click', async () => {
    const v = await formDialog({
      title: 'Ganti Password',
      okLabel: 'Simpan',
      fields: [
        { name: 'oldPassword', label: 'Password Lama', type: 'password', required: true },
        { name: 'newPassword', label: 'Password Baru (minimal 8 karakter)', type: 'password', required: true },
        { name: 'confirm', label: 'Ulangi Password Baru', type: 'password', required: true },
      ],
      validate: (x) => (x.newPassword !== x.confirm ? 'Konfirmasi password tidak sama' : null),
    });
    if (!v) return;
    const user = await callSafe('auth.changePassword', { oldPassword: v.oldPassword, newPassword: v.newPassword });
    if (user) toast('Password berhasil diganti', 'ok');
  });

  // ---- indikator koneksi realtime
  const liveWrap = $('#liveIndicator');
  const liveText = $('#liveText');
  const liveDevices = new Map();

  function paintLive() {
    const active = [...liveDevices.values()].filter(Boolean).length;
    liveWrap.classList.toggle('on', active > 0);
    liveText.textContent = active > 0 ? `Realtime aktif (${active} mesin)` : 'Realtime nonaktif';
  }

  async function refreshLiveStatus() {
    const status = await callSafe('device.liveStatus', {}, {});
    liveDevices.clear();
    Object.entries(status || {}).forEach(([id, on]) => liveDevices.set(String(id), on));
    paintLive();
  }

  // ---- kejadian dari mesin absensi
  // Selama terkunci, tidak ada data yang boleh tampil (termasuk lewat notifikasi).
  window.api.on('live-status', (p) => {
    liveDevices.set(String(p.deviceId), !!p.active);
    paintLive();
    if (!Auth.locked && window.App.page === 'devices') refresh();
  });

  window.api.on('live-scan', (p) => {
    if (Auth.locked) return;
    // Dashboard menampilkan feed-nya sendiri; halaman lain cukup diberi notifikasi.
    if (window.App.page === 'dashboard' && window.Dashboard && window.Dashboard.onLiveScan) {
      window.Dashboard.onLiveScan(p);
    } else if (window.App.page === 'logs') {
      refresh();
    }
    if (p.unknown) {
      toast(`Scan dari PIN ${p.userPin} — karyawan belum terdaftar`, 'warn');
    }
  });

  window.api.on('sync-done', (p) => {
    if (Auth.locked) return;
    if (p.inserted > 0) toast(`${p.name}: ${p.inserted} data absensi baru`, 'ok');
    if (['dashboard', 'logs', 'reports', 'devices'].includes(window.App.page)) refresh();
  });

  window.api.on('sync-error', (p) => {
    if (Auth.locked) return;
    toast(`${p.name}: ${p.error}`, 'err');
  });

  // ---- kemajuan pekerjaan ke mesin absensi
  window.api.on('progress', (p) => {
    if (!Auth.locked) window.App.showProgress(p);
  });

  // ---- menu Berkas
  window.api.on('menu', async (action) => {
    if (Auth.locked) return;
    if (action === 'backup') {
      const res = await callSafe('backup.now');
      if (res && res.ok) toast(`Backup dibuat: ${res.fileName} (${res.sizeText})`, 'ok', 5000);
      if (window.App.page === 'settings') refresh();
    } else if (action === 'backup-as') {
      const res = await callSafe('backup.saveAs');
      if (res && res.ok) toast(`Backup tersimpan: ${res.filePath}`, 'ok', 7000);
    } else if (action === 'backup-manage') {
      go('settings');
    }
  });

  await afterLogin(await Auth.ensure());
})();
