/**
 * Uji fungsional tanpa mesin fisik. Dijalankan di dalam Electron karena
 * better-sqlite3 dikompilasi untuk ABI Electron:
 *
 *   npx electron test/smoke.js
 */
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

app.disableHardwareAcceleration();

const results = [];
let failed = 0;

function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failed += 1;
  const line = `${ok ? '  OK  ' : ' GAGAL'} │ ${name}${detail ? ` — ${detail}` : ''}`;
  results.push(line);
  // Dicetak seketika, bukan ditumpuk sampai akhir: kalau pengujian mati di
  // tengah jalan, baris terakhir menunjukkan persis di mana berhentinya.
  console.log(line);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `dapat ${JSON.stringify(actual)}, harap ${JSON.stringify(expected)}`);
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-test-'));

  // ================================================== 1. protokol ZK murni
  const packet = require('../src/main/zk/packet');
  const { ZKClient } = require('../src/main/zk/client');
  const { CMD } = require('../src/main/zk/const');

  const { packet: connectPacket, nextReplyId } = packet.createPacket(CMD.CONNECT, null, 0, 5);
  eq('paket CONNECT panjang 8 byte', connectPacket.length, 8);
  eq('paket CONNECT perintah 1000', connectPacket.readUInt16LE(0), 1000);
  eq('replyId dinaikkan di paket terkirim', connectPacket.readUInt16LE(6), 6);
  eq('replyId berikutnya dikembalikan', nextReplyId, 6);
  // Sama seperti pyzk: pembungkusan terjadi pada USHRT_MAX, bukan 65536.
  eq('replyId berputar di 65535', packet.createPacket(CMD.CONNECT, null, 0, 65534).nextReplyId, 0);

  // Checksum harus membuat seluruh paket berjumlah nol (komplemen satu).
  const sum = (() => {
    let acc = 0;
    for (let i = 0; i < connectPacket.length; i += 2) acc += connectPacket.readUInt16LE(i);
    while (acc > 0xffff) acc = (acc & 0xffff) + (acc >>> 16);
    return acc;
  })();
  check('checksum paket konsisten', sum === 0xffff || sum === 0xfffe, `jumlah 0x${sum.toString(16)}`);

  const t = new Date(2026, 2, 2, 8, 5, 30);
  const roundTrip = packet.decodeTime(packet.encodeTime(t));
  eq('encode/decode waktu bolak-balik', roundTrip.getTime(), t.getTime());

  const hex = packet.decodeTimeHex(Buffer.from([26, 3, 2, 8, 5, 30]));
  eq('decode waktu realtime 6 byte', hex.getTime(), new Date(2026, 2, 2, 8, 5, 30).getTime());

  eq('comm key panjang 4 byte', packet.makeCommKey(0, 1234).length, 4);
  eq('comm key ikut berubah bila password berbeda',
    packet.makeCommKey(123, 700).equals(packet.makeCommKey(456, 700)), false);
  // MakeKey() asli membuang byte ketiga hasil scramble, jadi selisih session id
  // yang kecil memang tidak mengubah kunci. Perbedaan baru muncul saat carry
  // merambat ke byte yang lebih tinggi.
  eq('comm key berubah saat session id bergeser jauh',
    packet.makeCommKey(123, 1).equals(packet.makeCommKey(123, 513)), false);

  // Paket realtime 52 byte (firmware baru: PIN sebagai teks 24 byte)
  const live = Buffer.alloc(52);
  Buffer.from('1007').copy(live, 0);
  live[24] = 1; // mode verifikasi = sidik jari
  live[25] = 0; // punch = masuk
  Buffer.from([26, 3, 2, 7, 58, 12]).copy(live, 26);
  const parsed = ZKClient.parseLiveRecords(live);
  eq('paket realtime terbaca 1 record', parsed.length, 1);
  eq('PIN dari paket realtime', parsed[0].userId, '1007');
  eq('jam dari paket realtime', parsed[0].timestamp.getHours(), 7);

  const live12 = Buffer.alloc(12);
  live12.writeUInt32LE(42, 0);
  live12[4] = 1;
  live12[5] = 0;
  Buffer.from([26, 3, 2, 9, 0, 0]).copy(live12, 6);
  eq('paket realtime 12 byte (firmware lama)', ZKClient.parseLiveRecords(live12)[0].userId, '42');

  // ============================================== 2. database & data master
  const db = require('../src/main/db');
  db.init(tmp);

  const { employees, shifts, leaveTypes, leaves, holidays, settings } = require('../src/main/services/masters');
  const { schedules } = require('../src/main/services/schedules');
  const { insertLogs, attendance } = require('../src/main/services/attendance');
  const { reports } = require('../src/main/services/reports');

  const allShifts = shifts.list();
  check('shift bawaan ter-seed', allShifts.length >= 4, `${allShifts.length} shift`);
  const shiftPagi = allShifts.find((s) => s.code === 'P');
  const shiftMalam = allShifts.find((s) => s.code === 'M');
  check('shift Pagi & Malam ada', !!shiftPagi && !!shiftMalam);
  eq('jenis izin bawaan ter-seed', leaveTypes.list().length, 5);

  const idA = employees.create({ pin: '1', name: 'Ani Pagi', default_shift_id: shiftPagi.id });
  const idB = employees.create({ pin: '2', name: 'Budi Malam', default_shift_id: shiftMalam.id });
  eq('2 karyawan dibuat', employees.list().length, 2);

  let duplicateBlocked = false;
  try {
    employees.create({ pin: '1', name: 'PIN Kembar' });
  } catch {
    duplicateBlocked = true;
  }
  check('PIN ganda ditolak database', duplicateBlocked);

  // ==================================================== 3. log absensi
  const D = '2026-03-02'; // Senin
  const logs = [
    { userId: '1', timestamp: new Date(2026, 2, 2, 8, 5, 0), status: 1, punch: 0 },
    { userId: '1', timestamp: new Date(2026, 2, 2, 17, 20, 0), status: 1, punch: 1 },
    { userId: '1', timestamp: new Date(2026, 2, 3, 8, 30, 0), status: 1, punch: 0 },
    { userId: '1', timestamp: new Date(2026, 2, 3, 17, 0, 0), status: 1, punch: 1 },
    { userId: '1', timestamp: new Date(2026, 2, 4, 8, 0, 0), status: 1, punch: 0 },
    // 5 Maret sengaja kosong -> Alpha; 6 Maret ditutup izin sakit
    { userId: '2', timestamp: new Date(2026, 2, 2, 21, 50, 0), status: 1, punch: 0 },
    { userId: '2', timestamp: new Date(2026, 2, 3, 6, 10, 0), status: 1, punch: 1 },
  ];
  const ins = insertLogs(null, logs, 'tarik');
  eq('semua log tersimpan', ins.inserted, 7);
  eq('tidak ada PIN tak dikenal', ins.unknown, 0);

  const again = insertLogs(null, logs, 'tarik');
  eq('penarikan ulang tidak menduplikasi', again.inserted, 0);
  eq('duplikat terdeteksi', again.duplicate, 7);

  const dupWindow = insertLogs(null, [{ userId: '1', timestamp: new Date(2026, 2, 2, 8, 5, 30) }], 'tarik');
  eq('tap ganda dalam 60 detik diabaikan', dupWindow.inserted, 0);

  // Realtime tercatat "Password" (0) karena posisi byte beda antar firmware;
  // penarikan berikutnya membawa mode verifikasi resmi dari memori mesin.
  const scanRt = { userId: '1', timestamp: new Date(2026, 1, 10, 8, 0, 0), status: 0, punch: 0 };
  insertLogs(null, [scanRt], 'realtime');
  const koreksi = insertLogs(null, [{ ...scanRt, status: 1 }], 'tarik');
  eq('tarik mengoreksi mode verifikasi log realtime', koreksi.corrected, 1);
  eq('koreksi tidak menambah baris baru', koreksi.inserted, 0);
  const rtRow = db.get().prepare("SELECT status, source FROM attendance_logs WHERE ts = '2026-02-10 08:00:00'").get();
  eq('log realtime kini tercatat Sidik Jari', rtRow.status, 1);
  eq('asal log tetap realtime', rtRow.source, 'realtime');
  db.get().prepare("DELETE FROM attendance_logs WHERE ts = '2026-02-10 08:00:00'").run();

  // ==================================================== 4. jadwal & izin
  schedules.setDay(idA, '2026-03-07', allShifts.find((s) => s.is_off).id);
  holidays.create('2026-03-19', 'Hari Raya Nyepi');
  leaves.create({
    employee_id: idA,
    leave_type_id: leaveTypes.list().find((t) => t.code === 'S').id,
    start_date: '2026-03-06',
    end_date: '2026-03-06',
    note: 'demam',
  });

  // ==================================================== 5. perhitungan rekap
  const monthly = reports.monthly({ month: '2026-03' });
  const rowsA = monthly.rows.filter((r) => r.employee_id === idA);
  const byDate = (rows, date) => rows.find((r) => r.date === date);

  const a1 = byDate(rowsA, D);
  eq('A: jam masuk terbaca', a1.check_in, '08:05');
  eq('A: jam pulang terbaca', a1.check_out, '17:20');
  eq('A: masih dalam toleransi telat', a1.late_minutes, 0);
  eq('A: status hadir', a1.status, 'H');
  eq('A: jam kerja dipotong istirahat', a1.work_minutes, 555 - 60);
  eq('A: lembur 20 menit belum melewati ambang 30', a1.overtime_minutes, 0);

  const a2 = byDate(rowsA, '2026-03-03');
  eq('A: terlambat 20 menit (toleransi 10)', a2.late_minutes, 20);
  eq('A: status terlambat', a2.status, 'T');

  const a3 = byDate(rowsA, '2026-03-04');
  eq('A: hanya scan masuk -> tidak lengkap', a3.status, 'TL');
  eq('A: jam pulang kosong', a3.check_out, null);

  eq('A: tanpa scan & tanpa izin -> alpha', byDate(rowsA, '2026-03-05').status, 'A');
  eq('A: tertutup izin sakit', byDate(rowsA, '2026-03-06').status, 'S');
  eq('A: jadwal khusus libur dihormati', byDate(rowsA, '2026-03-07').status, 'L');
  eq('A: hari libur nasional', byDate(rowsA, '2026-03-19').status, 'LN');

  // Shift malam 22:00-06:00: scan pulang keesokan hari harus masuk tanggal shift.
  const rowsB = monthly.rows.filter((r) => r.employee_id === idB);
  const b1 = byDate(rowsB, D);
  eq('B: shift malam, masuk 21:50', b1.check_in, '21:50');
  eq('B: pulang 06:10 dicatat sebagai 30:10 (lintas hari)', b1.check_out, '30:10');
  eq('B: tidak dianggap terlambat', b1.late_minutes, 0);
  eq('B: status hadir', b1.status, 'H');
  eq('B: jam kerja lintas hari benar', b1.work_minutes, 500 - 60);
  eq('B: hari berikutnya tidak ikut terhitung hadir', byDate(rowsB, '2026-03-03').status, 'A');

  // Shift bawaan karyawan tidak boleh membuatnya masuk kerja di akhir pekan:
  // jadwal mingguan bawaan menandai Sabtu & Minggu sebagai libur.
  eq('A: Sabtu tetap libur meski punya shift bawaan', byDate(rowsA, '2026-03-14').status, 'L');
  eq('B: Minggu tetap libur meski punya shift bawaan', byDate(rowsB, '2026-03-15').status, 'L');
  eq('A: Rabu tetap memakai shift bawaan', byDate(rowsA, '2026-03-11').shift_code, 'P');
  eq('B: Rabu memakai shift malam bawaannya', byDate(rowsB, '2026-03-11').shift_code, 'M');

  const sumA = monthly.summary.find((s) => s.employee_id === idA);
  eq('rekap A: total hadir', sumA.hadir, 2);
  eq('rekap A: total terlambat', sumA.terlambat, 1);
  eq('rekap A: total sakit', sumA.sakit, 1);
  eq('rekap A: akumulasi menit telat', sumA.late_minutes, 20);

  const dash = reports.dashboard(D);
  eq('dashboard: hadir hari itu', dash.hadir, 2);
  eq('dashboard: jumlah scan', dash.scan_hari_ini, 3);

  // Hari ini: yang belum scan baru jadi Alpha setelah jam pulang shift lewat.
  const { computeRange } = require('../src/main/services/reports');
  const statusPada = (empId, date, now) =>
    computeRange({ from: date, to: date, employeeIds: [empId], now }).rows[0].status;
  eq('hari ini sebelum shift selesai: belum scan -> Belum',
    statusPada(idA, '2026-03-05', new Date(2026, 2, 5, 7, 0)), '-');
  eq('hari ini setelah jam pulang: belum scan -> Alpha',
    statusPada(idA, '2026-03-05', new Date(2026, 2, 5, 18, 0)), 'A');
  eq('shift malam hari ini belum dimulai -> Belum',
    statusPada(idB, '2026-03-05', new Date(2026, 2, 5, 23, 0)), '-');

  // Malam lalu Pagi: scan masuk Pagi tidak boleh direbut shift Malam kemarin.
  const idC = employees.create({ pin: '3', name: 'Cici Rotasi' });
  schedules.setDay(idC, '2026-03-09', shiftMalam.id);
  schedules.setDay(idC, '2026-03-10', shiftPagi.id);
  insertLogs(null, [
    { userId: '3', timestamp: new Date(2026, 2, 9, 21, 55, 0) },
    { userId: '3', timestamp: new Date(2026, 2, 10, 6, 3, 0) },
    { userId: '3', timestamp: new Date(2026, 2, 10, 7, 55, 0) },
    { userId: '3', timestamp: new Date(2026, 2, 10, 17, 5, 0) },
  ], 'tarik');
  const rotasi = reports.range({ from: '2026-03-09', to: '2026-03-10', employeeIds: [idC] }).rows;
  const malam = byDate(rotasi, '2026-03-09');
  const pagi = byDate(rotasi, '2026-03-10');
  eq('Malam->Pagi: pulang malam tetap 06:03', malam.check_out, '30:03');
  eq('Malam->Pagi: malam tanpa lembur palsu', malam.overtime_minutes, 0);
  eq('Malam->Pagi: masuk pagi 07:55 milik hari Pagi', pagi.check_in, '07:55');
  eq('Malam->Pagi: hari Pagi hadir lengkap', pagi.status, 'H');
  // Dibersihkan supaya hitungan pada pengujian berikutnya tidak berubah.
  employees.remove(idC);
  db.get().prepare("DELETE FROM attendance_logs WHERE user_pin = '3'").run();

  // Kartu RFID 10 digit melewati 2^31 dan tetap harus bisa dikirim ke mesin.
  const zkKartu = new ZKClient({ ip: '127.0.0.1' });
  zkKartu.userPacketSize = 72;
  let kartuBesar = null;
  try {
    kartuBesar = zkKartu._packUser({ uid: 1, userId: '9', name: 'X', card: 3000000000 }).readUInt32LE(35);
  } catch (err) {
    kartuBesar = err.message;
  }
  eq('kartu RFID > 2^31 dikemas utuh', kartuBesar, 3000000000);
  let kartuDitolak = false;
  try {
    employees.create({ pin: 'KARTU', name: 'Kartu Kebesaran', card: 5000000000 });
  } catch {
    kartuDitolak = true;
  }
  check('kartu RFID melewati 32 bit ditolak saat simpan', kartuDitolak);

  // ================================================ 6. jadwal massal
  const gen = schedules.generate({
    employeeIds: [idA, idB],
    from: '2026-04-01',
    to: '2026-04-14',
    pattern: [shiftPagi.id, shiftPagi.id, shiftPagi.id, shiftPagi.id, shiftPagi.id, null, null],
    skipHolidays: true,
    overwrite: true,
  });
  eq('jadwal massal: jumlah sel terisi', gen.assigned, 28);
  const matrix = schedules.matrix({ month: '2026-04' });
  eq('matriks jadwal: jumlah hari April', matrix.dates.length, 30);
  eq('matriks jadwal: hari ke-6 pola = libur', matrix.employees[0].days[5].is_off, 1);

  // ======================================= 6b. shift bergilir (satpam)
  const shiftSiang = allShifts.find((s) => s.code === 'S');
  const reguPola = [shiftPagi.id, shiftSiang.id, shiftMalam.id, null];
  // Empat regu untuk pola empat langkah: tiga shift jaga + satu hari libur.
  // Dengan tiga regu saja, tiap hari selalu ada satu shift yang kosong.
  const satpam = [
    employees.create({ pin: 'S1', name: 'Satpam Regu A' }),
    employees.create({ pin: 'S2', name: 'Satpam Regu B' }),
    employees.create({ pin: 'S3', name: 'Satpam Regu C' }),
    employees.create({ pin: 'S4', name: 'Satpam Regu D' }),
  ];
  schedules.generate({
    employeeIds: satpam,
    from: '2026-05-01',
    to: '2026-05-28',
    pattern: reguPola,
    stagger: true,
    skipHolidays: false,
    overwrite: true,
  });

  const reguMatrix = schedules.matrix({ month: '2026-05', search: 'Satpam' });
  const kode = (namaAkhir, hari) => {
    const emp = reguMatrix.employees.find((e) => e.name.endsWith(namaAkhir));
    return emp.days[hari].code;
  };
  eq('satpam regu A hari-1 shift Pagi', kode('A', 0), 'P');
  eq('satpam regu B hari-1 shift Siang', kode('B', 0), 'S');
  eq('satpam regu C hari-1 shift Malam', kode('C', 0), 'M');
  eq('satpam regu A hari-2 bergeser ke Siang', kode('A', 1), 'S');
  eq('satpam regu C hari-2 bergeser ke libur', kode('C', 1), 'OFF');

  eq('satpam regu D hari-1 libur', kode('D', 0), 'OFF');

  // Inti shift bergilir: tiap hari ketiga shift harus ada penjaganya,
  // dan tepat satu regu libur.
  let hariBolong = 0;
  for (let hari = 0; hari < 28; hari++) {
    const kodeHari = ['A', 'B', 'C', 'D'].map((r) => kode(r, hari)).sort().join(',');
    if (kodeHari !== ['P', 'S', 'M', 'OFF'].sort().join(',')) hariBolong += 1;
  }
  eq('satpam: 28 hari berturut-turut tanpa shift kosong', hariBolong, 0);

  // Offset tanpa stagger menggeser semua orang bersamaan.
  schedules.generate({
    employeeIds: [satpam[0]],
    from: '2026-06-01',
    to: '2026-06-08',
    pattern: reguPola,
    offset: 2,
    skipHolidays: false,
    overwrite: true,
  });
  const juni = schedules.matrix({ month: '2026-06', search: 'Regu A' });
  eq('offset 2 memulai pola dari shift Malam', juni.employees[0].days[0].code, 'M');

  // =============================== 6c. rekonsiliasi aplikasi vs mesin
  const { devices } = require('../src/main/services/devices');
  const devId = devices.create({ name: 'Mesin Uji', ip: '10.0.0.9', port: 4370 });
  devices.saveUsers(
    devId,
    [
      { uid: 1, userId: '1', name: 'Ani Pagi', privilege: 0, card: 0 }, // sama persis
      { uid: 2, userId: '2', name: 'Budi Beda Nama', privilege: 0, card: 99 }, // beda
      { uid: 9, userId: '900', name: 'Hanya Di Mesin', privilege: 0, card: 0 },
    ],
    new Map([[1, 2]])
  );

  const rec = devices.reconcile(devId);
  const cariApp = (pin) => rec.app.find((r) => r.pin === pin);
  const cariMesin = (pin) => rec.device.find((r) => r.pin === pin);

  eq('rekonsiliasi: sudah sinkron', rec.counts.sinkron, 1);
  eq('rekonsiliasi: hanya ada di mesin', rec.counts.hanyaMesin, 1);
  // Keempat satpam belum pernah dikirim ke mesin ini.
  eq('rekonsiliasi: hanya ada di aplikasi', rec.counts.hanyaApp, 4);
  eq('rekonsiliasi: jumlah sidik jari terbaca', cariApp('1').finger_count, 2);
  eq('rekonsiliasi: PIN hanya-di-mesin benar', cariMesin('900').pin, '900');
  check('rekonsiliasi: baris hanya-di-mesin ditandai belum ada di aplikasi', !cariMesin('900').in_app);
  check('rekonsiliasi: baris hanya-di-aplikasi ditandai belum ada di mesin', !cariApp('S1').on_device);

  // Tabel kiri dan kanan harus menceritakan baris yang sama secara konsisten.
  eq('rekonsiliasi: status PIN 1 sama di kedua tabel',
    `${cariApp('1').status}|${cariMesin('1').status}`, 'sinkron|sinkron');

  // --- asal perubahan: belum ada rekaman kesepakatan, jadi hanya "beda"
  eq('rekonsiliasi: beda tanpa riwayat disebut berbeda saja', cariApp('2').status, 'beda');
  eq('rekonsiliasi: kolom yang berbeda terdeteksi',
    cariApp('2').differences.sort().join(','), 'kartu RFID,nama');

  // --- tiru alur "kirim ke mesin" yang sesungguhnya: mesin ditulis, dibaca
  //     ulang, baru kondisinya dicatat sebagai disepakati.
  const bacaMesin = (nama, hak, kartu) =>
    devices.saveUsers(
      devId,
      [
        { uid: 1, userId: '1', name: 'Ani Pagi', privilege: 0, card: 0 },
        { uid: 2, userId: '2', name: nama, privilege: hak, card: kartu },
      ],
      null
    );
  const ubahKaryawanB = (nama, hak, kartu) =>
    employees.update(idB, {
      pin: '2', name: nama, privilege: hak, card: kartu,
      default_shift_id: shiftMalam.id,
    });

  ubahKaryawanB('Budi Malam', 0, 0);
  bacaMesin('Budi Malam', 0, 0);
  devices.markPushed(devId, ['2']);
  eq('rekonsiliasi: setelah dikirim, statusnya sinkron', devices.reconcile(devId).app.find((r) => r.pin === '2').status, 'sinkron');

  ubahKaryawanB('Budi Malam Revisi', 0, 99);
  const setelahUbahApp = devices.reconcile(devId);
  eq('perubahan di aplikasi dikenali dari sisi aplikasi',
    setelahUbahApp.app.find((r) => r.pin === '2').status, 'ubah_app');
  eq('perubahan di aplikasi juga terlihat di tabel mesin',
    setelahUbahApp.device.find((r) => r.pin === '2').status, 'ubah_app');

  // --- kembalikan ke kondisi semula, lalu ubah dari sisi mesin
  ubahKaryawanB('Budi Malam', 0, 0);
  eq('rekonsiliasi: kembali sinkron setelah dikembalikan',
    devices.reconcile(devId).app.find((r) => r.pin === '2').status, 'sinkron');

  bacaMesin('Budi Ganti Di Mesin', 14, 0);
  const setelahUbahMesin = devices.reconcile(devId);
  eq('perubahan di mesin dikenali', setelahUbahMesin.device.find((r) => r.pin === '2').status, 'ubah_mesin');
  eq('perubahan di mesin: kolom yang beda terdeteksi',
    setelahUbahMesin.app.find((r) => r.pin === '2').differences.sort().join(','), 'hak akses,nama');

  // --- kedua sisi berubah = bentrok
  ubahKaryawanB('Budi Ganti Di Aplikasi', 0, 77);
  eq('kedua sisi berubah ditandai bentrok',
    devices.reconcile(devId).app.find((r) => r.pin === '2').status, 'bentrok');

  // --- ambil data mesin menyelesaikan bentrok
  devices.adoptFromDevice(devId, ['2']);
  const setelahAmbil = devices.reconcile(devId);
  eq('ambil data mesin: status kembali sinkron',
    setelahAmbil.app.find((r) => r.pin === '2').status, 'sinkron');
  eq('ambil data mesin: nama di aplikasi mengikuti mesin',
    employees.findByPin('2').name, 'Budi Ganti Di Mesin');
  eq('ambil data mesin: hak akses ikut tersalin', employees.findByPin('2').privilege, 14);

  // User yang hilang dari mesin harus ikut hilang dari hasil perbandingan.
  devices.saveUsers(devId, [{ uid: 1, userId: '1', name: 'Ani Pagi', privilege: 0, card: 0 }], null);
  eq('rekonsiliasi: user yang dihapus di mesin ikut hilang', devices.reconcile(devId).counts.hanyaMesin, 0);

  // ==================================================== 7. ekspor berkas
  settings.set('company_name', 'PT Contoh Sejahtera');
  const exporter = require('../src/main/services/exporter');

  const xlsx = path.join(tmp, 'rekap.xlsx');
  await exporter.monthlyExcel(xlsx, { month: '2026-03' });
  check('Excel rekap bulanan dibuat', fs.existsSync(xlsx) && fs.statSync(xlsx).size > 4000,
    `${fs.existsSync(xlsx) ? fs.statSync(xlsx).size : 0} byte`);

  const logXlsx = path.join(tmp, 'log.xlsx');
  await exporter.logsExcel(logXlsx, { from: '2026-03-01', to: '2026-03-31' });
  check('Excel log scan dibuat', fs.existsSync(logXlsx) && fs.statSync(logXlsx).size > 3000);

  const pdf = path.join(tmp, 'rekap.pdf');
  await exporter.htmlToPdf(exporter.monthlyPdfHtml({ month: '2026-03' }), pdf, { landscape: true });
  const pdfOk = fs.existsSync(pdf) && fs.readFileSync(pdf).subarray(0, 4).toString() === '%PDF';
  check('PDF rekap bulanan dibuat', pdfOk, `${fs.existsSync(pdf) ? fs.statSync(pdf).size : 0} byte`);

  const cardPdf = path.join(tmp, 'kartu.pdf');
  await exporter.htmlToPdf(exporter.employeeCardPdfHtml({ employeeId: idA, month: '2026-03' }), cardPdf, { landscape: false });
  check('PDF kartu absensi dibuat (ekspor ke-2 berturut-turut)',
    fs.existsSync(cardPdf) && fs.statSync(cardPdf).size > 1000,
    `${fs.existsSync(cardPdf) ? fs.statSync(cardPdf).size : 0} byte`);

  const dailyPdf = path.join(tmp, 'harian.pdf');
  await exporter.htmlToPdf(exporter.dailyPdfHtml({ date: D }), dailyPdf, { landscape: true });
  check('PDF harian dibuat (ekspor ke-3 berturut-turut)',
    fs.existsSync(dailyPdf) && fs.statSync(dailyPdf).size > 1000,
    `${fs.existsSync(dailyPdf) ? fs.statSync(dailyPdf).size : 0} byte`);

  // ================================================ 8. log tanpa karyawan
  insertLogs(null, [{ userId: '999', timestamp: new Date(2026, 2, 10, 8, 0, 0) }], 'tarik');
  eq('PIN asing tercatat sebagai tak dikenal', attendance.unknownPins().length, 1);
  employees.create({ pin: '999', name: 'Karyawan Baru' });
  eq('log tersambung otomatis setelah karyawan dibuat', attendance.unknownPins().length, 0);

  // ============================= 8b. hapus / ubah status banyak karyawan
  const massalA = employees.create({ pin: 'M1', name: 'Massal Satu', default_shift_id: shiftPagi.id });
  const massalB = employees.create({ pin: 'M2', name: 'Massal Dua', default_shift_id: shiftPagi.id });
  const massalC = employees.create({ pin: 'M3', name: 'Massal Tiga', default_shift_id: shiftPagi.id });

  // Beri mereka jadwal, izin, dan log absensi supaya dampaknya bisa diukur.
  schedules.generate({
    employeeIds: [massalA, massalB],
    from: '2026-07-01', to: '2026-07-05',
    pattern: [shiftPagi.id], skipHolidays: false, overwrite: true,
  });
  leaves.create({
    employee_id: massalA,
    leave_type_id: leaveTypes.list().find((t) => t.code === 'C').id,
    start_date: '2026-07-02', end_date: '2026-07-02',
  });
  insertLogs(null, [{ userId: 'M1', timestamp: new Date(2026, 6, 1, 8, 0, 0) }], 'tarik');

  const dampak = employees.impactOf([massalA, massalB]);
  eq('dampak hapus: jumlah karyawan', dampak.employees, 2);
  eq('dampak hapus: nama ikut dilaporkan', dampak.names.join(','), 'Massal Dua,Massal Satu');
  eq('dampak hapus: jadwal yang ikut terhapus', dampak.schedules, 10);
  eq('dampak hapus: izin yang ikut terhapus', dampak.leaves, 1);
  eq('dampak hapus: log yang kehilangan kaitan', dampak.logs, 1);

  // --- nonaktifkan massal
  eq('nonaktif massal: jumlah berubah', employees.setActiveMany([massalA, massalB, massalC], false).changed, 3);
  eq('nonaktif massal: benar-benar nonaktif',
    employees.list({ activeOnly: true }).filter((e) => String(e.pin).startsWith('M')).length, 0);
  eq('aktifkan massal kembali', employees.setActiveMany([massalA, massalB, massalC], true).changed, 3);
  eq('aktifkan massal: kembali muncul di daftar aktif',
    employees.list({ activeOnly: true }).filter((e) => String(e.pin).startsWith('M')).length, 3);

  // --- hapus massal
  const sebelumHapus = employees.list().length;
  eq('hapus massal: dua karyawan terhapus', employees.removeMany([massalA, massalB]).removed, 2);
  eq('hapus massal: jumlah karyawan berkurang dua', employees.list().length, sebelumHapus - 2);
  check('hapus massal: yang tidak dipilih tetap ada', !!employees.findByPin('M3'));

  // Inti keamanannya: log absensi TIDAK boleh ikut hilang.
  const logM1 = db.get().prepare("SELECT employee_id FROM attendance_logs WHERE user_pin = 'M1'").get();
  check('hapus massal: log absensi tetap tersimpan', !!logM1);
  eq('hapus massal: log jadi tanpa kaitan karyawan', logM1 && logM1.employee_id, null);

  // Jadwal dan izin memang ikut terhapus — itu sebabnya dampaknya diberitahukan.
  eq('hapus massal: jadwal ikut terhapus',
    db.get().prepare('SELECT COUNT(*) AS n FROM schedules WHERE employee_id IN (?, ?)').get(massalA, massalB).n, 0);
  eq('hapus massal: izin ikut terhapus',
    db.get().prepare('SELECT COUNT(*) AS n FROM leaves WHERE employee_id = ?').get(massalA).n, 0);

  // Log yatim tersambung lagi bila PIN yang sama didaftarkan ulang.
  const lahirLagi = employees.create({ pin: 'M1', name: 'Massal Satu Kembali' });
  eq('hapus massal: log tersambung lagi saat PIN didaftarkan ulang',
    db.get().prepare("SELECT employee_id FROM attendance_logs WHERE user_pin = 'M1'").get().employee_id, lahirLagi);

  eq('hapus massal: daftar kosong tidak melakukan apa-apa', employees.removeMany([]).removed, 0);

  // ===== 8f. satu paket: baca mesin membawa sidik jari, kirim memasangnya
  {
    const { MockDevice } = require('./mock-device');
    const { DeviceManager } = require('../src/main/zk/manager');
    const { fingerprints } = require('../src/main/services/fingerprints');

    const jariAsli = [
      { uid: 7, fid: 0, valid: 1, template: Buffer.alloc(220, 0x11) },
      { uid: 7, fid: 1, valid: 1, template: Buffer.alloc(260, 0x22) },
      { uid: 8, fid: 0, valid: 1, template: Buffer.alloc(300, 0x33) },
      // Template yatim: uid-nya tidak punya user di mesin.
      { uid: 99, fid: 0, valid: 1, template: Buffer.alloc(150, 0x44) },
    ];
    const mesinA = new MockDevice({
      users: [
        { uid: 7, userId: '701', name: 'Tujuh Satu', privilege: 0, card: 111 },
        { uid: 8, userId: '702', name: 'Tujuh Dua', privilege: 14, card: 222 },
      ],
      attendance: [],
      fingers: jariAsli.map((f) => ({ ...f })),
    });
    const mesinB = new MockDevice({ users: [], attendance: [], fingers: [] });
    const portA = await mesinA.listen();
    const portB = await mesinB.listen();
    const devA = devices.create({ name: 'Mesin A', ip: '127.0.0.1', port: portA });
    const devB = devices.create({ name: 'Mesin B', ip: '127.0.0.1', port: portB });
    const mgr = new DeviceManager();

    // --- SATU tindakan: baca mesin, sidik jari ikut tersimpan
    const baca = await mgr.syncUsers(devA);
    check('baca mesin: berhasil', baca.ok, baca.error || '');
    eq('baca mesin: jumlah user', baca.count, 2);
    check('baca mesin: sidik jari ikut terunduh', !!baca.templates, 'tidak ada info template');
    eq('baca mesin: template tersimpan', baca.templates.saved, 3);
    eq('baca mesin: template yatim dilewati', baca.templates.tanpaPin, 1);

    const stat = fingerprints.stats();
    eq('simpanan: jumlah template', stat.templates, 3);
    eq('simpanan: milik dua karyawan', stat.pins, 2);
    eq('simpanan: mesin asal dicatat', stat.sumber[0].nama, 'Mesin A');
    check(
      'simpanan: isi template identik dengan yang di mesin',
      Buffer.from(fingerprints.forPins(['701'])[0].template).equals(Buffer.alloc(220, 0x11))
    );

    // --- SATU tindakan: kirim karyawan, sidik jari ikut terpasang
    const kar1 = employees.create({ pin: '701', name: 'Tujuh Satu', card: 111 });
    const kar2 = employees.create({ pin: '702', name: 'Tujuh Dua', card: 222, privilege: 14 });

    // Mesin asal sengaja dimatikan: simpanan di aplikasi harus cukup.
    await mesinA.close();

    const kirim = await mgr.pushEmployees(devB, [kar1, kar2]);
    check('kirim ke mesin: berhasil meski mesin asal mati', kirim.ok, kirim.error || '');
    eq('kirim: dua karyawan terkirim', kirim.sent.length, 2);
    eq('kirim: tiga sidik jari ikut', kirim.jari.terkirim, 3);
    eq('kirim: mesin membenarkan pertambahannya', kirim.jari.bertambah, 3);

    // Dibuktikan di mesin B, bukan dari laporan aplikasi.
    eq('mesin B: dua user terbentuk', mesinB.users.length, 2);
    eq('mesin B: tiga sidik jari mendarat', mesinB.fingers.length, 3);
    const b701 = mesinB.users.find((u) => u.userId === '701');
    eq('mesin B: nama ikut terpasang', b701 && b701.name, 'Tujuh Satu');
    eq('mesin B: kartu ikut terpasang', b701 && b701.card, 111);

    const jariB = mesinB.fingers.filter((f) => f.uid === (b701 && b701.uid));
    eq('mesin B: PIN 701 punya dua jari', jariB.length, 2);
    check(
      'mesin B: isi template identik dengan aslinya',
      jariB.some((f) => f.template.equals(Buffer.alloc(220, 0x11))) &&
        jariB.some((f) => f.template.equals(Buffer.alloc(260, 0x22)))
    );

    // --- karyawan tanpa sidik jari tersimpan tetap terkirim datanya
    fingerprints.remove(null);
    const kar3 = employees.create({ pin: '703', name: 'Tujuh Tiga', card: 333 });
    const polos = await mgr.pushEmployees(devB, [kar3]);
    check('kirim tanpa sidik jari tersimpan: tetap berhasil', polos.ok, polos.error || '');
    eq('kirim tanpa sidik jari: tidak ada jari terkirim', polos.jari.terkirim, 0);
    check('mesin B: user ketiga tetap terbentuk', mesinB.users.some((u) => u.userId === '703'));

    await mgr.shutdown();
    await mesinB.close();
    devices.remove(devA);
    devices.remove(devB);
    employees.remove(kar1);
    employees.remove(kar2);
    employees.remove(kar3);
  }

  // ====== 8e. sidik jari yang tersimpan di aplikasi terlihat dari sisi mesin
  {
    const { fingerprints } = require('../src/main/services/fingerprints');

    const kar1 = employees.create({ pin: 'X1', name: 'Punya Jari' });
    const kar2 = employees.create({ pin: 'X2', name: 'Tanpa Jari' });
    const mTujuan = devices.create({ name: 'Mesin Tujuan', ip: '10.9.9.2', port: 4370 });
    devices.saveUsers(mTujuan, [], null);

    // Sidik jari sudah tersimpan di aplikasi, tetapi mesin tujuan masih kosong.
    fingerprints.saveMany(
      [
        { user_pin: 'X1', finger_id: 0, template: Buffer.alloc(200, 1), valid: 1 },
        { user_pin: 'X1', finger_id: 1, template: Buffer.alloc(210, 2), valid: 1 },
      ],
      { deviceId: null, deviceName: 'Mesin Sumber' }
    );

    const baris = devices.reconcile(mTujuan).app;
    const x1 = baris.find((r) => r.pin === 'X1');
    const x2 = baris.find((r) => r.pin === 'X2');

    eq('mesin tujuan kosong: belum ada sidik jari di sana', x1.finger_count, 0);
    eq('sidik jari tersimpan di aplikasi terdeteksi', x1.fingers_stored, 2);
    eq('mesin asal template dicatat', x1.fingers_stored_source, 'Mesin Sumber');
    eq('yang tak punya simpanan tetap nol', x2.fingers_stored, 0);
    check('yang tak punya simpanan tidak menyebut asal', !x2.fingers_stored_source);

    // Daftar karyawan ikut membawa jumlah sidik jari, supaya bisa dilihat
    // langsung dari halaman Karyawan tanpa membuka mesin.
    const daftar = employees.list({ search: 'Punya Jari' });
    eq('daftar karyawan: jumlah sidik jari ikut', daftar[0].finger_count, 2);
    eq('daftar karyawan: yang tanpa jari nol',
      employees.list({ search: 'Tanpa Jari' })[0].finger_count, 0);

    // Inti keluhan pengguna: kolom sidik jari di tabel "Karyawan di Aplikasi"
    // harus menampilkan angka yang SAMA apa pun mesin yang sedang dipilih.
    // Sebelumnya angkanya ikut berganti mengikuti mesin, sehingga orang yang
    // sama terlihat punya jumlah berbeda-beda.
    const mLain = devices.create({ name: 'Mesin Ketiga', ip: '10.9.9.3', port: 4370 });
    devices.saveUsers(mLain, [{ uid: 5, userId: 'X1', name: 'Punya Jari', privilege: 0, card: 0 }], new Map([[5, 9]]));

    const dariTujuan = devices.reconcile(mTujuan).app.find((r) => r.pin === 'X1');
    const dariLain = devices.reconcile(mLain).app.find((r) => r.pin === 'X1');
    eq('simpanan aplikasi sama dilihat dari mesin mana pun',
      `${dariTujuan.fingers_stored}|${dariLain.fingers_stored}`, '2|2');
    // Angka milik mesin memang boleh berbeda — itu ditampilkan di tabel kanan.
    eq('angka milik mesin tetap beda per mesin',
      `${dariTujuan.finger_count}|${dariLain.finger_count}`, '0|9');

    devices.remove(mLain);
    fingerprints.remove(null);
    devices.remove(mTujuan);
    employees.remove(kar1);
    employees.remove(kar2);
  }

  // ================= 8d. apa saja yang ikut terbawa saat import dari mesin
  {
    const { MockDevice } = require('./mock-device');
    const { DeviceManager } = require('../src/main/zk/manager');

    const mesinImpor = new MockDevice({
      users: [
        { uid: 1, userId: '601', name: 'Impor Lengkap', privilege: 14, card: 778899, password: '4321' },
        { uid: 2, userId: '602', name: 'Impor Polos', privilege: 0, card: 0, password: '' },
      ],
      attendance: [],
      fingers: [
        { uid: 1, fid: 0, valid: 1, template: Buffer.alloc(180, 3) },
        { uid: 1, fid: 1, valid: 1, template: Buffer.alloc(190, 4) },
      ],
    });
    const portImpor = await mesinImpor.listen();
    const devImpor = devices.create({ name: 'Mesin Impor', ip: '127.0.0.1', port: portImpor });
    const mgr = new DeviceManager();
    await mgr.syncUsers(devImpor);

    const dariMesin = devices.reconcile(devImpor).device;
    const baris601 = dariMesin.find((r) => r.pin === '601');
    eq('baca mesin: nama terbaca', baris601.name, 'Impor Lengkap');
    eq('baca mesin: kartu RFID terbaca', baris601.card, 778899);
    eq('baca mesin: hak akses terbaca', baris601.privilege, 14);
    eq('baca mesin: password mesin terbaca', baris601.password, '4321');
    eq('baca mesin: jumlah sidik jari terbaca', baris601.finger_count, 2);

    // Import jadi karyawan di aplikasi.
    employees.importFromDevice(
      dariMesin.map((r) => ({
        user_pin: r.pin, name: r.name, card: r.card,
        privilege: r.privilege, password: r.password,
      })),
      {}
    );

    const kar = employees.findByPin('601');
    eq('import: PIN jadi PIN karyawan', kar.pin, '601');
    eq('import: nama ikut', kar.name, 'Impor Lengkap');
    eq('import: kartu RFID ikut', kar.card, 778899);
    eq('import: hak akses ikut', kar.privilege, 14);
    eq('import: password mesin ikut', kar.device_password, '4321');

    const polos = employees.findByPin('602');
    eq('import: user tanpa kartu tetap 0', polos.card, 0);
    eq('import: user tanpa password tetap kosong', polos.device_password, null);

    // Sidik jari TIDAK disimpan di aplikasi — hanya jumlahnya yang dicatat.
    const kolom = db.get().prepare("SELECT name FROM pragma_table_info('employees')").all().map((r) => r.name);
    check('import: tidak ada kolom template sidik jari di data karyawan',
      !kolom.some((c) => /template|finger/i.test(c)), kolom.join(','));

    await mgr.shutdown();
    await mesinImpor.close();
    devices.remove(devImpor);
    employees.remove(kar.id);
    employees.remove(polos.id);
  }

  // ======================== 8c. hapus user di mesin (terpilih & semua)
  {
    const { MockDevice } = require('./mock-device');
    const { DeviceManager } = require('../src/main/zk/manager');

    const isiMesin = [
      { uid: 1, userId: '501', name: 'Mesin Satu', privilege: 0 },
      { uid: 2, userId: '502', name: 'Mesin Dua', privilege: 0 },
      { uid: 3, userId: '503', name: 'Mesin Tiga', privilege: 0 },
      { uid: 4, userId: '504', name: 'Mesin Empat', privilege: 0 },
    ];
    const mesin = new MockDevice({
      users: isiMesin.map((u) => ({ ...u })),
      attendance: [{ uid: 1, userId: '501', timestamp: new Date(2026, 6, 1, 8, 0, 0), status: 1, punch: 0 }],
      fingers: [
        { uid: 1, fid: 0, valid: 1, template: Buffer.alloc(200, 7) },
        { uid: 2, fid: 0, valid: 1, template: Buffer.alloc(200, 8) },
      ],
    });
    const portMesin = await mesin.listen();
    const devHapus = devices.create({ name: 'Mesin Hapus', ip: '127.0.0.1', port: portMesin });
    const mgr = new DeviceManager();

    await mgr.syncUsers(devHapus);
    eq('hapus mesin: daftar awal tersimpan', devices.reconcile(devHapus).device.length, 4);

    // --- hapus sebagian
    const sebagian = await mgr.removeDeviceUsers(devHapus, ['502', '504']);
    check('hapus sebagian: berhasil', sebagian.ok, sebagian.error || '');
    eq('hapus sebagian: dua terhapus', sebagian.removed.length, 2);
    eq('hapus sebagian: sisa di mesin', mesin.users.length, 2);
    check('hapus sebagian: yang tidak dipilih tetap ada',
      mesin.users.some((u) => u.userId === '501') && mesin.users.some((u) => u.userId === '503'));
    eq('hapus sebagian: sidik jarinya ikut terhapus', mesin.fingers.filter((f) => f.uid === 2).length, 0);
    eq('hapus sebagian: daftar di aplikasi ikut menyusut', devices.reconcile(devHapus).device.length, 2);

    // --- hapus semua
    const kemajuan = [];
    mgr.on('progress', (ev) => kemajuan.push(ev));
    const semua = await mgr.removeDeviceUsers(devHapus, null);
    check('hapus semua: berhasil', semua.ok, semua.error || '');
    eq('hapus semua: dua sisa ikut terhapus', semua.removed.length, 2);
    eq('hapus semua: mesin jadi kosong', mesin.users.length, 0);
    eq('hapus semua: jumlah sisa dilaporkan dari mesin', semua.sisa, 0);
    eq('hapus semua: seluruh sidik jari hilang', mesin.fingers.length, 0);
    eq('hapus semua: daftar di aplikasi ikut kosong', devices.reconcile(devHapus).device.length, 0);

    // Log absensi di mesin tidak boleh ikut terhapus.
    eq('hapus semua: log absensi di mesin tetap utuh', mesin.attendance.length, 1);

    // Kemajuan harus terpancar, lengkap dengan hitungan.
    check('hapus semua: kemajuan dipancarkan', kemajuan.length > 0, `${kemajuan.length} kejadian`);
    check('hapus semua: ada hitungan berjalan',
      kemajuan.some((e) => Number.isFinite(e.current) && Number.isFinite(e.total) && e.total > 0));
    check('hapus semua: ditutup dengan penanda selesai', kemajuan.some((e) => e.done));

    // Menghapus dari mesin yang sudah kosong tidak boleh meledak.
    const lagi = await mgr.removeDeviceUsers(devHapus, null);
    check('hapus semua pada mesin kosong: tetap aman', lagi.ok, lagi.error || '');
    eq('hapus semua pada mesin kosong: tidak ada yang terhapus', lagi.removed.length, 0);

    await mgr.shutdown();
    await mesin.close();
    devices.remove(devHapus);
  }

  // ======================== 8d. tarik per periode & rekap rentang tanggal
  {
    const { MockDevice } = require('./mock-device');
    const { DeviceManager } = require('../src/main/zk/manager');

    // Periode gaji 21 Agustus - 20 September; dua scan di luarnya.
    const scan = (bln, tgl, jam) => ({ uid: 1, userId: '1', timestamp: new Date(2026, bln, tgl, jam, 0, 0), status: 1, punch: 0 });
    const mesin = new MockDevice({
      users: [{ uid: 1, userId: '1', name: 'Ani Pagi', privilege: 0 }],
      attendance: [scan(7, 20, 8), scan(7, 21, 8), scan(8, 1, 8), scan(8, 20, 17), scan(8, 21, 8)],
    });
    const portMesin = await mesin.listen();
    const devPeriode = devices.create({ name: 'Mesin Periode', ip: '127.0.0.1', port: portMesin });
    const mgr = new DeviceManager();

    const tarik = await mgr.pull(devPeriode, { from: '2026-08-21', to: '2026-09-20' });
    check('tarik periode: berhasil', tarik.ok, tarik.error || '');
    eq('tarik periode: seluruh log mesin terbaca', tarik.onDevice, 5);
    eq('tarik periode: hanya yang dalam periode disimpan', tarik.inserted, 3);
    eq('tarik periode: yang di luar periode dilaporkan', tarik.outOfRange, 2);
    const tersimpan = db.get()
      .prepare('SELECT MIN(log_date) AS a, MAX(log_date) AS b, COUNT(*) AS n FROM attendance_logs WHERE device_id = ?')
      .get(devPeriode);
    eq('tarik periode: tanggal paling awal', tersimpan.a, '2026-08-21');
    eq('tarik periode: tanggal paling akhir (inklusif)', tersimpan.b, '2026-09-20');

    let periodeTerbalik = null;
    try {
      mgr.pull(devPeriode, { from: '2026-09-20', to: '2026-08-21' });
    } catch (err) {
      periodeTerbalik = err.message;
    }
    check('tarik periode: tanggal terbalik ditolak', /tidak boleh setelah/.test(periodeTerbalik || ''), periodeTerbalik);

    // Rekap rentang tanggal melintasi dua bulan.
    const rentang = reports.range({ from: '2026-08-21', to: '2026-09-20', employeeIds: [idA] });
    eq('rekap rentang: jumlah hari 21 Agu - 20 Sep', rentang.dates.length, 31);
    eq('rekap rentang: hari pertama', rentang.dates[0], '2026-08-21');
    check('rekap rentang: ringkasan satu karyawan', rentang.summary.length === 1 && rentang.summary[0].employee_id === idA);
    let rentangSalah = null;
    try {
      reports.range({ from: '2026-01-01', to: '2027-06-01' });
    } catch (err) {
      rentangSalah = err.message;
    }
    check('rekap rentang: lebih dari setahun ditolak', /maksimal/.test(rentangSalah || ''), rentangSalah);

    const exporterRentang = require('../src/main/services/exporter');
    const xlsxRentang = path.join(tmp, 'rentang.xlsx');
    await exporterRentang.monthlyExcel(xlsxRentang, { from: '2026-08-21', to: '2026-09-20' });
    check('Excel rekap rentang dibuat', fs.existsSync(xlsxRentang) && fs.statSync(xlsxRentang).size > 4000);
    const htmlRentang = exporterRentang.monthlyPdfHtml({ from: '2026-08-21', to: '2026-09-20' });
    check('PDF rekap rentang menyebut periodenya',
      htmlRentang.includes('Rekap Absensi Periode') && htmlRentang.includes('21 Agustus 2026 s/d 20 September 2026'));
    const kartuRentang = exporterRentang.employeeCardPdfHtml({ employeeId: idA, from: '2026-08-21', to: '2026-09-20' });
    check('kartu absensi rentang menyebut periodenya', kartuRentang.includes('21 Agustus 2026 s/d 20 September 2026'));

    await mgr.shutdown();
    await mesin.close();
    db.get().prepare('DELETE FROM attendance_logs WHERE device_id = ?').run(devPeriode);
    devices.remove(devPeriode);
  }

  // ============================= 8d2. event realtime yang dikirim berulang
  {
    const { MockDevice } = require('./mock-device');
    const { DeviceManager } = require('../src/main/zk/manager');
    const mesin = new MockDevice({ users: [], attendance: [], ignoreAcks: true });
    const portMesin = await mesin.listen();
    const devRt = devices.create({ name: 'Mesin Bandel', ip: '127.0.0.1', port: portMesin, live_capture: 1 });
    const mgr = new DeviceManager();
    const feed = [];
    mgr.on('live-scan', (ev) => feed.push(ev));
    const mulai = await mgr.startLive(devRt);
    check('realtime berulang: live capture tersambung', mulai.ok, mulai.error || '');
    mesin.pushScan({ userId: '1', timestamp: new Date(2026, 8, 21, 14, 52, 23) });
    await new Promise((r) => setTimeout(r, 450));
    check('realtime berulang: mesin memang mengirim ulang', mesin.liveResends >= 3, `${mesin.liveResends} kali`);
    eq('realtime berulang: feed Dashboard hanya menerima sekali', feed.length, 1);
    eq('realtime berulang: tersimpan sekali',
      db.get().prepare("SELECT COUNT(*) AS n FROM attendance_logs WHERE ts = '2026-09-21 14:52:23'").get().n, 1);
    await mgr.shutdown();
    await mesin.close();
    db.get().prepare('DELETE FROM attendance_logs WHERE device_id = ?').run(devRt);
    devices.remove(devRt);
  }

  // ================================ 8d3. PIN otomatis & bentrok PIN di mesin
  {
    const { MockDevice } = require('./mock-device');
    const { DeviceManager } = require('../src/main/zk/manager');
    const { samePerson } = require('../src/main/services/devices');

    check('nama: sama persis dianggap orang yang sama', samePerson('Adi Mulya', 'adi  mulya'));
    check('nama: terpotong di mesin dianggap sama', samePerson('Adi Mulya Suprayogi Panjang', 'Adi Mulya'));
    check('nama: nama cadangan mesin "User 25" bukan orang lain', samePerson('Siti', 'User 25'));
    check('nama: nama berbeda terdeteksi', !samePerson('Siti Aminah', 'Budi Santoso'));

    const mesin = new MockDevice({
      users: [
        { uid: 1, userId: '9077', name: 'Budi Asli', privilege: 0 },
        { uid: 2, userId: '9079', name: 'Adi Mulya', privilege: 0 },
      ],
      attendance: [],
    });
    const portMesin = await mesin.listen();
    const devPin = devices.create({ name: 'Mesin PIN', ip: '127.0.0.1', port: portMesin });
    const mgr = new DeviceManager();
    await mgr.syncUsers(devPin);

    eq('PIN otomatis: melewati PIN yang sudah dipakai di mesin', employees.nextPin(), '9080');
    const konflik = employees.pinConflicts('9077');
    check('bentrok PIN: user mesin yang belum diimport terdeteksi',
      konflik.length === 1 && konflik[0].name === 'Budi Asli' && konflik[0].device_name === 'Mesin PIN');
    eq('bentrok PIN: PIN kosong tidak bentrok', employees.pinConflicts('9080').length, 0);

    const siti = employees.create({ pin: '9077', name: 'Siti Baru' });
    const adi = employees.create({ pin: '9079', name: 'Adi Mulya Suprayogi' });
    const lain = employees.create({ pin: '9078', name: 'Karyawan Lain' });
    eq('bentrok PIN: PIN milik sendiri yang tidak berubah tidak dicek', employees.pinConflicts('9077', siti).length, 0);

    const coba = await mgr.pushEmployees(devPin, [siti, adi, lain]);
    check('kirim ke mesin: berhenti minta konfirmasi', coba.needsConfirm === true);
    check('kirim ke mesin: hanya orang yang berbeda yang dilaporkan',
      coba.conflicts.length === 1 && coba.conflicts[0].pin === '9077' && coba.conflicts[0].deviceName === 'Budi Asli');
    eq('kirim ke mesin: data orang di mesin belum tersentuh', mesin.users.find((u) => u.userId === '9077').name, 'Budi Asli');
    eq('kirim ke mesin: karyawan lain juga belum dikirim', mesin.users.some((u) => u.userId === '9078'), false);

    const lewati = await mgr.pushEmployees(devPin, [siti, adi, lain], { skipPins: ['9077'] });
    check('kirim tanpa yang bentrok: berhasil', lewati.ok, lewati.error || '');
    eq('kirim tanpa yang bentrok: dua terkirim', lewati.sent.length, 2);
    eq('kirim tanpa yang bentrok: Budi tetap utuh', mesin.users.find((u) => u.userId === '9077').name, 'Budi Asli');

    const timpa = await mgr.pushEmployees(devPin, [siti], { overwrite: true });
    check('tetap timpa: berhasil', timpa.ok, timpa.error || '');
    eq('tetap timpa: data di mesin diganti', mesin.users.find((u) => u.userId === '9077').name, 'Siti Baru');

    await mgr.shutdown();
    await mesin.close();
    [siti, adi, lain].forEach((id) => employees.remove(id));
    devices.remove(devPin);
  }

  // ================================================ 8e. login & hak akses
  {
    const { auth, authorize, verifySecret } = require('../src/main/services/auth');
    const { audit } = require('../src/main/services/audit');
    const gagal = (fn) => {
      try {
        fn();
        return null;
      } catch (err) {
        return err.message;
      }
    };

    check('login: aplikasi baru wajib membuat Admin', auth.needsSetup());
    check('login: password terlalu pendek ditolak',
      /minimal 8/.test(gagal(() => auth.setup({ username: 'admin', fullName: 'Admin', password: 'pendek' })) || ''));
    const awal = auth.setup({ username: 'admin', fullName: 'Admin HRD', password: 'rahasia-123' });
    eq('login: Admin pertama berperan admin', awal.user.role, 'admin');
    check('login: kode pemulihan diberikan', /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(awal.recoveryCode), awal.recoveryCode);
    check('login: pembuatan Admin tidak bisa diulang',
      /sudah pernah/.test(gagal(() => auth.setup({ username: 'admin2', fullName: 'X', password: 'rahasia-123' })) || ''));

    const tersimpan = db.get().prepare("SELECT password_hash FROM app_users WHERE username = 'admin'").get().password_hash;
    check('login: password tidak disimpan sebagai teks asli', !tersimpan.includes('rahasia-123') && tersimpan.startsWith('scrypt$'));
    check('login: hash cocok dengan password benar', verifySecret('rahasia-123', tersimpan));
    check('login: hash menolak password salah', !verifySecret('rahasia-124', tersimpan));

    eq('login: berhasil dengan password benar', auth.login({ username: 'ADMIN', password: 'rahasia-123' }).username, 'admin');
    check('login: password salah ditolak dengan pesan umum',
      /salah/.test(gagal(() => auth.login({ username: 'admin', password: 'keliru-sekali' })) || ''));
    for (let i = 0; i < 4; i++) gagal(() => auth.login({ username: 'admin', password: 'keliru-sekali' }));
    check('login: dikunci sementara setelah 5 kali salah',
      /Terlalu banyak/.test(gagal(() => auth.login({ username: 'admin', password: 'rahasia-123' })) || ''));

    // Operator dibuat Admin dengan password sementara.
    const op = auth.create({ username: 'operator1', fullName: 'Operator Satu', role: 'operator', password: 'sementara-1' });
    eq('pengguna: operator wajib ganti password', op.must_change_password, 1);
    const opMasuk = auth.login({ username: 'operator1', password: 'sementara-1' });
    eq('hak akses: wajib ganti password memblokir perintah lain',
      (authorize('reports.monthly', opMasuk) || {}).code, 'PASSWORD_CHANGE_REQUIRED');
    const opBaru = auth.changePassword(op.id, { oldPassword: 'sementara-1', newPassword: 'milikku-sendiri' });
    eq('pengguna: setelah ganti password bebas bekerja', authorize('reports.monthly', opBaru), null);
    eq('hak akses: operator boleh scan manual', authorize('attendance.addManual', opBaru), null);
    eq('hak akses: operator tidak boleh hapus user di mesin', (authorize('device.removeUsers', opBaru) || {}).code, 'FORBIDDEN');
    eq('hak akses: operator tidak boleh pulihkan backup', (authorize('backup.restore', opBaru) || {}).code, 'FORBIDDEN');
    eq('hak akses: operator tidak boleh kelola pengguna', (authorize('users.create', opBaru) || {}).code, 'FORBIDDEN');
    eq('hak akses: admin boleh pulihkan backup', authorize('backup.restore', awal.user), null);
    eq('hak akses: belum masuk ditolak', (authorize('employees.list', null) || {}).code, 'AUTH_REQUIRED');
    eq('hak akses: layar login tetap terbuka tanpa masuk', authorize('auth.login', null), null);

    check('pengguna: Admin terakhir tidak bisa dinonaktifkan akun lain',
      /minimal satu Admin/.test(gagal(() => auth.update(op.id, awal.user.id, { fullName: 'Admin HRD', role: 'admin', active: 0 })) || ''));
    check('pengguna: tidak bisa menurunkan peran sendiri',
      /akun sendiri/.test(gagal(() => auth.update(awal.user.id, awal.user.id, { fullName: 'Admin HRD', role: 'operator', active: 1 })) || ''));
    auth.update(awal.user.id, op.id, { fullName: 'Operator Satu', role: 'operator', active: 0 });
    eq('pengguna: akun nonaktif kehilangan sesi', auth.current(op.id), null);
    check('pengguna: akun nonaktif tidak bisa masuk',
      /dinonaktifkan/.test(gagal(() => auth.login({ username: 'operator1', password: 'milikku-sendiri' })) || ''));

    // Kode pemulihan: berlaku sekali, lalu diganti yang baru.
    const pulih = auth.recover({ username: 'admin', code: awal.recoveryCode.toLowerCase(), newPassword: 'password-baru-1' });
    eq('pemulihan: berhasil dengan kode yang benar', pulih.user.username, 'admin');
    check('pemulihan: kode baru diterbitkan', pulih.recoveryCode !== awal.recoveryCode);
    check('pemulihan: kode lama hangus',
      /salah/.test(gagal(() => auth.recover({ username: 'admin', code: awal.recoveryCode, newPassword: 'password-baru-2' })) || ''));

    audit.log(awal.user, 'Tes aktivitas', 'detail uji');
    eq('catatan aktivitas: tersimpan dan bisa dicari', audit.list({ search: 'Tes aktivitas' }).rows[0].username, 'admin');
    for (let i = 0; i < 30; i++) audit.log(awal.user, 'Tes halaman', `baris ${i}`);
    const hal2 = audit.list({ search: 'Tes halaman', limit: 10, offset: 10 });
    eq('catatan aktivitas: jumlah seluruh hasil', hal2.total, 30);
    eq('catatan aktivitas: satu halaman sesuai limit', hal2.rows.length, 10);
    eq('catatan aktivitas: halaman 2 berisi baris ke-11 dari terbaru', hal2.rows[0].detail, 'baris 19');
    eq('catatan aktivitas: pilihan "Semua" tanpa batas', audit.list({ search: 'Tes halaman', limit: null }).rows.length, 30);
    audit.savePending([{ at: '2026-09-21 10:00:00', username: 'admin', action: 'Pulihkan backup', detail: 'uji.db' }]);
    eq('catatan aktivitas: titipan pemulihan ditulis saat dibuka', audit.flushPending(), 1);
    eq('catatan aktivitas: titipan masuk ke database', audit.list({ search: 'uji.db' }).total, 1);
  }

  // ==================================================== 9. backup & pemulihan
  const backupSvc = require('../src/main/services/backup');

  const dibuat = await backupSvc.create({});
  check('backup dibuat di folder backup', fs.existsSync(dibuat.filePath) && dibuat.size > 10000, dibuat.sizeText);
  check('nama backup manual berawalan manual-', dibuat.fileName.startsWith('manual-'), dibuat.fileName);

  const daftar = backupSvc.list();
  eq('backup muncul di daftar', daftar.items.length, 1);
  eq('jenis backup terbaca', daftar.items[0].kind, 'manual');

  // --- pemeriksaan isi
  const isi = backupSvc.inspect(dibuat.filePath);
  check('pemeriksaan backup: dinyatakan sah', isi.ok, isi.error || '');
  eq('pemeriksaan backup: jumlah karyawan terbaca', isi.employees, employees.list().length);
  check('pemeriksaan backup: jumlah log terbaca', isi.logs > 0, `${isi.logs} log`);

  // --- berkas yang tidak sah harus ditolak SEBELUM menimpa apa pun
  const kecil = path.join(tmp, 'kecil.db');
  fs.writeFileSync(kecil, 'terlalu pendek');
  const tolak0 = backupSvc.inspect(kecil);
  check('berkas terlalu kecil ditolak', !tolak0.ok);
  check('alasan menyebut ukuran', /terlalu kecil/i.test(tolak0.error || ''), tolak0.error);

  const bukanDb = path.join(tmp, 'catatan.db');
  fs.writeFileSync(bukanDb, 'ini cuma teks biasa, bukan database sama sekali. '.repeat(30));
  const tolak1 = backupSvc.inspect(bukanDb);
  check('berkas teks biasa ditolak', !tolak1.ok);
  check('alasan menyebut bukan SQLite', /bukan database SQLite/i.test(tolak1.error || ''), tolak1.error);

  const dbLain = path.join(tmp, 'database-lain.db');
  const asing = new (require('better-sqlite3'))(dbLain);
  asing.exec('CREATE TABLE catatan (id INTEGER PRIMARY KEY, isi TEXT)');
  asing.close();
  const tolak2 = backupSvc.inspect(dbLain);
  check('database SQLite milik aplikasi lain ditolak', !tolak2.ok);
  check('alasan menyebut tabel yang hilang', /bukan milik aplikasi/i.test(tolak2.error || ''), tolak2.error);

  eq('berkas tidak ada ditolak', backupSvc.inspect(path.join(tmp, 'hilang.db')).ok, false);

  // --- pemulihan sungguhan: ubah data, pulihkan, pastikan kembali
  const jumlahSebelum = employees.list().length;
  employees.create({ pin: 'HAPUS-1', name: 'Karyawan Setelah Backup' });
  eq('data bertambah setelah backup', employees.list().length, jumlahSebelum + 1);

  const pulih = await backupSvc.restore(dibuat.filePath);
  check('pemulihan berhasil', pulih.ok, pulih.error || '');
  check('salinan pengaman dibuat sebelum menimpa', pulih.safety && fs.existsSync(pulih.safety));

  db.init(tmp);
  eq('data kembali seperti saat backup', employees.list().length, jumlahSebelum);
  check('karyawan yang dibuat setelah backup ikut hilang', !employees.findByPin('HAPUS-1'));

  // --- salinan pengaman itu sendiri harus bisa dipulihkan lagi
  const balik = backupSvc.inspect(pulih.safety);
  check('salinan pengaman sah dan bisa dipakai', balik.ok, balik.error || '');
  eq('salinan pengaman memuat data yang sempat hilang', balik.employees, jumlahSebelum + 1);

  // --- pembatasan jumlah backup otomatis
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await backupSvc.create({ auto: true });
  }
  const hasilPrune = backupSvc.prune(2);
  eq('backup otomatis lama dibuang', hasilPrune.removed, 2);
  eq('backup otomatis tersisa sesuai batas', hasilPrune.kept, 2);
  check(
    'backup manual tidak ikut terbuang',
    backupSvc.list().items.some((i) => i.kind === 'manual')
  );
  check(
    'salinan pengaman tidak ikut terbuang',
    backupSvc.list().items.some((i) => i.kind === 'pengaman')
  );

  db.close();

  // ============================== 10. migrasi database versi sebelumnya
  // Pengguna yang sudah memakai versi lama punya tabel tanpa kolom kartu RFID.
  // schema.sql memakai CREATE TABLE IF NOT EXISTS, jadi kolom baru hanya masuk
  // lewat migrasi — dan datanya tidak boleh hilang.
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-lama-'));
  fs.mkdirSync(path.join(oldDir, 'data'), { recursive: true });
  const Database = require('better-sqlite3');
  const lamaDb = new Database(path.join(oldDir, 'data', 'absensi.db'));
  lamaDb.exec(`
    CREATE TABLE employees (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pin           TEXT NOT NULL UNIQUE,
      nip           TEXT,
      name          TEXT NOT NULL,
      department_id INTEGER,
      position      TEXT,
      phone         TEXT,
      email         TEXT,
      join_date     TEXT,
      default_shift_id INTEGER,
      active        INTEGER NOT NULL DEFAULT 1,
      note          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO employees (pin, name, position) VALUES ('77', 'Karyawan Versi Lama', 'Staf');
  `);
  lamaDb.close();

  db.init(oldDir);
  const kolom = db.get().prepare("SELECT name FROM pragma_table_info('employees')").all().map((r) => r.name);
  check('migrasi: kolom kartu RFID ditambahkan', kolom.includes('card'));
  check('migrasi: kolom hak akses ditambahkan', kolom.includes('privilege'));
  check('migrasi: kolom password mesin ditambahkan', kolom.includes('device_password'));

  const karyawanLama = db.get().prepare("SELECT * FROM employees WHERE pin = '77'").get();
  eq('migrasi: data karyawan lama utuh', karyawanLama && karyawanLama.name, 'Karyawan Versi Lama');
  eq('migrasi: kolom lain tidak rusak', karyawanLama && karyawanLama.position, 'Staf');
  eq('migrasi: kolom baru diisi nilai bawaan', karyawanLama && karyawanLama.card, 0);
  eq('migrasi: shift bawaan tetap ter-seed', db.get().prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 4);

  // Menjalankan ulang tidak boleh menggandakan kolom atau melempar galat.
  db.close();
  db.init(oldDir);
  eq(
    'migrasi: aman dijalankan berulang',
    db.get().prepare("SELECT COUNT(*) AS n FROM pragma_table_info('employees') WHERE name = 'card'").get().n,
    1
  );

  db.close();
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    failed += 1;
    results.push(` GAGAL │ pengujian berhenti: ${err.stack || err.message}`);
  }

  console.log(`\n${'─'.repeat(78)}`);
  results.forEach((r) => console.log(r));
  console.log('─'.repeat(78));
  console.log(`${results.length - failed}/${results.length} pemeriksaan lolos${failed ? ` — ${failed} GAGAL` : ' — semua lolos'}\n`);
  app.exit(failed ? 1 : 0);
});
