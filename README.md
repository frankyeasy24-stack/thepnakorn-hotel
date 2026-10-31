# เว็บไซต์โรงแรมเทพนคร (Cloudflare)

เว็บไซต์พร้อมระบบจองและหลังบ้าน ทำงานบน Cloudflare แบบฟรี:

| ส่วน | ใช้อะไร | หน้าที่ |
|---|---|---|
| หน้าเว็บ | Cloudflare Pages | แสดงเว็บไซต์ (ไฟล์ `public/`) |
| API | Pages Functions (`functions/`, `src/server.js`) | จอง, ล็อกอิน, สิทธิ์, อัปโหลดรูป, LINE, Omise |
| ฐานข้อมูล | D1 (`thepnakorn-db`) | ข้อมูลโรงแรม ห้องพัก การจอง ผู้ใช้ |
| รูปภาพ | Workers KV (`IMAGES`) | รูปที่อัปโหลดจากหลังบ้าน |

ข้อมูลและรูปทั้งหมดจากเว็บต้นแบบอยู่ในโฟลเดอร์ `seed/` แล้ว ติดตั้งครั้งแรกจะได้ข้อมูลชุดเดิมครบ

---

## 1. สิ่งที่ต้องมี

1. บัญชี Cloudflare (สมัครฟรีที่ https://dash.cloudflare.com/sign-up ไม่ต้องใช้บัตรเครดิต)
2. Node.js เวอร์ชัน 18 ขึ้นไป (ดาวน์โหลดที่ https://nodejs.org เลือกเวอร์ชัน LTS)
3. เปิดโปรแกรม Terminal (Mac) หรือ PowerShell (Windows) แล้วเข้าไปที่โฟลเดอร์นี้

## 2. ติดตั้งขึ้นเว็บจริง (ทำครั้งเดียว ประมาณ 15 นาที)

```bash
# 2.1 ติดตั้งเครื่องมือ และล็อกอิน Cloudflare (จะเปิดเบราว์เซอร์ให้กดอนุญาต)
npm install
npx wrangler login

# 2.2 สร้างฐานข้อมูล แล้วคัดลอก database_id ที่ได้ ไปใส่ใน wrangler.toml
npx wrangler d1 create thepnakorn-db

# 2.3 สร้างที่เก็บรูป แล้วคัดลอก id ที่ได้ ไปใส่ใน wrangler.toml (ใต้ [[kv_namespaces]])
npx wrangler kv namespace create IMAGES

# 2.4 สร้างโปรเจกต์เว็บ
npx wrangler pages project create thepnakorn --production-branch main

# 2.5 ใส่ข้อมูลเดิมและรูปเดิมทั้งหมด
npm run db:init:remote
npm run images:remote

# 2.6 ตั้งรหัสติดตั้ง (คิดเองเป็นข้อความยาวๆ ใช้ครั้งเดียวตอนสร้างบัญชีเจ้าของ)
npx wrangler pages secret put SETUP_TOKEN --project-name thepnakorn

# 2.7 อัปโหลดเว็บ
npm run deploy
```

เสร็จแล้วจะได้ลิงก์เว็บ เช่น `https://thepnakorn.pages.dev`

## 3. สร้างบัญชีเจ้าของ

1. เปิด `https://thepnakorn.pages.dev/#admin` (หรือกด "สำหรับพนักงาน" ที่ท้ายเว็บ)
2. ใส่ **รหัสติดตั้ง** จากข้อ 2.6 พร้อมชื่อ อีเมล และรหัสผ่านของคุณ
3. ระบบจะสร้างบัญชี **เจ้าของ** ให้ทันที หลังจากนั้นหน้านี้จะใช้สร้างบัญชีซ้ำไม่ได้อีก

**เพิ่มแอดมิน:** หลังบ้าน → "สิทธิ์และประวัติ" → "เพิ่มแอดมิน" ใส่ชื่อ อีเมล และรหัสผ่านเริ่มต้น แล้วส่งให้พนักงาน
พนักงานเปลี่ยนรหัสเองได้ที่ "บัญชีของฉัน"

| | เจ้าของ | แอดมิน |
|---|---|---|
| การจอง ห้องว่าง รายงาน บันทึกการจอง | ✓ | ✓ |
| แก้ราคา รูป ข้อมูลโรงแรม โปรโมชั่น | ✓ | ✓ |
| ลบประเภทห้อง | ✓ | – |
| พร้อมเพย์ / API / บัญชีผู้ใช้ / ประวัติการแก้ไข | ✓ | – |

สิทธิ์ทั้งหมดตรวจที่เซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนปุ่ม

## 4. เชื่อมต่อ LINE (แจ้งเตือนการจองเข้ากลุ่มพนักงาน)

> LINE Notify ปิดให้บริการไปแล้ว ระบบนี้ใช้ **LINE Messaging API** (บอทของ LINE Official Account) แทน

1. ไปที่ https://developers.line.biz → สร้าง Provider → สร้าง channel ประเภท **Messaging API** (จะได้ LINE Official Account มาด้วย)
2. แท็บ **Basic settings** → คัดลอก **Channel secret**
3. แท็บ **Messaging API**:
   - กด Issue **Channel access token (long-lived)** แล้วคัดลอก
   - **Webhook URL**: ใส่ `https://thepnakorn.pages.dev/api/line/webhook` แล้วเปิด **Use webhook**
   - เปิด **Allow bot to join group chats**
   - ใน LINE Official Account Manager ปิด "ข้อความตอบกลับอัตโนมัติ" (Auto-reply) เพื่อไม่ให้บอทตอบมั่ว
4. ใส่รหัสลับ แล้ว deploy ใหม่:
   ```bash
   npx wrangler pages secret put LINE_CHANNEL_SECRET --project-name thepnakorn
   npx wrangler pages secret put LINE_CHANNEL_ACCESS_TOKEN --project-name thepnakorn
   npm run deploy
   ```
5. เชิญบอทเข้ากลุ่ม LINE ของพนักงาน → บอทจะตอบว่า "เชื่อมต่อกลุ่มนี้กับเว็บไซต์โรงแรมเทพนครแล้ว"
6. หลังบ้าน → "เชื่อมต่อ API และการชำระเงิน" → กด **ส่งข้อความทดสอบเข้า LINE**

ทุกครั้งที่มีคำขอจองห้อง จองโต๊ะ หรือขอใบเสนอราคา และเมื่อได้รับเงินมัดจำ ระบบจะแจ้งเข้ากลุ่มทันที

## 5. รับชำระเงินมัดจำออนไลน์ (Omise · พร้อมเพย์ QR)

1. สมัคร https://www.omise.co (Opn Payments) และ **อีเมลไปที่ support@omise.co เพื่อขอเปิดใช้ PromptPay**
2. Dashboard → Keys → คัดลอก **Secret key** (เริ่มด้วย `skey_test_` สำหรับทดสอบ หรือ `skey_` สำหรับใช้งานจริง)
3. Dashboard → Webhooks → เพิ่ม `https://thepnakorn.pages.dev/api/omise/webhook`
4. ใส่รหัสลับ แล้ว deploy ใหม่:
   ```bash
   npx wrangler pages secret put OMISE_SECRET_KEY --project-name thepnakorn
   npm run deploy
   ```
5. หลังบ้าน → "เชื่อมต่อ API และการชำระเงิน" → การ์ดพร้อมเพย์ → ตั้ง **มัดจำ (%)** เช่น 30

**ขั้นตอนการชำระเงิน**
- ลูกค้าจองห้อง → ระบบสร้าง QR พร้อมเพย์ของ Omise ตามยอดมัดจำ (QR มีอายุ 60 นาที)
- ลูกค้าสแกนจ่าย → การจองเปลี่ยนเป็น **ยืนยันแล้ว** อัตโนมัติ → แจ้งเข้า LINE

**ทดสอบในโหมด test:** เปิด charge ใน Omise Dashboard → Actions → Mark as Successful

ถ้ายังไม่ได้ใส่ Omise key แต่ใส่เลขพร้อมเพย์ไว้ ระบบจะแสดง QR พร้อมเพย์ธรรมดา ให้ลูกค้าส่งสลิปเอง

## 6. ใช้โดเมนของโรงแรม

Cloudflare Dashboard → Workers & Pages → thepnakorn → **Custom domains** → ใส่โดเมน เช่น `www.thepnakornhotel.com`
อย่าลืมเปลี่ยน Webhook URL ใน LINE และ Omise ให้เป็นโดเมนใหม่ด้วย

## 7. งานประจำ

| ต้องการ | คำสั่ง |
|---|---|
| แก้หน้าตาเว็บ | แก้ `src/page.html` แล้ว `npm run deploy` |
| สำรองข้อมูล | `npx wrangler d1 export thepnakorn-db --remote --output backup.sql` |
| ดู log ข้อผิดพลาด | Cloudflare Dashboard → thepnakorn → Functions → Real-time logs |

## 8. ทดสอบในเครื่องตัวเอง (ไม่กระทบเว็บจริง)

```bash
cp .dev.vars.example .dev.vars      # แล้วแก้ SETUP_TOKEN ในไฟล์
npm run db:init:local
npm run images:local
npm run dev                          # เปิด http://localhost:8788
```

## โควตาฟรีที่ควรรู้

- Workers/Pages Functions: 100,000 request ต่อวัน
- D1 และ KV มีโควตาอ่าน/เขียนรายวัน ถ้าเกินจะใช้ไม่ได้จนถึง 07:00 น. (เวลาไทย) ของวันถัดไป
- รูปอัปโหลดได้ไม่เกิน 10 MB ต่อรูป (ควรย่อรูปให้เหลือ 1–2 MB จะโหลดเร็วกว่า)

ถ้าโรงแรมมีคนเข้าเว็บมาก ค่อยอัปเกรดเป็น Workers Paid (ประมาณ 5 ดอลลาร์ต่อเดือน)

## ความปลอดภัย

- **รหัสผ่าน:** เข้ารหัสแบบ PBKDF2 และล็อกอินผิดเกิน 10 ครั้งใน 15 นาทีจะถูกพักการล็อกอิน
- **รหัสลับต่าง ๆ:** LINE token, Omise secret key และ SETUP_TOKEN เก็บเป็น secret บน Cloudflare ไม่อยู่ในโค้ดหรือหน้าเว็บ
- **การชำระเงิน:** ยืนยันโดยดึงสถานะจาก Omise โดยตรงทุกครั้ง ไม่เชื่อข้อมูลใน webhook
- **กันสแปม:** จำกัดการส่งคำขอจองไม่เกิน 12 ครั้งต่อชั่วโมงต่อ IP
- **ราคา:** คำนวณใหม่ที่เซิร์ฟเวอร์ทุกครั้ง ลูกค้าแก้ราคาเองจากหน้าเว็บไม่ได้
