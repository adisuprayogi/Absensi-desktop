/**
 * Menjalankan aplikasi sungguhan, membuka tiap halaman, mengumpulkan error
 * JavaScript di halaman, lalu menyimpan tangkapan layar tiap halaman.
 *
 *   npx electron test/ui.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SHOT_DIR = path.join(__dirname, 'screenshots');
const PAGES = ['dashboard', 'employees', 'shifts', 'schedules', 'devices', 'sync', 'logs', 'leaves', 'reports', 'settings'];

const problems = [];

// Data uji dipisahkan dari data aplikasi yang sesungguhnya, supaya pengujian
// bisa diulang dari nol dan tidak mengganggu data pengguna. Harus dipasang
// sebelum main.js dimuat, karena di situlah database dibuka.
const TEST_USER_DATA = path.join(__dirname, '.userdata');
fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
fs.mkdirSync(TEST_USER_DATA, { recursive: true });
app.setPath('userData', TEST_USER_DATA);

require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWindow() {
  for (let i = 0; i < 60; i++) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length && !wins[0].webContents.isLoading()) return wins[0];
    await wait(250);
  }
  throw new Error('Jendela utama tidak pernah siap');
}

app.whenReady().then(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const win = await waitForWindow();
  win.setSize(1440, 900);

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    // level 3 = error
    if (level >= 3) problems.push(`console: ${message} (${path.basename(source || '')}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) =>
    problems.push(`renderer mati: ${details.reason}`)
  );

  // Beri data contoh supaya halaman tidak semuanya kosong.
  const db = require('../src/main/db');
  const { employees, shifts, leaveTypes, leaves, settings } = require('../src/main/services/masters');
  const { devices } = require('../src/main/services/devices');
  const { insertLogs } = require('../src/main/services/attendance');

  if (employees.list().length === 0) {
    settings.set('company_name', 'PT Contoh Sejahtera');
    const pagi = shifts.list().find((s) => s.code === 'P');
    const malam = shifts.list().find((s) => s.code === 'M');
    const deptId = db.get().prepare('INSERT INTO departments (name) VALUES (?)').run('Produksi').lastInsertRowid;
    const dept2 = db.get().prepare('INSERT INTO departments (name) VALUES (?)').run('Administrasi').lastInsertRowid;

    const names = [
      ['101', 'Ahmad Fauzi', deptId, pagi.id, 'Operator'],
      ['102', 'Siti Rahayu', dept2, pagi.id, 'Staf Administrasi'],
      ['103', 'Budi Santoso', deptId, malam.id, 'Operator Malam'],
      ['104', 'Dewi Lestari', dept2, pagi.id, 'Bendahara'],
      ['105', 'Rizky Pratama', deptId, pagi.id, 'Teknisi'],
    ];
    const ids = names.map(([pin, name, dep, shift, pos]) =>
      employees.create({ pin, name, department_id: dep, default_shift_id: shift, position: pos, join_date: '2024-01-15' })
    );

    const devLobi = devices.create({ name: 'Mesin Lobi Utama', ip: '127.0.0.1', port: 4370, live_capture: 0 });
    devices.create({ name: 'Mesin Gudang', ip: '192.168.1.202', port: 4370 });

    // Bila test/fake-machine.js sedang jalan, tarik daftar user aslinya supaya
    // halaman Sinkron Karyawan menampilkan perbandingan yang sungguhan.
    const { DeviceManager } = require('../src/main/zk/manager');
    const mgr = new DeviceManager();
    const sync = await mgr.syncUsers(devLobi);
    console.log(sync.ok
      ? `  info  │ mesin tiruan terbaca: ${sync.count} user`
      : `  info  │ mesin tidak terhubung (${sync.error}) — dipakai data semaian`);
    if (sync.ok) {
      // Uji jalur tulis lewat lapisan aplikasi: kirim dua karyawan ke mesin.
      const push = await mgr.pushEmployees(devLobi, ids.slice(0, 2));
      console.log(`  info  │ kirim karyawan ke mesin: ${push.sent ? push.sent.length : 0} berhasil, ${push.failed ? push.failed.length : 0} gagal`);
      if (push.failed && push.failed.length) problems.push(`kirim karyawan gagal: ${push.failed[0].error}`);

      // Ubah satu karyawan di aplikasi SETELAH tersinkron, supaya halaman
      // Sinkron Karyawan memperlihatkan status "Diubah di aplikasi".
      const emp = employees.find(ids[0]);
      employees.update(ids[0], { ...emp, card: 8801234 });
    } else {
      // Tanpa mesin yang bisa dihubungi, isi daftar user mesin langsung ke
      // database. Halaman Sinkron Karyawan jadi tetap punya data di kedua sisi,
      // sehingga pengujiannya tidak bergantung pada mesin tiruan yang berjalan.
      devices.saveUsers(
        devLobi,
        [
          { uid: 1, userId: '101', name: 'Ahmad Fauzi', privilege: 0, card: 0 },
          { uid: 2, userId: '102', name: 'Siti Rahayu', privilege: 0, card: 0 },
          { uid: 3, userId: '103', name: 'Budi Santoso', privilege: 0, card: 0 },
          { uid: 9, userId: '900', name: 'Satpam Malam', privilege: 0, card: 0 },
        ],
        new Map([[1, 2], [2, 1], [3, 0]])
      );
      employees.update(ids[0], { ...employees.find(ids[0]), card: 8801234 });
    }
    await mgr.shutdown();

    // Log absensi seminggu terakhir.
    const today = new Date();
    const logs = [];
    for (let back = 6; back >= 0; back--) {
      const d = new Date(today);
      d.setDate(d.getDate() - back);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      logs.push({ userId: '101', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 52, 0) });
      logs.push({ userId: '101', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 8, 0) });
      logs.push({ userId: '102', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 19, 0) });
      logs.push({ userId: '102', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 45, 0) });
      logs.push({ userId: '104', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 58, 0) });
      if (back !== 2) {
        logs.push({ userId: '104', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 16, 30, 0) });
      }
      logs.push({ userId: '105', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 3, 0) });
      logs.push({ userId: '105', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 20, 0) });
      logs.push({ userId: '103', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 55, 0) });
      logs.push({ userId: '103', timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 6, 5, 0) });
    }
    insertLogs(1, logs, 'tarik');

    const p = (n) => String(n).padStart(2, '0');
    const iso = (dd) => `${dd.getFullYear()}-${p(dd.getMonth() + 1)}-${p(dd.getDate())}`;
    const cuti = new Date(today);
    cuti.setDate(cuti.getDate() - 3);
    leaves.create({
      employee_id: ids[1],
      leave_type_id: leaveTypes.list().find((t) => t.code === 'C').id,
      start_date: iso(cuti),
      end_date: iso(cuti),
      note: 'Keperluan keluarga',
    });

    await win.webContents.reload();
    await wait(1500);
  }

  for (const page of PAGES) {
    try {
      await win.webContents.executeJavaScript(`window.App.go(${JSON.stringify(page)})`);
      await wait(900);
      const title = await win.webContents.executeJavaScript('document.getElementById("pageTitle").textContent');
      const errorCard = await win.webContents.executeJavaScript(
        'document.body.innerText.includes("Halaman gagal dimuat")'
      );
      if (errorCard) problems.push(`halaman "${page}" menampilkan pesan gagal dimuat`);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SHOT_DIR, `${page}.png`), image.toPNG());
      console.log(`  ${errorCard ? 'GAGAL' : '  OK '} │ ${page} (judul: ${title})`);
    } catch (err) {
      problems.push(`halaman "${page}": ${err.message}`);
      console.log(`  GAGAL │ ${page} — ${err.message}`);
    }
  }

  // Pekerjaan ke mesin bisa berjalan lama. Panel kemajuan harus muncul, angkanya
  // naik, lalu hilang sendiri setelah selesai.
  try {
    const { MockDevice } = require('./mock-device');
    // Jeda balasan dipasang supaya prosesnya cukup lama untuk diamati,
    // seperti perangkat asli yang memang tidak instan.
    const mesinLambat = new MockDevice({ users: [], attendance: [], replyDelay: 45 });
    const portLambat = await mesinLambat.listen();
    const devLambat = devices.create({ name: 'Mesin Uji Kemajuan', ip: '127.0.0.1', port: portLambat });
    const idsKirim = employees.list().map((e) => e.id);

    const hasil = await win.webContents.executeJavaScript(`
      (async () => {
        const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
        const panel = () => document.getElementById('progressPanel');
        const teks = (id) => (document.getElementById(id) || {}).textContent || '';
        const lebar = () => (document.getElementById('progressFill') || {}).style.width || '';

        const awalTersembunyi = panel().hidden;
        // Dijalankan tanpa ditunggu, supaya bisa diamati saat sedang berjalan.
        const janji = window.api.call('device.pushEmployees', { id: ${devLambat}, employeeIds: ${JSON.stringify(idsKirim)} });

        const contoh = [];
        for (let i = 0; i < 25; i++) {
          await tunggu(120);
          if (!panel().hidden) {
            contoh.push({ judul: teks('progressTitle'), hitung: teks('progressCount'),
                          fase: teks('progressPhase'), label: teks('progressLabel'), lebar: lebar() });
          }
        }
        await janji;
        await tunggu(2400);
        return { awalTersembunyi, contoh, akhirTersembunyi: panel().hidden };
      })()
    `);

    // Bentuknya "8 / 15": dipecah manual, bukan dengan regex, supaya tidak ada
    // escape yang bisa tertelan saat berkas ini disunting lewat skrip.
    const berhitung = hasil.contoh.filter((c) => {
      const bagian = String(c.hitung).split('/');
      return bagian.length === 2 && Number(bagian[0].trim()) > 0 && Number(bagian[1].trim()) > 0;
    });
    const angka = berhitung.map((c) => Number(c.hitung.split('/')[0].trim()));
    const naik = angka.length >= 2 && angka[angka.length - 1] > angka[0];
    const adaNama = hasil.contoh.some((c) => c.label && c.label.includes('—'));
    const adaJudul = hasil.contoh.some((c) => /Mesin Uji Kemajuan/.test(c.judul));

    const cek = [
      ['panel kemajuan tersembunyi saat menganggur', hasil.awalTersembunyi],
      ['panel muncul selama pengiriman', hasil.contoh.length > 0],
      ['judul menyebut nama mesin tujuan', adaJudul],
      ['penghitung naik selama proses', naik],
      ['nama karyawan yang sedang dikirim ditampilkan', adaNama],
      ['panel hilang sendiri setelah selesai', hasil.akhirTersembunyi],
    ];
    for (const [nama, lolos] of cek) {
      if (!lolos) problems.push(`kemajuan: ${nama}`);
      console.log(`  ${lolos ? '  OK ' : 'GAGAL'} │ ${nama}`);
    }
    if (naik) console.log(`         (terpantau ${angka[0]} → ${angka[angka.length - 1]} dari ${idsKirim.length})`);

    await mesinLambat.close();
    devices.remove(devLambat);
  } catch (err) {
    problems.push(`uji kemajuan: ${err.message}`);
  }

  // Pilih banyak baris di halaman Karyawan: baris aksi harus muncul, jumlahnya
  // benar, dan centang tidak boleh hilang saat baris aksi diperbarui.
  try {
    await win.webContents.executeJavaScript(`window.App.go('employees')`);
    await wait(1000);
    const hasil = await win.webContents.executeJavaScript(`
      (async () => {
        const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
        const bar = () => document.getElementById('bulkBar');
        const jumlah = () => Number(document.getElementById('bulkCount').textContent);
        const centang = () => [...document.querySelectorAll('#content .pick')];
        const semua = document.querySelector('#content .pick-all');
        if (!semua) return { galat: 'kotak pilih-semua tidak ada' };

        const awalTersembunyi = bar().hidden;

        semua.checked = true;
        semua.dispatchEvent(new Event('change', { bubbles: true }));
        await tunggu(200);
        const total = centang().length;
        const setelahSemua = { tampil: !bar().hidden, n: jumlah(), tercentang: centang().filter((c) => c.checked).length };

        const satu = centang()[0];
        satu.checked = false;
        satu.dispatchEvent(new Event('change', { bubbles: true }));
        await tunggu(200);
        const setelahLepasSatu = { n: jumlah(), sebagian: semua.indeterminate };

        document.querySelector('[data-act="bulkClear"]').click();
        await tunggu(250);
        const setelahBatal = { tersembunyi: bar().hidden, tercentang: centang().filter((c) => c.checked).length };

        return { awalTersembunyi, total, setelahSemua, setelahLepasSatu, setelahBatal };
      })()
    `);

    if (hasil.galat) {
      problems.push(`uji pilih banyak: ${hasil.galat}`);
    } else {
      const cek = [
        ['baris aksi tersembunyi sebelum ada yang dipilih', hasil.awalTersembunyi],
        ['pilih semua mencentang seluruh baris', hasil.setelahSemua.tercentang === hasil.total && hasil.setelahSemua.n === hasil.total],
        ['baris aksi muncul saat ada pilihan', hasil.setelahSemua.tampil],
        ['jumlah berkurang saat satu dilepas', hasil.setelahLepasSatu.n === hasil.total - 1],
        ['pilih-semua jadi separuh saat sebagian dipilih', hasil.setelahLepasSatu.sebagian],
        ['Batal Pilih mengosongkan pilihan', hasil.setelahBatal.tersembunyi && hasil.setelahBatal.tercentang === 0],
      ];
      for (const [nama, lolos] of cek) {
        if (!lolos) problems.push(`pilih banyak: ${nama}`);
        console.log(`  ${lolos ? '  OK ' : 'GAGAL'} │ ${nama}`);
      }
    }
  } catch (err) {
    problems.push(`uji pilih banyak: ${err.message}`);
  }

  // Kedua tabel di halaman Sinkron Karyawan harus sama-sama menampilkan jumlah
  // sidik jari. Tanpa kolom ini di sisi aplikasi, admin tidak bisa tahu siapa
  // yang sudah didaftarkan ke mesin tetapi belum merekam jarinya.
  try {
    await win.webContents.executeJavaScript(`window.App.go('sync')`);
    await wait(1100);
    const header = await win.webContents.executeJavaScript(`
      (() => {
        const kartu = [...document.querySelectorAll('.sync-split > .card')];
        return kartu.map((c) => {
          const judul = c.querySelector('h3') ? c.querySelector('h3').textContent : '?';
          const kolom = [...c.querySelectorAll('th')].map((t) => t.textContent.trim());
          return judul + ' :: ' + kolom.join('|');
        }).join(' ;; ');
      })()
    `);
    const kartuKiri = header.split(' ;; ')[0] || '';
    const adaKolom = /Sidik Jari/i.test(kartuKiri);
    if (!adaKolom) problems.push(`tabel "Karyawan di Aplikasi" tanpa kolom Sidik Jari: ${kartuKiri}`);
    console.log(`  ${adaKolom ? '  OK ' : 'GAGAL'} │ kolom Sidik Jari ada di tabel Karyawan di Aplikasi`);
  } catch (err) {
    problems.push(`uji kolom Sidik Jari: ${err.message}`);
  }
  // Kotak cari harus tetap menerima ketikan setelah halaman disaring ulang.
  // Dulu fokus hilang begitu hasil saringan dimuat: huruf pertama masuk, huruf
  // berikutnya jatuh ke luar kolom, sehingga pencarian tampak tidak berfungsi.
  try {
    await win.webContents.executeJavaScript(`window.App.go('sync')`);
    await wait(1100);

    const hasil = await win.webContents.executeJavaScript(`
      (async () => {
        const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
        const barisTabel = (n) => {
          const kartu = document.querySelectorAll('.sync-split > .card')[n];
          return [...kartu.querySelectorAll('tbody tr')].filter(
            (tr) => !tr.querySelector('.empty')
          ).length;
        };
        const sebelumKiri = barisTabel(0);
        const sebelumKanan = barisTabel(1);

        // Ketik huruf demi huruf, seperti pengguna sungguhan.
        const kotak = document.getElementById('qApp');
        if (!kotak) return { galat: 'kotak cari qApp tidak ada' };
        kotak.focus();
        for (const ch of 'Budi') {
          const aktif = document.getElementById('qApp');
          aktif.value += ch;
          aktif.dispatchEvent(new Event('input', { bubbles: true }));
          await tunggu(120);
        }
        await tunggu(900);

        const fokusId = document.activeElement ? document.activeElement.id : '(tidak ada)';
        const isiKotak = document.getElementById('qApp') ? document.getElementById('qApp').value : '';
        return {
          sebelumKiri, sebelumKanan,
          sesudahKiri: barisTabel(0),
          sesudahKanan: barisTabel(1),
          fokusId, isiKotak,
        };
      })()
    `);

    if (hasil.galat) {
      problems.push(`uji pencarian: ${hasil.galat}`);
    } else {
      const fokusTetap = hasil.fokusId === 'qApp';
      const ketikanUtuh = hasil.isiKotak === 'Budi';
      const kiriMenyaring = hasil.sesudahKiri < hasil.sebelumKiri && hasil.sesudahKiri > 0;
      const kananTetap = hasil.sesudahKanan === hasil.sebelumKanan;

      if (!fokusTetap) problems.push(`fokus kotak cari hilang setelah menyaring (fokus di: ${hasil.fokusId})`);
      if (!ketikanUtuh) problems.push(`ketikan tidak utuh di kotak cari: "${hasil.isiKotak}" (harap "Budi")`);
      if (!kiriMenyaring) problems.push(`tabel kiri tidak tersaring: ${hasil.sebelumKiri} -> ${hasil.sesudahKiri}`);
      if (!kananTetap) problems.push(`tabel kanan ikut tersaring padahal pencariannya terpisah: ${hasil.sebelumKanan} -> ${hasil.sesudahKanan}`);

      console.log(`  ${fokusTetap ? '  OK ' : 'GAGAL'} │ fokus kotak cari bertahan saat mengetik (isi: "${hasil.isiKotak}")`);
      console.log(`  ${kiriMenyaring ? '  OK ' : 'GAGAL'} │ pencarian menyaring tabel kiri (${hasil.sebelumKiri} -> ${hasil.sesudahKiri})`);
      console.log(`  ${kananTetap ? '  OK ' : 'GAGAL'} │ tabel kanan tidak ikut tersaring (${hasil.sebelumKanan} -> ${hasil.sesudahKanan})`);
    }
  } catch (err) {
    problems.push(`uji pencarian: ${err.message}`);
  }
  // Pendengar aksi dari halaman sebelumnya tidak boleh ikut menangani klik di
  // halaman baru. Dulu tombol "Ubah" di Mesin Absensi malah membuka form
  // karyawan, karena kedua halaman memakai nama aksi yang sama.
  try {
    await win.webContents.executeJavaScript(`window.App.go('employees')`);
    await wait(900);
    await win.webContents.executeJavaScript(`window.App.go('devices')`);
    await wait(900);
    const judul = await win.webContents.executeJavaScript(`
      (async () => {
        const btn = document.querySelector('#content [data-act="edit"]');
        if (!btn) return 'TOMBOL TIDAK ADA';
        btn.click();
        await new Promise((r) => setTimeout(r, 700));
        const h = document.querySelector('#modal .modal-head h3');
        return h ? h.textContent : 'DIALOG TIDAK TERBUKA';
      })()
    `);
    const benar = judul.startsWith('Ubah Mesin');
    if (!benar) problems.push(`tombol Ubah di halaman Mesin membuka dialog salah: "${judul}"`);
    console.log(`  ${benar ? '  OK ' : 'GAGAL'} │ tombol Ubah mesin membuka dialog yang benar (${judul})`);
    await win.webContents.executeJavaScript(`window.App.closeModal(null)`);
  } catch (err) {
    problems.push(`uji tombol Ubah: ${err.message}`);
  }

  console.log('');
  if (problems.length) {
    console.log('MASALAH DITEMUKAN:');
    problems.forEach((p) => console.log(`  - ${p}`));
  } else {
    console.log('Semua halaman termuat tanpa error.');
  }
  console.log(`Tangkapan layar: ${SHOT_DIR}\n`);
  app.exit(problems.length ? 1 : 0);
});
