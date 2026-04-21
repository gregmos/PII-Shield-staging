#!/usr/bin/env node

/**
 * End-to-end test for the thin-mcpb + install-model-script design.
 *
 * Validates two scenarios on top of the fresh server.bundle.mjs:
 * 1. No model on disk → list_entities returns phase="needs_setup" envelope
 *    with the one-liner URLs and searched paths.
 * 2. PII_SHIELD_MODELS_DIR pointed at a dir that contains the real model →
 *    auto-BFS finds it, NER initializes, phase="ready".
 *
 * Run:  node tests/needs-setup-envelope-e2e.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const BUNDLE = path.join(PROJECT, "dist", "server.bundle.mjs");
const DEV_CACHE = path.join(os.homedir(), ".pii_shield_dev_cache", "models");

if (!fs.existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run 'npm run build' first.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(DEV_CACHE, "gliner-pii-base-v1.0", "model.onnx"))) {
  console.error(`Missing model in dev cache at ${DEV_CACHE}/gliner-pii-base-v1.0/model.onnx`);
  process.exit(1);
}

let passed = 0, failed = 0;
function check(c, m) { if (c) { console.log(`  ok  ${m}`); passed++; } else { console.log(`  FAIL ${m}`); failed++; } }

function makeServer(env) {
  const proc = spawn("node", [BUNDLE], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = new Map();
  let nextId = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line);
        if (p.id !== undefined && waiters.has(p.id)) { waiters.get(p.id)(p); waiters.delete(p.id); }
      } catch { /* logs */ }
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const callTool = async (name, args = {}) => {
    const r = await request("tools/call", { name, arguments: args });
    const text = r?.result?.content?.find((c) => c.type === "text");
    if (!text) return { _raw: r };
    try { return JSON.parse(text.text); } catch { return { _raw: text.text }; }
  };
  return { proc, request, callTool };
}

async function main() {
  const tmpMappings = fs.mkdtempSync(path.join(os.tmpdir(), "pii-ns-"));

  // ── Scenario 1: no model ─────────────────────────────────────────────────
  // Point HOME at an empty temp dir to bypass any existing ~/.pii_shield/
  // model on the dev machine. Also clear CLAUDE_PLUGIN_DATA and
  // PII_SHIELD_MODELS_DIR so auto-BFS finds nothing.
  console.log("\n## Scenario 1 — no model on disk");
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "pii-empty-home-"));
  const srv1 = makeServer({
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    PII_SHIELD_MAPPINGS_DIR: tmpMappings,
    PII_SHIELD_MODELS_DIR: "",
    CLAUDE_PLUGIN_DATA: "",
  });
  await srv1.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ns-test", version: "1" } });

  // Wait a moment for NER init to attempt + fail
  await new Promise((r) => setTimeout(r, 2000));

  const r1 = await srv1.callTool("list_entities");
  check(r1.phase === "needs_setup", `phase=needs_setup (got: ${r1.phase})`);
  check(r1.ner_ready === false, "ner_ready=false");
  check(typeof r1.user_message === "string" && r1.user_message.includes("install-model"),
    "user_message mentions install-model");
  check(!!r1.setup_instructions, "setup_instructions present");
  check(typeof r1.setup_instructions?.one_liner_windows === "string" && r1.setup_instructions.one_liner_windows.includes("iwr"),
    "Windows one-liner uses iwr");
  check(typeof r1.setup_instructions?.one_liner_mac_linux === "string" && r1.setup_instructions.one_liner_mac_linux.includes("curl"),
    "Unix one-liner uses curl");
  check(Array.isArray(r1.setup_instructions?.searched_paths) && r1.setup_instructions.searched_paths.length >= 2,
    `searched_paths ≥ 2 (got: ${r1.setup_instructions?.searched_paths?.length})`);
  check(r1.setup_instructions?.expected_path === "~/.pii_shield/models/gliner-pii-base-v1.0/",
    "expected_path points to ~/.pii_shield/models/");

  srv1.proc.kill();
  fs.rmSync(emptyHome, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 300));

  // ── Scenario 2: model found via PII_SHIELD_MODELS_DIR override ──────────
  console.log("\n## Scenario 2 — PII_SHIELD_MODELS_DIR points to dev cache");
  const srv2 = makeServer({
    PII_SHIELD_MAPPINGS_DIR: tmpMappings,
    PII_SHIELD_MODELS_DIR: DEV_CACHE,
  });
  await srv2.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ns-test-2", version: "1" } });

  // Poll list_entities until ready or timeout (NER deps install is slow first run,
  // but this dev machine already has deps → should be fast)
  const deadline = Date.now() + 3 * 60 * 1000;
  let finalPhase = "?";
  while (Date.now() < deadline) {
    const r = await srv2.callTool("list_entities");
    finalPhase = r.phase;
    if (r.ner_ready === true && r.phase === "ready") break;
    if (r.phase === "error" || r.phase === "needs_setup") {
      console.log(`  phase=${r.phase}, bailing: ${r.user_message || r.ner_error || "?"}`);
      break;
    }
    process.stdout.write(`  phase=${r.phase} ${r.progress_pct ?? "?"}%\r`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  console.log("");
  check(finalPhase === "ready", `phase=ready after init (got: ${finalPhase})`);

  srv2.proc.kill();
  fs.rmSync(tmpMappings, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
