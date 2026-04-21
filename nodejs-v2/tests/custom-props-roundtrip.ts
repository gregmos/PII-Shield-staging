/**
 * Roundtrip smoke test for docx-custom-props.
 * Run: npx tsx tests/custom-props-roundtrip.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import {
  readCustomProps,
  writeCustomProps,
  writePiiShieldProps,
  readPiiShieldProps,
} from "../src/docx/docx-custom-props.js";

let passed = 0;
let failed = 0;

function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok  ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL ${msg}`);
    failed++;
  }
}

async function makeFixtureDocx(filepath: string): Promise<void> {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ children: [new TextRun("Hello from PII Shield test fixture.")] }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  await fs.promises.writeFile(filepath, buf);
}

async function main(): Promise<void> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pii-custom-props-"));
  const fixture = path.join(tmp, "fixture.docx");
  await makeFixtureDocx(fixture);

  console.log(`Fixture: ${fixture}`);

  // 1. Fresh docx has no custom props.
  const initial = await readCustomProps(fixture);
  check(Object.keys(initial).length === 0, "fresh docx: no custom props");

  const initialPii = await readPiiShieldProps(fixture);
  check(initialPii === null, "fresh docx: readPiiShieldProps returns null");

  // 2. Write PII Shield props and read back.
  await writePiiShieldProps(fixture, {
    session_id: "01HXK9ABC123",
    source_hash: "sha256:deadbeef",
    anonymized_at: "2026-04-19T10:15:00Z",
  });
  const pii = await readPiiShieldProps(fixture);
  check(pii !== null, "after write: readPiiShieldProps returns non-null");
  check(pii?.session_id === "01HXK9ABC123", "session_id roundtrip");
  check(pii?.source_hash === "sha256:deadbeef", "source_hash roundtrip");
  check(pii?.anonymized_at === "2026-04-19T10:15:00Z", "anonymized_at roundtrip");

  // 3. Generic readCustomProps shows all 3 keys.
  const all = await readCustomProps(fixture);
  check(
    all["pii_shield.session_id"] === "01HXK9ABC123"
      && all["pii_shield.source_hash"] === "sha256:deadbeef"
      && all["pii_shield.anonymized_at"] === "2026-04-19T10:15:00Z",
    "all three keys present in generic read",
  );

  // 4. Second write MERGES — adding a new key keeps old ones.
  await writeCustomProps(fixture, { custom_extra: "extra-value" });
  const merged = await readCustomProps(fixture);
  check(merged["pii_shield.session_id"] === "01HXK9ABC123", "merge preserves session_id");
  check(merged["custom_extra"] === "extra-value", "merge adds custom_extra");

  // 5. Write to same key UPDATES value.
  await writeCustomProps(fixture, { "pii_shield.session_id": "01HXK9UPDATED" });
  const after = await readCustomProps(fixture);
  check(after["pii_shield.session_id"] === "01HXK9UPDATED", "update in place");
  check(after["custom_extra"] === "extra-value", "update keeps other keys");

  // 6. ZIP structure intact: Content_Types + _rels include custom.xml refs.
  const buf = await fs.promises.readFile(fixture);
  const zip = await JSZip.loadAsync(buf);
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  check(
    ct.includes('PartName="/docProps/custom.xml"'),
    "[Content_Types].xml has custom.xml override",
  );
  const rels = await zip.file("_rels/.rels")!.async("string");
  check(
    rels.includes("custom-properties") && rels.includes("docProps/custom.xml"),
    "_rels/.rels has custom-properties relationship",
  );

  // 7. Custom.xml body looks sane.
  const customXml = await zip.file("docProps/custom.xml")!.async("string");
  check(customXml.includes("xmlns:vt="), "custom.xml has vt namespace");
  check(customXml.includes("01HXK9UPDATED"), "custom.xml contains updated session_id");

  // 8. Values that would need XML escaping survive.
  await writeCustomProps(fixture, {
    "pii_shield.xml_test": `<tag>a & b "c" 'd'</tag>`,
  });
  const esc = await readCustomProps(fixture);
  check(
    esc["pii_shield.xml_test"] === `<tag>a & b "c" 'd'</tag>`,
    "xml-special chars roundtrip correctly",
  );

  // Cleanup
  await fs.promises.rm(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(2);
});
