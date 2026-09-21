/**
 * Mesin absensi tiruan yang bicara protokol ZKTeco (seperti Solution X105/X401).
 * Dipakai untuk menguji klien tanpa perangkat fisik.
 *
 * Meniru dua pola transfer data yang dipakai firmware asli:
 *  - daftar user  : CMD_PREPARE_DATA lalu rentetan CMD_DATA
 *  - log absensi  : CMD_ACK_OK berisi ukuran, lalu ditarik per potongan
 */
'use strict';

const net = require('node:net');
const dgram = require('node:dgram');

const { CMD, TCP_MAGIC } = require('../src/main/zk/const');
const { createPacket, wrapTcp, parseHeader, encodeTime, cString, makeCommKey } = require('../src/main/zk/packet');

const SESSION_ID = 0x1234;

/** Rakit satu record log absensi 40 byte. */
function attendanceRecord({ uid, userId, timestamp, status = 1, punch = 0 }) {
  const r = Buffer.alloc(40);
  r.writeUInt16LE(uid, 0);
  r.write(userId, 2, 24, 'latin1');
  r.writeUInt8(status, 26);
  r.writeUInt32LE(encodeTime(timestamp), 27);
  r.writeUInt8(punch, 31);
  return r;
}

/** Rakit satu record user 72 byte. */
function userRecord({ uid, userId, name, privilege = 0, card = 0, password = '' }) {
  const r = Buffer.alloc(72);
  r.writeUInt16LE(uid, 0);
  r.writeUInt8(privilege, 2);
  r.write(password, 3, 8, 'latin1');
  r.write(name, 11, 24, 'utf8');
  r.writeUInt32LE(card, 35);
  r.write('', 40, 7, 'latin1');
  r.write(userId, 48, 24, 'latin1');
  return r;
}

/** Kebalikan userRecord: baca record 72 byte yang ditulis klien ke mesin. */
function parseUserRecord(r) {
  return {
    uid: r.readUInt16LE(0),
    privilege: r.readUInt8(2),
    password: cString(r.subarray(3, 11)),
    name: cString(r.subarray(11, 35)),
    card: r.readInt32LE(35),
    groupId: cString(r.subarray(40, 47)),
    userId: cString(r.subarray(48, 72)),
  };
}

/**
 * Baca record user dari jalur UNGGAH BUFFER.
 *
 * Panjangnya 73 byte, bukan 72 seperti perintah tulis user biasa: diawali byte
 * penanda 2 dan ada byte tetap 1 setelah nomor kartu. Mesin tiruan sengaja
 * memeriksa penanda itu dan menolak kiriman yang tata letaknya keliru —
 * perangkat asli menerimanya diam-diam lalu membuang isinya, dan kesalahan
 * seperti itu tidak akan pernah tertangkap kalau tiruannya ikut permisif.
 */
function parseUploadUserRecord(r) {
  if (r.length !== 73) {
    throw new Error(`record user pada unggahan harus 73 byte, diterima ${r.length}`);
  }
  if (r.readUInt8(0) !== 2) {
    throw new Error(`byte penanda record user harus 2, diterima ${r.readUInt8(0)}`);
  }
  return {
    uid: r.readUInt16LE(1),
    privilege: r.readUInt8(3),
    password: cString(r.subarray(4, 12)),
    name: cString(r.subarray(12, 36)),
    card: r.readUInt32LE(36),
    groupId: cString(r.subarray(41, 48)),
    userId: cString(r.subarray(49, 73)),
  };
}

/** Blok template sidik jari: uint32 panjang + rentetan record. */
function fingerBlock(fingers) {
  const parts = fingers.map((f) => {
    const r = Buffer.alloc(6 + f.template.length);
    r.writeUInt16LE(6 + f.template.length, 0);
    r.writeUInt16LE(f.uid, 2);
    r.writeInt8(f.fid, 4);
    r.writeInt8(f.valid, 5);
    f.template.copy(r, 6);
    return r;
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Blok data lengkap: uint32 panjang record + isinya. */
function dataBlock(records) {
  const body = Buffer.concat(records);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

class MockDevice {
  constructor({ users = [], attendance = [], fingers = [], protocol = 'tcp', commKey = 0, port = 0, host = '127.0.0.1', replyDelay = 0 } = {}) {
    // Jeda balasan buatan. Perangkat asli membalas dalam puluhan milidetik;
    // tanpa jeda, pengujian selesai terlalu cepat untuk menguji hal-hal yang
    // hanya tampak saat proses sedang berjalan, seperti bilah kemajuan.
    this.replyDelay = replyDelay;
    this.users = users;
    this.fingers = fingers;
    this.refreshCount = 0;
    this.uploadBuffer = null;
    this.uploadExpected = 0;
    this.attendance = attendance;
    this.protocol = protocol;
    this.commKey = commKey;
    this.tcp = protocol !== 'udp';
    // port 0 = pilih port bebas (dipakai saat pengujian otomatis)
    this.wantPort = port;
    this.host = host;

    this._rebuildUsers();
    this.attBlock = dataBlock(attendance.map(attendanceRecord));
    this.pending = null; // blok yang sedang ditarik per potongan
    this.received = []; // riwayat perintah, untuk pemeriksaan di tes
    this.server = null;
    this.port = 0;
    this.sockets = new Set();
    this.lastPeer = null;
  }

  _rebuildUsers() {
    this.userBlock = dataBlock(this.users.map(userRecord));
  }

  listen() {
    return new Promise((resolve) => {
      if (this.tcp) {
        this.server = net.createServer((socket) => {
          this.sockets.add(socket);
          socket.on('close', () => this.sockets.delete(socket));
          socket.on('error', () => {});
          let buf = Buffer.alloc(0);
          socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
              if (buf.length < 8) return;
              if (!buf.subarray(0, 4).equals(TCP_MAGIC)) return;
              const size = buf.readUInt32LE(4);
              if (buf.length < 8 + size) return;
              const packet = buf.subarray(8, 8 + size);
              buf = buf.subarray(8 + size);
              this._handle(packet, (reply) => socket.write(wrapTcp(reply)));
            }
          });
        });
        this.server.listen(this.wantPort, this.host, () => {
          this.port = this.server.address().port;
          resolve(this.port);
        });
      } else {
        this.server = dgram.createSocket('udp4');
        this.server.on('message', (msg, rinfo) => {
          this.lastPeer = rinfo;
          this._handle(msg, (reply) => this.server.send(reply, rinfo.port, rinfo.address));
        });
        this.server.bind(this.wantPort, this.host, () => {
          this.port = this.server.address().port;
          resolve(this.port);
        });
      }
    });
  }

  _reply(send, command, data, replyId) {
    const { packet } = createPacket(command, data, SESSION_ID, replyId);
    if (this.replyDelay > 0) setTimeout(() => send(packet), this.replyDelay);
    else send(packet);
  }

  _handle(packet, send) {
    const header = parseHeader(packet);
    const data = packet.subarray(8);
    const rid = header.replyId;
    this.received.push(header.command);

    switch (header.command) {
      case CMD.CONNECT:
        this._reply(send, this.commKey ? CMD.ACK_UNAUTH : CMD.ACK_OK, null, rid);
        break;

      case CMD.AUTH: {
        // Kunci dihitung ulang di sisi mesin dan dibandingkan, seperti perangkat
        // asli. Tanpa ini, Comm Key yang salah pun akan lolos.
        const diharapkan = makeCommKey(this.commKey, SESSION_ID);
        const cocok = data.length >= 4 && data.subarray(0, 4).equals(diharapkan);
        this._reply(send, cocok ? CMD.ACK_OK : CMD.ACK_UNAUTH, null, rid);
        break;
      }

      case CMD.EXIT:
      case CMD.ENABLEDEVICE:
      case CMD.DISABLEDEVICE:
      case CMD.FREE_DATA:
      case CMD.CANCELCAPTURE:
        this._reply(send, CMD.ACK_OK, null, rid);
        break;

      case CMD.ACK_OK:
        // ACK balik dari klien saat live capture — tidak perlu dijawab.
        break;

      case CMD.VERSION:
        this._reply(send, CMD.ACK_OK, Buffer.from('Ver 6.60 Aug 25 2020\0', 'latin1'), rid);
        break;

      case CMD.OPTIONS_RRQ: {
        const name = data.toString('latin1').replace(/\0.*$/, '');
        const values = {
          '~DeviceName': 'X105',
          '~SerialNumber': 'CJZC201960385',
          '~Platform': 'ZMM220_TFT',
          MAC: '00:17:61:12:34:56',
        };
        this._reply(send, CMD.ACK_OK, Buffer.from(`${name}=${values[name] || ''}\0`, 'latin1'), rid);
        break;
      }

      case CMD.GET_TIME: {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(encodeTime(new Date()), 0);
        this._reply(send, CMD.ACK_OK, buf, rid);
        break;
      }

      case CMD.SET_TIME:
        this.timeSetTo = data.readUInt32LE(0);
        this._reply(send, CMD.ACK_OK, null, rid);
        break;

      case CMD.GET_FREE_SIZES: {
        const buf = Buffer.alloc(80);
        buf.writeInt32LE(this.users.length, 4 * 4); // jumlah user
        // Jumlah sidik jari yang sebenarnya, bukan jumlah user. Angka inilah
        // yang dipakai aplikasi untuk memastikan kiriman benar mendarat.
        buf.writeInt32LE(this.fingers.length, 6 * 4);
        buf.writeInt32LE(this.attendance.length, 8 * 4); // jumlah record
        buf.writeInt32LE(3000, 15 * 4); // kapasitas user
        buf.writeInt32LE(100000, 16 * 4); // kapasitas record
        this._reply(send, CMD.ACK_OK, buf, rid);
        break;
      }

      case CMD.DATA_WRRQ: {
        const inner = data.readUInt16LE(1);
        if (inner === CMD.DB_RRQ) {
          // Template sidik jari: pola ACK berisi ukuran, lalu ditarik per potongan.
          this.pending = fingerBlock(this.fingers);
          const ack = Buffer.alloc(5);
          ack.writeUInt8(0, 0);
          ack.writeUInt32LE(this.pending.length, 1);
          this._reply(send, CMD.ACK_OK, ack, rid);
        } else if (inner === CMD.USERTEMP_RRQ) {
          // Pola 1: umumkan ukuran, lalu kirim isinya sekaligus, tutup dengan ACK.
          const size = Buffer.alloc(4);
          size.writeUInt32LE(this.userBlock.length, 0);
          this._reply(send, CMD.PREPARE_DATA, size, rid);
          this._reply(send, CMD.DATA, this.userBlock, rid);
          this._reply(send, CMD.ACK_OK, null, rid);
        } else {
          // Pola 2: umumkan ukuran, klien menarik per potongan.
          this.pending = this.attBlock;
          const ack = Buffer.alloc(5);
          ack.writeUInt8(0, 0);
          ack.writeUInt32LE(this.attBlock.length, 1);
          this._reply(send, CMD.ACK_OK, ack, rid);
        }
        break;
      }

      case CMD.DATA_RDY: {
        const start = data.readInt32LE(0);
        const len = data.readInt32LE(4);
        const block = this.pending || Buffer.alloc(0);
        this._reply(send, CMD.DATA, block.subarray(start, start + len), rid);
        break;
      }

      case CMD.USER_WRQ: {
        const incoming = parseUserRecord(data);
        const idx = this.users.findIndex((u) => String(u.userId) === String(incoming.userId));
        if (idx >= 0) this.users[idx] = { ...this.users[idx], ...incoming };
        else this.users.push(incoming);
        this._rebuildUsers();
        this._reply(send, CMD.ACK_OK, null, rid);
        break;
      }

      case CMD.DELETE_USER: {
        const uid = data.readUInt16LE(0);
        this.users = this.users.filter((u) => u.uid !== uid);
        this.fingers = this.fingers.filter((f) => f.uid !== uid);
        this._rebuildUsers();
        this._reply(send, CMD.ACK_OK, null, rid);
        break;
      }

      case CMD.REFRESHDATA:
        this.refreshCount += 1;
        this._reply(send, CMD.ACK_OK, null, rid);
        break;

      case CMD.PREPARE_DATA:
        // Klien mengumumkan akan mengirim data sebesar sekian byte.
        this.uploadExpected = data.readUInt32LE(0);
        this.uploadBuffer = Buffer.alloc(0);
        this._reply(send, CMD.ACK_OK, null, rid);
        break;

      case CMD.DATA:
        this.uploadBuffer = Buffer.concat([this.uploadBuffer || Buffer.alloc(0), data]);
        this._reply(send, CMD.ACK_OK, null, rid);
        break;

      case CMD.SAVE_USERTEMPS: {
        this._commitUpload();
        this._reply(send, CMD.ACK_OK, null, rid);
        break;
      }

      case CMD.CLEAR_ATTLOG:
        this.attendance = [];
        this.attBlock = dataBlock([]);
        this._reply(send, CMD.ACK_OK, null, rid);
        break;

      case CMD.REG_EVENT:
        this.liveFlags = data.length >= 4 ? data.readUInt32LE(0) : 0;
        this._reply(send, CMD.ACK_OK, null, rid);
        this._liveSend = send;
        break;

      default:
        this._reply(send, CMD.ACK_OK, null, rid);
    }
  }

  /**
   * Bongkar buffer unggahan saveUserWithTemplates:
   * [len user][len tabel][len template] + record user + tabel + isi template.
   */
  _commitUpload() {
    const buf = this.uploadBuffer;
    if (!buf || buf.length < 12) return;

    const userLen = buf.readUInt32LE(0);
    const tableLen = buf.readUInt32LE(4);
    const userPack = buf.subarray(12, 12 + userLen);
    const tablePack = buf.subarray(12 + userLen, 12 + userLen + tableLen);
    const blobPack = buf.subarray(12 + userLen + tableLen);

    let incoming;
    try {
      incoming = parseUploadUserRecord(userPack);
    } catch (err) {
      // Dicatat, bukan dilempar: mesin asli pun tidak mengeluh, hanya membuang.
      this.uploadRejected = err.message;
      this.uploadBuffer = null;
      return;
    }
    const idx = this.users.findIndex((u) => String(u.userId) === String(incoming.userId));
    if (idx >= 0) this.users[idx] = { ...this.users[idx], ...incoming };
    else this.users.push(incoming);
    this._rebuildUsers();

    this.fingers = this.fingers.filter((f) => f.uid !== incoming.uid);
    for (let off = 0; off + 8 <= tablePack.length; off += 8) {
      const uid = tablePack.readUInt16LE(off + 1);
      const fid = tablePack.readInt8(off + 3);
      const start = tablePack.readUInt32LE(off + 4);
      if (start + 2 > blobPack.length) continue;
      const size = blobPack.readUInt16LE(start);
      this.fingers.push({
        uid,
        fid,
        valid: 1,
        template: Buffer.from(blobPack.subarray(start + 2, start + size)),
      });
    }

    this.uploadBuffer = null;
  }

  /** Kirim satu kejadian scan realtime ke klien yang sedang mendengarkan. */
  pushScan({ userId, timestamp, status = 1, punch = 0 }) {
    if (!this._liveSend) throw new Error('Klien belum mendaftar event realtime');
    const payload = Buffer.alloc(52);
    payload.write(userId, 0, 24, 'latin1');
    payload.writeUInt8(status, 24);
    payload.writeUInt8(punch, 25);
    Buffer.from([
      timestamp.getFullYear() - 2000,
      timestamp.getMonth() + 1,
      timestamp.getDate(),
      timestamp.getHours(),
      timestamp.getMinutes(),
      timestamp.getSeconds(),
    ]).copy(payload, 26);
    this._reply(this._liveSend, CMD.REG_EVENT, payload, 0);
  }

  close() {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      return undefined;
    });
  }
}

module.exports = { MockDevice, attendanceRecord, userRecord, parseUserRecord, parseUploadUserRecord, dataBlock, fingerBlock, SESSION_ID };
