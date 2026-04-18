#!/usr/bin/env node

/**
 * PII Shield v2 — Plugin Builder (version read from manifest.json).
 *
 * Pipeline (order matters):
 *   1a. vite build ui/review.html → dist/ui/review.html (single-file via
 *       vite-plugin-singlefile — all TS/CSS inlined into one HTML document).
 *   1b. esbuild src/index.ts → dist/server.bundle.mjs, using the .html text
 *       loader so `import REVIEW_HTML from "../dist/ui/review.html"` gets
 *       inlined into the bundle as a string literal.
 *   1c. Download GLiNER model + tokenizer files (once-per-machine dev cache)
 *       — required for step 4 below which bundles them INSIDE the .mcpb.
 *   2. Stage + `mcpb pack` → dist/pii-shield-v{VERSION}.mcpb (Claude Desktop).
 *      The .mcpb contains server.bundle.mjs + manifest.json + LICENSE +
 *      models/gliner-pii-base-v1.0/{model.onnx, tokenizer files}.
 *   3. Assemble plugin ZIP → dist/pii-shield-v{VERSION}-plugin.zip
 *      (server.bundle.mjs + .claude-plugin/plugin.json + .mcp.json + skills/
 *      + commands/). Models NOT included in the plugin.zip — that format is
 *      only kept for legacy compatibility and has a 100 MB limit.
 *
 * No HTML asset ships as a standalone file in v2 — the UI is served to the
 * MCP host via the `ui://pii-shield/review.html` resource read (see
 * registerAppResource in src/index.ts), and the resource handler serves the
 * string that esbuild inlined from the vite output.
 *
 * **Why bundle the model inside the .mcpb?** — Claude Desktop Extensions
 * sometimes spawn multiple MCP server processes on the same host (known
 * [anthropics/claude-code#28126](https://github.com/anthropics/claude-code/issues/28126)).
 * When those multiple processes race to download the same 665 MB file from
 * HuggingFace into a shared cache dir (~/.pii_shield/models) we've seen every
 * flavour of corruption: ENOENT-on-rename (Defender quarantines), 0-byte
 * files (process-B-openSync-"w"-truncates-A's-mid-write), lockfile deadlocks.
 * Bundling ships the model pre-extracted with the extension — no runtime
 * download, no race surface, no coordination needed. Every server instance
 * opens the same read-only file path; Windows handles shared-read perfectly.
 *
 * Runtime deps (onnxruntime-node, transformers, gliner) are STILL auto-
 * installed on first NER call via npm into ${CLAUDE_PLUGIN_DATA}/deps — they
 * need platform-specific native binaries that we can't universally bundle.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT_DIR = DIST;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const VERSION = MANIFEST.version;
const ZIP_NAME = `pii-shield-v${VERSION}-plugin.zip`;
const MCPB_NAME = `pii-shield-v${VERSION}.mcpb`;

// ────────────────────────────────────────────────────────────────────────────
// GLiNER model + tokenizer — bundled inside the .mcpb. HuggingFace URLs
// resolved once per developer machine into a dev cache, then copied into the
// staging dir before `mcpb pack`. The cache is re-used across rebuilds so we
// don't re-download 665 MB every time.
// ────────────────────────────────────────────────────────────────────────────
const MODEL_SLUG = "gliner-pii-base-v1.0";
const HF_REPO = "knowledgator/gliner-pii-base-v1.0";
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;
const DEV_MODEL_CACHE = path.join(os.homedir(), ".pii_shield_dev_cache", "models", MODEL_SLUG);
const BUNDLED_FILES = [
  // { hfPath, localName, required }
  { hfPath: "onnx/model.onnx",        localName: "model.onnx",              required: true  },
  { hfPath: "tokenizer.json",         localName: "tokenizer.json",          required: true  },
  { hfPath: "tokenizer_config.json",  localName: "tokenizer_config.json",   required: true  },
  { hfPath: "special_tokens_map.json", localName: "special_tokens_map.json", required: true },
  { hfPath: "gliner_config.json",     localName: "gliner_config.json",      required: true  },
];

/**
 * Stream-download `url` to `destPath` using native fetch + sync fd writes.
 * Overwrites if present. No atomic rename needed — this is the build host,
 * not production; race conditions don't apply.
 */
async function fetchTo(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  if (!res.body) throw new Error(`No response body for ${url}`);
  const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const fd = fs.openSync(destPath, "w");
  let downloaded = 0;
  let lastLog = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, value);
      downloaded += value.length;
      if (totalBytes > 0) {
        const pct = Math.round((downloaded / totalBytes) * 100);
        if (pct - lastLog >= 10) {
          process.stdout.write(`\r        ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
          lastLog = pct;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (lastLog > 0) process.stdout.write("\n");
  return downloaded;
}

/**
 * Ensure all BUNDLED_FILES exist in DEV_MODEL_CACHE. Downloads anything missing.
 * Returns the resolved dev-cache dir so the caller can copy files into staging.
 */
async function ensureDevModelCache() {
  fs.mkdirSync(DEV_MODEL_CACHE, { recursive: true });
  for (const f of BUNDLED_FILES) {
    const local = path.join(DEV_MODEL_CACHE, f.localName);
    if (fs.existsSync(local)) {
      const sz = fs.statSync(local).size;
      console.log(`        ✓ ${f.localName} (cached, ${(sz / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    console.log(`        ↓ ${f.localName} — downloading from HuggingFace...`);
    const got = await fetchTo(`${HF_BASE}/${f.hfPath}`, local);
    console.log(`        ✓ ${f.localName} (${(got / 1024 / 1024).toFixed(1)} MB)`);
  }
  return DEV_MODEL_CACHE;
}

function addFileToZip(zip, zipPath, filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  WARN: ${filePath} not found, skipping`);
    return;
  }
  // Always use forward slashes in ZIP paths
  const normalizedPath = zipPath.replace(/\\/g, "/");
  const data = fs.readFileSync(filePath);
  zip.file(normalizedPath, data);
}

function addDirToZip(zip, zipPrefix, dirPath, filter) {
  if (!fs.existsSync(dirPath)) {
    console.warn(`  WARN: ${dirPath} not found, skipping`);
    return;
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(entry.parentPath || entry.path, entry.name);
    const relativePath = path.relative(dirPath, fullPath);
    if (filter && !filter(relativePath)) continue;
    const zipPath = `${zipPrefix}/${relativePath}`.replace(/\\/g, "/");
    zip.file(zipPath, fs.readFileSync(fullPath));
  }
}

async function build() {
  console.log(`=== PII Shield v${VERSION} Plugin Builder ===\n`);

  // Step 1a: vite build — produce dist/ui/review.html before esbuild so the
  // .html text loader can pick it up. vite-plugin-singlefile inlines all JS
  // and CSS into one HTML document, which becomes the response body for the
  // `ui://pii-shield/review.html` MCP resource.
  console.log("1a. vite build → dist/ui/review.html");
  const uiOut = path.join(DIST, "ui");
  await fsp.mkdir(uiOut, { recursive: true });
  const viteCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const viteResult = spawnSync(viteCmd, ["vite", "build", "--logLevel", "warn"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, INPUT: "review.html" },
  });
  if (viteResult.status !== 0) {
    throw new Error(`vite build failed with exit code ${viteResult.status}`);
  }
  const uiHtmlPath = path.join(uiOut, "review.html");
  if (!fs.existsSync(uiHtmlPath)) {
    throw new Error(
      `vite build finished but ${uiHtmlPath} does not exist — check outDir in vite.config.ts`,
    );
  }
  const uiHtmlSize = (fs.statSync(uiHtmlPath).size / 1024).toFixed(1);
  console.log(`   ✓ dist/ui/review.html (${uiHtmlSize} KB, single-file bundle)`);

  // Step 1b: Run esbuild
  console.log("\n1b. Building server bundle...");
  // @xenova/transformers, gliner, onnxruntime-node, onnxruntime-common, and sharp
  // are external — installed at runtime by ensureNerDeps() into PATHS.DEPS_DIR
  // (= ${CLAUDE_PLUGIN_DATA}/deps when installed as a plugin).
  // See nodejs/esbuild.config.mjs for the rationale.
  const { build } = await import("esbuild");
  await build({
    entryPoints: [path.join(ROOT, "src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    outfile: path.join(DIST, "server.bundle.mjs"),
    sourcemap: false,
    external: [
      "@xenova/transformers",
      "gliner",
      "onnxruntime-node",
      "onnxruntime-common",
      "sharp",
      "canvas", // optional pdf.js dep for rendering, not used for text extraction
    ],
    loader: { ".html": "text" },
    banner: {
      js: [
        'import { createRequire } from "module";',
        'import { fileURLToPath as __esm_fileURLToPath } from "url";',
        'import { dirname as __esm_dirname } from "path";',
        'import * as __early_fs from "fs";',
        'import * as __early_path from "path";',
        'import * as __early_os from "os";',
        'const require = createRequire(import.meta.url);',
        'const __filename = __esm_fileURLToPath(import.meta.url);',
        'const __dirname = __esm_dirname(__filename);',
        'function __earlyDataDir() {',
        '  const pluginData = process.env.CLAUDE_PLUGIN_DATA;',
        '  if (pluginData && pluginData.length > 0) return pluginData;',
        '  return __early_path.join(__early_os.homedir(), ".pii_shield");',
        '}',
        'function __earlyLog(msg) {',
        '  try {',
        '    const dir = __early_path.join(__earlyDataDir(), "audit");',
        '    __early_fs.mkdirSync(dir, { recursive: true });',
        '    __early_fs.appendFileSync(__early_path.join(dir, "ner_init.log"), new Date().toISOString() + " " + msg + "\\n");',
        '  } catch (_) {}',
        '  try { console.error(msg); } catch (_) {}',
        '}',
        'process.on("uncaughtException", (err) => { __earlyLog("[UNCAUGHT] " + (err && err.stack || err)); });',
        'process.on("unhandledRejection", (reason) => { __earlyLog("[UNHANDLED] " + (reason && reason.stack || reason)); });',
        'globalThis.__earlyLog = __earlyLog;',
        '__earlyLog("[init] node=" + process.version + " platform=" + process.platform + " pid=" + process.pid);',
        '__earlyLog("[init] cwd=" + process.cwd() + " CLAUDE_PLUGIN_DATA=" + (process.env.CLAUDE_PLUGIN_DATA || "<unset>"));',
        '__earlyLog("[init] banner ok, entering bundle");',
      ].join("\n"),
    },
  });
  console.log("   ✓ dist/server.bundle.mjs");

  // Step 1c: Ensure GLiNER model + tokenizer in the developer cache. They
  // will be copied into the .mcpb staging dir in step 4 so every install has
  // the model shipped next to server.bundle.mjs — no runtime download race.
  console.log("\n1c. Ensuring GLiNER model + tokenizer in dev cache...");
  console.log(`    cache dir: ${DEV_MODEL_CACHE}`);
  await ensureDevModelCache();

  // Step 2: Create ZIP
  console.log("\n2. Creating ZIP...");
  const zip = new JSZip();

  // Bundle
  addFileToZip(zip, "server.bundle.mjs", path.join(DIST, "server.bundle.mjs"));

  // Plugin metadata — inject version from manifest.json so plugin.json never
  // drifts out of sync with the rest of the build (config.ts VERSION, manifest.json,
  // ZIP/MCPB filenames all come from MANIFEST.version).
  const pluginJsonPath = path.join(__dirname, ".claude-plugin/plugin.json");
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  if (pluginJson.version !== VERSION) {
    console.log(`   ⚠ plugin.json version ${pluginJson.version} → ${VERSION} (injected from manifest)`);
    pluginJson.version = VERSION;
  }
  zip.file(".claude-plugin/plugin.json", JSON.stringify(pluginJson, null, 2));
  addFileToZip(zip, ".mcp.json", path.join(__dirname, ".mcp.json"));
  addFileToZip(zip, ".claude/launch.json", path.join(__dirname, ".claude/launch.json"));

  // Slash commands (e.g. /pii-debug-logs) — loaded by Claude Code's plugin
  // command scanner from the plugin-root `commands/` dir.
  const commandsDir = path.join(__dirname, "commands");
  if (fs.existsSync(commandsDir)) {
    addDirToZip(zip, "commands", commandsDir, (rel) => rel.endsWith(".md"));
    console.log(`   ✓ commands/ (slash commands)`);
  }

  // Skill
  const skillDir = path.join(__dirname, "skills/pii-contract-analyze");
  if (fs.existsSync(skillDir)) {
    addDirToZip(zip, "skills/pii-contract-analyze", skillDir);
  } else {
    // Copy from project root
    const rootSkillDir = path.join(ROOT, "..", "pii-contract-analyze");
    if (fs.existsSync(rootSkillDir)) {
      addDirToZip(zip, "skills/pii-contract-analyze", rootSkillDir);
    }
  }

  // No standalone HTML assets — the review UI is inlined into server.bundle.mjs
  // via esbuild's .html text loader (see step 1a/1b above) and served as the
  // body of the `ui://pii-shield/review.html` MCP resource.

  // Models — bundled inside the .mcpb (step 4 below), NOT inside the plugin
  // ZIP. Claude Code plugin.zip has a 100 MB cap; we won't fit a 665 MB model
  // in there anyway. The plugin.zip distribution is legacy — all users should
  // install via `.mcpb` (Claude Desktop Extension).
  console.log("   ⊘ models/ (bundled inside .mcpb, not in plugin.zip)");

  // No node_modules/ in ZIP — everything is either:
  // - Bundled into server.bundle.mjs (esbuild)
  // - Auto-installed at first run via npm (onnxruntime-node → PATHS.DEPS_DIR)
  console.log("   ⊘ node_modules/ (onnxruntime-node auto-installed on first NER call)");

  // Generate ZIP
  console.log("\n3. Generating ZIP file...");
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const outPath = path.join(OUT_DIR, ZIP_NAME);
  fs.writeFileSync(outPath, buffer);
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
  console.log(`\n✓ Plugin ZIP created: ${outPath} (${sizeMB} MB)`);

  // Step 4: Stage + pack .mcpb (Claude Desktop MCPB bundle)
  console.log("\n4. Packing .mcpb (Claude Desktop bundle)...");
  const stageDir = path.join(DIST, "staging", `pii-shield-v${VERSION}`);
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });

  // manifest.json — required by Claude Desktop
  await fsp.copyFile(path.join(ROOT, "manifest.json"), path.join(stageDir, "manifest.json"));
  // server bundle — entry_point in manifest
  await fsp.copyFile(path.join(DIST, "server.bundle.mjs"), path.join(stageDir, "server.bundle.mjs"));
  // LICENSE (optional)
  const licenseSrc = path.join(ROOT, "..", "LICENSE");
  if (fs.existsSync(licenseSrc)) {
    await fsp.copyFile(licenseSrc, path.join(stageDir, "LICENSE"));
  }

  // Bundled model + tokenizer — copied from the dev cache populated in step 1c.
  // Lands at `<extension_root>/models/<slug>/{...}` on install.
  //
  // model.onnx is SPLIT into two parts (part-aa + part-ab) because Claude
  // Desktop enforces a 512 MB per-inner-file limit inside a .mcpb archive —
  // the full 634 MB model.onnx would be rejected at preview:
  //   "Failed to read or unzip file: File is too large: 634MB (max: 512MB)"
  // Splitting at a 500 MB boundary puts both parts comfortably under the limit.
  // The runtime concatenates them back into model.onnx on first startup (see
  // ensureModelFiles in src/engine/ner-backend.ts). Reassembly is a local
  // byte-stream copy (no network, no hash, no lock), ~5 sec on SSD.
  const stageModelsDir = path.join(stageDir, "models", MODEL_SLUG);
  await fsp.mkdir(stageModelsDir, { recursive: true });
  const SPLIT_AT = 500 * 1024 * 1024; // 500 MB — leaves headroom below the 512 MB mcpb inner-file cap
  let totalModelBytes = 0;
  for (const f of BUNDLED_FILES) {
    const src = path.join(DEV_MODEL_CACHE, f.localName);
    if (f.localName === "model.onnx") {
      // Stream-split the big ONNX into two parts. Using a chunked read/write
      // loop so we don't hold 634 MB in memory during the build.
      const srcSize = fs.statSync(src).size;
      const dstA = path.join(stageModelsDir, "model.onnx.part-aa");
      const dstB = path.join(stageModelsDir, "model.onnx.part-ab");
      const srcFd = fs.openSync(src, "r");
      const fdA = fs.openSync(dstA, "w");
      const fdB = fs.openSync(dstB, "w");
      const CHUNK = 1 * 1024 * 1024; // 1 MB read chunks
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      try {
        while (pos < srcSize) {
          const want = Math.min(CHUNK, srcSize - pos);
          const got = fs.readSync(srcFd, buf, 0, want, pos);
          if (got <= 0) break;
          // Decide which part this chunk goes to. Most chunks are entirely in
          // part-aa OR part-ab; only the one chunk straddling the boundary
          // splits across both.
          if (pos + got <= SPLIT_AT) {
            fs.writeSync(fdA, buf, 0, got);
          } else if (pos >= SPLIT_AT) {
            fs.writeSync(fdB, buf, 0, got);
          } else {
            const headLen = SPLIT_AT - pos;
            fs.writeSync(fdA, buf, 0, headLen);
            fs.writeSync(fdB, buf, headLen, got - headLen);
          }
          pos += got;
        }
      } finally {
        fs.closeSync(srcFd);
        fs.closeSync(fdA);
        fs.closeSync(fdB);
      }
      const sizeA = fs.statSync(dstA).size;
      const sizeB = fs.statSync(dstB).size;
      totalModelBytes += sizeA + sizeB;
      console.log(
        `   ✓ models/${MODEL_SLUG}/model.onnx.part-aa (${(sizeA / 1024 / 1024).toFixed(1)} MB)`,
      );
      console.log(
        `   ✓ models/${MODEL_SLUG}/model.onnx.part-ab (${(sizeB / 1024 / 1024).toFixed(1)} MB)`,
      );
    } else {
      // Tokenizer JSON files — small, copy as-is.
      const dst = path.join(stageModelsDir, f.localName);
      await fsp.copyFile(src, dst);
      totalModelBytes += fs.statSync(dst).size;
    }
  }
  console.log(
    `   ✓ models/${MODEL_SLUG}/ bundled (${BUNDLED_FILES.length + 1} files total, ` +
    `${(totalModelBytes / 1024 / 1024).toFixed(1)} MB)`,
  );

  const mcpbOut = path.join(OUT_DIR, MCPB_NAME);
  await fsp.rm(mcpbOut, { force: true });
  const cmd = process.platform === "win32" ? "mcpb.cmd" : "mcpb";
  const result = spawnSync(cmd, ["pack", stageDir, mcpbOut], { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    throw new Error(`mcpb pack failed with exit code ${result.status}`);
  }
  const mcpbSizeMB = (fs.statSync(mcpbOut).size / 1024 / 1024).toFixed(2);
  console.log(`\n✓ MCPB created: ${mcpbOut} (${mcpbSizeMB} MB)`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
