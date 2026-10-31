// สร้าง public/index.html จาก src/page.html (ไฟล์หน้าเว็บหลัก)
import { readFileSync, writeFileSync } from "node:fs";
const page = readFileSync(new URL("../src/page.html", import.meta.url), "utf8");
const logo = (page.match(/const LOGO="(data:image\/png;base64,[^"]+)"/) || [])[1] || "";
const html = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="โรงแรมเทพนคร บุรีรัมย์ ที่พักใจกลางเมือง ใกล้สนามช้าง อินเตอร์เนชั่นแนล เซอร์กิต พร้อมศูนย์ประชุมและจัดเลี้ยง">
<link rel="icon" href="${logo}">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="/api-shim.js"></script>
</head>
<body>
${page}
</body>
</html>
`;
writeFileSync(new URL("../public/index.html", import.meta.url), html);
console.log("public/index.html", (html.length / 1024).toFixed(0) + " KB");
