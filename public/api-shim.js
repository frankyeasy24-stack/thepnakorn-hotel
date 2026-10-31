// ตัวเชื่อมหน้าเว็บกับ API บน Cloudflare
// หน้าเว็บเขียนไว้ให้ใช้ window.claude.use("db" | "user" | "assets" | "downloads")
// ไฟล์นี้จำลอง interface เดียวกัน แต่ส่งข้อมูลไปที่ /api/* ของเราเอง
(() => {
  const H = { "Content-Type": "application/json", "X-Requested-With": "thepnakorn" };
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: H, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || "เกิดข้อผิดพลาด (" + r.status + ")"); e.code = r.status === 401 || r.status === 403 ? "invalid_argument" : "unavailable"; e.status = r.status; throw e; }
    return data;
  }
  let me = null, setupNeeded = false;
  const ready = api("GET", "/api/me").then((x) => { me = x.user; setupNeeded = !!x.setupNeeded; }).catch(() => {});

  // ----- realtime แบบ polling (เฉพาะคนที่ล็อกอิน เพื่อประหยัดโควตาฐานข้อมูล) -----
  const subs = new Set();
  const refreshAll = () => subs.forEach((s) => s.poll());
  setInterval(() => { if (me && !document.hidden) refreshAll(); }, 15000);
  document.addEventListener("visibilitychange", () => { if (me && !document.hidden) refreshAll(); });

  const snap = (id, exists, data) => ({ id, exists, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  const enc = encodeURIComponent;
  function docRef(path) {
    const id = path.split("/").pop();
    const url = "/api/doc?path=" + enc(path);
    return {
      id, path,
      async get() { const r = await api("GET", url); return snap(id, r.exists, r.data); },
      async set(d) { await api("PUT", url, d); refreshAll(); },
      async update(d) { await api("PATCH", url, d); refreshAll(); },
      async delete() { await api("DELETE", url); refreshAll(); },
      onSnapshot(next, err) {
        let last = null;
        const s = { poll: async () => { try { const r = await api("GET", url); const k = JSON.stringify(r); if (k !== last) { last = k; next(snap(id, r.exists, r.data)); } } catch (e) { err && err({ code: "unavailable", message: e.message }); } } };
        subs.add(s); s.poll();
        return () => subs.delete(s);
      },
      collection: (p) => colRef(path + "/" + p),
    };
  }
  function colRef(path) {
    const url = "/api/col?path=" + enc(path);
    const toSnap = (r) => { const docs = r.docs.map((d) => snap(d.id, true, d.data)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
    const q = {
      path,
      doc: (id) => docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))),
      async add(d) { const ref = q.doc(); await ref.set(d); return ref; },
      async get() { return toSnap(await api("GET", url)); },
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      onSnapshot(next, err) {
        let last = null;
        const s = { poll: async () => { try { const r = await api("GET", url); const k = JSON.stringify(r); if (k !== last) { last = k; next(toSnap(r)); } } catch (e) { err && err({ code: "unavailable", message: e.message }); } } };
        subs.add(s); s.poll();
        return () => subs.delete(s);
      },
    };
    return q;
  }
  const db = { doc: docRef, collection: colRef };

  const user = {
    canEdit: async () => { await ready; return !!me; },
    isOwner: async () => { await ready; return !!me && me.role === "owner"; },
    id: async () => { await ready; return me ? me.id : null; },
    can: async () => { await ready; return !!me; },
    profiles: async (ids) => {
      const r = await api("GET", "/api/users/names?ids=" + enc(ids.join(",")));
      return Object.fromEntries(ids.map((i) => [i, { name: (r[i] && r[i].name) || "" }]));
    },
  };
  const assets = {
    async upload(blob) {
      const r = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream", "X-Requested-With": "thepnakorn" }, body: blob, credentials: "same-origin" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "อัปโหลดไม่สำเร็จ");
      return d;
    },
  };
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
  };

  window.claude = {
    async use(name) {
      await ready;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return me ? assets : null;
      if (name === "downloads") return me ? downloads : null;
      return null;
    },
  };

  // ฟังก์ชันเฉพาะเซิร์ฟเวอร์ที่หน้าเว็บเรียกใช้
  window.hotelAuth = {
    me: () => me,
    setupNeeded: () => setupNeeded,
    login: (email, password) => api("POST", "/api/login", { email, password }),
    logout: () => api("POST", "/api/logout", {}),
    setup: (b) => api("POST", "/api/setup", b),
    changePassword: (current, password) => api("POST", "/api/me/password", { current, password }),
    book: (item) => api("POST", "/api/bookings", item),
    setStatus: (id, status) => api("PATCH", "/api/bookings/" + enc(id), { status }).then((r) => { refreshAll(); return r; }),
    paymentStatus: (id) => api("GET", "/api/bookings/" + enc(id) + "/payment").then((r) => r.status),
    integrationStatus: () => api("GET", "/api/integrations/status"),
    testLine: () => api("POST", "/api/integrations/test-line", {}),
    users: {
      list: () => api("GET", "/api/users").then((r) => r.users),
      create: (b) => api("POST", "/api/users", b),
      update: (id, b) => api("PATCH", "/api/users/" + enc(id), b),
      remove: (id) => api("DELETE", "/api/users/" + enc(id)),
    },
  };
})();
