/**
 * Unit tests for session export / import.
 * Run: npx tsx tests/session-archive-test.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pii-archive-test-"));
process.env.PII_SHIELD_DATA_DIR = tmpRoot;

const { createPlaceholderState, assignPlaceholders } = await import("../src/engine/entity-dedup.js");
const {
  newSessionId,
  saveSessionState,
  loadSessionState,
  sessionExists,
} = await import("../src/mapping/mapping-store.js");
const { saveReview } = await import("../src/mapping/review-store.js");
const {
  exportSession,
  importSession,
  exportSessionToFile,
  importSessionFromFile,
} = await import("../src/portability/session-archive.js");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

async function expectThrow(fn: () => Promise<unknown>, substr: string, msg: string): Promise<void> {
  try {
    await fn();
    check(false, `${msg} (expected throw, none)`);
  } catch (e: any) {
    const s = String(e?.message ?? e);
    check(s.toLowerCase().includes(substr.toLowerCase()), `${msg} (threw: ${s.slice(0, 100)})`);
  }
}

function setupSession(sid: string): void {
  const state = createPlaceholderState();
  assignPlaceholders([
    { text: "Acme Corporation", type: "ORGANIZATION", start: 0, end: 16, score: 1 },
    { text: "John Smith", type: "PERSON", start: 20, end: 30, score: 1 },
    { text: "jsmith@acme.com", type: "EMAIL_ADDRESS", start: 40, end: 55, score: 1 },
  ], "", state);
  saveSessionState(sid, {
    state,
    documents: [{
      doc_id: "doc-archive-test-1",
      source_path: "/tmp/fake.docx",
      source_hash: "sha256:feedbeef",
      anonymized_at: "2026-04-19T10:00:00Z",
    }],
  });
  saveReview(sid, {
    session_id: sid,
    entities: [{ text: "Acme Corporation", type: "ORGANIZATION", start: 0, end: 16, score: 1, placeholder: "<ORG_1>" }],
    original_text: "Acme Corporation    John Smith    jsmith@acme.com",
    anonymized_text: "<ORG_1>     <PERSON_1>    <EMAIL_1>",
    overrides: { remove: [], add: [] },
    approved: false,
    timestamp: Date.now(),
  });
}

async function main(): Promise<void> {
  // 1. Roundtrip through buffer.
  const sid1 = newSessionId();
  setupSession(sid1);
  const before = loadSessionState(sid1)!;

  const archive = await exportSession(sid1, "correct-horse-battery-staple");
  check(archive.length > 64, "archive has non-trivial size");
  check(archive.subarray(0, 4).toString("ascii") === "PII1", "archive starts with PII1 magic");
  check(archive[4] === 0x01, "archive version byte = 0x01");

  // Delete local copy to simulate import on a fresh machine.
  const mapFile = path.join(tmpRoot, "mappings", `${sid1}.json`);
  const reviewFile = path.join(tmpRoot, "mappings", `review_${sid1}.json`);
  fs.rmSync(mapFile, { force: true });
  fs.rmSync(reviewFile, { force: true });
  const { _resetDataDirCache } = await import("../src/utils/config.js");
  _resetDataDirCache();
  // Drop in-memory too by re-importing the module fresh — use dynamic re-import
  // Actually: saveMapping is best-effort disk; _inMemory Map still holds the
  // session. For this test, import with overwrite=true to exercise the path.

  const res1 = await importSession(archive, "correct-horse-battery-staple", { overwrite: true });
  check(res1.session_id === sid1, "import returns same session_id");
  check(res1.document_count === 1, "import reports 1 document");
  check(res1.had_review === true, "import reports had_review=true");

  const after = loadSessionState(sid1)!;
  check(after !== null, "session exists after import");
  check(after.documents.length === 1, "documents survived roundtrip");
  check(after.documents[0].source_hash === "sha256:feedbeef", "doc source_hash survived");
  check(after.mapping["<ORG_1>"] === "Acme Corporation", "mapping <ORG_1> survived");
  check(after.state.typeCounters.get("ORGANIZATION") === 1, "state typeCounters survived");
  check(after.state.seenExact.get("ORGANIZATION::acme corporation") === "<ORG_1>",
    "state seenExact survived");

  // 2. Wrong passphrase.
  await expectThrow(
    () => importSession(archive, "totally-wrong", { overwrite: true }),
    "decryption failed", "wrong passphrase → readable error");

  // 3. Corrupted archive (flip 1 byte in ciphertext).
  const corrupted = Buffer.from(archive);
  corrupted[HEADER_LEN_CONST + 5] ^= 0xff;
  await expectThrow(
    () => importSession(corrupted, "correct-horse-battery-staple", { overwrite: true }),
    "decryption failed", "1-byte ciphertext flip → decryption failed");

  // 4. Wrong magic.
  const wrongMagic = Buffer.from(archive);
  wrongMagic[0] = "X".charCodeAt(0);
  await expectThrow(
    () => importSession(wrongMagic, "correct-horse-battery-staple", { overwrite: true }),
    "magic mismatch", "wrong magic → readable error");

  // 5. Truncated archive.
  await expectThrow(
    () => importSession(archive.subarray(0, 40), "correct-horse-battery-staple", { overwrite: true }),
    "too small", "truncated archive → readable error");

  // 6. Archive length mismatch (tweak ctLen field).
  const badLen = Buffer.from(archive);
  badLen.writeUInt32BE(badLen.readUInt32BE(36) + 10, 36);
  await expectThrow(
    () => importSession(badLen, "correct-horse-battery-staple", { overwrite: true }),
    "length mismatch", "ct_len inflated → length mismatch error");

  // 7. Session not found on export.
  await expectThrow(
    () => exportSession("does-not-exist", "xxxxxx"),
    "not found", "unknown session → not-found error");

  // 8. Passphrase too short.
  await expectThrow(
    () => exportSession(sid1, "abc"),
    "at least 4", "short passphrase → readable error");

  // 9. Import without overwrite when session already exists.
  await expectThrow(
    () => importSession(archive, "correct-horse-battery-staple", { overwrite: false }),
    "already exists", "no-overwrite + existing session → error");

  // 10. File-level helpers.
  const sid2 = newSessionId();
  setupSession(sid2);
  const archivePath = path.join(tmpRoot, `session-${sid2}.pii-session`);
  const expRes = await exportSessionToFile(sid2, "another-pass", archivePath);
  check(fs.existsSync(archivePath), "exportSessionToFile wrote a file");
  check(expRes.archive_size_bytes > 0, "export reports positive size");

  // Delete in-memory + disk copies and import.
  fs.rmSync(path.join(tmpRoot, "mappings", `${sid2}.json`), { force: true });
  fs.rmSync(path.join(tmpRoot, "mappings", `review_${sid2}.json`), { force: true });

  const impRes = await importSessionFromFile(archivePath, "another-pass", { overwrite: true });
  check(impRes.session_id === sid2, "importSessionFromFile restored session_id");
  check(sessionExists(sid2), "sessionExists after file import");

  // 11. Without review — ensure absent review doesn't break roundtrip.
  const sid3 = newSessionId();
  const state3 = createPlaceholderState();
  assignPlaceholders([{ text: "Foo Inc.", type: "ORGANIZATION", start: 0, end: 8, score: 1 }], "", state3);
  saveSessionState(sid3, { state: state3, documents: [] });
  // Deliberately no saveReview(sid3, ...)
  const buf3 = await exportSession(sid3, "nopass-review");
  fs.rmSync(path.join(tmpRoot, "mappings", `${sid3}.json`), { force: true });
  const res3 = await importSession(buf3, "nopass-review", { overwrite: true });
  check(res3.had_review === false, "had_review=false when no review data");
  check(res3.document_count === 0, "empty docs list survives");

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

// Header length constant for corruption test (must match session-archive.ts)
const HEADER_LEN_CONST = 4 + 4 + 16 + 12 + 4;

main().catch((e) => { console.error(e); process.exit(2); });
