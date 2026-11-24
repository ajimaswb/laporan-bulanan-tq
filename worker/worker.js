// Server Laporan Bulanan di Cloudflare Workers.
// - /srv/*  : login SDO (kode + password), data di D1, spreadsheet kehadiran
// - lainnya : file statis (index.html, browser.js, *.py) dari Workers Assets
// Hak akses sama seperti versi Supabase: admin boleh semua, SDO hanya data miliknya sendiri.

const SHEET_ID = "1bWm6Ak_eK4UNba9meC9B_vTxKVy9jpFV";
const PBKDF2_ITER = 20000;              // dijaga rendah agar muat di batas CPU Worker gratis
const SESI_DETIK = 60 * 60 * 24 * 30;   // sesi login 30 hari
const MAKS_FILE = 2 * 1024 * 1024;      // batas ukuran tanda tangan / template
const enc = new TextEncoder();

class Galat extends Error {
  constructor(status, pesan) { super(pesan); this.status = status; }
}

// ---------------------------------------------------------------- util
function json(data, status = 200, header = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...header },
  });
}

function keB64(bytes) {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const dariB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = s => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function samaPersis(a, b) {
  if (a.length !== b.length) return false;
  let beda = 0;
  for (let i = 0; i < a.length; i++) beda |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return beda === 0;
}

function kodeValid(teks) {
  const kode = String(teks || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(kode)) throw new Galat(400, "Kode SDO harus 2–8 huruf atau angka, contoh: AJM.");
  return kode;
}

// ---------------------------------------------------------------- password & sesi
async function hashPassword(password, saltB64 = null, iter = PBKDF2_ITER) {
  const salt = saltB64 ? dariB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const kunci = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, kunci, 256);
  return { hash: keB64(bits), salt: keB64(salt), iter };
}

function cekPanjang(password) {
  if (String(password || "").length < 8) throw new Galat(400, "Password minimal 8 karakter.");
}

async function hmac(env, teks) {
  if (!env.SESSION_SECRET) throw new Galat(500, "SESSION_SECRET belum diatur di Worker.");
  const kunci = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(keB64(await crypto.subtle.sign("HMAC", kunci, enc.encode(teks))));
}

// token = kode.kedaluwarsa.versi.tanda ; versi = potongan salt password, jadi ganti password = semua sesi lama gugur
async function buatCookie(env, row) {
  const exp = Math.floor(Date.now() / 1000) + SESI_DETIK;
  const isi = `${row.kode}.${exp}.${b64url(row.pw_salt).slice(0, 10)}`;
  const token = `${isi}.${await hmac(env, isi)}`;
  return `lt_sesi=${token}; Path=/; Max-Age=${SESI_DETIK}; HttpOnly; Secure; SameSite=Lax`;
}
const hapusCookie = "lt_sesi=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

async function pengguna(request, env) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)lt_sesi=([^;]+)/);
  if (!m) return null;
  const bagian = m[1].split(".");
  if (bagian.length !== 4) return null;
  const [kode, exp, versi, tanda] = bagian;
  if (Number(exp) < Date.now() / 1000) return null;
  if (!samaPersis(tanda, await hmac(env, `${kode}.${exp}.${versi}`))) return null;
  const row = await env.DB.prepare("SELECT kode, nama, admin, pw_salt FROM sdo WHERE kode = ?").bind(kode).first();
  if (!row || !row.pw_salt || b64url(row.pw_salt).slice(0, 10) !== versi) return null;
  return { kode: row.kode, nama: row.nama, admin: !!row.admin };
}

async function wajibLogin(request, env) {
  const u = await pengguna(request, env);
  if (!u) throw new Galat(401, "Silakan login terlebih dahulu.");
  return u;
}
function wajibAdmin(u) {
  if (!u.admin) throw new Galat(403, "Hanya admin yang bisa melakukan ini.");
}
function wajibMilikSendiri(u, kode, pesan) {
  if (!u.admin && u.kode !== kode) throw new Galat(403, pesan);
}

// ---------------------------------------------------------------- data
const adaAdmin = async env =>
  !!(await env.DB.prepare("SELECT 1 FROM sdo WHERE admin = 1 AND pw_hash IS NOT NULL LIMIT 1").first());

function barisSdo(r) {
  return { nama: r.nama, admin: !!r.admin, akun: !!r.pw_hash, ttd: !!r.ada_ttd,
           mandays_copart: JSON.parse(r.mandays_copart || "[]"), koreksi: JSON.parse(r.koreksi || "{}") };
}

async function bacaBody(request) {
  const tipe = request.headers.get("Content-Type") || "";
  if (tipe.includes("application/json")) return request.json();
  return {};
}

async function bacaBiner(request) {
  const isi = new Uint8Array(await request.arrayBuffer());
  if (!isi.length) throw new Galat(400, "File kosong.");
  if (isi.length > MAKS_FILE) throw new Galat(413, "File terlalu besar (maksimal 2 MB).");
  return isi;
}

async function batasLogin(env, ip) {
  const batas = Math.floor(Date.now() / 1000) - 300;
  await env.DB.prepare("DELETE FROM gagal_login WHERE waktu < ?").bind(batas).run();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM gagal_login WHERE ip = ? AND waktu >= ?").bind(ip, batas).first();
  if (r.n >= 8) throw new Galat(429, "Terlalu banyak percobaan login. Silakan coba lagi dalam 5 menit.");
}

// ---------------------------------------------------------------- rute /srv/*
async function tangani(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/^\/srv/, "");
  const metode = request.method;
  const ip = request.headers.get("CF-Connecting-IP") || "0";

  // Permintaan yang mengubah data wajib membawa header khusus (cegah CSRF dari situs lain)
  if (metode !== "GET" && request.headers.get("X-Laporan") !== "1") throw new Galat(400, "Permintaan tidak valid.");

  if (p === "/sehat") return json({ ok: true, ada_admin: await adaAdmin(env) });

  if (p === "/status") {
    const u = await pengguna(request, env);
    return json({ login: u, ada_admin: await adaAdmin(env) });
  }

  if (p === "/login" && metode === "POST") {
    await batasLogin(env, ip);
    const d = await bacaBody(request);
    const kode = String(d.kode || "").trim().toUpperCase();
    const row = await env.DB.prepare("SELECT * FROM sdo WHERE kode = ?").bind(kode).first();
    let cocok = false;
    if (row && row.pw_hash) {
      const h = await hashPassword(String(d.password || ""), row.pw_salt, row.pw_iter);
      cocok = samaPersis(h.hash, row.pw_hash);
    }
    if (!cocok) {
      await env.DB.prepare("INSERT INTO gagal_login (ip, waktu) VALUES (?, ?)").bind(ip, Math.floor(Date.now() / 1000)).run();
      throw new Galat(401, "Kode SDO atau password salah.");
    }
    return json({ ok: true }, 200, { "Set-Cookie": await buatCookie(env, row) });
  }

  if (p === "/logout" && metode === "POST") return json({ ok: true }, 200, { "Set-Cookie": hapusCookie });

  if (p === "/siapkan_admin" && metode === "POST") {
    if (await adaAdmin(env)) throw new Galat(400, "Akun admin sudah tersedia.");
    const d = await bacaBody(request);
    cekPanjang(d.password);
    const kode = (await env.DB.prepare("SELECT nilai FROM pengaturan WHERE kunci = 'admin_awal'").first()).nilai;
    const h = await hashPassword(d.password);
    await env.DB.prepare(
      `INSERT INTO sdo (kode, admin, pw_hash, pw_salt, pw_iter) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT (kode) DO UPDATE SET admin = 1, pw_hash = excluded.pw_hash, pw_salt = excluded.pw_salt, pw_iter = excluded.pw_iter`
    ).bind(kode, h.hash, h.salt, h.iter).run();
    return json({ ok: true, kode }, 200, { "Set-Cookie": await buatCookie(env, { kode, pw_salt: h.salt }) });
  }

  // ---------- perlu login
  const u = await wajibLogin(request, env);

  if (p === "/ganti_password" && metode === "POST") {
    const d = await bacaBody(request);
    cekPanjang(d.password);
    const h = await hashPassword(d.password);
    await env.DB.prepare("UPDATE sdo SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE kode = ?").bind(h.hash, h.salt, h.iter, u.kode).run();
    return json({ ok: true }, 200, { "Set-Cookie": await buatCookie(env, { kode: u.kode, pw_salt: h.salt }) });
  }

  if (p === "/kehadiran" && metode === "GET") {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, { redirect: "follow" });
    if (!r.ok) throw new Galat(502, `Gagal mengambil spreadsheet (${r.status}).`);
    return new Response(r.body, { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Cache-Control": "no-store" } });
  }

  // --- master copart (baca: semua SDO, tulis: admin)
  if (p === "/master" && metode === "GET") {
    const copart = {};
    for (const r of (await env.DB.prepare("SELECT kode, data FROM master_copart ORDER BY kode").all()).results) {
      copart[r.kode] = JSON.parse(r.data);
    }
    const abaikan = (await env.DB.prepare("SELECT frasa FROM copart_abaikan ORDER BY frasa").all()).results.map(r => r.frasa);
    return json({ copart, abaikan });
  }
  if (p === "/master" && metode === "PUT") {
    wajibAdmin(u);
    const d = await bacaBody(request);
    const perintah = [env.DB.prepare("DELETE FROM master_copart"), env.DB.prepare("DELETE FROM copart_abaikan")];
    for (const [kode, data] of Object.entries(d.copart || {})) {
      perintah.push(env.DB.prepare("INSERT INTO master_copart (kode, data) VALUES (?, ?)").bind(kode, JSON.stringify(data)));
    }
    for (const frasa of new Set(d.abaikan || [])) {
      perintah.push(env.DB.prepare("INSERT INTO copart_abaikan (frasa) VALUES (?)").bind(frasa));
    }
    await env.DB.batch(perintah);
    return json({ ok: true });
  }

  // --- SDO
  if (p === "/sdo" && metode === "GET") {
    const sql = `SELECT s.*, (SELECT 1 FROM ttd t WHERE t.kode = s.kode) AS ada_ttd FROM sdo s`;
    const rows = u.admin
      ? (await env.DB.prepare(`${sql} ORDER BY s.kode`).all()).results
      : (await env.DB.prepare(`${sql} WHERE s.kode = ?`).bind(u.kode).all()).results;
    const hasil = {};
    for (const r of rows) hasil[r.kode] = barisSdo(r);
    return json(hasil);
  }
  if (p === "/sdo" && metode === "POST") {
    wajibAdmin(u);
    const d = await bacaBody(request);
    const kode = kodeValid(d.kode);
    await env.DB.prepare("INSERT INTO sdo (kode, nama) VALUES (?, ?) ON CONFLICT (kode) DO NOTHING")
      .bind(kode, String(d.nama || "").trim()).run();
    return json({ ok: true });
  }

  let m = p.match(/^\/sdo\/([A-Z0-9]{2,8})(\/akun)?$/);
  if (m) {
    const kode = m[1];
    if (m[2] && metode === "POST") {
      wajibAdmin(u);
      const d = await bacaBody(request);
      cekPanjang(d.password);
      const h = await hashPassword(d.password);
      const r = await env.DB.prepare("UPDATE sdo SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE kode = ?").bind(h.hash, h.salt, h.iter, kode).run();
      if (!r.meta.changes) throw new Galat(404, `SDO ${kode} belum terdaftar.`);
      return json({ ok: true });
    }
    if (metode === "PATCH") {
      wajibMilikSendiri(u, kode, "Anda hanya bisa mengubah data sendiri.");
      const d = await bacaBody(request);
      const set = [], nilai = [];
      if ("nama" in d) { set.push("nama = ?"); nilai.push(String(d.nama || "").trim()); }
      if ("mandays_copart" in d) { set.push("mandays_copart = ?"); nilai.push(JSON.stringify(d.mandays_copart || [])); }
      if ("koreksi" in d) { set.push("koreksi = ?"); nilai.push(JSON.stringify(d.koreksi || {})); }
      if (set.length) {
        await env.DB.prepare(`UPDATE sdo SET ${set.join(", ")}, diubah = datetime('now') WHERE kode = ?`).bind(...nilai, kode).run();
      }
      return json({ ok: true });
    }
    if (metode === "DELETE") {
      wajibAdmin(u);
      if (kode === u.kode) throw new Galat(400, "Tidak bisa menghapus akun sendiri.");
      await env.DB.batch([env.DB.prepare("DELETE FROM ttd WHERE kode = ?").bind(kode),
                          env.DB.prepare("DELETE FROM sdo WHERE kode = ?").bind(kode)]);
      return json({ ok: true });
    }
  }

  // --- tanda tangan
  m = p.match(/^\/ttd\/([A-Z0-9]{2,8})$/);
  if (m) {
    const kode = m[1];
    wajibMilikSendiri(u, kode, "Anda hanya bisa mengakses tanda tangan sendiri.");
    if (metode === "GET") {
      const r = await env.DB.prepare("SELECT png FROM ttd WHERE kode = ?").bind(kode).first();
      if (!r) return json({ error: "Belum ada tanda tangan." }, 404);
      return new Response(new Uint8Array(r.png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
    }
    if (metode === "PUT") {
      const isi = await bacaBiner(request);
      await env.DB.prepare(`INSERT INTO ttd (kode, png) VALUES (?, ?)
                            ON CONFLICT (kode) DO UPDATE SET png = excluded.png, diubah = datetime('now')`).bind(kode, isi).run();
      return json({ ok: true });
    }
    if (metode === "DELETE") {
      await env.DB.prepare("DELETE FROM ttd WHERE kode = ?").bind(kode).run();
      return json({ ok: true });
    }
  }

  // --- template laporan (baca: semua SDO, ganti: admin)
  if (p === "/template/info" && metode === "GET") {
    const r = await env.DB.prepare("SELECT diubah FROM berkas WHERE nama = 'template'").first();
    return json({ diubah: r ? r.diubah.replace(" ", "T") + "Z" : null });
  }
  if (p === "/template" && metode === "GET") {
    const r = await env.DB.prepare("SELECT isi FROM berkas WHERE nama = 'template'").first();
    if (!r) throw new Galat(404, "Template laporan belum tersedia.");
    return new Response(new Uint8Array(r.isi), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Cache-Control": "no-store" } });
  }
  if (p === "/template" && metode === "PUT") {
    wajibAdmin(u);
    const isi = await bacaBiner(request);
    if (isi[0] !== 0x50 || isi[1] !== 0x4b) throw new Galat(400, "File harus berformat .xlsx.");
    await env.DB.prepare(`INSERT INTO berkas (nama, isi) VALUES ('template', ?)
                          ON CONFLICT (nama) DO UPDATE SET isi = excluded.isi, diubah = datetime('now')`).bind(isi).run();
    return json({ ok: true });
  }

  throw new Galat(404, "Tidak ditemukan.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/srv/")) return env.ASSETS.fetch(request);
    try {
      return await tangani(request, env);
    } catch (e) {
      if (e instanceof Galat) return json({ error: e.message }, e.status);
      return json({ error: `Terjadi kesalahan di server: ${e.message}` }, 500);
    }
  },
};
