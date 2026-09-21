'use strict';

(function () {
  const A = window.App;
  const state = { from: null, to: null, deviceId: '', search: '', unknownOnly: false, page: 0 };
  const PAGE_SIZE = 200;

  async function manualForm() {
    const employees = await A.call('employees.list', { activeOnly: true });
    if (!employees.length) {
      A.toast('Belum ada karyawan aktif', 'warn');
      return;
    }
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');

    const values = await A.formDialog({
      title: 'Tambah Scan Manual',
      okLabel: 'Simpan',
      fields: [
        {
          name: 'employeeId', label: 'Karyawan', type: 'select', required: true,
          options: employees.map((e) => ({ value: e.id, label: `${e.name} (PIN ${e.pin})` })),
        },
        { name: 'date', label: 'Tanggal', type: 'date', required: true, row: 'a', value: A.fmt.today() },
        {
          name: 'time', label: 'Jam', type: 'time', required: true, row: 'a',
          value: `${p(now.getHours())}:${p(now.getMinutes())}`,
          attrs: 'step="1"',
        },
        {
          name: 'note', label: 'Alasan Koreksi', value: '',
          hint: 'Mis. lupa absen, mesin error — tersimpan sebagai penanda sumber data',
        },
      ],
    });
    if (!values) return;

    const time = values.time.length === 5 ? `${values.time}:00` : values.time;
    const res = await A.callSafe('attendance.addManual', {
      employeeId: Number(values.employeeId),
      ts: `${values.date} ${time}`,
      note: values.note,
    });
    if (res) {
      A.toast('Scan manual ditambahkan', 'ok');
      await A.refresh();
    }
  }

  async function showUnknown() {
    const rows = await A.call('attendance.unknownPins');
    await A.modal({
      title: 'PIN Belum Terdaftar',
      wide: true,
      body: rows.length
        ? `<p class="small muted" style="margin:0 0 12px">
             PIN berikut ada di log mesin tetapi belum punya data karyawan. Tambahkan karyawan
             dengan PIN yang sama agar log ini masuk ke rekap.
           </p>${A.table(
             [
               { label: 'PIN', className: 'c num', render: (r) => `<strong>${A.esc(r.user_pin)}</strong>` },
               { label: 'Jumlah Scan', className: 'c num', render: (r) => r.scans },
               { label: 'Pertama', className: 'nowrap', render: (r) => A.esc(A.fmt.dateTime(r.first_seen)) },
               { label: 'Terakhir', className: 'nowrap', render: (r) => A.esc(A.fmt.dateTime(r.last_seen)) },
             ],
             rows
           )}`
        : A.emptyState('Semua PIN sudah terdaftar', 'Tidak ada log yang menggantung tanpa karyawan.', '✓'),
      footer: `<button data-close>Tutup</button>${rows.length ? '<button class="btn-primary" data-goto>Ke Halaman Karyawan</button>' : ''}`,
      onOpen: (box) => {
        const btn = A.$('[data-goto]', box);
        if (btn) {
          btn.addEventListener('click', () => {
            A.closeModal(null);
            A.go('employees');
          });
        }
      },
    });
  }

  A.registerPage('logs', {
    title: 'Log Scan',
    subtitle: 'Data mentah setiap tap di mesin absensi',

    async render(root) {
      if (!state.from) {
        const d = new Date();
        d.setDate(d.getDate() - 6);
        const p = (n) => String(n).padStart(2, '0');
        state.from = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        state.to = A.fmt.today();
      }

      const [data, devices, stats] = await Promise.all([
        A.call('attendance.list', {
          from: state.from,
          to: state.to,
          deviceId: state.deviceId ? Number(state.deviceId) : null,
          search: state.search,
          unknownOnly: state.unknownOnly,
          limit: PAGE_SIZE,
          offset: state.page * PAGE_SIZE,
        }),
        A.call('devices.list'),
        A.call('attendance.stats'),
      ]);

      A.setActions(
        `<button id="btnUnknown">PIN Belum Terdaftar${stats.unknown ? ` (${stats.unknown})` : ''}</button>
         <button id="btnExport">Export Excel</button>
         <button class="btn-primary" id="btnManual">+ Scan Manual</button>`,
        {
          '#btnManual': () => manualForm(),
          '#btnUnknown': () => showUnknown(),
          '#btnExport': async () => {
            const res = await A.callSafe('export.logsExcel', {
              from: state.from,
              to: state.to,
              deviceId: state.deviceId ? Number(state.deviceId) : null,
              search: state.search,
              unknownOnly: state.unknownOnly,
            });
            if (res && res.ok) {
              A.toast(`${res.rows} baris diekspor`, 'ok');
              await A.callSafe('file.open', { filePath: res.filePath });
            }
          },
        }
      );

      A.setSubtitle(
        `${data.total.toLocaleString('id-ID')} log pada rentang ini • total ${stats.total.toLocaleString('id-ID')} log tersimpan`
      );

      const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

      root.innerHTML = `
        <div class="toolbar">
          <input type="date" id="from" value="${A.esc(state.from)}" style="width:auto" />
          <span class="muted small">s/d</span>
          <input type="date" id="to" value="${A.esc(state.to)}" style="width:auto" />
          <select id="device">
            <option value="">Semua Mesin</option>
            ${devices.map((d) => `<option value="${d.id}"${String(state.deviceId) === String(d.id) ? ' selected' : ''}>${A.esc(d.name)}</option>`).join('')}
          </select>
          <input class="search" id="q" placeholder="Cari nama atau PIN..." value="${A.esc(state.search)}" />
          <label class="check"><input type="checkbox" id="unknownOnly"${state.unknownOnly ? ' checked' : ''}> Hanya PIN tak dikenal</label>
        </div>

        <div class="card">
          <div class="card-body flush">
            ${A.table(
              [
                { label: 'Waktu', className: 'nowrap num', render: (r) => `<strong>${A.esc(String(r.ts).slice(11, 19))}</strong> <span class="muted small">${A.esc(A.fmt.date(r.ts))}</span>` },
                { label: 'Hari', className: 'c', render: (r) => A.esc(A.fmt.dayName(r.ts)) },
                { label: 'PIN', className: 'c num', render: (r) => A.esc(r.user_pin) },
                {
                  label: 'Karyawan',
                  render: (r) =>
                    r.employee_name
                      ? `<strong>${A.esc(r.employee_name)}</strong>`
                      : '<span style="color:#b45309">Belum terdaftar</span>',
                },
                { label: 'Mesin', render: (r) => A.esc(r.device_name || '-') },
                { label: 'Verifikasi', className: 'c', render: (r) => `<span class="badge soft">${A.esc(r.verify_label)}</span>` },
                {
                  label: 'Sumber', className: 'c',
                  render: (r) =>
                    r.source === 'realtime'
                      ? '<span class="badge" style="background:#10b981">Realtime</span>'
                      : String(r.source).startsWith('manual')
                        ? '<span class="badge" style="background:#8b5cf6">Manual</span>'
                        : '<span class="badge soft">Tarik</span>',
                },
                {
                  label: '', className: 'r',
                  render: (r) => `<button class="btn-sm btn-danger" data-act="del" data-id="${r.id}">Hapus</button>`,
                },
              ],
              data.rows,
              { empty: 'Tidak ada log pada rentang ini. Tarik data dari mesin absensi lebih dulu.' }
            )}
          </div>
          ${
            totalPages > 1
              ? `<div class="card-head" style="border-top:1px solid var(--border);border-bottom:0;justify-content:space-between">
                  <span class="small muted">Halaman ${state.page + 1} dari ${totalPages}</span>
                  <div class="pill-row">
                    <button class="btn-sm" data-act="prev"${state.page === 0 ? ' disabled' : ''}>‹ Sebelumnya</button>
                    <button class="btn-sm" data-act="next"${state.page >= totalPages - 1 ? ' disabled' : ''}>Berikutnya ›</button>
                  </div>
                </div>`
              : ''
          }
        </div>
      `;

      const reset = () => {
        state.page = 0;
        A.refresh();
      };
      A.$('#from', root).addEventListener('change', (e) => {
        state.from = e.target.value;
        reset();
      });
      A.$('#to', root).addEventListener('change', (e) => {
        state.to = e.target.value;
        reset();
      });
      A.$('#device', root).addEventListener('change', (e) => {
        state.deviceId = e.target.value;
        reset();
      });
      A.$('#unknownOnly', root).addEventListener('change', (e) => {
        state.unknownOnly = e.target.checked;
        reset();
      });
      let timer = null;
      A.$('#q', root).addEventListener('input', (e) => {
        clearTimeout(timer);
        state.search = e.target.value;
        timer = setTimeout(reset, 300);
      });

      A.bindActions(root, {
        prev: () => {
          state.page = Math.max(0, state.page - 1);
          A.refresh();
        },
        next: () => {
          state.page += 1;
          A.refresh();
        },
        del: async (d) => {
          const ok = await A.confirm('Hapus log scan ini?', { okLabel: 'Hapus' });
          if (!ok) return;
          await A.callSafe('attendance.remove', { id: Number(d.id) });
          await A.refresh();
        },
      });
    },
  });
})();
