/**
 * Menjalankan mesin absensi Solution X105 TIRUAN di komputer ini, supaya
 * seluruh fitur mesin bisa dicoba tanpa perangkat fisik.
 *
 *   node test/fake-machine.js            (port 4370)
 *   node test/fake-machine.js 4371       (port lain)
 *
 * Lalu di aplikasi: Mesin Absensi > + Tambah Mesin
 *   Alamat IP : 127.0.0.1
 *   Port      : 4370
 *   Comm Key  : 0
 */
'use strict';

const { MockDevice } = require('./mock-device');

const PORT = Number(process.argv[2]) || 4370;

const USERS = [
  { uid: 1, userId: '101', name: 'Ahmad Fauzi', privilege: 0 },
  { uid: 2, userId: '102', name: 'Siti Rahayu', privilege: 14 },
  { uid: 3, userId: '103', name: 'Budi Santoso', privilege: 0 },
  { uid: 4, userId: '104', name: 'Dewi Lestari', privilege: 0 },
  { uid: 5, userId: '105', name: 'Rizky Pratama', privilege: 0 },
  { uid: 6, userId: '106', name: 'Nurul Hidayah', privilege: 0 },
];

/** Jam scan dibuat agak acak supaya rekapnya terasa seperti data asli. */
function jitter(base, spread) {
  return base + Math.round((Math.random() - 0.5) * spread);
}

function buildAttendance() {
  const out = [];
  const today = new Date();

  for (let back = 13; back >= 0; back--) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // akhir pekan libur

    const at = (h, m, userId, uid, punch) =>
      out.push({
        uid,
        userId,
        timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, jitter(30, 50)),
        status: 1,
        punch,
      });

    // 101 — rajin, kadang lembur tipis
    at(7, jitter(50, 12), '101', 1, 0);
    at(17, jitter(10, 20), '101', 1, 1);

    // 102 — sering telat beberapa menit
    at(8, jitter(14, 16), '102', 2, 0);
    at(17, jitter(35, 20), '102', 2, 1);

    // 103 — shift malam, pulang dini hari berikutnya
    at(21, jitter(52, 10), '103', 3, 0);
    out.push({
      uid: 3,
      userId: '103',
      timestamp: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 6, jitter(8, 14), 0),
      status: 1,
      punch: 1,
    });

    // 104 — sesekali lupa absen pulang
    at(7, jitter(56, 10), '104', 4, 0);
    if (back % 5 !== 2) at(16, jitter(35, 15), '104', 4, 1);

    // 105 — sering lembur
    at(8, jitter(2, 8), '105', 5, 0);
    at(19, jitter(5, 40), '105', 5, 1);

    // 106 — beberapa hari tidak masuk sama sekali (jadi Alpha)
    if (back % 4 !== 1) {
      at(7, jitter(58, 10), '106', 6, 0);
      at(17, jitter(5, 15), '106', 6, 1);
    }
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}

(async () => {
  const attendance = buildAttendance();
  const device = new MockDevice({ users: USERS, attendance, port: PORT, host: '0.0.0.0' });

  try {
    await device.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} sedang dipakai. Jalankan dengan port lain, mis:\n  node test/fake-machine.js 4371\n`);
    } else {
      console.error(`\nGagal menjalankan mesin tiruan: ${err.message}\n`);
    }
    process.exit(1);
  }

  console.log(`
╭──────────────────────────────────────────────────────────────╮
│  MESIN ABSENSI TIRUAN AKTIF                                  │
│  Meniru Solution X105 (protokol ZKTeco)                      │
╰──────────────────────────────────────────────────────────────╯

  Alamat IP  : 127.0.0.1
  Port       : ${PORT}
  Comm Key   : 0
  Protokol   : TCP

  Isi mesin  : ${USERS.length} user, ${attendance.length} log absensi (14 hari terakhir)

  Di aplikasi, buka  Mesin Absensi > + Tambah Mesin  lalu isi data di atas.
  Centang "Aktifkan realtime" untuk melihat scan masuk langsung.

  Scan realtime dikirim otomatis tiap 20 detik selama jendela ini terbuka.
  Tekan Ctrl+C untuk mematikan mesin tiruan.
`);

  // Kirim scan realtime berkala, supaya live capture bisa dilihat bekerja.
  let n = 0;
  setInterval(() => {
    if (!device._liveSend) return;
    const user = USERS[n % USERS.length];
    n += 1;
    const now = new Date();
    try {
      device.pushScan({ userId: user.userId, timestamp: now });
      console.log(
        `  → scan realtime: ${user.userId} ${user.name} pada ${now.toLocaleTimeString('id-ID')}`
      );
    } catch {
      /* klien sedang tidak mendengarkan */
    }
  }, 20000);

  process.on('SIGINT', async () => {
    console.log('\nMesin tiruan dimatikan.');
    await device.close();
    process.exit(0);
  });
})();
