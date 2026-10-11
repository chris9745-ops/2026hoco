// Photo uploads for the Homecoming site.
// Photos are stored in Netlify Blobs (built into Netlify, no extra account).
//
//   GET    /api/photos        -> list of uploaded photos
//   POST   /api/upload        -> add a photo        (needs the upload passcode)
//   GET    /api/img/p/<id>    -> full-size photo
//   GET    /api/img/t/<id>    -> thumbnail
//   DELETE /api/photos/<id>   -> remove a photo     (needs the admin passcode)
//
// Passcodes come from two Netlify environment variables: UPLOAD_CODE and ADMIN_CODE.

import { getStore } from "@netlify/blobs";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_THUMB_BYTES = 400 * 1024;
const MAX_PHOTOS = 600; // safety cap on total uploads

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const store = () => getStore({ name: "hoco-uploads", consistency: "strong" });

const sameCode = (given, expected) =>
  !!expected && (given || "").trim().toLowerCase() === expected.trim().toLowerCase();

const b64url = {
  enc: (s) => Buffer.from(s, "utf8").toString("base64url"),
  dec: (s) => Buffer.from(s, "base64url").toString("utf8"),
};

// A photo's id carries its details, so listing needs no extra lookups:
//   <time>-<random>.<width>x<height>.n<name in base64url>
const ID_RE = /^[0-9a-z]{9}-[0-9a-z]{8}\.\d{1,4}x\d{1,4}\.n[A-Za-z0-9_-]{0,128}$/;

function describe(id) {
  const [stamp, size, n] = id.split(".");
  const [w, h] = size.split("x").map(Number);
  return { id, w, h, name: b64url.dec(n.slice(1)), ts: parseInt(stamp.split("-")[0], 36) };
}

const isJpeg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

async function upload(req) {
  if (!process.env.UPLOAD_CODE) return json({ error: "Uploads aren't switched on yet." }, 503);
  if (!sameCode(req.headers.get("x-code"), process.env.UPLOAD_CODE))
    return json({ error: "That passcode isn't right." }, 401);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Upload didn't come through. Try again." }, 400);
  }
  const photo = form.get("photo");
  const thumb = form.get("thumb");
  if (!photo?.arrayBuffer || !thumb?.arrayBuffer) return json({ error: "No photo received." }, 400);
  if (photo.size > MAX_PHOTO_BYTES || thumb.size > MAX_THUMB_BYTES)
    return json({ error: "That photo is too large." }, 413);

  const photoBuf = Buffer.from(await photo.arrayBuffer());
  const thumbBuf = Buffer.from(await thumb.arrayBuffer());
  if (!isJpeg(photoBuf) || !isJpeg(thumbBuf)) return json({ error: "Only photos can be added." }, 415);

  const w = Math.round(Number(form.get("w")));
  const h = Math.round(Number(form.get("h")));
  if (!(w >= 50 && w <= 4000 && h >= 50 && h <= 4000)) return json({ error: "Bad photo size." }, 400);

  const name = String(form.get("name") || "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, 24);

  const s = store();
  const { blobs } = await s.list({ prefix: "t/" });
  if (blobs.length >= MAX_PHOTOS) return json({ error: "The gallery is full." }, 507);

  const stamp = Date.now().toString(36).padStart(9, "0");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");
  const id = `${stamp}-${rand}.${w}x${h}.n${b64url.enc(name)}`;

  await s.set(`p/${id}`, photoBuf);
  await s.set(`t/${id}`, thumbBuf); // thumbnail last: a photo is only listed once both parts exist
  return json(describe(id), 201);
}

async function list() {
  const { blobs } = await store().list({ prefix: "t/" });
  const photos = blobs
    .map((b) => b.key.slice(2))
    .filter((id) => ID_RE.test(id))
    .map(describe)
    .sort((a, b) => a.ts - b.ts);
  return json(photos);
}

async function image(kind, id) {
  if (!ID_RE.test(id)) return new Response("Not found", { status: 404 });
  const data = await store().get(`${kind}/${id}`, { type: "arrayBuffer" });
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(data, {
    headers: {
      "content-type": "image/jpeg",
      "x-content-type-options": "nosniff",
      // Cached for an hour, so a removed photo stops being served soon after.
      "cache-control": "public, max-age=3600",
      "netlify-cdn-cache-control": "public, max-age=3600",
    },
  });
}

async function remove(req, id) {
  if (!sameCode(req.headers.get("x-admin"), process.env.ADMIN_CODE))
    return json({ error: "That admin passcode isn't right." }, 401);
  if (!ID_RE.test(id)) return json({ error: "Not found." }, 404);
  const s = store();
  await s.delete(`t/${id}`);
  await s.delete(`p/${id}`);
  return json({ ok: true });
}

export default async (req) => {
  const path = decodeURIComponent(new URL(req.url).pathname).replace(/\/+$/, "");
  try {
    if (req.method === "GET" && path === "/api/photos") return await list();
    if (req.method === "POST" && path === "/api/upload") return await upload(req);
    let m;
    if (req.method === "GET" && (m = path.match(/^\/api\/img\/([pt])\/(.+)$/))) return await image(m[1], m[2]);
    if (req.method === "DELETE" && (m = path.match(/^\/api\/photos\/(.+)$/))) return await remove(req, m[1]);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
};

export const config = { path: "/api/*" };
