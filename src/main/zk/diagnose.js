'use strict';

const net = require('node:net');
const dgram = require('node:dgram');

const { CMD, USHRT_MAX, TCP_MAGIC } = require('./const');
const { createPacket, wrapTcp, parseHeader } = require('./packet');
const { ZKClient } = require('./client');

/**
 * Port yang lazim dipakai mesin absensi. 4370 adalah bawaan Solution/ZKTeco;
 * sisanya sering muncul di firmware atau konfigurasi lain, dan berguna untuk
 * memastikan mesinnya memang hidup sekalipun portnya bukan yang diharapkan.
 */
const COMMON_PORTS = [
  { port: 4370, note: 'Port bawaan Solution X105 / X401' },
  { port: 4371, note: 'Alternatif pada sebagian firmware' },
  { port: 5005, note: 'Dipakai sebagian mesin ZKTeco lama' },
  { port: 80, note: 'Halaman web mesin (menandakan mesin hidup di jaringan)' },
  { port: 8000, note: 'Halaman web alternatif' },
];

/** Apakah sebuah port TCP menerima koneksi. */
function tcpProbe(ip, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ open, error });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true, null));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err.code || err.message));
    socket.connect(port, ip);
  });
}

/**
 * Kirim satu paket CONNECT lewat UDP dan tunggu balasan apa pun.
 * UDP tidak punya konsep "port terbuka", jadi satu-satunya bukti adalah
 * mesin benar-benar menjawab.
 */
function udpProbe(ip, port, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (answered, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* sudah tertutup */
      }
      resolve({ answered, error });
    };

    const timer = setTimeout(() => finish(false, 'tidak ada balasan'), timeout);
    socket.on('message', (msg) => {
      if (msg.length >= 8) {
        const header = parseHeader(msg);
        finish(true, null, header);
      } else {
        finish(true, null);
      }
    });
    socket.on('error', (err) => finish(false, err.code || err.message));

    const { packet } = createPacket(CMD.CONNECT, null, 0, USHRT_MAX - 1);
    socket.send(packet, 0, packet.length, port, ip, (err) => {
      if (err) finish(false, err.code || err.message);
    });
  });
}

/**
 * Kenali antarmuka web bawaan mesin ("ZK Web Server"). Keberadaannya adalah
 * bukti kuat bahwa alamat itu memang mesin absensi, sekaligus jalan lain untuk
 * memeriksa pengaturannya lewat peramban.
 */
function webProbe(ip, port, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buf = '';
    let done = false;
    const finish = (zkWeb) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ zkWeb });
    };
    socket.setTimeout(timeout);
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => {
      socket.write(`GET / HTTP/1.0\r\nHost: ${ip}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.length > 2048 || /\r\n\r\n/.test(buf)) finish(/ZK Web Server/i.test(buf));
    });
    socket.once('close', () => finish(/ZK Web Server/i.test(buf)));
    socket.connect(port, ip);
  });
}

/**
 * Apakah yang menjawab di port itu benar-benar mesin ZK.
 * Dikenali dari penanda frame 0x50 0x50 0x82 0x7d pada balasan TCP.
 */
function zkHandshakeProbe(ip, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('timeout', () => finish({ zk: false, reason: 'mesin tidak menjawab sapaan protokol' }));
    socket.once('error', (err) => finish({ zk: false, reason: err.code || err.message }));
    socket.once('connect', () => {
      const { packet } = createPacket(CMD.CONNECT, null, 0, USHRT_MAX - 1);
      socket.write(wrapTcp(packet));
    });
    socket.once('data', (chunk) => {
      if (chunk.length >= 8 && chunk.subarray(0, 4).equals(TCP_MAGIC)) {
        const header = chunk.length >= 16 ? parseHeader(chunk.subarray(8, 16)) : null;
        finish({
          zk: true,
          needsCommKey: header ? header.command === CMD.ACK_UNAUTH : false,
          command: header ? header.command : null,
        });
      } else {
        finish({ zk: false, reason: 'balasan bukan protokol ZKTeco (mungkin perangkat lain)' });
      }
    });
    socket.connect(port, ip);
  });
}

/**
 * Periksa satu mesin secara menyeluruh dan susun kesimpulan yang bisa langsung
 * ditindaklanjuti: mesinnya hidup atau tidak, port mana yang terbuka, apakah
 * yang menjawab benar mesin absensi, dan apakah butuh Comm Key.
 *
 * @param {Array} extraPorts  daftar port lain yang ikut dipindai. Bisa diganti
 *   saat pengujian agar hasilnya tidak bergantung pada isi jaringan setempat.
 */
async function diagnose({ ip, port = 4370, commKey = 0, protocol = 'tcp', extraPorts = COMMON_PORTS }) {
  const hasil = {
    ip,
    port: Number(port),
    protocol,
    ports: [],
    reachable: false,
    zkPort: null,
    needsCommKey: false,
    connected: false,
    error: null,
    saran: [],
  };

  // --- 1. Port yang sedang dipakai, plus port lain yang lazim
  const daftar = [{ port: Number(port), note: 'Port yang diisi di aplikasi' }];
  for (const p of extraPorts) {
    if (p.port !== Number(port)) daftar.push(p);
  }

  for (const item of daftar) {
    // eslint-disable-next-line no-await-in-loop
    const tcp = await tcpProbe(ip, item.port);
    const baris = { port: item.port, note: item.note, tcp: tcp.open, tcpError: tcp.error, zk: false };
    if (tcp.open) {
      hasil.reachable = true;
      // eslint-disable-next-line no-await-in-loop
      const hs = await zkHandshakeProbe(ip, item.port);
      baris.zk = hs.zk;
      baris.zkReason = hs.reason;

      if (!hs.zk && (item.port === 80 || item.port === 8000)) {
        // eslint-disable-next-line no-await-in-loop
        const web = await webProbe(ip, item.port);
        if (web.zkWeb) {
          baris.zkWeb = true;
          baris.zkReason = 'antarmuka web mesin absensi';
          hasil.webPort = item.port;
        }
      }
      if (hs.zk && !hasil.zkPort) {
        hasil.zkPort = item.port;
        hasil.needsCommKey = !!hs.needsCommKey;
      }
    }
    hasil.ports.push(baris);
  }

  // --- 2. Bila TCP buntu, coba UDP di port yang dipilih
  if (!hasil.zkPort) {
    const udp = await udpProbe(ip, Number(port));
    hasil.udp = udp;
    if (udp.answered) {
      hasil.reachable = true;
      hasil.zkPort = Number(port);
      hasil.saran.push(
        `Mesin menjawab lewat UDP di port ${port}, tetapi tidak lewat TCP. Ubah Protokol menjadi UDP di form mesin.`
      );
    }
  }

  // --- 3. Bila ada port ZK, coba koneksi sungguhan lengkap dengan Comm Key
  if (hasil.zkPort) {
    const client = new ZKClient({ ip, port: hasil.zkPort, commKey, protocol: 'tcp', timeout: 5000 });
    try {
      await client.connect();
      hasil.connected = true;
      hasil.firmware = await client.getFirmwareVersion().catch(() => '');
      hasil.deviceName = await client.getDeviceName().catch(() => '');
      hasil.serial = await client.getSerialNumber().catch(() => '');
      const sizes = await client.getSizes().catch(() => ({}));
      hasil.users = sizes.users;
      hasil.records = sizes.records;
    } catch (err) {
      hasil.error = err.message;
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  hasil.saran.push(...susunSaran(hasil));
  return hasil;
}

/** Terjemahkan hasil pemeriksaan menjadi langkah yang konkret. */
function susunSaran(h) {
  const saran = [];

  if (!h.reachable) {
    saran.push(
      `Komputer tidak bisa menjangkau ${h.ip} sama sekali. Buka Command Prompt lalu jalankan: ping ${h.ip}`
    );
    saran.push(
      'Bila ping juga gagal: pastikan kabel LAN mesin terpasang, dan alamat IP komputer berada di jaringan yang sama dengan mesin (tiga angka pertama IP harus sama, mis. 192.168.1.x).'
    );
    saran.push(
      'Cek alamat IP mesin lewat: Menu → Komunikasi (Comm.) → Jaringan (Ethernet). Pastikan angkanya sama persis dengan yang diisi di aplikasi.'
    );
    return saran;
  }

  if (!h.zkPort) {
    const terbuka = h.ports.filter((p) => p.tcp).map((p) => p.port);
    if (terbuka.length) {
      saran.push(
        `Alamat ${h.ip} hidup dan port ${terbuka.join(', ')} terbuka, tetapi tidak ada yang menjawab sebagai mesin absensi. Kemungkinan IP itu milik perangkat lain di jaringan.`
      );
    }
    if (h.webPort) {
      saran.push(
        `Alamat ini melayani halaman web mesin absensi, jadi kemungkinan besar memang mesinnya — tetapi port datanya tertutup. Buka http://${h.ip} di peramban untuk memeriksa pengaturan jaringannya.`
      );
    }
    saran.push(
      'Cek nomor port di mesin: Menu → Komunikasi (Comm.) → Jaringan (Ethernet) → TCP COMM Port. Nilai bawaannya 4370.'
    );
    saran.push(
      'Bila mesin memakai fitur "Comm. Key" atau koneksi terkunci, aktifkan dulu koneksi PC di menu yang sama.'
    );
    return saran;
  }

  if (h.zkPort !== h.port) {
    saran.push(
      `Mesin ditemukan di port ${h.zkPort}, bukan ${h.port}. Ubah kolom Port di form mesin menjadi ${h.zkPort}.`
    );
  }

  if (h.connected) {
    saran.push('Koneksi berhasil. Simpan pengaturan ini, lalu tekan "Sinkron User" untuk menarik daftar karyawan dari mesin.');
    return saran;
  }

  if (h.webPort) {
    const alamat = h.webPort === 80 ? `http://${h.ip}` : `http://${h.ip}:${h.webPort}`;
    saran.push(
      `Mesin ini juga punya halaman web di ${alamat} — bisa dibuka lewat peramban untuk memeriksa pengaturannya bila menunya sulit dijangkau.`
    );
  }

  if (h.needsCommKey) {
    saran.push(
      'Mesin meminta Comm Key. Lihat nilainya di mesin: Menu → Komunikasi (Comm.) → Kunci Komunikasi (Comm Key), lalu isikan angka itu di form mesin.'
    );
  }
  if (h.error) {
    saran.push(`Mesin menjawab tetapi koneksi ditolak: ${h.error}`);
  }
  return saran;
}

module.exports = { diagnose, tcpProbe, udpProbe, zkHandshakeProbe, COMMON_PORTS };
