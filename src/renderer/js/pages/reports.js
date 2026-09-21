'use strict';

(function () {
  const A = window.App;
  const state = { mode: 'bulanan', month: null, date: null, departmentId: '', search: '' };

  function statusBadge(r) {
    return `<span class="badge" style="background:${A.esc(r.status_color)}">${A.esc(r.status_label)}</span>`;
  }

  async function renderMonthly(root, depts) {
    const data = await A.call('reports.monthly', {
      month: state.month,
      departmentId: state.departmentId ? Number(state.departmentId) : null,
      search: state.search,
    });

    A.setSubtitle(`Periode ${A.fmt.monthLabel(state.month)} • ${data.summary.length} karyawan`);
    A.setActions(
      `<button id="btnExcel">Export Excel</button>
       <button id="btnPdf">Cetak PDF</button>`,
      {
        '#btnExcel': async (e) => {
          await A.busy(e.currentTarget, async () => {
            const res = await A.callSafe('export.monthlyExcel', exportParams());
            if (res && res.ok) {
              A.toast('Rekap Excel tersimpan', 'ok');
              await A.callSafe('file.open', { filePath: res.filePath });
            }
          }, 'Menyusun...');
        },
        '#btnPdf': async (e) => {
          await A.busy(e.currentTarget, async () => {
            const res = await A.callSafe('export.monthlyPdf', exportParams());
            if (res && res.ok) {
              A.toast('Rekap PDF tersimpan', 'ok');
              await A.callSafe('file.open', { filePath: res.filePath });
            }
          }, 'Menyusun...');
        },
      }
    );

    const totals = data.summary.reduce(
      (acc, s) => {
        acc.hadir += s.hadir;
        acc.terlambat += s.terlambat;
        acc.alpha += s.alpha;
        acc.late += s.late_minutes;
        acc.overtime += s.overtime_minutes;
        acc.izin += s.cuti + s.sakit + s.izin + s.dinas_luar + s.izin_lain;
        return acc;
      },
      { hadir: 0, terlambat: 0, alpha: 0, late: 0, overtime: 0, izin: 0 }
    );

    root.innerHTML = `
      ${filterBar(depts)}
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat green"><span class="label">Total Kehadiran</span><span class="value num">${totals.hadir}</span><span class="hint">hari-orang</span></div>
        <div class="stat amber"><span class="label">Total Keterlambatan</span><span class="value num">${totals.terlambat}</span><span class="hint">${A.fmt.duration(totals.late)} akumulasi telat</span></div>
        <div class="stat red"><span class="label">Total Alpha</span><span class="value num">${totals.alpha}</span><span class="hint">tanpa keterangan</span></div>
        <div class="stat violet"><span class="label">Total Lembur</span><span class="value num" style="font-size:22px">${A.fmt.duration(totals.overtime)}</span><span class="hint">${totals.izin} hari izin/cuti</span></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h3>Rekap per Karyawan</h3><div class="sub">Klik baris untuk melihat rincian harian</div></div>
        </div>
        <div class="card-body flush">
          ${A.table(
            [
              { label: 'PIN', className: 'c num', render: (s) => A.esc(s.pin) },
              { label: 'Nama Karyawan', render: (s) => `<strong>${A.esc(s.employee_name)}</strong><div class="small muted">${A.esc(s.department_name || '-')}</div>` },
              { label: 'Hadir', className: 'c num', render: (s) => `<strong>${s.hadir}</strong>` },
              { label: 'Telat', className: 'c num', render: (s) => (s.terlambat ? `<span style="color:#b45309;font-weight:600">${s.terlambat}</span>` : '0') },
              { label: 'Tdk Lengkap', className: 'c num', render: (s) => s.tidak_lengkap || 0 },
              { label: 'Alpha', className: 'c num', render: (s) => (s.alpha ? `<span style="color:#dc2626;font-weight:600">${s.alpha}</span>` : '0') },
              { label: 'Cuti', className: 'c num', render: (s) => s.cuti },
              { label: 'Sakit', className: 'c num', render: (s) => s.sakit },
              { label: 'Izin', className: 'c num', render: (s) => s.izin },
              { label: 'Dinas', className: 'c num', render: (s) => s.dinas_luar },
              { label: 'Libur', className: 'c num', render: (s) => s.libur },
              { label: 'Total Telat', className: 'c num nowrap', render: (s) => A.fmt.duration(s.late_minutes) },
              { label: 'Jam Kerja', className: 'c num nowrap', render: (s) => A.fmt.duration(s.work_minutes) },
              { label: 'Lembur', className: 'c num nowrap', render: (s) => A.fmt.duration(s.overtime_minutes) },
              {
                label: '', className: 'r',
                render: (s) => `<button class="btn-sm" data-act="detail" data-id="${s.employee_id}" data-name="${A.esc(s.employee_name)}">Rincian</button>`,
              },
            ],
            data.summary,
            { empty: 'Tidak ada data pada periode ini.' }
          )}
        </div>
      </div>
    `;
    return data;
  }

  async function renderDaily(root, depts) {
    const rows = await A.call('reports.daily', {
      date: state.date,
      departmentId: state.departmentId ? Number(state.departmentId) : null,
      search: state.search,
    });

    A.setSubtitle(`${A.fmt.dayName(state.date)}, ${A.fmt.dateLong(state.date)} • ${rows.length} karyawan`);
    A.setActions(
      `<button id="btnExcel">Export Excel</button><button id="btnPdf">Cetak PDF</button>`,
      {
        '#btnExcel': async (e) => {
          await A.busy(e.currentTarget, async () => {
            const res = await A.callSafe('export.dailyExcel', exportParams());
            if (res && res.ok) {
              A.toast('Rekap harian tersimpan', 'ok');
              await A.callSafe('file.open', { filePath: res.filePath });
            }
          }, 'Menyusun...');
        },
        '#btnPdf': async (e) => {
          await A.busy(e.currentTarget, async () => {
            const res = await A.callSafe('export.dailyPdf', exportParams());
            if (res && res.ok) {
              A.toast('Rekap harian tersimpan', 'ok');
              await A.callSafe('file.open', { filePath: res.filePath });
            }
          }, 'Menyusun...');
        },
      }
    );

    const count = (code) => rows.filter((r) => r.status === code).length;

    root.innerHTML = `
      ${filterBar(depts)}
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat green"><span class="label">Hadir</span><span class="value num">${count('H') + count('T')}</span><span class="hint">${count('T')} di antaranya terlambat</span></div>
        <div class="stat amber"><span class="label">Tidak Lengkap</span><span class="value num">${count('TL')}</span><span class="hint">hanya scan sekali</span></div>
        <div class="stat red"><span class="label">Alpha</span><span class="value num">${count('A')}</span><span class="hint">tanpa keterangan</span></div>
        <div class="stat slate"><span class="label">Libur</span><span class="value num">${count('L') + count('LN')}</span><span class="hint">sesuai jadwal shift</span></div>
      </div>

      <div class="card">
        <div class="card-body flush">
          ${A.table(
            [
              { label: 'PIN', className: 'c num', render: (r) => A.esc(r.pin) },
              { label: 'Nama Karyawan', render: (r) => `<strong>${A.esc(r.employee_name)}</strong><div class="small muted">${A.esc(r.department_name || '-')}</div>` },
              { label: 'Shift', className: 'c', render: (r) => (r.shift_name ? `<span class="chip">${A.esc(r.shift_code)} · ${A.esc(r.shift_name)}</span>` : '<span class="muted">-</span>') },
              { label: 'Jam Kerja', className: 'c nowrap num', render: (r) => A.esc(r.shift_time || '-') },
              { label: 'Masuk', className: 'c num', render: (r) => (r.check_in ? `<strong>${A.esc(r.check_in)}</strong>` : '<span class="muted">-</span>') },
              { label: 'Pulang', className: 'c num', render: (r) => (r.check_out ? `<strong>${A.esc(r.check_out)}</strong>` : '<span class="muted">-</span>') },
              { label: 'Telat', className: 'c num', render: (r) => (r.late_minutes ? `<span style="color:#b45309;font-weight:600">${r.late_minutes} m</span>` : '-') },
              { label: 'Plg Cepat', className: 'c num', render: (r) => (r.early_minutes ? `${r.early_minutes} m` : '-') },
              { label: 'Jam Kerja', className: 'c num nowrap', render: (r) => A.fmt.duration(r.work_minutes) },
              { label: 'Lembur', className: 'c num nowrap', render: (r) => A.fmt.duration(r.overtime_minutes) },
              { label: 'Status', className: 'c', render: statusBadge },
            ],
            rows,
            { empty: 'Tidak ada data pada tanggal ini.' }
          )}
        </div>
      </div>
    `;
  }

  async function showDetail(employeeId, name) {
    const b = monthBounds(state.month);
    const { rows, summary } = await A.call('reports.employeeCard', {
      employeeId,
      from: b.start,
      to: b.end,
    });

    await A.modal({
      title: `Rincian Absensi — ${name}`,
      wide: true,
      body: `
        <div class="pill-row" style="margin-bottom:14px">
          <span class="chip">Hadir <strong>${summary ? summary.hadir : 0}</strong></span>
          <span class="chip">Terlambat <strong>${summary ? summary.terlambat : 0}</strong></span>
          <span class="chip">Alpha <strong>${summary ? summary.alpha : 0}</strong></span>
          <span class="chip">Total telat <strong>${A.fmt.duration(summary ? summary.late_minutes : 0)}</strong></span>
          <span class="chip">Lembur <strong>${A.fmt.duration(summary ? summary.overtime_minutes : 0)}</strong></span>
        </div>
        <div style="max-height:52vh;overflow:auto">
          ${A.table(
            [
              { label: 'Tanggal', className: 'nowrap', render: (r) => `${A.esc(A.fmt.date(r.date))} <span class="muted small">${A.esc(A.fmt.dayName(r.date))}</span>` },
              { label: 'Shift', className: 'c', render: (r) => A.esc(r.shift_name || '-') },
              { label: 'Jadwal', className: 'c nowrap num', render: (r) => A.esc(r.shift_time || '-') },
              { label: 'Masuk', className: 'c num', render: (r) => A.esc(r.check_in || '-') },
              { label: 'Pulang', className: 'c num', render: (r) => A.esc(r.check_out || '-') },
              { label: 'Telat', className: 'c num', render: (r) => (r.late_minutes ? `${r.late_minutes} m` : '-') },
              { label: 'Lembur', className: 'c num', render: (r) => A.fmt.duration(r.overtime_minutes) },
              { label: 'Status', className: 'c', render: statusBadge },
            ],
            rows
          )}
        </div>
      `,
      footer: '<button data-close>Tutup</button><button class="btn-primary" data-pdf>Cetak Kartu PDF</button>',
      onOpen: (box) => {
        A.$('[data-pdf]', box).addEventListener('click', async () => {
          const res = await A.callSafe('export.employeeCardPdf', { employeeId, month: state.month });
          if (res && res.ok) {
            A.toast('Kartu absensi tersimpan', 'ok');
            await A.callSafe('file.open', { filePath: res.filePath });
          }
        });
      },
    });
  }

  function monthBounds(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const p = (n) => String(n).padStart(2, '0');
    return { start: `${y}-${p(m)}-01`, end: `${y}-${p(m)}-${p(last)}` };
  }

  function exportParams() {
    const base = {
      departmentId: state.departmentId ? Number(state.departmentId) : null,
      search: state.search,
    };
    return state.mode === 'bulanan' ? { ...base, month: state.month } : { ...base, date: state.date };
  }

  function filterBar(depts) {
    return `<div class="toolbar">
      <select id="mode" style="width:auto">
        <option value="bulanan"${state.mode === 'bulanan' ? ' selected' : ''}>Rekap Bulanan</option>
        <option value="harian"${state.mode === 'harian' ? ' selected' : ''}>Rekap Harian</option>
      </select>
      ${
        state.mode === 'bulanan'
          ? `<input type="month" id="month" value="${A.esc(state.month)}" style="width:auto" />`
          : `<input type="date" id="date" value="${A.esc(state.date)}" style="width:auto" />`
      }
      <select id="dept">
        <option value="">Semua Departemen</option>
        ${depts.map((d) => `<option value="${d.id}"${String(state.departmentId) === String(d.id) ? ' selected' : ''}>${A.esc(d.name)}</option>`).join('')}
      </select>
      <input class="search" id="q" placeholder="Cari karyawan..." value="${A.esc(state.search)}" />
    </div>`;
  }

  A.registerPage('reports', {
    title: 'Rekap Absensi',
    subtitle: '',

    async render(root) {
      if (!state.month) state.month = A.fmt.currentMonth();
      if (!state.date) state.date = A.fmt.today();

      const depts = await A.call('departments.list');
      if (state.mode === 'bulanan') await renderMonthly(root, depts);
      else await renderDaily(root, depts);

      A.$('#mode', root).addEventListener('change', (e) => {
        state.mode = e.target.value;
        A.refresh();
      });
      const monthEl = A.$('#month', root);
      if (monthEl) {
        monthEl.addEventListener('change', (e) => {
          state.month = e.target.value;
          A.refresh();
        });
      }
      const dateEl = A.$('#date', root);
      if (dateEl) {
        dateEl.addEventListener('change', (e) => {
          state.date = e.target.value;
          A.refresh();
        });
      }
      A.$('#dept', root).addEventListener('change', (e) => {
        state.departmentId = e.target.value;
        A.refresh();
      });
      let timer = null;
      A.$('#q', root).addEventListener('input', (e) => {
        clearTimeout(timer);
        state.search = e.target.value;
        timer = setTimeout(() => A.refresh(), 300);
      });

      A.bindActions(root, {
        detail: (d) => showDetail(Number(d.id), d.name),
      });
    },
  });
})();
