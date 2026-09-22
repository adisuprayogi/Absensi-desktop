'use strict';

(function () {
  const A = window.App;

  const KIND_BADGE = {
    otomatis: '<span class="badge" style="background:#2563eb">Otomatis</span>',
    manual: '<span class="badge" style="background:#10b981">Manual</span>',
    pengaman: '<span class="badge" style="background:#f59e0b">Pengaman</span>',
  };

  /** Kartu pengelola backup: pengaturan, tombol aksi, dan daftar berkasnya. */
  function backupCard(cfg, backups) {
    const terakhir = cfg.last_backup_at
      ? new Date(cfg.last_backup_at).toLocaleString('id-ID')
      : 'belum pernah';

    return `<div class="card">
      <div class="card-head">
        <div>
          <h3>Backup &amp; Pemulihan Data</h3>
          <div class="sub">Backup terakhir: ${A.esc(terakhir)} • ${backups.items.length} berkas tersimpan</div>
        </div>
        <div class="pill-row">
          <button class="btn-primary btn-sm" data-act="backup-now">Backup Sekarang</button>
          <button class="btn-sm" data-act="backup-as">Simpan ke Lokasi Lain...</button>
          <button class="btn-sm" data-act="restore-file">Pulihkan dari Berkas...</button>
        </div>
      </div>
      <div class="card-body">
        <div class="field-row cols-3">
          <div class="field">
            <label class="check">
              <input type="checkbox" id="auto_backup_enabled"${cfg.auto_backup_enabled === '1' ? ' checked' : ''}>
              Backup otomatis harian
            </label>
            <div class="hint">Dibuat sekali sehari saat aplikasi dipakai</div>
          </div>
          <div class="field">
            <label>Jumlah Backup Otomatis Disimpan</label>
            <input type="number" id="auto_backup_keep" min="1" max="365" value="${A.esc(cfg.auto_backup_keep || '14')}" />
            <div class="hint">Yang paling lama dibuang sendiri</div>
          </div>
          <div class="field">
            <label>Folder Penyimpanan</label>
            <div style="display:flex;gap:6px">
              <button class="btn-sm" data-act="choose-folder" style="white-space:nowrap">Pilih Folder...</button>
              <button class="btn-sm" data-act="open-folder" style="white-space:nowrap">Buka</button>
            </div>
            <div class="hint" style="word-break:break-all">${A.esc(backups.folder)}</div>
          </div>
        </div>

        <p class="small muted" style="margin:4px 0 0">
          Backup manual dan salinan pengaman tidak pernah dihapus otomatis.
          Sebelum memulihkan, aplikasi selalu membuat salinan pengaman dari data
          yang sedang dipakai — jadi hasil pemulihan yang keliru masih bisa dibatalkan.
        </p>
      </div>
      <div class="card-body flush">
        ${A.table(
          [
            { label: 'Nama Berkas', render: (b) => `<strong>${A.esc(b.name)}</strong>` },
            { label: 'Jenis', className: 'c', render: (b) => KIND_BADGE[b.kind] || '' },
            {
              label: 'Waktu', className: 'nowrap',
              render: (b) => A.esc(new Date(b.modified).toLocaleString('id-ID')),
            },
            { label: 'Ukuran', className: 'r num', render: (b) => A.esc(b.sizeText) },
            {
              label: '', className: 'r',
              render: (b) => `<div class="row-actions">
                <button class="btn-sm" data-act="inspect" data-file="${A.esc(b.filePath)}">Lihat Isi</button>
                <button class="btn-sm" data-act="restore" data-file="${A.esc(b.filePath)}" data-name="${A.esc(b.name)}">Pulihkan</button>
                <button class="btn-sm btn-danger" data-act="delete-backup" data-file="${A.esc(b.filePath)}" data-name="${A.esc(b.name)}">Hapus</button>
              </div>`,
            },
          ],
          backups.items,
          { empty: 'Belum ada backup. Tekan "Backup Sekarang" untuk membuat yang pertama.' }
        )}
      </div>
    </div>`;
  }

  /** Ringkasan isi sebuah berkas backup, supaya pengguna tahu yang akan dipulihkan. */
  function ringkasanIsi(info) {
    const baris = [
      ['Nama berkas', info.fileName],
      ['Ukuran', info.sizeText],
      ['Dibuat', new Date(info.modified).toLocaleString('id-ID')],
      ['Perusahaan', info.company || '-'],
      ['Jumlah karyawan', String(info.employees)],
      ['Jumlah mesin', String(info.devices)],
      ['Jumlah log absensi', Number(info.logs).toLocaleString('id-ID')],
      ['Rentang log', info.firstLog ? `${A.fmt.date(info.firstLog)} s/d ${A.fmt.date(info.lastLog)}` : '-'],
    ];
    return `<dl class="kv">${baris.map(([k, v]) => `<dt>${A.esc(k)}</dt><dd>${A.esc(v)}</dd>`).join('')}</dl>`;
  }

  /** Tampilkan isi backup, lalu tawarkan pemulihan dari dialog yang sama. */
  async function tinjauBackup(filePath, { tawarkanPulihkan = true } = {}) {
    const info = await A.callSafe('backup.inspect', { filePath });
    if (!info) return;
    if (!info.ok) {
      await A.modal({
        title: 'Berkas Tidak Bisa Dipakai',
        body: `<p style="margin:0 0 8px">Berkas ini tidak bisa dipulihkan:</p>
               <p class="small" style="margin:0;color:#dc2626">${A.esc(info.error)}</p>`,
        footer: '<button data-close>Tutup</button>',
      });
      return;
    }

    const lanjut = await A.modal({
      title: 'Isi Berkas Backup',
      body: ringkasanIsi(info),
      footer: `<button data-close>Tutup</button>${
        tawarkanPulihkan ? '<button class="btn-danger" data-pulihkan>Pulihkan Data Ini</button>' : ''
      }`,
      onOpen: (box) => {
        const btn = A.$('[data-pulihkan]', box);
        if (btn) btn.addEventListener('click', () => A.closeModal('pulihkan'));
      },
    });
    if (lanjut === 'pulihkan') await jalankanPemulihan(filePath, info);
  }

  /** Konfirmasi berlapis, lalu pulihkan dan jalankan ulang aplikasi. */
  async function jalankanPemulihan(filePath, info) {
    const ok = await A.confirm(
      `Ganti seluruh data saat ini dengan isi backup ini?`,
      {
        title: 'Pulihkan Data',
        okLabel: 'Ya, Pulihkan Sekarang',
        detail:
          `Backup berisi ${info.employees} karyawan dan ${Number(info.logs).toLocaleString('id-ID')} log absensi.\n\n` +
          'Data yang sedang dipakai akan disalin dulu sebagai cadangan pengaman. ' +
          'Aplikasi menutup sendiri dan terbuka lagi setelah pemulihan selesai.',
      }
    );
    if (!ok) return;

    const res = await A.callSafe('backup.restore', { filePath });
    if (!res) return;
    if (!res.ok) {
      A.toast(res.error, 'err', 9000);
      return;
    }
    await A.modal({
      title: 'Pemulihan Berhasil',
      body: `<p style="margin:0 0 10px">Data telah dipulihkan. Aplikasi akan menutup dan terbuka kembali sesaat lagi.</p>
             <p class="small muted" style="margin:0">Data sebelumnya disimpan sebagai salinan pengaman di folder backup.</p>`,
      footer: '',
    });
  }

  async function holidayDialog() {
    const values = await A.formDialog({
      title: 'Tambah Hari Libur',
      okLabel: 'Tambah',
      fields: [
        { name: 'date', label: 'Tanggal', type: 'date', required: true, value: A.fmt.today() },
        { name: 'name', label: 'Keterangan', required: true, attrs: 'placeholder="Mis. Hari Raya Idul Fitri"' },
      ],
    });
    if (!values) return;
    await A.callSafe('holidays.create', values);
    A.toast('Hari libur ditambahkan', 'ok');
    await A.refresh();
  }

  /** Pilih att2000.mdb, tampilkan ringkasan isinya, lalu impor bila disetujui. */
  async function importAtt2000(btn) {
    const pilih = await A.busy(btn, () => A.callSafe('att2000.choose'), 'Membaca berkas...');
    if (!pilih || !pilih.ok) return;
    const p = pilih.preview;
    const angka = (n) => Number(n || 0).toLocaleString('id-ID');
    const kosong = !p.employees.total && !p.logs.total && !p.shifts && !p.leaves && !p.holidays && !p.departments;

    const baris = [
      ['Karyawan', p.employees.total, `${angka(p.employees.baru)} baru, ${angka(p.employees.sudahAda)} PIN sudah ada (dilewati)`],
      ['Log scan', p.logs.total, p.logs.total
        ? `${A.fmt.dateTime(p.logs.dari)} s/d ${A.fmt.dateTime(p.logs.sampai)}` +
          (p.logs.tanpaKaryawan ? ` • ${angka(p.logs.tanpaKaryawan)} tanpa data karyawan (dilewati)` : '')
        : ''],
      ['Departemen', p.departments, 'Dipasangkan lewat nama bila sudah ada'],
      ['Shift', p.shifts, 'Dilewati bila namanya sudah ada'],
      ['Jenis izin', p.leaveTypes, 'Dilewati bila namanya sudah ada'],
      ['Izin & cuti', p.leaves, 'Disimpan dengan status Disetujui'],
      ['Hari libur', p.holidays, ''],
    ];
    const tabel = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Data</th><th class="r">Ditemukan</th><th>Keterangan</th></tr></thead>
      <tbody>${baris.map(([a, n, k]) => `<tr><td><strong>${A.esc(a)}</strong></td><td class="r num">${angka(n)}</td><td class="small muted">${A.esc(k)}</td></tr>`).join('')}</tbody>
    </table></div>`;

    const lewat = [];
    if (p.schedules) lewat.push(`${angka(p.schedules)} jadwal shift — atur ulang di halaman Jadwal Shift`);
    if (p.fingerprints) lewat.push(`${angka(p.fingerprints)} sidik jari — ambil dari mesin lewat Sinkron Karyawan → Baca Ulang dari Mesin`);
    if (p.machines) lewat.push(`${angka(p.machines)} mesin — daftarkan di halaman Mesin Absensi`);

    const setuju = await A.modal({
      title: 'Impor dari Att2000 / ZKTime',
      wide: true,
      body: `
        <p class="small muted" style="margin-top:0">Berkas: <strong>${A.esc(pilih.filePath)}</strong></p>
        ${kosong
          ? `<div class="warn-bar" style="margin:0 0 12px">Berkas ini tidak berisi data karyawan maupun absensi — kemungkinan database
              Att2000 baru yang belum pernah dipakai. Cari berkas att2000.mdb di komputer yang selama ini menjalankan software Att2000.</div>`
          : ''}
        ${tabel}
        ${lewat.length ? `<p class="small" style="margin:12px 0 4px"><b>Tidak ikut diimpor:</b></p>
          <ul class="small muted" style="margin:0;padding-left:18px">${lewat.map((x) => `<li>${A.esc(x)}</li>`).join('')}</ul>` : ''}
        <p class="small muted" style="margin:12px 0 0">Sebelum impor, aplikasi membuat backup data yang sedang dipakai.</p>`,
      footer: `<button data-close>Batal</button>
        <button class="btn-primary" data-ok${kosong ? ' disabled' : ''}>Impor Sekarang</button>`,
      onOpen: (box) => {
        A.$('[data-ok]', box).addEventListener('click', () => A.closeModal(true));
      },
    });
    if (!setuju) return;

    const hasil = await A.busy(btn, () => A.callSafe('att2000.import', { filePath: pilih.filePath }), 'Mengimpor...');
    if (!hasil) return;
    await A.modal({
      title: 'Impor Selesai',
      body: `<div class="table-wrap"><table class="data"><tbody>
        <tr><td>Karyawan baru</td><td class="r num"><strong>${angka(hasil.employees)}</strong></td></tr>
        <tr><td>Karyawan dilewati (PIN sudah ada)</td><td class="r num">${angka(hasil.employeesSkipped)}</td></tr>
        <tr><td>Log scan baru</td><td class="r num"><strong>${angka(hasil.logs)}</strong></td></tr>
        <tr><td>Log scan dilewati (sudah ada / tanpa karyawan)</td><td class="r num">${angka(hasil.logsDuplicate + hasil.logsUnknown)}</td></tr>
        <tr><td>Departemen baru</td><td class="r num">${angka(hasil.departments)}</td></tr>
        <tr><td>Shift baru</td><td class="r num">${angka(hasil.shifts)}</td></tr>
        <tr><td>Jenis izin baru</td><td class="r num">${angka(hasil.leaveTypes)}</td></tr>
        <tr><td>Izin & cuti</td><td class="r num">${angka(hasil.leaves)}</td></tr>
        <tr><td>Hari libur</td><td class="r num">${angka(hasil.holidays)}</td></tr>
      </tbody></table></div>
      <p class="small muted" style="margin:12px 0 0">Backup sebelum impor: ${A.esc(hasil.backup)}.
        Langkah berikutnya: kirim karyawan ke mesin lewat Sinkron Karyawan, lalu periksa shift dan jadwal.</p>`,
      footer: '<button class="btn-primary" data-close>Tutup</button>',
    });
    await A.refresh();
  }

  A.registerPage('settings', {
    title: 'Pengaturan',
    subtitle: 'Identitas perusahaan, aturan absensi, hari libur, dan backup data',

    async render(root) {
      const year = new Date().getFullYear();
      const [cfg, info, holidays, stats, backups] = await Promise.all([
        A.call('settings.all'),
        A.call('app.info'),
        A.call('holidays.list', {}),
        A.call('attendance.stats'),
        A.call('backup.list'),
      ]);

      A.setActions('');

      root.innerHTML = `
        <div class="grid cols-2">
          <div class="card" style="margin:0">
            <div class="card-head"><div><h3>Identitas Perusahaan</h3><div class="sub">Muncul di kop laporan Excel dan PDF</div></div></div>
            <div class="card-body">
              <div class="field"><label>Nama Perusahaan</label><input id="company_name" value="${A.esc(cfg.company_name || '')}" /></div>
              <div class="field"><label>Alamat</label><textarea id="company_address">${A.esc(cfg.company_address || '')}</textarea></div>
              <div class="field-row">
                <div class="field"><label>Nama Penanda Tangan</label><input id="report_signer" value="${A.esc(cfg.report_signer || '')}" /><div class="hint">Kosongkan bila tidak perlu kolom tanda tangan</div></div>
                <div class="field"><label>Jabatan Penanda Tangan</label><input id="report_signer_title" value="${A.esc(cfg.report_signer_title || '')}" /></div>
              </div>
              <div class="field"><label>Catatan Kaki Laporan</label><input id="report_footer" value="${A.esc(cfg.report_footer || '')}" /></div>
            </div>
          </div>

          <div class="card" style="margin:0">
            <div class="card-head"><div><h3>Sinkronisasi Mesin</h3><div class="sub">Cara aplikasi mengambil data dari mesin absensi</div></div></div>
            <div class="card-body">
              <div class="field">
                <label class="check"><input type="checkbox" id="auto_sync_enabled"${cfg.auto_sync_enabled === '1' ? ' checked' : ''}> Aktifkan auto-sync terjadwal</label>
                <div class="hint">Aplikasi menarik data sendiri dari mesin yang ditandai "Auto-sync"</div>
              </div>
              <div class="field">
                <label>Interval Auto-sync (menit)</label>
                <input type="number" id="auto_sync_interval" min="1" max="1440" value="${A.esc(cfg.auto_sync_interval || '15')}" />
              </div>
              <div class="field">
                <label class="check"><input type="checkbox" id="live_capture_enabled"${cfg.live_capture_enabled === '1' ? ' checked' : ''}> Aktifkan live capture (realtime)</label>
                <div class="hint">Saklar utama. Mesin yang ikut realtime diatur satu per satu di halaman Mesin Absensi.</div>
              </div>
              <div class="field">
                <label>Abaikan Scan Berulang Dalam (detik)</label>
                <input type="number" id="duplicate_window" min="0" max="3600" value="${A.esc(cfg.duplicate_window || '60')}" />
                <div class="hint">Mencegah tap ganda tercatat dua kali</div>
              </div>
            </div>
          </div>

          <div class="card" style="margin:0">
            <div class="card-head"><div><h3>Aturan Perhitungan</h3><div class="sub">Rentang waktu scan yang diakui milik sebuah shift</div></div></div>
            <div class="card-body">
              <div class="field-row">
                <div class="field">
                  <label>Toleransi Sebelum Jam Masuk (jam)</label>
                  <input type="number" id="window_before_hours" min="1" max="12" value="${A.esc(cfg.window_before_hours || '6')}" />
                </div>
                <div class="field">
                  <label>Toleransi Setelah Jam Pulang (jam)</label>
                  <input type="number" id="window_after_hours" min="1" max="12" value="${A.esc(cfg.window_after_hours || '6')}" />
                </div>
              </div>
              <p class="small muted" style="margin:0">
                Contoh: shift 08:00–17:00 dengan toleransi 6 jam mengakui scan antara 02:00 dan 23:00
                sebagai absensi hari itu. Perbesar bila karyawan sering datang jauh lebih awal.
              </p>
            </div>
          </div>

          <div class="card" style="margin:0">
            <div class="card-head"><div><h3>Data Aplikasi</h3></div></div>
            <div class="card-body">
              <dl class="kv">
                <dt>Versi Aplikasi</dt><dd>${A.esc(info.version)}</dd>
                <dt>Total Log Absensi</dt><dd class="num">${stats.total.toLocaleString('id-ID')}</dd>
                <dt>Log Tanpa Karyawan</dt><dd class="num">${stats.unknown.toLocaleString('id-ID')}</dd>
                <dt>Log Pertama</dt><dd>${A.esc(stats.first ? A.fmt.dateTime(stats.first) : '-')}</dd>
                <dt>Log Terakhir</dt><dd>${A.esc(stats.last ? A.fmt.dateTime(stats.last) : '-')}</dd>
                <dt>Lokasi Database</dt><dd class="small" style="word-break:break-all;font-weight:400">${A.esc(info.dbPath)}</dd>
              </dl>
              <div class="pill-row" style="margin-top:14px">
                <button data-act="relink">Sambungkan Ulang Log ke Karyawan</button>
              </div>
              <p class="small muted" style="margin:12px 0 0">
                "Sambungkan ulang" berguna setelah menambah karyawan baru: log lama dengan PIN yang
                sama akan langsung terhubung dan masuk ke rekap.
              </p>
            </div>
          </div>
        </div>

        ${backupCard(cfg, backups)}

        <div class="card" data-admin>
          <div class="card-head">
            <div>
              <h3>Impor dari Att2000 / ZKTime</h3>
              <div class="sub">Pindahkan data dari software bawaan mesin ZKTeco (berkas att2000.mdb)</div>
            </div>
            <button class="btn-primary btn-sm" data-act="import-att">Pilih Berkas .mdb...</button>
          </div>
          <div class="card-body">
            <p class="small muted" style="margin:0">
              Yang dipindahkan: departemen, karyawan, log scan, shift, jenis izin, izin/cuti, dan hari libur.
              Data yang sudah ada di aplikasi tidak ditimpa, dan backup dibuat otomatis sebelum impor.
              Berkasnya biasanya ada di <code>C:\\Program Files (x86)\\Att2000\\att2000.mdb</code> pada komputer lama.
            </p>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div><h3>Hari Libur Nasional</h3><div class="sub">Dipakai saat membuat jadwal massal dan menentukan status libur di rekap</div></div>
            <button class="btn-primary btn-sm" data-act="add-holiday">+ Tambah Hari Libur</button>
          </div>
          <div class="card-body flush">
            ${A.table(
              [
                { label: 'Tanggal', className: 'nowrap', render: (h) => `<strong>${A.esc(A.fmt.dateLong(h.date))}</strong>` },
                { label: 'Hari', className: 'c', render: (h) => A.esc(A.fmt.dayName(h.date)) },
                { label: 'Keterangan', render: (h) => A.esc(h.name) },
                {
                  label: '', className: 'r',
                  render: (h) => `<button class="btn-sm btn-danger" data-act="del-holiday" data-id="${h.id}">Hapus</button>`,
                },
              ],
              holidays,
              { empty: `Belum ada hari libur terdaftar untuk ${year} maupun tahun lain.` }
            )}
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px;padding-bottom:20px">
          <button class="btn-primary" data-act="save">Simpan Pengaturan</button>
        </div>
      `;

      A.bindActions(root, {
        save: async (d, btn) => {
          const val = (id) => {
            const el = A.$(`#${id}`, root);
            if (!el) return '';
            return el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
          };
          await A.busy(btn, async () => {
            await A.callSafe('settings.save', {
              company_name: val('company_name'),
              company_address: val('company_address'),
              report_signer: val('report_signer'),
              report_signer_title: val('report_signer_title'),
              report_footer: val('report_footer'),
              auto_sync_enabled: val('auto_sync_enabled'),
              auto_sync_interval: val('auto_sync_interval'),
              live_capture_enabled: val('live_capture_enabled'),
              duplicate_window: val('duplicate_window'),
              window_before_hours: val('window_before_hours'),
              window_after_hours: val('window_after_hours'),
              auto_backup_enabled: val('auto_backup_enabled'),
              auto_backup_keep: val('auto_backup_keep'),
            });
            A.toast('Pengaturan disimpan', 'ok');
            const brand = A.$('#brandCompany');
            if (brand) brand.textContent = val('company_name') || 'Karyawan';
          }, 'Menyimpan...');
        },

        'backup-now': async (d, btn) => {
          await A.busy(btn, async () => {
            const res = await A.callSafe('backup.now');
            if (res && res.ok) A.toast(`Backup dibuat: ${res.fileName} (${res.sizeText})`, 'ok', 5000);
            await A.refresh();
          }, 'Membuat backup...');
        },

        'backup-as': async (d, btn) => {
          await A.busy(btn, async () => {
            const res = await A.callSafe('backup.saveAs');
            if (res && res.ok) A.toast(`Backup tersimpan: ${res.filePath}`, 'ok', 7000);
            await A.refresh();
          }, 'Menyimpan...');
        },

        'choose-folder': async () => {
          const res = await A.callSafe('backup.chooseFolder');
          if (res && res.ok) {
            A.toast('Folder backup diubah', 'ok');
            await A.refresh();
          }
        },

        'open-folder': () => A.callSafe('backup.openFolder'),

        inspect: (d) => tinjauBackup(d.file, { tawarkanPulihkan: false }),

        restore: (d) => tinjauBackup(d.file),

        'restore-file': async () => {
          const info = await A.callSafe('backup.choose');
          if (!info || info.canceled) return;
          if (!info.ok) {
            A.toast(info.error, 'err', 9000);
            return;
          }
          await tinjauBackup(info.filePath);
        },

        'delete-backup': async (d) => {
          const ok = await A.confirm(`Hapus berkas backup "${d.name}"?`, {
            okLabel: 'Hapus',
            detail: 'Berkas dihapus permanen dari folder backup.',
          });
          if (!ok) return;
          await A.callSafe('backup.remove', { filePath: d.file });
          A.toast('Berkas backup dihapus', 'ok');
          await A.refresh();
        },

        relink: async (d, btn) => {
          await A.busy(btn, async () => {
            await A.callSafe('employees.relinkLogs');
            A.toast('Log absensi disambungkan ulang ke data karyawan', 'ok');
            await A.refresh();
          }, 'Memproses...');
        },

        'import-att': (d, btn) => importAtt2000(btn),

        'add-holiday': () => holidayDialog(),

        'del-holiday': async (d) => {
          await A.callSafe('holidays.remove', { id: Number(d.id) });
          await A.refresh();
        },
      });
    },
  });
})();
