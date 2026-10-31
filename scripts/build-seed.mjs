// สร้างไฟล์ seed/seed.sql จากข้อมูลที่ส่งออกจากเว็บต้นแบบ (seed/export/<collection>/<id>.json)
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = new URL("../seed/export/", import.meta.url).pathname;
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const lines = ["-- สร้างโดย scripts/build-seed.mjs"];
for (const col of readdirSync(root)) {
  if (!statSync(join(root, col)).isDirectory()) continue;
  for (const f of readdirSync(join(root, col)).filter((x) => x.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(root, col, f), "utf8"));
    const path = col + "/" + f.replace(/\.json$/, "");
    lines.push(`INSERT OR REPLACE INTO docs(path,parent,data,updated_at) VALUES(${q(path)},${q(col)},${q(JSON.stringify(data))},${q(new Date().toISOString())});`);
  }
}
writeFileSync(new URL("../seed/seed.sql", import.meta.url), lines.join("\n") + "\n");
console.log("seed/seed.sql:", lines.length - 1, "documents");
