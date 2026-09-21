'use strict';

(function () {
  const A = window.App;
  const state = { month: null, departmentId: '', search: '' };
  let shiftCache = [];

  /** Warna teks yang kontras di atas warna latar shift. */
  function textOn(hex) {
    const c = String(hex || '#ffffff').replace('#', '');
    if (c.length < 6) return '#0f172a';
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#0f172a' : '#ffffff';
  }

  async function pickShift(employeeName, date, current) {
    const options = [
      { value: '', label: '— Ikuti jadwal bawaan —' },
      ...shiftCache.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}${s.is_off ? '' : ` (${s.start_time}-${s.end_time})`}` })),
    ];
    return A.formDialog({
      title: `Jadwal ${employeeName}`,
      okLabel: 'Simpan',
      fields: [
        {
          name: 'shiftId', label: `Shift untuk ${A.fmt.dayName(date)}, ${A.fmt.dateLong(date)}`,
          type: 'select', value: current || '', options,
        },
      ],
    });
  }

  async function generateDialog() {
    const [employees, depts] = await Promise.all([
      A.call('employees.list', { activeOnly: true }),
      A.call('departments.list'),
    ]);
    if (!employees.length) {
      A.toast('Belum ada karyawan aktif', 'warn');
      return;
    }

    const shiftOptions = [
      { value: '', label: '— Libur —' },
      ...shiftCache.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })),
    ];
    const bounds = monthBounds(state.month);

    const values = await A.modal({
      title: 'Buat Jadwal Massal',
      wide: true,
      body: `
        <div class="field-row">
          <div class="field">
            <label>Dari Tanggal *</label>
            <input type="date" name="from" value="${bounds.start}" required />
          </div>
          <div class="field">
            <label>Sampai Tanggal *</label>
            <input type="date" name="to" value="${bounds.end}" required />
          </div>
        </div>

        <div class="field">
          <label>Pola Shift Berulang</label>
          <div class="hint" style="margin:0 0 8px">
            Pola diulang terus sepanjang rentang tanggal. Contoh 5 hari kerja + 2 libur:
            isi 7 baris dengan 5 shift kerja lalu 2 libur.
          </div>
          <div id="patternRows"></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button type="button" class="btn-sm" id="addRow">+ Tambah Hari</button>
            <button type="button" class="btn-sm" id="preset57">Preset 5 Kerja + 2 Libur</button>
            <button type="button" class="btn-sm" id="preset3">Preset Rotasi P-S-M</button>
          </div>
        </div>

        <div class="field">
          <label>Karyawan *</label>
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <select id="filterDept" style="flex:1">
              <option value="">Semua Departemen</option>
              ${depts.map((d) => `<option value="${d.id}">${A.esc(d.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn-sm" id="selectAll">Pilih Semua</button>
            <button type="button" class="btn-sm" id="selectNone">Kosongkan</button>
          </div>
          <div id="empList" style="border:1px solid var(--border);border-radius:8px;max-height:220px;overflow-y:auto;padding:8px"></div>
        </div>

        <div class="field">
          <label>Shift Bergilir</label>
          <label class="check" style="margin-bottom:6px">
            <input type="checkbox" id="stagger"> Setiap karyawan mulai dari titik pola yang berbeda
          </label>
          <div class="hint" style="margin:0 0 8px">
            Untuk satpam dan operator pabrik: satu pola yang sama dipakai semua orang,
            tetapi tiap orang digeser satu hari dari orang sebelumnya, sehingga
            setiap shift selalu ada yang menjaga.
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="small muted" style="white-space:nowrap">Geser titik awal pola</span>
            <input type="number" id="offset" value="0" min="0" style="width:90px" />
            <span class="small muted">hari</span>
          </div>
        </div>

        <label class="check" style="margin-bottom:8px"><input type="checkbox" id="skipHolidays" checked> Jadikan libur pada tanggal libur nasional</label>
        <label class="check"><input type="checkbox" id="overwrite" checked> Timpa jadwal yang sudah ada</label>
      `,
      footer: '<button data-close>Batal</button><button class="btn-primary" data-ok>Buat Jadwal</button>',
      onOpen: (box) => {
        const rowsEl = A.$('#patternRows', box);

        const addRow = (value = '') => {
          const idx = rowsEl.children.length + 1;
          const div = document.createElement('div');
          div.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
          div.innerHTML = `
            <span class="muted small" style="width:58px">Hari ${idx}</span>
            <select class="pat" style="flex:1">${shiftOptions
              .map((o) => `<option value="${o.value}"${String(o.value) === String(value) ? ' selected' : ''}>${A.esc(o.label)}</option>`)
              .join('')}</select>
            <button type="button" class="btn-sm btn-ghost" data-remove>✕</button>`;
          div.querySelector('[data-remove]').addEventListener('click', () => {
            div.remove();
            renumber();
          });
          rowsEl.appendChild(div);
        };
        const renumber = () => {
          Array.from(rowsEl.children).forEach((c, i) => {
            c.firstElementChild.textContent = `Hari ${i + 1}`;
          });
        };

        const work = shiftCache.find((s) => !s.is_off);
        for (let i = 0; i < 5; i++) addRow(work ? work.id : '');
        addRow('');
        addRow('');

        A.$('#addRow', box).addEventListener('click', () => addRow(work ? work.id : ''));
        A.$('#preset57', box).addEventListener('click', () => {
          rowsEl.innerHTML = '';
          for (let i = 0; i < 5; i++) addRow(work ? work.id : '');
          addRow('');
          addRow('');
        });
        A.$('#preset3', box).addEventListener('click', () => {
          rowsEl.innerHTML = '';
          const kerja = shiftCache.filter((s) => !s.is_off).slice(0, 3);
          kerja.forEach((s) => addRow(s.id));
          addRow('');
        });

        // ---- daftar karyawan
        const empList = A.$('#empList', box);
        const paintEmployees = (deptId) => {
          const filtered = deptId
            ? employees.filter((e) => String(e.department_id) === String(deptId))
            : employees;
          empList.innerHTML = filtered.length
            ? filtered
                .map(
                  (e) => `<label class="check" style="padding:3px 0">
                    <input type="checkbox" class="emp" value="${e.id}" checked>
                    <span>${A.esc(e.name)} <span class="muted small">· PIN ${A.esc(e.pin)}${e.department_name ? ` · ${A.esc(e.department_name)}` : ''}</span></span>
                  </label>`
                )
                .join('')
            : '<p class="muted small" style="margin:6px">Tidak ada karyawan pada departemen ini.</p>';
        };
        paintEmployees('');
        A.$('#filterDept', box).addEventListener('change', (e) => paintEmployees(e.target.value));
        A.$('#selectAll', box).addEventListener('click', () =>
          A.$$('.emp', box).forEach((c) => {
            c.checked = true;
          })
        );
        A.$('#selectNone', box).addEventListener('click', () =>
          A.$$('.emp', box).forEach((c) => {
            c.checked = false;
          })
        );

        A.$('[data-ok]', box).addEventListener('click', () => {
          const from = box.querySelector('[name=from]').value;
          const to = box.querySelector('[name=to]').value;
          const pattern = A.$$('.pat', box).map((s) => (s.value ? Number(s.value) : null));
          const employeeIds = A.$$('.emp', box).filter((c) => c.checked).map((c) => Number(c.value));

          if (!from || !to) return A.toast('Rentang tanggal wajib diisi', 'err');
          if (to < from) return A.toast('Tanggal akhir lebih awal dari tanggal mulai', 'err');
          if (!pattern.length) return A.toast('Pola shift belum diisi', 'err');
          if (!employeeIds.length) return A.toast('Pilih minimal satu karyawan', 'err');

          return A.closeModal({
            from, to, pattern, employeeIds,
            offset: Number(A.$('#offset', box).value) || 0,
            stagger: A.$('#stagger', box).checked,
            skipHolidays: A.$('#skipHolidays', box).checked,
            overwrite: A.$('#overwrite', box).checked,
          });
        });
      },
    });

    if (!values) return;
    const res = await A.callSafe('schedules.generate', values);
    if (res) {
      A.toast(`Jadwal dibuat: ${res.employees} karyawan × ${res.days} hari`, 'ok');
      await A.refresh();
    }
  }

  function monthBounds(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const p = (n) => String(n).padStart(2, '0');
    return { start: `${y}-${p(m)}-01`, end: `${y}-${p(m)}-${p(last)}` };
  }

  A.registerPage('schedules', {
    title: 'Jadwal Shift',
    subtitle: 'Klik sel untuk mengubah shift satu hari',

    async render(root) {
      if (!state.month) state.month = A.fmt.currentMonth();

      const [data, depts, shifts] = await Promise.all([
        A.call('schedules.matrix', {
          month: state.month,
          departmentId: state.departmentId ? Number(state.departmentId) : null,
          search: state.search,
        }),
        A.call('departments.list'),
        A.call('shifts.list', { activeOnly: true }),
      ]);
      shiftCache = shifts;

      A.setActions(
        `<button id="btnClear">Hapus Jadwal Khusus</button>
         <button class="btn-primary" id="btnGenerate">Buat Jadwal Massal</button>`,
        {
          '#btnGenerate': () => generateDialog(),
          '#btnClear': async () => {
            const b = monthBounds(state.month);
            const ok = await A.confirm(
              `Hapus semua jadwal khusus pada ${A.fmt.monthLabel(state.month)}?`,
              { okLabel: 'Hapus', detail: 'Karyawan kembali mengikuti shift bawaan / jadwal mingguan.' }
            );
            if (!ok) return;
            const res = await A.callSafe('schedules.clearRange', {
              employeeIds: data.employees.map((e) => e.id),
              from: b.start,
              to: b.end,
            });
            if (res) A.toast(`${res.removed} jadwal dihapus`, 'ok');
            await A.refresh();
          },
        }
      );

      const holidaySet = new Set(data.holidays);
      const dayNums = data.dates.map((d) => Number(d.slice(8, 10)));
      const dow = data.dates.map((d) => {
        const [y, m, dd] = d.split('-').map(Number);
        return new Date(y, m - 1, dd).getDay();
      });
      const dowLetters = ['M', 'S', 'S', 'R', 'K', 'J', 'S'];

      const headCells = data.dates
        .map((d, i) => {
          const cls = holidaySet.has(d) ? 'holiday' : dow[i] === 0 || dow[i] === 6 ? 'weekend' : '';
          return `<th class="${cls}" title="${A.esc(A.fmt.dayName(d))}, ${A.esc(A.fmt.dateLong(d))}">
            <div>${dayNums[i]}</div><div style="opacity:.65">${dowLetters[dow[i]]}</div>
          </th>`;
        })
        .join('');

      const bodyRows = data.employees
        .map(
          (e) => `<tr>
            <td class="name-col" title="${A.esc(e.name)}">
              <strong>${A.esc(e.name)}</strong>
              <div class="muted" style="font-size:10.5px">PIN ${A.esc(e.pin)}${e.department_name ? ` · ${A.esc(e.department_name)}` : ''}</div>
            </td>
            ${e.days
              .map((day, i) => {
                const cls = holidaySet.has(day.date) ? 'holiday' : dow[i] === 0 || dow[i] === 6 ? 'weekend' : '';
                const style = day.code && !day.is_off
                  ? `background:${A.esc(day.color)};color:${textOn(day.color)}`
                  : '';
                const label = day.code ? (day.is_off ? '·' : day.code) : '–';
                return `<td class="${cls}"><button class="cell${day.explicit ? ' explicit' : ''}"
                  style="${style}"
                  data-act="cell" data-emp="${e.id}" data-name="${A.esc(e.name)}"
                  data-date="${day.date}" data-shift="${day.shift_id || ''}"
                  title="${A.esc(day.name || 'Tidak dijadwalkan')}">${A.esc(label)}</button></td>`;
              })
              .join('')}
          </tr>`
        )
        .join('');

      root.innerHTML = `
        <div class="toolbar">
          <input type="month" id="month" value="${A.esc(state.month)}" style="width:auto" />
          <select id="dept">
            <option value="">Semua Departemen</option>
            ${depts.map((d) => `<option value="${d.id}"${String(state.departmentId) === String(d.id) ? ' selected' : ''}>${A.esc(d.name)}</option>`).join('')}
          </select>
          <input class="search" id="q" placeholder="Cari karyawan..." value="${A.esc(state.search)}" />
          <div class="spacer"></div>
          <div class="legend">
            ${shifts.map((s) => `<span class="k"><i style="background:${A.esc(s.color || '#94a3b8')}"></i>${A.esc(s.code)} ${A.esc(s.name)}</span>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-body flush">
            ${
              data.employees.length
                ? `<div class="sched-wrap"><table class="sched">
                    <thead><tr><th class="name-col">Karyawan</th>${headCells}</tr></thead>
                    <tbody>${bodyRows}</tbody>
                  </table></div>`
                : A.emptyState('Belum ada karyawan aktif', 'Tambahkan karyawan lebih dulu di halaman Karyawan.', '▦')
            }
          </div>
        </div>
        <p class="small muted">Sel bergaris bawah = jadwal khusus yang di-set manual. Sel tanpa garis mengikuti shift bawaan karyawan atau jadwal mingguan.</p>
      `;

      A.$('#month', root).addEventListener('change', (e) => {
        state.month = e.target.value;
        A.refresh();
      });
      A.$('#dept', root).addEventListener('change', (e) => {
        state.departmentId = e.target.value;
        A.refresh();
      });
      let timer = null;
      A.$('#q', root).addEventListener('input', (e) => {
        clearTimeout(timer);
        state.search = e.target.value;
        timer = setTimeout(() => A.refresh(), 280);
      });

      A.bindActions(root, {
        cell: async (d) => {
          const result = await pickShift(d.name, d.date, d.shift);
          if (!result) return;
          await A.callSafe('schedules.setDay', {
            employeeId: Number(d.emp),
            date: d.date,
            shiftId: result.shiftId ? Number(result.shiftId) : null,
          });
          await A.refresh();
        },
      });
    },
  });
})();
