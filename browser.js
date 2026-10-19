// Versi browser (GitHub Pages): Python (laporan_bulanan.py) berjalan di browser lewat Pyodide,
// login & data lewat Supabase. Modul ini meniru endpoint /api/* milik gui.py sehingga
// tampilan (index.html) sama untuk versi lokal maupun online.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
const FILE_PY = ["laporan_bulanan.py", "penyimpanan.py", "inti.py", "web.py", "config.json"];
const FIELD_MASTER = ["nama", "kata_kunci", "lokasi", "standar", "kategori", "kegiatan_default"];

let CFG = null;
let SB = null;
let tampilStatus = () => {};
const S = { profil: null, master: null, sdo: null, kehadiran: false, ttd: {}, ttdUrl: {}, template: undefined, unduh: null };

export function aturStatus(fn) { tampilStatus = fn; }

async function config() {
  if (!CFG) {
    CFG = await (await fetch("config.json", { cache: "no-cache" })).json();
    SB = CFG.supabase;
  }
  return CFG;
}

function gagal(status, pesan) {
  const e = new Error(pesan);
  e.status = status;
  return e;
}

// ---------------------------------------------------------------- sesi login
function bacaSesi() {
  try { return JSON.parse(localStorage.getItem("lt_sesi")); } catch (e) { return null; }
}
function simpanSesi(s) {
  try {
    localStorage.setItem("lt_sesi", JSON.stringify({
      access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    }));
  } catch (e) { /* mode privat: sesi hanya selama halaman terbuka */ }
  S.sesi = s;
}
function hapusSesi() {
  try { localStorage.removeItem("lt_sesi"); } catch (e) {}
  Object.assign(S, { sesi: null, profil: null, master: null, sdo: null, ttd: {}, template: undefined });
}

async function token() {
  const s = S.sesi || bacaSesi();
  if (!s) throw gagal(401, "Silakan login.");
  if (s.expires_at && s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  try {
    const baru = await sb("/auth/v1/token?grant_type=refresh_token",
      { method: "POST", body: { refresh_token: s.refresh_token }, auth: false });
    simpanSesi(baru);
    return baru.access_token;
  } catch (e) {
    hapusSesi();
    throw gagal(401, "Sesi berakhir, silakan login lagi.");
  }
}

async function sb(path, { method = "GET", body, auth = true, headers = {}, mentah = false } = {}) {
  await config();
  const h = { apikey: SB.key, ...headers };
  if (auth) h.Authorization = "Bearer " + await token();
  let data = body;
  if (body !== undefined && !(body instanceof Uint8Array)) {
    data = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  const r = await fetch(SB.url + path, { method, headers: h, body: data });
  if (!r.ok) {
    let pesan = r.statusText;
    try {
      const j = await r.json();
      pesan = j.message || j.msg || j.error_description || j.error || pesan;
    } catch (e) {}
    throw gagal(r.status, pesan);
  }
  if (mentah) return new Uint8Array(await r.arrayBuffer());
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const rpc = (fungsi, arg = {}, auth = true) => sb(`/rest/v1/rpc/${fungsi}`, { method: "POST", body: arg, auth });
const emailSdo = kode => `${kode.toLowerCase()}@sdo.example.com`;
const q = encodeURIComponent;

// ---------------------------------------------------------------- Python di browser
let pySiap = null;
function python() {
  if (!pySiap) {
    pySiap = (async () => {
      tampilStatus("Menyiapkan aplikasi (pertama kali ±20 detik)…");
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
    const user = await sb("/auth/v1/user");
    const rows = await sb(`/rest/v1/sdo?select=kode,nama,admin&user_id=eq.${q(user.id)}`);
    if (!rows.length) throw gagal(403, "Akun ini belum terhubung ke SDO mana pun. Hubungi admin.");
    S.profil = rows[0];
  }
  return S.profil;
}

async function master(segarkan = false) {
  if (!S.master || segarkan) {
    const copart = {};
    for (const r of await sb("/rest/v1/master_copart?select=kode,data&order=kode")) copart[r.kode] = r.data;
    const abaikan = (await sb("/rest/v1/copart_abaikan?select=frasa&order=frasa")).map(r => r.frasa);
    S.master = { copart, abaikan };
  }
  return S.master;
}

async function simpanMaster(baru) {
  const lama = await master(true);
  const rows = Object.entries(baru.copart).map(([kode, data]) => ({ kode, data }));
  if (rows.length) {
    await sb("/rest/v1/master_copart", { method: "POST", body: rows,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
  }
  for (const k of Object.keys(lama.copart)) {
    if (!(k in baru.copart)) await sb(`/rest/v1/master_copart?kode=eq.${q(k)}`, { method: "DELETE" });
  }
  const tambah = baru.abaikan.filter(a => !lama.abaikan.includes(a));
  if (tambah.length) {
    await sb("/rest/v1/copart_abaikan", { method: "POST", body: tambah.map(frasa => ({ frasa })),
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" } });
  }
  for (const a of lama.abaikan) {
    if (!baru.abaikan.includes(a)) await sb(`/rest/v1/copart_abaikan?frasa=eq.${q(a)}`, { method: "DELETE" });
  }
  await master(true);
}

async function daftarSdo(segarkan = false) {
  if (!S.sdo || segarkan) {
    S.sdo = {};
    for (const r of await sb("/rest/v1/sdo?select=kode,nama,admin,user_id,mandays_copart,koreksi&order=kode")) {
      S.sdo[r.kode] = { nama: r.nama, admin: r.admin, akun: !!r.user_id,
                        mandays_copart: r.mandays_copart, koreksi: r.koreksi };
    }
  }
  return S.sdo;
}

async function ttdBytes(kode) {
  if (!(kode in S.ttd)) {
    try {
      S.ttd[kode] = await sb(`/storage/v1/object/authenticated/ttd/${q(kode)}.png`, { mentah: true });
    } catch (e) {
      if (e.status === 400 || e.status === 404) S.ttd[kode] = null;
      else throw e;
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
  if (S.template === undefined) {
    const rows = await sb("/rest/v1/berkas?select=nama,diubah&nama=eq.template");
    S.template = rows.length ? rows[0].diubah : null;
  }
  return S.template;
}

async function siapkanTemplate() {
  if (!(await infoTemplate())) {
    throw gagal(400, "Template laporan belum diupload. Admin perlu mengupload template .xlsx di tab Data SDO.");
  }
  const { py } = await python();
  if (!S.templateDiFS) {
    const rows = await sb("/rest/v1/berkas?select=isi_base64&nama=eq.template");
    const bin = Uint8Array.from(atob(rows[0].isi_base64), c => c.charCodeAt(0));
    py.FS.writeFile("/tmp/template.xlsx", bin);
    S.templateDiFS = true;
  }
  return "/tmp/template.xlsx";
}

async function siapkanKehadiran(muatUlang = false) {
  if (S.kehadiran && !muatUlang) return;
  const { py } = await python();
  tampilStatus("Mengambil spreadsheet kehadiran…");
  await config();
  const r = await fetch(SB.url + "/functions/v1/kehadiran",
    { headers: { Authorization: "Bearer " + await token(), apikey: SB.key } });
  if (!r.ok) {
    let pesan = r.statusText;
    try { pesan = (await r.json()).error || pesan; } catch (e) {}
    throw gagal(r.status, pesan);
  }
  py.FS.writeFile("/tmp/kehadiran.xlsx", new Uint8Array(await r.arrayBuffer()));
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
    if (!(S.sesi || bacaSesi())) return { online: true, login: null, perlu_admin_awal: !(await rpc("ada_admin", {}, false)) };
    try {
      const pr = await profil();
      python();  // mulai memuat Python di latar belakang
      return { online: true, login: { kode: pr.kode, nama: pr.nama, admin: pr.admin } };
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        hapusSesi();
        return { online: true, login: null, perlu_admin_awal: !(await rpc("ada_admin", {}, false)), pesan: e.message };
      }
      throw e;
    }
  }

  if (p === "/api/login") {
    const kode = String(data.kode || "").trim().toUpperCase();
    try {
      simpanSesi(await sb("/auth/v1/token?grant_type=password",
        { method: "POST", body: { email: emailSdo(kode), password: data.password || "" }, auth: false }));
    } catch (e) {
      throw gagal(401, e.status >= 500 ? "Server login sedang bermasalah, coba lagi." : "Kode SDO atau password salah.");
    }
    return { ok: true };
  }

  if (p === "/api/logout") {
    try { await sb("/auth/v1/logout", { method: "POST", body: {} }); } catch (e) {}
    hapusSesi();
    return { ok: true };
  }

  if (p === "/api/siapkan_admin") {
    if (await rpc("ada_admin", {}, false)) throw gagal(400, "Admin sudah ada.");
    if ((data.password || "").length < 8) throw gagal(400, "Password minimal 8 karakter.");
    const kode = await rpc("siapkan_admin", { p_password: data.password }, false);
    return api("/api/login", { kode, password: data.password });
  }

  // --- perlu login
  const pr = await profil();

  if (p === "/api/ganti_password") {
    await rpc("ganti_password_saya", { p_password: data.password || "" });
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
      await sb(`/rest/v1/sdo?kode=eq.${q(kode)}`, { method: "PATCH", body: r.sdo_baru,
        headers: { Prefer: "return=minimal" } });
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

  const wajibAdmin = () => { if (!pr.admin) throw gagal(403, "Hanya admin yang boleh melakukan ini."); };

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
    if (!/^[A-Z0-9]{2,8}$/.test(kode)) throw gagal(400, "Kode SDO harus 2-8 huruf/angka, mis. AJM.");
    if (!pr.admin && kode !== pr.kode) throw gagal(403, "Hanya boleh mengubah data sendiri.");
    const semua = await daftarSdo(true);
    if (!(kode in semua)) {
      wajibAdmin();
      await sb("/rest/v1/sdo", { method: "POST", body: { kode, nama: (data.nama || "").trim() },
        headers: { Prefer: "return=minimal" } });
    } else if ("nama" in data) {
      await sb(`/rest/v1/sdo?kode=eq.${q(kode)}`, { method: "PATCH", body: { nama: data.nama.trim() },
        headers: { Prefer: "return=minimal" } });
      if (kode === pr.kode) pr.nama = data.nama.trim();
    }
    return { sdo: daftarUntukGui(await daftarSdo(true)) };
  }

  if (p === "/api/sdo/hapus") {
    wajibAdmin();
    const kode = String(data.kode || "");
    try { await sb(`/storage/v1/object/ttd/${q(kode)}.png`, { method: "DELETE" }); } catch (e) {}
    await rpc("hapus_sdo", { p_kode: kode });
    lupakanTtd(kode);
    return { sdo: daftarUntukGui(await daftarSdo(true)) };
  }

  if (p === "/api/sdo/akun") {
    wajibAdmin();
    await rpc("atur_akun_sdo", { p_kode: String(data.kode || ""), p_password: data.password || "" });
    return { sdo: daftarUntukGui(await daftarSdo(true)) };
  }

  if (p === "/api/sdo/ttd") {
    const kode = String(data.kode || "");
    if (!pr.admin && kode !== pr.kode) throw gagal(403, "Hanya boleh mengubah tanda tangan sendiri.");
    if (data.data) {
      const { py } = await python();
      py.FS.writeFile("/tmp/ttd_masuk", bytesDariDataUrl(data.data));
      await panggil("olah_ttd", "/tmp/ttd_masuk", "/tmp/ttd_keluar.png");
      await sb(`/storage/v1/object/ttd/${q(kode)}.png`, { method: "POST", body: py.FS.readFile("/tmp/ttd_keluar.png"),
        headers: { "Content-Type": "image/png", "x-upsert": "true", "Cache-Control": "no-cache" } });
    } else {
      try { await sb(`/storage/v1/object/ttd/${q(kode)}.png`, { method: "DELETE" }); } catch (e) {}
    }
    lupakanTtd(kode);
    const semua = await daftarSdo(true);
    await Promise.all(Object.keys(semua).map(ttdBytes));
    return { sdo: daftarUntukGui(semua) };
  }

  if (p === "/api/template/simpan") {
    wajibAdmin();
    const bin = bytesDariDataUrl(data.data || "");
    if (bin[0] !== 0x50 || bin[1] !== 0x4b) throw gagal(400, "File harus berupa .xlsx.");
    await sb("/rest/v1/berkas", { method: "POST",
      body: { nama: "template", isi_base64: data.data.split(",", 2)[1], diubah: new Date().toISOString() },
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
    S.template = undefined;
    S.templateDiFS = false;
    return { template: { diubah: await infoTemplate() } };
  }

  throw gagal(404, "Tidak tersedia di versi online.");
}

