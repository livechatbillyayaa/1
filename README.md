# Live Chat Gabungan (YouTube + TikTok) - versi ringan

Satu halaman web, dua kolom: **YouTube di kiri, TikTok di kanan**, realtime.
Tanpa awalan YT/TT di depan nama, karena kolomnya sudah terpisah.

## Cara pakai

1. Install Node.js 18 atau lebih baru.
2. Sekali saja: `npm install`
3. Isi `config.json`:
   - `youtube.liveId` (11 karakter dari `youtube.com/watch?v=XXXXXXXXXXX`), atau `youtube.handle` (`@namachannel`), atau `youtube.channelId` (`UC...`)
   - `tiktok.username` (tanpa `@`)
4. Jalankan: `npm start`
   atau: `node server.js --yt ID_VIDEO_ATAU_@HANDLE --tt username_tiktok`
5. Buka `http://localhost:3000`

Live yang belum mulai atau terputus akan dicoba lagi otomatis tiap 15 detik.

## Moderasi komentar (admin)

Komentar YouTube dan TikTok **tidak langsung tampil**. Semuanya masuk antrean dulu, dan baru muncul di display setelah admin menekan **Approve**. Komentar yang di-**Reject** dibuang dan tidak akan tampil.

1. Isi password di `config.json`: `"admin": { "password": "PASSWORD_ANDA" }`.
   Jika dikosongkan, server membuat password acak setiap kali dijalankan dan menampilkannya di konsol.
   Alternatif: `node server.js --admin-pass PASSWORD` atau env `ADMIN_PASSWORD`.
2. Jalankan server, lalu buka **`http://localhost:3000/admin`** dan masuk dengan password tersebut.
3. Di halaman admin:
   - **Approve** / **Reject** di tiap komentar. Komentar tampil di display begitu di-approve.
   - **Approve semua** / **Reject semua** untuk memproses seluruh antrean sekaligus. Klik dua kali (konfirmasi) dalam 3 detik. Yang diproses hanya komentar yang terlihat saat klik pertama.
   - Komentar Super Chat ditandai kuning. Status koneksi dan jumlah penonton tampil di bagian atas.
   - Judul tab menampilkan jumlah komentar yang menunggu, jadi tetap terlihat saat tab di belakang.

Catatan:
- Halaman display (`/`, dipakai OBS) tetap terbuka tanpa password, tetapi hanya menerima komentar yang sudah di-approve.
- Jika tidak ada admin yang membuka `/admin`, display akan kosong karena tidak ada yang menyetujui komentar.
- Antrean maksimal 200 komentar (`admin.queueMax`). Jika penuh, komentar yang paling lama menunggu dibuang. Antrean hanya di memori, jadi hilang jika server dimatikan.
- Halaman admin hanya bisa dibuka dari komputer yang menjalankan server (`127.0.0.1`). Login salah 5 kali = dikunci 1 menit. Sesi login berlaku 12 jam.

## OBS

Tambah sumber **Browser**: `http://localhost:3000/?bg=transparent&size=28`

| Parameter | Fungsi |
|---|---|
| `bg=transparent` | Latar transparan, status disembunyikan |
| `size=28` | Ukuran huruf (px) |
| `max=100` | Jumlah pesan maksimal per kolom (default 100) |
| `status=0` | Sembunyikan judul kolom dan status (angka penonton tetap tampil) |
| `viewers=0` | Sembunyikan angka penonton |

Tes tanpa live: `http://localhost:3000/test?src=YT&name=Budi&text=halo` (`src=TT` untuk TikTok). Pesan uji masuk ke antrean admin dulu, lalu approve di `/admin` agar tampil di display.

## Jumlah penonton live

Angka 👁 di tiap kolom = penonton yang sedang menonton saat ini.

- **TikTok**: realtime dari event `roomUser`.
- **YouTube**: dicek tiap 20 detik. Tanpa pengaturan tambahan, dibaca dari halaman video. Lebih stabil: isi `youtube.apiKey` di `config.json` (YouTube Data API v3, gratis) atau jalankan dengan env `YT_KEY=...`.
- Tes tampilan: `http://localhost:3000/test-viewers?src=TT&n=250` (tanpa `n` = kosongkan).

## Milestone Socialbuzz

Tampil di bagian bawah halaman, sebagai widget milestone dari Socialbuzz.

1. Di dashboard Socialbuzz, buka pengaturan widget **Milestone** dan salin URL widget-nya (bersifat rahasia, jangan dibagikan).
2. Tempel di `config.json`: `"socialbuzz": { "milestoneUrl": "https://..." }` (atau `node server.js --ms URL`).
3. Parameter URL halaman: `ms=0` (sembunyikan), `msh=160` (tinggi px).

## Yang dibuat ringan

- Server hanya mendengarkan `127.0.0.1` (pakai `--host 0.0.0.0` jika perlu diakses perangkat lain).
- Library YouTube/TikTok hanya dimuat kalau dipakai.
- TikTok: riwayat chat awal dan info hadiah tidak diproses.
- Pesan dikirim dalam format ringkas, riwayat hanya 30 pesan, teks dipotong 300 karakter.
- Browser menggambar pesan sekali per frame, tanpa animasi, maksimal 100 pesan per kolom.
- Satu timer coba-ulang per platform dan satu ping untuk semua klien.

## Catatan

- Memakai library tidak resmi `youtube-chat` dan `tiktok-live-connector`. Jika TikTok berhenti bekerja, jalankan `npm update`.
- Hanya menampilkan chat masuk, tidak bisa membalas.
- `config.json` berisi API key YouTube dan URL milestone yang bersifat rahasia. Jangan dibagikan atau diunggah ke tempat publik.
