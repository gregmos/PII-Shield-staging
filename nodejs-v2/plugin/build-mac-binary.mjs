#!/usr/bin/env node

/**
 * Build a macOS-only MCPB that launches PII Shield through a bundled official
 * Node.js runtime instead of Claude Desktop's built-in Node path.
 *
 * This intentionally does not use `mcpb pack`: when that CLI runs on Windows it
 * drops Unix executable bits from ZIP entries, which breaks `server.type:
 * "binary"` launchers after Claude Desktop unpacks the extension on macOS.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const CACHE = path.join(DIST, ".cache", "node-runtime");
const BASE_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const VERSION = BASE_MANIFEST.version;

const NODE_VERSION = "24.15.0";
const NODE_BASE_URL = `https://nodejs.org/download/release/v${NODE_VERSION}`;
const TARGETS = [
  { arch: "arm64", nodePlatform: "darwin-arm64" },
  { arch: "x64", nodePlatform: "darwin-x64" },
];

const STAGE_DIR = path.join(DIST, "staging", `pii-shield-v${VERSION}-darwin-universal`);
const MCPB_NAME = `pii-shield-v${VERSION}-darwin-universal.mcpb`;
const MCPB_OUT = path.join(DIST, MCPB_NAME);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function getHttps(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "pii-shield-build" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        getHttps(next).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} failed: HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
  });
}

async function downloadFile(url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const data = await getHttps(url);
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, dest);
}

async function loadShaSums() {
  const text = (await getHttps(`${NODE_BASE_URL}/SHASUMS256.txt`)).toString("utf8");
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

async function ensureNodeArchive(target, shaSums) {
  const archiveName = `node-v${NODE_VERSION}-${target.nodePlatform}.tar.gz`;
  const archivePath = path.join(CACHE, archiveName);
  const expected = shaSums.get(archiveName);
  if (!expected) throw new Error(`No SHA256 entry found for ${archiveName}`);

  if (fs.existsSync(archivePath)) {
    const actual = sha256File(archivePath);
    if (actual === expected) {
      console.log(`   - ${archiveName} already cached`);
      return archivePath;
    }
    console.warn(`   - cached ${archiveName} hash mismatch; re-downloading`);
    await fsp.rm(archivePath, { force: true });
  }

  console.log(`   - downloading ${archiveName}`);
  await downloadFile(`${NODE_BASE_URL}/${archiveName}`, archivePath);
  const actual = sha256File(archivePath);
  if (actual !== expected) {
    await fsp.rm(archivePath, { force: true });
    throw new Error(`SHA256 mismatch for ${archiveName}: got ${actual}, expected ${expected}`);
  }
  return archivePath;
}

async function extractArchive(archivePath, target) {
  const extractRoot = path.join(os.tmpdir(), `pii-shield-node-${NODE_VERSION}-${target.nodePlatform}`);
  const expectedRoot = path.join(extractRoot, `node-v${NODE_VERSION}-${target.nodePlatform}`);
  await fsp.rm(extractRoot, { recursive: true, force: true });
  await fsp.mkdir(extractRoot, { recursive: true });
  const archiveForTar = process.platform === "win32"
    ? path.join(extractRoot, path.basename(archivePath))
    : archivePath;
  if (archiveForTar !== archivePath) {
    await fsp.copyFile(archivePath, archiveForTar);
  }
  console.log(`   - extracting ${path.basename(archivePath)}`);
  // On Windows GNU tar interprets `C:\...` as a remote host spec; extract from
  // within the temp dir (basename only) so the drive-letter colon never hits
  // tar's argv. Keeps macOS/Linux invocation identical.
  const tarArgs = process.platform === "win32"
    ? ["-xzf", path.basename(archiveForTar)]
    : ["-xzf", archiveForTar, "-C", extractRoot];
  const tarOpts = process.platform === "win32"
    ? { stdio: "inherit", shell: false, cwd: extractRoot }
    : { stdio: "inherit", shell: false };
  const result = spawnSync("tar", tarArgs, tarOpts);
  if (result.status !== 0) {
    throw new Error(`tar extraction failed for ${archivePath} with exit code ${result.status}`);
  }
  return expectedRoot;
}

async function copyFileIfExists(src, dst) {
  if (!fs.existsSync(src)) return;
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

async function stageRuntime(target, nodeRoot) {
  const runtimeRoot = path.join(STAGE_DIR, "runtime", target.nodePlatform);
  await fsp.mkdir(path.join(runtimeRoot, "bin"), { recursive: true });
  await fsp.mkdir(path.join(runtimeRoot, "lib", "node_modules"), { recursive: true });

  await fsp.copyFile(path.join(nodeRoot, "bin", "node"), path.join(runtimeRoot, "bin", "node"));
  await fsp.cp(
    path.join(nodeRoot, "lib", "node_modules", "npm"),
    path.join(runtimeRoot, "lib", "node_modules", "npm"),
    { recursive: true },
  );

  await copyFileIfExists(path.join(nodeRoot, "LICENSE"), path.join(runtimeRoot, "LICENSE"));
  await copyFileIfExists(path.join(nodeRoot, "README.md"), path.join(runtimeRoot, "README.md"));
}

function makeDarwinManifest() {
  const manifest = JSON.parse(JSON.stringify(BASE_MANIFEST));
  const env = manifest.server?.mcp_config?.env || {};
  manifest.description =
    `${manifest.description} macOS package includes Node.js ${NODE_VERSION} to avoid host runtime launch bugs.`;
  manifest.server = {
    type: "binary",
    entry_point: "launch.sh",
    mcp_config: {
      command: "${__dirname}/launch.sh",
      args: [],
      env,
    },
  };
  manifest.compatibility = {
    claude_desktop: BASE_MANIFEST.compatibility?.claude_desktop || ">=0.10.0",
    platforms: ["darwin"],
  };
  return manifest;
}

async function writeLauncher() {
  const launcher = `#!/bin/sh
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ARCH=$(uname -m)

case "$ARCH" in
  arm64|aarch64)
    NODE_DIR="$DIR/runtime/darwin-arm64"
    ;;
  x86_64|amd64)
    NODE_DIR="$DIR/runtime/darwin-x64"
    ;;
  *)
    echo "PII Shield: unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

export PATH="$NODE_DIR/bin:$PATH"
export PIISH_BUNDLED_NODE_DIR="$NODE_DIR"
exec "$NODE_DIR/bin/node" "$DIR/server.bundle.mjs" "$@"
`;
  await fsp.writeFile(path.join(STAGE_DIR, "launch.sh"), launcher, "utf8");
}

function isExecutableZipPath(relPath) {
  return relPath === "launch.sh" || /^runtime\/darwin-(arm64|x64)\/bin\/node$/.test(relPath);
}

async function addDirToZip(zip, dir, baseDir = dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await addDirToZip(zip, fullPath, baseDir);
      continue;
    }
    if (!entry.isFile()) continue;
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    const mode = isExecutableZipPath(relPath) ? 0o755 : 0o644;
    zip.file(relPath, fs.readFileSync(fullPath), { unixPermissions: mode });
  }
}

async function packMcpb() {
  const zip = new JSZip();
  await addDirToZip(zip, STAGE_DIR);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });

  const check = await JSZip.loadAsync(buffer);
  for (const relPath of [
    "launch.sh",
    "runtime/darwin-arm64/bin/node",
    "runtime/darwin-x64/bin/node",
  ]) {
    const entry = check.file(relPath);
    const mode = entry?.unixPermissions ? entry.unixPermissions & 0o777 : 0;
    if (mode !== 0o755) {
      throw new Error(`ZIP executable mode check failed for ${relPath}: ${mode.toString(8) || "<none>"}`);
    }
  }

  await fsp.writeFile(MCPB_OUT, buffer);
  return buffer.length;
}

function validateStagedManifest() {
  const manifestPath = path.join(STAGE_DIR, "manifest.json");
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/c", "mcpb.cmd", "validate", manifestPath], { stdio: "inherit" })
    : spawnSync("mcpb", ["validate", manifestPath], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`mcpb validate failed for darwin manifest with exit code ${result.status}`);
  }
}

async function main() {
  console.log(`=== PII Shield v${VERSION} macOS binary MCPB builder ===\n`);

  const bundlePath = path.join(DIST, "server.bundle.mjs");
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Missing ${bundlePath}. Run npm run build:plugin first, then npm run build:plugin:mac.`);
  }

  await fsp.rm(STAGE_DIR, { recursive: true, force: true });
  await fsp.mkdir(STAGE_DIR, { recursive: true });

  console.log(`1. Downloading/verifying official Node.js ${NODE_VERSION} runtimes`);
  const shaSums = await loadShaSums();
  for (const target of TARGETS) {
    const archivePath = await ensureNodeArchive(target, shaSums);
    const nodeRoot = await extractArchive(archivePath, target);
    await stageRuntime(target, nodeRoot);
    await fsp.rm(path.dirname(nodeRoot), { recursive: true, force: true });
  }

  console.log("\n2. Staging PII Shield server + binary manifest");
  await fsp.copyFile(bundlePath, path.join(STAGE_DIR, "server.bundle.mjs"));
  await writeLauncher();
  await fsp.writeFile(
    path.join(STAGE_DIR, "manifest.json"),
    `${JSON.stringify(makeDarwinManifest(), null, 2)}\n`,
    "utf8",
  );

  const licenseSrc = path.join(ROOT, "..", "LICENSE");
  if (fs.existsSync(licenseSrc)) {
    await fsp.copyFile(licenseSrc, path.join(STAGE_DIR, "LICENSE"));
  }

  console.log("\n3. Validating darwin manifest");
  validateStagedManifest();

  console.log("\n4. Packing MCPB with Unix executable bits");
  await fsp.rm(MCPB_OUT, { force: true });
  const size = await packMcpb();
  console.log(`   - executable bits OK for launch.sh and bundled node binaries`);
  console.log(`\nOK: ${MCPB_OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error("macOS binary MCPB build failed:", err);
  process.exit(1);
});
