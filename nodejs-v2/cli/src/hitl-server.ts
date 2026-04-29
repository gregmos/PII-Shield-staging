/**
 * PII Shield CLI — HITL HTTP server.
 *
 * Local-only review UI for CLI users. Mirrors the MCP Apps wire protocol
 * (start_review payload + apply_review_overrides) over plain HTTP/JSON.
 *
 * Security model:
 *   - Bind to 127.0.0.1 only — never accessible off-host.
 *   - Random 32-hex bearer token generated per invocation. The browser
 *     URL contains it (`?token=…`); every API request must echo it back
 *     either as the `Authorization: Bearer <t>` header or `?token=` query.
 *   - Origin / Referer check: POST endpoints accept requests only if the
 *     header points at our own host (or is absent — same-origin XHR).
 *   - Idle timeout: 30 minutes without activity → close, reject promise.
 *     UI heartbeats every 30 s to keep the timer alive while the user reads.
 *
 * The review-cli.html is inlined via esbuild's text loader during build.
 * In dev (tsx) the import resolves to a real file read from dist/.
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { URL } from "node:url";
import {
  getReview,
  saveReview,
  updateDocReview,
  type ReviewOverrides,
} from "../../src/mapping/review-store.js";
import { logServer } from "../../src/audit/audit-logger.js";
import { registerCleanup } from "./cleanup-registry.js";

// At build time esbuild's text loader inlines the file as a string.
// At dev time (tsx) we fall back to reading from dist/ui/review-cli.html.
// @ts-ignore — handled by esbuild loader: { ".html": "text" }
import REVIEW_CLI_HTML_INLINED from "../../dist/ui/review-cli.html";

function loadReviewHtml(): string {
  if (typeof REVIEW_CLI_HTML_INLINED === "string" && REVIEW_CLI_HTML_INLINED.length > 100) {
    return REVIEW_CLI_HTML_INLINED;
  }
  // Dev fallback (tsx without esbuild text loader).
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "../../dist/ui/review-cli.html"),
      path.resolve(here, "../../../dist/ui/review-cli.html"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
    }
  } catch {
    /* ignore */
  }
  return `<!doctype html><html><body><h1>review-cli.html not built</h1>
    <p>Run <code>npm run build:cli</code> first.</p></body></html>`;
}

export interface ReviewServerResult {
  status: "approved" | "cancelled" | "timeout";
  /**
   * Raw apply events — one per /apply call. Includes duplicates from the
   * bulk-mode UI's re-flush behaviour, so don't use length as a count of
   * approved docs. Use `approvedDocIds` for that.
   */
  approvals: Array<{ session_id: string; doc_id: string; archived_path?: string }>;
  /**
   * The doc_ids the user explicitly approved (one per Approve-button click,
   * deduplicated). Empty unless `status === "approved"`.
   */
  approvedDocIds?: string[];
}

function pickPort(start: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = () => {
      const srv = http.createServer();
      srv.once("error", () => {
        srv.close();
        port += 1;
        if (port > end) {
          reject(new Error(`No free port in ${start}-${end}`));
          return;
        }
        tryPort();
      });
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve(port));
      });
    };
    tryPort();
  });
}

function checkAuth(req: http.IncomingMessage, token: string, parsed: URL): boolean {
  const headerAuth = req.headers["authorization"];
  if (typeof headerAuth === "string" && headerAuth === `Bearer ${token}`) return true;
  const queryToken = parsed.searchParams.get("token");
  return queryToken === token;
}

function checkOrigin(req: http.IncomingMessage, host: string): boolean {
  const origin = req.headers["origin"];
  const referer = req.headers["referer"];
  // Allow missing Origin/Referer (some same-origin XHR don't send Origin).
  if (!origin && !referer) return true;
  const allowed = `http://${host}`;
  if (origin && origin === allowed) return true;
  if (referer && referer.startsWith(allowed)) return true;
  return false;
}

function readBody(req: http.IncomingMessage, max = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let acc = "";
    req.on("data", (c) => {
      acc += c.toString("utf8");
      if (acc.length > max) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(acc));
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(data);
}

/**
 * Start the review server, return a promise that resolves when the user
 * approves all documents (or rejects on cancel/timeout).
 *
 * Idle timeout is generous (30 min) and is reset by the UI's heartbeat
 * (`/api/sessions/heartbeat` every 30 s), so a user reading a long legal
 * document doesn't get the server pulled out from under them.
 */
export async function runReviewServer(
  sessionId: string,
  opts: { idleTimeoutMs?: number } = {},
): Promise<{ url: string; result: Promise<ReviewServerResult> }> {
  const review = getReview(sessionId);
  if (!review) {
    throw new Error(`No review data found for session '${sessionId}'.`);
  }
  if (!review.documents || review.documents.length === 0) {
    throw new Error(`Session '${sessionId}' has no documents to review.`);
  }

  const idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
  const token = crypto.randomBytes(16).toString("hex");
  const port = await pickPort(6789, 6799);
  const host = `127.0.0.1:${port}`;
  const html = loadReviewHtml();

  const approvals: ReviewServerResult["approvals"] = [];
  // Per-doc explicit approval set. A doc is added to this set ONLY when the
  // shim sends `/api/sessions/approve` for it — fired once when the user
  // clicks the Approve button while that tab is active. /done gates on
  // `approvedSet ⊇ allDocIds`, which is bulletproof against:
  //   - naive `curl /done` (set is empty)
  //   - first-click bulk-loop /apply storm (apply doesn't touch the set)
  //   - imbalanced apply counts (e.g. d1 twice + d2 once → set still missing d2)
  const approvedSet = new Set<string>();
  const docCount = review.documents.length;
  const allDocIds = new Set(review.documents.map((d) => d.doc_id));
  let resolveResult!: (r: ReviewServerResult) => void;
  let rejectResult!: (e: Error) => void;
  const resultPromise = new Promise<ReviewServerResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  let idleTimer: NodeJS.Timeout;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logServer(`[HITL] idle timeout after ${idleTimeoutMs}ms — closing server`);
      server.close();
      resolveResult({ status: "timeout", approvals });
    }, idleTimeoutMs);
  };

  const server = http.createServer(async (req, res) => {
    resetIdle();
    const url = new URL(req.url ?? "/", `http://${host}`);

    try {
      // 1. Static: GET / (HTML)
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(html);
        return;
      }

      // All API endpoints need auth + same-origin.
      const authed = checkAuth(req, token, url);
      if (!authed) {
        jsonResponse(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method !== "GET" && !checkOrigin(req, host)) {
        jsonResponse(res, 403, { error: "cross-origin denied" });
        return;
      }

      // 2. GET /api/sessions/init — initial payload (bulk-mode shape).
      if (req.method === "GET" && url.pathname === "/api/sessions/init") {
        const fresh = getReview(sessionId);
        if (!fresh) {
          jsonResponse(res, 404, { error: "session vanished" });
          return;
        }
        const sessions = fresh.documents.map((doc) => ({
          session_id: fresh.session_id,
          doc_id: doc.doc_id,
          source_filename: doc.source_filename,
          original_text: doc.original_text,
          html_text: doc.html_text,
          anonymized_text: doc.anonymized_text,
          entities: doc.entities,
          overrides: doc.overrides,
          approved: doc.approved,
        }));
        jsonResponse(res, 200, { sessions, is_bulk: sessions.length > 1 });
        return;
      }

      // 3. POST /api/sessions/apply — accept overrides for a doc.
      if (req.method === "POST" && url.pathname === "/api/sessions/apply") {
        const body = JSON.parse(await readBody(req)) as {
          session_id?: string;
          doc_id?: string;
          overrides?: ReviewOverrides;
        };
        if (body.session_id !== sessionId) {
          jsonResponse(res, 400, { error: "session_id mismatch" });
          return;
        }
        const overrides = body.overrides ?? { remove: [], add: [] };
        const data = getReview(sessionId);
        if (!data) {
          jsonResponse(res, 404, { error: "review missing" });
          return;
        }
        const doc = data.documents.find((d) => d.doc_id === body.doc_id);
        if (!doc) {
          jsonResponse(res, 404, { error: "doc not found" });
          return;
        }
        // Persist overrides ONLY. /apply is fired by the bulk-mode UI for
        // every doc on every Approve click, so it's not a reliable signal of
        // user intent on its own. The shim sends /api/sessions/approve for
        // the active tab's doc_id; that route is the explicit approval
        // signal /done validates against.
        updateDocReview(sessionId, doc.doc_id, { overrides });
        approvals.push({
          session_id: sessionId,
          doc_id: doc.doc_id,
        });
        jsonResponse(res, 200, {
          status: "applied",
          session_id: sessionId,
          doc_id: doc.doc_id,
          remove_count: overrides.remove?.length ?? 0,
          add_count: overrides.add?.length ?? 0,
        });
        return;
      }

      // 4. POST /api/sessions/approve — explicit "user approved this doc".
      // Fired by the shim once per Approve-button click, with the active
      // tab's doc_id. Idempotent: repeated approvals for the same doc are
      // no-ops. /done gates on this set, not /apply counts.
      if (req.method === "POST" && url.pathname === "/api/sessions/approve") {
        const body = JSON.parse(await readBody(req)) as {
          session_id?: string;
          doc_id?: string;
        };
        if (body.session_id !== sessionId) {
          jsonResponse(res, 400, { error: "session_id mismatch" });
          return;
        }
        if (!body.doc_id || !allDocIds.has(body.doc_id)) {
          jsonResponse(res, 404, { error: "unknown doc_id" });
          return;
        }
        approvedSet.add(body.doc_id);
        jsonResponse(res, 200, {
          status: "approved",
          doc_id: body.doc_id,
          approved_count: approvedSet.size,
          doc_count: docCount,
        });
        return;
      }

      // 5. POST /api/sessions/done — user finished all reviews. Validates
      // that every doc was explicitly approved via /api/sessions/approve.
      if (req.method === "POST" && url.pathname === "/api/sessions/done") {
        const missing = [...allDocIds].filter((id) => !approvedSet.has(id));
        if (missing.length > 0) {
          jsonResponse(res, 400, {
            error: "review incomplete",
            doc_count: docCount,
            approved_count: approvedSet.size,
            missing_doc_ids: missing,
            hint:
              "Click Approve on every tab. The success overlay appears once each document is explicitly approved.",
          });
          return;
        }
        for (const id of approvedSet) {
          updateDocReview(sessionId, id, { approved: true });
        }
        jsonResponse(res, 200, {
          status: "ok",
          approved_count: approvedSet.size,
        });
        setImmediate(() => {
          server.close();
          clearTimeout(idleTimer);
          resolveResult({
            status: "approved",
            approvals,
            approvedDocIds: [...approvedSet],
          });
        });
        return;
      }

      // 5. POST /api/sessions/cancel
      if (req.method === "POST" && url.pathname === "/api/sessions/cancel") {
        jsonResponse(res, 200, { status: "cancelled" });
        setImmediate(() => {
          server.close();
          clearTimeout(idleTimer);
          resolveResult({ status: "cancelled", approvals });
        });
        return;
      }

      // 6. POST /api/sessions/heartbeat — UI ping to keep idle timer alive
      // while the user reads. resetIdle() at the top of the handler does the
      // actual work; we just acknowledge.
      if (req.method === "POST" && url.pathname === "/api/sessions/heartbeat") {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      jsonResponse(res, 404, { error: "not found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logServer(`[HITL] handler error: ${msg}`);
      jsonResponse(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  resetIdle();

  const url = `http://${host}/?token=${token}`;
  // Log a token-free version to the persistent audit file. The full URL is
  // returned to the CLI which prints it to stdout — token never touches
  // disk. (Audit logs may be shared with us for diagnostic; the
  // single-use token is harmless after server close, but persisting it is
  // poor hygiene.)
  logServer(`[HITL] server listening at http://${host}/ for session ${sessionId} (token redacted)`);

  // If the server errors out, reject the promise.
  server.on("error", (e) => {
    rejectResult(e);
  });

  // Register graceful shutdown for SIGINT/SIGTERM. Removes itself once
  // the server closes normally.
  const unregister = registerCleanup(() => {
    return new Promise<void>((res) => {
      try {
        clearTimeout(idleTimer);
        server.close(() => res());
      } catch {
        res();
      }
    });
  });
  server.on("close", () => unregister());

  return { url, result: resultPromise };
}
