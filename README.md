# Laporan Bulanan FM-SDD-008 otomatis

Membuat file `FM-SDD-008 Laporan Bulanan <SDO> (26 ... - 25 ...).xlsx` dari spreadsheet kehadiran (Google Sheets).
Bisa dipakai **online** di Cloudflare (semua SDO, login per SDO, data di D1) atau **lokal** di komputer sendiri.

## Versi online (Cloudflare)
Alamat: **https://laporan-bulanan-tq.aporan--ulanan.workers.dev/**
(alamat lama GitHub Pages otomatis dialihkan ke sini)

- `worker/worker.js` (Cloudflare Worker): login SDO, data di D1 `laporan-bulanan-tq`, spreadsheet kehadiran.
  File aplikasi (index.html, browser.js, *.py) dilayani dari folder ini; `.assetsignore` menjaga data & rahasia tidak ikut.
- Kode Python laporan berjalan **di browser** lewat Pyodide (pertama kali ±10–20 detik).
- Login: **kode SDO + password**. Admin (AJM) membuat/reset akun SDO di menu **Data SDO**.
- SDO biasa hanya melihat & mengubah laporan, nama, dan tanda tangannya sendiri; master copart hanya bisa dibaca.
- Tidak ada pause otomatis seperti Supabase gratis.

### Deploy
```bash
npx wrangler@4 login        # sekali saja
npx wrangler@4 deploy
```
Secret `SESSION_SECRET` sudah dipasang di Worker (`npx wrangler@4 secret put SESSION_SECRET` untuk mengganti).
Uji lokal: `npx wrangler@4 dev --local` lalu buka `http://localhost:8787/?browser=1` (butuh `.dev.vars`).

## Versi lokal
Klik dua kali `Laporan Bulanan.command` (atau `python3 gui.py`). Browser terbuka di `http://127.0.0.1:8765`.
Tanpa login; data di `sdo.json`, `master_copart.json`, `ttd/`, template di `template/template_FM-SDD-008.xlsx`
(file-file ini tidak ikut di repo).

Terminal:

```bash
python3 laporan_bulanan.py                    # periode berjalan (cutoff tgl 25)
python3 laporan_bulanan.py --periode 2026-11  # 26 Okt - 25 Nov 2026
python3 laporan_bulanan.py --sdo JNT          # SDO lain
```

## Alur
1. Unduh spreadsheet kehadiran (export xlsx) → ambil kolom kode SDO dari sheet bulan terkait.
2. Ambil semua hari kerja (Senin–Jumat) 26 bulan lalu s/d 25 bulan ini.
3. Teks kehadiran → Co-Part, Kegiatan, Keterangan (master copart + koreksi).
4. Isi template, sesuaikan jumlah baris, pasang nama & tanda tangan SDO, isi sheet *Laporan Mandays*.

## File
| File | Isi |
|---|---|
| `laporan_bulanan.py` | generator laporan (juga CLI) |
| `inti.py` | logika GUI bersama (lokal & browser) |
| `web.py` | jembatan Python ↔ JavaScript untuk versi browser |
| `browser.js` | versi online: Pyodide + login + Worker |
| `gui.py` | server versi lokal |
| `penyimpanan.py` | penyimpanan file lokal |
| `worker/worker.js` | server Cloudflare (login, D1, spreadsheet) |
| `index.html` | tampilan (dipakai versi lokal & online) |
| `config.json` | aturan global (absen, kata kegiatan, kota, cutoff, alamat Supabase) |

## Master copart
Tab **Master Copart**: kode, nama lengkap, kata kunci di spreadsheet, lokasi, standar, kategori.
- Nama di spreadsheet (semua implementer, periode terpilih) yang belum ada di master muncul sebagai **copart baru** → Tambah / Abaikan.
  Nama kota di teks (mis. "IAG PALEMBANG") dipakai sebagai saran lokasi.
- Copart tanpa lokasi dan copart baru → reminder + badge di halaman Laporan.
