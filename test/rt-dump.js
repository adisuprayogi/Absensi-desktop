/**
 * Rekam isi mentah paket realtime dari mesin asli, untuk memetakan posisi
 * byte mode verifikasi pada firmware tertentu.
 *
 *   node test/rt-dump.js <ip> [port] [commKey]
 *
 * Tutup aplikasi dulu supaya koneksinya tidak berebut. Setelah muncul
 * "Silakan scan", tempel jari, kartu, atau ketik password di mesin.
 * Tekan Ctrl+C untuk selesai.
 */
'use strict';

const { ZKClient } = require('../src/main/zk/client');
const { toDateTimeStr } = require('../src/main/util/datetime');

const [ip, port = '4370', commKey = '0'] = process.argv.slice(2);
if (!ip) {
  console.error('Pemakaian: node test/rt-dump.js <ip> [port] [commKey]');
  process.exit(1);
}

const hex = (buf) => buf.toString('hex').match(/.{1,2}/g).join(' ');

async function main() {
  const zk = new ZKClient({ ip, port, commKey });
  await zk.connect();
  console.log(`Terhubung ke ${ip}:${port}`);

  // Pembanding: 3 log terakhir di memori mesin, yang mode verifikasinya pasti benar.
  const logs = await zk.getAttendance();
  console.log(`\nLog tersimpan di mesin: ${logs.length}. Tiga terakhir:`);
  for (const r of logs.slice(-3)) {
    console.log(`  PIN ${r.userId}  ${toDateTimeStr(r.timestamp)}  verifikasi=${r.status}  punch=${r.punch}`);
  }

  // Tangkap payload mentah sebelum diurai.
  const asli = zk._handleLiveFrame.bind(zk);
  zk._handleLiveFrame = (frame) => {
    console.log(`\nPaket realtime ${frame.data.length} byte:`);
    console.log(`  ${hex(frame.data)}`);
    for (const r of ZKClient.parseLiveRecords(frame.data)) {
      console.log(`  terbaca: PIN ${r.userId}  ${toDateTimeStr(r.timestamp)}  byte24=${r.status}  byte25=${r.punch}`);
    }
    asli(frame);
  };

  await zk.startLive();
  console.log('\nSilakan scan di mesin (sidik jari, lalu kartu/password bila ada). Ctrl+C untuk selesai.');

  process.on('SIGINT', async () => {
    await zk.disconnect().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});
