const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TICKET_TTL_MS = 10 * 60 * 1000;
const PUBLIC_VIDEO_PATH = /^\/videos\/([a-z0-9._-]{1,96})\/([a-z0-9._-]{1,160}\.mp4)$/;
const SIGNED_UPLOAD_PATH = /^\/v1\/upload\/videos\/([a-z0-9._-]{1,96})\/([a-z0-9._-]{1,160}\.mp4)$/;

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

async function authorized(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function videoKey(match: RegExpExecArray): string {
  return `videos/${match[1]}/${match[2]}`;
}

function hasBody(object: R2Object): object is R2ObjectBody {
  return "body" in object;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signaturePayload(key: string, bytes: number, expires: number): Uint8Array {
  return new TextEncoder().encode(`PUT\n${key}\n${bytes}\n${expires}`);
}

function base64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function issueUpload(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await authorized(request, env.UPLOAD_TOKEN))) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const input = await request.json().catch(() => undefined) as unknown;
  if (!input || typeof input !== "object") {
    return json({ error: "Expected a JSON upload request" }, { status: 400 });
  }
  const { sessionId, name, bytes } = input as Record<string, unknown>;
  if (typeof sessionId !== "string" || !/^[a-z0-9._-]{1,96}$/.test(sessionId)) {
    return json({ error: "Invalid sessionId" }, { status: 400 });
  }
  if (typeof name !== "string" || !/^[a-z0-9._-]{1,100}\.mp4$/.test(name)) {
    return json({ error: "Invalid MP4 name" }, { status: 400 });
  }
  if (!Number.isSafeInteger(bytes) || Number(bytes) < 1 || Number(bytes) > MAX_UPLOAD_BYTES) {
    return json({ error: "bytes must be between 1 byte and 100 MiB" }, { status: 400 });
  }

  const key = `videos/${sessionId}/${crypto.randomUUID()}-${name}`;
  const expires = Date.now() + UPLOAD_TICKET_TTL_MS;
  const signature = base64Url(await crypto.subtle.sign(
    "HMAC",
    await signingKey(env.UPLOAD_TOKEN),
    signaturePayload(key, Number(bytes), expires),
  ));
  const uploadUrl = new URL(`/v1/upload/${key}`, url.origin);
  uploadUrl.searchParams.set("bytes", String(bytes));
  uploadUrl.searchParams.set("expires", String(expires));
  uploadUrl.searchParams.set("signature", signature);
  return json({
    key,
    url: `${url.origin}/${key}`,
    uploadUrl: uploadUrl.toString(),
    expires,
  }, { status: 201 });
}

async function validUploadTicket(
  env: Env,
  key: string,
  bytes: number,
  expires: number,
  signature: string,
): Promise<boolean> {
  const decoded = fromBase64Url(signature);
  if (!decoded || expires < Date.now() || expires > Date.now() + UPLOAD_TICKET_TTL_MS) {
    return false;
  }
  return await crypto.subtle.verify(
    "HMAC",
    await signingKey(env.UPLOAD_TOKEN),
    decoded,
    signaturePayload(key, bytes, expires),
  );
}

async function upload(request: Request, env: Env, key: string, url: URL): Promise<Response> {
  const bytes = Number(url.searchParams.get("bytes"));
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_UPLOAD_BYTES ||
    !Number.isSafeInteger(expires) ||
    !(await validUploadTicket(env, key, bytes, expires, signature))
  ) {
    return json({ error: "Invalid or expired upload ticket" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "video/mp4") {
    return json({ error: "Content-Type must be video/mp4" }, { status: 415 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (contentLength !== bytes) {
    return json({ error: "Content-Length does not match the upload ticket" }, { status: 400 });
  }
  if (!request.body) return json({ error: "Missing request body" }, { status: 400 });

  const object = await env.VIDEOS.put(key, request.body, {
    httpMetadata: {
      contentType: "video/mp4",
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: `inline; filename="${key.slice(key.lastIndexOf("/") + 1)}"`,
    },
    customMetadata: { uploadedBy: "opencomputer-code-tutorial-video" },
  });
  console.log(JSON.stringify({ event: "video.uploaded", key, bytes: object.size }));
  return json(
    { key, bytes: object.size, url: `${url.origin}/${key}` },
    { status: 201 },
  );
}

async function download(request: Request, env: Env, key: string): Promise<Response> {
  const rangeRequested = request.method === "GET" && request.headers.has("range");
  const object = request.method === "HEAD"
    ? await env.VIDEOS.head(key)
    : await env.VIDEOS.get(key, { range: request.headers });
  if (!object) return json({ error: "Not found" }, { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (rangeRequested && object.range) {
    const range = object.range as { suffix?: number; offset?: number; length?: number };
    const suffix = typeof range.suffix === "number" ? range.suffix : undefined;
    const length = suffix !== undefined
      ? Math.min(suffix, object.size)
      : range.length ?? object.size - (range.offset ?? 0);
    const offset = suffix !== undefined
      ? object.size - length
      : range.offset ?? 0;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
  } else {
    headers.set("content-length", String(object.size));
  }
  const body = request.method === "HEAD" || !hasBody(object) ? null : object.body;
  return new Response(body, { status: rangeRequested && object.range ? 206 : 200, headers });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/uploads") {
    if (request.method === "POST") return await issueUpload(request, env, url);
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
  }

  const signedUpload = SIGNED_UPLOAD_PATH.exec(url.pathname);
  if (signedUpload) {
    if (request.method === "PUT") return await upload(request, env, videoKey(signedUpload), url);
    return json({ error: "Method not allowed" }, { status: 405, headers: { allow: "PUT" } });
  }

  const publicMatch = PUBLIC_VIDEO_PATH.exec(url.pathname);
  if (publicMatch && (request.method === "GET" || request.method === "HEAD")) {
    return await download(request, env, videoKey(publicMatch));
  }
  return json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "request.failed",
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: "Internal server error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
