#!/usr/bin/env node
/**
 * PII Shield v2.0.2 — stdio protocol smoke test.
 *
 * Validates that the MCP server, in isolation from any host, returns the
 * exact envelope shapes required by the MCP Apps spec (2026-01-26) for
 * the in-chat review panel.
 *
 * If any assertion here fails, the server is broken before it even talks
 * to Claude Desktop — fix here first.
 *
 * Checks:
 *   1. `initialize` responds with a well-formed capabilities object.
 *   2. `tools/list` includes `start_review` with BOTH forms of
 *      `_meta.ui.resourceUri` (the nested object form required by the
 *      spec AND the deprecated flat `_meta["ui/resourceUri"]` key that
 *      older Claude Desktop builds read). Emission is library-managed
 *      by `registerAppTool` in `@modelcontextprotocol/ext-apps`.
 *   3. `tools/list` includes `apply_review_overrides` as a plain tool
 *      (no `_meta.ui` expected — it's not a UI-resource-bearing tool).
 *   4. `resources/list` includes `ui://pii-shield/review.html` with
 *      mimeType `text/html;profile=mcp-app`.
 *   5. `resources/read` on that URI returns HTML >1 KB starting with
 *      `<!DOCTYPE html>` and containing the review shell's topbar text
 *      ("PII Shield Review") — proves the single-file Vite bundle is
 *      actually inlined into server.bundle.mjs.
 *   6. `tools/call start_review` (with no session_id) returns a
 *      well-formed envelope. Since no `anonymize_file` has run, it
 *      SHOULD return `structuredContent.status === "error"` with a
 *      human message — that's still a valid MCP response shape.
 *   7. `tools/call apply_review_overrides` with a non-existent
 *      session_id returns a cleanly-shaped error in content[0].text
 *      (no crash, no malformed envelope).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, "..", "dist", "server.bundle.mjs");
const REVIEW_URI = "ui://pii-shield/review.html";

function must(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

async function main() {
  const child = spawn(process.execPath, [BUNDLE], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Mirror server stderr so we can see trace lines in test output
  child.stderr.on("data", (c) => process.stderr.write("[server] " + c));

  const pending = new Map();
  let nextId = 1;
  let buf = "";

  child.stdout.on("data", (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* ignore non-JSON (shouldn't happen on stdout) */
      }
    }
  });

  function rpc(method, params) {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    child.stdin.write(frame);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout ${method} id=${id}`));
        }
      }, 10000);
    });
  }
  function notify(method, params) {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  try {
    // ─── 1. initialize ─────────────────────────────────────────────────────
    const init = await rpc("initialize", {
      protocolVersion: "2026-01-26",
      capabilities: {},
      clientInfo: { name: "pii-shield-smoke", version: "1" },
    });
    notify("notifications/initialized", {});

    const caps = init.result?.capabilities;
    must(caps, "initialize missing capabilities");
    console.log(
      `✓ initialize: protocolVersion=${init.result?.protocolVersion}, ` +
        `serverInfo.name=${init.result?.serverInfo?.name}`,
    );

    // ─── 2. tools/list — start_review with dual-key _meta.ui.resourceUri ───
    const toolsList = await rpc("tools/list", {});
    must(
      Array.isArray(toolsList.result?.tools),
      "tools/list missing tools array",
    );
    const startReview = toolsList.result.tools.find(
      (t) => t.name === "start_review",
    );
    must(startReview, "start_review not in tools/list");
    must(
      startReview._meta?.ui?.resourceUri === REVIEW_URI,
      `start_review._meta.ui.resourceUri wrong: ${JSON.stringify(startReview._meta)}`,
    );
    must(
      startReview._meta?.["ui/resourceUri"] === REVIEW_URI,
      `start_review._meta["ui/resourceUri"] (flat) wrong/missing: ${JSON.stringify(startReview._meta)}`,
    );
    console.log(
      `✓ tools/list: start_review has BOTH nested _meta.ui.resourceUri AND ` +
        `flat _meta["ui/resourceUri"] = ${REVIEW_URI}`,
    );

    // ─── 3. tools/list — apply_review_overrides is a plain tool ────────────
    const applyOverrides = toolsList.result.tools.find(
      (t) => t.name === "apply_review_overrides",
    );
    must(applyOverrides, "apply_review_overrides not in tools/list");
    // Plain tools should NOT carry _meta.ui.* keys.
    must(
      !applyOverrides._meta?.ui,
      `apply_review_overrides unexpectedly has _meta.ui: ${JSON.stringify(applyOverrides._meta)}`,
    );
    console.log(
      `✓ tools/list: apply_review_overrides present as plain tool (no _meta.ui)`,
    );

    // ─── 4. resources/list — ui://pii-shield/review.html ───────────────────
    const resList = await rpc("resources/list", {});
    const uiRes = resList.result?.resources?.find((r) => r.uri === REVIEW_URI);
    must(uiRes, `UI resource ${REVIEW_URI} not in resources/list`);
    must(
      uiRes.mimeType === "text/html;profile=mcp-app",
      `UI resource wrong mimeType: ${uiRes.mimeType}`,
    );
    console.log(`✓ resources/list: ${uiRes.uri} (mime=${uiRes.mimeType})`);

    // ─── 5. resources/read — HTML is inlined & non-trivial ─────────────────
    const read = await rpc("resources/read", { uri: REVIEW_URI });
    must(
      read.result?.contents?.length === 1,
      "resources/read must return 1 content entry",
    );
    const c0 = read.result.contents[0];
    must(
      c0.mimeType === "text/html;profile=mcp-app",
      `resources/read wrong mimeType: ${c0.mimeType}`,
    );
    must(
      typeof c0.text === "string" && c0.text.length > 1000,
      `resources/read text missing or too short (${c0.text?.length || 0} bytes)`,
    );
    must(
      c0.text.toLowerCase().startsWith("<!doctype html>"),
      `resources/read HTML does not start with <!DOCTYPE html>, got: ${c0.text.slice(0, 60)}…`,
    );
    must(
      c0.text.includes("PII Shield Review"),
      "HTML body does not contain 'PII Shield Review' (topbar title missing — Vite bundle may be stale)",
    );
    console.log(
      `✓ resources/read: ${c0.text.length} bytes HTML, mime=${c0.mimeType}, ` +
        `contains topbar title`,
    );

    // ─── 6. tools/call start_review — no session, but well-formed ──────────
    const startCall = await rpc("tools/call", {
      name: "start_review",
      arguments: {},
    });
    const scRes = startCall.result;
    must(
      Array.isArray(scRes?.content) && scRes.content.length > 0,
      "start_review response missing content array",
    );
    must(
      scRes.structuredContent && typeof scRes.structuredContent === "object",
      "start_review response missing structuredContent",
    );
    // With no anonymize_file call prior, we expect status=error — still a
    // valid MCP response. What matters is the envelope shape, not the payload.
    const sc = scRes.structuredContent;
    must(
      typeof sc.status === "string",
      `start_review structuredContent.status should be string, got ${typeof sc.status}`,
    );
    console.log(
      `✓ tools/call start_review: envelope well-formed ` +
        `(status="${sc.status}", content[0].text[0..60]="${scRes.content[0].text.slice(0, 60)}…")`,
    );

    // ─── 7. tools/call apply_review_overrides — bad session, clean error ───
    const applyCall = await rpc("tools/call", {
      name: "apply_review_overrides",
      arguments: {
        session_id: "no-such-session-smoke-xyz",
        overrides: { remove: [], add: [] },
      },
    });
    const acRes = applyCall.result;
    must(
      Array.isArray(acRes?.content) && acRes.content.length > 0,
      "apply_review_overrides response missing content array",
    );
    const bodyText = acRes.content[0].text;
    must(
      typeof bodyText === "string" && bodyText.length > 0,
      "apply_review_overrides content[0].text missing",
    );
    // Body should be JSON with an error field — we don't care about exact shape
    // here, just that the tool didn't crash or return a malformed envelope.
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (e) {
      throw new Error(`apply_review_overrides body is not JSON: ${bodyText.slice(0, 200)}`);
    }
    must(
      typeof parsed === "object" && parsed !== null,
      "apply_review_overrides body parsed to non-object",
    );
    console.log(
      `✓ tools/call apply_review_overrides: clean error envelope for unknown session ` +
        `(body[0..80]="${bodyText.slice(0, 80)}…")`,
    );

console.log("\nPASS — all 7 PII Shield v2.0.2 protocol checks green.");
    console.log(
      "       MCP Apps wiring: start_review descriptor carries dual-key resourceUri,",
    );
    console.log(
      `       ${REVIEW_URI} resource returns the Vite single-file HTML,`,
    );
    console.log(
      "       apply_review_overrides plain tool handles bad inputs without crashing.",
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
