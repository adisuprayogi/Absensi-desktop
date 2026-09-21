/**
 * Uji klien protokol ZK terhadap mesin absensi tiruan.
 * Tidak memerlukan Electron maupun perangkat fisik:
 *
 *   node test/zk-protocol.js
 */
'use strict';

const { ZKClient } = require('../src/main/zk/client');
const { MockDevice } = require('./mock-device');

const results = [];
let failed = 0;

function check(name, condition, detail = '') {
  if (!condition) failed += 1;
  results.push(`${condition ? '  OK  ' : ' GAGAL'} │ ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `dapat ${JSON.stringify(actual)}, harap ${JSON.stringify(expected)}`);
}

const USERS = [
  { uid: 1, userId: '101', name: 'Ahmad Fauzi', privilege: 0 },
  { uid: 2, userId: '102', name: 'Siti Rahayu', privilege: 14 },
  { uid: 3, userId: '103', name: 'Budi Santoso', privilege: 0 },
];

const ATT = [
  { uid: 1, userId: '101', timestamp: new Date(2026, 8, 1, 7, 55, 12), status: 1, punch: 0 },
  { uid: 1, userId: '101', timestamp: new Date(2026, 8, 1, 17, 3, 40), status: 1, punch: 1 },
  { uid: 2, userId: '102', timestamp: new Date(2026, 8, 1, 8, 12, 5), status: 1, punch: 0 },
  { uid: 3, userId: '103', timestamp: new Date(2026, 8, 1, 21, 58, 0), status: 15, punch: 0 },
];

async function testProtocol(protocol) {
  const label = protocol.toUpperCase();
  const device = new MockDevice({ users: USERS, attendance: ATT, protocol });
  const port = await device.listen();

  const zk = new ZKClient({ ip: '127.0.0.1', port, protocol, timeout: 5000 });
  try {
    await zk.connect();
    check(`${label}: terhubung ke mesin`, zk.connected);
    eq(`${label}: session id diambil dari balasan mesin`, zk.sessionId, 0x1234);

    eq(`${label}: baca versi firmware`, await zk.getFirmwareVersion(), 'Ver 6.60 Aug 25 2020');
    eq(`${label}: baca nama perangkat`, await zk.getDeviceName(), 'X105');
    eq(`${label}: baca serial number`, await zk.getSerialNumber(), 'CJZC201960385');

    const sizes = await zk.getSizes();
    eq(`${label}: jumlah user dari mesin`, sizes.users, 3);
    eq(`${label}: jumlah log dari mesin`, sizes.records, 4);
    eq(`${label}: kapasitas log`, sizes.recordCapacity, 100000);

    // Jalur CMD_PREPARE_DATA + rentetan CMD_DATA
    const users = await zk.getUsers();
    eq(`${label}: jumlah user terbaca`, users.length, 3);
    eq(`${label}: PIN user pertama`, users[0].userId, '101');
    eq(`${label}: nama user pertama`, users[0].name, 'Ahmad Fauzi');
    eq(`${label}: hak akses admin terbaca`, users[1].privilege, 14);

    // Jalur CMD_ACK_OK + tarik per potongan (CMD_DATA_RDY)
    const logs = await zk.getAttendance();
    eq(`${label}: jumlah log terbaca`, logs.length, 4);
    eq(`${label}: PIN log pertama`, logs[0].userId, '101');
    eq(
      `${label}: waktu log pertama utuh`,
      logs[0].timestamp.getTime(),
      new Date(2026, 8, 1, 7, 55, 12).getTime()
    );
    eq(`${label}: mode verifikasi wajah terbaca`, logs[3].status, 15);
    eq(`${label}: penanda masuk/pulang terbaca`, logs[1].punch, 1);

    // Penyaringan berdasarkan waktu
    const recent = await zk.getAttendance(new Date(2026, 8, 1, 12, 0, 0));
    eq(`${label}: filter log setelah jam tertentu`, recent.length, 2);

    await zk.disableDevice();
    check(`${label}: mesin dikunci saat transfer`, zk.deviceEnabled === false);
    await zk.enableDevice();
    check(`${label}: mesin dibuka kembali`, zk.deviceEnabled === true);

    await zk.setTime(new Date(2026, 8, 7, 10, 30, 0));
    check(`${label}: perintah samakan jam diterima mesin`, device.timeSetTo > 0);

    // Live capture
    const scans = [];
    zk.on('attendance', (rec) => scans.push(rec));
    await zk.startLive();
    check(`${label}: mode realtime aktif`, zk.liveMode);
    eq(`${label}: mesin menerima pendaftaran event absensi`, device.liveFlags, 1);

    device.pushScan({ userId: '102', timestamp: new Date(2026, 8, 7, 8, 1, 9) });
    device.pushScan({ userId: '103', timestamp: new Date(2026, 8, 7, 8, 2, 30) });
    await new Promise((r) => setTimeout(r, 250));

    eq(`${label}: dua scan realtime diterima`, scans.length, 2);
    eq(`${label}: PIN scan realtime`, scans[0].userId, '102');
    eq(
      `${label}: waktu scan realtime`,
      scans[0].timestamp.getTime(),
      new Date(2026, 8, 7, 8, 1, 9).getTime()
    );

    await zk.stopLive();
    check(`${label}: mode realtime dimatikan`, !zk.liveMode);

    await zk.clearAttendance();
    eq(`${label}: log mesin dikosongkan`, (await zk.getAttendance()).length, 0);
  } finally {
    await zk.disconnect().catch(() => {});
    await device.close();
  }
}

/** Menulis user, kartu RFID, hak akses, penghapusan, dan salin sidik jari. */
async function testWrite() {
  const fingers = [
    { uid: 1, fid: 0, valid: 1, template: Buffer.alloc(320, 0xa5) },
    { uid: 1, fid: 1, valid: 1, template: Buffer.alloc(280, 0x5a) },
    { uid: 2, fid: 0, valid: 1, template: Buffer.alloc(300, 0x33) },
  ];
  const device = new MockDevice({
    users: USERS.map((u) => ({ ...u })),
    attendance: [],
    fingers: fingers.map((f) => ({ ...f })),
  });
  const port = await device.listen();
  const zk = new ZKClient({ ip: '127.0.0.1', port, timeout: 5000 });

  try {
    await zk.connect();

    // --- buat user baru lengkap dengan kartu RFID
    await zk.setUser({
      uid: 20,
      userId: '201',
      name: 'Karyawan Baru',
      privilege: 0,
      card: 1234567,
    });
    let users = await zk.getUsers();
    const baru = users.find((u) => u.userId === '201');
    check('tulis user baru: user muncul di mesin', !!baru);
    eq('tulis user baru: nama tersimpan', baru && baru.name, 'Karyawan Baru');
    eq('tulis user baru: kartu RFID tersimpan', baru && baru.card, 1234567);
    check('tulis user: mesin diminta muat ulang data', device.refreshCount > 0);

    // --- timpa user yang sudah ada
    await zk.setUser({
      uid: 1,
      userId: '101',
      name: 'Ahmad Fauzi Revisi',
      privilege: 14,
      card: 7654321,
    });
    users = await zk.getUsers();
    const diubah = users.find((u) => u.userId === '101');
    eq('timpa user: nama berubah', diubah && diubah.name, 'Ahmad Fauzi Revisi');
    eq('timpa user: hak akses berubah jadi admin', diubah && diubah.privilege, 14);
    eq('timpa user: kartu RFID berubah', diubah && diubah.card, 7654321);
    eq('timpa user: jumlah user tidak bertambah', users.length, USERS.length + 1);

    // --- nama non-ASCII harus utuh bolak-balik
    await zk.setUser({ uid: 21, userId: '202', name: 'Ibnu Ath-thufail', card: 0 });
    users = await zk.getUsers();
    eq('nama dengan tanda hubung utuh', users.find((u) => u.userId === '202').name, 'Ibnu Ath-thufail');

    // --- baca template sidik jari
    const templates = await zk.getFingerprints();
    eq('baca sidik jari: jumlah template', templates.length, 3);
    eq('baca sidik jari: panjang template pertama', templates[0].template.length, 320);
    check(
      'baca sidik jari: isi template utuh',
      templates[0].template.equals(Buffer.alloc(320, 0xa5))
    );
    eq('baca sidik jari: nomor jari terbaca', templates[1].fid, 1);

    // --- tulis user beserta sidik jarinya (jalur salin antar mesin)
    const copied = templates.filter((t) => t.uid === 1);
    await zk.saveUserWithTemplates(
      { uid: 30, userId: '301', name: 'Hasil Salinan', privilege: 0, card: 555 },
      copied.map((t) => ({ ...t, uid: 30 }))
    );
    users = await zk.getUsers();
    const salinan = users.find((u) => u.userId === '301');
    check('salin sidik jari: user tujuan dibuat', !!salinan);
    eq('salin sidik jari: kartu ikut tersalin', salinan && salinan.card, 555);

    const after = await zk.getFingerprints();
    const forNew = after.filter((t) => t.uid === 30);
    eq('salin sidik jari: dua template tersalin', forNew.length, 2);
    check(
      'salin sidik jari: isi template identik dengan asal',
      forNew[0].template.equals(Buffer.alloc(320, 0xa5)) ||
        forNew[0].template.equals(Buffer.alloc(280, 0x5a))
    );
    eq(
      'salin sidik jari: total panjang template utuh',
      forNew.reduce((n, t) => n + t.template.length, 0),
      320 + 280
    );

    // --- hapus user
    const jumlahSebelum = (await zk.getUsers()).length;
    await zk.deleteUserByPin('202');
    users = await zk.getUsers();
    eq('hapus user: jumlah berkurang satu', users.length, jumlahSebelum - 1);
    check('hapus user: PIN 202 hilang', !users.some((u) => u.userId === '202'));
    check('hapus user: user lain tetap ada', users.some((u) => u.userId === '101'));

    eq('hapus user tak dikenal: dilaporkan tidak ditemukan', await zk.deleteUserByPin('999'), false);
  } finally {
    await zk.disconnect().catch(() => {});
    await device.close();
  }
}

async function testCommKey() {
  const device = new MockDevice({ users: USERS, attendance: [], commKey: 1234 });
  const port = await device.listen();
  const zk = new ZKClient({ ip: '127.0.0.1', port, commKey: 1234, timeout: 5000 });
  try {
    await zk.connect();
    check('mesin ber-Comm Key: autentikasi berhasil', zk.connected);
    check('mesin ber-Comm Key: perintah AUTH terkirim', device.received.includes(1102));
  } finally {
    await zk.disconnect().catch(() => {});
    await device.close();
  }
}

/** Alat diagnosa: memindai port dan menyimpulkan langkah perbaikan. */
async function testDiagnose() {
  const { diagnose } = require('../src/main/zk/diagnose');

  // --- mesin sehat di port yang benar
  const device = new MockDevice({ users: USERS, attendance: ATT });
  const port = await device.listen();
  try {
    const d = await diagnose({ ip: '127.0.0.1', port });
    check('diagnosa: mesin sehat terdeteksi terjangkau', d.reachable);
    eq('diagnosa: port mesin ditemukan', d.zkPort, port);
    check('diagnosa: berhasil terhubung penuh', d.connected, d.error || '');
    eq('diagnosa: nama perangkat terbaca', d.deviceName, 'X105');
    eq('diagnosa: jumlah user terbaca', d.users, USERS.length);
    check(
      'diagnosa: saran mengarahkan ke sinkron user',
      d.saran.some((s) => /Sinkron User/i.test(s)),
      d.saran.join(' | ')
    );
  } finally {
    await device.close();
  }

  // --- tidak ada mesin di alamat itu.
  //
  //     Alamat "mati" di luar jaringan bukan patokan yang bisa dipercaya:
  //     sebagian jaringan kantor memasang proxy atau captive portal yang
  //     menjawab alamat apa pun di port 80, sehingga hasilnya berubah-ubah
  //     tergantung tempat pengujian dijalankan. Yang dipakai di sini adalah
  //     port lokal yang baru saja dilepas — dijamin tidak ada yang
  //     mendengarkan — dan daftar port tambahan dikosongkan.
  const portKosong = await new Promise((resolve) => {
    const s = require('node:net').createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const mati = await diagnose({ ip: '127.0.0.1', port: portKosong, extraPorts: [] });
  check('diagnosa: alamat tanpa mesin dinyatakan tidak terjangkau', !mati.reachable);
  check('diagnosa: tidak ada port ZK ditemukan', mati.zkPort === null);
  check(
    'diagnosa: menyarankan uji ping',
    mati.saran.some((s) => /ping/i.test(s)),
    mati.saran.join(' | ')
  );
  check(
    'diagnosa: menyebut lokasi menu jaringan di mesin',
    mati.saran.some((s) => /Komunikasi/i.test(s))
  );

  // --- mesin ber-Comm Key, tapi aplikasi mengisi kunci yang salah
  const terkunci = new MockDevice({ users: USERS, attendance: [], commKey: 9876 });
  const portKunci = await terkunci.listen();
  try {
    const d = await diagnose({ ip: '127.0.0.1', port: portKunci, commKey: 1111 });
    eq('diagnosa: mesin ber-Comm Key tetap ditemukan', d.zkPort, portKunci);
    check('diagnosa: kebutuhan Comm Key terdeteksi', d.needsCommKey);
    check(
      'diagnosa: saran menyebut Kunci Komunikasi',
      d.saran.some((s) => /Comm Key|Kunci Komunikasi/i.test(s)),
      d.saran.join(' | ')
    );
  } finally {
    await terkunci.close();
  }
}

async function testUnreachable() {
  // Port 1 hampir pasti tertutup; koneksi harus gagal dengan pesan Indonesia.
  const zk = new ZKClient({ ip: '127.0.0.1', port: 1, timeout: 2500 });
  try {
    await zk.connect();
    check('mesin tak terjangkau: harus gagal', false, 'malah berhasil terhubung');
  } catch (err) {
    check('mesin tak terjangkau: pesan galat ramah', /menolak koneksi|Timeout|terjangkau/i.test(err.message), err.message);
  } finally {
    await zk.disconnect().catch(() => {});
  }
}

(async () => {
  try {
    await testProtocol('tcp');
    await testProtocol('udp');
    await testWrite();
    await testCommKey();
    await testDiagnose();
    await testUnreachable();
  } catch (err) {
    failed += 1;
    results.push(` GAGAL │ pengujian berhenti: ${err.stack || err.message}`);
  }

  console.log(`\n${'─'.repeat(78)}`);
  results.forEach((r) => console.log(r));
  console.log('─'.repeat(78));
  console.log(`${results.length - failed}/${results.length} pemeriksaan lolos${failed ? ` — ${failed} GAGAL` : ' — semua lolos'}\n`);
  process.exit(failed ? 1 : 0);
})();
