'use strict';

(function () {
  const A = window.App;

  async function deviceForm(existing) {
    const values = await A.formDialog({
      title: existing ? `Ubah Mesin — ${existing.name}` : 'Tambah Mesin Absensi',
      okLabel: existing ? 'Simpan Perubahan' : 'Tambah',
      wide: true,
      fields: [
        {
          name: 'name', label: 'Nama Mesin', required: true,
          value: existing ? existing.name : '',
          hint: 'Mis. Mesin Lobi Utama, Mesin Gudang',
        },
        {
          name: 'ip', label: 'Alamat IP Mesin', required: true, row: 'a',
          value: existing ? existing.ip : '192.168.1.201',
          hint: 'Lihat di mesin: Menu > Komunikasi > Jaringan',
        },
        {
          name: 'port', label: 'Port', type: 'number', required: true, row: 'a',
          value: existing ? existing.port : 4370,
          attrs: 'min="1" max="65535"',
          hint: 'Bawaan Solution X105/X401: 4370',
        },
        {
          name: 'comm_key', label: 'Comm Key', type: 'number', row: 'b',
          value: existing ? existing.comm_key : 0,
          attrs: 'min="0"',
          hint: 'Isi 0 bila mesin tidak memakai kunci komunikasi',
        },
        {
          name: 'protocol', label: 'Protokol', type: 'select', row: 'b',
          value: existing ? existing.protocol : 'tcp',
          options: [
            { value: 'tcp', label: 'TCP (disarankan)' },
            { value: 'udp', label: 'UDP' },
          ],
        },
        {
          name: 'auto_sync', label: 'Ikut auto-sync terjadwal', type: 'checkbox',
          value: existing ? existing.auto_sync : 1,
          hint: 'Data ditarik otomatis sesuai interval di halaman Pengaturan',
        },
        {
          name: 'live_capture', label: 'Aktifkan realtime (live capture)', type: 'checkbox',
          value: existing ? existing.live_capture : 0,
          hint: 'Aplikasi menjaga koneksi terus-menerus agar scan masuk seketika',
        },
        { name: 'active', label: 'Mesin aktif', type: 'checkbox', value: existing ? existing.active : 1 },
      ],
      validate: (v) => (!String(v.ip || '').trim() ? 'Alamat IP wajib diisi' : null),
    });
    if (!values) return;

    if (existing) await A.call('devices.update', { id: existing.id, ...values });
    else await A.call('devices.create', values);

    await A.callSafe('device.applySettings');
    A.toast(existing ? 'Mesin diperbarui' : 'Mesin ditambahkan', 'ok');
    await A.refresh();
  }

  async function showInfo(device, info) {
    const rows = [
      ['Nama di Mesin', info.name || '-'],
      ['Platform', info.platform || '-'],
      ['Firmware', info.firmware || '-'],
      ['Serial Number', info.serial || '-'],
      ['Jam Mesin', info.device_time || '-'],
      ['Jumlah User', info.users != null ? info.users : '-'],
      ['Jumlah Sidik Jari', info.fingers != null ? info.fingers : '-'],
      ['Log Tersimpan', info.records != null ? `${info.records}${info.recordCapacity ? ` / ${info.recordCapacity}` : ''}` : '-'],
      ['Kapasitas User', info.userCapacity || '-'],
    ];
    const drift = info.device_time
      ? `<p class="small muted" style="margin:12px 0 0">Jam komputer: ${new Date().toLocaleString('id-ID')}. Bila berbeda jauh dengan jam mesin, tekan "Samakan Jam Mesin" agar rekap tidak melenceng.</p>`
      : '';

    await A.modal({
      title: `Info Mesin — ${device.name}`,
      body: `<dl class="kv">${rows.map(([k, v]) => `<dt>${A.esc(k)}</dt><dd>${A.esc(v)}</dd>`).join('')}</dl>${drift}`,
      footer: '<button data-close>Tutup</button>',
    });
  }

  /** Tampilkan hasil pemindaian port beserta langkah yang perlu dilakukan. */
  async function showDiagnosis(device, d) {
    const ya = '<span style="color:#059669;font-weight:600">terbuka</span>';
    const tidak = '<span class="muted">tertutup</span>';

    const tabelPort = A.table(
      [
        { label: 'Port', className: 'c num', render: (p) => `<strong>${A.esc(p.port)}</strong>` },
        { label: 'TCP', className: 'c', render: (p) => (p.tcp ? ya : tidak) },
        {
          label: 'Mesin Absensi?', className: 'c',
          render: (p) =>
            p.zk
              ? '<span class="badge" style="background:#10b981">Ya</span>'
              : p.tcp
                ? `<span class="small muted">${A.esc(p.zkReason || 'bukan')}</span>`
                : '<span class="muted">-</span>',
        },
        { label: 'Keterangan', render: (p) => `<span class="small muted">${A.esc(p.note)}</span>` },
      ],
      d.ports
    );

    const ringkas = d.connected
      ? `<div class="stat green" style="margin-bottom:14px">
           <span class="label">Hasil</span>
           <span class="value" style="font-size:17px">Mesin ditemukan dan berhasil dihubungi</span>
           <span class="hint">${A.esc(d.deviceName || '')} ${A.esc(d.firmware || '')} • ${d.users || 0} user, ${d.records || 0} log di mesin</span>
         </div>`
      : `<div class="stat red" style="margin-bottom:14px">
           <span class="label">Hasil</span>
           <span class="value" style="font-size:17px">${
             d.reachable ? 'Alamat hidup, tapi mesin absensi belum terhubung' : 'Alamat tidak terjangkau'
           }</span>
           <span class="hint">${A.esc(d.error || `Diperiksa: ${A.esc(d.ip)}`)}</span>
         </div>`;

    await A.modal({
      title: `Diagnosa Koneksi — ${device.name}`,
      wide: true,
      body: `
        ${ringkas}
        <h4 style="margin:0 0 6px;font-size:13.5px">Hasil pemindaian port di ${A.esc(d.ip)}</h4>
        ${tabelPort}
        <h4 style="margin:16px 0 6px;font-size:13.5px">Langkah yang disarankan</h4>
        <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.75">
          ${d.saran.map((s) => `<li>${A.esc(s)}</li>`).join('')}
        </ol>
        <div style="margin-top:16px;padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px">
          <strong style="font-size:13px">Cara melihat port di mesin Solution X401</strong>
          <ol style="margin:8px 0 0;padding-left:20px;font-size:12.5px;line-height:1.7">
            <li>Tekan tombol <strong>M/OK</strong> pada mesin untuk membuka menu</li>
            <li>Pilih <strong>Komunikasi</strong> (atau <em>Comm.</em>)</li>
            <li>Pilih <strong>Jaringan</strong> (atau <em>Ethernet</em>) — di sini terlihat Alamat IP, Subnet Mask, dan <strong>Port TCP</strong> (bawaannya 4370)</li>
            <li>Kembali ke <strong>Komunikasi</strong>, pilih <strong>Koneksi PC</strong> (atau <em>Comm Key / PC Connection</em>) — di sini terlihat <strong>Kunci Komunikasi</strong>. Bila nilainya bukan 0, isikan angka itu di kolom Comm Key aplikasi.</li>
          </ol>
        </div>
      `,
      footer: '<button data-close>Tutup</button>',
    });
  }

  async function showDeviceUsers(deviceId, deviceName) {
    const users = await A.call('devices.users', { deviceId });

    // Pindah halaman cukup menggambar ulang isi dialog, bukan seluruh halaman.
    const kunci = `device-users-${deviceId}`;
    const gambar = () => {
      const box = A.$('#deviceUsersBody');
      if (box) box.innerHTML = isiTabel();
    };
    const isiTabel = () => {
      const hal = A.paginate(kunci, users, { onChange: gambar });
      return tabelUser(hal.rows) + hal.controls;
    };
    const tabelUser = (rows) =>
      A.table(
        [
          { label: 'PIN', className: 'c num', render: (u) => `<strong>${A.esc(u.user_pin)}</strong>` },
          { label: 'Nama di Mesin', render: (u) => A.esc(u.name || '-') },
          {
            label: 'Hak Akses', className: 'c',
            render: (u) => (u.privilege >= 14 ? '<span class="badge" style="background:#8b5cf6">Admin</span>' : '<span class="badge soft">User</span>'),
          },
          {
            label: 'Terhubung ke Karyawan',
            render: (u) =>
              u.employee_name
                ? `<span style="color:#059669">✓ ${A.esc(u.employee_name)}</span>`
                : '<span style="color:#b45309">Belum terdaftar</span>',
          },
        ],
        rows
      );

    await A.modal({
      title: `User Terdaftar di ${deviceName} (${users.length})`,
      wide: true,
      body: users.length
        ? `<div id="deviceUsersBody">${isiTabel()}</div>`
        : A.emptyState('Belum ada data user', 'Tekan "Sinkron User" untuk mengambil daftar dari mesin.', '☺'),
      footer: '<button data-close>Tutup</button>',
    });
  }

  /**
   * Tarik log dari mesin, hanya menyimpan scan pada periode tertentu.
   * Dipakai juga oleh halaman Log Scan, dengan periode dari filternya.
   */
  async function pullPeriodDialog({ from = null, to = null } = {}) {
    const devices = (await A.call('devices.list')).filter((d) => d.active);
    if (!devices.length) {
      A.toast('Belum ada mesin absensi aktif', 'warn');
      return false;
    }
    const values = await A.formDialog({
      title: 'Tarik Data per Periode',
      okLabel: 'Tarik Data',
      fields: [
        {
          name: 'deviceId',
          label: 'Mesin',
          type: 'select',
          value: '',
          options: [
            { value: '', label: `Semua mesin aktif (${devices.length})` },
            ...devices.map((d) => ({ value: d.id, label: `${d.name} (${d.ip})` })),
          ],
        },
        { name: 'from', label: 'Dari tanggal', type: 'date', value: from || `${A.fmt.currentMonth()}-01`, required: true, row: 'periode' },
        { name: 'to', label: 'Sampai tanggal', type: 'date', value: to || A.fmt.today(), required: true, row: 'periode' },
      ],
      validate: (v) => (v.from > v.to ? 'Tanggal awal tidak boleh setelah tanggal akhir' : null),
    });
    if (!values) return false;

    const periode = { from: values.from, to: values.to };
    const label = `${A.fmt.date(periode.from)} s/d ${A.fmt.date(periode.to)}`;
    A.toast(`Menarik data periode ${label}... seluruh log di mesin tetap dibaca, mohon tunggu.`, 'ok', 6000);

    const results = values.deviceId
      ? [{ name: devices.find((d) => String(d.id) === String(values.deviceId)).name,
           ...(await A.callSafe('device.pull', { id: Number(values.deviceId), ...periode }, { ok: false })) }]
      : await A.callSafe('device.pullAll', periode, []);

    const ok = (results || []).filter((r) => r.ok);
    const gagal = (results || []).filter((r) => !r.ok);
    const baru = ok.reduce((n, r) => n + (r.inserted || 0), 0);
    const dalam = ok.reduce((n, r) => n + (r.fetched || 0), 0);
    const luar = ok.reduce((n, r) => n + (r.outOfRange || 0), 0);
    if (ok.length) {
      A.toast(
        `Periode ${label}: ${baru} data baru dari ${dalam} scan dalam periode` +
          (luar ? ` • ${luar} scan di luar periode tidak disimpan` : ''),
        'ok',
        8000
      );
    }
    for (const r of gagal) A.toast(`${r.name || 'Mesin'}: ${r.error || 'gagal'}`, 'err', 8000);
    return true;
  }
  A.pullPeriodDialog = pullPeriodDialog;

  A.registerPage('devices', {
    title: 'Mesin Absensi',
    subtitle: 'Solution X105 / X401 dan mesin ZKTeco lain melalui jaringan LAN',

    async render(root) {
      const [devices, history] = await Promise.all([
        A.call('devices.list'),
        A.call('devices.syncHistory', { limit: 15 }),
      ]);
      const liveStatus = await A.callSafe('device.liveStatus', {}, {});

      A.setActions(
        `<button id="btnPullPeriod">Tarik per Periode</button>
         <button id="btnPullAll">Tarik Data Semua</button>
         <button class="btn-primary" id="btnAdd">+ Tambah Mesin</button>`,
        {
          '#btnAdd': () => deviceForm(null),
          '#btnPullPeriod': async () => {
            if (await pullPeriodDialog()) await A.refresh();
          },
          '#btnPullAll': async (e) => {
            await A.busy(e.currentTarget, async () => {
              const results = await A.callSafe('device.pullAll', {}, []);
              const total = (results || []).reduce((n, r) => n + (r.inserted || 0), 0);
              A.toast(`Selesai. ${total} data absensi baru.`, 'ok');
              await A.refresh();
            }, 'Menarik data...');
          },
        }
      );

      const cards = devices
        .map((d) => {
          const live = liveStatus && liveStatus[d.id];
          return `<div class="card" style="margin:0">
            <div class="card-head">
              <div>
                <h3>${A.esc(d.name)}</h3>
                <div class="sub num">${A.esc(d.ip)}:${A.esc(d.port)} · ${A.esc(String(d.protocol).toUpperCase())}${d.comm_key ? ' · Comm Key aktif' : ''}</div>
              </div>
              <div class="pill-row">
                ${d.active ? '' : '<span class="badge soft">Nonaktif</span>'}
                ${d.auto_sync ? '<span class="badge" style="background:#2563eb">Auto-sync</span>' : ''}
                ${d.live_capture ? `<span class="badge" style="background:${live ? '#10b981' : '#94a3b8'}">${live ? 'Realtime aktif' : 'Realtime terputus'}</span>` : ''}
              </div>
            </div>
            <div class="card-body">
              <dl class="kv" style="grid-template-columns:130px 1fr">
                <dt>Model</dt><dd>${A.esc(d.model || '-')}</dd>
                <dt>Serial</dt><dd>${A.esc(d.serial || '-')}</dd>
                <dt>User Tersinkron</dt><dd>${d.user_count}</dd>
                <dt>Log Tersimpan</dt><dd class="num">${d.log_count.toLocaleString('id-ID')}</dd>
                <dt>Sinkron Terakhir</dt><dd>${A.esc(d.last_sync_at ? A.fmt.dateTime(d.last_sync_at) : 'Belum pernah')}</dd>
                <dt>Status</dt><dd class="small muted">${A.esc(d.last_status || '-')}</dd>
              </dl>
              <div class="pill-row" style="margin-top:14px">
                <button class="btn-sm btn-primary" data-act="pull" data-id="${d.id}">Tarik Data</button>
                <button class="btn-sm" data-act="test" data-id="${d.id}">Tes Koneksi</button>
                <button class="btn-sm" data-act="diagnose" data-id="${d.id}">Diagnosa</button>
                <button class="btn-sm" data-act="users" data-id="${d.id}" data-name="${A.esc(d.name)}">Lihat User</button>
                <button class="btn-sm" data-act="syncusers" data-id="${d.id}">Sinkron User</button>
                <button class="btn-sm" data-act="settime" data-id="${d.id}">Samakan Jam</button>
                ${d.live_capture
                  ? `<button class="btn-sm" data-act="${live ? 'stoplive' : 'startlive'}" data-id="${d.id}">${live ? 'Matikan Realtime' : 'Nyalakan Realtime'}</button>`
                  : ''}
                <button class="btn-sm" data-act="edit" data-id="${d.id}">Ubah</button>
                <button class="btn-sm btn-danger" data-act="del" data-id="${d.id}" data-name="${A.esc(d.name)}">Hapus</button>
              </div>
            </div>
          </div>`;
        })
        .join('');

      root.innerHTML = `
        ${
          devices.length
            ? `<div class="grid cols-2" style="margin-bottom:16px">${cards}</div>`
            : `<div class="card"><div class="card-body">${A.emptyState(
                'Belum ada mesin absensi',
                'Tambahkan mesin Solution X105 atau X401 yang terhubung ke jaringan LAN yang sama dengan komputer ini.',
                '⌗'
              )}</div></div>`
        }

        <div class="card">
          <div class="card-head"><div><h3>Riwayat Penarikan Data</h3></div></div>
          <div class="card-body flush">
            ${A.table(
              [
                { label: 'Waktu', className: 'nowrap', render: (h) => A.esc(A.fmt.dateTime(h.started_at)) },
                { label: 'Mesin', render: (h) => A.esc(h.device_name || '-') },
                { label: 'Diambil', className: 'c num', render: (h) => h.fetched || 0 },
                { label: 'Tersimpan', className: 'c num', render: (h) => `<strong>${h.inserted || 0}</strong>` },
                {
                  label: 'Hasil', className: 'c',
                  render: (h) =>
                    h.ended_at
                      ? h.ok
                        ? '<span class="badge" style="background:#10b981">Berhasil</span>'
                        : '<span class="badge" style="background:#ef4444">Gagal</span>'
                      : '<span class="badge soft">Berjalan</span>',
                },
                { label: 'Keterangan', render: (h) => `<span class="small muted">${A.esc(h.message || '-')}</span>` },
              ],
              history,
              { empty: 'Belum ada riwayat penarikan data.' }
            )}
          </div>
        </div>
      `;

      const findDevice = (id) => devices.find((x) => String(x.id) === String(id));

      A.bindActions(root, {
        pull: async (d, btn) => {
          await A.busy(btn, async () => {
            const res = await A.callSafe('device.pull', { id: Number(d.id) });
            if (res && res.ok) A.toast(`${res.inserted} data baru dari ${res.fetched} log di mesin`, 'ok');
            else if (res) A.toast(res.error, 'err', 7000);
            await A.refresh();
          }, 'Menarik...');
        },
        test: async (d, btn) => {
          await A.busy(btn, async () => {
            const res = await A.callSafe('device.test', { id: Number(d.id) });
            if (res && res.ok) {
              await showInfo(findDevice(d.id), res.info);
            } else if (res) {
              // Gagal menghubungi: tawarkan pemeriksaan mendalam, bukan sekadar pesan galat.
              const lanjut = await A.confirm(res.error, {
                title: 'Koneksi Gagal',
                okLabel: 'Jalankan Diagnosa',
                danger: false,
                detail: 'Diagnosa memindai port mesin dan memberi tahu langkah perbaikannya.',
              });
              if (lanjut) {
                const hasil = await A.callSafe('device.diagnose', { id: Number(d.id) });
                if (hasil) await showDiagnosis(findDevice(d.id), hasil);
              }
            }
            await A.refresh();
          }, 'Menguji...');
        },
        diagnose: async (d, btn) => {
          await A.busy(btn, async () => {
            const hasil = await A.callSafe('device.diagnose', { id: Number(d.id) });
            if (hasil) await showDiagnosis(findDevice(d.id), hasil);
          }, 'Memindai...');
        },
        users: (d) => showDeviceUsers(Number(d.id), d.name),
        syncusers: async (d, btn) => {
          await A.busy(btn, async () => {
            const res = await A.callSafe('device.syncUsers', { id: Number(d.id) });
            if (res && res.ok) A.toast(`${res.count} user disinkronkan dari mesin`, 'ok');
            else if (res) A.toast(res.error, 'err', 7000);
            await A.refresh();
          }, 'Sinkron...');
        },
        settime: async (d, btn) => {
          const ok = await A.confirm('Samakan jam mesin dengan jam komputer ini?', {
            okLabel: 'Samakan',
            danger: false,
            detail: 'Jam mesin yang meleset membuat perhitungan telat dan lembur ikut meleset.',
          });
          if (!ok) return;
          await A.busy(btn, async () => {
            const res = await A.callSafe('device.setTime', { id: Number(d.id) });
            A.toast(res && res.ok ? 'Jam mesin disamakan' : (res && res.error) || 'Gagal', res && res.ok ? 'ok' : 'err');
          }, 'Menyamakan...');
        },
        startlive: async (d, btn) => {
          await A.busy(btn, async () => {
            const res = await A.callSafe('device.startLive', { id: Number(d.id) });
            A.toast(res && res.ok ? 'Realtime dinyalakan' : (res && res.error) || 'Gagal', res && res.ok ? 'ok' : 'err');
            await A.refresh();
          }, 'Menyambung...');
        },
        stoplive: async (d) => {
          await A.callSafe('device.stopLive', { id: Number(d.id) });
          A.toast('Realtime dimatikan', 'ok');
          await A.refresh();
        },
        edit: (d) => deviceForm(findDevice(d.id)),
        del: async (d) => {
          const ok = await A.confirm(`Hapus mesin "${d.name}"?`, {
            okLabel: 'Hapus',
            detail: 'Log absensi yang sudah ditarik tetap tersimpan di database.',
          });
          if (!ok) return;
          await A.callSafe('devices.remove', { id: Number(d.id) });
          A.toast('Mesin dihapus', 'ok');
          await A.refresh();
        },
      });
    },
  });
})();
