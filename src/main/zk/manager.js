'use strict';

const { EventEmitter } = require('node:events');

const { ZKClient } = require('./client');
const { devices } = require('../services/devices');
const { insertLogs } = require('../services/attendance');
const { settings, employees } = require('../services/masters');
const { fingerprints } = require('../services/fingerprints');
const { toDateTimeStr } = require('../util/datetime');

/**
 * Mengelola seluruh koneksi ke mesin absensi:
 *  - tarik data manual
 *  - auto-sync terjadwal
 *  - live capture (koneksi menetap, scan masuk realtime)
 *
 * Semua operasi ke satu mesin diserialkan lewat antrean per-device supaya
 * live capture dan penarikan data tidak saling merebut socket.
 */
class DeviceManager extends EventEmitter {
  constructor() {
    super();
    this.live = new Map(); // deviceId -> { client, reconnectTimer, stopped }
    this.queues = new Map(); // deviceId -> Promise
    this.autoSyncTimer = null;
    this.syncing = new Set();
  }

  // ---------------------------------------------------------- antrean

  _enqueue(deviceId, fn) {
    const prev = this.queues.get(deviceId) || Promise.resolve();
    const next = prev.then(fn, fn);
    // Rantai tetap hidup meski satu tugas gagal.
    this.queues.set(
      deviceId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  /**
   * Jalankan `fn` dengan klien terhubung. Bila mesin sedang live capture,
   * koneksi live dipakai ulang (live dijeda sebentar), bukan buka socket baru.
   */
  async _withClient(device, fn) {
    const liveEntry = this.live.get(device.id);
    if (liveEntry && liveEntry.client && liveEntry.client.connected) {
      const client = liveEntry.client;
      const wasLive = client.liveMode;
      try {
        if (wasLive) await client.stopLive();
        return await fn(client);
      } finally {
        if (wasLive && client.connected) {
          await client.startLive().catch(() => {});
        }
      }
    }

    const client = new ZKClient({
      ip: device.ip,
      port: device.port,
      commKey: device.comm_key,
      protocol: device.protocol,
    });
    try {
      await client.connect();
      return await fn(client);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  /**
   * Kabarkan kemajuan pekerjaan panjang ke halaman aplikasi.
   *
   * `total` boleh null bila jumlahnya belum diketahui (mis. saat menunggu
   * mesin mengirim daftarnya) — halaman menampilkan bilah bergerak, bukan
   * persentase palsu.
   */
  _progress(deviceId, judul, fase, { current = null, total = null, label = '', done = false } = {}) {
    this.emit('progress', { deviceId, judul, fase, current, total, label, done });
  }

  _device(deviceId) {
    const device = devices.find(deviceId);
    if (!device) throw new Error('Mesin absensi tidak ditemukan');
    return device;
  }

  // ------------------------------------------------------------ operasi

  /** Uji koneksi dan ambil identitas mesin. */
  testConnection(deviceId) {
    const device = this._device(deviceId);
    return this._enqueue(deviceId, async () => {
      try {
        const info = await this._withClient(device, async (client) => {
          const [firmware, name, serial, platform, sizes, time] = [
            await client.getFirmwareVersion().catch(() => ''),
            await client.getDeviceName().catch(() => ''),
            await client.getSerialNumber().catch(() => ''),
            await client.getPlatform().catch(() => ''),
            await client.getSizes().catch(() => ({})),
            await client.getTime().catch(() => null),
          ];
          return {
            firmware,
            name,
            serial,
            platform,
            ...sizes,
            device_time: time ? toDateTimeStr(time) : null,
          };
        });
        devices.setStatus(deviceId, 'Terhubung', {
          info: { model: info.name || info.platform || null, serial: info.serial || null, firmware: info.firmware || null },
        });
        this.emit('device-status', { deviceId, ok: true, message: 'Terhubung', info });
        return { ok: true, info };
      } catch (err) {
        devices.setStatus(deviceId, `Gagal: ${err.message}`);
        this.emit('device-status', { deviceId, ok: false, message: err.message });
        return { ok: false, error: err.message };
      }
    });
  }

  /**
   * Baca daftar user + jumlah sidik jari lewat koneksi yang SUDAH terbuka,
   * lalu simpan ke device_users.
   *
   * Sengaja menerima `client`, bukan memanggil syncUsers(): memanggil metode
   * ber-antrean dari dalam antrean mesin yang sama akan saling menunggu.
   */
  async _refreshUserList(client, deviceId, judul = null, { simpanTemplate = false } = {}) {
    if (judul) this._progress(deviceId, judul, 'Membaca daftar user dari mesin...');
    const users = await client.getUsers();
    const counts = new Map();
    let tersimpan = null;

    // Sidik jari bersifat tambahan: sebagian firmware lama menolak permintaan
    // ini sama sekali, dan itu tidak boleh menggagalkan pembacaan daftar user.
    try {
      if (judul) this._progress(deviceId, judul, `Membaca sidik jari (${users.length} user)...`);
      const templates = await client.getFingerprints();
      for (const f of templates) {
        if (f.valid) counts.set(f.uid, (counts.get(f.uid) || 0) + 1);
      }

      if (simpanTemplate && templates.length) {
        // Disimpan berdasarkan PIN supaya bisa dipasang ke mesin mana pun nanti,
        // dan supaya ikut terbawa ke dalam backup database.
        const pinByUid = new Map(users.map((u) => [u.uid, String(u.userId)]));
        const rows = [];
        let tanpaPin = 0;
        for (const t of templates) {
          const pin = pinByUid.get(t.uid);
          if (!pin) {
            tanpaPin += 1;
            continue;
          }
          rows.push({ user_pin: pin, finger_id: t.fid, template: t.template, valid: t.valid });
        }
        const device = devices.find(deviceId);
        if (judul) this._progress(deviceId, judul, 'Menyimpan sidik jari ke aplikasi...');
        tersimpan = {
          ...fingerprints.saveMany(rows, { deviceId, deviceName: device && device.name }),
          dibaca: templates.length,
          tanpaPin,
        };
      }
      // Mesin menjawab permintaan template: berarti jalur sidik jari terbuka.
      devices.setFingerprintSupport(deviceId, true);
    } catch {
      // Ditolak mentah-mentah (biasanya kode 2001 pada firmware lama). Dicatat
      // supaya pengguna diberi tahu sebelum mencoba mengirim sidik jari ke sini.
      devices.setFingerprintSupport(deviceId, false);
    }

    devices.saveUsers(deviceId, users, counts);
    users.templateInfo = tersimpan;
    return users;
  }

  /** Tarik daftar user dari mesin (beserta jumlah sidik jarinya) ke device_users. */
  syncUsers(deviceId) {
    const device = this._device(deviceId);
    return this._enqueue(deviceId, async () => {
      try {
        const judul = `Import dari ${device.name}`;
        this._progress(deviceId, judul, 'Menghubungi mesin...');
        const users = await this._withClient(device, async (client) => {
          await client.disableDevice().catch(() => {});
          try {
            return await this._refreshUserList(client, deviceId, judul, { simpanTemplate: true });
          } finally {
            await client.enableDevice().catch(() => {});
          }
        });

        this._progress(deviceId, judul, 'Selesai', { current: users.length, total: users.length, done: true });
        const tpl = users.templateInfo;
        devices.setStatus(
          deviceId,
          tpl ? `Baca mesin: ${users.length} user, ${tpl.saved} sidik jari` : `Baca mesin: ${users.length} user`
        );
        this.emit('users-synced', { deviceId, count: users.length });
        return { ok: true, count: users.length, users, templates: tpl };
      } catch (err) {
        this._progress(deviceId, `Import dari ${device.name}`, 'Gagal', { done: true });
        devices.setStatus(deviceId, `Gagal sinkron user: ${err.message}`);
        return { ok: false, error: err.message };
      }
    });
  }

  /**
   * Kirim data karyawan dari aplikasi ke mesin: PIN, nama, kartu RFID, hak
   * akses, password, DAN sidik jari yang tersimpan di aplikasi.
   *
   * Sidik jari hanya ikut bila sudah pernah diunduh dari mesin lain — merekam
   * jari baru tetap harus lewat sensor di mesin.
   */
  pushEmployees(deviceId, employeeIds) {
    const device = this._device(deviceId);
    return this._enqueue(deviceId, async () => {
      const rows = employeeIds
        .map((id) => employees.find(id))
        .filter(Boolean);
      if (!rows.length) return { ok: false, error: 'Tidak ada karyawan yang dipilih' };

      const sent = [];
      const failed = [];
      let sebelumJari = null;
      let sesudahJari = null;
      const judul = `Kirim ke ${device.name}`;
      this._progress(deviceId, judul, 'Menghubungi mesin...');
      try {
        await this._withClient(device, async (client) => {
          await client.disableDevice().catch(() => {});
          try {
            // Sekali baca daftar user, supaya uid tidak dicari ulang tiap karyawan.
            this._progress(deviceId, judul, 'Membaca daftar user di mesin...');
            const existing = await client.getUsers();
            sebelumJari = (await client.getSizes().catch(() => ({}))).fingers;

            // Sidik jari yang tersimpan di aplikasi ikut dipasang sekalian —
            // satu tindakan, bukan dua langkah terpisah.
            const jariPerPin = new Map();
            for (const t of fingerprints.forPins(rows.map((r) => String(r.pin)))) {
              const pin = String(t.user_pin);
              if (!jariPerPin.has(pin)) jariPerPin.set(pin, []);
              jariPerPin.get(pin).push({ fid: t.finger_id, valid: t.valid, template: t.template });
            }
            const byPin = new Map(existing.map((u) => [String(u.userId), u]));
            const usedUids = new Set(existing.map((u) => u.uid));
            let nextUid = 1;

            let ke = 0;
            for (const emp of rows) {
              ke += 1;
              this._progress(deviceId, judul, 'Mengirim data karyawan', {
                current: ke, total: rows.length, label: `${emp.pin} — ${emp.name}`,
              });
              const current = byPin.get(String(emp.pin));
              let uid = current ? current.uid : null;
              if (!uid) {
                while (usedUids.has(nextUid)) nextUid += 1;
                uid = nextUid;
                usedUids.add(uid);
              }
              const jari = jariPerPin.get(String(emp.pin)) || [];
              const dataUser = {
                uid,
                userId: String(emp.pin),
                name: emp.name,
                privilege: emp.privilege || 0,
                password: emp.device_password || '',
                card: emp.card || 0,
              };
              try {
                if (jari.length) {
                  await client.saveUserWithTemplates(dataUser, jari.map((f) => ({ ...f, uid })));
                } else {
                  await client.setUser({ ...dataUser, refresh: false });
                }
                sent.push({ pin: emp.pin, name: emp.name, uid, created: !current, jari: jari.length });
              } catch (err) {
                failed.push({ pin: emp.pin, name: emp.name, error: err.message });
              }
            }
            // Satu kali muat ulang untuk seluruh batch, bukan per karyawan.
            this._progress(deviceId, judul, 'Menyimpan di mesin...');
            await client.refreshData();
            this._progress(deviceId, judul, 'Memeriksa hasil di mesin...');
            sesudahJari = (await client.getSizes().catch(() => ({}))).fingers;
            await this._refreshUserList(client, deviceId);
          } finally {
            await client.enableDevice().catch(() => {});
          }
        });
      } catch (err) {
        this._progress(deviceId, judul, 'Gagal', { done: true });
        devices.setStatus(deviceId, `Gagal kirim karyawan: ${err.message}`);
        return { ok: false, error: err.message, sent, failed };
      }

      // Data aplikasi kini sudah ada di mesin: catat sebagai kondisi disepakati,
      // supaya perubahan berikutnya bisa dikenali datang dari sisi mana.
      this._progress(deviceId, judul, 'Selesai', { done: true });
      devices.markPushed(deviceId, sent.map((s) => s.pin));

      const jariTerkirim = sent.reduce((n, x) => n + (x.jari || 0), 0);
      const jariBertambah =
        Number.isFinite(sebelumJari) && Number.isFinite(sesudahJari) ? sesudahJari - sebelumJari : null;

      // Sidik jari dikirim tetapi penghitung mesin tidak bergerak sama sekali:
      // firmware-nya menolak, meski setiap paket tadi dijawab OK.
      if (jariTerkirim > 0 && jariBertambah === 0) {
        devices.setFingerprintSupport(deviceId, false);
      } else if (jariTerkirim > 0 && jariBertambah > 0) {
        devices.setFingerprintSupport(deviceId, true);
      }

      devices.setStatus(
        deviceId,
        `Kirim karyawan: ${sent.length} berhasil, ${failed.length} gagal` +
          (jariTerkirim ? `, ${jariTerkirim} sidik jari` : '')
      );
      this.emit('users-synced', { deviceId, count: sent.length });

      return {
        ok: failed.length === 0,
        sent,
        failed,
        jari: { terkirim: jariTerkirim, sebelum: sebelumJari, sesudah: sesudahJari, bertambah: jariBertambah },
      };
    });
  }

  /** Hapus user dari mesin berdasarkan PIN. */
  /**
   * Hapus user dari mesin. `pins` berisi daftar PIN, atau null untuk
   * menghapus SELURUH user yang ada di mesin.
   *
   * Sidik jari milik user ikut terhapus. Log absensi yang tersimpan di mesin
   * TIDAK disentuh — masih bisa ditarik setelah ini.
   */
  removeDeviceUsers(deviceId, pins = null) {
    const device = this._device(deviceId);
    return this._enqueue(deviceId, async () => {
      const removed = [];
      const failed = [];
      const semua = pins === null;
      const judul = semua ? `Hapus semua user di ${device.name}` : `Hapus user di ${device.name}`;
      let sisa = null;

      this._progress(deviceId, judul, 'Menghubungi mesin...');
      try {
        await this._withClient(device, async (client) => {
          await client.disableDevice().catch(() => {});
          try {
            this._progress(deviceId, judul, 'Membaca daftar user di mesin...');
            const existing = await client.getUsers();
            const byPin = new Map(existing.map((u) => [String(u.userId), u]));
            const target = semua ? existing : pins.map((pin) => byPin.get(String(pin))).filter(Boolean);

            let ke = 0;
            for (const u of target) {
              ke += 1;
              this._progress(deviceId, judul, 'Menghapus user', {
                current: ke, total: target.length, label: `${u.userId} — ${u.name || ''}`,
              });
              try {
                // Penyimpanan ditunda; dilakukan sekali setelah semua selesai.
                await client.deleteUser(u.uid, { refresh: false });
                removed.push(String(u.userId));
              } catch (err) {
                failed.push({ pin: String(u.userId), error: err.message });
              }
            }

            this._progress(deviceId, judul, 'Menyimpan perubahan di mesin...');
            await client.refreshData();

            // Dihitung ulang dari mesin, bukan dari jumlah yang dikirim.
            this._progress(deviceId, judul, 'Memeriksa hasil...');
            sisa = (await client.getSizes().catch(() => ({}))).users;
            await this._refreshUserList(client, deviceId, judul);
          } finally {
            await client.enableDevice().catch(() => {});
          }
        });
      } catch (err) {
        this._progress(deviceId, judul, 'Gagal', { done: true });
        return { ok: false, error: err.message, removed, failed };
      }

      this._progress(deviceId, judul, 'Selesai', { done: true });
      devices.setStatus(deviceId, `Hapus user: ${removed.length} terhapus`);
      this.emit('users-synced', { deviceId, count: removed.length });
      return { ok: failed.length === 0, removed, failed, sisa };
    });
  }

  /** Tarik log absensi dari satu mesin. */
  pull(deviceId, { silent = false } = {}) {
    const device = this._device(deviceId);
    return this._enqueue(deviceId, async () => {
      if (this.syncing.has(deviceId)) return { ok: false, error: 'Penarikan data sedang berjalan' };
      this.syncing.add(deviceId);
      const historyId = devices.logSyncStart(deviceId);
      if (!silent) this.emit('sync-start', { deviceId, name: device.name });

      try {
        const records = await this._withClient(device, async (client) => {
          await client.disableDevice().catch(() => {});
          try {
            return await client.getAttendance();
          } finally {
            await client.enableDevice().catch(() => {});
          }
        });

        const result = insertLogs(deviceId, records, 'tarik');
        devices.logSyncEnd(historyId, {
          ok: true,
          fetched: result.fetched,
          inserted: result.inserted,
          message: `${result.inserted} baru, ${result.duplicate} duplikat`,
        });
        devices.setStatus(deviceId, `Tarik data: ${result.inserted} baru dari ${result.fetched}`, { lastSync: true });
        this.emit('sync-done', { deviceId, name: device.name, ...result });
        return { ok: true, ...result };
      } catch (err) {
        devices.logSyncEnd(historyId, { ok: false, message: err.message });
        devices.setStatus(deviceId, `Gagal tarik data: ${err.message}`);
        this.emit('sync-error', { deviceId, name: device.name, error: err.message });
        return { ok: false, error: err.message };
      } finally {
        this.syncing.delete(deviceId);
      }
    });
  }

  /** Tarik dari semua mesin aktif. */
  async pullAll({ onlyAutoSync = false, silent = false } = {}) {
    const list = devices.list().filter((d) => d.active && (!onlyAutoSync || d.auto_sync));
    const results = [];
    for (const d of list) {
      results.push({ deviceId: d.id, name: d.name, ...(await this.pull(d.id, { silent })) });
    }
    return results;
  }

  async setDeviceTime(deviceId, date = new Date()) {
    const device = this._device(deviceId);
    return this._enqueue(deviceId, async () => {
      try {
        await this._withClient(device, (client) => client.setTime(date));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  async clearDeviceAttendance(deviceId) {
    const device = this._device(deviceId);
    return this._enqueue(deviceId, async () => {
      try {
        await this._withClient(device, (client) => client.clearAttendance());
        devices.setStatus(deviceId, 'Log di mesin dikosongkan');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  async restartDevice(deviceId) {
    const device = this._device(deviceId);
    await this.stopLive(deviceId);
    return this._enqueue(deviceId, async () => {
      try {
        await this._withClient(device, (client) => client.restart());
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  // -------------------------------------------------------- live capture

  async startLive(deviceId) {
    if (this.live.has(deviceId)) return { ok: true, already: true };
    const device = this._device(deviceId);
    const entry = { client: null, reconnectTimer: null, stopped: false, attempts: 0 };
    this.live.set(deviceId, entry);
    const result = await this._connectLive(device, entry);
    if (!result.ok) this._scheduleReconnect(device, entry);
    return result;
  }

  async _connectLive(device, entry) {
    if (entry.stopped) return { ok: false, error: 'dihentikan' };
    const client = new ZKClient({
      ip: device.ip,
      port: device.port,
      commKey: device.comm_key,
      protocol: device.protocol,
    });

    client.on('attendance', (rec) => {
      const result = insertLogs(device.id, [rec], 'realtime');
      const emp = employees.findByPin(rec.userId);
      this.emit('live-scan', {
        deviceId: device.id,
        deviceName: device.name,
        userPin: rec.userId,
        employeeName: emp ? emp.name : null,
        ts: toDateTimeStr(rec.timestamp),
        inserted: result.inserted > 0,
        unknown: !emp,
      });
    });

    client.on('close', () => {
      if (entry.stopped) return;
      this.emit('live-status', { deviceId: device.id, active: false, message: 'Koneksi realtime terputus' });
      this._scheduleReconnect(device, entry);
    });

    client.on('error', () => {});

    try {
      await client.connect();
      await client.startLive();
      entry.client = client;
      entry.attempts = 0;
      devices.setStatus(device.id, 'Realtime aktif');
      this.emit('live-status', { deviceId: device.id, active: true, message: 'Realtime aktif' });
      return { ok: true };
    } catch (err) {
      await client.disconnect().catch(() => {});
      entry.client = null;
      devices.setStatus(device.id, `Realtime gagal: ${err.message}`);
      this.emit('live-status', { deviceId: device.id, active: false, message: err.message });
      return { ok: false, error: err.message };
    }
  }

  /** Sambung ulang otomatis dengan jeda bertambah (maks 60 detik). */
  _scheduleReconnect(device, entry) {
    if (entry.stopped || entry.reconnectTimer) return;
    entry.attempts = (entry.attempts || 0) + 1;
    const delay = Math.min(5000 * entry.attempts, 60000);
    entry.reconnectTimer = setTimeout(async () => {
      entry.reconnectTimer = null;
      if (entry.stopped) return;
      const fresh = devices.find(device.id);
      if (!fresh || !fresh.active || !fresh.live_capture) {
        await this.stopLive(device.id);
        return;
      }
      const result = await this._connectLive(fresh, entry);
      if (!result.ok) this._scheduleReconnect(fresh, entry);
    }, delay);
  }

  async stopLive(deviceId) {
    const entry = this.live.get(deviceId);
    if (!entry) return { ok: true };
    entry.stopped = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    this.live.delete(deviceId);
    if (entry.client) {
      await entry.client.stopLive().catch(() => {});
      await entry.client.disconnect().catch(() => {});
    }
    this.emit('live-status', { deviceId, active: false, message: 'Realtime dimatikan' });
    return { ok: true };
  }

  liveStatus() {
    const out = {};
    for (const [id, entry] of this.live) {
      out[id] = !!(entry.client && entry.client.connected && entry.client.liveMode);
    }
    return out;
  }

  /** Samakan koneksi live dengan kolom `live_capture` di database. */
  async syncLiveConnections() {
    const enabled = settings.get('live_capture_enabled', '1') === '1';
    const list = devices.list();
    const shouldRun = new Set(
      enabled ? list.filter((d) => d.active && d.live_capture).map((d) => d.id) : []
    );

    for (const id of [...this.live.keys()]) {
      if (!shouldRun.has(id)) await this.stopLive(id);
    }
    for (const id of shouldRun) {
      if (!this.live.has(id)) await this.startLive(id);
    }
    return this.liveStatus();
  }

  // ---------------------------------------------------------- auto-sync

  startAutoSync() {
    this.stopAutoSync();
    if (settings.get('auto_sync_enabled', '1') !== '1') return;
    const minutes = Math.max(1, Number(settings.get('auto_sync_interval', '15')) || 15);
    this.autoSyncTimer = setInterval(() => {
      this.pullAll({ onlyAutoSync: true, silent: true }).catch(() => {});
    }, minutes * 60 * 1000);
    this.emit('autosync-status', { active: true, minutes });
  }

  stopAutoSync() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
      this.emit('autosync-status', { active: false });
    }
  }

  /** Terapkan ulang pengaturan auto-sync & live setelah diubah user. */
  async applySettings() {
    this.startAutoSync();
    await this.syncLiveConnections();
    return { autoSync: !!this.autoSyncTimer, live: this.liveStatus() };
  }

  async shutdown() {
    this.stopAutoSync();
    for (const id of [...this.live.keys()]) await this.stopLive(id);
  }
}

module.exports = { DeviceManager };
