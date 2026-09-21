/* Layar masuk, pembuatan Admin pertama, pemulihan password, dan kunci otomatis.
   Hak akses sesungguhnya diperiksa di proses utama; layar ini hanya pintunya. */
'use strict';

window.Auth = (function () {
  const A = window.App;
  const { esc, $ } = A;

  let minPassword = 8;
  let companyName = '';
  let locked = true;
  let onUnlock = null;

  // --------------------------------------------------------------- layar

  const screen = () => $('#authScreen');

  function show(html) {
    const el = screen();
    el.innerHTML = `<div class="auth-card">
      <div class="auth-brand">
        <div class="brand-mark">A</div>
        <div><strong>Absensi Karyawan</strong>${companyName ? `<span>${esc(companyName)}</span>` : ''}</div>
      </div>
      ${html}
    </div>`;
    el.hidden = false;
    const first = el.querySelector('input:not([type=checkbox])');
    if (first) setTimeout(() => first.focus(), 30);
    return el;
  }

  function hide() {
    screen().hidden = true;
    screen().innerHTML = '';
  }

  function setError(el, message) {
    const box = el.querySelector('.auth-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  /**
   * Pasang form: `submit` menerima nilai isian dan boleh melempar Error, yang
   * lalu ditampilkan di dalam kartu tanpa menutup form.
   */
  function bindForm(el, submit) {
    const form = el.querySelector('form');
    const btn = form.querySelector('button[type=submit]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setError(el, '');
      const values = Object.fromEntries(new FormData(form).entries());
      btn.disabled = true;
      try {
        await submit(values);
      } catch (err) {
        setError(el, err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  const field = (name, label, type = 'text', attrs = '') =>
    `<div class="field"><label for="a_${name}">${esc(label)}</label>
      <input id="a_${name}" name="${name}" type="${type}" autocomplete="off" required ${attrs} /></div>`;

  function checkNewPassword(v) {
    if ((v.newPassword || '').length < minPassword) throw new Error(`Password minimal ${minPassword} karakter.`);
    if (v.newPassword !== v.confirm) throw new Error('Konfirmasi password tidak sama.');
  }

  // -------------------------------------------------------------- alur

  /** Buat Admin pertama; hanya muncul saat belum ada pengguna sama sekali. */
  function setupFlow() {
    return new Promise((resolve) => {
      const el = show(`
        <h2>Buat Akun Admin</h2>
        <p class="muted small">Aplikasi belum punya pengguna. Akun pertama ini menjadi Admin, yang nantinya bisa menambah pengguna lain.</p>
        <form>
          ${field('fullName', 'Nama Lengkap')}
          ${field('username', 'Nama Pengguna', 'text', 'pattern="[A-Za-z0-9._\\-]{3,32}" title="3-32 karakter: huruf, angka, titik, garis bawah, minus"')}
          ${field('newPassword', `Password (minimal ${minPassword} karakter)`, 'password')}
          ${field('confirm', 'Ulangi Password', 'password')}
          <div class="auth-error" hidden></div>
          <button type="submit" class="btn-primary auth-submit">Buat Admin &amp; Masuk</button>
        </form>`);
      bindForm(el, async (v) => {
        checkNewPassword(v);
        const hasil = await A.call('auth.setup', { username: v.username, fullName: v.fullName, password: v.newPassword });
        await showRecoveryCode(hasil.recoveryCode, true);
        resolve(hasil.user);
      });
    });
  }

  function loginFlow() {
    return new Promise((resolve) => {
      const el = show(`
        <h2>Masuk</h2>
        <form>
          ${field('username', 'Nama Pengguna')}
          ${field('password', 'Password', 'password')}
          <div class="auth-error" hidden></div>
          <button type="submit" class="btn-primary auth-submit">Masuk</button>
        </form>
        <button class="btn-ghost auth-link" data-recover>Lupa password Admin?</button>`);
      bindForm(el, async (v) => {
        resolve(await A.call('auth.login', { username: v.username, password: v.password }));
      });
      el.querySelector('[data-recover]').addEventListener('click', async () => {
        const user = await recoverFlow();
        resolve(user || (await loginFlow()));
      });
    });
  }

  /** Atur ulang password Admin dengan kode pemulihan; null = kembali ke login. */
  function recoverFlow() {
    return new Promise((resolve) => {
      const el = show(`
        <h2>Pulihkan Password Admin</h2>
        <p class="muted small">Masukkan kode pemulihan yang dicatat saat akun Admin dibuat. Setelah dipakai, kode itu hangus dan Anda akan diberi kode baru.
        Operator yang lupa password cukup minta Admin meresetnya.</p>
        <form>
          ${field('username', 'Nama Pengguna Admin')}
          ${field('code', 'Kode Pemulihan', 'text', 'placeholder="XXXX-XXXX-XXXX-XXXX" style="font-family:monospace;text-transform:uppercase"')}
          ${field('newPassword', `Password Baru (minimal ${minPassword} karakter)`, 'password')}
          ${field('confirm', 'Ulangi Password Baru', 'password')}
          <div class="auth-error" hidden></div>
          <button type="submit" class="btn-primary auth-submit">Atur Ulang Password</button>
        </form>
        <button class="btn-ghost auth-link" data-back>← Kembali ke halaman masuk</button>`);
      bindForm(el, async (v) => {
        checkNewPassword(v);
        const hasil = await A.call('auth.recover', { username: v.username, code: v.code, newPassword: v.newPassword });
        await showRecoveryCode(hasil.recoveryCode, false);
        resolve(hasil.user);
      });
      el.querySelector('[data-back]').addEventListener('click', () => resolve(null));
    });
  }

  /** Password sementara dari Admin wajib diganti sebelum boleh bekerja. */
  function forceChangeFlow(user) {
    return new Promise((resolve) => {
      const el = show(`
        <h2>Ganti Password</h2>
        <p class="muted small">Halo ${esc(user.full_name)}, password Anda masih password sementara dari Admin. Ganti dulu sebelum melanjutkan.</p>
        <form>
          ${field('oldPassword', 'Password Sementara', 'password')}
          ${field('newPassword', `Password Baru (minimal ${minPassword} karakter)`, 'password')}
          ${field('confirm', 'Ulangi Password Baru', 'password')}
          <div class="auth-error" hidden></div>
          <button type="submit" class="btn-primary auth-submit">Simpan &amp; Lanjutkan</button>
        </form>
        <button class="btn-ghost auth-link" data-out>Keluar</button>`);
      bindForm(el, async (v) => {
        checkNewPassword(v);
        resolve(await A.call('auth.changePassword', { oldPassword: v.oldPassword, newPassword: v.newPassword }));
      });
      el.querySelector('[data-out]').addEventListener('click', async () => {
        await window.api.call('auth.logout', {});
        resolve(null);
      });
    });
  }

  /** Tampilkan kode pemulihan sekali; wajib dikonfirmasi sudah dicatat. */
  function showRecoveryCode(code, pertama) {
    return new Promise((resolve) => {
      const el = show(`
        <h2>Kode Pemulihan Admin</h2>
        <p class="muted small">${pertama ? 'Akun Admin sudah dibuat.' : 'Password berhasil diatur ulang. Kode lama sudah tidak berlaku.'}
        Catat atau cetak kode di bawah ini dan simpan di tempat aman. Kode ini satu-satunya cara memulihkan password Admin bila lupa,
        dan <strong>tidak akan ditampilkan lagi</strong>.</p>
        <div class="recovery-code">${esc(code)}</div>
        <form>
          <label class="check"><input type="checkbox" required /> Saya sudah mencatat kode ini</label>
          <div class="auth-error" hidden></div>
          <button type="submit" class="btn-primary auth-submit">Lanjutkan</button>
        </form>`);
      bindForm(el, async () => resolve());
    });
  }

  // ------------------------------------------------ masuk & kunci ulang

  /** Pastikan ada pengguna yang masuk; tampilkan layar yang sesuai sampai berhasil. */
  async function ensure() {
    const info = await A.callSafe('app.info', {}, {});
    companyName = (info && info.companyName) || '';
    for (;;) {
      const st = await A.call('auth.status');
      minPassword = st.minPassword || minPassword;
      let user = st.user;
      if (!user) user = st.needsSetup ? await setupFlow() : await loginFlow();
      if (user && user.must_change_password) user = await forceChangeFlow(user);
      if (user) {
        hide();
        locked = false;
        return user;
      }
    }
  }

  /** Kunci aplikasi: sembunyikan data, lalu minta masuk lagi. */
  async function lock(reason = null) {
    if (locked) return;
    locked = true;
    if (reason !== 'expired') await window.api.call('auth.logout', { reason });
    A.setUser(null);
    A.closeModal(null);
    A.hideProgress();
    $('#content').innerHTML = '';
    $('#topbarActions').innerHTML = '';
    const user = await ensure();
    if (onUnlock) await onUnlock(user);
  }

  // Sesi ditolak proses utama (mis. akun dinonaktifkan): langsung kunci.
  A.setAuthHandler(() => lock('expired'));

  // -------------------------------------------------------- kunci otomatis

  let idleMinutes = 15;
  let lastActivity = Date.now();
  ['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((evt) =>
    document.addEventListener(evt, () => {
      lastActivity = Date.now();
    }, { passive: true })
  );
  setInterval(() => {
    if (!locked && idleMinutes > 0 && Date.now() - lastActivity > idleMinutes * 60000) lock('idle');
  }, 20000);

  function setIdleMinutes(minutes) {
    const n = Number(minutes);
    idleMinutes = Number.isFinite(n) && n >= 0 ? n : 15;
    lastActivity = Date.now();
  }

  return {
    ensure,
    lock,
    setIdleMinutes,
    setOnUnlock: (fn) => {
      onUnlock = fn;
    },
    get locked() {
      return locked;
    },
  };
})();
