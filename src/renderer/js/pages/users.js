'use strict';

(function () {
  const A = window.App;
  const state = { search: '' };

  const ROLE_OPTIONS = [
    { value: 'operator', label: 'Operator — pekerjaan harian HRD' },
    { value: 'admin', label: 'Admin — akses penuh' },
  ];

  function roleBadge(u) {
    return u.role === 'admin'
      ? '<span class="badge" style="background:#2563eb">Admin</span>'
      : '<span class="badge" style="background:#64748b">Operator</span>';
  }

  async function userForm(existing) {
    const fields = existing
      ? [
          { name: 'full_name', label: 'Nama Lengkap', value: existing.full_name, required: true },
          { name: 'role', label: 'Peran', type: 'select', value: existing.role, options: ROLE_OPTIONS },
          { name: 'active', label: 'Akun aktif (bisa dipakai masuk)', type: 'checkbox', value: existing.active },
        ]
      : [
          { name: 'full_name', label: 'Nama Lengkap', required: true },
          {
            name: 'username', label: 'Nama Pengguna', required: true,
            hint: '3-32 karakter: huruf, angka, titik, garis bawah, atau minus',
            attrs: 'pattern="[A-Za-z0-9._\\-]{3,32}"',
          },
          { name: 'role', label: 'Peran', type: 'select', value: 'operator', options: ROLE_OPTIONS },
          {
            name: 'password', label: 'Password Sementara', type: 'password', required: true,
            hint: 'Minimal 8 karakter. Pengguna wajib menggantinya saat pertama kali masuk.',
          },
        ];

    const v = await A.formDialog({
      title: existing ? `Ubah Pengguna — ${existing.username}` : 'Tambah Pengguna',
      fields,
      validate: (x) => (!existing && (x.password || '').length < 8 ? 'Password minimal 8 karakter' : null),
    });
    if (!v) return;

    const res = existing
      ? await A.callSafe('users.update', { id: existing.id, fullName: v.full_name, role: v.role, active: v.active })
      : await A.callSafe('users.create', { username: v.username, fullName: v.full_name, role: v.role, password: v.password });
    if (res) {
      A.toast(existing ? 'Pengguna diperbarui' : `Pengguna ${res.username} dibuat`, 'ok');
      await A.refresh();
    }
  }

  async function resetPassword(user) {
    const v = await A.formDialog({
      title: `Reset Password — ${user.username}`,
      okLabel: 'Reset Password',
      fields: [
        {
          name: 'password', label: 'Password Sementara Baru', type: 'password', required: true,
          hint: `Berikan kepada ${user.full_name}. Ia wajib menggantinya saat masuk berikutnya.`,
        },
      ],
      validate: (x) => ((x.password || '').length < 8 ? 'Password minimal 8 karakter' : null),
    });
    if (!v) return;
    const res = await A.callSafe('users.resetPassword', { id: user.id, password: v.password });
    if (res) A.toast(`Password ${user.username} direset`, 'ok');
  }

  async function regenerateRecovery() {
    const v = await A.formDialog({
      title: 'Buat Ulang Kode Pemulihan',
      okLabel: 'Buat Kode Baru',
      fields: [
        {
          name: 'password', label: 'Password Anda', type: 'password', required: true,
          hint: 'Kode lama langsung tidak berlaku setelah kode baru dibuat.',
        },
      ],
    });
    if (!v) return;
    const res = await A.callSafe('users.regenerateRecovery', { password: v.password });
    if (!res) return;
    await A.modal({
      title: 'Kode Pemulihan Baru',
      body: `<p class="small muted" style="margin-top:0">Catat atau cetak kode ini dan simpan di tempat aman.
        Kode ini tidak akan ditampilkan lagi.</p>
        <div class="recovery-code">${A.esc(res.recoveryCode)}</div>`,
      footer: '<button class="btn-primary" data-close>Sudah Saya Catat</button>',
    });
    await A.refresh();
  }

  A.registerPage('users', {
    title: 'Pengguna',
    subtitle: 'Akun yang boleh membuka aplikasi, dan catatan aktivitasnya',

    async render(root) {
      const halaman = A.pageRequest('audit', { resetOn: [state.search] });
      const [{ users, recovery }, settings, logs] = await Promise.all([
        A.call('users.list'),
        A.call('settings.all'),
        A.call('audit.list', { search: state.search, ...halaman }),
      ]);

      A.setActions(`<button class="btn-primary" id="btnAddUser">+ Tambah Pengguna</button>`, {
        '#btnAddUser': () => userForm(null),
      });

      const me = A.user;
      const kodeDibuat = recovery && recovery.createdAt
        ? new Date(recovery.createdAt).toLocaleString('id-ID')
        : 'belum ada';

      root.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Pengguna Aplikasi</h3>
              <div class="sub">Admin: akses penuh. Operator: tarik data, karyawan, jadwal, izin, scan manual, dan rekap —
                tanpa hapus data, konfigurasi mesin &amp; sistem, pemulihan backup, atau kelola pengguna.</div>
            </div>
          </div>
          <div class="card-body flush">
            ${A.table(
              [
                {
                  label: 'Pengguna',
                  render: (u) => `<strong>${A.esc(u.full_name)}</strong>${me && me.id === u.id ? ' <span class="badge soft">Anda</span>' : ''}
                    <div class="small muted">${A.esc(u.username)}</div>`,
                },
                { label: 'Peran', className: 'c', render: roleBadge },
                {
                  label: 'Status', className: 'c',
                  render: (u) => (u.active
                    ? (u.must_change_password ? '<span class="badge" style="background:#f59e0b">Wajib ganti password</span>' : '<span class="badge" style="background:#10b981">Aktif</span>')
                    : '<span class="badge" style="background:#94a3b8">Nonaktif</span>'),
                },
                { label: 'Terakhir Masuk', className: 'nowrap', render: (u) => A.esc(u.last_login_at ? A.fmt.dateTime(u.last_login_at) : '-') },
                {
                  label: '', className: 'r',
                  render: (u) => `<div class="row-actions">
                    <button class="btn-sm" data-act="edit" data-id="${u.id}">Ubah</button>
                    <button class="btn-sm" data-act="reset" data-id="${u.id}">Reset Password</button>
                  </div>`,
                },
              ],
              users
            )}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Keamanan</h3></div></div>
          <div class="card-body">
            <div class="field-row">
              <div class="field">
                <label for="autoLock">Kunci otomatis setelah tidak dipakai (menit)</label>
                <div style="display:flex;gap:8px">
                  <input type="number" id="autoLock" min="0" max="240" value="${A.esc(settings.auto_lock_minutes || '15')}" style="width:120px" />
                  <button class="btn-sm" data-act="save-lock">Simpan</button>
                </div>
                <div class="hint">Isi 0 untuk tidak pernah mengunci otomatis.</div>
              </div>
              <div class="field">
                <label>Kode Pemulihan Admin</label>
                <div><button class="btn-sm" data-act="recovery">Buat Ulang Kode Pemulihan</button></div>
                <div class="hint">Dibuat: ${A.esc(kodeDibuat)}. Buat ulang bila kode lama hilang atau mungkin diketahui orang lain.</div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div><h3>Catatan Aktivitas</h3><div class="sub">${logs.total.toLocaleString('id-ID')} kejadian: masuk/keluar, scan manual, penghapusan data, perubahan mesin, backup, dan pengguna</div></div>
            <input class="search" id="auditSearch" placeholder="Cari pengguna / tindakan..." value="${A.esc(state.search)}" style="width:260px" />
          </div>
          <div class="card-body flush">
            ${A.table(
              [
                { label: 'Waktu', className: 'nowrap num', render: (l) => A.esc(A.fmt.dateTime(l.at)) },
                { label: 'Pengguna', className: 'nowrap', render: (l) => A.esc(l.username || '-') },
                { label: 'Tindakan', className: 'nowrap', render: (l) => `<strong>${A.esc(l.action)}</strong>` },
                { label: 'Keterangan', render: (l) => `<span class="small">${A.esc(l.detail || '')}</span>` },
              ],
              logs.rows,
              { empty: 'Belum ada aktivitas tercatat.' }
            )}
          </div>
          ${A.pagerHtml('audit', logs.total)}
        </div>
      `;

      const byId = (id) => users.find((u) => String(u.id) === String(id));
      A.bindActions(root, {
        edit: (d) => userForm(byId(d.id)),
        reset: (d) => resetPassword(byId(d.id)),
        recovery: () => regenerateRecovery(),
        'save-lock': async (_d, btn) => {
          const menit = Math.max(0, Math.min(240, Math.round(Number(A.$('#autoLock', root).value) || 0)));
          await A.busy(btn, async () => {
            const ok = await A.callSafe('settings.save', { auto_lock_minutes: String(menit) });
            if (ok) {
              window.Auth.setIdleMinutes(menit);
              A.toast(menit ? `Aplikasi terkunci setelah ${menit} menit tidak dipakai` : 'Kunci otomatis dimatikan', 'ok');
            }
          });
        },
      });

      let timer = null;
      A.$('#auditSearch', root).addEventListener('input', (e) => {
        clearTimeout(timer);
        state.search = e.target.value;
        timer = setTimeout(() => A.refresh(), 300);
      });
    },
  });
})();
