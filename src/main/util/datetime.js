'use strict';

const pad = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' memakai waktu lokal (bukan UTC). */
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date -> 'YYYY-MM-DD HH:MM:SS' waktu lokal. */
function toDateTimeStr(d) {
  return `${toDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'YYYY-MM-DD' atau 'YYYY-MM-DD HH:MM:SS' -> Date lokal. */
function parseDateTime(s) {
  if (!s) return null;
  const m = String(s).match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0)
  );
}

/** 'HH:MM' -> menit sejak tengah malam. */
function timeToMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Menit -> 'HH:MM' (bisa lewat 24 jam, mis. 1500 -> '25:00'). */
function minutesToTime(min) {
  const v = Math.max(0, Math.round(min));
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
}

/** Menit -> '2j 15m' untuk tampilan. */
function humanDuration(min) {
  const v = Math.max(0, Math.round(min || 0));
  if (v === 0) return '-';
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}j`;
  return `${h}j ${m}m`;
}

function addDays(dateStr, days) {
  const d = parseDateTime(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

/** Daftar tanggal 'YYYY-MM-DD' dari start sampai end (inklusif). */
function dateRange(start, end) {
  const out = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 3660) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

function dayOfWeek(dateStr) {
  return parseDateTime(dateStr).getDay();
}

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

function dayName(dateStr) {
  return DAY_NAMES[dayOfWeek(dateStr)];
}

/** 'YYYY-MM-DD' -> '07 September 2026'. */
function formatDateLong(dateStr) {
  const d = parseDateTime(dateStr);
  if (!d) return '';
  return `${pad(d.getDate())} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** Batas awal & akhir bulan untuk 'YYYY-MM'. */
function monthBounds(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${y}-${pad(m)}-01`;
  const last = new Date(y, m, 0).getDate();
  return { start, end: `${y}-${pad(m)}-${pad(last)}` };
}

function todayStr() {
  return toDateStr(new Date());
}

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

module.exports = {
  pad,
  toDateStr,
  toDateTimeStr,
  parseDateTime,
  timeToMinutes,
  minutesToTime,
  humanDuration,
  addDays,
  dateRange,
  dayOfWeek,
  dayName,
  formatDateLong,
  monthBounds,
  todayStr,
  currentMonthStr,
  DAY_NAMES,
  MONTH_NAMES,
};
