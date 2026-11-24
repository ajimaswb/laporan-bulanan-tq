// Versi online (Cloudflare Workers): Python (laporan_bulanan.py) berjalan di browser lewat Pyodide,
// login & data lewat Worker (/srv/*, lihat worker/worker.js). Modul ini meniru endpoint /api/* milik
// gui.py sehingga tampilan (index.html) sama untuk versi lokal maupun online.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
const FILE_PY = ["laporan_bulanan.py", "penyimpanan.py", "inti.py", "web.py", "config.json"];
const FIELD_MASTER = ["nama", "kata_kunci", "lokasi", "standar", "kategori", "kegiatan_default"];

let CFG = null;
let tampilStatus = () => {};
const S = { profil: null, master: null, sdo: null, kehadiran: false, ttd: {}, ttdUrl: {}, template: undefined, unduh: null };

export function aturStatus(fn) { tampilStatus = fn; }

async function config() {
  if (!CFG) CFG = await (await fetch("config.json", { cache: "no-cache" })).json();
  return CFG;
}

function gagal(status, pesan) {
  const e = new Error(pesan);
  e.status = status;
  return e;
}

function lupakanSesi() {
  Object.assign(S, { profil: null, master: null, sdo: null, ttd: {}, template: undefined });
}

// Panggil server Worker. Sesi login disimpan di cookie HttpOnly oleh server.
async function srv(path, { method = "GET", body, mentah = false } = {}) {
  const h = {};
  let data = body;
  if (method !== "GET") h["X-Laporan"] = "1";
  if (body !== undefined && !(body instanceof Uint8Array)) {
    data = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  } else if (body instanceof Uint8Array) {
    h["Content-Type"] = "application/octet-stream";
  }
  const r = await fetch("/srv" + path, { method, headers: h, body: data, credentials: "same-origin" });
  if (!r.ok) {
    let pesan = r.statusText;
    try { pesan = (await r.json()).error || pesan; } catch (e) {}
    if (r.status === 401) lupakanSesi();
    throw gagal(r.status, pesan);
  }
  if (mentah) return new Uint8Array(await r.arrayBuffer());
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const q = encodeURIComponent;

// ---------------------------------------------------------------- Python di browser
let pySiap = null;
function python() {
  if (!pySiap) {
    pySiap = (async () => {
      tampilStatus("Menyiapkan aplikasi (pertama kali sekitar 20 detik)…");
      if (!window.loadPyodide) {
        await new Promise((ok, err) => {
          const s = document.createElement("script");
          s.src = PYODIDE_URL + "pyodide.js";
          s.onload = ok;
          s.onerror = () => err(new Error("Gagal memuat Pyodide. Periksa koneksi internet."));
          document.head.appendChild(s);
        });
      }
      const py = await window.loadPyodide({ indexURL: PYODIDE_URL });
      tampilStatus("Memasang pustaka Excel…");
      await py.loadPackage(["micropip", "Pillow", "ssl"]);
      await py.pyimport("micropip").install(["openpyxl"]);
      py.FS.mkdirTree("/app");
      for (const f of FILE_PY) {
        py.FS.writeFile("/app/" + f, await (await fetch(f, { cache: "no-cache" })).text());
      }
      py.runPython("import sys; sys.path.insert(0, '/app')");
      return { py, web: py.pyimport("web") };
    })();
    pySiap.catch(() => { pySiap = null; });
  }
  return pySiap;
}

async function panggil(fungsi, ...arg) {
  const { web } = await python();
  try {
    return web[fungsi](...arg);
  } catch (e) {
    const baris = String(e.message || e).trim().split("\n");
    throw gagal(400, baris[baris.length - 1].replace(/^\w+Error: /, ""));
  }
}

// ---------------------------------------------------------------- data
async function profil() {
  if (!S.profil) {
    const st = await srv("/status");
    if (!st.login) throw gagal(401, "Silakan login terlebih dahulu.");
    S.profil = st.login;
  }
  return S.profil;
}

async function master(segarkan = false) {
  if (!S.master || segarkan) S.master = await srv("/master");
  return S.master;
}

async function simpanMaster(baru) {
  await srv("/master", { method: "PUT", body: { copart: baru.copart, abaikan: baru.abaikan } });
  await master(true);
}

async function daftarSdo(segarkan = false) {
  if (!S.sdo || segarkan) S.sdo = await srv("/sdo");
  return S.sdo;
}

async function ttdBytes(kode) {
  if (!(kode in S.ttd)) {
    const info = (S.sdo || {})[kode];
    if (info && !info.ttd) {
      S.ttd[kode] = null;
    } else {
      try {
        S.ttd[kode] = await srv(`/ttd/${q(kode)}`, { mentah: true });
      } catch (e) {
        if (e.status === 404) S.ttd[kode] = null;
        else throw e;
      }
    }
  }
  return S.ttd[kode];
}

function ttdUrl(kode) {
  const b = S.ttd[kode];
  if (!b) return null;
  if (!S.ttdUrl[kode]) S.ttdUrl[kode] = URL.createObjectURL(new Blob([b], { type: "image/png" }));
  return S.ttdUrl[kode];
}

function lupakanTtd(kode) {
  delete S.ttd[kode];
  if (S.ttdUrl[kode]) URL.revokeObjectURL(S.ttdUrl[kode]);
  delete S.ttdUrl[kode];
}

async function infoTemplate() {
  if (S.template === undefined) S.template = (await srv("/template/info")).diubah;
  return S.template;
}

async function siapkanTemplate() {
  if (!(await infoTemplate())) {
    throw gagal(400, "Template laporan belum tersedia. Admin perlu meng-upload template .xlsx di menu Data SDO.");
  }
  const { py } = await python();
  if (!S.templateDiFS) {
    py.FS.writeFile("/tmp/template.xlsx", await srv("/template", { mentah: true }));
    S.templateDiFS = true;
  }
  return "/tmp/template.xlsx";
}

async function siapkanKehadiran(muatUlang = false) {
  if (S.kehadiran && !muatUlang) return;
  const { py } = await python();
  tampilStatus("Mengambil spreadsheet kehadiran…");
  py.FS.writeFile("/tmp/kehadiran.xlsx", await srv("/kehadiran", { mentah: true }));
  tampilStatus("Membaca spreadsheet kehadiran…");
  await panggil("muat_kehadiran", "/tmp/kehadiran.xlsx");
  S.kehadiran = true;
}

function periodeDefault() {
  const d = new Date();
  let th = d.getFullYear(), bl = d.getMonth() + 1;
  if (d.getDate() > (CFG?.tanggal_cutoff || 25)) { bl += 1; if (bl > 12) { bl = 1; th += 1; } }
  return `${th}-${String(bl).padStart(2, "0")}`;
}

async function kodeAktif(diminta) {
  const p = await profil();
  const semua = await daftarSdo();
  if (!p.admin) return p.kode;
  return diminta && semua[diminta] ? diminta : p.kode;
}

async function argsPy(kode, extra = {}) {
  const { py } = await python();
  const semua = await daftarSdo();
  const ttd = await ttdBytes(kode);
  let ttdPath = null;
  if (ttd) {
    ttdPath = `/tmp/ttd_${kode}.png`;
    py.FS.writeFile(ttdPath, ttd);
  }
  return {
    master: await master(),
    sdo: { kode, nama: "", mandays_copart: [], koreksi: {}, ...(semua[kode] || {}) },
    ttd_path: ttdPath,
    ...extra,
  };
}

async function denganTemplate(hasil) {
  hasil.reminder.template_belum = !(await infoTemplate());
  return hasil;
}

function daftarUntukGui(semua) {
  return Object.entries(semua).map(([kode, v]) => ({
    kode, nama: v.nama, ttd: !!S.ttd[kode], ttd_url: ttdUrl(kode), akun: v.akun, admin: v.admin,
    jumlah_copart: (v.mandays_copart || []).length,
  }));
}

function bytesDariDataUrl(dataUrl) {
  return Uint8Array.from(atob(dataUrl.split(",", 2)[1]), c => c.charCodeAt(0));
}

// ---------------------------------------------------------------- router /api/*
export async function api(path, body = {}) {
  await config();
  const url = new URL(path, "http://x");
  const p = url.pathname;
  const data = body || {};

  if (p === "/api/status") {
    const st = await srv("/status");
    if (!st.login) {
      lupakanSesi();
      return { online: true, login: null, perlu_admin_awal: !st.ada_admin };
    }
    S.profil = st.login;
    python();  // mulai memuat Python di latar belakang
    return { online: true, login: st.login };
  }

  if (p === "/api/login") {
    lupakanSesi();
    await srv("/login", { method: "POST", body: { kode: data.kode, password: data.password || "" } });
    return { ok: true };
  }

  if (p === "/api/logout") {
    try { await srv("/logout", { method: "POST", body: {} }); } catch (e) {}
    lupakanSesi();
    return { ok: true };
  }

  if (p === "/api/siapkan_admin") {
    if ((data.password || "").length < 8) throw gagal(400, "Password minimal 8 karakter.");
    lupakanSesi();
    await srv("/siapkan_admin", { method: "POST", body: { password: data.password } });
    return { ok: true };
  }

  // --- perlu login
  const pr = await profil();

  if (p === "/api/ganti_password") {
    if ((data.password || "").length < 8) throw gagal(400, "Password minimal 8 karakter.");
    await srv("/ganti_password", { method: "POST", body: { password: data.password } });
    return { ok: true };
  }

  if (p === "/api/awal") {
    const semua = await daftarSdo();
    const kode = await kodeAktif(url.searchParams.get("sdo"));
    const m = await master();
    const lokasi = { "-": "-" };
    for (const [k, c] of Object.entries(m.copart)) lokasi[k] = c.lokasi || "";
    return {
      kode,
      sdo: pr.admin ? Object.entries(semua).map(([k, v]) => ({ kode: k, nama: v.nama })) : [{ kode: pr.kode, nama: pr.nama }],
      periode: periodeDefault(),
      folder_output: "",
      copart: Object.keys(m.copart).sort(),
      lokasi,
    };
  }

  if (p === "/api/ambil") {
    await siapkanKehadiran(!!data.muat_ulang);
    const kode = await kodeAktif(data.sdo);
    const hasil = JSON.parse(await panggil("ambil", JSON.stringify(await argsPy(kode, { periode: data.periode }))));
    return denganTemplate(hasil);
  }

  if (p === "/api/pratinjau" || p === "/api/buat") {
    await siapkanKehadiran();
    const kode = await kodeAktif(data.sdo);
    const buat = p === "/api/buat";
    const extra = { periode: data.periode, form: data, tulis: buat };
    if (buat) extra.template_path = await siapkanTemplate();
    const r = JSON.parse(await panggil("pratinjau", JSON.stringify(await argsPy(kode, extra))));
    const hasil = await denganTemplate(r.hasil);
    if (buat) {
      await srv(`/sdo/${q(kode)}`, { method: "PATCH", body: r.sdo_baru });
      Object.assign(S.sdo[kode], r.sdo_baru);
      const { py } = await python();
      const isi = py.FS.readFile(hasil.path);
      if (S.unduh) URL.revokeObjectURL(S.unduh);
      S.unduh = URL.createObjectURL(new Blob([isi],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      hasil.unduh = S.unduh;
      delete hasil.path;
    }
    return hasil;
  }

  // --- master copart (baca: semua SDO, tulis: admin)
  if (p === "/api/master") {
    const m = await master(true);
    const copart = Object.entries(m.copart).map(([kode, c]) => {
      const row = { kode };
      for (const f of FIELD_MASTER) row[f] = c[f] ?? (f === "kata_kunci" ? [] : "");
      return row;
    });
    return { copart, abaikan: m.abaikan, boleh_ubah: !!pr.admin };
  }

  if (p === "/api/master/kandidat") {
    await siapkanKehadiran();
    const kode = await kodeAktif(data.sdo);
    return JSON.parse(await panggil("kandidat", JSON.stringify(await argsPy(kode, { periode: data.periode }))));
  }

  const wajibAdmin = () => { if (!pr.admin) throw gagal(403, "Hanya admin yang bisa melakukan ini."); };

  if (p === "/api/master/simpan") {
    wajibAdmin();
    await simpanMaster(JSON.parse(await panggil("master_dari_list",
      JSON.stringify(await master(true)), JSON.stringify(data.copart))));
    return api("/api/master");
  }
  if (p === "/api/master/tambah") {
    wajibAdmin();
    await simpanMaster(JSON.parse(await panggil("master_tambah", JSON.stringify(await master(true)), JSON.stringify(data))));
    return { ok: true };
  }
  if (p === "/api/master/abaikan") {
    wajibAdmin();
    await simpanMaster(JSON.parse(await panggil("master_abaikan",
      JSON.stringify(await master(true)), String(data.frasa || ""), !!data.batal)));
    return { ok: true };
  }

  // --- data SDO
  if (p === "/api/sdo") {
    const semua = await daftarSdo(true);
    await Promise.all(Object.keys(semua).map(ttdBytes));
    let belum = [];
    if (pr.admin && S.kehadiran) {
      belum = JSON.parse(await panggil("implementer", JSON.stringify({ periode: data.periode })))
        .filter(k => !(k in semua));
    }
    S.template = undefined;
    return { sdo: daftarUntukGui(semua), belum_terdaftar: belum, admin: !!pr.admin, online: true,
             template: pr.admin ? { diubah: await infoTemplate() } : null };
  }

  if (p === "/api/sdo/simpan") {
    const kode = String(data.kode || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(kode)) throw gagal(400, "Kode SDO harus 2–8 huruf atau angka, contoh: AJM.");
    if (!pr.admin && kode !== pr.kode) throw gagal(403, "Anda hanya bisa mengubah data sendiri.");
    const semua = await daftarSdo(true);
    if (!(kode in semua)) {
      wajibAdmin();
      await srv("/sdo", { method: "POST", body: { kode, nama: (data.nama || "").trim() } });
    } else if ("nama" in data) {
      await srv(`/sdo/${q(kode)}`, { method: "PATCH", body: { nama: data.nama.trim() } });
      if (kode === pr.kode) pr.nama = data.nama.trim();
    }
    return { sdo: daftarUntukGui(await daftarSdo(true)) };
  }

  if (p === "/api/sdo/hapus") {
    wajibAdmin();
    const kode = String(data.kode || "");
    await srv(`/sdo/${q(kode)}`, { method: "DELETE", body: {} });
    lupakanTtd(kode);
    return { sdo: daftarUntukGui(await daftarSdo(true)) };
  }

  if (p === "/api/sdo/akun") {
    wajibAdmin();
    if ((data.password || "").length < 8) throw gagal(400, "Password minimal 8 karakter.");
    await srv(`/sdo/${q(String(data.kode || ""))}/akun`, { method: "POST", body: { password: data.password } });
    return { sdo: daftarUntukGui(await daftarSdo(true)) };
  }

  if (p === "/api/sdo/ttd") {
    const kode = String(data.kode || "");
    if (!pr.admin && kode !== pr.kode) throw gagal(403, "Anda hanya bisa mengubah tanda tangan sendiri.");
    if (data.data) {
      const { py } = await python();
      py.FS.writeFile("/tmp/ttd_masuk", bytesDariDataUrl(data.data));
      await panggil("olah_ttd", "/tmp/ttd_masuk", "/tmp/ttd_keluar.png");
      await srv(`/ttd/${q(kode)}`, { method: "PUT", body: py.FS.readFile("/tmp/ttd_keluar.png") });
    } else {
      await srv(`/ttd/${q(kode)}`, { method: "DELETE", body: {} });
    }
    lupakanTtd(kode);
    const semua = await daftarSdo(true);
    await Promise.all(Object.keys(semua).map(ttdBytes));
    return { sdo: daftarUntukGui(semua) };
  }

  if (p === "/api/template/simpan") {
    wajibAdmin();
    const bin = bytesDariDataUrl(data.data || "");
    if (bin[0] !== 0x50 || bin[1] !== 0x4b) throw gagal(400, "File harus berformat .xlsx.");
    await srv("/template", { method: "PUT", body: bin });
    S.template = undefined;
    S.templateDiFS = false;
    return { template: { diubah: await infoTemplate() } };
  }

  throw gagal(404, "Tidak tersedia di versi online.");
}

