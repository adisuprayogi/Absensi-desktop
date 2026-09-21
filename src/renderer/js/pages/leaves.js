'use strict';

(function () {
  const A = window.App;
  const state = { from: null, to: null, search: '' };

  async function leaveForm(existing) {
    const [employees, types] = await Promise.all([
      A.call('employees.list', { activeOnly: true }),
      A.call('leaveTypes.list'),
    ]);
    if (!employees.length) {
      A.toast('Belum ada karyawan aktif', 'warn');
      return;
    }

    const values = await A.formDialog({
      title: existing ? 'Ubah Izin / Cuti' : 'Tambah Izin / Cuti',
      okLabel: 'Simpan',
      wide: true,
      fields: [
        {
          name: 'employee_id', label: 'Karyawan', type: 'select', required: true,
          value: existing ? existing.employee_id : '',
          options: employees.map((e) => ({ value: e.id, label: `${e.name} (PIN ${e.pin})` })),
        },
        {
          name: 'leave_type_id', label: 'Jenis', type: 'select', required: true,
          value: existing ? existing.leave_type_id : '',
          options: types.map((t) => ({ value: t.id, label: `${t.name}${t.counts_as_present ? ' (dihitung hadir)' : ''}` })),
        },
        {
          name: 'start_date', label: 'Tanggal Mulai', type: 'date', required: true, row: 'a',
          value: existing ? existing.start_date : A.fmt.today(),
        },
        {
          name: 'end_date', label: 'Tanggal Selesai', type: 'date', required: true, row: 'a',
          value: existing ? existing.end_date : A.fmt.today(),
          hint: 'Isi sama dengan tanggal mulai untuk izin satu hari',
        },
        {
          name: 'status', label: 'Status Pengajuan', type: 'select',
          value: existing ? existing.status : 'disetujui',
          options: [
            { value: 'disetujui', label: 'Disetujui (dipakai di rekap)' },
            { value: 'diajukan', label: 'Diajukan (belum dipakai di rekap)' },
            { value: 'ditolak', label: 'Ditolak' },
          ],
        },
        { name: 'note', label: 'Keterangan', type: 'textarea', value: existing ? existing.note : '' },
      ],
      validate: (v) => (v.end_date < v.start_date ? 'Tanggal selesai lebih awal dari tanggal mulai' : null),
    });
    if (!values) return;

    const payload = {
      ...values,
      employee_id: Number(values.employee_id),
      leave_type_id: Number(values.leave_type_id),
    };
    if (existing) await A.call('leaves.update', { id: existing.id, ...payload });
    else await A.call('leaves.create', payload);
    A.toast('Data izin tersimpan', 'ok');
    await A.refresh();
  }

  async function manageTypes() {
    const render = async (box) => {
      const list = await A.call('leaveTypes.list');
      A.$('#typeList', box).innerHTML = list
        .map(
          (t) => `<div class="live-item">
            <span class="badge" style="background:${A.esc(t.color)}">${A.esc(t.code)}</span>
            <span class="who">${A.esc(t.name)}</span>
            ${t.counts_as_present ? '<span class="badge soft">Dihitung hadir</span>' : ''}
            ${t.is_paid ? '' : '<span class="badge soft">Tanpa gaji</span>'}
            <button class="btn-sm btn-danger" data-type-del="${t.id}">Hapus</button>
          </div>`
        )
        .join('');
    };

    await A.modal({
      title: 'Jenis Izin & Cuti',
      body: `
        <div id="typeList" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px;max-height:300px;overflow-y:auto"></div>
        <div class="field-row">
          <div class="field"><label>Kode</label><input id="tCode" maxlength="8" placeholder="Mis. CB" /></div>
          <div class="field"><label>Nama</label><input id="tName" placeholder="Mis. Cuti Besar" /></div>
        </div>
        <label class="check" style="margin-bottom:6px"><input type="checkbox" id="tPresent"> Dihitung sebagai hadir di rekap</label>
        <label class="check" style="margin-bottom:12px"><input type="checkbox" id="tPaid" checked> Tetap dibayar</label>
        <button class="btn-primary" id="tAdd">Tambah Jenis</button>
      `,
      footer: '<button data-close>Tutup</button>',
      onOpen: async (box) => {
        await render(box);
        A.$('#tAdd', box).addEventListener('click', async () => {
          const code = A.$('#tCode', box).value.trim();
          const name = A.$('#tName', box).value.trim();
          if (!code || !name) return A.toast('Kode dan nama wajib diisi', 'err');
          try {
            await A.call('leaveTypes.create', {
              code,
              name,
              counts_as_present: A.$('#tPresent', box).checked ? 1 : 0,
              is_paid: A.$('#tPaid', box).checked ? 1 : 0,
            });
            A.$('#tCode', box).value = '';
            A.$('#tName', box).value = '';
            await render(box);
          } catch (err) {
            A.toast(err.message, 'err');
          }
          return undefined;
        });
        box.addEventListener('click', async (e) => {
          const del = e.target.closest('[data-type-del]');
          if (!del) return;
          await A.callSafe('leaveTypes.remove', { id: Number(del.dataset.typeDel) });
          await render(box);
        });
      },
    });
    await A.refresh();
  }

  A.registerPage('leaves', {
    title: 'Izin & Cuti',
    subtitle: 'Cuti, sakit, izin, dan dinas luar — otomatis menimpa status alpha di rekap',

    async render(root) {
      if (!state.from) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        state.from = `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        state.to = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(last)}`;
      }

      const list = await A.call('leaves.list', {
        from: state.from,
        to: state.to,
        search: state.search,
      });

      A.setActions(
        `<button id="btnTypes">Jenis Izin</button>
         <button class="btn-primary" id="btnAdd">+ Tambah Izin / Cuti</button>`,
        { '#btnAdd': () => leaveForm(null), '#btnTypes': () => manageTypes() }
      );
      A.setSubtitle(`${list.length} pengajuan pada rentang tanggal ini`);
      const hal = A.paginate('leaves', list, { resetOn: [state.from, state.to, state.search] });

      root.innerHTML = `
        <div class="toolbar">
          <input type="date" id="from" value="${A.esc(state.from)}" style="width:auto" />
          <span class="muted small">s/d</span>
          <input type="date" id="to" value="${A.esc(state.to)}" style="width:auto" />
          <input class="search" id="q" placeholder="Cari karyawan..." value="${A.esc(state.search)}" />
        </div>

        <div class="card">
          <div class="card-body flush">
            ${A.table(
              [
                {
                  label: 'Karyawan',
                  render: (l) => `<strong>${A.esc(l.employee_name)}</strong><div class="small muted">PIN ${A.esc(l.employee_pin)}</div>`,
                },
                {
                  label: 'Jenis', className: 'c',
                  render: (l) =>
                    `<span class="badge" style="background:${A.esc(l.leave_type_color || '#8b5cf6')}">${A.esc(l.leave_type_name)}</span>` +
                    (l.counts_as_present ? '<div class="small muted" style="margin-top:3px">dihitung hadir</div>' : ''),
                },
                { label: 'Mulai', className: 'c nowrap', render: (l) => A.esc(A.fmt.date(l.start_date)) },
                { label: 'Selesai', className: 'c nowrap', render: (l) => A.esc(A.fmt.date(l.end_date)) },
                { label: 'Jumlah Hari', className: 'c num', render: (l) => `${Math.round(l.days)} hari` },
                {
                  label: 'Status', className: 'c',
                  render: (l) => {
                    const map = {
                      disetujui: '<span class="badge" style="background:#10b981">Disetujui</span>',
                      diajukan: '<span class="badge" style="background:#f59e0b">Diajukan</span>',
                      ditolak: '<span class="badge" style="background:#ef4444">Ditolak</span>',
                    };
                    return map[l.status] || A.esc(l.status);
                  },
                },
                { label: 'Keterangan', render: (l) => `<span class="small muted">${A.esc(l.note || '-')}</span>` },
                {
                  label: '', className: 'r',
                  render: (l) => `<div class="row-actions">
                    <button class="btn-sm" data-act="edit" data-id="${l.id}">Ubah</button>
                    <button class="btn-sm btn-danger" data-act="del" data-id="${l.id}">Hapus</button>
                  </div>`,
                },
              ],
              hal.rows,
              { empty: 'Belum ada pengajuan izin atau cuti pada rentang ini.' }
            )}
          </div>
          ${hal.controls}
        </div>
      `;

      A.$('#from', root).addEventListener('change', (e) => {
        state.from = e.target.value;
        A.refresh();
      });
      A.$('#to', root).addEventListener('change', (e) => {
        state.to = e.target.value;
        A.refresh();
      });
      let timer = null;
      A.$('#q', root).addEventListener('input', (e) => {
        clearTimeout(timer);
        state.search = e.target.value;
        timer = setTimeout(() => A.refresh(), 280);
      });

      A.bindActions(root, {
        edit: (d) => leaveForm(list.find((x) => String(x.id) === String(d.id))),
        del: async (d) => {
          const ok = await A.confirm('Hapus data izin ini?', { okLabel: 'Hapus' });
          if (!ok) return;
          await A.callSafe('leaves.remove', { id: Number(d.id) });
          A.toast('Data izin dihapus', 'ok');
          await A.refresh();
        },
      });
    },
  });
})();
