'use strict';

/**
 * Konstanta protokol ZKTeco (dipakai mesin Solution X105 / X401 / X601, dll).
 * Referensi: protokol "standalone SDK" ZKTeco, port default 4370 (TCP & UDP).
 */

const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLEDEVICE: 1002,
  DISABLEDEVICE: 1003,
  RESTART: 1004,
  POWEROFF: 1005,
  SLEEP: 1006,
  RESUME: 1007,
  TEST_TEMP: 1011,
  TESTVOICE: 1017,
  VERSION: 1100,
  CHANGE_SPEED: 1101,
  AUTH: 1102,

  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  DATA_WRRQ: 1503,
  DATA_RDY: 1504,

  DB_RRQ: 7,
  USER_WRQ: 8,
  USERTEMP_RRQ: 9,
  USERTEMP_WRQ: 10,
  OPTIONS_RRQ: 11,
  OPTIONS_WRQ: 12,
  ATTLOG_RRQ: 13,
  CLEAR_DATA: 14,
  CLEAR_ATTLOG: 15,
  DELETE_USER: 18,
  DELETE_USERTEMP: 19,
  CLEAR_ADMIN: 20,

  GET_FREE_SIZES: 50,
  ENABLE_CLOCK: 57,
  STARTVERIFY: 60,
  STARTENROLL: 61,
  CANCELCAPTURE: 62,
  STATE_RRQ: 64,
  WRITE_LCD: 66,
  CLEAR_LCD: 67,
  GET_PINWIDTH: 69,

  GET_TIME: 201,
  SET_TIME: 202,
  REG_EVENT: 500,

  /** Minta mesin memuat ulang basis datanya setelah data ditulis. */
  REFRESHDATA: 1013,
  /** Simpan user + template yang sudah dikirim lewat buffer (lihat client.saveUserWithTemplates). */
  SAVE_USERTEMPS: 110,

  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_RETRY: 2003,
  ACK_REPEAT: 2004,
  ACK_UNAUTH: 2005,
  ACK_UNKNOWN: 0xffff,
  ACK_ERROR_CMD: 0xfffd,
  ACK_ERROR_INIT: 0xfffc,
  ACK_ERROR_DATA: 0xfffb,
};

/** Flag event untuk CMD_REG_EVENT (live capture). */
const EF = {
  ATTLOG: 1,
  FINGER: 1 << 1,
  ENROLLUSER: 1 << 2,
  ENROLLFINGER: 1 << 3,
  BUTTON: 1 << 4,
  UNLOCK: 1 << 5,
  VERIFY: 1 << 7,
  FPFTR: 1 << 8,
  ALARM: 1 << 9,
};

/** Selector data untuk CMD_DATA_WRRQ. */
const FCT = {
  ATTLOG: 1,
  WORKCODE: 8,
  FINGERTMP: 2,
  OPLOG: 4,
  USER: 5,
  SMS: 6,
  UDATA: 7,
  FACE: 9,
};

/** Tingkat hak akses user di mesin. */
const PRIVILEGE = {
  USER: 0,
  ENROLLER: 2,
  MANAGER: 12,
  ADMIN: 14,
};

const PRIVILEGE_LABEL = {
  0: 'Pengguna',
  2: 'Pendaftar',
  12: 'Manajer',
  14: 'Administrator',
};

const USHRT_MAX = 65535;

/** 4 byte penanda awal frame pada mode TCP: 0x50 0x50 0x82 0x7d */
const TCP_MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const TCP_HEADER_SIZE = 8;

/** Mode verifikasi (kolom `verify` pada log). */
const VERIFY_MODE = {
  0: 'Password',
  1: 'Sidik Jari',
  2: 'Kartu',
  3: 'Sidik Jari',
  4: 'Kartu',
  15: 'Wajah',
  255: 'Lainnya',
};

/** Status punch bawaan mesin (kolom `status` pada log). */
const PUNCH_STATE = {
  0: 'Masuk',
  1: 'Pulang',
  2: 'Istirahat Keluar',
  3: 'Istirahat Masuk',
  4: 'Lembur Masuk',
  5: 'Lembur Pulang',
  255: '-',
};

module.exports = {
  CMD,
  EF,
  FCT,
  PRIVILEGE,
  PRIVILEGE_LABEL,
  USHRT_MAX,
  TCP_MAGIC,
  TCP_HEADER_SIZE,
  VERIFY_MODE,
  PUNCH_STATE,
};
