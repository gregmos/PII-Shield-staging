/**
 * PII Shield v2.0.0 — HITL Review HTTP Server
 * Ported from pii_shield_server.py lines 2609-2784
 *
 * Localhost-only server for human review of anonymization results.
 * PII stays on the machine — never sent to Claude.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { ENV } from "../utils/config.js";
import { getReview, saveReview, approveReview, type ReviewData } from "../mapping/review-store.js";
// @ts-ignore — esbuild bundles .html as text via loader config
import EMBEDDED_REVIEW_HTML from "../../assets/review_ui.html";

let _server: http.Server | null = null;
let _port: number = ENV.PII_REVIEW_PORT;

/** Get review_ui.html content: embedded string first, then disk fallback */
/** Log to both audit file (same as NER logs) and stderr */
function reviewLog(msg: string): void {
  const full = `[Review] ${msg}`;
  try { (globalThis as any).__earlyLog?.(full); } catch { /* ignore */ }
  console.error(full);
}

function getReviewHtmlContent(): string {
  // Primary: embedded in bundle by esbuild (loader: { ".html": "text" })
  reviewLog(`EMBEDDED_REVIEW_HTML check: type=${typeof EMBEDDED_REVIEW_HTML}, len=${typeof EMBEDDED_REVIEW_HTML === "string" ? EMBEDDED_REVIEW_HTML.length : "N/A"}`);
  if (typeof EMBEDDED_REVIEW_HTML === "string" && EMBEDDED_REVIEW_HTML.length > 100) {
    reviewLog(`Serving embedded HTML (${EMBEDDED_REVIEW_HTML.length} chars)`);
    return EMBEDDED_REVIEW_HTML;
  }
  // Fallback: read from disk (dev mode / unbundled)
  reviewLog("EMBEDDED not available, trying disk fallback...");
  const candidates = [
    path.join(process.cwd(), "assets", "review_ui.html"),
    path.join(process.cwd(), "server", "review_ui.html"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "assets", "review_ui.html"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "..", "assets", "review_ui.html"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        reviewLog(`Disk fallback HIT: ${p} (${fs.statSync(p).size} bytes)`);
        return fs.readFileSync(p, "utf-8");
      }
    } catch { /* next */ }
  }
  throw new Error("review_ui.html not found");
}

export function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = (req.url || "/").split("?")[0];

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && urlPath.startsWith("/review/")) {
    const sessionId = urlPath.split("/review/")[1];
    serveReviewPage(sessionId, res);
  } else if (req.method === "GET" && urlPath.startsWith("/api/review/")) {
    const sessionId = urlPath.split("/api/review/")[1];
    serveReviewData(sessionId, res);
  } else if (req.method === "POST" && urlPath.includes("/api/approve/")) {
    const sessionId = urlPath.split("/api/approve/")[1];
    readBody(req, (body) => handleApprove(sessionId, body, res));
  } else if (req.method === "POST" && urlPath.includes("/api/remove_entity/")) {
    const sessionId = urlPath.split("/api/remove_entity/")[1];
    readBody(req, (body) => handleRemoveEntity(sessionId, body, res));
  } else if (req.method === "POST" && urlPath.includes("/api/add_entity/")) {
    const sessionId = urlPath.split("/api/add_entity/")[1];
    readBody(req, (body) => handleAddEntity(sessionId, body, res));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
}

export function readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => cb(Buffer.concat(chunks).toString("utf-8")));
}

export function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

export function serveReviewPage(sessionId: string, res: http.ServerResponse): void {
  reviewLog(`serveReviewPage called for session=${sessionId}`);
  const review = getReview(sessionId);
  if (!review) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Review session not found: ${sessionId}</h1>`);
    return;
  }
  try {
    let html = getReviewHtmlContent();
    reviewLog(`Serving HTML (${html.length} chars), has_v2.1=${html.includes("v2.1")}, has_split=${html.includes("split-btn")}`);
    // Server-side version injection — proves the NEW server served this page
    const versionTag = `<script>console.log("[PII-SERVER] v2.1 served at ${new Date().toISOString()}, session=${sessionId}");document.title="PII Shield Review v2.1";</script>`;
    html = html.replace("<head>", `<head>\n${versionTag}`);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "X-PII-Version": "2.1",
    });
    res.end(html);
  } catch (e) {
    reviewLog(`getReviewHtmlContent FAILED: ${e}`);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end("<h1>review_ui.html not found</h1>");
  }
}

export function serveReviewData(sessionId: string, res: http.ServerResponse): void {
  const review = getReview(sessionId);
  if (!review) {
    sendJson(res, { error: `Review session not found: ${sessionId}` }, 404);
    return;
  }
  console.error(`[Review API] GET /api/review/${sessionId}: entities=${(review.entities || []).length}, text_len=${(review.original_text || "").length}, has_html=${!!(review.html_text)}`);
  sendJson(res, {
    session_id: sessionId,
    original_text: review.original_text || "",
    entities: review.entities || [],
    // Match the field name the UI expects (original_html, not html_text)
    original_html: review.html_text || "",
    anonymized_text: review.anonymized_text || "",
    approved: review.approved || false,
    overrides: review.overrides || { remove: [], add: [] },
  });
}

export function handleApprove(sessionId: string, body: string, res: http.ServerResponse): void {
  reviewLog(`handleApprove called for session=${sessionId}, body_len=${body.length}`);
  const review = getReview(sessionId);
  if (!review) {
    reviewLog(`handleApprove: session ${sessionId} NOT FOUND`);
    sendJson(res, { error: "Session not found" }, 404);
    return;
  }
  let overrides: any = {};
  try { overrides = JSON.parse(body); } catch { /* empty */ }
  review.overrides = {
    remove: overrides.remove || [],
    add: overrides.add || [],
  };
  review.approved = true;
  saveReview(sessionId, review);
  reviewLog(`handleApprove: session ${sessionId} APPROVED (remove=${review.overrides.remove.length}, add=${review.overrides.add.length})`);
  sendJson(res, { status: "approved", session_id: sessionId });
}

/**
 * GET-based approve handler for fire-and-forget from cross-origin contexts
 * (e.g. file:// iframe in Cowork). Returns a 1x1 transparent GIF so <img>
 * tag completes without error. Overrides arrive as ?data=JSON query param.
 */
export function handleApproveGet(sessionId: string, query: string, res: http.ServerResponse): void {
  reviewLog(`handleApproveGet called for session=${sessionId}, query_len=${query.length}`);
  const params = new URLSearchParams(query);
  const dataStr = params.get("data") || params.get("overrides") || "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(dataStr); } catch { /* empty */ }
  const overrides = parsed.overrides || { remove: parsed.remove || [], add: parsed.add || [] };

  const review = getReview(sessionId);
  if (!review) {
    reviewLog(`handleApproveGet: session ${sessionId} NOT FOUND`);
    res.writeHead(404, { "Content-Type": "image/gif" });
    res.end();
    return;
  }
  review.overrides = { remove: overrides.remove || [], add: overrides.add || [] };
  review.approved = true;
  saveReview(sessionId, review);
  reviewLog(`handleApproveGet: session ${sessionId} APPROVED via GET (remove=${review.overrides.remove.length}, add=${review.overrides.add.length})`);

  // 1x1 transparent GIF
  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.writeHead(200, { "Content-Type": "image/gif", "Content-Length": String(pixel.length) });
  res.end(pixel);
}

export function handleRemoveEntity(sessionId: string, body: string, res: http.ServerResponse): void {
  const review = getReview(sessionId);
  if (!review) { sendJson(res, { error: "Session not found" }, 404); return; }
  try {
    const data = JSON.parse(body);
    const idx = data.index;
    if (typeof idx === "number" && idx >= 0 && idx < (review.entities?.length || 0)) {
      if (!review.overrides) review.overrides = { remove: [], add: [] };
      if (!review.overrides.remove.includes(idx)) {
        review.overrides.remove.push(idx);
        saveReview(sessionId, review);
      }
    }
  } catch { /* ignore */ }
  sendJson(res, { ok: true, overrides: review.overrides });
}

export function handleAddEntity(sessionId: string, body: string, res: http.ServerResponse): void {
  const review = getReview(sessionId);
  if (!review) { sendJson(res, { error: "Session not found" }, 404); return; }
  try {
    const data = JSON.parse(body);
    const text = (data.text || "").trim();
    const start = data.start ?? -1;
    const end = data.end ?? -1;
    if (!text || start < 0 || end <= start) {
      sendJson(res, { error: "Invalid entity" }, 400);
      return;
    }
    if (!review.overrides) review.overrides = { remove: [], add: [] };
    review.overrides.add.push({ text, type: data.type || "PERSON", start, end });
    saveReview(sessionId, review);
  } catch { /* ignore */ }
  sendJson(res, { ok: true, overrides: review.overrides });
}

/** Start the review HTTP server. Returns the port number. */
export function startReviewServer(): number {
  if (_server) return _port;

  _port = ENV.PII_REVIEW_PORT;

  try {
    _server = http.createServer(handleRequest);
    _server.listen(_port, "127.0.0.1");
    console.error(`[Review] Server started on http://127.0.0.1:${_port}`);
  } catch {
    // Try next port
    _port++;
    try {
      _server = http.createServer(handleRequest);
      _server.listen(_port, "127.0.0.1");
      console.error(`[Review] Server started on http://127.0.0.1:${_port}`);
    } catch (e) {
      console.error(`[Review] Failed to start server: ${e}`);
      return 0;
    }
  }

  return _port;
}

/** Open a URL in the default browser */
export function openBrowser(url: string): void {
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors */ });
}

export function getReviewPort(): number {
  return _port;
}

/**
 * Generate a self-contained HTML review file.
 * Used when HTTP server isn't accessible (e.g. Cowork VM).
 * Embeds review data as JSON in the HTML — user opens locally in browser.
 */
export function generateReviewHtml(sessionId: string, outputDir: string): string | null {
  const review = getReview(sessionId);
  if (!review) return null;

  let template: string;
  try {
    template = getReviewHtmlContent();
  } catch {
    console.error("[Review] review_ui.html template not found");
    return null;
  }

  // Data to embed (same structure the UI expects from /api/review/)
  const reviewPayload = {
    session_id: sessionId,
    original_text: review.original_text || "",
    anonymized_text: review.anonymized_text || "",
    entities: review.entities || [],
    original_html: review.html_text || "",
    approved: review.approved || false,
    overrides: review.overrides || { remove: [], add: [] },
  };

  // Inject data + standalone flag. The review_secret / AES-GCM code-paste path
  // was removed — approval is a plain JSON auto-download to the user's browser
  // Downloads folder, picked up by get_review_status / apply_review_decisions
  // via filesystem search. See plugin/skills/.../references/hitl-review.md.
  // Phase 6 Fix 6.3: plumb the workspace dir into the page so the Approve
  // handler can target it directly via showDirectoryPicker / showSaveFilePicker.
  // In Cowork the VM-side server can ONLY see this folder via the VirtioFS
  // mount, so dropping the JSON anywhere else (e.g. host Downloads) is invisible.
  const sidecarPort = parseInt(process.env.PII_SHIELD_HTTP_PORT || "6789", 10);
  const injection = `
<script>
window.STANDALONE_MODE = true;
window.REVIEW_DATA = ${JSON.stringify(reviewPayload)};
window.WORKSPACE_DIR = ${JSON.stringify(outputDir)};
window.PII_SHIELD_PORT = "${sidecarPort}";
</script>`;

  const html = template.replace("</head>", `${injection}\n</head>`);

  // Write to output directory
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `review_${sessionId}.html`);
  fs.writeFileSync(outPath, html, "utf-8");

  console.error(`[Review] Standalone HTML written to ${outPath}`);
  return outPath;
}
