#!/usr/bin/env node

/**
 * End-to-end test for v2.1 multi-file session + cross-session deanonymize.
 *
 * Covers plan Flow C (multi-file ANONYMIZE-ONLY → same session_id across
 * all outputs → deanonymize via custom.xml without passing session_id).
 *
 * Prerequisites:
 *   1. `npm run build` has produced dist/server.bundle.mjs
 *   2. NER model cache is warm (first ever run downloads ~665 MB and
 *      takes 2–5 min; this test will wait up to 10 min for readiness)
 *
 * Run:  node tests/multi-file-session-e2e.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun } from "docx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const FRESH_BUNDLE = path.join(PROJECT, "dist", "server.bundle.mjs");
// The NER backend resolves the bundled model via `path.dirname(import.meta.url)/models/...`.
// The fresh `npm run build` only rebuilds the JS bundle, not the 665 MB model split —
// that lives under dist/staging/<plugin>/models/. So for E2E we run the bundle
// *from* the staged dir, updating the bundle file to the freshly-built one.
const STAGED_DIR = path.join(PROJECT, "dist", "staging", "pii-shield-v2.0.0");
const STAGED_BUNDLE = path.join(STAGED_DIR, "server.bundle.mjs");
const STAGED_MODELS = path.join(STAGED_DIR, "models", "gliner-pii-base-v1.0");

if (!fs.existsSync(FRESH_BUNDLE)) {
  console.error(`Missing fresh bundle at ${FRESH_BUNDLE}. Run 'npm run build' first.`);
  process.exit(1);
}
if (!fs.existsSync(STAGED_MODELS)) {
  console.error(`Missing staged model at ${STAGED_MODELS}. Run 'npm run build:plugin' once to fetch the GLiNER model.`);
  process.exit(1);
}
// Sync: if fresh bundle is newer, overwrite the staged one so the test picks
// up v2.1 changes. (Plain file copy — sourcemap is not needed for the test.)
try {
  const freshMs = fs.statSync(FRESH_BUNDLE).mtimeMs;
  const stagedMs = fs.existsSync(STAGED_BUNDLE) ? fs.statSync(STAGED_BUNDLE).mtimeMs : 0;
  if (freshMs > stagedMs) {
    fs.copyFileSync(FRESH_BUNDLE, STAGED_BUNDLE);
    console.log(`Updated staged bundle with fresh build (${new Date(freshMs).toISOString()}).`);
  }
} catch (e) {
  console.error(`Could not sync staged bundle: ${e}`);
  process.exit(1);
}
const BUNDLE = STAGED_BUNDLE;

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

// ── JSON-RPC plumbing (same pattern as tests/e2e-test.mjs) ──────────────────
let stdoutBuffer = "";
const waiterById = new Map();
let nextId = 1;

function setupResponseReader(proc) {
  proc.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id !== undefined && waiterById.has(parsed.id)) {
          waiterById.get(parsed.id)(parsed);
          waiterById.delete(parsed.id);
        }
      } catch { /* non-JSON line (logs) */ }
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
}

function request(proc, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiterById.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function callTool(proc, name, args = {}) {
  const resp = await request(proc, "tools/call", { name, arguments: args });
  // Extract inner JSON string from content[0].text
  const textPart = resp?.result?.content?.find((c) => c.type === "text");
  if (!textPart) return { _raw: resp };
  try { return JSON.parse(textPart.text); } catch { return { _raw: textPart.text }; }
}

// ── Fixture builder ─────────────────────────────────────────────────────────
async function makeDocx(filepath, paragraphs) {
  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs.map((p) => new Paragraph({ children: [new TextRun(p)] })) }],
  });
  const buf = await Packer.toBuffer(doc);
  await fs.promises.writeFile(filepath, buf);
}

async function readDocxCustomProp(filepath, key) {
  const buf = await fs.promises.readFile(filepath);
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file("docProps/custom.xml");
  if (!file) return null;
  const xml = await file.async("string");
  const rx = new RegExp(`<property[^>]*name="${key}"[^>]*><vt:lpwstr>([^<]+)</vt:lpwstr></property>`);
  const m = rx.exec(xml);
  return m ? m[1] : null;
}

// ── Waiting for NER ─────────────────────────────────────────────────────────
async function waitForNer(proc) {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min
  let first = true;
  while (Date.now() < deadline) {
    const r = await callTool(proc, "list_entities");
    if (r.ner_ready === true) { console.log("  NER ready."); return true; }
    if (first) { console.log(`  NER loading: ${r.phase || "?"} (${r.progress_pct ?? "?"}%)`); first = false; }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pii-e2e-"));
  // Isolate mappings only — leave DATA_DIR alone so NER model cache is reused
  // from the user's existing ~/.pii_shield or CLAUDE_PLUGIN_DATA (avoid a
  // ~665 MB redownload for every test run).
  const mappingsDir = path.join(tmp, "mappings");
  fs.mkdirSync(mappingsDir, { recursive: true });

  const doc1 = path.join(tmp, "doc1.docx");
  const doc2 = path.join(tmp, "doc2.docx");
  const doc3 = path.join(tmp, "doc3.docx");

  await makeDocx(doc1, [
    "Agreement between Acme Corporation and John Smith.",
    "Dated 2026-04-19. Email: jsmith@acme.com.",
  ]);
  await makeDocx(doc2, [
    "Amendment #1 to the agreement between Acme Corporation and John Smith.",
    "New counterparty: Pepsi Inc. Contact: jane@pepsi.com.",
  ]);
  await makeDocx(doc3, [
    "Side letter from Pepsi Inc. countersigned by Jane Doe.",
  ]);

  console.log(`Fixtures in: ${tmp}`);

  // Spawn server
  const proc = spawn("node", [BUNDLE], {
    env: {
      ...process.env,
      PII_SHIELD_MAPPINGS_DIR: mappingsDir,
      PII_SKIP_REVIEW: "true", // avoid HITL loop in automated test
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  setupResponseReader(proc);

  // Initialize
  await request(proc, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "multi-file-e2e-test", version: "1.0" },
  });

  console.log("\n## Waiting for NER...");
  const ready = await waitForNer(proc);
  check(ready, "NER became ready within 10 min");
  if (!ready) { proc.kill(); process.exit(2); }

  console.log("\n## Flow C — multi-file session");
  const r1 = await callTool(proc, "anonymize_file", { file_path: doc1 });
  check(r1.status === "success", "doc1 anonymized");
  check(typeof r1.session_id === "string" && r1.session_id.length > 0, "doc1 got session_id");
  const sid = r1.session_id;
  console.log(`  session_id=${sid}  pool_size=${r1.pool_size}`);

  const r2 = await callTool(proc, "anonymize_file", { file_path: doc2, session_id: sid });
  check(r2.status === "success", "doc2 anonymized");
  check(r2.session_id === sid, "doc2 reused same session_id");
  check(r2.documents_in_session === 2, "session now has 2 documents");
  check(r2.pool_size >= r1.pool_size, "pool grew or stayed (identical entities reuse)");

  const r3 = await callTool(proc, "anonymize_file", { file_path: doc3, session_id: sid });
  check(r3.status === "success", "doc3 anonymized");
  check(r3.session_id === sid, "doc3 reused same session_id");
  check(r3.documents_in_session === 3, "session now has 3 documents");

  // Verify custom.xml contains session_id
  const cx1 = await readDocxCustomProp(r1.docx_output_path, "pii_shield.session_id");
  const cx2 = await readDocxCustomProp(r2.docx_output_path, "pii_shield.session_id");
  const cx3 = await readDocxCustomProp(r3.docx_output_path, "pii_shield.session_id");
  check(cx1 === sid, "doc1_anonymized.docx custom.xml has session_id");
  check(cx2 === sid, "doc2_anonymized.docx custom.xml has session_id");
  check(cx3 === sid, "doc3_anonymized.docx custom.xml has session_id");

  // Verify shared placeholders — read output .txt and check for same placeholder across files
  const txt1 = await fs.promises.readFile(r1.output_path, "utf-8");
  const txt2 = await fs.promises.readFile(r2.output_path, "utf-8");
  const txt3 = await fs.promises.readFile(r3.output_path, "utf-8");
  // "Acme" appears in doc1 and doc2 → must share placeholder
  const acmeMatches = (txt) => {
    const m = txt.match(/<(?:D\d+_)?ORG_\d+[a-z]?>/g);
    return m ? new Set(m) : new Set();
  };
  const acme1 = acmeMatches(txt1);
  const acme2 = acmeMatches(txt2);
  const shared = [...acme1].filter((p) => acme2.has(p));
  check(shared.length > 0, "at least one ORG placeholder shared between doc1 and doc2");

  // Pepsi appears in doc2 and doc3
  const pepsi23 = [...acmeMatches(txt2)].filter((p) => acmeMatches(txt3).has(p));
  check(pepsi23.length > 0, "at least one ORG placeholder shared between doc2 and doc3");

  console.log("\n## Flow B — cross-session deanonymize via custom.xml");
  // Simulate new chat: deanonymize WITHOUT passing session_id
  const rd1 = await callTool(proc, "deanonymize_docx", { file_path: r1.docx_output_path });
  check(!rd1.error, "deanonymize_docx without session_id succeeded");
  check(rd1.session_id === sid, "deanonymize resolved session_id from custom.xml");
  check(rd1.session_id_source === "custom_xml", "session_id_source=custom_xml");
  check(typeof rd1.restored_path === "string" && fs.existsSync(rd1.restored_path), "restored file written");

  // The restored .docx should contain original PII
  const restoredBuf = await fs.promises.readFile(rd1.restored_path);
  const restoredZip = await JSZip.loadAsync(restoredBuf);
  const restoredDoc = await restoredZip.file("word/document.xml").async("string");
  check(restoredDoc.includes("Acme Corporation"), "restored doc contains 'Acme Corporation'");
  check(restoredDoc.includes("John Smith"), "restored doc contains 'John Smith'");

  // Cleanup
  proc.kill();
  await fs.promises.rm(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
