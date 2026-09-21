# Absensi Karyawan

Aplikasi desktop Windows untuk manajemen absensi karyawan, shift, dan rekap,
terhubung langsung ke mesin fingerprint **Solution X105 / X401** melalui jaringan
LAN lokal.

Mesin Solution memakai protokol ZKTeco (port 4370). Aplikasi ini berbicara
protokol tersebut secara langsung — tidak perlu SDK, driver, atau software
bawaan mesin.

---

## Fitur

**Data master**
- Karyawan lengkap dengan PIN mesin, NIP, kartu RFID, hak akses mesin, departemen, jabatan, dan shift bawaan
- Import karyawan langsung dari daftar user yang sudah ada di mesin
- Kirim data karyawan dari aplikasi ke mesin (PIN, nama, kartu RFID, hak akses, password)
- Shift kerja: jam masuk/pulang, istirahat, toleransi telat, aturan lembur
- Shift malam lintas hari (mis. 22:00–06:00) ditangani dengan benar

**Jadwal**
- Jadwal mingguan bawaan (Senin–Jumat kerja, Sabtu–Minggu libur)
- Jadwal khusus per karyawan per tanggal, cukup klik selnya
- Pembuatan jadwal massal dari pola shift berulang (5 kerja + 2 libur, rotasi P-S-M, dll)
- **Shift bergilir** untuk satpam dan operator pabrik: satu pola dipakai semua regu, tiap regu digeser sehingga tidak ada shift yang kosong
- Hari libur nasional otomatis dijadikan libur saat membuat jadwal

**Sinkronisasi dengan mesin**
- Perbandingan dua arah: mana yang ada di mesin tapi belum di aplikasi, dan sebaliknya
- Deteksi perbedaan data (nama, kartu RFID, hak akses) beserta pilihan mana yang dipakai
- Kirim karyawan ke mesin, import dari mesin, atau hapus user dari mesin
- Salin sidik jari antar mesin
- Penanda karyawan yang belum punya sidik jari terdaftar

**Absensi**
- Tarik data manual dari satu atau semua mesin
- Auto-sync terjadwal di latar belakang
- Live capture realtime — scan langsung muncul di aplikasi begitu jari ditempel
- Dukungan banyak mesin sekaligus
- Anti duplikat: penarikan berulang tidak menggandakan data
- Scan manual untuk koreksi HRD (lupa absen, mesin error)

**Izin & cuti**
- Cuti, sakit, izin, dinas luar, cuti tanpa gaji (jenis bisa ditambah sendiri)
- Otomatis menimpa status Alpha di rekap
- Dinas luar dapat dihitung sebagai hadir

**Rekap & laporan**
- Rekap harian dan bulanan: hadir, telat, pulang cepat, lembur, alpha
- Rincian per karyawan (kartu absensi)
- Export Excel (dua sheet: ringkasan + detail harian)
- Cetak PDF berkop perusahaan lengkap dengan kolom tanda tangan

**Sistem**
- Database lokal SQLite — tidak perlu server
- Backup otomatis harian dengan batas jumlah penyimpanan
- Berkas backup diperiksa dulu sebelum dipulihkan, dan data lama selalu disalin sebagai pengaman

---

## Persyaratan

- Windows 10 atau lebih baru, 64-bit
- Komputer dan mesin absensi berada di **jaringan LAN yang sama**
- Mesin absensi Solution X105 / X401 (atau mesin ZKTeco lain yang sejenis)

---

## Instalasi

1. Jalankan `Absensi-Karyawan-Setup-1.0.0.exe`
2. Pilih folder instalasi, lalu tunggu sampai selesai
3. Jalankan aplikasi dari Start Menu atau ikon di desktop

Aplikasi tidak memerlukan hak administrator dan terpasang untuk pengguna saat ini.

---

## Persiapan Awal

### 1. Siapkan mesin absensi

Di mesin, buka **Menu → Komunikasi → Jaringan** dan catat:

| Yang dicatat | Contoh | Keterangan |
|---|---|---|
| Alamat IP | `192.168.1.201` | harus satu jaringan dengan komputer |
| Port | `4370` | bawaan Solution X105/X401 |
| Comm Key | `0` | isi `0` jika mesin tidak memakai kunci komunikasi |

Pastikan mesin bisa dihubungi dari komputer. Buka Command Prompt lalu jalankan:

```
ping 192.168.1.201
```

Bila tidak ada balasan, periksa kabel LAN, subnet, dan pengaturan IP mesin
sebelum melanjutkan.

### 2. Daftarkan mesin di aplikasi

**Mesin Absensi → + Tambah Mesin**, isi nama, IP, port, dan Comm Key.
Centang **Auto-sync** agar data ditarik otomatis, dan **Realtime** bila ingin
scan masuk seketika.

Tekan **Tes Koneksi** untuk memastikan mesin terbaca. Bila berhasil, akan muncul
model, firmware, serial number, jumlah user, dan jam mesin.

> Jika jam mesin berbeda jauh dengan jam komputer, tekan **Samakan Jam**.
> Jam yang meleset membuat perhitungan telat dan lembur ikut meleset.

### 3. Masukkan data karyawan

Cara tercepat: **Karyawan → Import dari Mesin**. Aplikasi mengambil daftar user
dari mesin dan membuat data karyawan untuk PIN yang belum terdaftar.

Yang terpenting: **PIN di aplikasi harus sama persis dengan User ID di mesin.**
Inilah yang menghubungkan scan jari dengan data karyawan.

### 4. Atur shift dan jadwal

- **Shift Kerja** — sesuaikan jam kerja, toleransi telat, dan aturan lembur
- **Shift Kerja → Jadwal Mingguan Bawaan** — tentukan hari kerja dan hari libur
- **Karyawan → Ubah → Shift Bawaan** — shift yang dipakai karyawan pada hari kerja
- **Jadwal Shift** — untuk pengecualian; klik sel mana pun untuk menggantinya

Urutan yang dipakai aplikasi saat menentukan shift seseorang pada suatu tanggal:

1. Jadwal khusus di halaman **Jadwal Shift** — selalu menang
2. **Jadwal mingguan** menentukan hari itu kerja atau libur
3. Pada hari kerja, dipakai **shift bawaan karyawan**; bila kosong, shift dari jadwal mingguan

Artinya karyawan bershift bawaan "Pagi" tetap libur pada Sabtu–Minggu selama
jadwal mingguan menandainya libur.

### 5. Isi hari libur nasional

**Pengaturan → Hari Libur Nasional.** Tanggal ini otomatis dijadikan libur saat
membuat jadwal massal dan berpengaruh pada status di rekap.

---

## Menyamakan Data Karyawan dengan Mesin

Buka halaman **Sinkron Karyawan**, pilih mesinnya, lalu tekan **Baca Ulang dari
Mesin**. Tampilannya dua tabel bersebelahan:

- **Kiri — Karyawan di Aplikasi**, dengan status hubungannya terhadap mesin
- **Kanan — Karyawan di Mesin**, dengan status hubungannya terhadap aplikasi

Baris yang sama muncul di kedua tabel, hanya sudut pandangnya yang berbeda.

### Arti Status

| Status | Artinya | Yang perlu dilakukan |
|---|---|---|
| **Sudah di mesin** / **Sudah di aplikasi** | Data sama persis di kedua sisi | Tidak ada |
| **Belum di mesin** | Karyawan sudah didaftar di aplikasi, tapi belum bisa absen | **Kirim ke Mesin →** (tabel kiri) |
| **Belum di aplikasi** | Ada user di mesin yang scannya tidak masuk rekap | **← Import** (tabel kanan) atau **Hapus** |
| **Diubah di aplikasi** | Datanya berbeda, dan yang berubah adalah sisi aplikasi | **Kirim ke Mesin →** untuk menyusulkan perubahannya |
| **Diubah di mesin** | Datanya berbeda, dan yang berubah adalah sisi mesin | **← Ambil Data** untuk mengikuti mesin |
| **Bentrok** | Kedua sisi berubah sejak terakhir sama | Putuskan mana yang benar, lalu kirim atau ambil |
| **Berbeda** | Datanya beda, tapi belum ada catatan riwayat sehingga asalnya tak diketahui | Pilih salah satu sisi; setelah itu perubahan berikutnya bisa dilacak |

Di bawah nama akan tertulis kolom mana yang berbeda, misalnya `beda: kartu RFID`.

Aplikasi bisa membedakan "diubah di aplikasi" dari "diubah di mesin" karena ia
mencatat kondisi terakhir yang sama di kedua sisi. Sisi yang menyimpang dari
catatan itulah yang berubah. Catatan ini dibuat otomatis saat data terkirim ke
mesin, saat data diambil dari mesin, dan saat pembacaan menemukan keduanya
kebetulan sudah sama.

Setiap tabel punya penyaring status sendiri — pilih **Perlu tindakan** untuk
menyembunyikan baris yang sudah beres.

Yang ikut terkirim saat "Kirim ke Mesin": PIN, nama, nomor kartu RFID, hak
akses, dan password mesin.

### Soal Sidik Jari

**Sidik jari tidak bisa didaftarkan dari komputer.** Perekaman sidik jari harus
dilakukan langsung di mesin lewat sensornya — tidak ada perangkat lunak mana pun
yang bisa membuat template sidik jari dari PC.

Yang bisa dilakukan aplikasi ini:

- **Melihat** siapa saja yang sudah punya sidik jari terdaftar di tiap mesin
- **Menyalin** sidik jari dari satu mesin ke mesin lain (**Sinkron Karyawan →
  Salin Sidik Jari**)

Jadi untuk kantor dengan beberapa mesin, alurnya:

1. Daftarkan karyawan di aplikasi, kirim ke **satu** mesin utama
2. Karyawan merekam sidik jari sekali saja di mesin utama itu
3. Salin sidik jari dari mesin utama ke mesin-mesin lain

Dengan begitu karyawan tidak perlu mengantre merekam jari di setiap mesin.

> Template sidik jari hanya bisa disalin antar mesin dengan algoritma yang sama.
> Menyalin dari mesin ZK9 ke ZK10 (atau sebaliknya) tidak akan dikenali.

---

## Shift Bergilir (Satpam, Operator Pabrik)

**Jadwal Shift → Buat Jadwal Massal.** Susun pola untuk satu siklus, lalu
centang **"Setiap karyawan mulai dari titik pola yang berbeda"**.

Contoh untuk penjagaan 24 jam:

- Pola: Hari 1 Pagi, Hari 2 Siang, Hari 3 Malam, Hari 4 Libur
- Pilih **4 orang**, centang shift bergilir

Hasilnya tiap hari selalu ada satu orang di Pagi, satu di Siang, satu di Malam,
dan satu libur — bergilir terus sepanjang tahun.

> Jumlah regu harus sama dengan panjang pola. Pola 4 langkah dengan hanya 3 regu
> akan menyisakan satu shift kosong setiap hari.

Untuk pola yang lebih panjang (mis. 2 pagi, 2 siang, 2 malam, 2 libur = 8 hari),
gunakan 8 regu, atau kelompokkan: jalankan generator beberapa kali, masing-masing
untuk satu regu dengan **"Geser titik awal pola"** yang berbeda.

---

## Pemakaian Sehari-hari

| Kebutuhan | Langkah |
|---|---|
| Ambil data absensi | **Dashboard → Tarik Data Semua Mesin** (atau biarkan auto-sync bekerja) |
| Lihat siapa telat hari ini | **Dashboard → Perlu Perhatian** |
| Input izin/cuti | **Izin & Cuti → + Tambah** |
| Koreksi lupa absen | **Log Scan → + Scan Manual** |
| Rekap akhir bulan | **Rekap Absensi → Rekap Bulanan → Export Excel / Cetak PDF** |
| Karyawan baru masuk | Daftarkan di **Karyawan**, lalu **Sinkron Karyawan → Kirim ke Mesin**, lalu rekam jarinya di mesin |
| Karyawan keluar | Nonaktifkan di **Karyawan**, lalu **Sinkron Karyawan → Hapus dari Mesin** |
| Kartu absensi 1 orang | **Karyawan → Kartu**, atau **Rekap → Rincian → Cetak Kartu PDF** |

---

## Status dalam Rekap

| Kode | Arti |
|---|---|
| Hadir | Scan masuk dan pulang lengkap, tidak melewati toleransi telat |
| Terlambat | Scan lengkap, tetapi masuk melewati toleransi |
| Tidak Lengkap | Hanya ada satu scan — lupa absen pulang atau lupa absen masuk |
| Alpha | Dijadwalkan kerja, tidak ada scan, dan tidak ada izin |
| Libur | Jadwalnya libur |
| Libur Nasional | Tanggal terdaftar sebagai hari libur |
| Cuti / Sakit / Izin / Dinas Luar | Sesuai data di halaman Izin & Cuti |
| Belum | Tanggal belum tiba |

---

## Bila Mesin Tidak Bisa Dihubungi

Tekan tombol **Diagnosa** pada kartu mesin (juga ditawarkan otomatis ketika Tes
Koneksi gagal). Aplikasi memindai port mesin, menguji apakah yang menjawab
benar-benar mesin absensi, lalu menyusun langkah perbaikannya.

### Cara melihat IP, port, dan Comm Key di mesin Solution X401

1. Tekan **M/OK** pada mesin untuk membuka menu
2. Pilih **Komunikasi** (pada sebagian firmware tertulis *Comm.*)
3. Pilih **Jaringan** (*Ethernet*) — di sini terlihat:
   - **Alamat IP** — mis. `192.168.1.201`
   - **Subnet Mask** — biasanya `255.255.255.0`
   - **Port TCP** (*TCP COMM Port*) — bawaannya **4370**
4. Kembali ke **Komunikasi**, pilih **Koneksi PC** (*PC Connection / Comm Key*):
   - **Kunci Komunikasi** (*Comm Key*) — bila nilainya bukan 0, isikan angka itu
     di kolom Comm Key aplikasi. Kalau tidak, koneksi akan selalu ditolak.

### Pesan galat dan artinya

| Pesan | Penyebab & solusi |
|---|---|
| *Timeout menghubungi …* | Mesin mati, IP salah, atau beda jaringan. Uji dengan `ping`. |
| *… menolak koneksi* | Port salah. Jalankan **Diagnosa** — aplikasi akan memberi tahu port yang benar. |
| *… tidak terjangkau* | Komputer dan mesin beda subnet. Samakan tiga angka pertama alamat IP-nya. |
| *Comm Key mesin salah* | Isi Comm Key sesuai **Komunikasi → Kunci Komunikasi** di mesin. |

### Memastikan jaringannya benar

Buka Command Prompt di komputer, lalu:

```
ipconfig
ping 192.168.1.201
```

`ipconfig` menampilkan alamat IP komputer. Tiga angka pertamanya harus sama
dengan alamat IP mesin. Contoh: komputer `192.168.1.10` dan mesin
`192.168.1.201` berada di jaringan yang sama; tetapi mesin `192.168.**0**.201`
tidak akan pernah terjangkau.

Bila `ping` tidak dibalas, masalahnya ada di jaringan — bukan di aplikasi.
Periksa kabel LAN, lampu indikator port switch, dan pengaturan IP di mesin.

Bila realtime sering terputus, aplikasi menyambung ulang sendiri dengan jeda
bertambah. Untuk jaringan yang kurang stabil, matikan realtime dan andalkan
auto-sync saja.

### Scan ada di mesin tapi tidak muncul di rekap

Kemungkinan besar PIN karyawan belum terdaftar. Buka **Log Scan → PIN Belum
Terdaftar** untuk melihat PIN yang menggantung, lalu buat karyawan dengan PIN
yang sama. Log lama akan langsung tersambung.

### Daftar user mesin masih kosong

Data user tidak ditarik otomatis. Buka **Sinkron Karyawan**, pilih mesinnya,
lalu tekan **Baca Ulang dari Mesin** — atau **Sinkron User** pada kartu mesin.
Keduanya baru bisa bekerja setelah koneksi berhasil.

---

## Backup & Pemulihan Data

Database disimpan di:

```
%APPDATA%Absensi Karyawandataabsensi.db
```

Semua pengelolaan backup ada di **Pengaturan → Backup & Pemulihan Data**.

### Backup otomatis

Aktif secara bawaan. Aplikasi membuat satu backup per hari saat dipakai, dan
menyimpan 14 backup otomatis terakhir — yang paling lama dibuang sendiri.
Jumlahnya bisa diubah.

Backup **manual** dan **salinan pengaman** tidak pernah dihapus otomatis, karena
keduanya lahir dari keputusan Anda, bukan dari penjadwal.

### Backup manual

| Tombol | Gunanya |
|---|---|
| **Backup Sekarang** | Simpan ke folder backup, sekali klik |
| **Simpan ke Lokasi Lain...** | Simpan ke folder pilihan sendiri, mis. flashdisk |
| **Pilih Folder...** | Pindahkan folder backup, mis. ke drive lain atau folder yang tersinkron ke cloud |

Tersedia juga di menu **Berkas**.

> Backup tersimpan di komputer yang sama dengan datanya. Agar benar-benar aman
> dari kerusakan hard disk, arahkan folder backup ke drive lain, atau sesekali
> salin hasilnya ke flashdisk lewat "Simpan ke Lokasi Lain".

### Memulihkan data

Tekan **Pulihkan** pada baris backup, atau **Pulihkan dari Berkas...** untuk
mengambil dari lokasi lain. Sebelum apa pun ditimpa, aplikasi:

1. **Memeriksa berkasnya** — memastikan itu benar database SQLite yang utuh dan
   memang milik aplikasi ini. Berkas yang salah ditolak, dan data Anda tidak
   tersentuh sama sekali.
2. **Menampilkan isinya** — jumlah karyawan, jumlah log, dan rentang tanggalnya,
   supaya Anda tahu persis apa yang akan dipulihkan.
3. **Membuat salinan pengaman** dari data yang sedang dipakai, dengan nama
   berawalan `sebelum-pulih-`.

Aplikasi menutup dan membuka diri sendiri setelah pemulihan selesai.

Kalau ternyata backup yang dipulihkan bukan yang Anda maksud, pulihkan lagi dari
berkas `sebelum-pulih-...` untuk kembali ke keadaan sebelumnya.

Menghapus aplikasi (uninstall) **tidak** menghapus database maupun backup.

---

## Untuk Pengembang

```bash
npm install          # pasang dependensi + rebuild native module untuk Electron
npm start            # jalankan aplikasi
npm run dev          # jalankan dengan DevTools terbuka
npm test             # uji protokol + uji fungsional
npm run test:ui      # buka tiap halaman dan simpan tangkapan layar
npm run dist         # bangun installer Windows ke folder dist/
npm run icon         # buat ulang build/icon.ico
```

### Struktur

```
src/main/            proses utama Electron
  zk/                implementasi protokol ZKTeco
    const.js         kode perintah dan flag
    packet.js        checksum, framing, encoding waktu, comm key
    client.js        klien TCP/UDP: connect, tarik data, live capture
    manager.js       orkestrasi banyak mesin, auto-sync, sambung ulang
  db/                skema SQLite dan inisialisasi
  services/          logika bisnis (karyawan, shift, jadwal, rekap, ekspor)
  ipc.js             daftar fungsi yang boleh dipanggil dari halaman
src/renderer/        antarmuka (HTML/CSS/JS biasa, tanpa proses build)
test/                uji protokol (dengan mesin tiruan), uji fungsional, uji UI
```

### Catatan implementasi

Beberapa hal sengaja dibuat "tidak rapi" karena mengikuti perilaku perangkat asli
atau keterbatasan Electron. Semuanya diberi komentar di tempatnya:

- **`packet.js`** — checksum dihitung memakai `replyId` lama, lalu `replyId`
  dinaikkan dan ditulis ulang ke paket. Terlihat seperti bug, tapi persis inilah
  yang dilakukan pyzk dan node-zklib, dua implementasi yang terbukti jalan di
  perangkat asli.
- **`exporter.js`** — satu jendela cetak tersembunyi dipakai ulang untuk semua
  ekspor PDF. Membuat lalu membuang BrowserWindow tiap ekspor membuat ekspor
  kedua gagal dan bisa mematikan proses pada dokumen besar. Direktori HTML
  sementara juga tidak dihapus saat aplikasi berjalan, karena penghapusannya
  merusak pemuatan jendela berikutnya.
- **`main.js`** — jendela cetak wajib ditutup saat jendela utama ditutup, kalau
  tidak `window-all-closed` tidak pernah terpicu dan aplikasi menggantung.

Protokol diuji terhadap mesin tiruan di `test/mock-device.js` yang meniru dua
pola transfer data firmware asli: `CMD_PREPARE_DATA` + rentetan `CMD_DATA`
(daftar user), dan `CMD_ACK_OK` berisi ukuran lalu ditarik per potongan lewat
`CMD_DATA_RDY` (log absensi).

---

## Hak Cipta

Hak Cipta © 2026 **Adi Mulya Suprayogi**. Seluruh hak dilindungi.
