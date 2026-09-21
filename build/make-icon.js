/**
 * Buat build/icon.ico tanpa dependensi grafis: gambar piksel dihitung manual,
 * dikemas sebagai PNG (zlib bawaan Node), lalu dibungkus jadi ICO multi-ukuran.
 *
 * Jalankan: node build/make-icon.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 64, 128, 256];

// ------------------------------------------------------------------- gambar

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

/** Anti-alias sederhana: 1 = penuh di dalam, 0 = di luar, di antaranya tepi. */
function coverage(dist, feather) {
  if (dist <= -feather) return 1;
  if (dist >= feather) return 0;
  return 0.5 - dist / (2 * feather);
}

function mix(dst, src, alpha) {
  return [
    dst[0] + (src[0] - dst[0]) * alpha,
    dst[1] + (src[1] - dst[1]) * alpha,
    dst[2] + (src[2] - dst[2]) * alpha,
    Math.max(dst[3], alpha),
  ];
}

/**
 * Ikon: kotak membulat bergradien biru, dengan jam (lingkaran + dua jarum)
 * sebagai lambang absensi.
 */
function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size;
  const feather = Math.max(0.6, s / 220);
  const radius = s * 0.22;
  const inset = s * 0.045;

  const cx = s / 2;
  const cy = s / 2;
  const dialR = s * 0.27;
  const ringW = Math.max(1.2, s * 0.045);

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = [0, 0, 0, 0];

      // --- kotak membulat (jarak bertanda ke tepi)
      const qx = Math.abs(px - cx) - (s / 2 - inset - radius);
      const qy = Math.abs(py - cy) - (s / 2 - inset - radius);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const boxDist = outside + Math.min(Math.max(qx, qy), 0) - radius;
      const boxA = coverage(boxDist, feather);

      if (boxA > 0) {
        // gradien diagonal biru -> indigo
        const t = (px + py) / (2 * s);
        const grad = [
          clamp(59 + (99 - 59) * t),
          clamp(130 + (102 - 130) * t),
          clamp(246 + (241 - 246) * t),
        ];
        color = mix(color, [...grad, 1], boxA);
      }

      // --- cincin jam putih
      const dr = Math.hypot(px - cx, py - cy);
      const ringDist = Math.abs(dr - dialR) - ringW / 2;
      const ringA = coverage(ringDist, feather) * boxA;
      if (ringA > 0) color = mix(color, [255, 255, 255, 1], ringA);

      // --- dua jarum jam (menunjuk 12 dan 4)
      const handA = Math.max(
        handCoverage(px, py, cx, cy, -Math.PI / 2, dialR * 0.62, ringW * 0.75, feather),
        handCoverage(px, py, cx, cy, Math.PI / 6, dialR * 0.46, ringW * 0.75, feather)
      ) * boxA;
      if (handA > 0) color = mix(color, [255, 255, 255, 1], handA);

      const o = (y * s + x) * 4;
      buf[o] = clamp(color[0]);
      buf[o + 1] = clamp(color[1]);
      buf[o + 2] = clamp(color[2]);
      buf[o + 3] = clamp(color[3] * 255);
    }
  }
  return buf;
}

/** Cakupan sebuah jarum: segmen garis dari pusat dengan ujung membulat. */
function handCoverage(px, py, cx, cy, angle, length, width, feather) {
  const ex = Math.cos(angle) * length;
  const ey = Math.sin(angle) * length;
  const vx = px - cx;
  const vy = py - cy;
  const len2 = ex * ex + ey * ey;
  let t = len2 ? (vx * ex + vy * ey) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dist = Math.hypot(vx - ex * t, vy - ey * t) - width / 2;
  return coverage(dist, feather);
}

// --------------------------------------------------------------------- PNG

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  // Tiap baris PNG diawali byte filter (0 = None).
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------- ICO

function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // tipe 1 = ikon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // 0 berarti 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // jumlah warna palet
    e[3] = 0;
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bit per piksel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// -------------------------------------------------------------------- main

const images = SIZES.map((size) => ({ size, data: toPng(renderRGBA(size), size) }));
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, toIco(images));
console.log(`icon.ico dibuat (${SIZES.join(', ')} px) — ${fs.statSync(out).size} byte`);
