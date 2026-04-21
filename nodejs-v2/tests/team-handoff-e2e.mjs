#!/usr/bin/env node

/**
 * End-to-end team-handoff test (plan Flow D).
 * Lawyer A anonymizes + exports; Lawyer B imports + deanonymizes on a
 * separate mappings dir (simulating a second machine).
 *
 * Prerequisites: same as multi-file-session-e2e.mjs (build + NER model
 * staged). Run:  node tests/team-handoff-e2e.mjs
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
const STAGED_DIR = path.join(PROJECT, "dist", "staging", "pii-shield-v2.0.0");
const STAGED_BUNDLE = path.join(STAGED_DIR, "server.bundle.mjs");
const STAGED_MODELS = path.join(STAGED_DIR, "models", "gliner-pii-base-v1.0");

if (!fs.existsSync(FRESH_BUNDLE)) { console.error(`Missing ${FRESH_BUNDLE}`); process.exit(1); }
if (!fs.existsSync(STAGED_MODELS)) { console.error(`Missing staged model`); process.exit(1); }
const freshMs = fs.statSync(FRESH_BUNDLE).mtimeMs;
const stagedMs = fs.existsSync(STAGED_BUNDLE) ? fs.statSync(STAGED_BUNDLE).mtimeMs : 0;
if (freshMs > stagedMs) {
  fs.copyFileSync(FRESH_BUNDLE, STAGED_BUNDLE);
  console.log(`Updated staged bundle.`);
}
const BUNDLE = STAGED_BUNDLE;

let passed = 0, failed = 0;
function check(c, m) { if (c) { console.log(`  ok  ${m}`); passed++; } else { console.log(`  FAIL ${m}`); failed++; } }

// JSON-RPC plumbing
function makeServer(mappingsDir) {
  const proc = spawn("node", [BUNDLE], {
    env: { ...process.env, PII_SHIELD_MAPPINGS_DIR: mappingsDir, PII_SKIP_REVIEW: "true" },
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

async function makeDocx(filepath, paragraphs) {
  const doc = new Document({ sections: [{ properties: {}, children: paragraphs.map((p) => new Paragraph({ children: [new TextRun(p)] })) }] });
  await fs.promises.writeFile(filepath, await Packer.toBuffer(doc));
}

async function waitForNer(srv) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await srv.callTool("list_entities");
    if (r.ner_ready === true) return true;
    await new Promise((res) => setTimeout(res, 5000));
  }
  return false;
}

async function main() {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pii-handoff-"));
  const mappingsA = path.join(tmp, "mappings-A");
  const mappingsB = path.join(tmp, "mappings-B");
  fs.mkdirSync(mappingsA, { recursive: true });
  fs.mkdirSync(mappingsB, { recursive: true });
  const docPath = path.join(tmp, "contract.docx");
  await makeDocx(docPath, [
    "Master Services Agreement between Acme Corporation and Pepsi Inc.",
    "Signed by John Smith on 2026-04-19.",
    "Counterparty contact: jane@pepsi.com.",
  ]);

  // ── Lawyer A ────────────────────────────────────────────────────────────
  console.log("\n## Lawyer A — anonymize + export");
  const srvA = makeServer(mappingsA);
  await srvA.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "handoff-e2e", version: "1" } });
  check(await waitForNer(srvA), "A: NER ready");

  const anonRes = await srvA.callTool("anonymize_file", { file_path: docPath });
  check(anonRes.status === "success", "A: anonymize_file succeeded");
  const sid = anonRes.session_id;
  check(!!sid, "A: got session_id");
  console.log(`  session_id=${sid}`);

  const archivePath = path.join(tmp, "acme.pii-session");
  const expRes = await srvA.callTool("export_session", {
    session_id: sid,
    passphrase: "correct horse battery staple",
    output_path: archivePath,
  });
  check(expRes.status === "success", "A: export_session succeeded");
  check(fs.existsSync(archivePath), "A: archive file exists on disk");
  check(expRes.archive_size_bytes > 100, "A: archive has non-trivial size");

  srvA.proc.kill();
  await new Promise((res) => setTimeout(res, 200));

  // ── Lawyer B (separate mappings dir, simulates different machine) ──────
  console.log("\n## Lawyer B — import + deanonymize on separate machine");
  const srvB = makeServer(mappingsB);
  await srvB.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "handoff-e2e", version: "1" } });
  check(await waitForNer(srvB), "B: NER ready");

  // Sanity: B does NOT have the session yet — deanonymize should fail.
  const anonDocxPath = anonRes.docx_output_path;
  const deanonFail = await srvB.callTool("deanonymize_docx", { file_path: anonDocxPath });
  check(deanonFail.status === "error" || deanonFail.error,
    "B (pre-import): deanonymize_docx errors because mapping is not yet imported");

  // Wrong passphrase → error.
  const wrongPass = await srvB.callTool("import_session", { archive_path: archivePath, passphrase: "totally wrong" });
  check(wrongPass.status === "error", "B: wrong passphrase → error");
  check(/decryption/i.test(wrongPass.error || ""), "B: error mentions decryption");

  // Correct passphrase → import succeeds.
  const imp = await srvB.callTool("import_session", { archive_path: archivePath, passphrase: "correct horse battery staple" });
  check(imp.status === "success", "B: import_session succeeded");
  check(imp.session_id === sid, "B: imported session_id matches original");
  check(imp.document_count === 1, "B: imported 1 document");

  // Now deanonymize the colleague's file on machine B — without passing session_id.
  const deanon = await srvB.callTool("deanonymize_docx", { file_path: anonDocxPath });
  check(!deanon.error, "B (post-import): deanonymize_docx succeeded");
  check(deanon.session_id === sid, "B: deanonymize resolved same session_id");
  check(deanon.session_id_source === "custom_xml", "B: session_id_source=custom_xml");
  check(fs.existsSync(deanon.restored_path), "B: restored .docx exists");

  // Verify restored content has PII.
  const restoredBuf = await fs.promises.readFile(deanon.restored_path);
  const restoredZip = await JSZip.loadAsync(restoredBuf);
  const restoredXml = await restoredZip.file("word/document.xml").async("string");
  check(restoredXml.includes("Acme Corporation"), "B: restored doc has 'Acme Corporation'");
  check(restoredXml.includes("Pepsi Inc."), "B: restored doc has 'Pepsi Inc.'");
  check(restoredXml.includes("John Smith"), "B: restored doc has 'John Smith'");

  // Re-import without overwrite: should error.
  const reImp = await srvB.callTool("import_session", { archive_path: archivePath, passphrase: "correct horse battery staple" });
  check(reImp.status === "error", "B: re-import without overwrite errors");
  check(/already exists/i.test(reImp.error || ""), "B: error mentions already exists");

  // Re-import with overwrite: succeeds.
  const reImp2 = await srvB.callTool("import_session", { archive_path: archivePath, passphrase: "correct horse battery staple", overwrite: true });
  check(reImp2.status === "success", "B: re-import with overwrite succeeds");
  check(reImp2.overwritten === true, "B: overwritten flag true on second import");

  srvB.proc.kill();
  await fs.promises.rm(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
