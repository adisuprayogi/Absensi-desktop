PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pin           TEXT NOT NULL UNIQUE,        -- User ID / PIN di mesin absensi
  nip           TEXT,                        -- nomor induk pegawai (opsional)
  name          TEXT NOT NULL,
  card          INTEGER NOT NULL DEFAULT 0,  -- nomor kartu RFID (0 = tidak ada)
  privilege     INTEGER NOT NULL DEFAULT 0,  -- hak akses di mesin: 0 user, 14 admin
  device_password TEXT,                      -- password numerik untuk buka di mesin
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  position      TEXT,
  phone         TEXT,
  email         TEXT,
  join_date     TEXT,
  default_shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(active);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);

CREATE TABLE IF NOT EXISTS devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  ip           TEXT NOT NULL,
  port         INTEGER NOT NULL DEFAULT 4370,
  comm_key     INTEGER NOT NULL DEFAULT 0,
  protocol     TEXT NOT NULL DEFAULT 'tcp',   -- tcp | udp
  model        TEXT,
  serial       TEXT,
  firmware     TEXT,
  auto_sync    INTEGER NOT NULL DEFAULT 1,
  live_capture INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_status  TEXT,
  -- Apakah mesin mau bertukar sidik jari lewat jaringan.
  -- NULL = belum diketahui, 1 = bisa, 0 = firmware-nya menolak.
  -- Sebagian firmware lama meng-ACK kiriman lalu membuangnya diam-diam,
  -- jadi ini satu-satunya cara memberi tahu pengguna sebelum ia menunggu sia-sia.
  fp_support   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(ip, port)
);

-- Daftar user apa adanya di tiap mesin, hasil sinkronisasi.
CREATE TABLE IF NOT EXISTS device_users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  uid         INTEGER,
  user_pin    TEXT NOT NULL,
  name        TEXT,
  privilege   INTEGER DEFAULT 0,
  card        INTEGER DEFAULT 0,
  password    TEXT,                          -- password numerik user di mesin
  finger_count INTEGER DEFAULT 0,            -- jumlah sidik jari terdaftar di mesin
  synced_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),

  -- Rekaman kondisi terakhir yang SAMA di aplikasi dan di mesin. Dipakai untuk
  -- membedakan "diubah di aplikasi" dari "diubah di mesin": sisi yang nilainya
  -- menyimpang dari rekaman inilah yang berubah. base_at NULL = belum pernah
  -- tercatat sepakat, jadi asal perubahan tidak bisa dipastikan.
  base_name      TEXT,
  base_card      INTEGER,
  base_privilege INTEGER,
  base_at        TEXT,

  UNIQUE(device_id, user_pin)
);

-- Template sidik jari milik karyawan.
--
-- Disimpan per PIN, BUKAN per mesin: nomor internal (uid) berbeda-beda di tiap
-- mesin, sedangkan PIN sama di mana pun. Dengan begitu satu salinan bisa
-- dipasang ke mesin mana saja, dan ikut terbawa ke dalam backup database.
CREATE TABLE IF NOT EXISTS fingerprints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_pin    TEXT NOT NULL,
  finger_id   INTEGER NOT NULL,               -- jari ke-0 sampai ke-9
  template    BLOB NOT NULL,                  -- data biner milik algoritma mesin
  size        INTEGER NOT NULL,
  valid       INTEGER NOT NULL DEFAULT 1,
  source_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  source_name TEXT,                           -- nama mesin asal, tetap ada meski mesinnya dihapus
  captured_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_pin, finger_id)
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_pin ON fingerprints(user_pin);

CREATE TABLE IF NOT EXISTS shifts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  start_time      TEXT NOT NULL DEFAULT '08:00',   -- HH:MM
  end_time        TEXT NOT NULL DEFAULT '17:00',
  break_minutes   INTEGER NOT NULL DEFAULT 60,
  late_tolerance  INTEGER NOT NULL DEFAULT 0,      -- menit
  early_tolerance INTEGER NOT NULL DEFAULT 0,      -- menit
  overtime_after  INTEGER NOT NULL DEFAULT 30,     -- menit lewat jam pulang
  min_work_minutes INTEGER NOT NULL DEFAULT 0,
  is_off          INTEGER NOT NULL DEFAULT 0,      -- 1 = shift libur
  color           TEXT DEFAULT '#4f7cff',
  active          INTEGER NOT NULL DEFAULT 1
);

-- Jadwal eksplisit per karyawan per tanggal.
CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date   TEXT NOT NULL,                       -- YYYY-MM-DD
  shift_id    INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
  note        TEXT,
  UNIQUE(employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(work_date);

-- Jadwal bawaan per hari dalam seminggu (0 = Minggu .. 6 = Sabtu).
CREATE TABLE IF NOT EXISTS default_schedule (
  dow      INTEGER PRIMARY KEY,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS leave_types (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  counts_as_present  INTEGER NOT NULL DEFAULT 0,   -- 1 = dihitung hadir di rekap
  is_paid            INTEGER NOT NULL DEFAULT 1,
  color              TEXT DEFAULT '#8b5cf6'
);

CREATE TABLE IF NOT EXISTS leaves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'disetujui', -- diajukan | disetujui | ditolak
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_leaves_emp ON leaves(employee_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS holidays (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  date  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

-- Log scan mentah dari mesin. UNIQUE mencegah duplikat saat tarik ulang.
CREATE TABLE IF NOT EXISTS attendance_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  user_pin    TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  ts          TEXT NOT NULL,                       -- YYYY-MM-DD HH:MM:SS
  log_date    TEXT NOT NULL,                       -- YYYY-MM-DD (untuk indeks)
  status      INTEGER DEFAULT 0,                   -- mode verifikasi
  punch       INTEGER DEFAULT 0,                   -- masuk / pulang / dll
  source      TEXT NOT NULL DEFAULT 'tarik',       -- tarik | realtime | manual
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(device_id, user_pin, ts)
);
CREATE INDEX IF NOT EXISTS idx_logs_date ON attendance_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_logs_emp_date ON attendance_logs(employee_id, log_date);
CREATE INDEX IF NOT EXISTS idx_logs_pin ON attendance_logs(user_pin);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sync_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  fetched    INTEGER DEFAULT 0,
  inserted   INTEGER DEFAULT 0,
  ok         INTEGER DEFAULT 0,
  message    TEXT
);
