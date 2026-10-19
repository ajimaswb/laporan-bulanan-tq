"""Jembatan untuk versi browser (GitHub Pages + Pyodide).

JavaScript (browser.js) mengurus login, Supabase, dan unduhan; modul ini hanya menghitung.
Semua fungsi menerima & mengembalikan string JSON agar mudah dipanggil dari JS.
"""
import copy
import datetime as dt
import json
from pathlib import Path

import inti
import laporan_bulanan as lb

TMP = Path("/tmp")
CONFIG = json.loads((lb.BASE / "config.json").read_text())
KEH = None
DIUNDUH = None


def _cfg(a: dict) -> dict:
    """Bangun cfg seperti baca_config(), dari data yang dikirim JS."""
    cfg = copy.deepcopy(CONFIG)
    cfg["copart"] = a["master"]["copart"]
    cfg["abaikan"] = a["master"]["abaikan"]
    sdo = a["sdo"]
    cfg["kode_implementer"] = sdo["kode"]
    cfg["nama_sdo"] = sdo.get("nama", "")
    cfg["mandays_copart"] = sdo.get("mandays_copart", [])
    cfg["koreksi"] = sdo.get("koreksi", {})
    cfg["ttd"] = a.get("ttd_path")
    cfg["template"] = a.get("template_path") or cfg["template"]
    return cfg


def _sdo_baru(cfg):
    return {"nama": cfg.get("nama_sdo", ""), "mandays_copart": cfg.get("mandays_copart", []),
            "koreksi": cfg.get("koreksi", {})}


def muat_kehadiran(path: str) -> str:
    global KEH, DIUNDUH
    KEH = lb.Kehadiran(Path(path))
    DIUNDUH = dt.datetime.now()
    return json.dumps({"ok": True})


def ambil(args: str) -> str:
    a = json.loads(args)
    cfg = _cfg(a)
    awal, akhir = inti.periode_dari(a, cfg)
    return json.dumps(inti.ke_json(cfg, lb.susun_laporan(cfg, KEH, awal, akhir), KEH, DIUNDUH))


def pratinjau(args: str) -> str:
    """-> {hasil, sdo_baru}; jika a['tulis'] juga menulis file .xlsx ke /tmp."""
    a = json.loads(args)
    cfg = _cfg(a)
    awal, akhir = inti.periode_dari(a, cfg)
    cfg2 = inti.terapkan_form(cfg, KEH, awal, akhir, a.get("form", {}))
    lap = lb.susun_laporan(cfg2, KEH, awal, akhir)
    hasil = inti.ke_json(cfg2, lap, KEH, DIUNDUH)
    if a.get("tulis"):
        out = TMP / "laporan.xlsx"
        lb.tulis_laporan(cfg2, awal, akhir, lap["baris"], lap["ringkas"], lap["mandays"], out)
        hasil["path"] = str(out)
    return json.dumps({"hasil": hasil, "sdo_baru": _sdo_baru(cfg2)})


def kandidat(args: str) -> str:
    a = json.loads(args)
    cfg = _cfg(a)
    awal, akhir = inti.periode_dari(a, cfg)
    return json.dumps({"kandidat": lb.deteksi_copart_baru(cfg, KEH, awal, akhir) if KEH else [],
                       "belum_lokasi": lb.belum_ada_lokasi(cfg),
                       "label": lb.label_periode(awal, akhir)})


def implementer(args: str) -> str:
    a = json.loads(args)
    awal, akhir = lb.hitung_periode(a.get("periode"), CONFIG["tanggal_cutoff"], dt.date.today())
    kode = []
    if KEH:
        for th, bl in sorted({(awal.year, awal.month), (akhir.year, akhir.month)}):
            kode += [k for k in KEH.implementer(th, bl) if k not in kode]
    return json.dumps(kode)


def periode_default() -> str:
    awal, akhir = lb.hitung_periode(None, CONFIG["tanggal_cutoff"], dt.date.today())
    return f"{akhir:%Y-%m}"


def kode_sdo(teks: str) -> str:
    return inti.kode_sdo(teks)


def olah_ttd(path_masuk: str, path_keluar: str) -> str:
    Path(path_keluar).write_bytes(inti.olah_ttd(Path(path_masuk).read_bytes()))
    return path_keluar


def master_ke_list(master: str) -> str:
    return json.dumps(inti.master_ke_list(json.loads(master)))


def master_dari_list(master: str, daftar: str) -> str:
    return json.dumps(inti.master_dari_list(json.loads(master), json.loads(daftar)))


def master_tambah(master: str, data: str) -> str:
    return json.dumps(inti.master_tambah(json.loads(master), json.loads(data)))


def master_abaikan(master: str, frasa: str, batal: bool) -> str:
    return json.dumps(inti.master_abaikan(json.loads(master), frasa, bool(batal)))
