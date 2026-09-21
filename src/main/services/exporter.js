'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { COPYRIGHT } = require('../util/branding');
const { reports } = require('./reports');
const { attendance } = require('./attendance');
const { settings } = require('./masters');
const {
  humanDuration,
  formatDateLong,
  dayName,
  monthBounds,
  MONTH_NAMES,
} = require('../util/datetime');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
};

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });
  row.height = 26;
}

function addTitle(sheet, columns, title, subtitle) {
  const company = settings.get('company_name', '') || '';
  sheet.mergeCells(1, 1, 1, columns);
  sheet.getCell(1, 1).value = company;
  sheet.getCell(1, 1).font = { bold: true, size: 13 };

  sheet.mergeCells(2, 1, 2, columns);
  sheet.getCell(2, 1).value = title;
  sheet.getCell(2, 1).font = { bold: true, size: 11 };

  sheet.mergeCells(3, 1, 3, columns);
  sheet.getCell(3, 1).value = subtitle;
  sheet.getCell(3, 1).font = { size: 10, color: { argb: 'FF6B7280' } };

  sheet.addRow([]);
}

function autoFit(sheet, minWidth = 8, maxWidth = 40) {
  sheet.columns.forEach((col) => {
    let max = minWidth;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value == null ? '' : cell.value).length + 2;
      if (len > max) max = len;
    });
    col.width = Math.min(max, maxWidth);
  });
}

// ------------------------------------------------------------------ Excel

/** Rekap bulanan: sheet ringkasan + sheet detail harian. */
async function monthlyExcel(filePath, params) {
  const data = reports.monthly(params);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aplikasi Absensi Karyawan';
  wb.created = new Date();

  // ---- Sheet 1: ringkasan per karyawan
  const s1 = wb.addWorksheet('Rekap Bulanan', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cols1 = [
    'No', 'PIN', 'NIP', 'Nama Karyawan', 'Departemen', 'Jabatan',
    'Hadir', 'Terlambat', 'Tdk Lengkap', 'Alpha', 'Cuti', 'Sakit', 'Izin', 'Dinas Luar', 'Libur',
    'Total Telat', 'Total Plg Cepat', 'Total Jam Kerja', 'Total Lembur',
  ];
  addTitle(s1, cols1.length, 'REKAP ABSENSI BULANAN', `Periode: ${monthLabel(data.month)}`);
  styleHeaderRow(s1.addRow(cols1));

  data.summary.forEach((s, i) => {
    const row = s1.addRow([
      i + 1, s.pin, s.nip || '', s.employee_name, s.department_name || '', s.position || '',
      s.hadir, s.terlambat, s.tidak_lengkap, s.alpha, s.cuti, s.sakit, s.izin, s.dinas_luar, s.libur,
      humanDuration(s.late_minutes), humanDuration(s.early_minutes),
      humanDuration(s.work_minutes), humanDuration(s.overtime_minutes),
    ]);
    row.eachCell((cell, col) => {
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: col >= 7 ? 'center' : col === 1 ? 'center' : 'left', vertical: 'middle' };
    });
  });
  autoFit(s1);
  s1.views = [{ state: 'frozen', ySplit: 5 }];

  // ---- Sheet 2: detail harian
  const s2 = wb.addWorksheet('Detail Harian', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cols2 = [
    'Tanggal', 'Hari', 'PIN', 'Nama Karyawan', 'Departemen', 'Shift', 'Jam Kerja',
    'Masuk', 'Pulang', 'Status', 'Telat (menit)', 'Plg Cepat (menit)', 'Jam Kerja', 'Lembur',
  ];
  addTitle(s2, cols2.length, 'DETAIL ABSENSI HARIAN', `Periode: ${monthLabel(data.month)}`);
  styleHeaderRow(s2.addRow(cols2));

  for (const r of data.rows) {
    const row = s2.addRow([
      r.date, dayName(r.date), r.pin, r.employee_name, r.department_name || '',
      r.shift_name || '-', r.shift_time || '-',
      r.check_in || '-', r.check_out || '-', r.status_label,
      r.late_minutes || 0, r.early_minutes || 0,
      humanDuration(r.work_minutes), humanDuration(r.overtime_minutes),
    ]);
    row.eachCell((cell, col) => {
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: col >= 8 ? 'center' : 'left', vertical: 'middle' };
    });
    if (r.status === 'A') {
      row.getCell(10).font = { color: { argb: 'FFDC2626' }, bold: true };
    } else if (r.status === 'T') {
      row.getCell(10).font = { color: { argb: 'FFD97706' }, bold: true };
    }
  }
  autoFit(s2);
  s2.views = [{ state: 'frozen', ySplit: 5 }];
  s2.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: cols2.length } };

  await wb.xlsx.writeFile(filePath);
  return { filePath, rows: data.rows.length, employees: data.summary.length };
}

/** Rekap satu hari. */
async function dailyExcel(filePath, params) {
  const rows = reports.daily(params);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Absensi Harian', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cols = [
    'No', 'PIN', 'Nama Karyawan', 'Departemen', 'Shift', 'Jam Kerja',
    'Masuk', 'Pulang', 'Status', 'Telat (menit)', 'Jam Kerja', 'Lembur',
  ];
  addTitle(sheet, cols.length, 'ABSENSI HARIAN', `${dayName(params.date)}, ${formatDateLong(params.date)}`);
  styleHeaderRow(sheet.addRow(cols));

  rows.forEach((r, i) => {
    const row = sheet.addRow([
      i + 1, r.pin, r.employee_name, r.department_name || '',
      r.shift_name || '-', r.shift_time || '-',
      r.check_in || '-', r.check_out || '-', r.status_label,
      r.late_minutes || 0, humanDuration(r.work_minutes), humanDuration(r.overtime_minutes),
    ]);
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle' };
    });
  });
  autoFit(sheet);
  await wb.xlsx.writeFile(filePath);
  return { filePath, rows: rows.length };
}

/** Log scan mentah. */
async function logsExcel(filePath, filters) {
  const { rows } = attendance.list({ ...filters, limit: 50000 });
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Log Absensi');
  const cols = ['Waktu', 'PIN', 'Nama Karyawan', 'Mesin', 'Verifikasi', 'Tipe Scan', 'Sumber'];
  addTitle(sheet, cols.length, 'LOG SCAN MENTAH', `${rows.length} baris`);
  styleHeaderRow(sheet.addRow(cols));

  for (const r of rows) {
    const row = sheet.addRow([
      r.ts, r.user_pin, r.employee_name || '(belum terdaftar)',
      r.device_name || '-', r.verify_label, r.punch_label, r.source,
    ]);
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
    });
  }
  autoFit(sheet);
  await wb.xlsx.writeFile(filePath);
  return { filePath, rows: rows.length };
}

// -------------------------------------------------------------------- PDF

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function pdfShell(title, subtitle, tableHtml, { landscape = true } = {}) {
  const company = settings.get('company_name', '') || '';
  const address = settings.get('company_address', '') || '';
  const footer = settings.get('report_footer', '') || '';
  const signer = settings.get('report_signer', '') || '';
  const signerTitle = settings.get('report_signer_title', '') || '';
  const printed = new Date().toLocaleString('id-ID');

  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 14mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 9.5px; color: #111827; margin: 0; }
  .head { text-align: center; border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; margin-bottom: 12px; }
  .head h1 { margin: 0; font-size: 15px; letter-spacing: .5px; }
  .head .addr { color: #6b7280; font-size: 9px; margin-top: 2px; }
  .head h2 { margin: 8px 0 0; font-size: 12px; text-transform: uppercase; }
  .head .sub { color: #6b7280; font-size: 9.5px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #d1d5db; padding: 4px 5px; }
  th { background: #1e3a8a; color: #fff; font-weight: 600; text-align: center; }
  tbody tr:nth-child(even) { background: #f9fafb; }
  .c { text-align: center; }
  .r { text-align: right; }
  .muted { color: #9ca3af; }
  .foot { margin-top: 14px; display: flex; justify-content: space-between; font-size: 9px; color: #6b7280; }
  .sign { margin-top: 26px; width: 220px; float: right; text-align: center; font-size: 10px; color: #111827; }
  .sign .line { margin-top: 52px; border-top: 1px solid #111827; padding-top: 3px; font-weight: 600; }
  .badge-a { color: #dc2626; font-weight: 600; }
  .badge-t { color: #d97706; font-weight: 600; }
</style></head><body>
<div class="head">
  <h1>${esc(company)}</h1>
  ${address ? `<div class="addr">${esc(address)}</div>` : ''}
  <h2>${esc(title)}</h2>
  <div class="sub">${esc(subtitle)}</div>
</div>
${tableHtml}
<div class="foot"><div>${esc(footer || COPYRIGHT)}</div><div>Dicetak: ${esc(printed)}</div></div>
${signer ? `<div class="sign"><div>Mengetahui,</div><div class="line">${esc(signer)}</div><div>${esc(signerTitle)}</div></div>` : ''}
</body></html>`;
}

function statusClass(code) {
  if (code === 'A') return 'badge-a';
  if (code === 'T') return 'badge-t';
  return '';
}

/** HTML rekap bulanan (ringkasan per karyawan). */
function monthlyPdfHtml(params) {
  const data = reports.monthly(params);
  const head = `<tr>
    <th>No</th><th>PIN</th><th>Nama Karyawan</th><th>Departemen</th>
    <th>Hadir</th><th>Telat</th><th>Alpha</th><th>Cuti</th><th>Sakit</th><th>Izin</th>
    <th>Dinas</th><th>Libur</th><th>Total Telat</th><th>Jam Kerja</th><th>Lembur</th>
  </tr>`;
  const body = data.summary
    .map(
      (s, i) => `<tr>
        <td class="c">${i + 1}</td><td class="c">${esc(s.pin)}</td>
        <td>${esc(s.employee_name)}</td><td>${esc(s.department_name || '-')}</td>
        <td class="c">${s.hadir}</td><td class="c">${s.terlambat}</td>
        <td class="c">${s.alpha ? `<span class="badge-a">${s.alpha}</span>` : 0}</td>
        <td class="c">${s.cuti}</td><td class="c">${s.sakit}</td><td class="c">${s.izin}</td>
        <td class="c">${s.dinas_luar}</td><td class="c">${s.libur}</td>
        <td class="c">${esc(humanDuration(s.late_minutes))}</td>
        <td class="c">${esc(humanDuration(s.work_minutes))}</td>
        <td class="c">${esc(humanDuration(s.overtime_minutes))}</td>
      </tr>`
    )
    .join('');
  const table = `<table><thead>${head}</thead><tbody>${body || '<tr><td colspan="15" class="c muted">Tidak ada data</td></tr>'}</tbody></table>`;
  return pdfShell('Rekap Absensi Bulanan', `Periode: ${monthLabel(data.month)}`, table);
}

/** HTML rekap harian. */
function dailyPdfHtml(params) {
  const rows = reports.daily(params);
  const head = `<tr>
    <th>No</th><th>PIN</th><th>Nama Karyawan</th><th>Departemen</th><th>Shift</th>
    <th>Jam Kerja</th><th>Masuk</th><th>Pulang</th><th>Status</th><th>Telat</th><th>Lembur</th>
  </tr>`;
  const body = rows
    .map(
      (r, i) => `<tr>
        <td class="c">${i + 1}</td><td class="c">${esc(r.pin)}</td>
        <td>${esc(r.employee_name)}</td><td>${esc(r.department_name || '-')}</td>
        <td class="c">${esc(r.shift_name || '-')}</td><td class="c">${esc(r.shift_time || '-')}</td>
        <td class="c">${esc(r.check_in || '-')}</td><td class="c">${esc(r.check_out || '-')}</td>
        <td class="c ${statusClass(r.status)}">${esc(r.status_label)}</td>
        <td class="c">${r.late_minutes ? `${r.late_minutes} m` : '-'}</td>
        <td class="c">${esc(humanDuration(r.overtime_minutes))}</td>
      </tr>`
    )
    .join('');
  const table = `<table><thead>${head}</thead><tbody>${body || '<tr><td colspan="11" class="c muted">Tidak ada data</td></tr>'}</tbody></table>`;
  return pdfShell(
    'Absensi Harian',
    `${dayName(params.date)}, ${formatDateLong(params.date)}`,
    table
  );
}

/** HTML kartu absensi satu karyawan (detail per tanggal). */
function employeeCardPdfHtml({ employeeId, month }) {
  const { start, end } = monthBounds(month);
  const { rows, summary } = reports.employeeCard({ employeeId, from: start, to: end });
  const emp = rows[0];
  const head = `<tr>
    <th>Tanggal</th><th>Hari</th><th>Shift</th><th>Jam Kerja</th>
    <th>Masuk</th><th>Pulang</th><th>Status</th><th>Telat</th><th>Jam Kerja</th><th>Lembur</th>
  </tr>`;
  const body = rows
    .map(
      (r) => `<tr>
        <td class="c">${esc(r.date)}</td><td class="c">${esc(dayName(r.date))}</td>
        <td class="c">${esc(r.shift_name || '-')}</td><td class="c">${esc(r.shift_time || '-')}</td>
        <td class="c">${esc(r.check_in || '-')}</td><td class="c">${esc(r.check_out || '-')}</td>
        <td class="c ${statusClass(r.status)}">${esc(r.status_label)}</td>
        <td class="c">${r.late_minutes ? `${r.late_minutes} m` : '-'}</td>
        <td class="c">${esc(humanDuration(r.work_minutes))}</td>
        <td class="c">${esc(humanDuration(r.overtime_minutes))}</td>
      </tr>`
    )
    .join('');

  const totals = summary
    ? `<table style="margin-top:10px"><thead><tr>
        <th>Hadir</th><th>Terlambat</th><th>Alpha</th><th>Cuti</th><th>Sakit</th><th>Izin</th>
        <th>Dinas Luar</th><th>Total Telat</th><th>Total Jam Kerja</th><th>Total Lembur</th>
      </tr></thead><tbody><tr>
        <td class="c">${summary.hadir}</td><td class="c">${summary.terlambat}</td>
        <td class="c">${summary.alpha}</td><td class="c">${summary.cuti}</td>
        <td class="c">${summary.sakit}</td><td class="c">${summary.izin}</td>
        <td class="c">${summary.dinas_luar}</td>
        <td class="c">${esc(humanDuration(summary.late_minutes))}</td>
        <td class="c">${esc(humanDuration(summary.work_minutes))}</td>
        <td class="c">${esc(humanDuration(summary.overtime_minutes))}</td>
      </tr></tbody></table>`
    : '';

  const subtitle = emp
    ? `${emp.employee_name} (PIN ${emp.pin})${emp.department_name ? ` — ${emp.department_name}` : ''} • ${monthLabel(month)}`
    : monthLabel(month);

  return pdfShell(
    'Kartu Absensi Karyawan',
    subtitle,
    `<table><thead>${head}</thead><tbody>${body}</tbody></table>${totals}`,
    { landscape: false }
  );
}

/**
 * Render HTML menjadi PDF memakai mesin cetak Chromium bawaan Electron.
 * Jendela dibuat tersembunyi lalu dibuang setelah selesai.
 */
let pdfTempDir = null;
let pdfCounter = 0;

/**
 * Direktori kerja untuk berkas HTML sementara.
 *
 * Sengaja satu direktori tetap yang TIDAK dihapus selama aplikasi berjalan:
 * menghapusnya tepat setelah jendela cetak dibuang membuat pemuatan jendela
 * berikutnya gagal dengan ERR_FAILED. Sisa berkas dibersihkan sekali saja saat
 * direktori pertama kali disiapkan, ketika belum ada jendela yang memuatnya.
 */
function ensurePdfTempDir() {
  if (pdfTempDir) return pdfTempDir;
  const os = require('node:os');
  pdfTempDir = path.join(os.tmpdir(), 'absensi-karyawan-cetak');
  fs.mkdirSync(pdfTempDir, { recursive: true });
  for (const name of fs.readdirSync(pdfTempDir)) {
    try {
      fs.unlinkSync(path.join(pdfTempDir, name));
    } catch {
      /* berkas milik proses lain — lewati saja */
    }
  }
  return pdfTempDir;
}

let pdfWindow = null;

/**
 * Satu jendela cetak tersembunyi yang dipakai ulang.
 *
 * Membuat lalu membuang BrowserWindow untuk tiap ekspor terbukti tidak stabil:
 * ekspor kedua gagal dengan ERR_FAILED, dan pada dokumen besar prosesnya bisa
 * ikut mati. Memakai ulang satu jendela menghilangkan masalah itu sekaligus
 * mempercepat ekspor berikutnya.
 */
function getPdfWindow() {
  const { BrowserWindow } = require('electron');
  if (pdfWindow && !pdfWindow.isDestroyed()) return pdfWindow;
  pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true },
  });
  return pdfWindow;
}

/**
 * Tutup jendela cetak.
 *
 * PERINGATAN: membongkar jendela ini setelah beberapa kali render terbukti bisa
 * mematikan seluruh proses saat Chromium membereskan dirinya — bukan lewat
 * exception, melainkan proses langsung berhenti. Karena itu aplikasi TIDAK
 * memanggilnya saat berjalan normal; jendela dibiarkan hidup tersembunyi sampai
 * aplikasi keluar, dan proses keluar diurus langsung oleh main.js.
 *
 * Disediakan hanya untuk keperluan pengujian dan keadaan darurat.
 */
function closePdfWindow() {
  if (pdfWindow && !pdfWindow.isDestroyed()) pdfWindow.destroy();
  pdfWindow = null;
}

/** Apakah jendela cetak sedang hidup (dipakai main.js saat memutuskan keluar). */
function hasPdfWindow() {
  return !!(pdfWindow && !pdfWindow.isDestroyed());
}

/**
 * Render HTML menjadi PDF memakai mesin cetak Chromium bawaan Electron.
 * Dimuat lewat berkas, bukan data: URL — Chromium menolak data: URL panjang
 * dan laporan sebulan penuh mudah melewati batasnya.
 */
async function htmlToPdf(html, filePath, { landscape = true } = {}) {
  pdfCounter += 1;
  const tempHtml = path.join(ensurePdfTempDir(), `laporan-${process.pid}-${pdfCounter}.html`);
  fs.writeFileSync(tempHtml, html, 'utf8');

  const win = getPdfWindow();
  await win.loadFile(tempHtml);
  const buffer = await win.webContents.printToPDF({
    landscape,
    printBackground: true,
    pageSize: 'A4',
    margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.35, right: 0.35 },
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return { filePath, bytes: buffer.length };
}

module.exports = {
  monthlyExcel,
  dailyExcel,
  logsExcel,
  monthlyPdfHtml,
  dailyPdfHtml,
  employeeCardPdfHtml,
  htmlToPdf,
  closePdfWindow,
  hasPdfWindow,
};
