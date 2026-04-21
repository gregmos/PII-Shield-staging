/**
 * Unit tests for v2.1.3 multi-doc review storage (per-doc array + legacy
 * migration). Run: npx tsx tests/multi-doc-review-test.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pii-multi-doc-review-"));
process.env.PII_SHIELD_DATA_DIR = tmpRoot;

const {
  saveReview,
  getReview,
  appendDocReview,
  findDocReview,
  findDocReviewByPath,
  updateDocReview,
} = await import("../src/mapping/review-store.js");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

function mkDoc(id: string, filename: string, extra: Partial<{ source_file_path: string; approved: boolean }> = {}) {
  return {
    doc_id: id,
    source_filename: filename,
    source_file_path: extra.source_file_path || `/fake/${filename}`,
    entities: [
      { text: "Acme Corp", type: "ORGANIZATION", start: 0, end: 9, placeholder: "<ORG_1>" },
    ],
    original_text: `Agreement with Acme Corp (${id}).`,
    anonymized_text: `Agreement with <ORG_1> (${id}).`,
    overrides: { remove: [] as number[], add: [] as Array<{ text: string; type: string; start: number; end: number }> },
    approved: !!extra.approved,
    output_dir: `/tmp/pii_shield_${id}`,
    output_path_original: `/tmp/pii_shield_${id}/${filename}_anonymized.txt`,
    added_at: Date.now(),
  };
}

async function main(): Promise<void> {
  // ── 1. appendDocReview creates a session + first doc ─────────────────────
  const sid = "2026-04-20_120000_test";
  const r1 = appendDocReview(sid, mkDoc("doc-1", "contract1.docx"));
  check(r1.session_id === sid, "appendDocReview sets session_id");
  check(r1.documents.length === 1, "after first append: 1 doc");

  const loaded1 = getReview(sid);
  check(loaded1?.documents.length === 1, "getReview roundtrip: 1 doc");
  check(loaded1?.documents[0].doc_id === "doc-1", "first doc id matches");
  check(loaded1?.documents[0].source_filename === "contract1.docx", "first doc filename matches");

  // ── 2. Append second doc → both preserved ────────────────────────────────
  appendDocReview(sid, mkDoc("doc-2", "contract2.docx"));
  const loaded2 = getReview(sid);
  check(loaded2?.documents.length === 2, "after second append: 2 docs");
  check(loaded2?.documents[0].doc_id === "doc-1", "doc1 preserved in position 0");
  check(loaded2?.documents[1].doc_id === "doc-2", "doc2 at position 1");

  // ── 3. Append same doc_id → replace in place ─────────────────────────────
  const doc2v2 = mkDoc("doc-2", "contract2_renamed.docx");
  appendDocReview(sid, doc2v2);
  const loaded3 = getReview(sid);
  check(loaded3?.documents.length === 2, "re-appending same doc_id doesn't grow");
  check(loaded3?.documents[1].source_filename === "contract2_renamed.docx", "doc2 metadata updated");

  // ── 4. findDocReview by id ────────────────────────────────────────────────
  const f1 = findDocReview(sid, "doc-1");
  check(f1?.doc_id === "doc-1", "findDocReview(doc-1) works");
  const f2 = findDocReview(sid, "doc-nonexistent");
  check(f2 === null, "findDocReview returns null for missing id");
  const f3 = findDocReview(sid); // no doc_id → first doc
  check(f3?.doc_id === "doc-1", "findDocReview without id returns first doc");

  // ── 5. findDocReviewByPath matches by source_file_path ───────────────────
  const byPath = findDocReviewByPath(sid, "/fake/contract1.docx");
  check(byPath?.doc_id === "doc-1", "findDocReviewByPath happy path");
  const byMissingPath = findDocReviewByPath(sid, "/nope/x.docx");
  check(byMissingPath === null, "findDocReviewByPath returns null for unknown path");

  // ── 6. updateDocReview mutates only one doc ──────────────────────────────
  const updated = updateDocReview(sid, "doc-1", { approved: true });
  check(updated?.approved === true, "updateDocReview flips approved on target");
  const afterUpdate = getReview(sid);
  check(afterUpdate?.documents[0].approved === true, "doc1 approved persisted");
  check(afterUpdate?.documents[1].approved === false, "doc2 approved untouched");

  // ── 7. Legacy migration on read ─────────────────────────────────────────
  const legacySid = "legacy-session-abc";
  const legacyPath = path.join(tmpRoot, "mappings", `review_${legacySid}.json`);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({
    session_id: legacySid,
    entities: [{ text: "John", type: "PERSON", start: 0, end: 4, placeholder: "<PERSON_1>" }],
    original_text: "John signed.",
    anonymized_text: "<PERSON_1> signed.",
    overrides: { remove: [], add: [] },
    approved: false,
    timestamp: 123456789,
    source_filename: "legacy.txt",
    source_file_path: "/legacy/legacy.txt",
    output_dir: "/tmp/legacy_outdir",
    output_path_original: "/tmp/legacy_outdir/legacy_anonymized.txt",
  }, null, 2), "utf-8");

  const migrated = getReview(legacySid);
  check(migrated !== null, "legacy file loads");
  check(Array.isArray(migrated?.documents), "legacy: documents array created");
  check(migrated?.documents.length === 1, "legacy: exactly one doc after migration");
  check(migrated?.documents[0].source_filename === "legacy.txt", "legacy: source_filename preserved");
  check(migrated?.documents[0].source_file_path === "/legacy/legacy.txt", "legacy: source_file_path preserved");
  check(migrated?.documents[0].entities.length === 1, "legacy: entities preserved");
  check(migrated?.documents[0].entities[0].placeholder === "<PERSON_1>", "legacy: entity placeholder preserved");
  check(migrated?.documents[0].original_text === "John signed.", "legacy: original_text preserved");
  check(!!migrated?.documents[0].doc_id.match(/^legacy-/), "legacy: synthetic doc_id prefix");

  // ── 8. Subsequent save writes new format ─────────────────────────────────
  updateDocReview(legacySid, migrated!.documents[0].doc_id, { approved: true });
  const onDisk = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
  check(Array.isArray(onDisk.documents), "after updateDocReview: new-format documents[] on disk");
  check(typeof onDisk.entities === "undefined", "after new save: legacy flat entities field is gone");
  check(onDisk.documents[0].approved === true, "migrated doc approved=true persisted");

  // ── 9. saveReview directly (caller passes full ReviewData) ────────────────
  const sid2 = "2026-04-20_121500_direct";
  saveReview(sid2, {
    session_id: sid2,
    timestamp: Date.now(),
    documents: [mkDoc("d-a", "fileA.docx"), mkDoc("d-b", "fileB.docx")],
  });
  const loaded4 = getReview(sid2);
  check(loaded4?.documents.length === 2, "direct saveReview with 2 docs roundtrips");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
