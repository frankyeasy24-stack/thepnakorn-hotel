// =====================================================================
//  Thepnakorn Hotel — API บน Cloudflare Pages Functions + D1 + KV
//  ทุก request ที่ขึ้นต้นด้วย /api/ จะเข้ามาที่ handle() ในไฟล์นี้
// =====================================================================

const SESSION_DAYS = 14;
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB ต่อรูป
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const HOLD = ["new", "waiting", "confirmed", "checkedin"];
const STATUS_TH = { new: "ใหม่", waiting: "รอชำระมัดจำ", confirmed: "ยืนยันแล้ว", checkedin: "เช็คอินแล้ว", cancelled: "ยกเลิก" };

// ---------- small helpers ----------
const J = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const bad = (error, status = 400) => J({ error }, status);
const nowIso = () => new Date().toISOString();
const bkkToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const bkkMonth = () => bkkToday().slice(0, 7);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n = 16) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); };
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nightsOf = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const baht = (n) => Number(n || 0).toLocaleString("th-TH");
const isAdmin = (u) => !!u && (u.role === "admin" || u.role === "owner");
const isOwner = (u) => !!u && u.role === "owner";

function validPath(p, even) {
  if (typeof p !== "string") return false;
  const s = p.split("/");
  if (!s.length || s.length > 8 || s.some((x) => !SEG.test(x) || x === "." || x === "..")) return false;
  return even ? s.length % 2 === 0 : s.length % 2 === 1;
}
function cookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function pbkdf2(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
}
async function readJson(req, max = 300_000) {
  const t = await req.text();
  if (t.length > max) throw new Error("ข้อมูลใหญ่เกินไป");
  return t ? JSON.parse(t) : {};
}

// ---------- docs store ----------
async function getDoc(env, path) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE path=?").bind(path).first();
  return r ? JSON.parse(r.data) : null;
}
async function putDoc(env, path, data) {
  const parent = path.split("/").slice(0, -1).join("/");
  await env.DB.prepare(
    "INSERT INTO docs(path,parent,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
  ).bind(path, parent, JSON.stringify(data), nowIso()).run();
}
function deepMerge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) o[k] = deepMerge(o[k], v);
    else o[k] = v;
  }
  return o;
}

// สิทธิ์อ่าน/เขียนตาม path (ตรงกับระบบสิทธิ์ในหลังบ้าน)
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
  if (top === "rooms" && method === "DELETE") return isOwner(u); // ลบประเภทห้อง: เจ้าของเท่านั้น
  if (top === "inbox") return false; // การจองแก้ผ่าน /api/bookings เท่านั้น เพื่อไม่ให้ข้อมูลทับกัน
  if (top === "availability") return isAdmin(u); // ระบบคำนวณเอง การเขียนจะถูกข้าม
  return ["site", "rooms", "offers"].includes(top) && isAdmin(u);
}

// ---------- availability & pricing ----------
async function allInboxItems(env) {
  const { results } = await env.DB.prepare("SELECT path,data FROM docs WHERE parent='inbox'").all();
  return results.flatMap((r) => (JSON.parse(r.data).items || []).map((i) => ({ ...i, _doc: r.path })));
}
function bookedMap(items) {
  const m = {};
  for (const i of items) {
    if (i.type !== "booking" || !HOLD.includes(i.status) || !isDate(i.checkin) || !isDate(i.checkout)) continue;
    const n = nightsOf(i.checkin, i.checkout);
    if (n < 1 || n > 60) continue;
    for (let d = i.checkin; d < i.checkout; d = addDays(d, 1)) {
      m[d] = m[d] || {};
      m[d][i.roomId] = (m[d][i.roomId] || 0) + (+i.qty || 1);
    }
  }
  return m;
}
const seasonFor = (content, d) => (content.seasons || []).find((x) => x.from && x.to && d >= x.from && d <= x.to);
const nightPrice = (content, r, d) => { const x = seasonFor(content, d); return Math.round((+r.price || 0) * (1 + (x ? +x.pct || 0 : 0) / 100)); };

// ---------- users & sessions ----------
async function currentUser(env, req) {
  const t = cookie(req, "tpn_session");
  if (!t) return null;
  const row = await env.DB.prepare(
    "SELECT u.id,u.email,u.name,u.role,u.disabled,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?"
  ).bind(await sha256(t)).first();
  if (!row || row.disabled || row.expires_at < nowIso()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}
function sessionCookie(token, maxAge, secure) {
  return `tpn_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
async function createSession(env, userId, secure) {
  const token = rand(32);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)").bind(await sha256(token), userId, exp).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()).run();
  return sessionCookie(token, SESSION_DAYS * 86400, secure);
}
async function makeUser(env, { email, name, role, password }) {
  email = str(email, 120).toLowerCase();
  name = str(name, 80);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("อีเมลไม่ถูกต้อง");
  if (!name) throw new Error("กรุณาใส่ชื่อ");
  if (!["owner", "admin"].includes(role)) throw new Error("สิทธิ์ไม่ถูกต้อง");
  if (typeof password !== "string" || password.length < 8) throw new Error("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
  const salt = rand(16);
  const id = "u_" + rand(10);
  await env.DB.prepare("INSERT INTO users(id,email,name,role,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?,?,?)")
    .bind(id, email, name, role, await pbkdf2(password, salt), salt, nowIso()).run();
  return id;
}
// จำกัดจำนวนครั้ง (ล็อกอินผิด, ส่งคำขอจอง) ต่อ key ภายในช่วงเวลา
async function hit(env, key, limit, windowMin) {
  const row = await env.DB.prepare("SELECT count,reset_at FROM login_attempts WHERE key=?").bind(key).first();
  const now = nowIso();
  if (!row || row.reset_at < now) {
    await env.DB.prepare("INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1, reset_at=excluded.reset_at")
      .bind(key, new Date(Date.now() + windowMin * 60e3).toISOString()).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare("UPDATE login_attempts SET count=count+1 WHERE key=?").bind(key).run();
  return true;
}

// ---------- notifications: LINE + webhook ----------
async function lineTarget(env) {
  const integ = (await getDoc(env, "settings/integrations")) || {};
  const rt = (await getDoc(env, "settings/line_runtime")) || {};
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || (integ.line && integ.line.enabled === false)) return null;
  return (integ.line && integ.line.groupId) || rt.groupId || null;
}
async function linePush(env, to, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!r.ok) throw new Error("LINE " + r.status + " " + (await r.text()).slice(0, 200));
}
async function notify(env, text, payload) {
  const jobs = [];
  try {
    const to = await lineTarget(env);
    if (to) jobs.push(linePush(env, to, text).catch((e) => console.log("line push failed", e.message)));
  } catch (e) { console.log("line", e.message); }
  try {
    const integ = (await getDoc(env, "settings/integrations")) || {};
    const wh = integ.webhook || {};
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
    `${it.roomName} × ${it.qty} ห้อง · ${it.guests} คน`,
    `${it.checkin} → ${it.checkout} (${it.nights} คืน)`,
    `ชื่อ: ${it.name}  โทร ${it.phone}${it.email ? "  " + it.email : ""}`,
    `ยอดรวม ${baht(it.total)} บาท${it.deposit ? ` · มัดจำ ${baht(it.deposit.amount)} บาท` : ""}`,
    it.note ? `หมายเหตุ: ${it.note}` : "",
    siteName ? `— ${siteName}` : "",
  ].filter(Boolean).join("\n");
}

// ---------- Omise ----------
async function omise(env, method, path, form) {
  const r = await fetch("https://api.omise.co" + path, {
    method,
    headers: { Authorization: "Basic " + btoa(env.OMISE_SECRET_KEY + ":"), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await r.json();
  if (!r.ok || data.object === "error") throw new Error("Omise: " + (data.message || r.status));
  return data;
}
async function findItem(env, bookingId) {
  return env.DB.prepare(
    "SELECT d.path AS path, j.key AS idx, j.value AS value FROM docs d, json_each(d.data,'$.items') j WHERE d.parent='inbox' AND json_extract(j.value,'$.id')=?"
  ).bind(bookingId).first();
}
async function setItemFields(env, path, idx, fields) {
  for (const [k, v] of Object.entries(fields)) {
    await env.DB.prepare(`UPDATE docs SET data=json_set(data,'$.items[${Number(idx)}].${k}', json(?)), updated_at=? WHERE path=?`)
      .bind(JSON.stringify(v), nowIso(), path).run();
  }
}
// อัปเดตสถานะการชำระเงิน (เรียกจาก webhook หรือจากการเช็คสถานะ)
async function applyCharge(env, charge) {
  const pay = await env.DB.prepare("SELECT * FROM payments WHERE charge_id=?").bind(charge.id).first();
  if (!pay || pay.status === charge.status) return pay && pay.status;
  await env.DB.prepare("UPDATE payments SET status=?, updated_at=? WHERE charge_id=?").bind(charge.status, nowIso(), charge.id).run();
  const row = await findItem(env, pay.booking_id);
  if (row) {
    const item = JSON.parse(row.value);
    const fields = { deposit: { ...(item.deposit || {}), status: charge.status === "successful" ? "paid" : charge.status, chargeId: charge.id } };
    if (charge.status === "successful" && ["new", "waiting"].includes(item.status)) fields.status = "confirmed";
    await setItemFields(env, row.path, row.idx, fields);
    if (charge.status === "successful")
      await notify(env, `💰 ได้รับเงินมัดจำ ${baht(pay.amount / 100)} บาท\nการจอง ${item.id} · ${item.name}\nสถานะเปลี่ยนเป็น "ยืนยันแล้ว"`, { event: "booking.paid", data: { ...item, ...fields } });
  }
  return charge.status;
}

// =====================================================================
//  Router
// =====================================================================
export async function handle({ request: req, env, waitUntil }) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const m = req.method;
  const secure = url.protocol === "https:";
  const bg = (promise) => (waitUntil ? waitUntil(promise) : promise);

  if (!env.DB) return bad("ยังไม่ได้ผูกฐานข้อมูล D1 (binding DB)", 500);

  // webhook จากภายนอก ไม่ต้องมี header ของหน้าเว็บ
  if (p === "line/webhook" && m === "POST") return lineWebhook(req, env);
  if (p === "omise/webhook" && m === "POST") return omiseWebhook(req, env);

  // กัน CSRF: request ที่เปลี่ยนข้อมูลต้องมาจากหน้าเว็บของเราเท่านั้น
  if (m !== "GET" && m !== "HEAD" && req.headers.get("x-requested-with") !== "thepnakorn") return bad("คำขอไม่ถูกต้อง", 403);

  try {
    const u = await currentUser(env, req);

    // ----- auth -----
    if (p === "me" && m === "GET") return J({ user: u, setupNeeded: !(await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first()) });
    if (p === "login" && m === "POST") {
      const ip = req.headers.get("cf-connecting-ip") || "local";
      const b = await readJson(req);
      if (!(await hit(env, "login:" + ip, 10, 15))) return bad("ล็อกอินผิดหลายครั้งเกินไป ลองใหม่ใน 15 นาที", 429);
      const row = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(str(b.email, 120).toLowerCase()).first();
      const ok = row && !row.disabled && safeEq(await pbkdf2(String(b.password || ""), row.pass_salt), row.pass_hash);
      if (!ok) { await new Promise((r) => setTimeout(r, 400)); return bad("อีเมลหรือรหัสผ่านไม่ถูกต้อง", 401); }
      await env.DB.prepare("DELETE FROM login_attempts WHERE key=?").bind("login:" + ip).run();
      return J({ ok: true }, 200, { "set-cookie": await createSession(env, row.id, secure) });
    }
    if (p === "logout" && m === "POST") {
      const t = cookie(req, "tpn_session");
      if (t) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256(t)).run();
      return J({ ok: true }, 200, { "set-cookie": sessionCookie("", 0, secure) });
    }
    if (p === "setup" && m === "POST") {
      if (await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first()) return bad("ตั้งค่าเจ้าของไปแล้ว", 403);
      const b = await readJson(req);
      if (!env.SETUP_TOKEN || !safeEq(String(b.token || ""), env.SETUP_TOKEN)) return bad("รหัสติดตั้ง (SETUP_TOKEN) ไม่ถูกต้อง", 403);
      const id = await makeUser(env, { ...b, role: "owner" });
      return J({ ok: true }, 200, { "set-cookie": await createSession(env, id, secure) });
    }
    if (p === "me/password" && m === "POST") {
      if (!u) return bad("กรุณาเข้าสู่ระบบ", 401);
      const b = await readJson(req);
      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first();
      if (!safeEq(await pbkdf2(String(b.current || ""), row.pass_salt), row.pass_hash)) return bad("รหัสผ่านเดิมไม่ถูกต้อง", 400);
      if (typeof b.password !== "string" || b.password.length < 8) return bad("รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร");
      const salt = rand(16);
      await env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?").bind(await pbkdf2(b.password, salt), salt, u.id).run();
      return J({ ok: true });
    }

    // ----- users (เจ้าของจัดการ) -----
    if (p === "users/names" && m === "GET") {
      if (!isAdmin(u)) return J({});
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 64);
      if (!ids.length) return J({});
      const { results } = await env.DB.prepare(`SELECT id,name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
      return J(Object.fromEntries(results.map((r) => [r.id, { name: r.name }])));
    }
    if (p === "users") {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      if (m === "GET") {
        const { results } = await env.DB.prepare("SELECT id,email,name,role,disabled,created_at FROM users ORDER BY created_at").all();
        return J({ users: results });
      }
      if (m === "POST") { const b = await readJson(req); return J({ id: await makeUser(env, { ...b, role: b.role === "owner" ? "owner" : "admin" }) }); }
    }
    const um = p.match(/^users\/(u_[a-f0-9]+)$/);
    if (um) {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      const id = um[1];
      if (id === u.id && m !== "PATCH") return bad("ลบบัญชีตัวเองไม่ได้");
      if (m === "DELETE") {
        await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
        await env.DB.prepare("DELETE FROM users WHERE id=?").bind(id).run();
        return J({ ok: true });
      }
      if (m === "PATCH") {
        const b = await readJson(req);
        if (b.name) await env.DB.prepare("UPDATE users SET name=? WHERE id=?").bind(str(b.name, 80), id).run();
        if (b.role && id !== u.id && ["owner", "admin"].includes(b.role)) await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(b.role, id).run();
        if (typeof b.disabled === "boolean" && id !== u.id) {
          await env.DB.prepare("UPDATE users SET disabled=? WHERE id=?").bind(b.disabled ? 1 : 0, id).run();
          if (b.disabled) await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
        }
        if (b.password) {
          if (b.password.length < 8) return bad("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
          const salt = rand(16);
          await env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?").bind(await pbkdf2(b.password, salt), salt, id).run();
          await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id).run();
        }
        return J({ ok: true });
      }
    }

    // ----- generic documents -----
    if (p === "doc") {
      const path = url.searchParams.get("path");
      if (!validPath(path, true)) return bad("path ไม่ถูกต้อง");
      if (m === "GET") {
        if (path === "availability/summary") {
          const map = bookedMap(await allInboxItems(env)), today = bkkToday(), days = {};
          for (const d of Object.keys(map)) if (d >= today) days[d] = map[d];
          return J({ exists: true, data: { days } });
        }
        if (!canRead(path, u)) return J({ exists: false });
        const d = await getDoc(env, path);
        return J({ exists: !!d, data: d || undefined });
      }
      if (!canWrite(path, u, m)) return bad(u ? "บัญชีนี้ไม่มีสิทธิ์แก้ข้อมูลส่วนนี้" : "กรุณาเข้าสู่ระบบ", u ? 403 : 401);
      if (path.startsWith("availability/")) return J({ ok: true }); // ระบบคำนวณเองจากการจอง
      if (m === "PUT") { const b = await readJson(req); if (!b || typeof b !== "object" || Array.isArray(b)) return bad("ข้อมูลต้องเป็น object"); await putDoc(env, path, b); return J({ ok: true }); }
      if (m === "PATCH") {
        const cur = await getDoc(env, path);
        if (!cur) return bad("ไม่พบข้อมูลที่จะแก้ไข", 404);
        await putDoc(env, path, deepMerge(cur, await readJson(req)));
        return J({ ok: true });
      }
      if (m === "DELETE") { await env.DB.prepare("DELETE FROM docs WHERE path=?").bind(path).run(); return J({ ok: true }); }
    }
    if (p === "col" && m === "GET") {
      const path = url.searchParams.get("path");
      if (!validPath(path, false)) return bad("path ไม่ถูกต้อง");
      const { results } = await env.DB.prepare("SELECT path,data FROM docs WHERE parent=? ORDER BY path").bind(path).all();
      return J({ docs: results.filter((r) => canRead(r.path, u)).map((r) => ({ id: r.path.split("/").pop(), data: JSON.parse(r.data) })) });
    }

    // ----- uploads -----
    if (p === "assets" && m === "POST") {
      if (!isAdmin(u)) return bad("กรุณาเข้าสู่ระบบ", 401);
      if (!env.IMAGES) return bad("ยังไม่ได้ผูก KV สำหรับเก็บรูป (binding IMAGES)", 500);
      const type = (req.headers.get("content-type") || "").split(";")[0];
      if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return bad("รองรับเฉพาะไฟล์รูป JPG, PNG, WEBP, GIF, AVIF");
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_UPLOAD) return bad("รูปใหญ่เกิน 10 MB กรุณาย่อรูปก่อน");
      const id = rand(16);
      await env.IMAGES.put(id, buf, { metadata: { contentType: type, size: buf.byteLength, by: u.id, at: nowIso() } });
      return J({ id, url: "/_blob/" + id, sizeBytes: buf.byteLength, contentType: type });
    }

    // ----- bookings -----
    if (p === "bookings" && m === "POST") return createBooking(req, env, u, bg);
    const bm = p.match(/^bookings\/(TPN-[A-Z0-9]+)(\/payment)?$/);
    if (bm && bm[2] && m === "GET") {
      const pay = await env.DB.prepare("SELECT * FROM payments WHERE booking_id=? ORDER BY created_at DESC").bind(bm[1]).first();
      if (!pay) return J({ status: "none" });
      let status = pay.status;
      if (status === "pending" && env.OMISE_SECRET_KEY) {
        try { status = await applyCharge(env, await omise(env, "GET", "/charges/" + pay.charge_id)); } catch (e) { console.log(e.message); }
      }
      return J({ status });
    }
    if (bm && !bm[2] && m === "PATCH") {
      if (!isAdmin(u)) return bad("กรุณาเข้าสู่ระบบ", 401);
      const b = await readJson(req);
      const row = await findItem(env, bm[1]);
      if (!row) return bad("ไม่พบการจองนี้", 404);
      const fields = {};
      if (b.status) { if (!STATUS_TH[b.status]) return bad("สถานะไม่ถูกต้อง"); fields.status = b.status; }
      if (typeof b.staffNote === "string") fields.staffNote = str(b.staffNote, 500);
      await setItemFields(env, row.path, row.idx, fields);
      return J({ ok: true });
    }

    // ----- integrations (เจ้าของ) -----
    if (p === "integrations/status" && m === "GET") {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      const rt = (await getDoc(env, "settings/line_runtime")) || {};
      return J({
        line: { token: !!env.LINE_CHANNEL_ACCESS_TOKEN, secret: !!env.LINE_CHANNEL_SECRET, groupId: rt.groupId || null, groupSeenAt: rt.at || null },
        omise: { secret: !!env.OMISE_SECRET_KEY, mode: env.OMISE_SECRET_KEY ? (env.OMISE_SECRET_KEY.startsWith("skey_test") ? "test" : "live") : null },
        webhookUrls: { line: url.origin + "/api/line/webhook", omise: url.origin + "/api/omise/webhook" },
      });
    }
    if (p === "integrations/test-line" && m === "POST") {
      if (!isOwner(u)) return bad("เฉพาะเจ้าของ", 403);
      const to = await lineTarget(env);
      if (!to) return bad(env.LINE_CHANNEL_ACCESS_TOKEN ? "ยังไม่รู้จักกลุ่ม LINE: เชิญบอทเข้ากลุ่มแล้วพิมพ์อะไรก็ได้ 1 ข้อความ" : "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN");
      await linePush(env, to, "✅ ทดสอบแจ้งเตือนจากเว็บไซต์โรงแรมเทพนคร ระบบเชื่อมต่อ LINE เรียบร้อย");
      return J({ ok: true });
    }

    return bad("ไม่พบ API นี้", 404);
  } catch (e) {
    console.log("error", e && e.stack);
    return bad(e && e.message ? e.message : "เกิดข้อผิดพลาด", 500);
  }
}

// ---------- booking creation ----------
async function createBooking(req, env, u, bg) {
  const b = await readJson(req, 20_000);
  if (b.website) return J({ ok: true, item: { id: "TPN-0" } }); // กันบอท (ช่องซ่อน)
  const staff = isAdmin(u) && b.source === "staff";
  if (!staff) {
    const ip = req.headers.get("cf-connecting-ip") || "local";
    if (!(await hit(env, "book:" + ip, 12, 60))) return bad("ส่งคำขอบ่อยเกินไป กรุณาติดต่อโรงแรมทางโทรศัพท์", 429);
  }
  const name = str(b.name, 100), phone = str(b.phone, 30);
  if (!name || (!staff && phone.replace(/\D/g, "").length < 6)) return bad("กรุณาใส่ชื่อและเบอร์โทรให้ถูกต้อง");
  const content = { ...((await getDoc(env, "site/content")) || {}) };
  const base = { id: "TPN-" + rand(4).toUpperCase(), source: staff ? "staff" : "web", name, phone, email: str(b.email, 120), note: str(b.note, 1000), createdAt: nowIso() };
  let item, payment = null;

  if (b.type === "inquiry") {
    item = { ...base, type: "inquiry", kind: str(b.kind, 60) || "ห้องประชุม", checkin: isDate(b.checkin) ? b.checkin : "", guests: Math.max(0, Math.min(10000, +b.guests || 0)), status: "new", total: 0 };
  } else {
    const room = await getDoc(env, "rooms/" + str(b.roomId, 200));
    if (!room || (room.active === false && !staff)) return bad("ไม่พบประเภทห้องนี้");
    const ci = b.checkin, co = b.checkout;
    if (!isDate(ci) || !isDate(co)) return bad("วันที่ไม่ถูกต้อง");
    const n = nightsOf(ci, co);
    if (n < 1 || n > 60) return bad("จำนวนคืนต้องอยู่ระหว่าง 1–60 คืน");
    if (!staff && ci < bkkToday()) return bad("วันเช็คอินต้องไม่ใช่วันที่ผ่านมาแล้ว");
    const qty = Math.max(1, Math.min(20, Math.round(+b.qty || 1)));
    const guests = Math.max(1, Math.min(200, Math.round(+b.guests || 1)));
    if (room.units > 0) {
      const map = bookedMap(await allInboxItems(env));
      let mx = 0;
      for (let d = ci; d < co; d = addDays(d, 1)) mx = Math.max(mx, (map[d] && map[d][b.roomId]) || 0);
      if (mx + qty > room.units) return bad("ห้องประเภทนี้เต็มในวันที่เลือก ลองเปลี่ยนวันหรือประเภทห้อง", 409);
    }
    let total = 0;
    for (let d = ci; d < co; d = addDays(d, 1)) total += nightPrice(content, room, d);
    total *= qty;
    if (staff && b.total !== undefined && +b.total >= 0) total = Math.round(+b.total);
    const status = staff && STATUS_TH[b.status] ? b.status : "new";
    item = { ...base, type: "booking", roomId: b.roomId, roomName: room.name, price: room.price, checkin: ci, checkout: co, nights: n, qty, guests, total, status };

    // มัดจำผ่าน Omise (PromptPay QR) ถ้าตั้งค่าไว้
    const pay = (await getDoc(env, "payment/config")) || {};
    const dep = Math.round((total * (+pay.depositPct || 0)) / 100);
    if (!staff && env.OMISE_SECRET_KEY && dep >= 20 && dep <= 150000) {
      try {
        const charge = await omise(env, "POST", "/charges", {
          amount: String(dep * 100), currency: "THB", "source[type]": "promptpay",
          description: `มัดจำการจอง ${item.id}`, "metadata[booking_id]": item.id,
          expires_at: new Date(Date.now() + 60 * 60e3).toISOString(),
        });
        const qr = charge.source && charge.source.scannable_code && charge.source.scannable_code.image && charge.source.scannable_code.image.download_uri;
        item.deposit = { amount: dep, status: "pending", chargeId: charge.id };
        payment = { provider: "omise", chargeId: charge.id, amount: dep, qr, expiresAt: charge.expires_at };
        await env.DB.prepare("INSERT INTO payments(charge_id,booking_id,inbox_path,amount,status,qr_url,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(charge.id, item.id, "inbox/web-" + bkkMonth(), dep * 100, charge.status, qr || null, charge.expires_at || null, nowIso(), nowIso()).run();
      } catch (e) {
        console.log("omise charge failed", e.message);
        item.deposit = { amount: dep, status: "unpaid" };
      }
    } else if (!staff && dep > 0) item.deposit = { amount: dep, status: "unpaid" };
  }

  // เพิ่มรายการแบบ atomic (ไม่ทับรายการที่เข้ามาพร้อมกัน)
  const path = (staff ? "inbox/staff-" : "inbox/web-") + bkkMonth();
  const json = JSON.stringify(item), t = nowIso();
  await env.DB.prepare(
    "INSERT INTO docs(path,parent,data,updated_at) VALUES(?,'inbox',json_object('items',json_array(json(?))),?) ON CONFLICT(path) DO UPDATE SET data=json_set(data,'$.items[#]',json(?)), updated_at=?"
  ).bind(path, json, t, json, t).run();

  bg(notify(env, bookingText(item, content.name), { event: item.type === "inquiry" ? "inquiry.created" : "booking.created", hotel: content.nameEn || "Thepnakorn Hotel", data: item }));
  return J({ ok: true, item, payment });
}

// ---------- webhooks ----------
async function lineWebhook(req, env) {
  const body = await req.text();
  if (!env.LINE_CHANNEL_SECRET) return bad("ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET", 500);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
  if (!safeEq(sig, req.headers.get("x-line-signature") || "")) return bad("signature ไม่ถูกต้อง", 401);
  const { events = [] } = JSON.parse(body || "{}");
  for (const ev of events) {
    const gid = ev.source && (ev.source.groupId || ev.source.roomId);
    if (gid) await putDoc(env, "settings/line_runtime", { groupId: gid, at: nowIso() });
    if (ev.type === "join" && ev.replyToken && env.LINE_CHANNEL_ACCESS_TOKEN) {
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: "เชื่อมต่อกลุ่มนี้กับเว็บไซต์โรงแรมเทพนครแล้ว ✅\nการจองและคำขอใหม่จะแจ้งเตือนในกลุ่มนี้" }] }),
      }).catch(() => {});
    }
  }
  return J({ ok: true });
}
async function omiseWebhook(req, env) {
  try {
    const ev = await readJson(req);
    // ไม่เชื่อข้อมูลใน webhook ตรง ๆ: ดึง charge จาก Omise อีกครั้งเพื่อยืนยัน
    if (env.OMISE_SECRET_KEY && ev && ev.key === "charge.complete" && ev.data && /^chrg_/.test(ev.data.id || ""))
      await applyCharge(env, await omise(env, "GET", "/charges/" + ev.data.id));
  } catch (e) { console.log("omise webhook", e.message); }
  return J({ ok: true });
}
