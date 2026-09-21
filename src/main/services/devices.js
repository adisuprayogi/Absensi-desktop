'use strict';

const db = require('../db');
const { placeholders } = require('../util/sql');

const devices = {
  list() {
    return db.get().prepare(`
      SELECT d.*,
             (SELECT COUNT(*) FROM device_users du WHERE du.device_id = d.id) AS user_count,
             (SELECT COUNT(*) FROM attendance_logs l WHERE l.device_id = d.id) AS log_count
      FROM devices d ORDER BY d.name
    `).all();
  },

  find(id) {
    return db.get().prepare('SELECT * FROM devices WHERE id = ?').get(id);
  },

  create(d) {
    const info = db.get().prepare(`
      INSERT INTO devices (name, ip, port, comm_key, protocol, auto_sync, live_capture, active)
      VALUES (@name, @ip, @port, @comm_key, @protocol, @auto_sync, @live_capture, @active)
    `).run(normalize(d));
    return info.lastInsertRowid;
  },

  update(id, d) {
    db.get().prepare(`
      UPDATE devices SET name=@name, ip=@ip, port=@port, comm_key=@comm_key, protocol=@protocol,
        auto_sync=@auto_sync, live_capture=@live_capture, active=@active
      WHERE id=@id
    `).run({ ...normalize(d), id });
    return true;
  },

  remove(id) {
    db.get().prepare('DELETE FROM devices WHERE id = ?').run(id);
    return true;
  },

  setStatus(id, status, { lastSync = false, info = null } = {}) {
    const fields = ['last_status = @status'];
    const params = { id, status: String(status || '').slice(0, 200) };
    if (lastSync) fields.push("last_sync_at = datetime('now','localtime')");
    if (info) {
      if (info.model !== undefined) {
        fields.push('model = @model');
        params.model = info.model;
      }
      if (info.serial !== undefined) {
        fields.push('serial = @serial');
        params.serial = info.serial;
      }
      if (info.firmware !== undefined) {
        fields.push('firmware = @firmware');
        params.firmware = info.firmware;
      }
    }
    db.get().prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return true;
  },

  /**
   * Simpan daftar user hasil sinkronisasi dari mesin.
   * User yang sudah tidak ada di mesin ikut dibuang, supaya perbandingan
   * aplikasi vs mesin tidak menampilkan sisa data lama.
   */
  saveUsers(deviceId, users, fingerCounts = null) {
    const stmt = db.get().prepare(`
      INSERT INTO device_users (device_id, uid, user_pin, name, privilege, card, password, finger_count, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(device_id, user_pin) DO UPDATE SET
        uid = excluded.uid, name = excluded.name, privilege = excluded.privilege,
        card = excluded.card, password = excluded.password,
        finger_count = excluded.finger_count, synced_at = excluded.synced_at
    `);
    const tx = db.get().transaction((list) => {
      for (const u of list) {
        stmt.run(
          deviceId,
          u.uid || 0,
          String(u.userId),
          u.name || '',
          u.privilege || 0,
          u.card || 0,
          u.password || null,
          fingerCounts ? fingerCounts.get(u.uid) || 0 : 0
        );
      }
      const keep = list.map((u) => String(u.userId));
      const sisa = keep.length ? keep.map(() => '?').join(',') : "''";
      db.get()
        .prepare(`DELETE FROM device_users WHERE device_id = ? AND user_pin NOT IN (${sisa})`)
        .run(deviceId, ...keep);

      // Bila aplikasi dan mesin ternyata sudah sama persis dan belum pernah
      // tercatat sepakat, catat sekarang — supaya perubahan berikutnya di salah
      // satu sisi bisa dikenali asalnya.
      db.get()
        .prepare(`
          UPDATE device_users SET
            base_name = name, base_card = card, base_privilege = privilege,
            base_at = datetime('now','localtime')
          WHERE device_id = ? AND base_at IS NULL AND EXISTS (
            SELECT 1 FROM employees e
            WHERE e.pin = device_users.user_pin
              AND TRIM(IFNULL(e.name, '')) = TRIM(IFNULL(device_users.name, ''))
              AND IFNULL(e.card, 0) = IFNULL(device_users.card, 0)
              AND IFNULL(e.privilege, 0) = IFNULL(device_users.privilege, 0)
          )
        `)
        .run(deviceId);
    });
    tx(users);
    return users.length;
  },

  /** Catat apakah mesin mendukung transfer sidik jari (null = belum tahu). */
  setFingerprintSupport(id, bisa) {
    db.get()
      .prepare('UPDATE devices SET fp_support = ? WHERE id = ?')
      .run(bisa === null ? null : bisa ? 1 : 0, id);
    return true;
  },

  /**
   * Identitas seseorang menurut mesin mana pun yang pernah dibaca.
   *
   * Dipakai saat memasang sidik jari ke mesin baru untuk orang yang belum
   * terdaftar sebagai karyawan di aplikasi: nama dan kartunya sudah pernah
   * terbaca dari mesin asal, jadi tidak perlu jatuh ke nama generik.
   */
  findUserByPin(pin) {
    return db.get()
      .prepare(`
        SELECT user_pin, name, card, privilege, password
        FROM device_users
        WHERE user_pin = ? AND TRIM(IFNULL(name, '')) <> ''
        ORDER BY synced_at DESC LIMIT 1
      `)
      .get(String(pin));
  },

  /**
   * Catat kondisi saat ini sebagai "disepakati kedua sisi", memakai nilai dari
   * aplikasi. Dipanggil setelah data berhasil dikirim ke mesin.
   */
  markPushed(deviceId, pins) {
    const stmt = db.get().prepare(`
      UPDATE device_users SET
        base_name = (SELECT e.name FROM employees e WHERE e.pin = device_users.user_pin),
        base_card = (SELECT IFNULL(e.card, 0) FROM employees e WHERE e.pin = device_users.user_pin),
        base_privilege = (SELECT IFNULL(e.privilege, 0) FROM employees e WHERE e.pin = device_users.user_pin),
        base_at = datetime('now','localtime')
      WHERE device_id = ? AND user_pin = ?
        AND EXISTS (SELECT 1 FROM employees e WHERE e.pin = device_users.user_pin)
    `);
    const tx = db.get().transaction((list) => {
      for (const pin of list) stmt.run(deviceId, String(pin));
    });
    tx(pins);
    return true;
  },

  /**
   * Timpa data karyawan di aplikasi dengan data dari mesin, lalu catat kondisi
   * itu sebagai disepakati. Kebalikan arah dari markPushed().
   */
  adoptFromDevice(deviceId, pins) {
    const rows = db.get()
      .prepare(`
        SELECT du.user_pin, du.name, du.card, du.privilege, e.id AS employee_id
        FROM device_users du
        JOIN employees e ON e.pin = du.user_pin
        WHERE du.device_id = ? AND du.user_pin IN (${placeholders(pins)})
      `)
      .all(deviceId, ...pins.map(String));

    const updateEmp = db.get().prepare(`
      UPDATE employees SET name = ?, card = ?, privilege = ?,
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `);
    const updateBase = db.get().prepare(`
      UPDATE device_users SET base_name = ?, base_card = ?, base_privilege = ?,
        base_at = datetime('now','localtime')
      WHERE device_id = ? AND user_pin = ?
    `);

    const tx = db.get().transaction((list) => {
      for (const r of list) {
        const nama = String(r.name || '').trim() || `Karyawan ${r.user_pin}`;
        const kartu = Number(r.card) || 0;
        const hak = Number(r.privilege) || 0;
        updateEmp.run(nama, kartu, hak, r.employee_id);
        updateBase.run(nama, kartu, hak, deviceId, String(r.user_pin));
      }
    });
    tx(rows);
    return { updated: rows.length };
  },

  /**
   * Bandingkan data karyawan di aplikasi dengan isi satu mesin.
   *
   * Menghasilkan dua daftar sejajar — sisi aplikasi dan sisi mesin — yang
   * masing-masing membawa status hubungannya dengan sisi seberang:
   *   sinkron      data sama di kedua sisi
   *   hanya_app    ada di aplikasi, belum ada di mesin
   *   hanya_mesin  ada di mesin, belum ada di aplikasi
   *   ubah_app     berbeda, dan yang berubah adalah sisi aplikasi
   *   ubah_mesin   berbeda, dan yang berubah adalah sisi mesin
   *   bentrok      kedua sisi berubah sejak terakhir sepakat
   *   beda         berbeda, tetapi asal perubahan tidak diketahui
   */
  reconcile(deviceId) {
    const onDevice = db.get()
      .prepare('SELECT * FROM device_users WHERE device_id = ? ORDER BY CAST(user_pin AS INTEGER), user_pin')
      .all(deviceId);
    const inApp = db.get()
      .prepare(`
        SELECT e.id, e.pin, e.name, e.card, e.privilege, e.active, e.updated_at,
               d.name AS department_name
        FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        ORDER BY e.name
      `)
      .all();

    // Sidik jari yang sudah tersimpan DI APLIKASI. Inilah yang menentukan siapa
    // yang bisa dikirim ke mesin ini tanpa merekam ulang jarinya — jauh lebih
    // berguna daripada sekadar tahu jarinya ada di mesin sebelah.
    const tersimpan = db.get()
      .prepare(`
        SELECT user_pin, COUNT(*) AS n, MIN(source_name) AS sumber
        FROM fingerprints WHERE valid = 1 GROUP BY user_pin
      `)
      .all();
    const fingersStored = new Map(
      tersimpan.map((r) => [String(r.user_pin), { count: r.n, source: r.sumber }])
    );

    const deviceByPin = new Map(onDevice.map((u) => [String(u.user_pin), u]));
    const appByPin = new Map(inApp.map((e) => [String(e.pin), e]));

    const norm = (r) => ({
      name: String((r && r.name) || '').trim(),
      card: Number((r && r.card) || 0),
      privilege: Number((r && r.privilege) || 0),
    });
    const sama = (a, b) =>
      a.name === b.name && a.card === b.card && a.privilege === b.privilege;

    /**
     * Tentukan hubungan satu PIN antara aplikasi dan mesin.
     * Asal perubahan disimpulkan dari rekaman kondisi terakhir yang disepakati
     * (kolom base_* pada device_users): sisi yang menyimpang dari rekaman itulah
     * yang berubah. Tanpa rekaman, yang bisa dipastikan hanyalah "berbeda".
     */
    const bandingkan = (emp, dev) => {
      if (!dev) return 'hanya_app';
      if (!emp) return 'hanya_mesin';

      const a = norm(emp);
      const d = norm(dev);
      if (sama(a, d)) return 'sinkron';

      if (!dev.base_at) return 'beda';
      const base = { name: String(dev.base_name || '').trim(), card: Number(dev.base_card || 0), privilege: Number(dev.base_privilege || 0) };

      const berubahDiApp = !sama(a, base);
      const berubahDiMesin = !sama(d, base);
      if (berubahDiApp && berubahDiMesin) return 'bentrok';
      if (berubahDiApp) return 'ubah_app';
      if (berubahDiMesin) return 'ubah_mesin';
      return 'beda';
    };

    /** Kolom mana saja yang berbeda, untuk ditampilkan sebagai keterangan. */
    const selisih = (emp, dev) => {
      if (!emp || !dev) return [];
      const a = norm(emp);
      const d = norm(dev);
      const out = [];
      if (a.name !== d.name) out.push('nama');
      if (a.card !== d.card) out.push('kartu RFID');
      if (a.privilege !== d.privilege) out.push('hak akses');
      return out;
    };

    const appRows = inApp.map((emp) => {
      const dev = deviceByPin.get(String(emp.pin)) || null;
      return {
        employee_id: emp.id,
        pin: String(emp.pin),
        name: emp.name,
        department_name: emp.department_name,
        card: Number(emp.card) || 0,
        privilege: Number(emp.privilege) || 0,
        active: emp.active,
        updated_at: emp.updated_at,
        on_device: !!dev,
        device_name: dev ? dev.name : null,
        device_card: dev ? Number(dev.card) || 0 : null,
        device_privilege: dev ? Number(dev.privilege) || 0 : null,
        finger_count: dev ? dev.finger_count || 0 : 0,
        fingers_stored: (fingersStored.get(String(emp.pin)) || {}).count || 0,
        fingers_stored_source: (fingersStored.get(String(emp.pin)) || {}).source || null,
        status: bandingkan(emp, dev),
        differences: selisih(emp, dev),
      };
    });

    const deviceRows = onDevice.map((dev) => {
      const emp = appByPin.get(String(dev.user_pin)) || null;
      return {
        uid: dev.uid,
        pin: String(dev.user_pin),
        name: dev.name,
        card: Number(dev.card) || 0,
        privilege: Number(dev.privilege) || 0,
        finger_count: dev.finger_count || 0,
        password: dev.password || null,
        synced_at: dev.synced_at,
        in_app: !!emp,
        employee_id: emp ? emp.id : null,
        app_name: emp ? emp.name : null,
        app_card: emp ? Number(emp.card) || 0 : null,
        app_privilege: emp ? Number(emp.privilege) || 0 : null,
        department_name: emp ? emp.department_name : null,
        status: bandingkan(emp, dev),
        differences: selisih(emp, dev),
      };
    });

    const hitung = (rows, status) => rows.filter((r) => r.status === status).length;

    return {
      app: appRows,
      device: deviceRows,
      counts: {
        appTotal: appRows.length,
        deviceTotal: deviceRows.length,
        sinkron: hitung(appRows, 'sinkron'),
        hanyaApp: hitung(appRows, 'hanya_app'),
        hanyaMesin: hitung(deviceRows, 'hanya_mesin'),
        ubahApp: hitung(appRows, 'ubah_app'),
        ubahMesin: hitung(appRows, 'ubah_mesin'),
        bentrok: hitung(appRows, 'bentrok'),
        beda: hitung(appRows, 'beda'),
      },
      lastSync: onDevice.length ? onDevice[0].synced_at : null,
    };
  },

  /** User mesin beserta status pemetaannya ke karyawan. */
  deviceUsers(deviceId = null) {
    const sql = `
      SELECT du.*, dv.name AS device_name, e.id AS employee_id, e.name AS employee_name
      FROM device_users du
      LEFT JOIN devices dv ON dv.id = du.device_id
      LEFT JOIN employees e ON e.pin = du.user_pin
      ${deviceId ? 'WHERE du.device_id = ?' : ''}
      ORDER BY CAST(du.user_pin AS INTEGER), du.user_pin
    `;
    const stmt = db.get().prepare(sql);
    return deviceId ? stmt.all(deviceId) : stmt.all();
  },

  logSyncStart(deviceId) {
    const info = db.get()
      .prepare("INSERT INTO sync_history (device_id, started_at) VALUES (?, datetime('now','localtime'))")
      .run(deviceId);
    return info.lastInsertRowid;
  },

  logSyncEnd(historyId, { ok, fetched = 0, inserted = 0, message = null }) {
    db.get().prepare(`
      UPDATE sync_history SET ended_at = datetime('now','localtime'),
        fetched = ?, inserted = ?, ok = ?, message = ? WHERE id = ?
    `).run(fetched, inserted, ok ? 1 : 0, message, historyId);
  },

  syncHistory(limit = 50) {
    return db.get().prepare(`
      SELECT h.*, d.name AS device_name FROM sync_history h
      LEFT JOIN devices d ON d.id = h.device_id
      ORDER BY h.id DESC LIMIT ?
    `).all(Math.min(Number(limit) || 50, 500));
  },
};

function normalize(d) {
  return {
    name: String(d.name || '').trim() || 'Mesin Absensi',
    ip: String(d.ip || '').trim(),
    port: Number(d.port) || 4370,
    comm_key: Number(d.comm_key) || 0,
    protocol: String(d.protocol || 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp',
    auto_sync: d.auto_sync === 0 || d.auto_sync === false ? 0 : 1,
    live_capture: d.live_capture ? 1 : 0,
    active: d.active === 0 || d.active === false ? 0 : 1,
  };
}

module.exports = { devices };
