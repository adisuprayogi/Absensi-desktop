'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');

const { CMD, EF, FCT, USHRT_MAX, TCP_MAGIC } = require('./const');
const {
  createPacket,
  wrapTcp,
  parseHeader,
  makeCommKey,
  decodeTime,
  encodeTime,
  decodeTimeHex,
  cString,
} = require('./packet');

const DEFAULT_TIMEOUT = 10000;
const BULK_TIMEOUT = 60000;
const MAX_CHUNK_TCP = 0xffc0;
const MAX_CHUNK_UDP = 16 * 1024;

class ZKError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZKError';
    this.code = code;
  }
}

/**
 * Klien protokol ZKTeco untuk mesin absensi Solution X105 / X401 lewat LAN.
 *
 * Pemakaian:
 *   const zk = new ZKClient({ ip: '192.168.1.201', port: 4370, commKey: 0 });
 *   await zk.connect();
 *   const logs = await zk.getAttendance();
 *   await zk.disconnect();
 *
 * Event: 'attendance' (live capture), 'close', 'error'.
 */
class ZKClient extends EventEmitter {
  constructor({ ip, port = 4370, commKey = 0, protocol = 'tcp', timeout = DEFAULT_TIMEOUT } = {}) {
    super();
    if (!ip) throw new ZKError('Alamat IP mesin belum diisi');
    this.ip = ip;
    this.port = Number(port) || 4370;
    this.commKey = Number(commKey) || 0;
    this.tcp = String(protocol).toLowerCase() !== 'udp';
    this.timeout = timeout;

    this.socket = null;
    this.connected = false;
    this.sessionId = 0;
    this.replyId = USHRT_MAX - 1;
    this.deviceEnabled = true;
    this.liveMode = false;

    // Info dari getSizes()
    this.userCount = 0;
    this.recordCount = 0;
    this.fingerCount = 0;
    this.recordCapacity = 0;
    this.userCapacity = 0;
    // Tata letak record user; dikoreksi otomatis setelah getUsers() pertama.
    this.userPacketSize = 72;

    this._rxBuffer = Buffer.alloc(0);
    this._frames = [];
    this._waiters = [];
    this._closedReason = null;
  }

  // ---------------------------------------------------------------- socket

  _openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new ZKError(String(err)));
      };

      if (this.tcp) {
        const sock = new net.Socket();
        sock.setNoDelay(true);
        const connectTimer = setTimeout(() => {
          sock.destroy();
          fail(new ZKError(`Timeout menghubungi ${this.ip}:${this.port}. Pastikan mesin menyala dan satu jaringan LAN.`, 'ETIMEDOUT'));
        }, this.timeout);

        sock.on('connect', () => {
          clearTimeout(connectTimer);
          if (settled) return;
          settled = true;
          resolve();
        });
        sock.on('data', (chunk) => this._onTcpData(chunk));
        sock.on('error', (err) => {
          clearTimeout(connectTimer);
          this._failAll(err);
          fail(this._friendlyError(err));
        });
        sock.on('close', () => {
          clearTimeout(connectTimer);
          this.connected = false;
          this._failAll(new ZKError('Koneksi ke mesin terputus', 'ECLOSED'));
          this.emit('close', this._closedReason);
        });
        sock.connect(this.port, this.ip);
        this.socket = sock;
      } else {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg) => this._onFrame(msg));
        sock.on('error', (err) => {
          this._failAll(err);
          fail(this._friendlyError(err));
        });
        sock.on('close', () => {
          this.connected = false;
          this._failAll(new ZKError('Koneksi ke mesin terputus', 'ECLOSED'));
          this.emit('close', this._closedReason);
        });
        sock.bind(() => {
          if (settled) return;
          settled = true;
          resolve();
        });
        this.socket = sock;
      }
    });
  }

  _friendlyError(err) {
    const code = err && err.code;
    if (code === 'ECONNREFUSED') {
      return new ZKError(`Mesin di ${this.ip}:${this.port} menolak koneksi. Cek nomor port (biasanya 4370).`, code);
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return new ZKError(`${this.ip} tidak terjangkau. Cek kabel LAN / subnet komputer dan mesin.`, code);
    }
    if (code === 'ETIMEDOUT') {
      return new ZKError(`Timeout menghubungi ${this.ip}:${this.port}. Pastikan mesin menyala dan IP benar.`, code);
    }
    return err instanceof Error ? err : new ZKError(String(err));
  }

  _onTcpData(chunk) {
    this._rxBuffer = Buffer.concat([this._rxBuffer, chunk]);
    for (;;) {
      if (this._rxBuffer.length < 8) return;
      if (!this._rxBuffer.subarray(0, 4).equals(TCP_MAGIC)) {
        // Sinkron ulang: cari penanda frame berikutnya.
        const idx = this._rxBuffer.indexOf(TCP_MAGIC, 1);
        if (idx === -1) {
          this._rxBuffer = Buffer.alloc(0);
          return;
        }
        this._rxBuffer = this._rxBuffer.subarray(idx);
        continue;
      }
      const size = this._rxBuffer.readUInt32LE(4);
      if (this._rxBuffer.length < 8 + size) return;
      const packet = this._rxBuffer.subarray(8, 8 + size);
      this._rxBuffer = this._rxBuffer.subarray(8 + size);
      if (packet.length >= 8) this._onFrame(packet);
    }
  }

  _onFrame(packet) {
    const header = parseHeader(packet);
    const frame = { ...header, data: packet.subarray(8) };

    // Paket realtime datang tanpa diminta; jangan dianggap balasan perintah.
    if (frame.command === CMD.REG_EVENT) {
      this._handleLiveFrame(frame);
      return;
    }

    const waiter = this._waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else if (this._frames.length < 64) {
      this._frames.push(frame);
    }
  }

  _failAll(err) {
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(this._friendlyError(err));
    }
  }

  _nextFrame(timeout = this.timeout) {
    const queued = this._frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx !== -1) this._waiters.splice(idx, 1);
        reject(new ZKError('Mesin tidak membalas (timeout). Coba ulangi atau restart mesin.', 'ETIMEDOUT'));
      }, timeout);
      this._waiters.push(waiter);
    });
  }

  _write(buf) {
    if (!this.socket) throw new ZKError('Socket belum terbuka');
    if (this.tcp) this.socket.write(buf);
    else this.socket.send(buf, 0, buf.length, this.port, this.ip);
  }

  /** Kirim perintah dan tunggu satu frame balasan. */
  async _send(command, data = null, timeout = this.timeout) {
    const { packet, nextReplyId } = createPacket(command, data, this.sessionId, this.replyId);
    this.replyId = nextReplyId;
    this._write(this.tcp ? wrapTcp(packet) : packet);
    return this._nextFrame(timeout);
  }

  /** Kirim perintah tanpa menunggu balasan (mis. ACK balik saat live capture). */
  _sendNoWait(command, data = null) {
    const { packet, nextReplyId } = createPacket(command, data, this.sessionId, this.replyId);
    this.replyId = nextReplyId;
    try {
      this._write(this.tcp ? wrapTcp(packet) : packet);
    } catch {
      /* socket sudah tertutup — abaikan */
    }
  }

  static isOk(frame) {
    return frame.command === CMD.ACK_OK || frame.command === CMD.ACK_DATA;
  }

  async _cmd(command, data = null, timeout = this.timeout, label = '') {
    const frame = await this._send(command, data, timeout);
    if (!ZKClient.isOk(frame)) {
      throw new ZKError(
        `Mesin menolak perintah${label ? ` ${label}` : ''} (kode ${frame.command}).`,
        frame.command
      );
    }
    return frame;
  }

  // --------------------------------------------------------------- session

  async connect() {
    await this._openSocket();
    this.sessionId = 0;
    this.replyId = USHRT_MAX - 1;

    let frame = await this._send(CMD.CONNECT);
    this.sessionId = frame.sessionId;

    if (frame.command === CMD.ACK_UNAUTH) {
      // Mesin memakai COMM key — kirim kunci acak berbasis session id.
      frame = await this._send(CMD.AUTH, makeCommKey(this.commKey, this.sessionId));
      if (!ZKClient.isOk(frame)) {
        // Dibedakan: Comm Key belum diisi sama sekali, versus diisi tapi salah.
        // Keduanya butuh tindakan berbeda dari pengguna.
        throw new ZKError(
          this.commKey
            ? `Comm Key ${this.commKey} ditolak mesin. Cocokkan dengan menu Komunikasi > Kunci Komunikasi di mesin.`
            : 'Mesin ini memakai Comm Key, tetapi di aplikasi masih diisi 0. Lihat nilainya di mesin: Menu > Komunikasi > Kunci Komunikasi, lalu isikan angka itu.',
          'EAUTH'
        );
      }
    } else if (!ZKClient.isOk(frame)) {
      throw new ZKError(`Mesin menolak koneksi (kode ${frame.command}).`, frame.command);
    }

    this.connected = true;
    return this;
  }

  async disconnect() {
    this.liveMode = false;
    try {
      if (this.connected && this.socket) {
        if (!this.deviceEnabled) await this.enableDevice().catch(() => {});
        await this._send(CMD.EXIT, null, 3000).catch(() => {});
      }
    } finally {
      this.connected = false;
      this._closedReason = 'disconnect';
      if (this.socket) {
        if (this.tcp) this.socket.destroy();
        else this.socket.close();
        this.socket = null;
      }
    }
  }

  /**
   * Kunci keypad mesin selama transfer data massal supaya buffer tidak berubah
   * di tengah pembacaan. Wajib dipasangkan dengan enableDevice().
   */
  async disableDevice() {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(0, 0);
    await this._cmd(CMD.DISABLEDEVICE, payload, this.timeout, 'nonaktifkan mesin');
    this.deviceEnabled = false;
  }

  async enableDevice() {
    await this._cmd(CMD.ENABLEDEVICE, null, this.timeout, 'aktifkan mesin');
    this.deviceEnabled = true;
  }

  // ------------------------------------------------------------ info dasar

  async getFirmwareVersion() {
    const frame = await this._cmd(CMD.VERSION, null, this.timeout, 'versi firmware');
    return cString(frame.data);
  }

  async _readOption(name) {
    const frame = await this._send(CMD.OPTIONS_RRQ, Buffer.from(`${name}\0`, 'latin1'));
    if (!ZKClient.isOk(frame)) return '';
    const text = cString(frame.data);
    const eq = text.indexOf('=');
    return eq === -1 ? text : text.slice(eq + 1);
  }

  getDeviceName() {
    return this._readOption('~DeviceName');
  }

  getSerialNumber() {
    return this._readOption('~SerialNumber');
  }

  getPlatform() {
    return this._readOption('~Platform');
  }

  getMac() {
    return this._readOption('MAC');
  }

  async getTime() {
    const frame = await this._cmd(CMD.GET_TIME, null, this.timeout, 'baca jam mesin');
    if (frame.data.length < 4) throw new ZKError('Balasan jam mesin tidak valid');
    return decodeTime(frame.data.readUInt32LE(0));
  }

  async setTime(date = new Date()) {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(encodeTime(date), 0);
    await this._cmd(CMD.SET_TIME, payload, this.timeout, 'set jam mesin');
    return true;
  }

  /** Jumlah user / sidik jari / record dan kapasitasnya. */
  async getSizes() {
    const frame = await this._cmd(CMD.GET_FREE_SIZES, null, this.timeout, 'baca kapasitas');
    const d = frame.data;
    if (d.length >= 80) {
      const f = [];
      for (let i = 0; i < 20; i++) f.push(d.readInt32LE(i * 4));
      this.userCount = f[4];
      this.fingerCount = f[6];
      this.recordCount = f[8];
      this.cardCount = f[12];
      this.fingerCapacity = f[14];
      this.userCapacity = f[15];
      this.recordCapacity = f[16];
    }
    return {
      users: this.userCount,
      fingers: this.fingerCount,
      records: this.recordCount,
      userCapacity: this.userCapacity,
      recordCapacity: this.recordCapacity,
      fingerCapacity: this.fingerCapacity,
    };
  }

  // ------------------------------------------------------- transfer massal

  get maxChunk() {
    return this.tcp ? MAX_CHUNK_TCP : MAX_CHUNK_UDP;
  }

  /**
   * Baca blok data besar (daftar user / log absensi).
   * Mesin membalas dengan salah satu dari tiga pola, ketiganya ditangani:
   *   1. CMD_DATA langsung berisi seluruh isi
   *   2. CMD_ACK_OK + ukuran, lalu kita tarik per potongan via CMD_DATA_RDY
   *   3. CMD_PREPARE_DATA + rentetan CMD_DATA
   */
  async readWithBuffer(command, fct = 0, ext = 0) {
    const req = Buffer.alloc(11);
    req.writeUInt8(1, 0);
    req.writeUInt16LE(command, 1);
    req.writeInt32LE(fct, 3);
    req.writeInt32LE(ext, 7);

    const frame = await this._send(CMD.DATA_WRRQ, req, BULK_TIMEOUT);

    if (frame.command === CMD.DATA) return frame.data;
    if (frame.command === CMD.PREPARE_DATA) return this._collectPrepared(frame);

    if (!ZKClient.isOk(frame)) {
      throw new ZKError(`Mesin tidak mendukung pembacaan data ini (kode ${frame.command}).`, frame.command);
    }
    if (frame.data.length < 5) return Buffer.alloc(0);

    const total = frame.data.readUInt32LE(1);
    if (total <= 0) {
      await this._freeData();
      return Buffer.alloc(0);
    }

    const parts = [];
    let start = 0;
    while (start < total) {
      const len = Math.min(this.maxChunk, total - start);
      parts.push(await this._readChunk(start, len));
      start += len;
    }
    await this._freeData();
    return Buffer.concat(parts);
  }

  async _readChunk(start, size) {
    const req = Buffer.alloc(8);
    req.writeInt32LE(start, 0);
    req.writeInt32LE(size, 4);

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const frame = await this._send(CMD.DATA_RDY, req, BULK_TIMEOUT);
        if (frame.command === CMD.DATA) return frame.data;
        if (frame.command === CMD.PREPARE_DATA) return this._collectPrepared(frame);
        lastErr = new ZKError(`Potongan data ditolak (kode ${frame.command})`, frame.command);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new ZKError(`Gagal membaca data pada offset ${start}`);
  }

  /** Setelah CMD_PREPARE_DATA: kumpulkan frame CMD_DATA sampai ukuran terpenuhi. */
  async _collectPrepared(prepareFrame) {
    const total = prepareFrame.data.length >= 4 ? prepareFrame.data.readUInt32LE(0) : 0;
    const parts = [];
    let received = 0;
    while (received < total) {
      const frame = await this._nextFrame(BULK_TIMEOUT);
      if (frame.command === CMD.DATA) {
        parts.push(frame.data);
        received += frame.data.length;
      } else if (ZKClient.isOk(frame)) {
        break;
      } else {
        throw new ZKError(`Transfer data gagal (kode ${frame.command})`, frame.command);
      }
    }
    // Mesin menutup transfer dengan ACK; abaikan jika tidak ada.
    if (received >= total && total > 0) {
      await this._nextFrame(2000).catch(() => null);
    }
    return Buffer.concat(parts);
  }

  async _freeData() {
    await this._send(CMD.FREE_DATA, null, 5000).catch(() => null);
  }

  // ---------------------------------------------------------------- users

  /** Daftar user yang terdaftar di mesin (PIN, nama, hak akses). */
  async getUsers() {
    await this.getSizes();
    if (this.userCount === 0) return [];

    const raw = await this.readWithBuffer(CMD.USERTEMP_RRQ, FCT.USER);
    if (raw.length <= 4) return [];

    const total = raw.readUInt32LE(0);
    const body = raw.subarray(4);
    let recSize = this.userCount > 0 ? Math.floor(total / this.userCount) : 0;
    if (recSize !== 28 && recSize !== 72) {
      recSize = body.length % 72 === 0 ? 72 : 28;
    }
    // Diingat supaya penulisan user memakai tata letak record yang sama.
    this.userPacketSize = recSize;

    const users = [];
    for (let off = 0; off + recSize <= body.length; off += recSize) {
      const r = body.subarray(off, off + recSize);
      if (recSize === 72) {
        users.push({
          uid: r.readUInt16LE(0),
          privilege: r.readUInt8(2),
          password: cString(r.subarray(3, 11)),
          name: cString(r.subarray(11, 35)),
          card: r.readUInt32LE(35),
          groupId: cString(r.subarray(40, 47)),
          userId: cString(r.subarray(48, 72)),
        });
      } else {
        users.push({
          uid: r.readUInt16LE(0),
          privilege: r.readUInt8(2),
          password: cString(r.subarray(3, 8)),
          name: cString(r.subarray(8, 16)),
          card: r.readUInt32LE(16),
          groupId: String(r.readUInt8(21)),
          userId: String(r.readUInt32LE(24)),
        });
      }
    }
    // Sebagian firmware mengosongkan nama; pakai PIN sebagai cadangan.
    for (const u of users) {
      if (!u.userId) u.userId = String(u.uid);
      if (!u.name) u.name = `User ${u.userId}`;
    }
    return users;
  }

  // ------------------------------------------------- menulis ke mesin

  /**
   * Susun record user 72 byte (firmware baru) atau 28 byte (firmware lama).
   * Tata letaknya sama persis dengan yang dibaca getUsers().
   */
  _packUser({ uid, userId, name, privilege = 0, password = '', card = 0, groupId = '' }) {
    const size = this.userPacketSize === 28 ? 28 : 72;
    const r = Buffer.alloc(size);
    const write = (text, offset, len) => {
      const buf = Buffer.from(String(text == null ? '' : text), 'utf8').subarray(0, len);
      buf.copy(r, offset);
    };

    if (size === 72) {
      r.writeUInt16LE(uid & 0xffff, 0);
      r.writeUInt8(privilege & 0xff, 2);
      write(password, 3, 8);
      write(name, 11, 24);
      // Nomor kartu tidak bertanda: kartu 10 digit sering melewati 2^31.
      r.writeUInt32LE(Number(card) || 0, 35);
      write(groupId, 40, 7);
      write(userId, 48, 24);
    } else {
      r.writeUInt16LE(uid & 0xffff, 0);
      r.writeUInt8(privilege & 0xff, 2);
      write(password, 3, 5);
      write(name, 8, 8);
      r.writeUInt32LE(Number(card) || 0, 16);
      r.writeUInt8(Number(groupId) || 0, 21);
      r.writeInt16LE(0, 22); // zona waktu
      r.writeUInt32LE(Number(userId) || 0, 24);
    }
    return r;
  }

  /**
   * Record user untuk jalur UNGGAH BUFFER (saveUserWithTemplates).
   *
   * Tata letaknya BERBEDA dari perintah tulis user biasa: ada byte penanda 2
   * di depan dan satu byte tetap 1 setelah nomor kartu, sehingga panjangnya
   * 73 byte (bukan 72) untuk firmware baru, dan 29 byte (bukan 28) untuk yang
   * lama. Memakai tata letak yang salah membuat mesin menerima kiriman tanpa
   * keluhan, tetapi seluruh isinya bergeser satu byte dan sidik jarinya tidak
   * pernah tersimpan.
   */
  _packUserForUpload({ uid, userId, name, privilege = 0, password = '', card = 0, groupId = '' }) {
    const kecil = this.userPacketSize === 28;
    const r = Buffer.alloc(kecil ? 29 : 73);
    const write = (text, offset, len) => {
      Buffer.from(String(text == null ? '' : text), 'utf8').subarray(0, len).copy(r, offset);
    };

    r.writeUInt8(2, 0); // penanda: record user di dalam buffer
    r.writeUInt16LE(uid & 0xffff, 1);
    r.writeUInt8(privilege & 0xff, 3);

    if (kecil) {
      write(password, 4, 5);
      write(name, 9, 8);
      r.writeUInt32LE(Number(card) || 0, 17);
      r.writeUInt8(Number(groupId) || 0, 22);
      r.writeInt16LE(0, 23); // zona waktu
      r.writeUInt32LE(Number(userId) || 0, 25);
    } else {
      write(password, 4, 8);
      write(name, 12, 24);
      r.writeUInt32LE(Number(card) || 0, 36);
      r.writeUInt8(1, 40);
      write(groupId, 41, 7);
      write(userId, 49, 24);
    }
    return r;
  }

  /**
   * Tulis (buat atau timpa) satu user di mesin.
   * `uid` adalah nomor urut internal mesin; `userId` adalah PIN yang diketik
   * karyawan. Bila uid tidak diisi, dicarikan nomor kosong berikutnya.
   */
  async setUser({ uid = null, userId, name, privilege = 0, password = '', card = 0, groupId = '', refresh = true }) {
    if (!userId) throw new ZKError('PIN (User ID) wajib diisi');
    let targetUid = uid;
    if (!targetUid) {
      const users = await this.getUsers();
      const existing = users.find((u) => String(u.userId) === String(userId));
      if (existing) {
        targetUid = existing.uid;
      } else {
        const used = new Set(users.map((u) => u.uid));
        targetUid = 1;
        while (used.has(targetUid)) targetUid += 1;
      }
    }

    const payload = this._packUser({ uid: targetUid, userId, name, privilege, password, card, groupId });
    await this._cmd(CMD.USER_WRQ, payload, this.timeout, 'tulis data user');
    // Saat menulis banyak user sekaligus, refresh cukup sekali di akhir.
    if (refresh) await this.refreshData();
    return { uid: targetUid, userId };
  }

  /** Hapus satu user dari mesin berdasarkan uid internalnya. */
  async deleteUser(uid, { refresh = true } = {}) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16LE(Number(uid) & 0xffff, 0);
    await this._cmd(CMD.DELETE_USER, payload, this.timeout, 'hapus user');
    // Menyimpan ulang basis data mesin memakan waktu; saat menghapus banyak
    // user, cukup sekali di akhir. Ratusan penghapusan jadi jauh lebih cepat.
    if (refresh) await this.refreshData();
    return true;
  }

  /** Hapus user berdasarkan PIN. */
  async deleteUserByPin(userId) {
    const users = await this.getUsers();
    const target = users.find((u) => String(u.userId) === String(userId));
    if (!target) return false;
    await this.deleteUser(target.uid);
    return true;
  }

  /** Minta mesin memuat ulang basis datanya setelah penulisan. */
  async refreshData() {
    await this._send(CMD.REFRESHDATA, null, this.timeout).catch(() => null);
    return true;
  }

  /**
   * Baca seluruh template sidik jari di mesin.
   * Template adalah data biner milik algoritma ZK — tidak bisa dibuat dari
   * komputer, hanya bisa disalin apa adanya antar mesin sejenis.
   */
  async getFingerprints() {
    const raw = await this.readWithBuffer(CMD.DB_RRQ, FCT.FINGERTMP);
    if (raw.length <= 4) return [];

    let remaining = raw.readUInt32LE(0);
    let body = raw.subarray(4);
    const out = [];

    while (remaining > 0 && body.length >= 6) {
      const size = body.readUInt16LE(0);
      if (size < 6 || size > body.length) break;
      out.push({
        uid: body.readUInt16LE(2),
        fid: body.readInt8(4),
        valid: body.readInt8(5),
        template: Buffer.from(body.subarray(6, size)),
      });
      body = body.subarray(size);
      remaining -= size;
    }
    return out;
  }

  /** Kirim data besar ke mesin secara bertahap (kebalikan readWithBuffer). */
  async _sendWithBuffer(buffer) {
    const MAX_CHUNK = 1024;
    await this._send(CMD.FREE_DATA, null, 5000).catch(() => null);

    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(buffer.length, 0);
    await this._cmd(CMD.PREPARE_DATA, sizeBuf, BULK_TIMEOUT, 'siapkan pengiriman data');

    for (let start = 0; start < buffer.length; start += MAX_CHUNK) {
      const chunk = buffer.subarray(start, Math.min(start + MAX_CHUNK, buffer.length));
      await this._cmd(CMD.DATA, chunk, BULK_TIMEOUT, 'kirim potongan data');
    }
    return true;
  }

  /**
   * Tulis satu user beserta template sidik jarinya sekaligus.
   * Dipakai untuk menyalin karyawan dari satu mesin ke mesin lain.
   *
   * @param {object} user  { uid, userId, name, privilege, password, card, groupId }
   * @param {Array}  fingers  [{ fid, valid, template }]
   */
  async saveUserWithTemplates(user, fingers = []) {
    if (!fingers.length) {
      return this.setUser(user);
    }

    const uid = user.uid;
    if (!uid) throw new ZKError('uid mesin wajib diisi saat menyalin sidik jari');

    const tables = [];
    const blobs = [];
    let offset = 0;
    for (const finger of fingers) {
      const body = Buffer.alloc(2 + finger.template.length);
      body.writeUInt16LE(finger.template.length + 2, 0);
      finger.template.copy(body, 2);

      const entry = Buffer.alloc(8);
      entry.writeInt8(2, 0);
      entry.writeUInt16LE(uid & 0xffff, 1);
      entry.writeInt8(finger.fid, 3);
      entry.writeUInt32LE(offset, 4);

      tables.push(entry);
      blobs.push(body);
      offset += body.length;
    }

    const userPack = this._packUserForUpload(user);
    const tablePack = Buffer.concat(tables);
    const blobPack = Buffer.concat(blobs);

    const head = Buffer.alloc(12);
    head.writeUInt32LE(userPack.length, 0);
    head.writeUInt32LE(tablePack.length, 4);
    head.writeUInt32LE(blobPack.length, 8);

    await this._sendWithBuffer(Buffer.concat([head, userPack, tablePack, blobPack]));

    const commit = Buffer.alloc(8);
    commit.writeUInt32LE(12, 0);
    commit.writeUInt16LE(0, 4);
    commit.writeUInt16LE(8, 6);
    await this._cmd(CMD.SAVE_USERTEMPS, commit, BULK_TIMEOUT, 'simpan user dan sidik jari');
    await this.refreshData();
    return true;
  }

  // ----------------------------------------------------------- absensi

  /**
   * Tarik seluruh log absensi yang tersimpan di mesin.
   * @param {Date} [since] jika diisi, log lebih lama dari ini dibuang.
   */
  async getAttendance(since = null) {
    await this.getSizes();
    if (this.recordCount === 0) return [];

    const raw = await this.readWithBuffer(CMD.ATTLOG_RRQ);
    if (raw.length <= 4) return [];

    const total = raw.readUInt32LE(0);
    const body = raw.subarray(4);
    let recSize = this.recordCount > 0 ? Math.floor(total / this.recordCount) : 0;
    if (![8, 16, 40].includes(recSize)) {
      if (body.length % 40 === 0) recSize = 40;
      else if (body.length % 16 === 0) recSize = 16;
      else recSize = 8;
    }

    // Format 8 byte hanya menyimpan uid internal, perlu peta ke PIN.
    let uidMap = null;
    if (recSize === 8) {
      const users = await this.getUsers();
      uidMap = new Map(users.map((u) => [u.uid, u.userId]));
    }

    const out = [];
    for (let off = 0; off + recSize <= body.length; off += recSize) {
      const r = body.subarray(off, off + recSize);
      let rec;
      if (recSize === 40) {
        rec = {
          uid: r.readUInt16LE(0),
          userId: cString(r.subarray(2, 26)),
          status: r.readUInt8(26),
          timestamp: decodeTime(r.readUInt32LE(27)),
          punch: r.readUInt8(31),
        };
      } else if (recSize === 16) {
        rec = {
          uid: 0,
          userId: String(r.readUInt32LE(0)),
          timestamp: decodeTime(r.readUInt32LE(4)),
          status: r.readUInt8(8),
          punch: r.readUInt8(9),
        };
      } else {
        const uid = r.readUInt16LE(0);
        rec = {
          uid,
          userId: (uidMap && uidMap.get(uid)) || String(uid),
          status: r.readUInt8(2),
          timestamp: decodeTime(r.readUInt32LE(3)),
          punch: r.readUInt8(7),
        };
      }
      if (!rec.userId) continue;
      if (Number.isNaN(rec.timestamp.getTime())) continue;
      if (since && rec.timestamp < since) continue;
      out.push(rec);
    }
    return out;
  }

  /** Hapus SEMUA log absensi di mesin. Tidak bisa dibatalkan. */
  async clearAttendance() {
    await this._cmd(CMD.CLEAR_ATTLOG, null, 30000, 'hapus log absensi');
    return true;
  }

  async restart() {
    this._sendNoWait(CMD.RESTART);
    this.connected = false;
    return true;
  }

  async testVoice() {
    const payload = Buffer.alloc(2);
    payload.writeUInt16LE(0, 0);
    await this._cmd(CMD.TESTVOICE, payload, this.timeout, 'tes suara');
    return true;
  }

  // ------------------------------------------------------- live capture

  /**
   * Mulai mendengarkan scan realtime. Setiap scan dipancarkan sebagai
   * event 'attendance' berisi { userId, timestamp, status, punch }.
   */
  async startLive() {
    if (this.liveMode) return;
    await this._send(CMD.CANCELCAPTURE, null, 3000).catch(() => null);
    if (!this.deviceEnabled) await this.enableDevice().catch(() => {});

    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(EF.ATTLOG, 0);
    await this._cmd(CMD.REG_EVENT, payload, this.timeout, 'daftar event realtime');
    this.liveMode = true;
  }

  async stopLive() {
    if (!this.liveMode) return;
    this.liveMode = false;
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(0, 0);
    await this._send(CMD.REG_EVENT, payload, 3000).catch(() => null);
  }

  /**
   * ACK untuk event realtime. Reply id-nya tetap USHRT_MAX - 1, persis pyzk,
   * dan TIDAK memakai/menaikkan penghitung perintah biasa. Dengan reply id
   * lain, mesin menganggap event belum diterima lalu mengirimnya berulang-ulang
   * — di aplikasi, satu scan tampil terus-menerus di feed Dashboard.
   */
  _ackLiveEvent() {
    const { packet } = createPacket(CMD.ACK_OK, null, this.sessionId, USHRT_MAX - 1);
    try {
      this._write(this.tcp ? wrapTcp(packet) : packet);
    } catch {
      /* socket sudah tertutup — abaikan */
    }
  }

  _handleLiveFrame(frame) {
    // Mesin menunggu ACK sebelum mengirim event berikutnya.
    this._ackLiveEvent();
    if (!frame.data || frame.data.length < 8) return;

    for (const rec of ZKClient.parseLiveRecords(frame.data)) {
      this.emit('attendance', rec);
    }
  }

  /**
   * Panjang paket realtime berbeda-beda antar firmware; petakan sesuai layout
   * yang dikenal. userId numerik dipakai firmware lama, string 24 byte oleh
   * firmware baru (termasuk X105/X401).
   */
  static parseLiveRecords(data) {
    const out = [];
    let buf = data;

    while (buf.length >= 10) {
      let userId;
      let status;
      let punch;
      let timeHex;
      let consumed;

      switch (buf.length) {
        case 10:
          userId = String(buf.readUInt16LE(0));
          status = buf.readUInt8(2);
          punch = buf.readUInt8(3);
          timeHex = buf.subarray(4, 10);
          consumed = 10;
          break;
        case 12:
          userId = String(buf.readUInt32LE(0));
          status = buf.readUInt8(4);
          punch = buf.readUInt8(5);
          timeHex = buf.subarray(6, 12);
          consumed = 12;
          break;
        case 14:
          userId = String(buf.readUInt16LE(0));
          status = buf.readUInt8(2);
          punch = buf.readUInt8(3);
          timeHex = buf.subarray(4, 10);
          consumed = 14;
          break;
        case 32:
        case 36:
        case 37:
          userId = cString(buf.subarray(0, 24));
          status = buf.readUInt8(24);
          punch = buf.readUInt8(25);
          timeHex = buf.subarray(26, 32);
          consumed = buf.length;
          break;
        default:
          if (buf.length < 52) return out;
          userId = cString(buf.subarray(0, 24));
          status = buf.readUInt8(24);
          punch = buf.readUInt8(25);
          timeHex = buf.subarray(26, 32);
          consumed = 52;
          break;
      }

      const timestamp = decodeTimeHex(timeHex);
      if (userId && !Number.isNaN(timestamp.getTime())) {
        out.push({ userId, timestamp, status, punch });
      }
      buf = buf.subarray(consumed);
    }
    return out;
  }
}

module.exports = { ZKClient, ZKError };
