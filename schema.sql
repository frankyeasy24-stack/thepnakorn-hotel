-- โครงสร้างฐานข้อมูล D1 ของเว็บไซต์โรงแรมเทพนคร
-- docs   : ข้อมูลหน้าเว็บทั้งหมด (ข้อมูลโรงแรม ห้องพัก โปรโมชั่น การจอง ประวัติ) เก็บเป็น JSON ตาม path
-- users  : บัญชีเจ้าของและแอดมิน
-- sessions: การล็อกอิน
-- payments: รายการชำระเงินผ่าน Omise

CREATE TABLE IF NOT EXISTS docs (
  path       TEXT PRIMARY KEY,           -- เช่น site/content, rooms/standard, inbox/web-2026-10
  parent     TEXT NOT NULL,              -- collection เช่น site, rooms, inbox
  data       TEXT NOT NULL,              -- JSON
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin')),
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,             -- sha256 ของ token ใน cookie
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS payments (
  charge_id  TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  inbox_path TEXT NOT NULL,
  amount     INTEGER NOT NULL,             -- หน่วยสตางค์
  status     TEXT NOT NULL,
  qr_url     TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_booking ON payments(booking_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key        TEXT PRIMARY KEY,             -- ip หรือ email
  count      INTEGER NOT NULL,
  reset_at   TEXT NOT NULL
);
