/**
 * Tests for loadMappingData / loadSessionState / saveSessionState / sessionExists
 * in mapping-store. Run: npx tsx tests/mapping-store-session-test.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Must set env BEFORE importing config-dependent modules.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pii-mapping-test-"));
process.env.PII_SHIELD_DATA_DIR = tmpRoot;

const { createPlaceholderState, assignPlaceholders } = await import("../src/engine/entity-dedup.js");
const {
  newSessionId,
  saveSessionState,
  loadSessionState,
  loadMappingData,
  loadMapping,
  sessionExists,
  saveMapping,
} = await import("../src/mapping/mapping-store.js");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

async function main(): Promise<void> {
  const sid = newSessionId();

  // Session doesn't exist yet
  check(!sessionExists(sid), "sessionExists(fresh) = false");
  check(loadSessionState(sid) === null, "loadSessionState(fresh) = null");
  check(loadMappingData(sid) === null, "loadMappingData(fresh) = null");

  // Build a state via assignPlaceholders
  const state = createPlaceholderState();
  assignPlaceholders([
    { text: "Acme Corporation", type: "ORGANIZATION", start: 0, end: 16, score: 1 },
    { text: "John Smith", type: "PERSON", start: 20, end: 30, score: 1 },
  ], "", state);

  // Save with documents list
  saveSessionState(sid, {
    state,
    documents: [{
      doc_id: "doc1",
      source_path: "/tmp/doc1.docx",
      source_hash: "sha256:aaa",
      anonymized_at: "2026-04-19T10:00:00Z",
    }],
  });
  check(sessionExists(sid), "sessionExists after save = true");

  // Disk artifact check
  const onDisk = path.join(tmpRoot, "mappings", `${sid}.json`);
  check(fs.existsSync(onDisk), "file exists on disk");
  const raw = JSON.parse(fs.readFileSync(onDisk, "utf-8"));
  check(!!raw.metadata.placeholder_state, "disk JSON has metadata.placeholder_state");
  check(Array.isArray(raw.metadata.documents), "disk JSON has metadata.documents array");
  check(raw.metadata.documents.length === 1, "1 document in list");

  // Load it back
  const loaded = loadSessionState(sid);
  check(loaded !== null, "loadSessionState after save = non-null");
  check(loaded!.state.typeCounters.get("ORGANIZATION") === 1, "ORG counter=1 in loaded state");
  check(loaded!.state.typeCounters.get("PERSON") === 1, "PERSON counter=1 in loaded state");
  check(loaded!.documents.length === 1, "documents roundtrip");
  check(loaded!.documents[0].source_hash === "sha256:aaa", "document source_hash roundtrip");
  check(loaded!.mapping["<ORG_1>"] === "Acme Corporation", "mapping entry roundtrip");

  // Extend: add another doc, re-save, verify placeholder reuse works
  const loaded2 = loadSessionState(sid)!;
  assignPlaceholders([
    { text: "Acme Corporation", type: "ORGANIZATION", start: 0, end: 16, score: 1 },
    { text: "Jane Doe", type: "PERSON", start: 20, end: 28, score: 1 },
  ], "", loaded2.state);

  saveSessionState(sid, {
    state: loaded2.state,
    documents: [
      ...loaded2.documents,
      {
        doc_id: "doc2",
        source_path: "/tmp/doc2.docx",
        source_hash: "sha256:bbb",
        anonymized_at: "2026-04-19T11:00:00Z",
      },
    ],
  });

  const loaded3 = loadSessionState(sid)!;
  check(loaded3.documents.length === 2, "docs extended to 2");
  check(loaded3.state.typeCounters.get("PERSON") === 2, "PERSON counter extended to 2");
  check(loaded3.state.seenExact.get("PERSON::jane doe") !== undefined, "Jane Doe registered in seenExact");

  // Legacy BC: mapping saved via old saveMapping with no placeholder_state
  const legacySid = newSessionId();
  saveMapping(legacySid, { "<ORG_1>": "Pepsi Co.", "<PERSON_1>": "Bob Legacy" }, { source: "/tmp/legacy.docx" });
  const legacyLoaded = loadSessionState(legacySid);
  check(legacyLoaded !== null, "legacy session loads");
  check(legacyLoaded!.state.typeCounters.get("ORGANIZATION") === 1, "legacy: ORG counter reconstructed");
  check(legacyLoaded!.state.seenExact.get("ORGANIZATION::pepsi co") === "<ORG_1>", "legacy: seenExact reconstructed");
  check(legacyLoaded!.documents.length === 0, "legacy: empty documents list");

  // loadMapping() keeps working for old callers
  const mapOnly = loadMapping(sid);
  check(mapOnly["<ORG_1>"] === "Acme Corporation", "loadMapping() unchanged BC");

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
