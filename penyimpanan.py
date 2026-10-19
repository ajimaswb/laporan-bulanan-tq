"""Tempat menyimpan master copart, data SDO, dan tanda tangan.

- PenyimpananLokal   : file JSON + folder ttd/ (dipakai saat jalan di komputer sendiri)
- PenyimpananSupabase: database + storage Supabase, memakai token login SDO (dipakai saat online)

Keduanya punya fungsi yang sama sehingga laporan_bulanan.py tidak perlu tahu bedanya.
"""
import json
import os
import ssl
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent

def _cfg_supabase():
    try:
        return json.loads((BASE / "config.json").read_text()).get("supabase", {})
    except (OSError, ValueError):
        return {}


# Mode online: env LAPORAN_ONLINE=1 (alamat & publishable key dari config.json), atau SUPABASE_URL + SUPABASE_KEY.
_SB = _cfg_supabase() if os.environ.get("LAPORAN_ONLINE") == "1" else {}
SUPABASE_URL = os.environ.get("SUPABASE_URL", _SB.get("url", "")).rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", _SB.get("key", ""))  # publishable key (bukan rahasia)
ONLINE = bool(SUPABASE_URL and SUPABASE_KEY)

try:  # Python dari python.org di macOS tidak membawa sertifikat CA sendiri
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()


def email_sdo(kode: str) -> str:
    """Email sintetis akun Supabase (tidak pernah dikirimi email); sama dengan public.email_sdo()."""
    return f"{kode.lower()}@sdo.example.com"


# ---------------------------------------------------------------- lokal
class PenyimpananLokal:
    admin = True
    kode = None  # lokal: tidak ada login, semua SDO bisa dipilih

    def __init__(self, base: Path = BASE):
        self.master_file = base / "master_copart.json"
        self.sdo_file = base / "sdo.json"
        self.ttd_dir = base / "ttd"

    def baca_master(self) -> dict:
        m = json.loads(self.master_file.read_text()) if self.master_file.exists() else {}
        m.setdefault("copart", {})
        m.setdefault("abaikan", [])
        return m

    def simpan_master(self, master: dict):
        master = {"copart": dict(sorted(master["copart"].items())), "abaikan": sorted(set(master["abaikan"]))}
        self.master_file.write_text(json.dumps(master, indent=2, ensure_ascii=False) + "\n")

    def baca_sdo(self) -> dict:
        return json.loads(self.sdo_file.read_text()) if self.sdo_file.exists() else {}

    def simpan_sdo(self, kode: str, data: dict):
        semua = self.baca_sdo()
        semua[kode] = {**semua.get(kode, {}), **data}
        self.sdo_file.write_text(json.dumps(dict(sorted(semua.items())), indent=2, ensure_ascii=False) + "\n")

    def tambah_sdo(self, kode: str, nama: str = ""):
        if kode not in self.baca_sdo():
            self.simpan_sdo(kode, {"nama": nama, "mandays_copart": [], "koreksi": {}})
        elif nama:
            self.simpan_sdo(kode, {"nama": nama})

    def hapus_sdo(self, kode: str):
        semua = self.baca_sdo()
        semua.pop(kode, None)
        self.sdo_file.write_text(json.dumps(semua, indent=2, ensure_ascii=False) + "\n")
        self.simpan_ttd(kode, None)

    def ttd_bytes(self, kode: str):
        p = self.ttd_dir / f"{kode}.png"
        return p.read_bytes() if p.exists() else None

    def simpan_ttd(self, kode: str, png: bytes | None):
        p = self.ttd_dir / f"{kode}.png"
        if png is None:
            p.unlink(missing_ok=True)
        else:
            self.ttd_dir.mkdir(exist_ok=True)
            p.write_bytes(png)

    def ttd_path(self, kode: str):
        p = self.ttd_dir / f"{kode}.png"
        return str(p) if p.exists() else None


# ---------------------------------------------------------------- supabase
class GagalSupabase(Exception):
    def __init__(self, status, pesan):
        super().__init__(pesan)
        self.status = status


def _http(method, path, token=None, body=None, headers=None, mentah=False):
    url = f"{SUPABASE_URL}{path}"
    h = {"apikey": SUPABASE_KEY}
    if token:
        h["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
        else:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL) as r:
            isi = r.read()
    except urllib.error.HTTPError as e:
        isi = e.read().decode(errors="replace")
        try:
            j = json.loads(isi)
            pesan = j.get("message") or j.get("msg") or j.get("error_description") or j.get("error") or isi
        except ValueError:
            pesan = isi
        raise GagalSupabase(e.code, pesan) from None
    if mentah:
        return isi
    return json.loads(isi) if isi else None


def login(kode: str, password: str) -> dict:
    """-> {access_token, refresh_token, expires_in, user}"""
    try:
        return _http("POST", "/auth/v1/token?grant_type=password",
                     body={"email": email_sdo(kode), "password": password})
    except GagalSupabase as e:
        if e.status in (400, 401):
            raise GagalSupabase(401, "Kode SDO atau password salah.") from None
        raise


def perbarui_token(refresh_token: str) -> dict:
    return _http("POST", "/auth/v1/token?grant_type=refresh_token", body={"refresh_token": refresh_token})


def user_dari_token(token: str) -> dict:
    return _http("GET", "/auth/v1/user", token=token)


def ada_admin() -> bool:
    return bool(_http("POST", "/rest/v1/rpc/ada_admin", body={}))


def siapkan_admin(password: str) -> str:
    return _http("POST", "/rest/v1/rpc/siapkan_admin", body={"p_password": password})


def sehat() -> bool:
    """Ping ringan ke database (dipakai keep-alive agar project gratis tidak di-pause)."""
    return isinstance(ada_admin(), bool)


class PenyimpananSupabase:
    def __init__(self, token: str, user_id: str):
        self.token = token
        q = urllib.parse.quote
        rows = _http("GET", f"/rest/v1/sdo?select=kode,nama,admin&user_id=eq.{q(user_id)}", token)
        if not rows:
            raise GagalSupabase(403, "Akun ini belum terhubung ke SDO mana pun. Hubungi admin.")
        self.kode = rows[0]["kode"]
        self.nama = rows[0]["nama"]
        self.admin = rows[0]["admin"]
        self._ttd_cache = {}

    def _rest(self, method, path, body=None, headers=None):
        return _http(method, f"/rest/v1/{path}", self.token, body, headers)

    def rpc(self, fungsi, **arg):
        return self._rest("POST", f"rpc/{fungsi}", body=arg)

    # --- master
    def baca_master(self) -> dict:
        copart = {r["kode"]: r["data"] for r in self._rest("GET", "master_copart?select=kode,data&order=kode")}
        abaikan = [r["frasa"] for r in self._rest("GET", "copart_abaikan?select=frasa&order=frasa")]
        return {"copart": copart, "abaikan": abaikan}

    def simpan_master(self, master: dict):
        lama = self.baca_master()
        baru = master["copart"]
        if baru:
            self._rest("POST", "master_copart", [{"kode": k, "data": v} for k, v in baru.items()],
                       {"Prefer": "resolution=merge-duplicates,return=minimal"})
        for k in set(lama["copart"]) - set(baru):
            self._rest("DELETE", f"master_copart?kode=eq.{urllib.parse.quote(k)}")
        ab_baru, ab_lama = set(master["abaikan"]), set(lama["abaikan"])
        if ab_baru - ab_lama:
            self._rest("POST", "copart_abaikan", [{"frasa": f} for f in sorted(ab_baru - ab_lama)],
                       {"Prefer": "resolution=ignore-duplicates,return=minimal"})
        for f in ab_lama - ab_baru:
            self._rest("DELETE", f"copart_abaikan?frasa=eq.{urllib.parse.quote(f)}")

    # --- sdo
    def baca_sdo(self) -> dict:
        rows = self._rest("GET", "sdo?select=kode,nama,admin,user_id,mandays_copart,koreksi&order=kode")
        return {r["kode"]: {"nama": r["nama"], "admin": r["admin"], "punya_akun": bool(r["user_id"]),
                            "mandays_copart": r["mandays_copart"], "koreksi": r["koreksi"]} for r in rows}

    def simpan_sdo(self, kode: str, data: dict):
        isi = {k: v for k, v in data.items() if k in ("nama", "mandays_copart", "koreksi")}
        self._rest("PATCH", f"sdo?kode=eq.{urllib.parse.quote(kode)}", isi, {"Prefer": "return=minimal"})

    def tambah_sdo(self, kode: str, nama: str = ""):
        self._rest("POST", "sdo", {"kode": kode, "nama": nama},
                   {"Prefer": "resolution=ignore-duplicates,return=minimal"})
        if nama:
            self.simpan_sdo(kode, {"nama": nama})

    def hapus_sdo(self, kode: str):
        self.simpan_ttd(kode, None)
        self.rpc("hapus_sdo", p_kode=kode)

    def atur_akun(self, kode: str, password: str):
        self.rpc("atur_akun_sdo", p_kode=kode, p_password=password)

    def ganti_password(self, password: str):
        self.rpc("ganti_password_saya", p_password=password)

    # --- tanda tangan (bucket privat "ttd")
    def ttd_bytes(self, kode: str):
        if kode not in self._ttd_cache:
            try:
                self._ttd_cache[kode] = _http("GET", f"/storage/v1/object/authenticated/ttd/{kode}.png",
                                              self.token, mentah=True)
            except GagalSupabase as e:
                if e.status in (400, 404):
                    self._ttd_cache[kode] = None
                else:
                    raise
        return self._ttd_cache[kode]

    def simpan_ttd(self, kode: str, png: bytes | None):
        self._ttd_cache.pop(kode, None)
        if png is None:
            try:
                _http("DELETE", f"/storage/v1/object/ttd/{kode}.png", self.token)
            except GagalSupabase as e:
                if e.status not in (400, 404):
                    raise
            return
        _http("POST", f"/storage/v1/object/ttd/{kode}.png", self.token, png,
              {"Content-Type": "image/png", "x-upsert": "true", "Cache-Control": "no-cache"})

    def ttd_path(self, kode: str):
        data = self.ttd_bytes(kode)
        if not data:
            return None
        f = Path(tempfile.gettempdir()) / f"ttd_{kode}_{os.getpid()}.png"
        f.write_bytes(data)
        return str(f)
