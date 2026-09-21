'use strict';

const { USHRT_MAX, TCP_MAGIC } = require('./const');

/**
 * Checksum ala ZKTeco: jumlahkan tiap pasang byte sebagai uint16 LE,
 * bungkus pada USHRT_MAX, lalu komplemen satu.
 */
function createChecksum(buf) {
  let checksum = 0;
  let i = 0;
  while (i + 1 < buf.length) {
    checksum += buf.readUInt16LE(i);
    if (checksum > USHRT_MAX) checksum -= USHRT_MAX;
    i += 2;
  }
  if (i < buf.length) {
    checksum += buf[buf.length - 1];
  }
  while (checksum > USHRT_MAX) checksum -= USHRT_MAX;
  checksum = ~checksum;
  while (checksum < 0) checksum += USHRT_MAX;
  return checksum & 0xffff;
}

/**
 * Susun header 8 byte + payload.
 *
 * Catatan penting soal kompatibilitas firmware: checksum dihitung memakai
 * replyId lama, baru setelah itu replyId dinaikkan dan ditulis ulang ke paket.
 * Terlihat seperti bug, tapi ini persis yang dilakukan pyzk dan node-zklib —
 * dua implementasi yang terbukti jalan di perangkat asli. Jangan "dirapikan".
 */
function createPacket(command, data, sessionId, replyId) {
  const payload = data && data.length ? Buffer.from(data) : Buffer.alloc(0);
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16LE(command & 0xffff, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(sessionId & 0xffff, 4);
  buf.writeUInt16LE(replyId & 0xffff, 6);
  payload.copy(buf, 8);
  buf.writeUInt16LE(createChecksum(buf), 2);
  const nextReplyId = (replyId + 1) % USHRT_MAX;
  buf.writeUInt16LE(nextReplyId, 6);
  return { packet: buf, nextReplyId };
}

/** Bungkus paket dengan header TCP 8 byte: magic + panjang payload. */
function wrapTcp(packet) {
  const out = Buffer.alloc(8 + packet.length);
  TCP_MAGIC.copy(out, 0);
  out.writeUInt32LE(packet.length, 4);
  packet.copy(out, 8);
  return out;
}

/** Baca header 8 byte menjadi objek. */
function parseHeader(buf) {
  return {
    command: buf.readUInt16LE(0),
    checksum: buf.readUInt16LE(2),
    sessionId: buf.readUInt16LE(4),
    replyId: buf.readUInt16LE(6),
  };
}

/**
 * Scramble password + session id menjadi comm key, port dari MakeKey() commpro.c.
 * Dipakai saat mesin membalas CMD_ACK_UNAUTH (mesin dipasangi COMM key).
 */
function makeCommKey(password, sessionId, ticks = 50) {
  const key = Number(password) >>> 0;
  let k = 0;
  for (let i = 0; i < 32; i++) {
    if (key & (1 << i)) k = ((k << 1) | 1) >>> 0;
    else k = (k << 1) >>> 0;
  }
  k = (k + (Number(sessionId) >>> 0)) >>> 0;

  const b = Buffer.alloc(4);
  b.writeUInt32LE(k, 0);
  b[0] ^= 'Z'.charCodeAt(0);
  b[1] ^= 'K'.charCodeAt(0);
  b[2] ^= 'S'.charCodeAt(0);
  b[3] ^= 'O'.charCodeAt(0);

  // tukar dua uint16
  const swapped = Buffer.alloc(4);
  swapped.writeUInt16LE(b.readUInt16LE(2), 0);
  swapped.writeUInt16LE(b.readUInt16LE(0), 2);

  const B = ticks & 0xff;
  const out = Buffer.alloc(4);
  out[0] = swapped[0] ^ B;
  out[1] = swapped[1] ^ B;
  out[2] = B;
  out[3] = swapped[3] ^ B;
  return out;
}

/** Waktu terkemas 4 byte (detik sejak 2000-01-01 dengan bulan 31 hari). */
function decodeTime(value) {
  let t = value >>> 0;
  const second = t % 60;
  t = Math.floor(t / 60);
  const minute = t % 60;
  t = Math.floor(t / 60);
  const hour = t % 24;
  t = Math.floor(t / 24);
  const day = (t % 31) + 1;
  t = Math.floor(t / 31);
  const month = (t % 12) + 1;
  t = Math.floor(t / 12);
  const year = t + 2000;
  return new Date(year, month - 1, day, hour, minute, second);
}

/** Kebalikan decodeTime, untuk CMD_SET_TIME. */
function encodeTime(date) {
  const year = date.getFullYear() - 2000;
  const month = date.getMonth();
  const day = date.getDate() - 1;
  return (
    (((year * 12 + month) * 31 + day) * 24 * 60 * 60 +
      date.getHours() * 3600 +
      date.getMinutes() * 60 +
      date.getSeconds()) >>>
    0
  );
}

/** Waktu 6 byte (YY MM DD hh mm ss) yang dipakai paket realtime. */
function decodeTimeHex(buf) {
  return new Date(2000 + buf[0], buf[1] - 1, buf[2], buf[3], buf[4], buf[5]);
}


/** Ambil string sampai NUL, buang byte kontrol sisa firmware. */
function cString(buf) {
  const end = buf.indexOf(0);
  const slice = end === -1 ? buf : buf.subarray(0, end);
  let cut = slice.length;
  while (cut > 0 && slice[cut - 1] < 0x20) cut -= 1;
  let start = 0;
  while (start < cut && slice[start] < 0x20) start += 1;
  return slice.subarray(start, cut).toString('utf8').trim();
}

module.exports = {
  createChecksum,
  createPacket,
  wrapTcp,
  parseHeader,
  makeCommKey,
  decodeTime,
  encodeTime,
  decodeTimeHex,
  cString,
};
