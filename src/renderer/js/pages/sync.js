'use strict';

(function () {
  const A = window.App;
  const state = { deviceId: null, appFilter: '', deviceFilter: '', appSearch: '', deviceSearch: '' };
  // Baris terpilih per tabel. Disimpan di sini, bukan dibaca dari kotak centang,
  // supaya pilihan di halaman tabel lain tidak hilang saat berpindah halaman.
  const pilih = { app: new Set(), device: new Set() };

  const PRIVILEGE_LABEL = { 0: 'Pengguna', 2: 'Pendaftar', 12: 'Manajer', 14: 'Administrator' };
  const priv = (v) => PRIVILEGE_LABEL[Number(v) || 0] || `Kode ${v}`;
  const cardText = (v) => (Number(v) ? `<span class="num">${A.esc(v)}</span>` : '<span class="muted">-</span>');

  /**
   * Label status dilihat dari masing-masing sisi. Baris yang sama bisa berbunyi
   * berbeda di tabel kiri dan kanan, karena "belum ada di seberang" artinya
   * tidak sama tergantung Anda berdiri di sisi mana.
   */
  const STATUS = {
    sinkron: { app: 'Sudah di mesin', device: 'Sudah di aplikasi', color: '#10b981' },
    hanya_app: { app: 'Belum di mesin', device: '', color: '#2563eb' },
    hanya_mesin: { app: '', device: 'Belum di aplikasi', color: '#ef4444' },
    ubah_app: { app: 'Diubah di aplikasi', device: 'Diubah di aplikasi', color: '#f59e0b' },
    ubah_mesin: { app: 'Diubah di mesin', device: 'Diubah di mesin', color: '#8b5cf6' },
    bentrok: { app: 'Bentrok', device: 'Bentrok', color: '#dc2626' },
    beda: { app: 'Berbeda', device: 'Berbeda', color: '#f97316' },
  };

  /**
   * Mesin menolak ditimpa diam-diam: PIN yang dikirim ternyata dipakai orang
   * lain (namanya berbeda) di mesin. Admin memilih melewati, menimpa, atau batal.
   */
  function overwriteDialog(res, device) {
    const semuaBentrok = res.conflicts.length >= res.total;
    const baris = res.conflicts
      .map((k) => `<tr>
        <td class="c num"><strong>${A.esc(k.pin)}</strong></td>
        <td>${A.esc(k.name)}</td>
        <td>${A.esc(k.deviceName || '(tanpa nama)')}</td>
        <td class="c">${k.fingers ? `<strong>${k.fingers}</strong>` : '<span class="muted">-</span>'}</td>
      </tr>`)
      .join('');
    return A.modal({
      title: 'PIN Dipakai Orang Lain di Mesin',
      wide: true,
      body: `
        <p style="margin-top:0">${res.conflicts.length} dari ${res.total} karyawan yang akan dikirim memakai PIN yang
        di <strong>${A.esc(device.name)}</strong> terdaftar atas nama orang lain. Belum ada yang diubah di mesin.</p>
        <div class="table-wrap" style="margin-bottom:12px"><table class="data">
          <thead><tr><th class="c">PIN</th><th>Di Aplikasi</th><th>Di Mesin Sekarang</th><th class="c">Sidik Jari di Mesin</th></tr></thead>
          <tbody>${baris}</tbody>
        </table></div>
        <div class="warn-bar" style="margin:0">
          Bila ditimpa, data orang di mesin diganti dengan data aplikasi dan <b>sidik jarinya ikut menjadi milik
          karyawan aplikasi</b>. Timpa hanya bila Anda yakin itu orang yang sama (mis. namanya baru diganti).
        </div>`,
      footer: `
        <button data-choice="cancel">Batal</button>
        ${semuaBentrok ? '' : `<button class="btn-primary" data-choice="skip">Kirim Tanpa yang Bentrok (${res.total - res.conflicts.length})</button>`}
        <button class="btn-danger" data-choice="overwrite">Tetap Timpa Semua</button>`,
      onOpen: (box) => {
        A.$$('[data-choice]', box).forEach((b) => b.addEventListener('click', () => A.closeModal(b.dataset.choice)));
      },
    });
  }

  function statusBadge(status, sisi) {
    const s = STATUS[status] || STATUS.beda;
    return `<span class="badge" style="background:${s.color}">${A.esc(s[sisi] || s.app || s.device)}</span>`;
  }

  function checkbox(group, value) {
    const checked = pilih[group].has(String(value)) ? ' checked' : '';
    return `<input type="checkbox" class="pick" data-group="${group}" value="${A.esc(value)}"${checked}>`;
  }
  function selectAllHeader(group) {
    return `<input type="checkbox" class="pick-all" data-group="${group}" title="Pilih semua yang tampil">`;
  }
  function picked(group) {
    return [...pilih[group]];
  }


  /**
   * Sidik jari yang tersimpan DI APLIKASI — dipakai di tabel kiri.
   *
   * Angkanya milik orangnya sendiri dan TIDAK berubah saat mesin di dropdown
   * diganti. Sebelumnya kolom ini menampilkan jumlah di mesin yang sedang
   * dipilih, sehingga orang yang sama terlihat punya angka berbeda-beda di
   * tabel yang judulnya "Karyawan di Aplikasi" — membingungkan dan keliru.
   */
  function fingerBadgeApp(count, source) {
    if (!count) {
      return '<span class="muted" title="Belum ada sidik jari tersimpan di aplikasi untuk karyawan ini">-</span>';
    }
    const asal = source ? ` (diunduh dari ${source})` : '';
    return (
      '<span class="badge" style="background:#10b981" ' +
      'title="' + A.esc(count + ' sidik jari tersimpan di aplikasi' + asal) + '">' + count + '</span>'
    );
  }

  /**
   * Sidik jari yang benar-benar ada DI MESIN — dipakai di tabel kanan.
   * Angka 0 berarti usernya terdaftar tetapi belum pernah merekam jari.
   */
  function fingerBadgeDevice(count) {
    if (count > 0) {
      return '<span class="badge" style="background:#10b981" title="' + count + ' sidik jari terdaftar di mesin ini">' + count + '</span>';
    }
    return '<span class="badge" style="background:#f59e0b" title="Terdaftar di mesin, tetapi belum merekam sidik jari">0</span>';
  }
  /**
   * Kotak cari milik satu tabel. Sengaja terpisah kiri dan kanan: admin sering
   * perlu menyaring salah satu sisi saja, mis. menelusuri satu nama di mesin
   * sambil tetap melihat seluruh daftar karyawan di aplikasi.
   */
  function searchBox(id, value) {
    return `<input class="search" id="${id}" placeholder="Cari nama atau PIN..."
      value="${A.esc(value)}" style="width:180px;min-width:130px" />`;
  }

  /** Ringkas selisih jadi keterangan pendek, mis. "nama, kartu RFID". */
  function diffText(row) {
    if (!row.differences || !row.differences.length) return '';
    return `<div class="small muted" style="margin-top:2px">beda: ${A.esc(row.differences.join(', '))}</div>`;
  }

  function applyFilter(rows, filter, search, sisi) {
    let out = rows;
    if (filter === 'masalah') {
      out = out.filter((r) => r.status !== 'sinkron');
    } else if (filter) {
      out = out.filter((r) => r.status === filter);
    }
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          String(r.pin).toLowerCase().includes(q) ||
          String(r.name || '').toLowerCase().includes(q) ||
          String(sisi === 'app' ? r.device_name || '' : r.app_name || '').toLowerCase().includes(q)
      );
    }
    return out;
  }

  A.registerPage('sync', {
    title: 'Sinkron Karyawan',
    subtitle: 'Bandingkan data karyawan di aplikasi dengan isi mesin absensi',

    async render(root) {
      const devices = await A.call('devices.list');
      if (!devices.length) {
        A.setActions('');
        root.innerHTML = `<div class="card"><div class="card-body">${A.emptyState(
          'Belum ada mesin absensi',
          'Tambahkan mesin lebih dulu di halaman Mesin Absensi.',
          '⌗'
        )}</div></div>`;
        return;
      }

      if (!state.deviceId || !devices.some((d) => String(d.id) === String(state.deviceId))) {
        // Mesin yang sudah pernah dibaca lebih berguna dibuka lebih dulu
        // daripada mesin pertama menurut abjad yang mungkin masih kosong.
        const sudahDibaca = devices.find((d) => d.user_count > 0);
        state.deviceId = (sudahDibaca || devices[0]).id;
      }
      const deviceId = Number(state.deviceId);
      const device = devices.find((d) => String(d.id) === String(deviceId));
      const data = await A.call('devices.reconcile', { deviceId });

      A.setActions(
        `<button class="btn-primary" id="btnReread">Baca Ulang dari Mesin</button>`,
        {
          '#btnReread': async (e) => {
            await A.busy(e.currentTarget, async () => {
              const res = await A.callSafe('device.syncUsers', { id: deviceId });
              if (res && res.ok) {
                const t = res.templates;
                const jari = t && t.saved ? `, ${t.saved} sidik jari tersimpan di aplikasi` : '';
                const yatim = t && t.tanpaPin ? ` (${t.tanpaPin} dilewati tanpa PIN)` : '';
                A.toast(`${res.count} user dibaca dari mesin${jari}${yatim}`, 'ok', 7000);
              } else if (res) A.toast(res.error, 'err', 8000);
              await A.refresh();
            }, 'Membaca...');
          },
        }
      );

      A.setSubtitle(
        data.lastSync
          ? `${device.name} • terakhir dibaca ${A.fmt.dateTime(data.lastSync)}`
          : `${device.name} • belum pernah dibaca — tekan "Baca Ulang dari Mesin"`
      );

      const c = data.counts;
      const appRows = applyFilter(data.app, state.appFilter, state.appSearch, 'app');
      const deviceRows = applyFilter(data.device, state.deviceFilter, state.deviceSearch, 'device');
      const perluTindakan = c.hanyaApp + c.hanyaMesin + c.ubahApp + c.ubahMesin + c.bentrok + c.beda;

      A.prunePicks(pilih.app, appRows.map((r) => String(r.employee_id)));
      A.prunePicks(pilih.device, deviceRows.map((r) => String(r.pin)));
      const halApp = A.paginate('sync-app', appRows, { resetOn: [deviceId, state.appFilter, state.appSearch] });
      const halDev = A.paginate('sync-device', deviceRows, { resetOn: [deviceId, state.deviceFilter, state.deviceSearch] });
      const cocok = { app: appRows, device: deviceRows };

      root.innerHTML = `
        <div class="toolbar">
          <select id="device" style="min-width:250px">
            ${devices.map((d) => `<option value="${d.id}"${String(deviceId) === String(d.id) ? ' selected' : ''}>${A.esc(d.name)} — ${A.esc(d.ip)}</option>`).join('')}
          </select>
          <div class="spacer"></div>
          <div class="legend">
            ${['sinkron', 'hanya_app', 'hanya_mesin', 'ubah_app', 'ubah_mesin', 'bentrok']
              .map((k) => `<span class="k"><i style="background:${STATUS[k].color}"></i>${A.esc(STATUS[k].app || STATUS[k].device)}</span>`)
              .join('')}
          </div>
        </div>

        <div class="grid cols-4" style="margin-bottom:16px">
          <div class="stat green"><span class="label">Sudah Sinkron</span><span class="value num">${c.sinkron}</span><span class="hint">data sama di kedua sisi</span></div>
          <div class="stat" style="border-left-color:#2563eb"><span class="label">Belum di Mesin</span><span class="value num">${c.hanyaApp}</span><span class="hint">karyawan belum bisa absen</span></div>
          <div class="stat red"><span class="label">Belum di Aplikasi</span><span class="value num">${c.hanyaMesin}</span><span class="hint">scannya tidak masuk rekap</span></div>
          <div class="stat amber"><span class="label">Datanya Berubah</span><span class="value num">${c.ubahApp + c.ubahMesin + c.bentrok + c.beda}</span><span class="hint">${c.ubahApp} di aplikasi, ${c.ubahMesin} di mesin${c.bentrok ? `, ${c.bentrok} bentrok` : ''}</span></div>
        </div>

        ${device.fp_support === 0
          ? `<div class="warn-bar">
              <strong>${A.esc(device.name)} tidak mendukung transfer sidik jari lewat jaringan.</strong>
              Firmware mesin ini menolak perintah baca maupun tulis sidik jari — kirimannya diterima
              lalu dibuang tanpa keluhan. PIN, nama, kartu RFID, hak akses, dan password tetap bisa dikirim.
              Untuk sidik jari: rekam langsung di mesin, atau perbarui firmware-nya agar setara mesin lain.
            </div>`
          : ''}

        <div class="sync-split">
          ${tabelAplikasi(halApp, appRows.length, data.app, device)}
          ${tabelMesin(halDev, deviceRows.length, data.device, device)}
        </div>

        ${perluTindakan === 0 && data.device.length
          ? '<p class="small muted" style="text-align:center;margin-top:4px">Semua data karyawan sudah sama antara aplikasi dan mesin ini.</p>'
          : ''}
      `;

      // ---- filter & pencarian
      A.$('#device', root).addEventListener('change', (e) => {
        state.deviceId = e.target.value;
        pilih.app.clear();
        pilih.device.clear();
        state.appFilter = '';
        state.deviceFilter = '';
        state.appSearch = '';
        state.deviceSearch = '';
        A.refresh();
      });
      // Penyaringan ditunda sejenak supaya halaman tidak dibangun ulang tiap
      // ketukan tombol. Fokus dan posisi kursor dipulihkan oleh core.js.
      let timer = null;
      const pasangCari = (id, kunci) => {
        const el = A.$(`#${id}`, root);
        if (!el) return;
        el.addEventListener('input', (e) => {
          clearTimeout(timer);
          state[kunci] = e.target.value;
          timer = setTimeout(() => A.refresh(), 280);
        });
      };
      pasangCari('qApp', 'appSearch');
      pasangCari('qDevice', 'deviceSearch');
      const fApp = A.$('#filterApp', root);
      if (fApp) {
        fApp.addEventListener('change', (e) => {
          state.appFilter = e.target.value;
          A.refresh();
        });
      }
      const fDev = A.$('#filterDevice', root);
      if (fDev) {
        fDev.addEventListener('change', (e) => {
          state.deviceFilter = e.target.value;
          A.refresh();
        });
      }

      // ---- pilihan baris: header hanya mencentang halaman yang tampil
      const kotak = (group) => A.$$(`.pick[data-group="${group}"]`, root);
      function segarkanPilihan(group) {
        const n = pilih[group].size;
        const dicentang = kotak(group).filter((c2) => c2.checked).length;
        const all = A.$(`.pick-all[data-group="${group}"]`, root);
        if (all) {
          all.checked = dicentang > 0 && dicentang === kotak(group).length;
          all.indeterminate = dicentang > 0 && dicentang < kotak(group).length;
        }
        const info = A.$(`[data-pick-info="${group}"]`, root);
        if (!info) return;
        const total = cocok[group].length;
        info.innerHTML = !n
          ? ''
          : ` • <strong>${n} dipilih</strong>` +
            (n < total && dicentang === kotak(group).length
              ? ` <button class="link" data-act="pickAll" data-group="${group}">pilih semua ${total}</button>`
              : n > dicentang ? ` <span>(${n - dicentang} di halaman lain)</span>` : '') +
            ` <button class="link" data-act="pickClear" data-group="${group}">batal</button>`;
      }
      ['app', 'device'].forEach((group) => {
        kotak(group).forEach((c2) =>
          c2.addEventListener('change', () => {
            if (c2.checked) pilih[group].add(c2.value);
            else pilih[group].delete(c2.value);
            segarkanPilihan(group);
          })
        );
        const all = A.$(`.pick-all[data-group="${group}"]`, root);
        if (all) {
          all.addEventListener('change', () => {
            kotak(group).forEach((c2) => {
              c2.checked = all.checked;
              if (c2.checked) pilih[group].add(c2.value);
              else pilih[group].delete(c2.value);
            });
            segarkanPilihan(group);
          });
        }
        segarkanPilihan(group);
      });

      // ---- aksi
      A.bindActions(root, {
        pickAll: (d) => {
          cocok[d.group].forEach((r) => pilih[d.group].add(String(d.group === 'app' ? r.employee_id : r.pin)));
          segarkanPilihan(d.group);
        },
        pickClear: (d) => {
          pilih[d.group].clear();
          kotak(d.group).forEach((c2) => { c2.checked = false; });
          segarkanPilihan(d.group);
        },

        push: async (d, btn) => {
          const ids = picked('app').map(Number);
          if (!ids.length) return A.toast('Pilih karyawan di tabel kiri lebih dulu', 'warn');
          const ok = await A.confirm(`Kirim ${ids.length} karyawan ke ${device.name}?`, {
            title: 'Kirim ke Mesin',
            okLabel: 'Kirim',
            danger: false,
            detail:
              'Yang dikirim: PIN, nama, kartu RFID, hak akses, password, dan sidik jari yang tersimpan di aplikasi.\n' +
              'Sidik jari hanya ada bila sudah pernah dibaca dari mesin lain. Merekam jari baru tetap harus lewat sensor di mesin.' +
              (device.fp_support === 0
                ? '\n\nPERHATIAN: mesin ini sudah terbukti menolak sidik jari. Data user tetap masuk, sidik jarinya tidak.'
                : ''),
          });
          if (!ok) return undefined;
          return A.busy(btn, async () => {
            let res = await A.callSafe('device.pushEmployees', { id: deviceId, employeeIds: ids });
            if (res && res.needsConfirm) {
              const pilihan = await overwriteDialog(res, device);
              if (pilihan === 'skip') {
                res = await A.callSafe('device.pushEmployees', {
                  id: deviceId, employeeIds: ids, skipPins: res.conflicts.map((k) => k.pin),
                });
              } else if (pilihan === 'overwrite') {
                res = await A.callSafe('device.pushEmployees', { id: deviceId, employeeIds: ids, overwrite: true });
              } else {
                A.toast('Pengiriman dibatalkan. Tidak ada yang diubah di mesin.', 'warn');
                return;
              }
            }
            if (res && res.error && !res.sent) A.toast(res.error, 'err', 8000);
            else if (res) {
              const gagal = res.failed ? res.failed.length : 0;
              const j = res.jari || {};
              // Jumlah sidik jari dibaca ulang dari mesin, bukan dari yang dikirim.
              const jari = j.terkirim
                ? Number.isFinite(j.bertambah)
                  ? `, sidik jari di mesin: ${j.sebelum} → ${j.sesudah} (+${j.bertambah})`
                  : `, ${j.terkirim} sidik jari dikirim`
                : '';
              const tolak = j.terkirim && j.bertambah === 0
                ? ' — mesin menerima kiriman tetapi sidik jarinya tidak bertambah, firmware mesin ini kemungkinan menolak penulisan sidik jari'
                : '';
              pilih.app.clear();
              A.toast(
                `${res.sent.length} karyawan terkirim${gagal ? `, ${gagal} gagal` : ''}${jari}${tolak}`,
                gagal || tolak ? 'warn' : 'ok',
                tolak ? 12000 : 8000
              );
            }
            await A.refresh();
          }, 'Mengirim...');
        },

        import: async (d, btn) => {
          const pins = picked('device');
          if (!pins.length) return A.toast('Pilih user di tabel kanan lebih dulu', 'warn');
          const baru = data.device.filter((r) => pins.includes(r.pin) && !r.in_app);
          const sudahAda = pins.length - baru.length;
          if (!baru.length) {
            return A.toast('Semua yang dipilih sudah ada di aplikasi. Pakai "Ambil Data Mesin" untuk menyamakan.', 'warn', 6000);
          }
          return A.busy(btn, async () => {
            const res = await A.callSafe('employees.importFromDevice', {
              rows: baru.map((r) => ({
                user_pin: r.pin, name: r.name, card: r.card,
                privilege: r.privilege, password: r.password,
              })),
            });
            if (res) {
              pilih.device.clear();
              A.toast(
                `${res.created} karyawan ditambahkan${sudahAda ? `, ${sudahAda} dilewati karena sudah ada` : ''}`,
                'ok'
              );
            }
            await A.refresh();
          }, 'Mengimport...');
        },

        adopt: async (d, btn) => {
          const pins = picked('device').filter((p) => {
            const row = data.device.find((r) => r.pin === p);
            return row && row.in_app && row.status !== 'sinkron';
          });
          if (!pins.length) return A.toast('Pilih baris yang datanya berbeda di tabel kanan', 'warn');
          const ok = await A.confirm(`Timpa data ${pins.length} karyawan di aplikasi dengan data dari mesin?`, {
            title: 'Ambil Data Mesin',
            okLabel: 'Timpa di Aplikasi',
            detail: 'Nama, kartu RFID, dan hak akses di aplikasi diganti mengikuti mesin.',
          });
          if (!ok) return undefined;
          return A.busy(btn, async () => {
            const res = await A.callSafe('devices.adoptFromDevice', { deviceId, pins });
            if (res) {
              pilih.device.clear();
              A.toast(`${res.updated} karyawan disamakan dengan mesin`, 'ok');
            }
            await A.refresh();
          }, 'Menyamakan...');
        },

        removeAllFromDevice: async (d, btn) => {
          const jumlah = data.device.length;
          if (!jumlah) return A.toast('Belum ada data user dari mesin ini', 'warn');

          const punyaJari = data.device.filter((r) => r.finger_count > 0).length;
          const rincian = [
            `${jumlah} user akan dihapus dari mesin, termasuk sidik jarinya.`,
            punyaJari
              ? `${punyaJari} di antaranya punya sidik jari terdaftar — semuanya hilang dan hanya bisa dikembalikan dengan merekam ulang di mesin, atau menyalin dari mesin lain.`
              : 'Tidak ada sidik jari terdaftar di mesin ini.',
            'Log absensi yang tersimpan di mesin TIDAK ikut terhapus dan masih bisa ditarik.',
            'Data karyawan di aplikasi juga tidak tersentuh.',
          ];

          const ok = await A.confirm(`Hapus SEMUA ${jumlah} user dari ${device.name}?`, {
            title: 'Hapus Semua User di Mesin',
            okLabel: `Ya, Hapus ${jumlah} User`,
            detail: rincian.join('\n'),
          });
          if (!ok) return undefined;

          // Konfirmasi kedua: tindakan ini tidak bisa dibatalkan, dan pada mesin
          // dengan ratusan user akibatnya besar bila salah tekan.
          const yakin = await A.confirm('Sekali lagi: tindakan ini tidak bisa dibatalkan.', {
            title: 'Konfirmasi Terakhir',
            okLabel: 'Hapus Sekarang',
            detail: `Setelah ini ${device.name} tidak punya user sama sekali, dan tidak ada yang bisa absen di mesin itu sampai datanya dikirim ulang.`,
          });
          if (!yakin) return undefined;

          return A.busy(btn, async () => {
            const res = await A.callSafe('device.removeUsers', { id: deviceId, pins: null });
            if (res && res.removed) {
              const sisa = Number.isFinite(res.sisa) ? `, tersisa ${res.sisa} di mesin` : '';
              A.toast(`${res.removed.length} user dihapus dari mesin${sisa}`, res.failed && res.failed.length ? 'warn' : 'ok', 7000);
            }
            await A.refresh();
          }, 'Menghapus...');
        },

        removeFromDevice: async (d, btn) => {
          const pins = picked('device');
          if (!pins.length) return A.toast('Pilih user di tabel kanan lebih dulu', 'warn');
          const ok = await A.confirm(`Hapus ${pins.length} user dari ${device.name}?`, {
            okLabel: 'Hapus dari Mesin',
            detail: 'Sidik jari user tersebut ikut terhapus dari mesin dan tidak bisa dikembalikan kecuali disalin dari mesin lain. Log absensi yang sudah tertarik tetap aman.',
          });
          if (!ok) return undefined;
          return A.busy(btn, async () => {
            const res = await A.callSafe('device.removeUsers', { id: deviceId, pins });
            if (res && res.removed) {
              pilih.device.clear();
              A.toast(`${res.removed.length} user dihapus dari mesin`, 'ok');
            }
            await A.refresh();
          }, 'Menghapus...');
        },
      });
    },
  });

  // ------------------------------------------------------------- tabel kiri

  function filterSelect(id, value, opsi) {
    return `<select id="${id}" class="btn-sm" style="width:auto;padding:4px 8px">
      ${opsi.map((o) => `<option value="${o.value}"${String(value) === String(o.value) ? ' selected' : ''}>${A.esc(o.label)}</option>`).join('')}
    </select>`;
  }

  function tabelAplikasi(hal, cocok, semua, device) {
    return `<div class="card" style="margin:0">
      <div class="card-head">
        <div>
          <h3>Karyawan di Aplikasi</h3>
          <div class="sub">${semua.length} karyawan • ${cocok} cocok filter<span data-pick-info="app"></span></div>
        </div>
        <div class="pill-row">
          ${searchBox('qApp', state.appSearch)}
          ${filterSelect('filterApp', state.appFilter, [
            { value: '', label: 'Semua status' },
            { value: 'masalah', label: 'Perlu tindakan' },
            { value: 'hanya_app', label: 'Belum di mesin' },
            { value: 'ubah_app', label: 'Diubah di aplikasi' },
            { value: 'ubah_mesin', label: 'Diubah di mesin' },
            { value: 'sinkron', label: 'Sudah sinkron' },
          ])}
          <button class="btn-primary btn-sm" data-act="push">Kirim ke Mesin →</button>
        </div>
      </div>
      <div class="card-body flush" style="max-height:60vh;overflow:auto">
        ${A.table(
          [
            { labelHtml: selectAllHeader('app'), className: 'c', render: (r) => checkbox('app', r.employee_id) },
            { label: 'PIN', className: 'c num', render: (r) => `<strong>${A.esc(r.pin)}</strong>` },
            {
              label: 'Nama',
              render: (r) =>
                `<strong>${A.esc(r.name)}</strong>${r.active ? '' : ' <span class="badge soft">Nonaktif</span>'}` +
                `<div class="small muted">${A.esc(r.department_name || 'Tanpa departemen')}</div>${diffText(r)}`,
            },
            { label: 'Kartu', className: 'c', render: (r) => cardText(r.card) },
            { label: 'Hak Akses', className: 'c', render: (r) => `<span class="small">${A.esc(priv(r.privilege))}</span>` },
            {
              labelHtml: '<span title="Sidik jari yang tersimpan di aplikasi. Tidak berubah saat mesin di atas diganti.">Sidik Jari</span>',
              className: 'c',
              render: (r) => fingerBadgeApp(r.fingers_stored, r.fingers_stored_source),
            },
            { label: 'Status', className: 'c', render: (r) => statusBadge(r.status, 'app') },
          ],
          hal.rows,
          { empty: `Tidak ada karyawan yang cocok dengan filter.` }
        )}
      </div>
      ${hal.controls}
      <div class="card-head" style="border-top:1px solid var(--border);border-bottom:0;display:block">
        <div class="small muted">Status dilihat dari sisi aplikasi terhadap ${A.esc(device.name)}</div>
        <div class="small muted" style="margin-top:3px">
          Kolom <strong>Sidik Jari</strong> di sini = jumlah yang <strong>tersimpan di aplikasi</strong>,
          tidak berubah saat mesin di atas diganti. Yang ada di mesin ditampilkan di tabel kanan.
        </div>
        <div class="small muted" style="margin-top:3px">
          <strong>Kirim ke Mesin</strong> mengirim PIN, nama, kartu RFID, hak akses, password,
          <strong>dan sidik jari</strong> yang tersimpan di aplikasi — sekaligus, satu tindakan.
          Sidik jari masuk ke aplikasi saat menekan <strong>Baca Ulang dari Mesin</strong>.
        </div>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------ tabel kanan

  function tabelMesin(hal, cocok, semua, device) {
    return `<div class="card" style="margin:0">
      <div class="card-head">
        <div>
          <h3>Karyawan di Mesin</h3>
          <div class="sub">${A.esc(device.name)} • ${semua.length} user • ${cocok} cocok filter<span data-pick-info="device"></span></div>
        </div>
        <div class="pill-row">
          ${searchBox('qDevice', state.deviceSearch)}
          ${filterSelect('filterDevice', state.deviceFilter, [
            { value: '', label: 'Semua status' },
            { value: 'masalah', label: 'Perlu tindakan' },
            { value: 'hanya_mesin', label: 'Belum di aplikasi' },
            { value: 'ubah_mesin', label: 'Diubah di mesin' },
            { value: 'ubah_app', label: 'Diubah di aplikasi' },
            { value: 'sinkron', label: 'Sudah sinkron' },
          ])}
          <button class="btn-primary btn-sm" data-act="import">← Import</button>
          <button class="btn-sm" data-act="adopt">← Ambil Data</button>
          <button class="btn-danger btn-sm" data-act="removeFromDevice">Hapus</button>
          <button class="btn-sm btn-danger-soft" data-act="removeAllFromDevice">Hapus Semua</button>
        </div>
      </div>
      <div class="card-body flush" style="max-height:60vh;overflow:auto">
        ${A.table(
          [
            { labelHtml: selectAllHeader('device'), className: 'c', render: (r) => checkbox('device', r.pin) },
            { label: 'PIN', className: 'c num', render: (r) => `<strong>${A.esc(r.pin)}</strong>` },
            {
              label: 'Nama di Mesin',
              render: (r) =>
                `<strong>${A.esc(r.name || '(tanpa nama)')}</strong>` +
                (r.in_app && r.app_name && r.app_name !== r.name
                  ? `<div class="small muted">di aplikasi: ${A.esc(r.app_name)}</div>`
                  : '') +
                diffText(r),
            },
            { label: 'Kartu', className: 'c', render: (r) => cardText(r.card) },
            {
              labelHtml: '<span title="Sidik jari yang benar-benar ada di mesin ini">Sidik Jari</span>',
              className: 'c',
              render: (r) => fingerBadgeDevice(r.finger_count),
            },
            { label: 'Status', className: 'c', render: (r) => statusBadge(r.status, 'device') },
          ],
          hal.rows,
          { empty: 'Belum ada data user dari mesin ini. Tekan "Baca Ulang dari Mesin".' }
        )}
      </div>
      ${hal.controls}
      <div class="card-head" style="border-top:1px solid var(--border);border-bottom:0">
        <span class="small muted">Status dilihat dari sisi mesin terhadap data aplikasi</span>
      </div>
    </div>`;
  }
})();
