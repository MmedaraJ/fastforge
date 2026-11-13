// The media domain's front door. Every request must carry a valid signature;
// the file then comes from R2, cached without the signature.
//
// Paths look like /t/<expires>.<signature>/packaged/<id>/<file>, signed by the
// API with MEDIA_URL_SECRET (internal/signing). The bucket itself is private:
// this Worker reads it through the MEDIA binding.

const SIGNED = /^\/t\/(\d+)\.([A-Za-z0-9_-]+)\/(packaged\/[^/]+\/)(.+)$/;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withCors(new Response("method not allowed", { status: 405 }));
    }

    const url = new URL(request.url);
    const match = SIGNED.exec(url.pathname);
    if (!match) return withCors(new Response("forbidden", { status: 403 }));
    const [, expires, signature, folder, file] = match;
    if (Date.now() / 1000 >= Number(expires)) return withCors(new Response("expired", { status: 403 }));
    // The same message the API signs: purpose, expiry, the asset's folder.
    if (!(await verify(env.MEDIA_URL_SECRET, `media.${expires}.${folder}`, signature))) {
      return withCors(new Response("forbidden", { status: 403 }));
    }

    // One cache entry per file, not per viewer. Every viewer's signature
    // differs, so a cache keyed by the full URL would hold a copy for each
    // and almost never hit.
    const key = folder + file;
    const cacheKey = new Request(`https://${url.hostname}/${key}`);
    let response = await caches.default.match(cacheKey);
    let state = "HIT";
    if (!response) {
      state = "MISS";
      const object = await env.MEDIA.get(key);
      if (!object) return withCors(new Response("not found", { status: 404 }));
      const headers = new Headers();
      // The Content-Type and Cache-Control the worker set at upload, so a
      // segment caches for a year and a manifest for five minutes.
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      response = new Response(object.body, { headers });
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    }
    response = withCors(response);
    response.headers.set("X-Media-Cache", state);
    return request.method === "HEAD" ? new Response(null, response) : response;
  },
};

/** HMAC-SHA256, checked by crypto.subtle.verify, which compares in constant time. */
async function verify(secretBase64, message, signature) {
  let mac;
  try {
    mac = fromBase64(signature.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", fromBase64(secretBase64), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(message));
}

function fromBase64(text) {
  const padded = text + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** The player is on another origin, so every answer, refusals included, carries CORS headers. */
function withCors(response) {
  const copy = new Response(response.body, response);
  copy.headers.set("Access-Control-Allow-Origin", "*");
  copy.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  copy.headers.set("Access-Control-Allow-Headers", "Range");
  return copy;
}