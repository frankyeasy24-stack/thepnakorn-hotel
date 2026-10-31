// =====================================================================
//  Thepnakorn Hotel — API สำหรับ Vercel (Functions + Vercel Blob)
//  ข้อมูลเก็บเป็นไฟล์ JSON หนึ่งไฟล์ต่อหมวด (db/<หมวด>.json) ใน Blob store แบบ private
//  เขียนแบบ ifMatch (กันข้อมูลทับกันเมื่อมีคนบันทึกพร้อมกัน)
// =====================================================================
import { put, get, BlobPreconditionFailedError } from "@vercel/blob";
import { createHmac, pbkdf2 as pbkdf2cb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import SEED from "./seed-data.js";

const pbkdf2Async = promisify(pbkdf2cb);
const SESSION_DAYS = 14;
const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel รับ request ได้ไม่เกินประมาณ 4.5 MB
const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const COLS = new Set(["site", "rooms", "offers", "payment", "availability", "inbox", "settings", "logs"]);
const HOLD = ["new", "waiting", "confirmed", "checkedin"];
const STATUS_TH = { new: "ใหม่", waiting: "รอชำระมัดจำ", confirmed: "ยืนยันแล้ว", checkedin: "เช็คอินแล้ว", cancelled: "ยกเลิก" };
const SEED_IMAGES = new Set(SEED.__images || []);

// ---------- helpers ----------
const J = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const bad = (error, status = 400) => J({ error }, status);
const nowIso = () => new Date().toISOString();
const bkkToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const bkkMonth = () => bkkToday().slice(0, 7);
const rand = (n = 16) => randomBytes(n).toString("hex");
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nightsOf = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const baht = (n) => Number(n || 0).toLocaleString("th-TH");
const isAdmin = (u) => !!u && (u.role === "admin" || u.role === "owner");
const isOwner = (u) => !!u && u.role === "owner";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
const pbkdf2 = async (pw, salt) => (await pbkdf2Async(pw, Buffer.from(salt, "hex"), 100000, 32, "sha256")).toString("hex");
const cookie = (req, name) => { const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)")); return m ? decodeURIComponent(m[1]) : null; };
async function readJson(req, max = 300_000) { const t = await req.text(); if (t.length > max) throw new Error("ข้อมูลใหญ่เกินไป"); return t ? JSON.parse(t) : {}; }
function splitPath(path) {
  const s = typeof path === "string" ? path.split("/") : [];
  return s.length === 2 && COLS.has(s[0]) && ID.test(s[1]) ? s : null;
}

// ---------- storage: one JSON file per collection ----------
const memo = new Map(); // ภายใน request เดียว
async function readCol(name) {
  if (memo.has(name)) return memo.get(name);
  let r = null;
  try { r = await get(`db/${name}.json`, { access: "private", useCache: false }); } catch (e) { if (!(e && /not.?found/i.test(e.name + e.message))) throw e; }
  const out = r && r.statusCode === 200
    ? { data: JSON.parse(await new Response(r.stream).text()), etag: r.blob.etag }
    : { data: structuredClone(SEED[name] || {}), etag: null };
  memo.set(name, out);
  return out;
}
// แก้หมวดข้อมูลแบบ read-modify-write พร้อมลองใหม่ถ้ามีคนบันทึกแทรก
async function mutateCol(name, fn) {
  for (let i = 0; i < 5; i++) {
    memo.delete(name);
    const { data, etag } = await readCol(name);
    const result = await fn(data);
    try {
      await put(`db/${name}.json`, JSON.stringify(data), {
        access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
        cacheControlMaxAge: 60, ...(etag ? { ifMatch: etag } : {}),
      });
      memo.delete(name);
      return result;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError || /precondition/i.test(String(e && e.message))) { await sleep(80 + Math.random() * 200); continue; }
      throw e;
    }
  }
  throw new Error("มีคนบันทึกข้อมูลพร้อมกัน กรุณาลองอีกครั้ง");
}
async function getDoc(path) { const [c, id] = splitPath(path); return (await readCol(c)).data[id] ?? null; }
const putDoc = (path, data) => { const [c, id] = splitPath(path); return mutateCol(c, (col) => { col[id] = data; }); };

// ---------- permissions (ตรงกับระบบสิทธิ์ในหลังบ้าน) ----------
const PUBLIC_READ = new Set(["site", "rooms", "offers", "payment", "availability"]);
function canRead(path, u) {
  const [top, id] = path.split("/");
  if (PUBLIC_READ.has(top)) return true;
  if (top === "inbox") return isAdmin(u);
  if (top === "settings") return isOwner(u);
  if (top === "logs") return isOwner(u) || (isAdmin(u) && id === u.id);
  return false;
}
function canWrite(path, u, method) {
  const [top, id] = path.split("/");
  if (top === "payment" || top === "settings") return isOwner(u);
  if (top === "logs") return isAdmin(u) && id === u.id;
  if (top === "rooms" && method === "DELETE") return isOwner(u);
  if (top === "inbox") return false; // การจองแก้ผ่าน /api/bookings เท่านั้น
  if (top === "availability") return isAdmin(u);
  return ["site", "rooms", "offers"].includes(top) && isAdmin(u);
}
function deepMerge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) o[k] = deepMerge(o[k], v);
    else o[k] = v;
  }
  return o;
}

// ---------- availability & pricing ----------
async function allInboxItems() {
  const { data } = await readCol("inbox");
  return Object.entries(data).flatMap(([id, d]) => (d.items || []).map((i) => ({ ...i, _doc: "inbox/" + id })));
}
function bookedMap(items) {
  const m = {};
  for (const i of items) {
    if (i.type !== "booking" || !HOLD.includes(i.status) || !isDate(i.checkin) || !isDate(i.checkout)) continue;
    const n = nightsOf(i.checkin, i.checkout);
    if (n < 1 || n > 60) continue;
    for (let d = i.checkin; d < i.checkout; d = addDays(d, 1)) { m[d] = m[d] || {}; m[d][i.roomId] = (m[d][i.roomId] || 0) + (+i.qty || 1); }
  }
  return m;
}
const seasonFor = (content, d) => (content.seasons || []).find((x) => x.from && x.to && d >= x.from && d <= x.to);
const nightPrice = (content, r, d) => { const x = seasonFor(content, d); return Math.round((+r.price || 0) * (1 + (x ? +x.pct || 0 : 0) / 100)); };

// ---------- users & stateless sessions (cookie ลงลายเซ็น HMAC) ----------
const secret = () => process.env.SESSION_SECRET || process.env.SETUP_TOKEN || "";
const sign = (s) => createHmac("sha256", secret()).update(s).digest("base64url");
function sessionCookie(value, maxAge, secure) { return `tpn_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`; }
function makeSession(user, secure) {
  const body = Buffer.from(JSON.stringify({ u: user.id, v: user.sv || 0, e: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  return sessionCookie(body + "." + sign(body), SESSION_DAYS * 86400, secure);
}
async function currentUser(req) {
  const c = cookie(req, "tpn_session");
  if (!c || !secret()) return null;
  const [body, sig] = c.split(".");
  if (!body || !sig || !safeEq(sig, sign(body))) return null;
  let s; try { s = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!s || s.e < Date.now()) return null;
  const u = (await readCol("_users")).data[s.u];
  if (!u || u.disabled || (u.sv || 0) !== s.v) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}
async function newUserRecord({ email, name, role, password }) {
  email = str(email, 120).toLowerCase(); name = str(name, 80);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("อีเมลไม่ถูกต้อง");
  if (!name) throw new Error("กรุณาใส่ชื่อ");
  if (!["owner", "admin"].includes(role)) throw new Error("สิทธิ์ไม่ถูกต้อง");
  if (typeof password !== "string" || password.length < 8) throw new Error("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
  const salt = rand(16);
  return { id: "u_" + rand(10), email, name, role, pass_hash: await pbkdf2(password, salt), pass_salt: salt, disabled: false, sv: 0, created_at: nowIso() };
}

// ---------- notifications ----------
async function lineTarget() {
  const integ = (await getDoc("settings/integrations")) || {};
  const rt = (await getDoc("settings/line_runtime")) || {};
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || (integ.line && integ.line.enabled === false)) return null;
  return (integ.line && integ.line.groupId) || rt.groupId || null;
}
async function linePush(to, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.LINE_CHANNEL_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!r.ok) throw new Error("LINE " + r.status + " " + (await r.text()).slice(0, 200));
}
async function notify(text, payload) {
  const jobs = [];
  try { const to = await lineTarget(); if (to) jobs.push(linePush(to, text).catch((e) => console.log("line push failed", e.message))); } catch (e) { console.log("line", e.message); }
  try {
    const wh = ((await getDoc("settings/integrations")) || {}).webhook || {};
    if (wh.enabled && /^https:\/\//.test(wh.url || "") && payload)
      jobs.push(fetch(wh.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch((e) => console.log("webhook failed", e.message)));
  } catch (e) { console.log("webhook", e.message); }
  await Promise.all(jobs);
}
function bookingText(it, siteName) {
  if (it.type === "inquiry")
    return [`📩 คำขอใหม่: ${it.kind || "ห้องประชุม"} (${it.id})`, `ชื่อ: ${it.name}  โทร ${it.phone}`, it.checkin ? `วันที่: ${it.checkin} · ${it.guests || "-"} คน` : `จำนวน: ${it.guests || "-"} คน`, it.note ? `รายละเอียด: ${it.note}` : ""].filter(Boolean).join("\n");
  return [
    `🛎️ คำขอจองห้องใหม่ ${it.id}${it.source === "staff" ? " (พนักงานบันทึก)" : ""}`,
    `${it.roomName} × ${it.qty} ห้อง · ${it.guests} คน`, `${it.checkin} → ${it.checkout} (${it.nights} คืน)`,
    `ชื่อ: ${it.name}  โทร ${it.phone}${it.email ? "  " + it.email : ""}`,
    `ยอดรวม ${baht(it.total)} บาท${it.deposit ? ` · มัดจำ ${baht(it.deposit.amount)} บาท` : ""}`,
    it.note ? `หมายเหตุ: ${it.note}` : "", siteName ? `— ${siteName}` : "",
  ].filter(Boolean).join("\n");
}

// ---------- Omise ----------
async function omise(method, path, form) {
  const r = await fetch("https://api.omise.co" + path, {
    method,
    headers: { Authorization: "Basic " + Buffer.from(process.env.OMISE_SECRET_KEY + ":").toString("base64"), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await r.json();
  if (!r.ok || data.object === "error") throw new Error("Omise: " + (data.message || r.status));
  return data;
}
// แก้ฟิลด์ของการจองหนึ่งรายการ (ค้นจาก id)
async function updateItem(bookingId, fn) {
  return mutateCol("inbox", (col) => {
    for (const d of Object.values(col)) {
      const it = (d.items || []).find((x) => x.id === bookingId);
      if (it) { fn(it); return { ...it }; }
    }
    return null;
  });
}
async function applyCharge(charge) {
  const pays = (await readCol("_payments")).data;
  const pay = pays[charge.id];
  if (!pay || pay.status === charge.status) return pay && pay.status;
  await mutateCol("_payments", (col) => { col[charge.id] = { ...col[charge.id], status: charge.status, updated_at: nowIso() }; });
  const item = await updateItem(pay.booking_id, (it) => {
    it.deposit = { ...(it.deposit || {}), status: charge.status === "successful" ? "paid" : charge.status, chargeId: charge.id };
    if (charge.status === "successful" && ["new", "waiting"].includes(it.status)) it.status = "confirmed";
  });
  if (item && charge.status === "successful")
    await notify(`💰 ได้รับเงินมัดจำ ${baht(pay.amount / 100)} บาท\nการจอง ${item.id} · ${item.name}\nสถานะเปลี่ยนเป็น "ยืนยันแล้ว"`, { event: "booking.paid", data: item });
  return charge.status;
}

// =====================================================================
//  Router
// =====================================================================
export async function handle(req) {
  memo.clear();
  const url = new URL(req.url);
  const blobId = url.searchParams.get("__blob");
  if (blobId !== null) return serveBlob(blobId, url);
  const p = (url.searchParams.get("__p") || url.pathname.replace(/^\/api\/?/, "")).replace(/\/+$/, "");
  const m = req.method;
  const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) return bad("ยังไม่ได้เชื่อม Vercel Blob store กับโปรเจกต์นี้", 500);
  if (p === "line/webhook" && m === "POST") return lineWebhook(req);
  if (p === "omise/webhook" && m === "POST") return omiseWebhook(req);
  if (m !== "GET" && m !== "HEAD" && req.headers.get("x-requested-with") !== "thepnakorn") return bad("คำขอไม่ถูกต้อง", 403);

  try {
    const u = await currentUser(req);

    // ----- auth -----
    if (p === "me" && m === "GET") return J({ user: u, setupNeeded: Object.keys((await readCol("_users")).data).length === 0 });
    if (p === "login" && m === "POST") {
      const b = await readJson(req);
      const users = Object.values((await readCol("_users")).data);
      const row = users.find((x) => x.email === str(b.email, 120).toLowerCase());
      const ok = row && !row.disabled && safeEq(await pbkdf2(String(b.password || ""), row.pass_salt), row.pass_hash);
      if (!ok) { await sleep(700); return bad("อีเมลหรือรหัสผ่านไม่ถูกต้อง", 401); }
      return J({ ok: true }, 200, { "set-cookie": makeSession(row, secure) });
    }
    if (p === "logout" && m === "POST") return J({ ok: true }, 200, { "set-cookie": sessionCookie("", 0, secure) });
    if (p === "setup" && m === "POST") {
      const b = await readJson(req);
      if (!process.env.SETUP_TOKEN || !safeEq(String(b.token || ""), process.env.SETUP_TOKEN)) return bad("รหัสติดตั้ง (SETUP_TOKEN) ไม่ถูกต้อง", 403);
      const rec = await newUserRecord({ ...b, role: "owner" });
      const made = await mutateCol("_users", (col) => { if (Object.keys(col).length) return false; col[rec.id] = rec; return true; });
      if (!made) return bad("ตั้งค่าเจ้าของไปแล้ว", 403);
      return J({ ok: true }, 200, { "set-cookie": makeSession(rec, secure) });
    }
    if (p === "me/password" && m === "POST") {
      if (!u) return bad("กรุณาเข้าสู่ระบบ", 401);
      const b = await readJson(req);
      const row = (await readCol("_users")).data[u.id];
      if (!safeEq(await pbkdf2(String(b.current || ""), row.pass_salt), row.pass_hash)) return bad("รหัสผ่านเดิมไม่ถูกต้อง");
      if (typeof b.password !== "string" || b.password.length < 8) return bad("รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร");
      const salt = rand(16), hash = await pbkdf2(b.password, salt);
      let rec;
      await mutateCol("_users", (col) => { rec = col[u.id] = { ...col[u.id], pass_hash: hash, pass_salt: salt, sv: (col[u.id].sv || 0) + 1 }; });
      return J({ ok: true }, 200, { "set-cookie": makeSession(rec, secure) });
    }

    // ----- users (เจ้าของจัดการ) -----
    if (p === "users/names" && m === "GET") {
      if (!isAdmin(u)) return J({});
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 64);
      const all = (await readCol("_users")).data;
      return J(Object.fromEntries(ids.filter((i) => all[i]).map((i) => [i, { name: all[i].name }])));
    }
    if (p === "users") {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      if (m === "GET") return J({ users: Object.values((await readCol("_users")).data).map(({ id, email, name, role, disabled, created_at }) => ({ id, email, name, role, disabled: disabled ? 1 : 0, created_at })).sort((a, b) => a.created_at.localeCompare(b.created_at)) });
      if (m === "POST") {
        const b = await readJson(req);
        const rec = await newUserRecord({ ...b, role: b.role === "owner" ? "owner" : "admin" });
        await mutateCol("_users", (col) => { if (Object.values(col).some((x) => x.email === rec.email)) throw new Error("มีอีเมลนี้อยู่แล้ว"); col[rec.id] = rec; });
        return J({ id: rec.id });
      }
    }
    const um = p.match(/^users\/(u_[a-f0-9]+)$/);
    if (um) {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      const id = um[1];
      if (id === u.id && m !== "PATCH") return bad("ลบบัญชีตัวเองไม่ได้");
      if (m === "DELETE") { await mutateCol("_users", (col) => { delete col[id]; }); return J({ ok: true }); }
      if (m === "PATCH") {
        const b = await readJson(req);
        let pw = null;
        if (b.password) { if (b.password.length < 8) return bad("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร"); const salt = rand(16); pw = { pass_salt: salt, pass_hash: await pbkdf2(b.password, salt) }; }
        await mutateCol("_users", (col) => {
          const x = col[id]; if (!x) throw new Error("ไม่พบผู้ใช้");
          if (b.name) x.name = str(b.name, 80);
          if (b.role && id !== u.id && ["owner", "admin"].includes(b.role)) x.role = b.role;
          if (typeof b.disabled === "boolean" && id !== u.id) { x.disabled = b.disabled; if (b.disabled) x.sv = (x.sv || 0) + 1; }
          if (pw) { Object.assign(x, pw); x.sv = (x.sv || 0) + 1; }
        });
        return J({ ok: true });
      }
    }

    // ----- generic documents -----
    if (p === "doc") {
      const path = url.searchParams.get("path");
      if (!splitPath(path)) return bad("path ไม่ถูกต้อง");
      if (m === "GET") {
        if (path === "availability/summary") {
          const map = bookedMap(await allInboxItems()), today = bkkToday(), days = {};
          for (const d of Object.keys(map)) if (d >= today) days[d] = map[d];
          return J({ exists: true, data: { days } });
        }
        if (!canRead(path, u)) return J({ exists: false });
        const d = await getDoc(path);
        return J({ exists: !!d, data: d || undefined });
      }
      if (!canWrite(path, u, m)) return bad(u ? "บัญชีนี้ไม่มีสิทธิ์แก้ข้อมูลส่วนนี้" : "กรุณาเข้าสู่ระบบ", u ? 403 : 401);
      if (path.startsWith("availability/")) return J({ ok: true });
      const [c, id] = splitPath(path);
      if (m === "PUT") { const b = await readJson(req); if (!b || typeof b !== "object" || Array.isArray(b)) return bad("ข้อมูลต้องเป็น object"); await putDoc(path, b); return J({ ok: true }); }
      if (m === "PATCH") {
        const b = await readJson(req);
        const ok = await mutateCol(c, (col) => { if (!col[id]) return false; col[id] = deepMerge(col[id], b); return true; });
        return ok ? J({ ok: true }) : bad("ไม่พบข้อมูลที่จะแก้ไข", 404);
      }
      if (m === "DELETE") { await mutateCol(c, (col) => { delete col[id]; }); return J({ ok: true }); }
    }
    if (p === "col" && m === "GET") {
      const c = url.searchParams.get("path");
      if (!COLS.has(c)) return bad("path ไม่ถูกต้อง");
      const { data } = await readCol(c);
      return J({ docs: Object.keys(data).sort().filter((id) => canRead(c + "/" + id, u)).map((id) => ({ id, data: data[id] })) });
    }

    // ----- uploads -----
    if (p === "assets" && m === "POST") {
      if (!isAdmin(u)) return bad("กรุณาเข้าสู่ระบบ", 401);
      const type = (req.headers.get("content-type") || "").split(";")[0];
      if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return bad("รองรับเฉพาะไฟล์รูป JPG, PNG, WEBP, GIF, AVIF");
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.byteLength > MAX_UPLOAD) return bad("รูปใหญ่เกิน 4 MB กรุณาย่อรูปก่อนอัปโหลด");
      const id = rand(16);
      await put("img/" + id, buf, { access: "private", contentType: type, addRandomSuffix: false });
      return J({ id, url: "/_blob/" + id, sizeBytes: buf.byteLength, contentType: type });
    }

    // ----- bookings -----
    if (p === "bookings" && m === "POST") return createBooking(req, u);
    const bm = p.match(/^bookings\/(TPN-[A-Z0-9]+)(\/payment)?$/);
    if (bm && bm[2] && m === "GET") {
      const pays = Object.entries((await readCol("_payments")).data).filter(([, x]) => x.booking_id === bm[1]);
      if (!pays.length) return J({ status: "none" });
      const [cid, pay] = pays[pays.length - 1];
      let status = pay.status;
      if (status === "pending" && process.env.OMISE_SECRET_KEY) { try { status = await applyCharge(await omise("GET", "/charges/" + cid)); } catch (e) { console.log(e.message); } }
      return J({ status });
    }
    if (bm && !bm[2] && m === "PATCH") {
      if (!isAdmin(u)) return bad("กรุณาเข้าสู่ระบบ", 401);
      const b = await readJson(req);
      if (b.status && !STATUS_TH[b.status]) return bad("สถานะไม่ถูกต้อง");
      const it = await updateItem(bm[1], (x) => { if (b.status) x.status = b.status; if (typeof b.staffNote === "string") x.staffNote = str(b.staffNote, 500); });
      return it ? J({ ok: true }) : bad("ไม่พบการจองนี้", 404);
    }

    // ----- integrations (เจ้าของ) -----
    if (p === "integrations/status" && m === "GET") {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      const rt = (await getDoc("settings/line_runtime")) || {};
      const k = process.env.OMISE_SECRET_KEY;
      return J({
        line: { token: !!process.env.LINE_CHANNEL_ACCESS_TOKEN, secret: !!process.env.LINE_CHANNEL_SECRET, groupId: rt.groupId || null, groupSeenAt: rt.at || null },
        omise: { secret: !!k, mode: k ? (k.startsWith("skey_test") ? "test" : "live") : null },
        webhookUrls: { line: url.origin + "/api/line/webhook", omise: url.origin + "/api/omise/webhook" },
      });
    }
    if (p === "integrations/test-line" && m === "POST") {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      const to = await lineTarget();
      if (!to) return bad(process.env.LINE_CHANNEL_ACCESS_TOKEN ? "ยังไม่รู้จักกลุ่ม LINE: เชิญบอทเข้ากลุ่มแล้วพิมพ์อะไรก็ได้ 1 ข้อความ" : "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN");
      await linePush(to, "✅ ทดสอบแจ้งเตือนจากเว็บไซต์โรงแรมเทพนคร ระบบเชื่อมต่อ LINE เรียบร้อย");
      return J({ ok: true });
    }
    return bad("ไม่พบ API นี้", 404);
  } catch (e) {
    console.log("error", e && e.stack);
    return bad(e && e.message ? e.message : "เกิดข้อผิดพลาด", 500);
  }
}

// ---------- images ----------
async function serveBlob(id, url) {
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response("Not found", { status: 404 });
  try {
    const r = await get("img/" + id, { access: "private" });
    if (r && r.statusCode === 200)
      return new Response(r.stream, { headers: { "content-type": r.blob.contentType || "image/jpeg", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
  } catch (e) { if (!/not.?found/i.test(String(e && e.name) + String(e && e.message))) console.log("blob", e.message); }
  if (SEED_IMAGES.has(id)) return Response.redirect(new URL("/seed-images/" + id + ".jpg", url), 302); // รูปเดิมจากเว็บต้นแบบ
  return new Response("Not found", { status: 404 });
}

// ---------- booking creation ----------
async function createBooking(req, u) {
  const b = await readJson(req, 20_000);
  if (b.website) return J({ ok: true, item: { id: "TPN-0" } }); // กันบอท
  const staff = isAdmin(u) && b.source === "staff";
  const name = str(b.name, 100), phone = str(b.phone, 30);
  if (!name || (!staff && phone.replace(/\D/g, "").length < 6)) return bad("กรุณาใส่ชื่อและเบอร์โทรให้ถูกต้อง");
  const content = { ...((await getDoc("site/content")) || {}) };
  const base = { id: "TPN-" + rand(4).toUpperCase(), source: staff ? "staff" : "web", name, phone, email: str(b.email, 120), note: str(b.note, 1000), createdAt: nowIso() };
  let item, payment = null;

  if (b.type === "inquiry") {
    item = { ...base, type: "inquiry", kind: str(b.kind, 60) || "ห้องประชุม", checkin: isDate(b.checkin) ? b.checkin : "", guests: Math.max(0, Math.min(10000, +b.guests || 0)), status: "new", total: 0 };
  } else {
    const room = await getDoc("rooms/" + (ID.test(String(b.roomId)) ? b.roomId : "_"));
    if (!room || (room.active === false && !staff)) return bad("ไม่พบประเภทห้องนี้");
    const ci = b.checkin, co = b.checkout;
    if (!isDate(ci) || !isDate(co)) return bad("วันที่ไม่ถูกต้อง");
    const n = nightsOf(ci, co);
    if (n < 1 || n > 60) return bad("จำนวนคืนต้องอยู่ระหว่าง 1–60 คืน");
    if (!staff && ci < bkkToday()) return bad("วันเช็คอินต้องไม่ใช่วันที่ผ่านมาแล้ว");
    const qty = Math.max(1, Math.min(20, Math.round(+b.qty || 1)));
    const guests = Math.max(1, Math.min(200, Math.round(+b.guests || 1)));
    let total = 0;
    for (let d = ci; d < co; d = addDays(d, 1)) total += nightPrice(content, room, d);
    total *= qty;
    if (staff && b.total !== undefined && +b.total >= 0) total = Math.round(+b.total);
    item = { ...base, type: "booking", roomId: b.roomId, roomName: room.name, price: room.price, checkin: ci, checkout: co, nights: n, qty, guests, total, status: staff && STATUS_TH[b.status] ? b.status : "new" };
    item._units = room.units || 0;

    const pay = (await getDoc("payment/config")) || {};
    const dep = Math.round((total * (+pay.depositPct || 0)) / 100);
    if (!staff && process.env.OMISE_SECRET_KEY && dep >= 20 && dep <= 150000) {
      try {
        const charge = await omise("POST", "/charges", {
          amount: String(dep * 100), currency: "THB", "source[type]": "promptpay",
          description: `มัดจำการจอง ${item.id}`, "metadata[booking_id]": item.id, expires_at: new Date(Date.now() + 60 * 60e3).toISOString(),
        });
        const qr = charge.source && charge.source.scannable_code && charge.source.scannable_code.image && charge.source.scannable_code.image.download_uri;
        item.deposit = { amount: dep, status: "pending", chargeId: charge.id };
        payment = { provider: "omise", chargeId: charge.id, amount: dep, qr, expiresAt: charge.expires_at };
        await mutateCol("_payments", (col) => { col[charge.id] = { booking_id: item.id, amount: dep * 100, status: charge.status, qr_url: qr || null, created_at: nowIso(), updated_at: nowIso() }; });
      } catch (e) { console.log("omise charge failed", e.message); item.deposit = { amount: dep, status: "unpaid" }; }
    } else if (!staff && dep > 0) item.deposit = { amount: dep, status: "unpaid" };
  }

  // เพิ่มรายการ + เช็คห้องเต็มในขั้นตอนเดียว (กันจองเกินเมื่อมีคนจองพร้อมกัน)
  const units = item._units; delete item._units;
  const docId = (staff ? "staff-" : "web-") + bkkMonth();
  const full = await mutateCol("inbox", (col) => {
    if (item.type === "booking" && units > 0) {
      const map = bookedMap(Object.values(col).flatMap((d) => d.items || []));
      let mx = 0;
      for (let d = item.checkin; d < item.checkout; d = addDays(d, 1)) mx = Math.max(mx, (map[d] && map[d][item.roomId]) || 0);
      if (mx + item.qty > units) return true;
    }
    col[docId] = col[docId] || { items: [] };
    col[docId].items.push(item);
    return false;
  });
  if (full) return bad("ห้องประเภทนี้เต็มในวันที่เลือก ลองเปลี่ยนวันหรือประเภทห้อง", 409);
  await notify(bookingText(item, content.name), { event: item.type === "inquiry" ? "inquiry.created" : "booking.created", hotel: content.nameEn || "Thepnakorn Hotel", data: item });
  return J({ ok: true, item, payment });
}

// ---------- webhooks ----------
async function lineWebhook(req) {
  const body = await req.text();
  if (!process.env.LINE_CHANNEL_SECRET) return bad("ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET", 500);
  const sig = createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(body).digest("base64");
  if (!safeEq(sig, req.headers.get("x-line-signature") || "")) return bad("signature ไม่ถูกต้อง", 401);
  const { events = [] } = JSON.parse(body || "{}");
  for (const ev of events) {
    const gid = ev.source && (ev.source.groupId || ev.source.roomId);
    if (gid) await putDoc("settings/line_runtime", { groupId: gid, at: nowIso() });
    if (ev.type === "join" && ev.replyToken && process.env.LINE_CHANNEL_ACCESS_TOKEN)
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.LINE_CHANNEL_ACCESS_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: "เชื่อมต่อกลุ่มนี้กับเว็บไซต์โรงแรมเทพนครแล้ว ✅\nการจองและคำขอใหม่จะแจ้งเตือนในกลุ่มนี้" }] }),
      }).catch(() => {});
  }
  return J({ ok: true });
}
async function omiseWebhook(req) {
  try {
    const ev = await readJson(req);
    if (process.env.OMISE_SECRET_KEY && ev && ev.key === "charge.complete" && ev.data && /^chrg_/.test(ev.data.id || ""))
      await applyCharge(await omise("GET", "/charges/" + ev.data.id));
  } catch (e) { console.log("omise webhook", e.message); }
  return J({ ok: true });
}
