import { DurableObject } from "cloudflare:workers";
import QRCode from "qrcode";

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

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
    if (buffer.byteLength < 1000) return text("Image too small", 400);

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
    button, a.download {
      display: inline-block; margin: 8px 8px 0 0; padding: 10px 12px;
      border: 1px solid #888; border-radius: 8px; background: #f8f8f8;
      color: #111; text-decoration: none; cursor: pointer; font-size: 15px;
    }
    code { word-break: break-all; }
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
    return;
  }

  const meta = pendingMeta || {
    filename: "photo.jpg",
    mime: "image/jpeg",
    size: event.data.byteLength,
    ts: Date.now()
  };
  pendingMeta = null;

  const blob = new Blob([event.data], { type: "image/jpeg" });
  const objectUrl = URL.createObjectURL(blob);

  const card = document.createElement("div");
  card.className = "box";

  const title = document.createElement("h2");
  title.textContent = meta.filename + " (" + Math.round(blob.size / 1024) + " KB)";
  card.appendChild(title);

  const img = document.createElement("img");
  img.src = objectUrl;
  card.appendChild(img);

  const download = document.createElement("a");
  download.href = objectUrl;
  download.download = meta.filename;
  download.className = "download";
  download.textContent = "Download JPEG";
  card.appendChild(download);

  const copy = document.createElement("button");
  copy.textContent = "Copy image to clipboard";
  copy.onclick = async () => {
    try {
      if (!navigator.clipboard || !window.ClipboardItem) {
        throw new Error("Clipboard image API unavailable");
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/jpeg": blob })
      ]);
      copy.textContent = "Copied";
    } catch (err) {
      copy.textContent = "Copy failed — use Download";
    }
  };
  card.appendChild(copy);

  receivedEl.prepend(card);
};
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
  <title>Upload Photo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 24px auto; padding: 0 16px; }
    .box { border: 1px solid #ccc; border-radius: 12px; padding: 18px; margin: 16px 0; }
    input, button { font-size: 18px; margin-top: 12px; }
    button { padding: 12px 14px; border-radius: 8px; border: 1px solid #888; }
    img { max-width: 100%; border: 1px solid #ddd; border-radius: 8px; margin-top: 12px; }
    .status { font-weight: 700; }
  </style>
</head>
<body>
  <h1>Send Photo</h1>
  <div class="box">
    <p>Take a photo. It will be compressed locally to JPEG before upload.</p>
    <input id="file" type="file" accept="image/*" capture="environment">
    <div id="status" class="status"></div>
    <img id="preview" style="display:none">
    <button id="send" disabled>Send to desktop</button>
  </div>

<script>
const uploadUrl = "/u/${room}?token=${encodeURIComponent(token)}";
const fileEl = document.getElementById("file");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");

let compressedBlob = null;

const TARGET_MAX = 2 * 1024 * 1024;
const MAX_DIM = 2400;

fileEl.addEventListener("change", async () => {
  compressedBlob = null;
  sendEl.disabled = true;
  previewEl.style.display = "none";

  const file = fileEl.files && fileEl.files[0];
  if (!file) return;

  statusEl.textContent = "Compressing...";
  try {
    compressedBlob = await compressToJpeg(file);
    previewEl.src = URL.createObjectURL(compressedBlob);
    previewEl.style.display = "block";
    statusEl.textContent = "Ready: " + Math.round(compressedBlob.size / 1024) + " KB JPEG";
    sendEl.disabled = false;
  } catch (err) {
    statusEl.textContent = "Compression failed: " + err.message;
  }
});

sendEl.addEventListener("click", async () => {
  if (!compressedBlob) return;

  sendEl.disabled = true;
  statusEl.textContent = "Sending...";

  try {
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Filename": "phone-photo-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg"
      },
      body: compressedBlob
    });

    if (!res.ok) throw new Error(await res.text());
    statusEl.textContent = "Sent to desktop.";
  } catch (err) {
    statusEl.textContent = "Send failed: " + err.message;
  } finally {
    sendEl.disabled = false;
  }
});

async function compressToJpeg(file) {
  const img = await loadImage(file);

  let scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));

  for (let round = 0; round < 6; round++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let low = 0.45;
    let high = 0.92;
    let best = null;

    for (let i = 0; i < 8; i++) {
      const q = (low + high) / 2;
      const blob = await canvasToBlob(canvas, q);

      if (blob.size > TARGET_MAX) {
        high = q;
      } else {
        best = blob;
        low = q;
      }
    }

    if (best && best.size <= TARGET_MAX) return best;

    scale *= 0.85;
  }

  throw new Error("Could not compress below 2 MB");
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };

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
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}
