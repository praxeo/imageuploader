import { DurableObject } from "cloudflare:workers";
import QRCode from "qrcode";

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const FILE_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const FILE_TTL_MS = 24 * 60 * 60 * 1000;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Content-Type-Options": "nosniff"
};

function html(body) {
  return new Response(body, {
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function roomStub(env, roomId) {
  const id = env.ROOMS.idFromName(roomId);
  return env.ROOMS.get(id);
}

function safeRoomId(value) {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      const room = crypto.randomUUID();
      return Response.redirect(`${url.origin}/d/${room}`, 302);
    }

    const desktopMatch = path.match(/^\/d\/([^/]+)$/);
    if (desktopMatch && request.method === "GET") {
      const room = desktopMatch[1];
      if (!safeRoomId(room)) return text("Bad room id", 400);

      const token = crypto.randomUUID() + crypto.randomUUID();
      const phoneUrl = `${url.origin}/u/${room}?token=${encodeURIComponent(token)}`;
      const qrSvg = await QRCode.toString(phoneUrl, {
        type: "svg",
        margin: 1,
        width: 280,
        errorCorrectionLevel: "M"
      });

      return html(desktopPage({ room, token, phoneUrl, qrSvg }));
    }

    const phoneMatch = path.match(/^\/u\/([^/]+)$/);
    if (phoneMatch && request.method === "GET") {
      const room = phoneMatch[1];
      if (!safeRoomId(room)) return text("Bad room id", 400);
      const token = url.searchParams.get("token") || "";
      return html(phonePage({ room, token }));
    }

    const fileApiMatch = path.match(/^\/api\/files\/([^/]+)\/(start|part|complete)$/);
    if (fileApiMatch) {
      const [, room, action] = fileApiMatch;
      if (!safeRoomId(room)) return text("Bad room id", 400);
      const stub = roomStub(env, room);
      const relayUrl = new URL(`https://relay.local/files/${action}${url.search}`);
      relayUrl.searchParams.set("room", room);
      return stub.fetch(new Request(relayUrl, request));
    }

    const downloadMatch = path.match(/^\/files\/([^/]+)\/([^/]+)$/);
    if (downloadMatch && request.method === "GET") {
      const [, room, transferId] = downloadMatch;
      if (!safeRoomId(room) || !safeRoomId(transferId)) return text("Bad file id", 400);
      const auth = await roomStub(env, room).fetch(
        `https://relay.local/files/authorize?token=${encodeURIComponent(url.searchParams.get("token") || "")}&id=${encodeURIComponent(transferId)}`
      );
      if (!auth.ok) return auth;
      const { key, filename, mime } = await auth.json();
      const object = await env.FILES.get(key);
      if (!object) return text("File expired or not found", 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Content-Type", mime || "application/octet-stream");
      headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      headers.set("Content-Length", String(object.size));
      headers.set("Cache-Control", "private, no-store");
      return new Response(object.body, { headers });
    }

    if (phoneMatch && request.method === "POST") {
      const room = phoneMatch[1];
      if (!safeRoomId(room)) return text("Bad room id", 400);

      const len = Number(request.headers.get("content-length") || "0");
      if (len && len > MAX_UPLOAD_BYTES) return text("Image too large", 413);

      const stub = roomStub(env, room);
      return stub.fetch(new Request("https://relay.local/upload" + url.search, request));
    }

    const wsMatch = path.match(/^\/r\/([^/]+)\/ws$/);
    if (wsMatch) {
      const room = wsMatch[1];
      if (!safeRoomId(room)) return text("Bad room id", 400);

      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") return text("Expected WebSocket", 426);

      const stub = roomStub(env, room);
      return stub.fetch(new Request("https://relay.local/ws" + url.search, request));
    }

    return text("Not found", 404);
  }
};

export class RelayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.desktop = null;
    this.token = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.handleDesktopSocket(request, url);
    }

    if (url.pathname === "/upload") {
      return this.handleUpload(request, url);
    }

    if (url.pathname.startsWith("/files/")) {
      return this.handleFileRequest(request, url);
    }

    return text("Not found", 404);
  }

  handleDesktopSocket(request, url) {
    const token = url.searchParams.get("token") || "";
    if (request.headers.get("Upgrade") !== "websocket") {
      return text("Expected WebSocket", 426);
    }
    if (!token) return text("Missing token", 403);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();

    if (this.desktop) {
      try {
        this.desktop.close(1000, "Replaced by new desktop session");
      } catch {}
    }

    this.desktop = server;
    this.token = token;

    server.addEventListener("close", () => {
      if (this.desktop === server) {
        this.desktop = null;
        this.token = null;
      }
    });

    server.addEventListener("error", () => {
      if (this.desktop === server) {
        this.desktop = null;
        this.token = null;
      }
    });

    server.send(JSON.stringify({ type: "ready" }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async handleUpload(request, url) {
    const token = url.searchParams.get("token") || "";
    if (!this.desktop || !this.token || token !== this.token) {
      return text("Desktop session not connected or token invalid", 403);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("image/jpeg")) {
      return text("Only image/jpeg accepted", 415);
    }

    const len = Number(request.headers.get("content-length") || "0");
    if (len && len > MAX_UPLOAD_BYTES) return text("Image too large", 413);

    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_UPLOAD_BYTES) return text("Image too large", 413);
    if (buffer.byteLength < 500) return text("Image too small", 400);

    const filename =
      request.headers.get("x-filename") ||
      `photo-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;

    try {
      this.desktop.send(JSON.stringify({
        type: "image-meta",
        filename,
        mime: "image/jpeg",
        size: buffer.byteLength,
        ts: Date.now()
      }));

      this.desktop.send(buffer);
    } catch {
      this.desktop = null;
      this.token = null;
      return text("Desktop session disconnected", 409);
    }

    return text("Relayed");
  }

  authorized(url) {
    const token = url.searchParams.get("token") || "";
    return Boolean(this.desktop && this.token && token === this.token);
  }

  async handleFileRequest(request, url) {
    if (!this.authorized(url)) return text("Desktop session not connected or token invalid", 403);

    const transferId = url.searchParams.get("id") || "";
    if (url.pathname === "/files/authorize" && request.method === "GET") {
      if (!safeRoomId(transferId)) return text("Bad file id", 400);
      const file = await this.ctx.storage.get(`file:${transferId}`);
      if (!file || file.expiresAt <= Date.now()) return text("File expired or not found", 404);
      return Response.json(file);
    }

    if (url.pathname === "/files/start" && request.method === "POST") {
      const { filename, mime, size } = await request.json();
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
        return text("Invalid or unsupported file size", 413);
      }
      const safeName = sanitizeFilename(filename);
      const transferId = crypto.randomUUID();
      const key = `${url.searchParams.get("room") || "room"}/${transferId}/${safeName}`;
      const upload = await this.env.FILES.createMultipartUpload(key, {
        httpMetadata: { contentType: mime || "application/octet-stream" },
        customMetadata: { filename: safeName, transferId }
      });
      await this.ctx.storage.put(`upload:${transferId}`, {
        key, uploadId: upload.uploadId, filename: safeName,
        mime: mime || "application/octet-stream", size
      });
      return Response.json({ transferId, chunkSize: FILE_CHUNK_BYTES });
    }

    if (!safeRoomId(transferId)) return text("Bad file id", 400);
    const info = await this.ctx.storage.get(`upload:${transferId}`);
    if (!info) return text("Upload not found", 404);

    if (url.pathname === "/files/part" && request.method === "PUT") {
      const partNumber = Number(url.searchParams.get("part"));
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        return text("Bad part number", 400);
      }
      const length = Number(request.headers.get("content-length") || "0");
      if (length > FILE_CHUNK_BYTES) return text("Chunk too large", 413);
      const upload = this.env.FILES.resumeMultipartUpload(info.key, info.uploadId);
      const part = await upload.uploadPart(partNumber, request.body);
      return Response.json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (url.pathname === "/files/complete" && request.method === "POST") {
      const { parts } = await request.json();
      if (!Array.isArray(parts) || !parts.length) return text("No upload parts", 400);
      const upload = this.env.FILES.resumeMultipartUpload(info.key, info.uploadId);
      await upload.complete(parts);
      const expiresAt = Date.now() + FILE_TTL_MS;
      await this.ctx.storage.put(`file:${transferId}`, { ...info, expiresAt });
      await this.ctx.storage.delete(`upload:${transferId}`);
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null || currentAlarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
      this.desktop.send(JSON.stringify({
        type: "file-ready", id: transferId, filename: info.filename,
        mime: info.mime, size: info.size
      }));
      return text("Stored");
    }

    return text("Not found", 404);
  }

  async alarm() {
    const now = Date.now();
    const files = await this.ctx.storage.list({ prefix: "file:" });
    let nextAlarm = null;
    for (const [storageKey, file] of files) {
      if (file.expiresAt <= now) {
        await this.env.FILES.delete(file.key);
        await this.ctx.storage.delete(storageKey);
      } else if (nextAlarm === null || file.expiresAt < nextAlarm) {
        nextAlarm = file.expiresAt;
      }
    }
    if (nextAlarm !== null) await this.ctx.storage.setAlarm(nextAlarm);
  }
}

function desktopPage({ room, token, phoneUrl, qrSvg }) {
  const wsUrl = `/r/${room}/ws?token=${encodeURIComponent(token)}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Photo Relay Desktop</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 32px auto; padding: 0 16px; }
    .box { border: 1px solid #ccc; border-radius: 12px; padding: 18px; margin: 16px 0; }
    .qr svg { width: 280px; height: 280px; }
    .status { font-weight: 700; }
    img { max-width: 100%; border: 1px solid #ddd; border-radius: 8px; margin-top: 12px; }
    a.download {
      display: inline-block; margin: 8px 8px 0 0; padding: 10px 12px;
      border: 1px solid #888; border-radius: 8px; background: #f8f8f8;
      color: #111; text-decoration: none; cursor: pointer; font-size: 15px;
    }
    .hint {
      margin-top: 10px;
      padding: 10px 12px;
      background: #fffbe6;
      border: 1px solid #ffe58f;
      border-radius: 8px;
      font-size: 14px;
      color: #555;
    }
    code { word-break: break-all; }
    .rotate-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
    }
    .rotate-btn {
      font-size: 15px;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid #888;
      background: #f8f8f8;
      cursor: pointer;
      line-height: 1;
    }
    .rotate-btn:active { background: #e8e8e8; }
    .rotate-btn:disabled { opacity: 0.5; cursor: default; }
  </style>
</head>
<body>
  <h1>Photo Relay</h1>

  <div class="box">
    <div>Status: <span id="status" class="status">connecting...</span></div>
    <p>Scan this QR code from the phone. Keep this desktop page open.</p>
    <div class="qr">${qrSvg}</div>
    <p><code>${escapeHtml(phoneUrl)}</code></p>
  </div>

  <div id="received"></div>

<script>
const statusEl = document.getElementById("status");
const receivedEl = document.getElementById("received");
let pendingMeta = null;

const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(wsScheme + "//" + location.host + ${JSON.stringify(wsUrl)});
ws.binaryType = "arraybuffer";

ws.onopen = () => statusEl.textContent = "connected";
ws.onclose = () => statusEl.textContent = "disconnected - refresh desktop page";
ws.onerror = () => statusEl.textContent = "socket error";

ws.onmessage = async (event) => {
  if (typeof event.data === "string") {
    const msg = JSON.parse(event.data);
    if (msg.type === "ready") statusEl.textContent = "connected";
    if (msg.type === "image-meta") pendingMeta = msg;
    if (msg.type === "file-ready") addFileDownload(msg);
    return;
  }

  const meta = pendingMeta || {
    filename: "photo.jpg",
    mime: "image/jpeg",
    size: event.data.byteLength,
    ts: Date.now()
  };
  pendingMeta = null;

  const originalBlob = new Blob([event.data], { type: "image/jpeg" });

  const card = document.createElement("div");
  card.className = "box";

  const title = document.createElement("h2");
  card.appendChild(title);

  const img = document.createElement("img");
  card.appendChild(img);

  const bar = document.createElement("div");
  bar.className = "rotate-bar";
  const rotateLeft = document.createElement("button");
  rotateLeft.className = "rotate-btn";
  rotateLeft.textContent = "⟲ Rotate left";
  const rotateRight = document.createElement("button");
  rotateRight.className = "rotate-btn";
  rotateRight.textContent = "⟳ Rotate right";
  bar.appendChild(rotateLeft);
  bar.appendChild(rotateRight);
  card.appendChild(bar);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "To paste: right-click the image above → Copy Image → paste into destination.";
  card.appendChild(hint);

  const download = document.createElement("a");
  download.download = meta.filename;
  download.className = "download";
  download.textContent = "Download JPEG";
  card.appendChild(download);

  let rotation = 0;
  let currentUrl = null;

  async function render() {
    rotateLeft.disabled = rotateRight.disabled = true;
    try {
      const blob = rotation === 0
        ? originalBlob
        : await rotateJpeg(originalBlob, rotation);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(blob);
      img.src = currentUrl;
      download.href = currentUrl;
      title.textContent = meta.filename + " (" + Math.round(blob.size / 1024) + " KB)";
    } catch (err) {
      title.textContent = meta.filename + " — rotate failed: " + err.message;
    } finally {
      rotateLeft.disabled = rotateRight.disabled = false;
    }
  }

  rotateLeft.addEventListener("click", () => {
    rotation = (rotation + 270) % 360;
    render();
  });
  rotateRight.addEventListener("click", () => {
    rotation = (rotation + 90) % 360;
    render();
  });

  await render();
  receivedEl.prepend(card);
};

function addFileDownload(meta) {
  const card = document.createElement("div");
  card.className = "box";
  const title = document.createElement("h2");
  title.textContent = meta.filename + " (" + formatBytes(meta.size) + ")";
  const download = document.createElement("a");
  download.className = "download";
  download.textContent = "Download file";
  download.href = "/files/${room}/" + encodeURIComponent(meta.id) +
    "?token=" + encodeURIComponent(${JSON.stringify(token)});
  card.appendChild(title);
  card.appendChild(download);
  receivedEl.prepend(card);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload  = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    im.src = url;
  });
}

async function rotateJpeg(blob, rotation) {
  const im = await loadImageFromBlob(blob);
  const w = im.naturalWidth;
  const h = im.naturalHeight;
  const swap = rotation === 90 || rotation === 270;

  const canvas = document.createElement("canvas");
  canvas.width  = swap ? h : w;
  canvas.height = swap ? w : h;

  const ctx = canvas.getContext("2d", { alpha: false });
  switch (rotation) {
    case 90:  ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); break;
    case 180: ctx.translate(canvas.width, canvas.height); ctx.rotate(Math.PI); break;
    case 270: ctx.translate(0, canvas.height); ctx.rotate(-Math.PI / 2); break;
  }
  ctx.drawImage(im, 0, 0, w, h);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error("encode failed")),
      "image/jpeg",
      0.92
    );
  });
}
</script>
</body>
</html>`;
}

function phonePage({ room, token }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Upload Photos</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 24px auto; padding: 0 16px; }
    .box { border: 1px solid #ccc; border-radius: 12px; padding: 18px; margin: 16px 0; }
    input[type=file], button { font-size: 18px; margin-top: 12px; }
    button { padding: 12px 14px; border-radius: 8px; border: 1px solid #888; background: #f8f8f8; cursor: pointer; }
    progress { display: block; width: 100%; height: 22px; margin-top: 14px; }
    img { max-width: 100%; border: 1px solid #ddd; border-radius: 8px; margin-top: 12px; }
    .status { font-weight: 700; white-space: pre-line; margin-top: 10px; }
    .thumb { margin-top: 14px; }

    .size-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 12px;
    }
    .size-grid label {
      display: flex;
      flex-direction: column;
      gap: 3px;
      border: 2px solid #ccc;
      border-radius: 10px;
      padding: 10px 12px;
      cursor: pointer;
      font-size: 15px;
      transition: border-color 0.15s, background 0.15s;
    }
    .size-grid label:has(input:checked) {
      border-color: #0066cc;
      background: #eef4ff;
    }
    .size-grid input[type=radio] {
      display: none;
    }
    .size-grid .size-name {
      font-weight: 700;
      font-size: 16px;
    }
    .size-grid .size-desc {
      font-size: 13px;
      color: #555;
    }
    .size-grid .size-rec {
      font-size: 12px;
      font-weight: 700;
      color: #0066cc;
      margin-top: 2px;
    }

    .gray-row {
      margin-top: 14px;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .gray-row input { width: 18px; height: 18px; }

    .rotate-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
    }
    .rotate-btn {
      font-size: 16px;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid #888;
      background: #f8f8f8;
      cursor: pointer;
      line-height: 1;
    }
    .rotate-btn:active { background: #e8e8e8; }
    .rotate-readout {
      font-weight: 700;
      min-width: 52px;
      text-align: center;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <h1>Send Photos</h1>

  <div class="box">
    <p>Select photos from your phone. They are compressed locally to JPEG before upload.</p>

    <strong>Output size:</strong>
    <div class="size-grid">
      <label>
        <input type="radio" name="size" value="nano">
        <span class="size-name">Nano</span>
        <span class="size-desc">≤360 px · ~20 KB</span>
        <span class="size-rec">Last resort</span>
      </label>
      <label>
        <input type="radio" name="size" value="tiny" checked>
        <span class="size-name">Tiny</span>
        <span class="size-desc">≤480 px · ~40 KB</span>
        <span class="size-rec">✓ Recommended for Cerner</span>
      </label>
      <label>
        <input type="radio" name="size" value="xsmall">
        <span class="size-name">X-Small</span>
        <span class="size-desc">≤640 px · ~90 KB</span>
      </label>
      <label>
        <input type="radio" name="size" value="small">
        <span class="size-name">Small</span>
        <span class="size-desc">≤1024 px · ~200 KB</span>
      </label>
      <label>
        <input type="radio" name="size" value="medium">
        <span class="size-name">Medium</span>
        <span class="size-desc">≤1800 px · ~750 KB</span>
      </label>
      <label>
        <input type="radio" name="size" value="large">
        <span class="size-name">Large</span>
        <span class="size-desc">≤2400 px · ~2 MB</span>
      </label>
      <label>
        <input type="radio" name="size" value="original">
        <span class="size-name">Original</span>
        <span class="size-desc">Native size, max quality<br>(re-encoded, ≤2.8 MB)</span>
      </label>
    </div>

    <label class="gray-row">
      <input type="checkbox" id="grayscale">
      <span>Grayscale (roughly halves file size)</span>
    </label>

    <strong>Rotation:</strong>
    <div class="rotate-bar">
      <button type="button" id="rotate-left" class="rotate-btn">⟲ Left</button>
      <span id="rotate-readout" class="rotate-readout">0°</span>
      <button type="button" id="rotate-right" class="rotate-btn">⟳ Right</button>
    </div>

    <input id="file" type="file" accept="image/*" multiple>

    <div id="status" class="status"></div>

    <button id="send" disabled>Send selected photos to desktop</button>

    <div id="preview"></div>
  </div>

  <h1>Send Files</h1>
  <div class="box">
    <p>Select documents or other files from your phone. They are stored temporarily in Cloudflare R2 and expire after 24 hours.</p>
    <input id="generic-files" type="file" multiple>
    <progress id="file-progress" value="0" max="1"></progress>
    <div id="file-status" class="status"></div>
    <button id="file-send" disabled>Send selected files to desktop</button>
  </div>

<script>
const uploadUrl = "/u/${room}?token=${encodeURIComponent(token)}";
const fileEl    = document.getElementById("file");
const sendEl    = document.getElementById("send");
const statusEl  = document.getElementById("status");
const previewEl = document.getElementById("preview");
const grayEl    = document.getElementById("grayscale");

const genericFilesEl = document.getElementById("generic-files");
const fileSendEl = document.getElementById("file-send");
const fileStatusEl = document.getElementById("file-status");
const fileProgressEl = document.getElementById("file-progress");
const fileApiBase = "/api/files/${room}";
const fileToken = ${JSON.stringify(token)};

let compressedItems = [];

const PRESETS = {
  nano:     { targetMax:   20 * 1024, maxDim:  360,     qualLow: 0.20, qualHigh: 0.55 },
  tiny:     { targetMax:   40 * 1024, maxDim:  480,     qualLow: 0.25, qualHigh: 0.60 },
  xsmall:   { targetMax:   90 * 1024, maxDim:  640,     qualLow: 0.35, qualHigh: 0.70 },
  small:    { targetMax:  200 * 1024, maxDim: 1024,     qualLow: 0.40, qualHigh: 0.75 },
  medium:   { targetMax:  750 * 1024, maxDim: 1800,     qualLow: 0.50, qualHigh: 0.85 },
  large:    { targetMax: 2048 * 1024, maxDim: 2400,     qualLow: 0.55, qualHigh: 0.92 },
  original: { targetMax: 2867 * 1024, maxDim: Infinity, qualLow: 0.88, qualHigh: 0.98 }
};

function selectedPreset() {
  const radio = document.querySelector('input[name="size"]:checked');
  return PRESETS[radio ? radio.value : "tiny"];
}

let rotation = 0;
const rotateLeftEl    = document.getElementById("rotate-left");
const rotateRightEl   = document.getElementById("rotate-right");
const rotateReadoutEl = document.getElementById("rotate-readout");

function applyRotation(delta) {
  rotation = (rotation + delta + 360) % 360;
  rotateReadoutEl.textContent = rotation + "°";
  if (fileEl.files && fileEl.files.length) processFiles(fileEl.files);
}

rotateLeftEl.addEventListener("click", () => applyRotation(-90));
rotateRightEl.addEventListener("click", () => applyRotation(90));

document.querySelectorAll('input[name="size"]').forEach(radio => {
  radio.addEventListener("change", () => {
    if (fileEl.files && fileEl.files.length) processFiles(fileEl.files);
  });
});

grayEl.addEventListener("change", () => {
  if (fileEl.files && fileEl.files.length) processFiles(fileEl.files);
});

fileEl.addEventListener("change", () => {
  if (fileEl.files && fileEl.files.length) processFiles(fileEl.files);
});

async function processFiles(files) {
  compressedItems = [];
  sendEl.disabled = true;
  previewEl.innerHTML = "";

  const filesArr = Array.from(files);
  if (!filesArr.length) return;

  const preset = selectedPreset();
  const gray = grayEl.checked;
  statusEl.textContent = "Compressing " + filesArr.length + " photo(s)...";

  try {
    for (let i = 0; i < filesArr.length; i++) {
      const file = filesArr[i];
      statusEl.textContent = "Compressing " + (i + 1) + " of " + filesArr.length + "...";

      const blob = await compressToJpeg(file, preset, rotation, gray);
      const filename = makeJpegFilename(file.name, i);
      compressedItems.push({ blob, filename });

      const div = document.createElement("div");
      div.className = "thumb";

      const label = document.createElement("div");
      label.textContent = filename + " — " + Math.round(blob.size / 1024) + " KB";

      const img = document.createElement("img");
      img.src = URL.createObjectURL(blob);

      div.appendChild(label);
      div.appendChild(img);
      previewEl.appendChild(div);
    }

    statusEl.textContent = "Ready: " + compressedItems.length + " photo(s) compressed.";
    sendEl.disabled = false;
  } catch (err) {
    statusEl.textContent = "Compression failed: " + err.message;
  }
}

sendEl.addEventListener("click", async () => {
  if (!compressedItems.length) return;

  sendEl.disabled = true;
  let sent = 0;

  try {
    for (let i = 0; i < compressedItems.length; i++) {
      const item = compressedItems[i];
      statusEl.textContent = "Sending " + (i + 1) + " of " + compressedItems.length + "...";

      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          "X-Filename": item.filename
        },
        body: item.blob
      });

      if (!res.ok) throw new Error(await res.text());
      sent++;
    }

    statusEl.textContent = "Sent " + sent + " photo(s) to desktop.";
  } catch (err) {
    statusEl.textContent = "Send failed after " + sent + " photo(s): " + err.message;
  } finally {
    sendEl.disabled = false;
  }
});

genericFilesEl.addEventListener("change", () => {
  fileSendEl.disabled = !genericFilesEl.files.length;
  fileStatusEl.textContent = genericFilesEl.files.length
    ? genericFilesEl.files.length + " file(s) ready."
    : "";
});

fileSendEl.addEventListener("click", async () => {
  const files = Array.from(genericFilesEl.files);
  if (!files.length) return;
  fileSendEl.disabled = true;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let uploadedBytes = 0;
  fileProgressEl.max = totalBytes || 1;

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      fileStatusEl.textContent = "Starting " + (fileIndex + 1) + " of " + files.length + ": " + file.name;
      const started = await fileApi("start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, mime: file.type, size: file.size })
      });
      const parts = [];
      const partCount = Math.ceil(file.size / started.chunkSize);
      for (let index = 0; index < partCount; index++) {
        const start = index * started.chunkSize;
        const end = Math.min(file.size, start + started.chunkSize);
        fileStatusEl.textContent = "Uploading " + file.name + " — part " + (index + 1) + " of " + partCount;
        const part = await fileApi("part", {
          method: "PUT",
          query: { id: started.transferId, part: index + 1 },
          body: file.slice(start, end)
        });
        parts.push(part);
        uploadedBytes += end - start;
        fileProgressEl.value = uploadedBytes;
      }
      await fileApi("complete", {
        method: "POST",
        query: { id: started.transferId },
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts })
      }, false);
    }
    fileStatusEl.textContent = "Sent " + files.length + " file(s) to desktop.";
  } catch (err) {
    fileStatusEl.textContent = "Upload failed: " + err.message;
  } finally {
    fileSendEl.disabled = false;
  }
});

async function fileApi(action, options, expectJson = true) {
  const url = new URL(fileApiBase + "/" + action, location.origin);
  url.searchParams.set("token", fileToken);
  for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, value);
  const requestOptions = { ...options };
  delete requestOptions.query;
  const response = await fetch(url, requestOptions);
  if (!response.ok) throw new Error(await response.text());
  return expectJson ? response.json() : response.text();
}

async function compressToJpeg(file, preset, rotation, gray) {
  rotation = ((rotation || 0) % 360 + 360) % 360;
  const img = await loadImage(file);

  const nativeMax = Math.max(img.naturalWidth, img.naturalHeight);
  let scale = preset.maxDim === Infinity
    ? 1
    : Math.min(1, preset.maxDim / nativeMax);

  for (let round = 0; round < 8; round++) {
    const sw = Math.max(1, Math.round(img.naturalWidth  * scale));
    const sh = Math.max(1, Math.round(img.naturalHeight * scale));
    const swap = rotation === 90 || rotation === 270;

    const canvas = document.createElement("canvas");
    canvas.width  = swap ? sh : sw;
    canvas.height = swap ? sw : sh;

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.save();
    if (gray) ctx.filter = "grayscale(1)";
    switch (rotation) {
      case 90:  ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); break;
      case 180: ctx.translate(canvas.width, canvas.height); ctx.rotate(Math.PI); break;
      case 270: ctx.translate(0, canvas.height); ctx.rotate(-Math.PI / 2); break;
    }
    ctx.drawImage(img, 0, 0, sw, sh);
    ctx.restore();

    let low  = preset.qualLow;
    let high = preset.qualHigh;

    const floorBlob = await canvasToBlob(canvas, low);
    if (floorBlob.size > preset.targetMax) {
      scale *= 0.85;
      continue;
    }

    let best = floorBlob;

    for (let i = 0; i < 8; i++) {
      const q    = (low + high) / 2;
      const blob = await canvasToBlob(canvas, q);

      if (blob.size > preset.targetMax) {
        high = q;
      } else {
        best = blob;
        low  = q;
      }
    }

    return best;
  }

  throw new Error("Could not compress to target size");
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image")); };
    img.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("JPEG encode failed")),
      "image/jpeg",
      quality
    );
  });
}

function makeJpegFilename(originalName, index) {
  const base = originalName
    ? originalName.replace(/\\.[^.]+$/, "")
    : "iphone-photo-" + (index + 1);

  const safeBase = base
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "iphone-photo";

  return safeBase + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg";
}
</script>
</body>
</html>`;
}

function sanitizeFilename(value) {
  const filename = String(value || "file")
    .replace(/[\\/\u0000-\u001f\u007f]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return filename || "file";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[c]);
}
