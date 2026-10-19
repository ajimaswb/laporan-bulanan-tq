"""Logika GUI yang tidak bergantung pada server: dipakai gui.py (lokal) dan web.py (browser/Pyodide)."""
import base64
import copy
import datetime as dt
import re
from io import BytesIO
from pathlib import Path

from PIL import Image as PILImage

import laporan_bulanan as lb


def periode_dari(data, cfg):
    return lb.hitung_periode(data.get("periode"), cfg["tanggal_cutoff"], dt.date.today())


def terapkan_form(cfg, keh, awal, akhir, data, boleh_folder=False):
    """Gabungkan isian form ke salinan config; koreksi hanya disimpan jika beda dari hasil otomatis."""
    cfg2 = copy.deepcopy(cfg)
    if "mandays_copart" in data:
        cfg2["mandays_copart"] = data["mandays_copart"]
    folder = (data.get("folder_output") or "").strip()
    if boleh_folder and folder and Path(folder).expanduser() != lb.folder_output(cfg):
        cfg2["folder_output"] = folder
    if "baris" in data:
        auto = {b["tanggal"].isoformat(): b["auto"] for b in lb.susun_laporan(cfg2, keh, awal, akhir)["baris"]}
        koreksi = cfg2.setdefault("koreksi", {})
        for row in data["baris"]:
            tgl = row["tanggal"]
            if tgl not in auto:
                continue
            beda = {k: row[k].strip() for k in ("copart", "kegiatan", "ket")
                    if row.get(k) is not None and row[k].strip() != auto[tgl][k]}
            if beda:
                koreksi[tgl] = beda
            else:
                koreksi.pop(tgl, None)
    return cfg2


def reminder(cfg, awal, akhir, keh):
    baru = lb.deteksi_copart_baru(cfg, keh, awal, akhir) if keh else []
    kurang = [x for x, ada in (("nama", cfg.get("nama_sdo")), ("tanda tangan", cfg.get("ttd"))) if not ada]
    return {"belum_lokasi": lb.belum_ada_lokasi(cfg), "copart_baru": len(baru),
            "sdo": cfg["kode_implementer"], "sdo_kurang": kurang}


def ke_json(cfg, lap, keh, diunduh):
    return {
        "periode": f"{lap['akhir']:%Y-%m}",
        "label": lb.label_periode(lap["awal"], lap["akhir"]),
        "nama_file": lb.nama_file(cfg, lap["awal"], lap["akhir"]),
        "baris": [{
            "tanggal": b["tanggal"].isoformat(),
            "hari": lb.HARI_EN[b["tanggal"].weekday()],
            "teks": b["teks"],
            "copart": b["copart"], "kegiatan": b["kegiatan"], "ket": b["ket"],
            "auto": b["auto"], "ragu": b["ragu"], "kategori": b["kategori"],
        } for b in lap["baris"]],
        "ringkas": lap["ringkas"],
        "mandays": [{k: m.get(k) for k in ("kode", "kuota", "terpakai", "info", "mandays_terpakai",
                                            "progress_step", "laporan_singkat")} for m in lap["mandays"]],
        "peringatan": lap["peringatan"],
        "reminder": reminder(cfg, lap["awal"], lap["akhir"], keh),
        "diunduh": f"{diunduh:%d-%m-%Y %H:%M}" if diunduh else None,
    }


def kode_sdo(teks):
    kode = lb.norm(teks)
    if not re.fullmatch(r"[A-Z0-9]{2,8}", kode):
        raise ValueError("Kode SDO harus 2-8 huruf/angka, mis. AJM.")
    return kode


def olah_ttd(raw: bytes) -> bytes:
    """Tanda tangan -> PNG transparan (latar putih dibuang, tepi kosong dipotong)."""
    img = PILImage.open(BytesIO(raw)).convert("RGBA")
    img.thumbnail((1200, 1200))
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if r > 225 and g > 225 and b > 225:
                px[x, y] = (255, 255, 255, 0)
    kotak = img.getchannel("A").getbbox()
    if kotak:
        img = img.crop(kotak)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def dari_data_url(data_url: str) -> bytes:
    return base64.b64decode(data_url.split(",", 1)[-1])


FIELD_MASTER = ("nama", "kata_kunci", "lokasi", "standar", "kategori", "kegiatan_default")


def master_ke_list(master):
    return [{"kode": k, **{f: c.get(f, [] if f == "kata_kunci" else "") for f in FIELD_MASTER}}
            for k, c in master["copart"].items()]


def bersihkan(c):
    c = {k: (v.strip() if isinstance(v, str) else v) for k, v in c.items()}
    c["kata_kunci"] = sorted({lb.norm(x) for x in c.get("kata_kunci", []) if lb.norm(x)})
    if c.get("kategori") != "kantor":
        c.pop("kategori", None)
    for f in ("nama", "kegiatan_default", "standar"):
        if not c.get(f):
            c.pop(f, None)
    return c


def master_dari_list(master, daftar):
    """Tabel master dari GUI -> master baru; field lanjutan (kegiatan_khusus, dll.) dipertahankan."""
    lama = master["copart"]
    baru = {}
    for row in daftar:
        kode = lb.norm(row.get("kode"))
        if not kode:
            continue
        if kode in baru:
            raise ValueError(f"Kode {kode} dobel di master.")
        dasar = dict(lama.get(row.get("kode_asal") or kode, {}))
        dasar.update({f: row.get(f) for f in FIELD_MASTER if f in row})
        baru[kode] = bersihkan(dasar)
    return {"copart": baru, "abaikan": list(master["abaikan"])}


def master_tambah(master, data):
    kode = lb.norm(data.get("kode"))
    if not kode:
        raise ValueError("Kode copart wajib diisi.")
    master = copy.deepcopy(master)
    c = master["copart"].setdefault(kode, {"kata_kunci": []})
    c["kata_kunci"] = list(c.get("kata_kunci", [])) + [data.get("frasa") or kode]
    for f in ("lokasi", "standar", "nama"):
        if data.get(f) and not c.get(f):
            c[f] = data[f]
    master["copart"][kode] = bersihkan(c)
    return master


def master_abaikan(master, frasa, batal=False):
    master = copy.deepcopy(master)
    frasa = lb.norm(frasa)
    if batal:
        master["abaikan"] = [a for a in master["abaikan"] if lb.norm(a) != frasa]
    elif frasa and frasa not in master["abaikan"]:
        master["abaikan"].append(frasa)
    return master
