/**
 * Tests for PlaceholderState serde + reconstruction in entity-dedup.ts.
 * Run: npx tsx tests/placeholder-serde-test.ts
 */

import {
  assignPlaceholders,
  createPlaceholderState,
  serializePlaceholderState,
  deserializePlaceholderState,
  reconstructPlaceholderState,
  type PlaceholderState,
} from "../src/engine/entity-dedup.js";
import type { DetectedEntity } from "../src/engine/pattern-recognizers.js";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

function mkEntity(text: string, type: string, start = 0, end?: number): DetectedEntity {
  return { text, type, start, end: end ?? text.length, score: 1.0 };
}

function statesEqual(a: PlaceholderState, b: PlaceholderState): boolean {
  if (a.typeCounters.size !== b.typeCounters.size) return false;
  for (const [k, v] of a.typeCounters) if (b.typeCounters.get(k) !== v) return false;
  if (a.seenExact.size !== b.seenExact.size) return false;
  for (const [k, v] of a.seenExact) if (b.seenExact.get(k) !== v) return false;
  if (a.seenFamily.size !== b.seenFamily.size) return false;
  for (const [k, v] of a.seenFamily) {
    const bv = b.seenFamily.get(k);
    if (!bv || bv.familyNumber !== v.familyNumber || bv.variantCounter !== v.variantCounter) return false;
  }
  const ak = Object.keys(a.mapping), bk = Object.keys(b.mapping);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a.mapping[k] !== b.mapping[k]) return false;
  return true;
}

function run(): void {
  // 1. Empty state roundtrip
  const empty = createPlaceholderState();
  const e1 = deserializePlaceholderState(serializePlaceholderState(empty));
  check(statesEqual(empty, e1), "empty state roundtrips");

  // 2. Populated state — doc1 entities
  const state1 = createPlaceholderState();
  const entsDoc1: DetectedEntity[] = [
    mkEntity("Acme Corporation", "ORGANIZATION", 0),
    mkEntity("John Smith", "PERSON", 30),
    mkEntity("Acme Corp.", "ORGANIZATION", 50),   // family variant of Acme Corporation
    mkEntity("jsmith@example.com", "EMAIL_ADDRESS", 80),
  ];
  const r1 = assignPlaceholders(entsDoc1, "", state1);
  check(Object.keys(r1.mapping).length >= 3, "doc1 produced >=3 placeholders");

  // Serialize + deserialize, then assert equality
  const ser = serializePlaceholderState(state1);
  const deser = deserializePlaceholderState(ser);
  check(statesEqual(state1, deser), "populated state roundtrips byte-equal");

  // 3. Extend across docs: deser + doc2 entities should reuse Acme's placeholder
  const acmePh = state1.seenExact.get("ORGANIZATION::acme corporation");
  check(typeof acmePh === "string" && acmePh!.length > 0, "Acme Corp got a placeholder in state1");

  const entsDoc2: DetectedEntity[] = [
    mkEntity("Acme Corporation", "ORGANIZATION", 0),  // known — reuse
    mkEntity("Jane Doe", "PERSON", 20),               // new
    mkEntity("Pepsi Inc.", "ORGANIZATION", 40),       // new
  ];
  const r2 = assignPlaceholders(entsDoc2, "", deser);
  const acmePhInDoc2 = r2.entities.find((e) => e.text === "Acme Corporation")?.placeholder;
  check(acmePhInDoc2 === acmePh, "Acme reuses same placeholder across docs via deserialized state");

  const janePh = r2.entities.find((e) => e.text === "Jane Doe")?.placeholder;
  const smithPh = state1.seenExact.get("PERSON::john smith");
  check(!!janePh && janePh !== smithPh, "Jane Doe got a NEW placeholder (not John's)");

  const pepsiPh = r2.entities.find((e) => e.text === "Pepsi Inc.")?.placeholder;
  check(!!pepsiPh && pepsiPh !== acmePh, "Pepsi got a new ORG placeholder distinct from Acme");

  // Type counters should have grown
  check(deser.typeCounters.get("PERSON")! >= 2, "PERSON counter grew to >=2");
  check(deser.typeCounters.get("ORGANIZATION")! >= 2, "ORG counter grew to >=2");

  // 4. Reconstruct from mapping only (legacy session path)
  // Simulate a mapping from an old session that lacks placeholder_state.
  const legacyMapping: Record<string, string> = {
    "<ORG_1>": "Acme Corporation",
    "<ORG_1a>": "Acme Corp.",
    "<PERSON_1>": "John Smith",
    "<EMAIL_1>": "jsmith@example.com",
  };
  const reconstructed = reconstructPlaceholderState(legacyMapping);

  check(reconstructed.typeCounters.get("ORGANIZATION") === 1, "reconstruct: ORG counter = 1");
  check(reconstructed.typeCounters.get("PERSON") === 1, "reconstruct: PERSON counter = 1");
  const acmeRecon = reconstructed.seenExact.get("ORGANIZATION::acme corporation");
  check(acmeRecon === "<ORG_1>", "reconstruct: Acme Corporation → <ORG_1>");
  const acmeCorpRecon = reconstructed.seenExact.get("ORGANIZATION::acme corp");
  check(acmeCorpRecon === "<ORG_1a>", "reconstruct: 'Acme Corp.' normalized reversed");
  const familyAcme = reconstructed.seenFamily.get("ORGANIZATION::acme corporation");
  check(!!familyAcme && familyAcme.familyNumber === 1 && familyAcme.variantCounter === 1,
    "reconstruct: family Acme has variantCounter=1 (a)");

  // Extend reconstructed state — new doc with more variants shouldn't collide
  const entsDoc3: DetectedEntity[] = [
    mkEntity("Acme Corporation", "ORGANIZATION", 0),        // reuse <ORG_1>
    mkEntity("Acme Corp.", "ORGANIZATION", 30),             // reuse <ORG_1a>
    mkEntity("Pepsi Inc.", "ORGANIZATION", 60),             // new family → <ORG_2>
    mkEntity("Jane Doe", "PERSON", 90),                     // new → <PERSON_2>
  ];
  const r3 = assignPlaceholders(entsDoc3, "", reconstructed);
  const acmeR3 = r3.entities.find((e) => e.text === "Acme Corporation")?.placeholder;
  check(acmeR3 === "<ORG_1>", "extend: Acme Corporation reused <ORG_1>");
  const acmeCorpR3 = r3.entities.find((e) => e.text === "Acme Corp.")?.placeholder;
  check(acmeCorpR3 === "<ORG_1a>", "extend: Acme Corp. reused <ORG_1a>");
  const pepsiR3 = r3.entities.find((e) => e.text === "Pepsi Inc.")?.placeholder;
  check(pepsiR3 === "<ORG_2>", "extend: Pepsi got <ORG_2> (no collision)");
  const janeR3 = r3.entities.find((e) => e.text === "Jane Doe")?.placeholder;
  check(janeR3 === "<PERSON_2>", "extend: Jane got <PERSON_2> (no collision)");

  // 5. With prefix — reconstruct should strip D1/D2 prefix correctly
  const prefixedMapping: Record<string, string> = {
    "<D1_ORG_1>": "Acme",
    "<D1_PERSON_1>": "John",
  };
  const reconPrefixed = reconstructPlaceholderState(prefixedMapping);
  check(reconPrefixed.typeCounters.get("ORGANIZATION") === 1, "reconstruct with prefix: ORG counter=1");
  check(reconPrefixed.seenExact.get("ORGANIZATION::acme") === "<D1_ORG_1>",
    "reconstruct with prefix: acme → <D1_ORG_1> in seenExact");

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
