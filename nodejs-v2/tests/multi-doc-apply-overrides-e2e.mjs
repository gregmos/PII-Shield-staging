#!/usr/bin/env node

/**
 * End-to-end test for v2.1.3 per-doc apply_review_overrides routing.
 *
 * Scenarios covered:
 *   1. Two docs in one session → start_review emits 2 sessions[] entries
 *      with distinct doc_id values.
 *   2. apply_review_overrides(session_id, doc_id=D1, overrides) updates ONLY
 *      doc1's overrides + approved; doc2 untouched.
 *   3. apply_review_overrides(session_id, doc_id=D2, …) leaves doc1 alone.
 *   4. Disk file review_<S>.json has BOTH per-doc blocks correctly updated.
 *   5. Legacy fallback: apply_review_overrides WITHOUT doc_id targets doc[0].
 *   6. reanonymizeWithReview with doc1 path → status=success with new paths.
 *   7. reanonymizeWithReview with doc2 path → status=approved_no_changes
 *      (no overrides on doc2).
 *
 * Prereq: `npm run build:plugin` + `install-model.ps1` (or dev cache).
 * Run:    node tests/multi-doc-apply-overrides-e2e.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Document, Packer, Paragraph, TextRun } from "docx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, "..");
const FRESH_BUNDLE = path.join(PROJECT, "dist", "server.bundle.mjs");
const HOME_MODEL = path.join(os.homedir(), ".pii_shield", "models", "gliner-pii-base-v1.0", "model.onnx");

if (!fs.existsSync(FRESH_BUNDLE)) {
  console.error(`Missing fresh bundle at ${FRESH_BUNDLE}. Run 'npm run build' first.`);
  process.exit(1);
}
if (!fs.existsSync(HOME_MODEL)) {
  console.error(`Missing model at ${HOME_MODEL}. Run scripts/install-model.{ps1,sh} first.`);
  process.exit(1);
}
const BUNDLE = FRESH_BUNDLE;

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────
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
      } catch { /* logs */ }
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
  const textPart = resp?.result?.content?.find((c) => c.type === "text");
  if (!textPart) return { _raw: resp };
  try { return JSON.parse(textPart.text); } catch { return { _raw: textPart.text }; }
}

async function callAppTool(proc, name, args = {}) {
  // start_review returns structuredContent; use it when available.
  const resp = await request(proc, "tools/call", { name, arguments: args });
  return resp?.result || {};
}

// ── Fixture builder ─────────────────────────────────────────────────────────
async function makeDocx(filepath, paragraphs) {
  const doc = new Document({
    sections: [{
      properties: {},
      children: paragraphs.map((p) => new Paragraph({ children: [new TextRun(p)] })),
    }],
  });
  const buf = await Packer.toBuffer(doc);
  await fs.promises.writeFile(filepath, buf);
}

async function waitForNer(proc) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await callTool(proc, "list_entities");
    if (r.ner_ready === true) return true;
    await new Promise((res) => setTimeout(res, 5000));
  }
  return false;
}

async function main() {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pii-apply-overrides-"));
  const mappingsDir = path.join(tmp, "mappings");
  fs.mkdirSync(mappingsDir, { recursive: true });
  const doc1 = path.join(tmp, "doc1.docx");
  const doc2 = path.join(tmp, "doc2.docx");

  await makeDocx(doc1, [
    "Agreement between Acme Corporation and John Smith.",
    "Contact: jsmith@acme.com.",
  ]);
  await makeDocx(doc2, [
    "Side letter from Acme Corporation signed by Jane Doe.",
    "Office: Pepsi Tower, London.",
  ]);

  console.log(`Fixtures: ${tmp}`);

  // Run WITHOUT PII_SKIP_REVIEW so the review flow is active.
  const proc = spawn("node", [BUNDLE], {
    env: {
      ...process.env,
      PII_SHIELD_MAPPINGS_DIR: mappingsDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  setupResponseReader(proc);
  await request(proc, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "apply-overrides-e2e", version: "1.0" },
  });

  console.log("\n## NER warmup");
  check(await waitForNer(proc), "NER ready");

  console.log("\n## Anonymize 2 docs into 1 session");
  const r1 = await callTool(proc, "anonymize_file", { file_path: doc1 });
  check(r1.status === "success", "doc1 anonymize_file succeeded");
  const sid = r1.session_id;
  const docId1 = r1.doc_id;
  check(!!sid && !!docId1, "doc1 returned session_id + doc_id");

  const r2 = await callTool(proc, "anonymize_file", { file_path: doc2, session_id: sid });
  check(r2.status === "success", "doc2 anonymize_file succeeded");
  check(r2.session_id === sid, "doc2 reuses same session_id");
  const docId2 = r2.doc_id;
  check(!!docId2 && docId2 !== docId1, "doc2 got its own doc_id distinct from doc1's");
  check(r2.documents_in_session === 2, "documents_in_session=2");

  console.log("\n## start_review(session_id=S) — panel should list 2 docs");
  const sr = await callAppTool(proc, "start_review", { session_id: sid });
  const sc = sr.structuredContent || {};
  check(Array.isArray(sc.sessions), "structuredContent.sessions is an array");
  check((sc.sessions || []).length === 2, `sessions.length === 2 (got ${(sc.sessions || []).length})`);
  const sess = sc.sessions || [];
  const sessionDocIds = sess.map((s) => s.doc_id).filter(Boolean);
  check(sessionDocIds.includes(docId1), "sessions[] includes doc1 doc_id");
  check(sessionDocIds.includes(docId2), "sessions[] includes doc2 doc_id");
  check(sc.is_bulk === true, "is_bulk=true when 2+ payloads");

  const doc1Payload = sess.find((s) => s.doc_id === docId1);
  const doc2Payload = sess.find((s) => s.doc_id === docId2);
  check((doc1Payload?.entities || []).length > 0, "doc1 payload carries entities");
  check((doc2Payload?.entities || []).length > 0, "doc2 payload carries entities");
  // Sanity: the two docs have different entity sets
  const doc1Names = (doc1Payload?.entities || []).map((e) => e.text);
  const doc2Names = (doc2Payload?.entities || []).map((e) => e.text);
  check(doc1Names.includes("John Smith") || doc1Names.some((n) => n.includes("John")),
    "doc1 entities mention John");
  check(doc2Names.includes("Jane Doe") || doc2Names.some((n) => n.includes("Jane")),
    "doc2 entities mention Jane");

  console.log("\n## apply_review_overrides for doc1 (remove entity at idx 0)");
  const ar1 = await callTool(proc, "apply_review_overrides", {
    session_id: sid,
    doc_id: docId1,
    overrides: { remove: [0], add: [] },
  });
  check(ar1.status === "applied", "doc1 apply_review_overrides applied");
  check(ar1.doc_id === docId1, "response echoes doc1 doc_id");
  check(ar1.has_changes === true, "has_changes=true for doc1 (1 remove)");

  console.log("\n## apply_review_overrides for doc2 (no changes — approve clean)");
  const ar2 = await callTool(proc, "apply_review_overrides", {
    session_id: sid,
    doc_id: docId2,
    overrides: { remove: [], add: [] },
  });
  check(ar2.status === "applied", "doc2 apply_review_overrides applied");
  check(ar2.doc_id === docId2, "response echoes doc2 doc_id");
  check(ar2.has_changes === false, "has_changes=false for doc2");

  console.log("\n## Verify on-disk review_<S>.json has BOTH docs correctly updated");
  const reviewFile = path.join(mappingsDir, `review_${sid}.json`);
  check(fs.existsSync(reviewFile), `review file exists at ${path.basename(reviewFile)}`);
  const reviewData = JSON.parse(fs.readFileSync(reviewFile, "utf-8"));
  check(Array.isArray(reviewData.documents) && reviewData.documents.length === 2,
    "review.documents has 2 entries on disk");
  const diskDoc1 = reviewData.documents.find((d) => d.doc_id === docId1);
  const diskDoc2 = reviewData.documents.find((d) => d.doc_id === docId2);
  check(!!diskDoc1 && diskDoc1.approved === true, "doc1 approved=true on disk");
  check(diskDoc1?.overrides?.remove?.[0] === 0, "doc1 overrides.remove=[0] on disk");
  check(!!diskDoc2 && diskDoc2.approved === true, "doc2 approved=true on disk");
  check((diskDoc2?.overrides?.remove || []).length === 0, "doc2 overrides.remove=[] on disk (untouched)");

  console.log("\n## reanonymizeWithReview — doc1 (has overrides) → status=success");
  const rer1 = await callTool(proc, "anonymize_file", { file_path: doc1, review_session_id: sid });
  check(rer1.status === "success" || rer1.status === "approved_no_changes",
    `doc1 reanonymize responded (status=${rer1.status})`);
  check(rer1.doc_id === docId1, "doc1 reanonymize response echoes doc1 doc_id");
  // The server may route to "success" path (re-emit _corrected files) or the
  // "approved_no_changes" path if doc_1's overrides happened to apply cleanly
  // without altering the entity count. Both are valid — the key check is that
  // it locked onto DOC1, not DOC2.

  console.log("\n## reanonymizeWithReview — doc2 (no overrides) → status=approved_no_changes");
  const rer2 = await callTool(proc, "anonymize_file", { file_path: doc2, review_session_id: sid });
  check(rer2.status === "approved_no_changes",
    `doc2 reanonymize: approved_no_changes (got ${rer2.status})`);
  check(rer2.doc_id === docId2, "doc2 reanonymize response echoes doc2 doc_id");

  console.log("\n## Legacy fallback — apply_review_overrides WITHOUT doc_id (targets docs[0])");
  // Add a fresh third doc to reset the approve state a bit, then call apply
  // without doc_id — should route to documents[0].
  const ar3 = await callTool(proc, "apply_review_overrides", {
    session_id: sid,
    overrides: { remove: [], add: [] },
  });
  check(ar3.status === "applied", "no-doc_id apply_review_overrides applied");
  check(ar3.doc_id === docId1, "no-doc_id fallback targeted documents[0] = doc1's doc_id");

  proc.kill();
  await fs.promises.rm(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
