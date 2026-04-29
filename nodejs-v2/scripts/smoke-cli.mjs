#!/usr/bin/env node
/**
 * Smoke test for `dist/cli/bin.mjs`.
 *
 * Exercises a multi-file batch end-to-end (without HITL — that needs a
 * browser): doctor, scan, anonymize three files in one session, deanonymize
 * one, sessions list, sessions export+import. Skips the NER-dependent
 * assertions if the GLiNER model isn't installed (we still verify pattern
 * coverage works).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "dist", "cli", "bin.mjs");

if (!fs.existsSync(BIN)) {
  console.error(`smoke-cli: ${BIN} not found — run \`npm run build:cli\` first`);
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pii-shield-smoke-"));
console.log(`=== smoke-cli — work dir: ${TMP} ===\n`);

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: TMP,
    env: { ...process.env, NO_COLOR: "1" }, // strip ANSI from JSON-parseable output
    ...opts,
  });
  if (r.status !== 0 && !opts.allowNonZero) {
    console.error(`FAIL: pii-shield ${args.join(" ")}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    process.exit(1);
  }
  return r;
}

// ── 1. version + doctor ───────────────────────────────────────────────────
console.log("1. --version");
const ver = run(["--version"]);
console.log(`   ${ver.stdout.trim()}`);
if (!ver.stdout.match(/\d+\.\d+\.\d+/)) {
  console.error("FAIL: --version output doesn't look like semver");
  process.exit(1);
}

console.log("\n2. doctor --json");
const doctor = run(["doctor", "--json"], { allowNonZero: true });
const doctorReport = JSON.parse(doctor.stdout);
const modelOk = doctorReport.checks.find(c => c.name === "GLiNER model")?.ok === true;
console.log(`   node=${doctorReport.node_version} model=${modelOk}`);

// Distinguish "model missing" (acceptable cold-CI state, SKIP) from any
// other doctor failure (broken native binding, unwritable dirs, wrong
// platform — real bugs that should fail loudly).
const nonModelFailures = doctorReport.checks.filter(
  (c) => !c.ok && c.name !== "GLiNER model" && c.name !== "NER deps",
);
if (nonModelFailures.length > 0) {
  console.error(`FAIL: doctor reports non-model failures:`);
  for (const f of nonModelFailures) console.error(`  [${f.name}] ${f.detail}`);
  process.exit(1);
}

// All remaining steps drive scan / anonymize / verify, which require a
// real GLiNER model (their non-TTY path bails when it's missing rather than
// silently degrading). On a fresh CI without the model preinstalled we skip
// the NER-dependent run instead of failing — a green CI tells contributors
// the build still works; the model-loaded path is exercised in release QA.
if (!modelOk) {
  console.log(`\n=== smoke-cli SKIPPED ===`);
  console.log(`GLiNER model not installed — skipping NER-dependent steps (scan/anonymize/verify/sessions).`);
  console.log(`To run the full suite: \`pii-shield install-model\`, then re-run \`npm run smoke:cli\`.`);
  console.log(`Tmp dir: ${TMP}`);
  process.exit(0);
}

// ── 3. fixtures: 3 files with overlapping entities ────────────────────────
console.log("\n3. Generating 3 test files with shared entities");
const sample1 =
  "John Smith works at Acme Corp. His email is j.smith@acme.com and SSN 123-45-6789.";
const sample2 =
  "Acme Corporation announced that John Smith will lead the new project. Contact: j.smith@acme.com.";
const sample3 = "Reference: SSN 123-45-6789 confirmed for John Smith of Acme Corp.";
const f1 = path.join(TMP, "doc1.txt");
const f2 = path.join(TMP, "doc2.txt");
const f3 = path.join(TMP, "doc3.txt");
fs.writeFileSync(f1, sample1);
fs.writeFileSync(f2, sample2);
fs.writeFileSync(f3, sample3);

// ── 4. scan ────────────────────────────────────────────────────────────────
console.log("\n4. scan --json doc1.txt");
const scan = run(["scan", "--json", f1]);
const scanReport = JSON.parse(scan.stdout);
console.log(`   ${scanReport.entities.length} entities`);
if (scanReport.entities.length === 0) {
  console.error("FAIL: scan returned 0 entities — pattern recognizers broken?");
  process.exit(1);
}

// ── 5. anonymize batch (--no-review) ──────────────────────────────────────
console.log("\n5. anonymize --no-review doc1 doc2 doc3");
const anon = run(["anonymize", "--no-review", f1, f2, f3]);
const sidMatch = anon.stdout.match(/Session: (\S+)/);
if (!sidMatch) {
  console.error("FAIL: could not extract session id from anonymize output");
  console.error(anon.stdout);
  process.exit(1);
}
const sid = sidMatch[1];
console.log(`   session=${sid}`);

// Multi-file invariant: same SSN across docs should map to same placeholder.
const out1Dir = path.join(TMP, `pii_shield_${sid}`);
const out1 = path.join(out1Dir, "doc1_anonymized.txt");
const out3 = path.join(out1Dir, "doc3_anonymized.txt");
if (!fs.existsSync(out1) || !fs.existsSync(out3)) {
  console.error(`FAIL: expected output files at ${out1} and ${out3}`);
  process.exit(1);
}
const out1Text = fs.readFileSync(out1, "utf8");
const out3Text = fs.readFileSync(out3, "utf8");
const ssnPlaceholder1 = out1Text.match(/<US_SSN_\d+\w*>/)?.[0];
const ssnPlaceholder3 = out3Text.match(/<US_SSN_\d+\w*>/)?.[0];
if (!ssnPlaceholder1 || !ssnPlaceholder3 || ssnPlaceholder1 !== ssnPlaceholder3) {
  console.error(`FAIL: SSN placeholder not shared across docs (${ssnPlaceholder1} vs ${ssnPlaceholder3})`);
  process.exit(1);
}
console.log(`   shared SSN placeholder: ${ssnPlaceholder1}`);

// ── 6. deanonymize round-trip ─────────────────────────────────────────────
console.log("\n6. deanonymize doc1");
run(["deanonymize", out1, "--session", sid]);
const restored = path.join(out1Dir, "doc1_anonymized_restored.txt");
if (!fs.existsSync(restored)) {
  console.error(`FAIL: restored file missing at ${restored}`);
  process.exit(1);
}
const restoredText = fs.readFileSync(restored, "utf8");
if (restoredText !== sample1) {
  console.error(`FAIL: round-trip mismatch.\n  Original: ${sample1}\n  Restored: ${restoredText}`);
  process.exit(1);
}
console.log(`   round-trip OK`);

// ── 7. sessions list / show ───────────────────────────────────────────────
console.log("\n7. sessions list --json");
const list = run(["sessions", "list", "--json"]);
const rows = JSON.parse(list.stdout);
const found = rows.find((r) => r.session_id === sid);
if (!found || found.docs !== 3) {
  console.error(`FAIL: session ${sid} not in list or doc count != 3`);
  process.exit(1);
}
console.log(`   list contains ${rows.length} session(s); ours has ${found.docs} docs, ${found.entities} entities`);

console.log("\n8. sessions show --json");
const show = run(["sessions", "show", sid, "--json"]);
const showReport = JSON.parse(show.stdout);
if (showReport.documents.length !== 3) {
  console.error("FAIL: show should report 3 documents");
  process.exit(1);
}
console.log(`   ${showReport.entity_count} entities across ${showReport.documents.length} docs`);

// ── 9. sessions find ───────────────────────────────────────────────────────
console.log("\n9. sessions find");
const find = run(["sessions", "find", f1, "--json"]);
const findHits = JSON.parse(find.stdout);
if (findHits.length === 0 || findHits[0].session_id !== sid) {
  console.error(`FAIL: sessions find didn't locate ${f1} in ${sid}`);
  process.exit(1);
}
console.log(`   located ${f1} in ${findHits.length} session(s)`);

// ── 10. short prefix resolves ──────────────────────────────────────────────
console.log("\n10. sessions show <short prefix>");
const shortPrefix = sid.slice(0, 17); // e.g. "2026-04-29_102136"
const showShort = run(["sessions", "show", shortPrefix, "--json"]);
const showShortReport = JSON.parse(showShort.stdout);
if (showShortReport.session_id !== sid) {
  console.error(`FAIL: short prefix '${shortPrefix}' resolved to ${showShortReport.session_id} not ${sid}`);
  process.exit(1);
}
console.log(`   '${shortPrefix}' resolves to ${sid}`);

// ── 11. verify (clean output) ──────────────────────────────────────────────
console.log("\n11. verify on clean output");
const verifyClean = run(["verify", out1, "--session", sid, "--json"], { allowNonZero: true });
const verifyReport = JSON.parse(verifyClean.stdout);
if (!verifyReport.ok) {
  console.error(`FAIL: verify on freshly anonymized file flagged ${verifyReport.leaks_found} leak(s):`);
  console.error(JSON.stringify(verifyReport.leaks, null, 2));
  process.exit(1);
}
console.log(`   ${verifyReport.entities_detected} entities all placeholders, no leaks`);

// ── 12. verify (real PII present) ──────────────────────────────────────────
console.log("\n12. verify catches real PII leak");
const tampered = path.join(out1Dir, "doc1_tampered.txt");
fs.writeFileSync(tampered, out1Text + "\n\nLeaked: john.smith@evil.com");
const verifyLeak = run(["verify", tampered, "--session", sid, "--json"], { allowNonZero: true });
const verifyLeakReport = JSON.parse(verifyLeak.stdout);
if (verifyLeakReport.ok || verifyLeakReport.leaks_found === 0) {
  console.error("FAIL: verify should have flagged the planted leak but reported clean");
  process.exit(1);
}
console.log(`   leak detected: ${verifyLeakReport.leaks[0].type} "${verifyLeakReport.leaks[0].text}"`);

// ── 13. export + import round-trip ─────────────────────────────────────────
console.log("\n13. sessions export + import");
const archivePath = path.join(TMP, "session.pii-session");
const passphrase = crypto.randomBytes(16).toString("hex");
run(["sessions", "export", sid, "--passphrase", passphrase, "--out", archivePath]);
if (!fs.existsSync(archivePath)) {
  console.error("FAIL: archive not written");
  process.exit(1);
}
console.log(`   archive=${(fs.statSync(archivePath).size / 1024).toFixed(1)} KB`);

run(["sessions", "import", archivePath, "--passphrase", passphrase, "--overwrite"]);
console.log(`   import OK`);

console.log(`\n=== smoke-cli PASSED ===`);
console.log(`Tmp dir kept for inspection: ${TMP}`);
