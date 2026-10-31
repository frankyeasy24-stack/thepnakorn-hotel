// อัปโหลดรูปเดิมทั้งหมด (seed/images) เข้า KV
// ใช้: node scripts/upload-images.mjs --local   (ทดสอบในเครื่อง)
//      node scripts/upload-images.mjs --remote  (ขึ้นเว็บจริง)
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const mode = process.argv.includes("--remote") ? "--remote" : "--local";
const dir = new URL("../seed/images/", import.meta.url).pathname;
for (const f of readdirSync(dir)) {
  const m = f.match(/^([a-f0-9]{32})\.(jpe?g|png|webp|gif)$/);
  if (!m) continue;
  const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[m[2]];
  execFileSync("npx", ["wrangler", "kv", "key", "put", m[1], "--path", dir + f, "--binding", "IMAGES", "--metadata", JSON.stringify({ contentType: type }), mode], { stdio: "inherit" });
  console.log("uploaded", f);
}
