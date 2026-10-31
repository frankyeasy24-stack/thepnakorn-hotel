// แสดงรูปที่อัปโหลด: /_blob/<id>
export async function onRequestGet({ params, env }) {
  const id = String(params.id || "");
  if (!/^[a-f0-9]{32}$/.test(id) || !env.IMAGES) return new Response("Not found", { status: 404 });
  const { value, metadata } = await env.IMAGES.getWithMetadata(id, { type: "arrayBuffer" });
  if (!value) return new Response("Not found", { status: 404 });
  let type = metadata && metadata.contentType;
  if (!type) { const b = new Uint8Array(value.slice(0, 4)); type = b[0] === 0x89 ? "image/png" : b[0] === 0x47 ? "image/gif" : b[0] === 0x52 ? "image/webp" : "image/jpeg"; }
  return new Response(value, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
