// สร้าง lib/seed-data.js (ข้อมูลเริ่มต้น) และคัดลอกรูปเดิมไป public/seed-images สำหรับ Vercel
import { readdirSync, readFileSync, writeFileSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const root = new URL("../seed/export/", import.meta.url).pathname;
const out = {};
for (const col of readdirSync(root)) {
  if (!statSync(join(root, col)).isDirectory()) continue;
  out[col] = {};
  for (const f of readdirSync(join(root, col)).filter((x) => x.endsWith(".json"))) out[col][f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(root, col, f), "utf8"));
}
const imgDir = new URL("../seed/images/", import.meta.url).pathname, pub = new URL("../public/seed-images/", import.meta.url).pathname;
mkdirSync(pub, { recursive: true });
out.__images = [];
for (const f of readdirSync(imgDir)) { const m = f.match(/^([a-f0-9]{32})\.jpe?g$/); if (!m) continue; copyFileSync(imgDir + f, pub + m[1] + ".jpg"); out.__images.push(m[1]); }
writeFileSync(new URL("../lib/seed-data.js", import.meta.url), "// สร้างโดย scripts/build-vercel-seed.mjs — ข้อมูลตั้งต้นจากเว็บต้นแบบ\nexport default " + JSON.stringify(out, null, 1) + ";\n");
console.log("lib/seed-data.js:", Object.keys(out).join(", "), "· images:", out.__images.length);
