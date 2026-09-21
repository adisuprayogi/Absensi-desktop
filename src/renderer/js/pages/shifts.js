'use strict';

(function () {
  const A = window.App;

  async function shiftForm(existing) {
    const values = await A.formDialog({
      title: existing ? `Ubah Shift — ${existing.name}` : 'Tambah Shift',
      okLabel: existing ? 'Simpan Perubahan' : 'Tambah',
      wide: true,
      fields: [
        {
          name: 'code', label: 'Kode Shift', required: true, row: 'a',
          value: existing ? existing.code : '',
          hint: 'Singkat, mis. P / S / M',
          attrs: 'maxlength="8" style="text-transform:uppercase"',
        },
        { name: 'name', label: 'Nama Shift', required: true, row: 'a', value: existing ? existing.name : '' },
        {
          name: 'start_time', label: 'Jam Masuk', type: 'time', required: true, row: 'b',
          value: existing ? existing.start_time : '08:00',
        },
        {
          name: 'end_time', label: 'Jam Pulang', type: 'time', required: true, row: 'b',
          value: existing ? existing.end_time : '17:00',
          hint: 'Jam pulang lebih kecil dari jam masuk = shift malam lintas hari',
        },
        {
          name: 'break_minutes', label: 'Istirahat (menit)', type: 'number', row: 'c',
          value: existing ? existing.break_minutes : 60,
          attrs: 'min="0" max="480"',
          hint: 'Dipotong dari total jam kerja',
        },
        {
          name: 'late_tolerance', label: 'Toleransi Telat (menit)', type: 'number', row: 'c',
          value: existing ? existing.late_tolerance : 0,
          attrs: 'min="0" max="240"',
        },
        {
          name: 'early_tolerance', label: 'Toleransi Pulang Cepat (menit)', type: 'number', row: 'd',
          value: existing ? existing.early_tolerance : 0,
          attrs: 'min="0" max="240"',
        },
        {
          name: 'overtime_after', label: 'Lembur Dihitung Setelah (menit)', type: 'number', row: 'd',
          value: existing ? existing.overtime_after : 30,
          attrs: 'min="0" max="480"',
          hint: 'Lewat jam pulang sekian menit baru dihitung lembur',
        },
        {
          name: 'color', label: 'Warna di Tabel Jadwal', type: 'color', row: 'e',
          value: existing ? existing.color || '#4f7cff' : '#4f7cff',
        },
        {
          name: 'min_work_minutes', label: 'Minimum Jam Kerja (menit)', type: 'number', row: 'e',
          value: existing ? existing.min_work_minutes : 0,
          attrs: 'min="0"',
        },
        {
          name: 'is_off', label: 'Shift ini adalah hari libur', type: 'checkbox',
          value: existing ? existing.is_off : 0,
          hint: 'Karyawan tidak dianggap alpha bila tidak absen',
        },
        { name: 'active', label: 'Shift aktif', type: 'checkbox', value: existing ? existing.active : 1 },
      ],
    });
    if (!values) return;

    if (existing) await A.call('shifts.update', { id: existing.id, ...values });
    else await A.call('shifts.create', values);
    A.toast(existing ? 'Shift diperbarui' : 'Shift ditambahkan', 'ok');
    await A.refresh();
  }

  /** Durasi shift dalam menit, memperhitungkan lintas hari. */
  function shiftDuration(s) {
    const toMin = (t) => {
      const [h, m] = String(t).split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    let dur = toMin(s.end_time) - toMin(s.start_time);
    if (dur <= 0) dur += 1440;
    return dur;
  }

  async function weeklyDefaults() {
    const [shifts, current] = await Promise.all([
      A.call('shifts.list', { activeOnly: true }),
      A.call('defaultSchedule.list'),
    ]);
    const names = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const byDow = new Map(current.map((r) => [r.dow, r.shift_id]));

    const values = await A.formDialog({
      title: 'Jadwal Mingguan Bawaan',
      okLabel: 'Simpan',
      wide: true,
      fields: names.map((n, dow) => ({
        name: `dow_${dow}`,
        label: n,
        type: 'select',
        row: dow < 4 ? 'x' : 'y',
        value: byDow.get(dow) || '',
        options: [
          { value: '', label: '— Tidak dijadwalkan —' },
          ...shifts.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })),
        ],
      })),
    });
    if (!values) return;

    for (let dow = 0; dow <= 6; dow++) {
      const v = values[`dow_${dow}`];
      await A.callSafe('defaultSchedule.set', { dow, shiftId: v ? Number(v) : null });
    }
    A.toast('Jadwal mingguan bawaan disimpan', 'ok');
    await A.refresh();
  }

  A.registerPage('shifts', {
    title: 'Shift Kerja',
    subtitle: 'Definisi jam kerja, toleransi keterlambatan, dan aturan lembur',

    async render(root) {
      const [list, weekly] = await Promise.all([
        A.call('shifts.list'),
        A.call('defaultSchedule.list'),
      ]);

      A.setActions(
        `<button id="btnWeekly">Jadwal Mingguan Bawaan</button>
         <button class="btn-primary" id="btnAdd">+ Tambah Shift</button>`,
        { '#btnAdd': () => shiftForm(null), '#btnWeekly': () => weeklyDefaults() }
      );

      const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

      root.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Jadwal Mingguan Bawaan</h3>
              <div class="sub">Dipakai bila karyawan tidak punya shift bawaan dan tidak ada jadwal khusus</div>
            </div>
            <button class="btn-sm" data-act="weekly">Ubah</button>
          </div>
          <div class="card-body">
            <div class="pill-row">
              ${weekly
                .map(
                  (w) => `<span class="chip">
                    <strong>${A.esc(dayNames[w.dow])}</strong>
                    ${w.shift_name ? `<span>${A.esc(w.shift_code)} · ${A.esc(w.shift_name)}</span>` : '<span class="muted">tidak dijadwalkan</span>'}
                  </span>`
                )
                .join('')}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-body flush">
            ${A.table(
              [
                {
                  label: 'Kode', className: 'c',
                  render: (s) => `<span class="badge" style="background:${A.esc(s.color || '#4f7cff')}">${A.esc(s.code)}</span>`,
                },
                {
                  label: 'Nama Shift',
                  render: (s) => `<strong>${A.esc(s.name)}</strong>${s.is_off ? ' <span class="badge soft">Libur</span>' : ''}`,
                },
                {
                  label: 'Jam Kerja', className: 'c nowrap num',
                  render: (s) =>
                    s.is_off
                      ? '<span class="muted">-</span>'
                      : `${A.esc(s.start_time)} – ${A.esc(s.end_time)}${s.end_time <= s.start_time ? ' <span class="badge soft">+1 hari</span>' : ''}`,
                },
                {
                  label: 'Durasi', className: 'c num',
                  render: (s) => (s.is_off ? '-' : A.fmt.duration(shiftDuration(s) - (s.break_minutes || 0))),
                },
                { label: 'Istirahat', className: 'c num', render: (s) => (s.break_minutes ? `${s.break_minutes} m` : '-') },
                { label: 'Toleransi Telat', className: 'c num', render: (s) => (s.late_tolerance ? `${s.late_tolerance} m` : '-') },
                { label: 'Lembur Setelah', className: 'c num', render: (s) => (s.is_off ? '-' : `${s.overtime_after} m`) },
                {
                  label: 'Status', className: 'c',
                  render: (s) => (s.active ? '<span class="badge" style="background:#10b981">Aktif</span>' : '<span class="badge soft">Nonaktif</span>'),
                },
                {
                  label: '', className: 'r',
                  render: (s) => `<div class="row-actions">
                    <button class="btn-sm" data-act="edit" data-id="${s.id}">Ubah</button>
                    <button class="btn-sm btn-danger" data-act="del" data-id="${s.id}" data-name="${A.esc(s.name)}">Hapus</button>
                  </div>`,
                },
              ],
              list,
              { empty: 'Belum ada shift.' }
            )}
          </div>
        </div>
      `;

      A.bindActions(root, {
        weekly: () => weeklyDefaults(),
        edit: async (d) => {
          const s = list.find((x) => String(x.id) === String(d.id));
          await shiftForm(s);
        },
        del: async (d) => {
          const ok = await A.confirm(`Hapus shift "${d.name}"?`, {
            okLabel: 'Hapus',
            detail: 'Jadwal yang memakai shift ini akan ikut terhapus dan karyawan kembali mengikuti jadwal mingguan bawaan.',
          });
          if (!ok) return;
          await A.callSafe('shifts.remove', { id: Number(d.id) });
          A.toast('Shift dihapus', 'ok');
          await A.refresh();
        },
      });
    },
  });
})();
