/**
 * Smoke test for utils/hashing.
 * Run: npx tsx tests/hashing-test.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sha256File,
  sha256Buffer,
  sha256String,
  formatSha256,
  parseSha256,
} from "../src/utils/hashing.js";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

// Pre-computed: sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
const HELLO_WORLD_SHA = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
// sha256("")
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function main(): Promise<void> {
  check(sha256String("hello world") === HELLO_WORLD_SHA, "sha256String('hello world')");
  check(sha256String("") === EMPTY_SHA, "sha256String('')");
  check(sha256Buffer(Buffer.from("hello world")) === HELLO_WORLD_SHA, "sha256Buffer");
  check(sha256Buffer(new Uint8Array([])) === EMPTY_SHA, "sha256Buffer(empty Uint8Array)");

  // File roundtrip
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pii-hashing-"));
  const filepath = path.join(tmp, "hello.txt");
  await fs.promises.writeFile(filepath, "hello world", "utf-8");
  const fileHash = await sha256File(filepath);
  check(fileHash === HELLO_WORLD_SHA, "sha256File on 'hello world'");

  // Bigger file (1 MB of zeros)
  const bigPath = path.join(tmp, "big.bin");
  const mb = Buffer.alloc(1024 * 1024, 0);
  await fs.promises.writeFile(bigPath, mb);
  const bigStream = await sha256File(bigPath);
  const bigMemory = sha256Buffer(mb);
  check(bigStream === bigMemory, "streaming & buffer hashes match on 1MB zeros");

  // formatSha256 / parseSha256
  check(formatSha256(HELLO_WORLD_SHA) === `sha256:${HELLO_WORLD_SHA}`, "formatSha256");
  check(parseSha256(`sha256:${HELLO_WORLD_SHA}`) === HELLO_WORLD_SHA, "parseSha256 happy");
  check(parseSha256("md5:abc") === null, "parseSha256 rejects wrong algo");
  check(parseSha256("sha256:not-hex") === null, "parseSha256 rejects non-hex");
  check(parseSha256(`sha256:${HELLO_WORLD_SHA.slice(0, 32)}`) === null, "parseSha256 rejects wrong length");

  await fs.promises.rm(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
