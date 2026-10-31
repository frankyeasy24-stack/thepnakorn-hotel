// ทุก request /api/* และ /_blob/* ถูก rewrite มาที่ฟังก์ชันนี้ (ดู vercel.json)
import { handle } from "../lib/core.js";
export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
