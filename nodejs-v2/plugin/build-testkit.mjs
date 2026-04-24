#!/usr/bin/env node

/**
 * PII Shield v2 — Testkit Builder.
 *
 * Assembles `dist/testkit/` (loose files for direct distribution) AND
 * `dist/pii-shield-testkit-v{VERSION}.zip` (single file Gregory sends to
 * testers). The ZIP is built with JSZip + `unixPermissions: 0o755` for
 * `*.command` / `*.sh` entries, so when a Mac user unzips it the launcher
 * scripts are executable without a manual `chmod +x`.
 *
 * Inputs (must exist before this script runs — usually after `build-plugin.mjs`):
 *   - dist/pii-shield-v{VERSION}.mcpb              (from build-plugin step 4)
 *   - dist/pii-shield-v{VERSION}-darwin-universal.mcpb (optional macOS binary bundle)
 *   - plugin/skills/pii-contract-analyze.zip      (skill bundle, prebuilt)
 *   - scripts/install-model.{ps1,bat,sh,command}  (user-facing model installer)
 *   - plugin/testkit-INSTALL.md                   (3-step install guide)
 *
 * Outputs:
 *   - dist/testkit/                                (loose files, expanded)
 *   - dist/pii-shield-testkit-v{VERSION}.zip       (single-file distribution)
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const TESTKIT_DIR = path.join(DIST, "testkit");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const VERSION = MANIFEST.version;
const ZIP_NAME = `pii-shield-testkit-v${VERSION}.zip`;

function isExecutableScript(filename) {
  return filename.endsWith(".command") || filename.endsWith(".sh");
}

async function main() {
  console.log(`=== PII Shield v${VERSION} Testkit Builder ===\n`);

  await fsp.rm(TESTKIT_DIR, { recursive: true, force: true });
  await fsp.mkdir(TESTKIT_DIR, { recursive: true });

  const inputs = [
    {
      name: `pii-shield-v${VERSION}.mcpb`,
      src: path.join(DIST, `pii-shield-v${VERSION}.mcpb`),
      required: true,
    },
    {
      name: `pii-shield-v${VERSION}-darwin-universal.mcpb`,
      src: path.join(DIST, `pii-shield-v${VERSION}-darwin-universal.mcpb`),
      required: false,
    },
    {
      name: "pii-contract-analyze.skill",
      src: path.join(ROOT, "plugin/skills/pii-contract-analyze.zip"),
      required: true,
    },
    { name: "install-model.ps1",     src: path.join(ROOT, "scripts/install-model.ps1"),     required: true },
    { name: "install-model.bat",     src: path.join(ROOT, "scripts/install-model.bat"),     required: true },
    { name: "install-model.sh",      src: path.join(ROOT, "scripts/install-model.sh"),      required: true },
    { name: "install-model.command", src: path.join(ROOT, "scripts/install-model.command"), required: true },
    { name: "INSTALL.md",            src: path.join(ROOT, "plugin/testkit-INSTALL.md"),     required: true },
  ];

  console.log("1. Staging files into dist/testkit/...");
  for (const input of inputs) {
    if (!fs.existsSync(input.src)) {
      const msg = `Missing input: ${input.src}`;
      if (input.required) throw new Error(msg);
      console.warn(`   WARN: ${msg}, skipping`);
      continue;
    }
    const dst = path.join(TESTKIT_DIR, input.name);
    await fsp.copyFile(input.src, dst);
    if (isExecutableScript(input.name) && process.platform !== "win32") {
      // No-op on Windows (chmod doesn't apply); on POSIX makes the loose
      // file executable too (testers using the dist/testkit/ dir directly).
      try { fs.chmodSync(dst, 0o755); } catch { /* best effort */ }
    }
    console.log(`   ✓ ${input.name}`);
  }

  console.log("\n2. Packing dist/testkit/ → ZIP with preserved Unix permissions...");
  const zip = new JSZip();
  for (const input of inputs) {
    const filePath = path.join(TESTKIT_DIR, input.name);
    if (!fs.existsSync(filePath)) continue;
    const data = fs.readFileSync(filePath);
    const opts = isExecutableScript(input.name) ? { unixPermissions: 0o755 } : {};
    zip.file(input.name, data, opts);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX", // emit Unix-style external attrs so unixPermissions actually take effect
  });
  const zipPath = path.join(DIST, ZIP_NAME);
  fs.writeFileSync(zipPath, buffer);
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
  console.log(`   ✓ ${zipPath} (${sizeMB} MB)`);

  console.log("\n✓ Testkit ready. Send the .zip to testers — single file, +x preserved on .command/.sh after unzip.");
}

main().catch((err) => {
  console.error("Testkit build failed:", err);
  process.exit(1);
});
