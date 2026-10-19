#!/usr/bin/env python3
"""GUI Laporan Bulanan FM-SDD-008.

Lokal : python3 gui.py   (browser terbuka otomatis di http://127.0.0.1:8765, data di file JSON)
Online: set SUPABASE_URL + SUPABASE_KEY (+ PORT) -> login per SDO, data di Supabase.
"""
import datetime as dt
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import inti
import laporan_bulanan as lb
import penyimpanan as pn

ONLINE = pn.ONLINE
PORT = int(os.environ.get("PORT", 8765))
HOST = "0.0.0.0" if ONLINE else "127.0.0.1"
HTML = Path(__file__).resolve().parent / "index.html"
MAKS_BODY = 6 * 1024 * 1024


class Ditolak(Exception):
    def __init__(self, status, pesan):
        super().__init__(pesan)
        self.status = status


class Sesi:
    """Spreadsheet kehadiran (data publik) di-cache bersama agar edit terasa cepat."""

    def __init__(self):
        self.keh = None
        self.diunduh = None
        self.tmp = tempfile.mkdtemp(prefix="laporan_")
        self.kunci = threading.Lock()

    def kehadiran(self, cfg, muat_ulang=False):
        with self.kunci:
            umur = time.time() - self.diunduh.timestamp() if self.diunduh else None
            if self.keh is None or muat_ulang or (ONLINE and umur > 3600):
                self.keh = lb.muat_kehadiran(cfg, folder_tmp=self.tmp)
                self.diunduh = dt.datetime.now()
            return self.keh


SESI = Sesi()
UNDUHAN = {}       # id -> (bytes, nama_file, pemilik, kedaluwarsa)
TOKEN_OK = {}      # access_token -> (user_id, berlaku_sampai)  cache validasi
GAGAL_LOGIN = {}   # ip -> [waktu gagal]


# ---------------------------------------------------------------- logika laporan
def daftar_sdo(st):
    return [{"kode": k, "nama": v.get("nama", ""), "ttd": bool(st.ttd_bytes(k)),
             "akun": v.get("punya_akun", True), "admin": v.get("admin", False),
             "jumlah_copart": len(v.get("mandays_copart", []))} for k, v in st.baca_sdo().items()]


def simpan_master_dari_list(st, daftar):
    master = inti.master_dari_list(st.baca_master(), daftar)
    st.simpan_master(master)
    return master


def wajib_admin(st):
    if not st.admin:
        raise Ditolak(403, "Hanya admin yang boleh melakukan ini.")


def sdo_untuk(st, diminta):
    """SDO biasa selalu memakai kodenya sendiri; admin / mode lokal boleh memilih."""
    if ONLINE and not st.admin:
        return st.kode
    return inti.kode_sdo(diminta) if diminta else None


def simpan_unduhan(isi: bytes, nama: str, pemilik: str) -> str:
    sekarang = time.time()
    for k in [k for k, v in UNDUHAN.items() if v[3] < sekarang]:
        UNDUHAN.pop(k, None)
    kunci = secrets.token_urlsafe(16)
    UNDUHAN[kunci] = (isi, nama, pemilik, sekarang + 600)
    return kunci


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # --- util
    def kirim(self, kode, isi, tipe="application/json", header=None):
        data = isi if isinstance(isi, bytes) else json.dumps(isi, ensure_ascii=False).encode()
        self.send_response(kode)
        self.send_header("Content-Type", f"{tipe}; charset=utf-8" if tipe.startswith(("text", "application/json")) else tipe)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        for c in getattr(self, "_cookie", []):
            self.send_header("Set-Cookie", c)
        for k, v in (header or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def cookie(self, nama):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return c[nama].value if nama in c else None

    def set_cookie(self, nama, nilai, umur):
        aman = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        self._cookie = getattr(self, "_cookie", []) + [
            f"{nama}={nilai}; Path=/; Max-Age={umur}; HttpOnly; SameSite=Lax{aman}"]

    def simpan_sesi_login(self, sesi):
        self.set_cookie("lt_at", sesi["access_token"], 60 * 60 * 24 * 30)
        self.set_cookie("lt_rt", sesi["refresh_token"], 60 * 60 * 24 * 30)

    def ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    # --- autentikasi
    def penyimpanan(self):
        """-> objek penyimpanan milik pengguna yang login (atau lokal)."""
        if not ONLINE:
            return pn.PenyimpananLokal(lb.BASE)
        at = self.cookie("lt_at")
        if not at:
            raise Ditolak(401, "Silakan login.")
        cache = TOKEN_OK.get(at)
        if cache and cache[1] > time.time():
            user_id = cache[0]
        else:
            try:
                user_id = pn.user_dari_token(at)["id"]
            except pn.GagalSupabase as e:
                if e.status not in (401, 403) or not self.cookie("lt_rt"):
                    raise Ditolak(401, "Sesi berakhir, silakan login lagi.") from None
                try:
                    sesi = pn.perbarui_token(self.cookie("lt_rt"))
                except pn.GagalSupabase:
                    raise Ditolak(401, "Sesi berakhir, silakan login lagi.") from None
                self.simpan_sesi_login(sesi)
                at, user_id = sesi["access_token"], sesi["user"]["id"]
            TOKEN_OK[at] = (user_id, time.time() + 60)
        return pn.PenyimpananSupabase(at, user_id)

    def batasi_login(self):
        sekarang = time.time()
        daftar = [t for t in GAGAL_LOGIN.get(self.ip(), []) if sekarang - t < 300]
        GAGAL_LOGIN[self.ip()] = daftar
        if len(daftar) >= 8:
            raise Ditolak(429, "Terlalu banyak percobaan login. Coba lagi 5 menit lagi.")

    # --- GET
    def do_GET(self):
        try:
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if url.path in ("/", "/index.html"):
                return self.kirim(200, HTML.read_bytes(), "text/html")
            if url.path == "/api/sehat":
                return self.kirim(200, {"ok": pn.sehat() if ONLINE else True})
            if url.path == "/api/status":
                return self.kirim(200, self.status())

            st = self.penyimpanan()
            m = re.fullmatch(r"/ttd/([A-Z0-9]+)\.png", url.path)
            if m:
                kode = m.group(1)
                if ONLINE and not st.admin and kode != st.kode:
                    raise Ditolak(403, "Tidak diizinkan.")
                png = st.ttd_bytes(kode)
                return self.kirim(200, png, "image/png") if png else self.kirim(404, {"error": "tidak ada"})

            m = re.fullmatch(r"/api/unduh/([\w-]+)", url.path)
            if m:
                isi = UNDUHAN.get(m.group(1))
                if not isi or (ONLINE and isi[2] != st.kode and not st.admin):
                    raise Ditolak(404, "File sudah kedaluwarsa, buat ulang laporannya.")
                return self.kirim(200, isi[0], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                  {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(isi[1])}"})

            if url.path == "/api/awal":
                semua = st.baca_sdo()
                diminta = q.get("sdo") if q.get("sdo") in semua else None
                cfg = lb.baca_config(sdo=sdo_untuk(st, diminta), store=st)
                awal, akhir = inti.periode_dari({}, cfg)
                return self.kirim(200, {
                    "kode": cfg["kode_implementer"],
                    "sdo": daftar_sdo(st) if (st.admin or not ONLINE) else
                           [{"kode": st.kode, "nama": st.nama}],
                    "periode": f"{akhir:%Y-%m}",
                    "folder_output": "" if ONLINE else str(lb.folder_output(cfg)),
                    "copart": sorted(cfg["copart"]),
                    "lokasi": {"-": "-", **{k: c.get("lokasi") or "" for k, c in cfg["copart"].items()}},
                })
            self.kirim(404, {"error": "tidak ditemukan"})
        except Ditolak as e:
            self.kirim(e.status, {"error": str(e)})
        except pn.GagalSupabase as e:
            self.kirim(502 if e.status >= 500 else 400, {"error": str(e)})
        except Exception as e:
            self.kirim(500, {"error": f"{type(e).__name__}: {e}"})

    def status(self):
        hasil = {"online": ONLINE, "login": None}
        if not ONLINE:
            hasil["login"] = {"kode": None, "nama": "", "admin": True}
            return hasil
        try:
            st = self.penyimpanan()
            hasil["login"] = {"kode": st.kode, "nama": st.nama, "admin": st.admin}
        except (Ditolak, pn.GagalSupabase):
            hasil["perlu_admin_awal"] = not pn.ada_admin()
        return hasil

    # --- POST
    def do_POST(self):
        try:
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                raise Ditolak(415, "Content-Type harus application/json.")
            panjang = int(self.headers.get("Content-Length") or 0)
            if panjang > MAKS_BODY:
                raise Ditolak(413, "Data terlalu besar (maks 6 MB).")
            data = json.loads(self.rfile.read(panjang) or b"{}")
            self.tangani(data)
        except Ditolak as e:
            self.kirim(e.status, {"error": str(e)})
        except pn.GagalSupabase as e:
            self.kirim(e.status if e.status in (401, 403) else 400, {"error": str(e)})
        except Exception as e:  # tampilkan error di GUI, bukan diam-diam gagal
            self.kirim(500, {"error": f"{type(e).__name__}: {e}"})

    def tangani(self, data):
        p = self.path

        # --- tanpa login
        if p == "/api/login":
            if not ONLINE:
                return self.kirim(200, {"ok": True})
            self.batasi_login()
            try:
                sesi = pn.login(inti.kode_sdo(data.get("kode")), data.get("password") or "")
            except (pn.GagalSupabase, ValueError):
                GAGAL_LOGIN.setdefault(self.ip(), []).append(time.time())
                raise Ditolak(401, "Kode SDO atau password salah.") from None
            self.simpan_sesi_login(sesi)
            return self.kirim(200, {"ok": True})
        if p == "/api/logout":
            self.set_cookie("lt_at", "", 0)
            self.set_cookie("lt_rt", "", 0)
            return self.kirim(200, {"ok": True})
        if p == "/api/siapkan_admin":
            if not ONLINE or pn.ada_admin():
                raise Ditolak(400, "Admin sudah ada.")
            pw = data.get("password") or ""
            if len(pw) < 8:
                raise Ditolak(400, "Password minimal 8 karakter.")
            kode = pn.siapkan_admin(pw)
            self.simpan_sesi_login(pn.login(kode, pw))
            return self.kirim(200, {"ok": True, "kode": kode})

        st = self.penyimpanan()
        cfg = lb.baca_config(sdo=sdo_untuk(st, data.get("sdo")), store=st)

        # --- laporan
        if p == "/api/ambil":
            keh = SESI.kehadiran(cfg, muat_ulang=data.get("muat_ulang", False))
            awal, akhir = inti.periode_dari(data, cfg)
            return self.kirim(200, inti.ke_json(cfg, lb.susun_laporan(cfg, keh, awal, akhir), SESI.keh, SESI.diunduh))

        if p in ("/api/pratinjau", "/api/buat"):
            keh = SESI.kehadiran(cfg)
            awal, akhir = inti.periode_dari(data, cfg)
            cfg2 = inti.terapkan_form(cfg, keh, awal, akhir, data, boleh_folder=not ONLINE)
            lap = lb.susun_laporan(cfg2, keh, awal, akhir)
            hasil = inti.ke_json(cfg2, lap, SESI.keh, SESI.diunduh)
            if p == "/api/buat":
                lb.simpan_config(cfg2, store=st)
                nama = lb.nama_file(cfg2, awal, akhir)
                if ONLINE:
                    out = Path(SESI.tmp) / f"{secrets.token_hex(8)}.xlsx"
                else:
                    out = lb.folder_output(cfg2) / nama
                lb.tulis_laporan(cfg2, awal, akhir, lap["baris"], lap["ringkas"], lap["mandays"], out)
                isi = out.read_bytes()
                if ONLINE:
                    out.unlink(missing_ok=True)
                else:
                    hasil["file"] = str(out)
                hasil["unduh"] = f"/api/unduh/{simpan_unduhan(isi, nama, cfg2['kode_implementer'])}"
                hasil["nama_file"] = nama
            return self.kirim(200, hasil)

        if p == "/api/buka":
            if ONLINE:
                raise Ditolak(400, "Tidak tersedia di versi online.")
            out = lb.folder_output(cfg) / lb.nama_file(cfg, *inti.periode_dari(data, cfg))
            if not out.exists():
                raise Ditolak(400, "Belum ada file yang dibuat.")
            subprocess.run(["open", "-R", str(out)] if data.get("finder") else ["open", str(out)])
            return self.kirim(200, {"ok": True})

        # --- akun
        if p == "/api/ganti_password":
            if not ONLINE:
                raise Ditolak(400, "Tidak ada login di versi lokal.")
            st.ganti_password(data.get("password") or "")
            return self.kirim(200, {"ok": True})

        # --- master copart (baca: semua SDO, tulis: admin)
        if p == "/api/master":
            master = st.baca_master()
            return self.kirim(200, {"copart": inti.master_ke_list(master), "abaikan": master["abaikan"],
                                    "boleh_ubah": bool(st.admin)})

        if p == "/api/master/kandidat":
            keh = SESI.kehadiran(cfg)
            awal, akhir = inti.periode_dari(data, cfg)
            return self.kirim(200, {"kandidat": lb.deteksi_copart_baru(cfg, keh, awal, akhir),
                                    "belum_lokasi": lb.belum_ada_lokasi(cfg),
                                    "label": lb.label_periode(awal, akhir)})

        if p == "/api/master/simpan":
            wajib_admin(st)
            master = simpan_master_dari_list(st, data["copart"])
            return self.kirim(200, {"copart": inti.master_ke_list(master), "abaikan": master["abaikan"]})

        if p == "/api/master/tambah":
            wajib_admin(st)
            st.simpan_master(inti.master_tambah(st.baca_master(), data))
            return self.kirim(200, {"ok": True})

        if p == "/api/master/abaikan":
            wajib_admin(st)
            st.simpan_master(inti.master_abaikan(st.baca_master(), data.get("frasa"), data.get("batal")))
            return self.kirim(200, {"ok": True})

        # --- data SDO
        if p == "/api/sdo":
            ada = st.baca_sdo()
            di_sheet = []
            if st.admin and SESI.keh:
                awal, akhir = inti.periode_dari(data, cfg)
                for th, bl in sorted({(awal.year, awal.month), (akhir.year, akhir.month)}):
                    di_sheet += [k for k in SESI.keh.implementer(th, bl) if k not in ada and k not in di_sheet]
            return self.kirim(200, {"sdo": daftar_sdo(st), "belum_terdaftar": di_sheet,
                                    "admin": bool(st.admin), "online": ONLINE})

        if p == "/api/sdo/simpan":
            kode = inti.kode_sdo(data.get("kode"))
            if ONLINE and not st.admin and kode != st.kode:
                raise Ditolak(403, "Hanya boleh mengubah data sendiri.")
            if kode not in st.baca_sdo():
                wajib_admin(st)
                st.tambah_sdo(kode, (data.get("nama") or "").strip())
            elif "nama" in data:
                st.simpan_sdo(kode, {"nama": data["nama"].strip()})
            return self.kirim(200, {"sdo": daftar_sdo(st)})

        if p == "/api/sdo/hapus":
            wajib_admin(st)
            kode = inti.kode_sdo(data.get("kode"))
            if len(st.baca_sdo()) <= 1:
                raise ValueError("Minimal harus ada satu SDO.")
            st.hapus_sdo(kode)
            return self.kirim(200, {"sdo": daftar_sdo(st)})

        if p == "/api/sdo/akun":
            wajib_admin(st)
            if not ONLINE:
                raise Ditolak(400, "Akun hanya ada di versi online.")
            st.atur_akun(inti.kode_sdo(data.get("kode")), data.get("password") or "")
            return self.kirim(200, {"sdo": daftar_sdo(st)})

        if p == "/api/sdo/ttd":
            kode = inti.kode_sdo(data.get("kode"))
            if ONLINE and not st.admin and kode != st.kode:
                raise Ditolak(403, "Hanya boleh mengubah tanda tangan sendiri.")
            if kode not in st.baca_sdo():
                raise ValueError(f"SDO {kode} belum terdaftar.")
            st.simpan_ttd(kode, inti.olah_ttd(inti.dari_data_url(data["data"])) if data.get("data") else None)
            return self.kirim(200, {"sdo": daftar_sdo(st)})

        self.kirim(404, {"error": "tidak ditemukan"})


def main():
    server = None
    for p in range(PORT, PORT + (1 if ONLINE else 20)):
        try:
            server = ThreadingHTTPServer((HOST, p), Handler)
            break
        except OSError:
            continue
    if server is None:
        sys.exit("Tidak ada port kosong.")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"Laporan Bulanan ({'online/Supabase' if ONLINE else 'lokal'}) berjalan di {url}  (Ctrl+C untuk berhenti)",
          flush=True)
    if not ONLINE and "--no-browser" not in sys.argv:
        threading.Timer(0.5, webbrowser.open, args=[url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
