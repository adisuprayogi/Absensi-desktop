'use strict';

(function () {
  const A = window.App;
  const state = { search: '', departmentId: '', activeOnly: false };
  // Karyawan terpilih untuk tindakan massal; bertahan saat pindah halaman tabel.
  const pilihan = new Set();

  /**
   * PIN yang diketik sudah dipakai orang lain di mesin. Admin memilih:
   * kembali ke form, pakai PIN kosong lain, import orang itu dari mesin, atau
   * tetap memakai PIN ini (bila memang orang yang sama).
   */
  async function pinConflictDialog(values, konflik, nextPin, baru) {
    const daftar = konflik
      .map((k) => `<li><strong>${A.esc(k.device_name)}</strong>: "${A.esc(k.name || '(tanpa nama)')}"` +
        (k.finger_count ? ` — <strong>${k.finger_count} sidik jari</strong>` : ' — belum ada sidik jari') +
        (Number(k.card) ? `, kartu ${A.esc(k.card)}` : '') + '</li>')
      .join('');
    return A.modal({
      title: `PIN ${values.pin} Sudah Dipakai di Mesin`,
      wide: true,
      body: `
        <p style="margin-top:0">PIN <strong>${A.esc(values.pin)}</strong> sudah dipakai user yang belum terdaftar di aplikasi:</p>
        <ul style="margin:0 0 12px;padding-left:20px;line-height:1.7">${daftar}</ul>
        <div class="warn-bar" style="margin:0 0 12px">
          Bila ${A.esc(values.name)} disimpan dengan PIN ini lalu dikirim ke mesin, data orang tersebut di mesin
          <b>tertimpa</b>, dan sidik jarinya ikut menjadi milik ${A.esc(values.name)} —
          setiap orang itu scan, tercatat sebagai ${A.esc(values.name)}.
        </div>
        <p class="small muted" style="margin:0">Scan dengan PIN ini yang sudah tertarik juga akan tercatat atas nama ${A.esc(values.name)}.</p>`,
      footer: `
        <button data-choice="back">Kembali ke Form</button>
        ${baru ? '<button data-choice="import">Import Orang Itu dari Mesin</button>' : ''}
        <button class="btn-primary" data-choice="other">Pakai PIN Kosong (${A.esc(nextPin)})</button>
        <button class="btn-danger" data-choice="keep">Tetap Pakai PIN Ini</button>`,
      onOpen: (box) => {
        A.$$('[data-choice]', box).forEach((b) =>
          b.addEventListener('click', () => A.closeModal(b.dataset.choice))
        );
      },
    });
  }

  /**
   * @param existing karyawan yang diubah, atau null untuk karyawan baru
   * @param draft    isian sebelumnya, saat form dibuka ulang dari dialog bentrok PIN
   */
  async function employeeForm(existing, draft = null) {
    const [depts, shifts, nextPin] = await Promise.all([
      A.call('departments.list'),
      A.call('shifts.list', { activeOnly: true }),
      existing || draft ? null : A.call('employees.nextPin'),
    ]);
    const awal = draft || existing || {};

    const values = await A.formDialog({
      title: existing ? `Ubah Karyawan — ${existing.name}` : 'Tambah Karyawan',
      okLabel: existing ? 'Simpan Perubahan' : 'Tambah',
      wide: true,
      fields: [
        {
          name: 'pin', label: 'PIN / User ID Mesin', required: true, row: 'a',
          value: draft ? draft.pin : existing ? existing.pin : nextPin,
          hint: existing
            ? 'Harus sama persis dengan User ID di mesin absensi'
            : 'Terisi otomatis dengan nomor yang belum dipakai di aplikasi maupun di mesin. Boleh diganti.',
        },
        { name: 'nip', label: 'NIP / Nomor Pegawai', row: 'a', value: awal.nip || '' },
        { name: 'name', label: 'Nama Lengkap', required: true, value: awal.name || '' },
        {
          name: 'department_id', label: 'Departemen', type: 'select', row: 'b',
          value: awal.department_id || '',
          options: [{ value: '', label: '— Tidak ada —' }, ...depts.map((d) => ({ value: d.id, label: d.name }))],
        },
        { name: 'position', label: 'Jabatan', row: 'b', value: awal.position || '' },
        {
          name: 'default_shift_id', label: 'Shift Bawaan', type: 'select', row: 'c',
          value: awal.default_shift_id || '',
          options: [
            { value: '', label: '— Ikuti jadwal mingguan —' },
            ...shifts.map((s) => ({ value: s.id, label: `${s.code} — ${s.name} (${s.start_time}-${s.end_time})` })),
          ],
          hint: 'Shift yang dipakai pada hari kerja. Hari yang ditandai libur di jadwal mingguan tetap libur.',
        },
        { name: 'join_date', label: 'Tanggal Masuk', type: 'date', row: 'c', value: awal.join_date || '' },
        {
          name: 'card', label: 'Nomor Kartu RFID', type: 'number', row: 'e',
          value: awal.card || '',
          attrs: 'min="0" step="1"',
          hint: 'Kosongkan bila tidak memakai kartu. Ikut terkirim saat sinkron ke mesin.',
        },
        {
          name: 'privilege', label: 'Hak Akses di Mesin', type: 'select', row: 'e',
          value: awal.privilege || 0,
          options: [
            { value: 0, label: 'Pengguna biasa' },
            { value: 2, label: 'Pendaftar (boleh mendaftarkan sidik jari)' },
            { value: 12, label: 'Manajer' },
            { value: 14, label: 'Administrator mesin' },
          ],
        },
        {
          name: 'device_password', label: 'Password Mesin', row: 'f',
          value: awal.device_password || '',
          attrs: 'maxlength="8" inputmode="numeric"',
          hint: 'Angka, untuk absen tanpa sidik jari. Kosongkan bila tidak dipakai.',
        },
        { name: 'phone', label: 'No. HP', row: 'f', value: awal.phone || '' },
        { name: 'email', label: 'Email', type: 'email', row: 'f', value: awal.email || '' },
        { name: 'note', label: 'Catatan', type: 'textarea', value: awal.note || '' },
        { name: 'active', label: 'Karyawan aktif', type: 'checkbox', value: awal.active !== undefined ? awal.active : 1 },
      ],
      validate: (v) => (!String(v.pin || '').trim() ? 'PIN wajib diisi' : null),
    });
    if (!values) return;
    values.pin = String(values.pin).trim();

    // PIN yang sudah dipakai orang lain di mesin: jangan diam-diam disimpan.
    const konflik = await A.callSafe('employees.pinConflicts', { pin: values.pin, id: existing ? existing.id : null }, []);
    if (konflik && konflik.length) {
      const kosong = await A.call('employees.nextPin');
      const pilihan = await pinConflictDialog(values, konflik, kosong, !existing);
      if (pilihan === 'other') return employeeForm(existing, { ...values, pin: kosong });
      if (pilihan === 'import') return importConflict(values, konflik);
      if (pilihan !== 'keep') return employeeForm(existing, values);
    }

    try {
      if (existing) await A.call('employees.update', { id: existing.id, ...values });
      else await A.call('employees.create', values);
    } catch (err) {
      A.toast(err.message, 'err', 6000);
      return employeeForm(existing, values);
    }
    A.toast(existing ? 'Data karyawan diperbarui' : 'Karyawan ditambahkan', 'ok');
    await A.refresh();
  }

  /**
   * Orang di mesin itu ternyata memang yang dimaksud: buat karyawannya dengan
   * nama, kartu, hak akses, dan password dari mesin, sementara departemen,
   * jabatan, shift, dll. tetap dari isian form. Kondisinya langsung dicatat
   * sepakat, supaya halaman Sinkron Karyawan menunjukkan "Sudah di mesin".
   */
  async function importConflict(values, konflik) {
    const utama = konflik[0];
    try {
      await A.call('employees.create', {
        ...values,
        name: utama.name || values.name,
        card: utama.card || 0,
        privilege: utama.privilege || 0,
        device_password: utama.password || values.device_password,
      });
      // Mesin pertama didahulukan: dicatat terakhir supaya datanya yang dipakai.
      for (const k of [...konflik].reverse()) {
        await A.call('devices.adoptFromDevice', { deviceId: k.device_id, pins: [values.pin] });
      }
    } catch (err) {
      A.toast(err.message, 'err', 6000);
      return;
    }
    A.toast(`${utama.name || values.name} diimport dari ${utama.device_name} dengan PIN ${values.pin}`, 'ok', 6000);
    await A.refresh();
  }

  async function manageDepartments() {
    const render = async (box) => {
      const list = await A.call('departments.list');
      A.$('#deptList', box).innerHTML = list.length
        ? list
            .map(
              (d) => `<div class="live-item">
                <span class="who">${A.esc(d.name)}</span>
                <span class="badge soft">${d.employee_count} karyawan</span>
                <button class="btn-sm" data-dept-edit="${d.id}" data-name="${A.esc(d.name)}">Ubah</button>
                <button class="btn-sm btn-danger" data-dept-del="${d.id}">Hapus</button>
              </div>`
            )
            .join('')
        : '<div class="empty-state"><p class="small">Belum ada departemen.</p></div>';
    };

    await A.modal({
      title: 'Kelola Departemen',
      body: `
        <div style="display:flex;gap:8px;margin-bottom:14px">
          <input id="newDept" placeholder="Nama departemen baru" />
          <button class="btn-primary" id="addDept">Tambah</button>
        </div>
        <div id="deptList" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto"></div>
      `,
      footer: '<button data-close>Tutup</button>',
      onOpen: async (box) => {
        await render(box);

        A.$('#addDept', box).addEventListener('click', async () => {
          const input = A.$('#newDept', box);
          const name = input.value.trim();
          if (!name) return;
          try {
            await A.call('departments.create', { name });
            input.value = '';
            await render(box);
          } catch (err) {
            A.toast(err.message, 'err');
          }
        });

        box.addEventListener('click', async (e) => {
          const edit = e.target.closest('[data-dept-edit]');
          const del = e.target.closest('[data-dept-del]');
          if (edit) {
            const values = await A.formDialog({
              title: 'Ubah Departemen',
              fields: [{ name: 'name', label: 'Nama Departemen', required: true, value: edit.dataset.name }],
            });
            // Dialog anak menutup modal induk, jadi dibuka ulang setelah selesai.
            if (values) {
              await A.callSafe('departments.update', { id: Number(edit.dataset.deptEdit), name: values.name });
            }
            await manageDepartments();
            await A.refresh();
          } else if (del) {
            await A.callSafe('departments.remove', { id: Number(del.dataset.deptDel) });
            await render(box);
          }
        });
      },
    });
    await A.refresh();
  }

  async function importFromDevice() {
    const [devices, depts, shifts] = await Promise.all([
      A.call('devices.list'),
      A.call('departments.list'),
      A.call('shifts.list', { activeOnly: true }),
    ]);
    if (!devices.length) {
      A.toast('Belum ada mesin absensi terdaftar', 'warn');
      return;
    }

    const opts = await A.formDialog({
      title: 'Ambil Karyawan dari Mesin',
      okLabel: 'Ambil Daftar User',
      fields: [
        {
          name: 'deviceId', label: 'Mesin Absensi', type: 'select', required: true,
          options: devices.map((d) => ({ value: d.id, label: `${d.name} (${d.ip})` })),
        },
        {
          name: 'departmentId', label: 'Masukkan ke Departemen', type: 'select',
          options: [{ value: '', label: '— Tidak ada —' }, ...depts.map((d) => ({ value: d.id, label: d.name }))],
        },
        {
          name: 'defaultShiftId', label: 'Shift Bawaan', type: 'select',
          options: [{ value: '', label: '— Ikuti jadwal mingguan —' }, ...shifts.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))],
        },
      ],
    });
    if (!opts) return;

    A.toast('Menghubungi mesin absensi...', 'ok', 2500);
    const res = await A.callSafe('device.syncUsers', { id: Number(opts.deviceId) });
    if (!res || !res.ok) {
      A.toast(res ? res.error : 'Gagal menghubungi mesin', 'err', 6000);
      return;
    }

    const rows = res.users.map((u) => ({ user_pin: u.userId, name: u.name }));
    const existing = await A.call('employees.list', {});
    const existingPins = new Set(existing.map((e) => String(e.pin)));
    const baru = rows.filter((r) => !existingPins.has(String(r.user_pin)));

    if (!baru.length) {
      A.toast(`Mesin punya ${rows.length} user, semuanya sudah terdaftar.`, 'ok');
      return;
    }

    const ok = await A.confirm(
      `Ditemukan ${baru.length} user baru dari total ${rows.length} user di mesin.`,
      {
        title: 'Import Karyawan',
        okLabel: `Import ${baru.length} Karyawan`,
        danger: false,
        detail: baru.slice(0, 12).map((r) => `${r.user_pin} — ${r.name}`).join('\n') + (baru.length > 12 ? `\n… dan ${baru.length - 12} lainnya` : ''),
      }
    );
    if (!ok) return;

    const result = await A.callSafe('employees.importFromDevice', {
      rows: baru,
      departmentId: opts.departmentId ? Number(opts.departmentId) : null,
      defaultShiftId: opts.defaultShiftId ? Number(opts.defaultShiftId) : null,
    });
    if (result) A.toast(`${result.created} karyawan ditambahkan`, 'ok');
    await A.refresh();
  }

  A.registerPage('employees', {
    title: 'Karyawan',
    subtitle: 'Data induk karyawan dan pemetaan PIN mesin absensi',

    async render(root) {
      const [list, depts] = await Promise.all([
        A.call('employees.list', {
          search: state.search,
          departmentId: state.departmentId ? Number(state.departmentId) : null,
          activeOnly: state.activeOnly,
        }),
        A.call('departments.list'),
      ]);

      A.setActions(
        `<button id="btnImport">Import dari Mesin</button>
         <button id="btnDept">Departemen</button>
         <button class="btn-primary" id="btnAdd">+ Tambah Karyawan</button>`,
        {
          '#btnAdd': () => employeeForm(null),
          '#btnDept': () => manageDepartments(),
          '#btnImport': () => importFromDevice(),
        }
      );

      const aktif = list.filter((e) => e.active).length;
      A.setSubtitle(`${list.length} karyawan ditampilkan • ${aktif} aktif`);

      A.prunePicks(pilihan, list.map((e) => e.id));
      const hal = A.paginate('employees', list, {
        resetOn: [state.search, state.departmentId, state.activeOnly],
      });

      root.innerHTML = `
        <div class="toolbar">
          <input class="search" id="q" placeholder="Cari nama, PIN, atau NIP..." value="${A.esc(state.search)}" />
          <select id="dept">
            <option value="">Semua Departemen</option>
            ${depts.map((d) => `<option value="${d.id}"${String(state.departmentId) === String(d.id) ? ' selected' : ''}>${A.esc(d.name)}</option>`).join('')}
          </select>
          <label class="check"><input type="checkbox" id="activeOnly"${state.activeOnly ? ' checked' : ''}> Hanya aktif</label>
        </div>

        <div class="bulk-bar" id="bulkBar" hidden>
          <span class="bulk-count"><strong id="bulkCount">0</strong> karyawan terpilih</span>
          <span class="pick-note" id="pickNote"></span>
          <div class="spacer"></div>
          <button class="btn-sm" data-act="bulkOn">Aktifkan</button>
          <button class="btn-sm" data-act="bulkOff">Nonaktifkan</button>
          <button class="btn-sm btn-danger" data-act="bulkDel">Hapus Terpilih</button>
          <button class="btn-sm btn-ghost" data-act="bulkClear">Batal Pilih</button>
        </div>

        <div class="card">
          <div class="card-body flush">
            ${A.table(
              [
                {
                  labelHtml: '<input type="checkbox" class="pick-all" title="Pilih semua yang tampil">',
                  className: 'c',
                  render: (e) => `<input type="checkbox" class="pick" value="${e.id}"${pilihan.has(e.id) ? ' checked' : ''}>`,
                },
                { label: 'PIN', className: 'c num', render: (e) => `<strong>${A.esc(e.pin)}</strong>` },
                {
                  label: 'Nama Karyawan',
                  render: (e) => `<strong>${A.esc(e.name)}</strong>${e.nip ? `<div class="small muted">NIP ${A.esc(e.nip)}</div>` : ''}`,
                },
                { label: 'Departemen', render: (e) => A.esc(e.department_name || '-') },
                { label: 'Jabatan', render: (e) => A.esc(e.position || '-') },
                {
                  label: 'Kartu RFID', className: 'c num',
                  render: (e) => (e.card ? A.esc(e.card) : '<span class="muted">-</span>'),
                },
                {
                  // Sidik jari yang tersimpan DI APLIKASI, bukan di mesin. Inilah
                  // yang menentukan apakah orang ini bisa dipasang ke mesin baru
                  // tanpa merekam ulang jarinya.
                  label: 'Sidik Jari', className: 'c',
                  render: (e) =>
                    e.finger_count
                      ? `<span class="badge" style="background:#10b981" title="${e.finger_count} sidik jari tersimpan di aplikasi">${e.finger_count}</span>`
                      : '<span class="muted" title="Belum ada sidik jari tersimpan di aplikasi">-</span>',
                },
                {
                  label: 'Sandi Mesin', className: 'c',
                  render: (e) =>
                    e.device_password
                      ? '<span class="badge soft" title="Punya password untuk absen tanpa sidik jari">Ada</span>'
                      : '<span class="muted">-</span>',
                },
                {
                  label: 'Shift Bawaan', className: 'c',
                  render: (e) => (e.default_shift_name ? `<span class="chip">${A.esc(e.default_shift_code)} · ${A.esc(e.default_shift_name)}</span>` : '<span class="muted small">Jadwal mingguan</span>'),
                },
                { label: 'Masuk', className: 'c nowrap', render: (e) => A.esc(e.join_date ? A.fmt.date(e.join_date) : '-') },
                {
                  label: 'Status', className: 'c',
                  render: (e) =>
                    e.active
                      ? '<span class="badge" style="background:#10b981">Aktif</span>'
                      : '<span class="badge soft">Nonaktif</span>',
                },
                {
                  label: '', className: 'r',
                  render: (e) => `<div class="row-actions">
                    <button class="btn-sm" data-act="card" data-id="${e.id}">Kartu</button>
                    <button class="btn-sm" data-act="edit" data-id="${e.id}">Ubah</button>
                    <button class="btn-sm btn-danger" data-act="del" data-id="${e.id}" data-name="${A.esc(e.name)}">Hapus</button>
                  </div>`,
                },
              ],
              hal.rows,
              { empty: 'Belum ada karyawan. Tambah manual atau import dari mesin absensi.' }
            )}
          </div>
          ${hal.controls}
        </div>
      `;

      // ---- filter
      let timer = null;
      A.$('#q', root).addEventListener('input', (e) => {
        clearTimeout(timer);
        state.search = e.target.value;
        timer = setTimeout(() => A.refresh(), 280);
      });
      A.$('#dept', root).addEventListener('change', (e) => {
        state.departmentId = e.target.value;
        A.refresh();
      });
      A.$('#activeOnly', root).addEventListener('change', (e) => {
        state.activeOnly = e.target.checked;
        A.refresh();
      });

      async function ubahAktif(aktif, btn) {
        const ids = terpilih();
        if (!ids.length) return undefined;
        return A.busy(btn, async () => {
          const res = await A.callSafe('employees.setActiveMany', { ids, active: aktif });
          if (res) {
            pilihan.clear();
            A.toast(`${res.changed} karyawan di${aktif ? 'aktifkan' : 'nonaktifkan'}`, 'ok');
          }
          await A.refresh();
        }, 'Menyimpan...');
      }

      // ---- pilihan banyak baris
      // Kotak centang hanya ada untuk halaman yang tampil; pilihan sebenarnya
      // disimpan di `pilihan`, jadi yang dicentang di halaman lain tidak hilang.
      const kotak = () => A.$$('.pick', root);
      const terpilih = () => [...pilihan].map(Number);

      // Baris aksi diperbarui langsung tanpa membangun ulang halaman, supaya
      // centang yang sudah dipasang tidak ikut hilang.
      function segarkanBar() {
        const n = pilihan.size;
        A.$('#bulkCount', root).textContent = n;
        A.$('#bulkBar', root).hidden = n === 0;
        const dicentang = kotak().filter((c) => c.checked).length;
        const semua = A.$('.pick-all', root);
        if (semua) {
          const total = kotak().length;
          semua.checked = total > 0 && dicentang === total;
          semua.indeterminate = dicentang > 0 && dicentang < total;
        }
        // Seluruh halaman ini tercentang, tetapi hasil filter lebih banyak.
        const note = A.$('#pickNote', root);
        note.innerHTML =
          n < list.length && dicentang === kotak().length && dicentang > 0
            ? `<button class="link" data-act="pickAll">Pilih semua ${list.length} hasil filter</button>`
            : n > dicentang
              ? `<span class="muted">(${n - dicentang} di halaman lain)</span>`
              : '';
      }

      kotak().forEach((c) =>
        c.addEventListener('change', () => {
          if (c.checked) pilihan.add(Number(c.value));
          else pilihan.delete(Number(c.value));
          segarkanBar();
        })
      );
      const semuaBox = A.$('.pick-all', root);
      if (semuaBox) {
        semuaBox.addEventListener('change', () => {
          kotak().forEach((c) => {
            c.checked = semuaBox.checked;
            if (c.checked) pilihan.add(Number(c.value));
            else pilihan.delete(Number(c.value));
          });
          segarkanBar();
        });
      }
      segarkanBar();

      A.bindActions(root, {
        pickAll: () => {
          list.forEach((e) => pilihan.add(e.id));
          segarkanBar();
        },
        bulkClear: () => {
          pilihan.clear();
          kotak().forEach((c) => { c.checked = false; });
          segarkanBar();
        },

        bulkOn: (d, btn) => ubahAktif(true, btn),
        bulkOff: (d, btn) => ubahAktif(false, btn),

        bulkDel: async (d, btn) => {
          const ids = terpilih();
          if (!ids.length) return undefined;

          const dampak = await A.callSafe('employees.impact', { ids });
          if (!dampak) return undefined;

          const rincian = [];
          if (dampak.logs) rincian.push(`${dampak.logs.toLocaleString('id-ID')} log absensi tetap tersimpan, tetapi kehilangan kaitan dengan karyawannya`);
          if (dampak.schedules) rincian.push(`${dampak.schedules.toLocaleString('id-ID')} baris jadwal shift ikut TERHAPUS permanen`);
          if (dampak.leaves) rincian.push(`${dampak.leaves.toLocaleString('id-ID')} catatan izin/cuti ikut TERHAPUS permanen`);
          rincian.push('Bila hanya ingin menyembunyikan dari daftar aktif, pakai Nonaktifkan — datanya tetap utuh.');

          const nama = dampak.names.slice(0, 8).join(', ') + (dampak.names.length > 8 ? `, dan ${dampak.names.length - 8} lainnya` : '');
          const ok = await A.confirm(`Hapus ${ids.length} karyawan: ${nama}?`, {
            title: 'Hapus Karyawan Terpilih',
            okLabel: `Hapus ${ids.length} Karyawan`,
            detail: rincian.join('\n'),
          });
          if (!ok) return undefined;

          return A.busy(btn, async () => {
            const res = await A.callSafe('employees.removeMany', { ids });
            if (res) {
              pilihan.clear();
              A.toast(`${res.removed} karyawan dihapus`, 'ok');
            }
            await A.refresh();
          }, 'Menghapus...');
        },

        edit: async (d) => {
          const emp = await A.call('employees.find', { id: Number(d.id) });
          await employeeForm(emp);
        },
        del: async (d) => {
          const ok = await A.confirm(`Hapus karyawan "${d.name}"?`, {
            okLabel: 'Hapus',
            detail: 'Log absensi yang sudah tersimpan tidak ikut terhapus, tetapi kehilangan kaitan dengan karyawan ini.',
          });
          if (!ok) return;
          await A.callSafe('employees.remove', { id: Number(d.id) });
          A.toast('Karyawan dihapus', 'ok');
          await A.refresh();
        },
        card: async (d) => {
          const values = await A.formDialog({
            title: 'Cetak Kartu Absensi',
            okLabel: 'Buat PDF',
            fields: [{ name: 'month', label: 'Periode', type: 'month', required: true, value: A.fmt.currentMonth() }],
          });
          if (!values) return;
          const res = await A.callSafe('export.employeeCardPdf', {
            employeeId: Number(d.id),
            month: values.month,
          });
          if (res && res.ok) {
            A.toast('Kartu absensi tersimpan', 'ok');
            await A.callSafe('file.open', { filePath: res.filePath });
          }
        },
      });
    },
  });
})();
