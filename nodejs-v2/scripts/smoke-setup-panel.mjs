#!/usr/bin/env node
/**
 * PII Shield v2.1 — setup-panel stdio protocol smoke.
 *
 * Mirrors smoke-protocol.mjs but for the new install-flow surface:
 *   1. tools/list contains `start_model_setup` with `_meta.ui.resourceUri`
 *      pointing at `ui://pii-shield/setup.html`.
 *   2. tools/list contains `install_model_from_download` as a plain tool
 *      (no _meta.ui — it's a server tool, not UI-bearing).
 *   3. resources/list includes `ui://pii-shield/setup.html` with mimeType
 *      `text/html;profile=mcp-app`.
 *   4. resources/read on that URI returns HTML > 1 KB starting with
 *      `<!DOCTYPE html>` and containing the setup shell's topbar text
 *      ("PII Shield Setup").
 *   5. tools/call start_model_setup returns a well-formed envelope with
 *      structuredContent.status === "setup_ready" and includes the
 *      `model_zip_url` field.
 *   6. tools/call install_model_from_download with no model on disk and
 *      no zip in candidate dirs returns `{ status: "not_found" }` (NOT a
 *      crash) — clean error envelope.
 *
 * Does NOT actually install a model. The full happy-path (605 MB fake
 * model.onnx → ZIP → install → atomic move → forceReinitNer) is a
 * separate heavier smoke; see comment below for how to run it on demand.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, "..", "dist", "server.bundle.mjs");
const SETUP_URI = "ui://pii-shield/setup.html";

function must(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

async function main() {
  // Sandbox the data dir so we don't touch a real user install. Also point
  // the downloads-dir env at a known-empty temp dir so install_model_from_download
  // reliably returns not_found in this smoke.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piish-setup-smoke-"));
  const sandboxData = path.join(tmpRoot, "pii_shield_data");
  const emptyDownloads = path.join(tmpRoot, "empty-downloads");
  fs.mkdirSync(sandboxData, { recursive: true });
  fs.mkdirSync(emptyDownloads, { recursive: true });

  const child = spawn(process.execPath, [BUNDLE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PII_SHIELD_DATA_DIR: sandboxData,
      PII_SHIELD_MODEL_DOWNLOADS_DIR: emptyDownloads,
      // Empty PII_WORK_DIR so the candidate-paths scan doesn't accidentally
      // pick up a stray ZIP from the developer's actual work dir.
      PII_WORK_DIR: "",
      // Setting HOME to the temp root makes ~/Downloads, ~/Desktop, ~/Documents
      // all empty subdirs (or non-existent), so Tier 1 reliably misses.
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
    },
  });

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
        /* ignore non-JSON */
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
      }, 30000);
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  try {
    // ─── 1. initialize ─────────────────────────────────────────────────────
    const init = await rpc("initialize", {
      protocolVersion: "2026-01-26",
      capabilities: {},
      clientInfo: { name: "pii-shield-setup-smoke", version: "1" },
    });
    notify("notifications/initialized", {});
    must(init.result?.capabilities, "initialize missing capabilities");
    console.log(`✓ initialize OK (server=${init.result?.serverInfo?.name})`);

    // ─── 2. tools/list — start_model_setup with _meta.ui.resourceUri ───────
    const toolsList = await rpc("tools/list", {});
    must(Array.isArray(toolsList.result?.tools), "tools/list missing tools array");

    const startSetup = toolsList.result.tools.find((t) => t.name === "start_model_setup");
    must(startSetup, "start_model_setup not in tools/list");
    must(
      startSetup._meta?.ui?.resourceUri === SETUP_URI,
      `start_model_setup._meta.ui.resourceUri wrong: ${JSON.stringify(startSetup._meta)}`,
    );
    console.log(
      `✓ tools/list: start_model_setup → _meta.ui.resourceUri=${SETUP_URI}`,
    );

    const installTool = toolsList.result.tools.find(
      (t) => t.name === "install_model_from_download",
    );
    must(installTool, "install_model_from_download not in tools/list");
    must(
      !installTool._meta?.ui,
      "install_model_from_download should NOT have _meta.ui (it's a server tool)",
    );
    console.log(`✓ tools/list: install_model_from_download present as plain tool`);

    // ─── 3. resources/list — setup.html ─────────────────────────────────────
    const resourcesList = await rpc("resources/list", {});
    must(
      Array.isArray(resourcesList.result?.resources),
      "resources/list missing resources array",
    );
    const setupResource = resourcesList.result.resources.find(
      (r) => r.uri === SETUP_URI,
    );
    must(setupResource, `${SETUP_URI} not in resources/list`);
    must(
      setupResource.mimeType === "text/html;profile=mcp-app",
      `setup resource mimeType wrong: ${setupResource.mimeType}`,
    );
    console.log(`✓ resources/list: ${SETUP_URI} (mime=${setupResource.mimeType})`);

    // ─── 4. resources/read — setup HTML actually inlined ────────────────────
    const setupRead = await rpc("resources/read", { uri: SETUP_URI });
    const setupContents = setupRead.result?.contents?.[0];
    must(setupContents, "resources/read returned no contents");
    must(
      setupContents.mimeType === "text/html;profile=mcp-app",
      `setup contents mimeType wrong: ${setupContents.mimeType}`,
    );
    must(
      typeof setupContents.text === "string" && setupContents.text.length > 1024,
      `setup HTML too short: ${setupContents.text?.length} bytes`,
    );
    must(
      setupContents.text.startsWith("<!DOCTYPE html>") ||
        setupContents.text.startsWith("<!doctype html>"),
      "setup HTML missing DOCTYPE",
    );
    must(
      setupContents.text.includes("PII Shield Setup"),
      "setup HTML missing topbar title",
    );
    console.log(
      `✓ resources/read: ${setupContents.text.length} bytes, contains setup topbar title`,
    );

    // ─── 5. tools/call start_model_setup — well-formed envelope ─────────────
    const startResp = await rpc("tools/call", {
      name: "start_model_setup",
      arguments: {},
    });
    const startContent = startResp.result?.structuredContent;
    must(startContent, "start_model_setup returned no structuredContent");
    must(
      startContent.status === "setup_ready",
      `start_model_setup status wrong: ${startContent.status}`,
    );
    must(
      typeof startContent.model_zip_url === "string" &&
        startContent.model_zip_url.includes("gliner-pii-base-v1.0.zip"),
      "start_model_setup missing model_zip_url",
    );
    console.log(
      `✓ tools/call start_model_setup: status=${startContent.status}, ` +
        `zip=${startContent.model_zip_url.split("/").slice(-2).join("/")}`,
    );

    // ─── 6. tools/call install_model_from_download — clean not_found ────────
    // No model on disk, no ZIP in candidate dirs → must return not_found
    // with a hint, never crash.
    const installResp = await rpc("tools/call", {
      name: "install_model_from_download",
      arguments: {},
    });
    const installText = installResp.result?.content?.[0]?.text || "";
    let installPayload;
    try {
      installPayload = JSON.parse(installText);
    } catch {
      throw new Error(
        `install_model_from_download response not parseable: ${installText.slice(0, 200)}`,
      );
    }
    must(
      installPayload.status === "not_found",
      `install_model_from_download status wrong: ${installPayload.status} ` +
        `(expected not_found in empty sandbox)`,
    );
    must(
      installPayload.hint === "marker_required" ||
        installPayload.hint === "configure_dir",
      `install_model_from_download hint wrong: ${installPayload.hint}`,
    );
    must(
      Array.isArray(installPayload.searched) && installPayload.searched.length > 0,
      "install_model_from_download missing searched paths array",
    );
    console.log(
      `✓ tools/call install_model_from_download: status=not_found, ` +
        `hint=${installPayload.hint}, searched ${installPayload.searched.length} dirs`,
    );

    console.log(
      "\nPASS — all 6 PII Shield v2.1 setup-panel checks green.\n" +
        "       MCP Apps wiring: start_model_setup carries _meta.ui.resourceUri,\n" +
        "       ui://pii-shield/setup.html resource returns the Vite single-file HTML,\n" +
        "       install_model_from_download cleanly returns not_found in an empty sandbox.\n" +
        "\nNote: this smoke does NOT exercise the actual ZIP-extract → atomic-install\n" +
        "      → forceReinitNer happy path. To validate end-to-end, drop a real\n" +
        "      gliner-pii-base-v1.0.zip in the sandbox Downloads dir and re-call\n" +
        "      install_model_from_download (or run it manually against your real\n" +
        "      ~/Downloads after a release-page download).",
    );
    process.exit(0);
  } catch (e) {
    console.error("\nFAIL:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    child.kill();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

main().catch((e) => {
  console.error("uncaught:", e);
  process.exit(1);
});
