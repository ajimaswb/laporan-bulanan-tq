# Laporan Bulanan FM-SDD-008 otomatis

Membuat file `FM-SDD-008 Laporan Bulanan <SDO> (26 ... - 25 ...).xlsx` dari spreadsheet kehadiran (Google Sheets).
Bisa dipakai **online** di GitHub Pages (semua SDO, login per SDO, data di Supabase) atau **lokal** di komputer sendiri.

## Versi online (GitHub Pages)
Alamat: **https://ajimaswb.github.io/laporan-bulanan-tq/**

- Tidak ada server: kode Python (`laporan_bulanan.py`, `inti.py`, `web.py`) berjalan **di browser** lewat
  [Pyodide](https://pyodide.org). Pertama kali dibuka butuh ±10–20 detik untuk memuat Python; berikutnya lebih cepat.
- `browser.js` menggantikan server: login, data, dan unduhan langsung ke Supabase (project `laporan-bulanan-tq`).
- Spreadsheet kehadiran diambil lewat Supabase Edge Function `kehadiran` (Google memblokir unduhan langsung dari browser).
- Login: **kode SDO + password**. Admin (AJM) membuat akun SDO lain di tab **Data SDO** → *Buat akun* / *Reset password*.
- SDO biasa hanya melihat & mengubah laporan, nama, dan tanda tangannya sendiri; master copart hanya bisa dibaca.
- Admin mengelola master copart, daftar SDO, dan **template laporan** (upload sekali di tab Data SDO).
- Pertama kali setelah deploy: layar **Siapkan admin pertama** → buat password admin (AJM) → upload template & tanda tangan.
- `.github/workflows/keep-alive.yml` mem-ping Supabase tiap hari supaya project gratis tidak berhenti.

Hak akses dijaga Row Level Security di database. Data, tanda tangan, dan template **tidak** ada di repo ini.

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
| `browser.js` | versi browser: Pyodide + login + Supabase |
| `gui.py` | server versi lokal |
| `penyimpanan.py` | penyimpanan file lokal / Supabase |
| `index.html` | tampilan (dipakai versi lokal & online) |
| `config.json` | aturan global (absen, kata kegiatan, kota, cutoff, alamat Supabase) |

## Master copart
Tab **Master Copart**: kode, nama lengkap, kata kunci di spreadsheet, lokasi, standar, kategori.
- Nama di spreadsheet (semua implementer, periode terpilih) yang belum ada di master muncul sebagai **copart baru** → Tambah / Abaikan.
  Nama kota di teks (mis. "IAG PALEMBANG") dipakai sebagai saran lokasi.
- Copart tanpa lokasi dan copart baru → reminder + badge di halaman Laporan.
