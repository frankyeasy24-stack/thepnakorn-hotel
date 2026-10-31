// ติดตั้งเว็บไซต์โรงแรมเทพนครขึ้น Cloudflare อัตโนมัติ
// รันด้วยการดับเบิลคลิก deploy.cmd (Windows) หรือคำสั่ง: node deploy.mjs
// รันซ้ำได้ปลอดภัย: ขั้นตอนไหนทำแล้วจะข้าม และจะไม่ล้างข้อมูลที่แก้ไขไว้แล้ว
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

const PROJECT = "thepnakorn";
const DB = "thepnakorn-db";
const LOG = "deploy-log.txt";
writeFileSync(LOG, `deploy started ${new Date().toISOString()} node ${process.version} ${process.platform}\n`);
const log = (s) => { console.log(s); appendFileSync(LOG, s + "\n"); };
const step = (s) => log("\n=== " + s + " ===");

function run(cmd, { interactive = false, input, allowFail = false } = {}) {
  appendFileSync(LOG, "> " + cmd + "\n");
  const r = spawnSync(cmd, {
    shell: true, encoding: "utf8", input,
    stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...(interactive ? {} : { CI: "1" }) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (!interactive) appendFileSync(LOG, out.slice(-6000) + "\n");
  if (r.status !== 0 && !allowFail) throw new Error(`คำสั่งไม่สำเร็จ: ${cmd}\n${out.slice(-1500)}`);
  return { ok: r.status === 0, out, stdout: r.stdout || "" };
}
const W = "npx --yes wrangler";
const jsonFrom = (s) => { const i = s.search(/[\[{]/); return JSON.parse(s.slice(i)); };

try {
  step("1/8 ตรวจเครื่อง");
  const major = +process.versions.node.split(".")[0];
  if (major < 18) throw new Error("ต้องใช้ Node.js 18 ขึ้นไป (ตอนนี้ " + process.version + ") ดาวน์โหลดที่ https://nodejs.org");
  if (!existsSync("node_modules/wrangler")) { log("กำลังติดตั้งเครื่องมือ (ครั้งแรกใช้เวลา 1–3 นาที)…"); run("npm install --no-audit --no-fund"); }

  step("2/8 เข้าสู่ระบบ Cloudflare");
  if (!run(`${W} whoami`, { allowFail: true }).out.match(/associated with the email|Account ID/i)) {
    log("กำลังเปิดเบราว์เซอร์ให้เข้าสู่ระบบ Cloudflare กรุณากด Allow");
    run(`${W} login`, { interactive: true });
  }
  log(run(`${W} whoami`).out.split("\n").filter((l) => /email|Account/i.test(l)).join("\n"));

  step("3/8 ฐานข้อมูล D1");
  let dbs = jsonFrom(run(`${W} d1 list --json`).stdout);
  let db = dbs.find((d) => d.name === DB);
  if (!db) { run(`${W} d1 create ${DB}`); dbs = jsonFrom(run(`${W} d1 list --json`).stdout); db = dbs.find((d) => d.name === DB); }
  if (!db) throw new Error("สร้างฐานข้อมูลไม่สำเร็จ");
  const dbId = db.uuid || db.id;
  log("database_id = " + dbId);

  step("4/8 ที่เก็บรูป KV");
  let kvs = jsonFrom(run(`${W} kv namespace list`).stdout);
  let kv = kvs.find((k) => /IMAGES$/.test(k.title) && k.title.startsWith(PROJECT));
  if (!kv) { run(`${W} kv namespace create IMAGES`); kvs = jsonFrom(run(`${W} kv namespace list`).stdout); kv = kvs.find((k) => /IMAGES$/.test(k.title) && k.title.startsWith(PROJECT)); }
  if (!kv) throw new Error("สร้าง KV ไม่สำเร็จ");
  log("kv id = " + kv.id);

  let toml = readFileSync("wrangler.toml", "utf8");
  toml = toml.replace(/database_id = ".*"/, `database_id = "${dbId}"`).replace(/(\[\[kv_namespaces\]\][\s\S]*?id = )".*"/, `$1"${kv.id}"`);
  writeFileSync("wrangler.toml", toml);

  step("5/8 โปรเจกต์เว็บ (Pages)");
  const pc = run(`${W} pages project create ${PROJECT} --production-branch main`, { allowFail: true });
  log(pc.ok ? "สร้างโปรเจกต์แล้ว" : /already exists|8000002/i.test(pc.out) ? "มีโปรเจกต์อยู่แล้ว" : "สร้างโปรเจกต์: " + pc.out.slice(-300));

  step("6/8 ใส่ข้อมูลโรงแรมและรูปเดิม");
  const chk = run(`${W} d1 execute ${DB} --remote --command "SELECT count(*) AS c FROM docs" --json`, { allowFail: true });
  let hasData = false;
  try { hasData = chk.ok && jsonFrom(chk.stdout)[0].results[0].c > 0; } catch {}
  run(`${W} d1 execute ${DB} --remote --file=schema.sql`);
  if (!hasData) { run(`${W} d1 execute ${DB} --remote --file=seed/seed.sql`); log("ใส่ข้อมูลเดิมแล้ว"); }
  else log("ฐานข้อมูลมีข้อมูลอยู่แล้ว ไม่เขียนทับ");
  for (const f of readdirSync("seed/images")) {
    const m = f.match(/^([a-f0-9]{32})\./);
    if (!m) continue;
    run(`${W} kv key put ${m[1]} --path "seed/images/${f}" --namespace-id ${kv.id}`);
    log("อัปโหลดรูป " + f);
  }

  step("7/8 รหัสติดตั้ง");
  let token = existsSync(".setup-token") ? readFileSync(".setup-token", "utf8").trim() : "";
  if (!token) { token = "tpn-" + randomBytes(9).toString("hex"); writeFileSync(".setup-token", token); }
  writeFileSync(".secrets.json", JSON.stringify({ SETUP_TOKEN: token }));
  const sb = run(`${W} pages secret bulk .secrets.json --project-name ${PROJECT}`, { allowFail: true });
  if (!sb.ok) run(`${W} pages secret put SETUP_TOKEN --project-name ${PROJECT}`, { input: token + "\n" });
  unlinkSync(".secrets.json");

  step("8/8 อัปโหลดเว็บไซต์");
  const dep = run(`${W} pages deploy public --project-name ${PROJECT} --branch main --commit-dirty=true`);
  const preview = (dep.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev/i) || [])[0] || "";
  let site = "https://" + PROJECT + ".pages.dev";
  const pl = run(`${W} pages project list`, { allowFail: true }).out;
  const dom = pl.match(new RegExp(PROJECT + "[a-z0-9-]*\\.pages\\.dev", "i"));
  if (dom) site = "https://" + dom[0];

  const result = [
    "ติดตั้งเว็บไซต์โรงแรมเทพนครสำเร็จ",
    "",
    "เว็บไซต์:       " + site,
    "หลังบ้าน:       " + site + "/#admin",
    "รหัสติดตั้ง:     " + token,
    "(ใช้รหัสติดตั้งครั้งเดียวตอนสร้างบัญชีเจ้าของ)",
    preview ? "ลิงก์ของการอัปโหลดครั้งนี้: " + preview : "",
  ].join("\n");
  writeFileSync("RESULT.txt", result + "\n");
  step("เสร็จแล้ว");
  log(result);
  run(process.platform === "win32" ? `start "" "${site}/#admin"` : `open "${site}/#admin"`, { allowFail: true });
} catch (e) {
  log("\n*** ติดตั้งไม่สำเร็จ ***\n" + e.message);
  log("ส่งไฟล์ deploy-log.txt ให้ Claude ดูได้เลย");
  process.exitCode = 1;
}
