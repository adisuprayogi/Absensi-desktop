'use strict';

(function () {
  const A = window.App;
  let feedEl = null;

  function statusBadge(row) {
    return `<span class="badge" style="background:${A.esc(row.status_color)}">${A.esc(row.status_label)}</span>`;
  }

  A.registerPage('dashboard', {
    title: 'Dashboard',
    subtitle: '',

    async render(root) {
      const today = A.fmt.today();
      const [stat, recent, devices] = await Promise.all([
        A.call('reports.dashboard', { date: today }),
        A.call('attendance.recent', { limit: 25 }),
        A.call('devices.list'),
      ]);

      A.setSubtitle(`${A.fmt.dayName(today)}, ${A.fmt.dateLong(today)}`);
      A.setActions(
        `<button class="btn-primary" id="btnPullAll">Tarik Data Semua Mesin</button>`,
        {
          '#btnPullAll': async (e) => {
            await A.busy(e.currentTarget, async () => {
              const results = await A.callSafe('device.pullAll', {}, []);
              const total = (results || []).reduce((n, r) => n + (r.inserted || 0), 0);
              const failed = (results || []).filter((r) => !r.ok);
              if (!results || !results.length) A.toast('Belum ada mesin absensi terdaftar', 'warn');
              else if (failed.length) A.toast(`${total} data baru. ${failed.length} mesin gagal dihubungi.`, 'warn');
              else A.toast(`Selesai. ${total} data absensi baru.`, 'ok');
              await A.refresh();
            }, 'Menarik data...');
          },
        }
      );

      const belumAbsen = stat.belum_absen + stat.tidak_lengkap;
      const tiles = [
        { label: 'Karyawan Aktif', value: stat.total_karyawan, hint: 'terdaftar & aktif', cls: '' },
        { label: 'Hadir Hari Ini', value: stat.hadir, hint: `${stat.terlambat} terlambat`, cls: 'green' },
        { label: 'Belum / Tidak Lengkap', value: belumAbsen, hint: 'belum absen pulang atau belum scan', cls: 'amber' },
        { label: 'Alpha', value: stat.alpha, hint: 'tanpa keterangan', cls: 'red' },
        { label: 'Izin / Cuti / Sakit', value: stat.izin_cuti, hint: 'dengan keterangan', cls: 'violet' },
        { label: 'Libur', value: stat.libur, hint: 'sesuai jadwal shift', cls: 'slate' },
        { label: 'Total Scan Hari Ini', value: stat.scan_hari_ini, hint: 'jumlah tap di mesin', cls: '' },
        {
          label: 'Mesin Absensi',
          value: devices.filter((d) => d.active).length,
          hint: `${devices.filter((d) => d.live_capture).length} realtime`,
          cls: 'slate',
        },
      ];

      const perluPerhatian = stat.rows
        .filter((r) => ['A', 'T', 'TL'].includes(r.status))
        .sort((a, b) => b.late_minutes - a.late_minutes);

      root.innerHTML = `
        <div class="grid cols-4" style="margin-bottom:18px">
          ${tiles
            .map(
              (t) => `<div class="stat ${t.cls}">
                <span class="label">${A.esc(t.label)}</span>
                <span class="value num">${A.esc(t.value)}</span>
                <span class="hint">${A.esc(t.hint)}</span>
              </div>`
            )
            .join('')}
        </div>

        <div class="grid cols-2">
          <div class="card" style="margin:0">
            <div class="card-head">
              <div>
                <h3>Perlu Perhatian</h3>
                <div class="sub">Alpha, terlambat, dan absen tidak lengkap hari ini</div>
              </div>
              <span class="badge soft">${perluPerhatian.length}</span>
            </div>
            <div class="card-body flush" style="max-height:380px;overflow:auto">
              ${
                perluPerhatian.length
                  ? A.table(
                      [
                        { label: 'Karyawan', render: (r) => `<strong>${A.esc(r.employee_name)}</strong><div class="small muted">${A.esc(r.department_name || '-')}</div>` },
                        { label: 'Shift', className: 'c', render: (r) => A.esc(r.shift_name || '-') },
                        { label: 'Masuk', className: 'c num', render: (r) => A.esc(r.check_in || '-') },
                        { label: 'Pulang', className: 'c num', render: (r) => A.esc(r.check_out || '-') },
                        { label: 'Telat', className: 'c num', render: (r) => A.fmt.minutes(r.late_minutes) },
                        { label: 'Status', className: 'c', render: statusBadge },
                      ],
                      perluPerhatian
                    )
                  : A.emptyState('Semua tertib', 'Tidak ada alpha atau keterlambatan hari ini.', '✓')
              }
            </div>
          </div>

          <div class="card" style="margin:0">
            <div class="card-head">
              <div>
                <h3>Scan Terbaru</h3>
                <div class="sub">Data masuk realtime dan hasil tarik data</div>
              </div>
              <button class="btn-sm" data-act="refresh-feed">Muat Ulang</button>
            </div>
            <div class="card-body flush live-feed" id="liveFeed">
              ${recent.length ? recent.map(feedItem).join('') : A.emptyState('Belum ada scan', 'Scan dari mesin akan muncul di sini.', '≡')}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div><h3>Status Mesin Absensi</h3></div>
            <button class="btn-sm" data-act="goto-devices">Kelola Mesin</button>
          </div>
          <div class="card-body flush">
            ${
              devices.length
                ? A.table(
                    [
                      { label: 'Nama Mesin', render: (d) => `<strong>${A.esc(d.name)}</strong>` },
                      { label: 'Alamat', render: (d) => `<span class="num">${A.esc(d.ip)}:${A.esc(d.port)}</span>` },
                      { label: 'Mode', className: 'c', render: (d) => modeBadges(d) },
                      { label: 'Sinkron Terakhir', className: 'c', render: (d) => A.esc(d.last_sync_at ? A.fmt.dateTime(d.last_sync_at) : 'Belum pernah') },
                      { label: 'Status', render: (d) => `<span class="small muted">${A.esc(d.last_status || '-')}</span>` },
                      {
                        label: '', className: 'r',
                        render: (d) => `<button class="btn-sm" data-act="pull" data-id="${d.id}">Tarik Data</button>`,
                      },
                    ],
                    devices
                  )
                : A.emptyState('Belum ada mesin terdaftar', 'Tambahkan mesin Solution X105/X401 di halaman Mesin Absensi.', '⌗')
            }
          </div>
        </div>
      `;

      feedEl = A.$('#liveFeed', root);

      A.bindActions(root, {
        'refresh-feed': () => A.refresh(),
        'goto-devices': () => A.go('devices'),
        pull: async (data, btn) => {
          await A.busy(btn, async () => {
            const res = await A.callSafe('device.pull', { id: Number(data.id) });
            if (res && res.ok) A.toast(`${res.inserted} data baru, ${res.duplicate} duplikat dilewati`, 'ok');
            else if (res) A.toast(res.error, 'err');
            await A.refresh();
          }, 'Menarik...');
        },
      });
    },
  });

  function modeBadges(d) {
    const out = [];
    if (!d.active) out.push('<span class="badge soft">Nonaktif</span>');
    if (d.auto_sync) out.push('<span class="badge" style="background:#2563eb">Auto-sync</span>');
    if (d.live_capture) out.push('<span class="badge" style="background:#10b981">Realtime</span>');
    return `<div class="pill-row" style="justify-content:center">${out.join('') || '<span class="muted">-</span>'}</div>`;
  }

  function feedItem(r) {
    const name = r.employee_name || `PIN ${r.user_pin}`;
    const warn = r.employee_name ? '' : ' style="color:#b45309"';
    return `<div class="live-item">
      <span class="time">${A.esc(String(r.ts).slice(11, 19))}</span>
      <span class="who"${warn}>${A.esc(name)}</span>
      <span class="badge soft">${A.esc(r.device_name || r.source)}</span>
    </div>`;
  }

  /** Dipanggil app.js saat ada scan realtime masuk. */
  window.Dashboard = {
    onLiveScan(p) {
      if (!feedEl || !document.body.contains(feedEl)) return;
      const empty = feedEl.querySelector('.empty-state');
      if (empty) feedEl.innerHTML = '';
      const node = document.createElement('div');
      node.innerHTML = feedItem({
        ts: p.ts,
        user_pin: p.userPin,
        employee_name: p.employeeName,
        device_name: p.deviceName,
        source: 'realtime',
      });
      const item = node.firstElementChild;
      item.style.background = '#ecfdf5';
      feedEl.prepend(item);
      setTimeout(() => {
        item.style.transition = 'background .8s';
        item.style.background = '';
      }, 900);
      while (feedEl.children.length > 40) feedEl.lastElementChild.remove();
    },
  };
})();
