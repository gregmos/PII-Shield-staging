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
 *   2. Assemble plugin ZIP → dist/pii-shield-v{VERSION}-plugin.zip
 *      (server.bundle.mjs + .claude-plugin/plugin.json + .mcp.json + skills/
 *      + commands/). Models NOT included — kept for legacy compatibility.
 *   3. Stage + `mcpb pack` → dist/pii-shield-v{VERSION}.mcpb (Claude Desktop).
 *      THIN bundle: server.bundle.mjs + manifest.json + LICENSE only (~1 MB).
 *
 * **Why the .mcpb is thin (no model bundled):**
 * The 634 MB GLiNER model is installed separately by the end user via
 * `scripts/install-model.ps1` (Windows) or `scripts/install-model.sh`
 * (macOS/Linux), which downloads the model from HuggingFace into
 * `~/.pii_shield/models/gliner-pii-base-v1.0/`. This keeps the .mcpb small
 * (fast Claude Desktop install), avoids the 90 sec silent preview window,
 * and decouples model updates from code releases.
 *
 * At runtime `ensureModelFiles()` in `src/engine/ner-backend.ts` does an
 * auto-BFS over common locations (settings override → `~/.pii_shield/models/`
 * → CLAUDE_PLUGIN_DATA → Downloads → bundle-relative) — first valid dir
 * wins. If nothing is found, the server returns a `needs_setup` envelope
 * telling the user to run the install-model one-liner.
 *
 * Runtime deps (onnxruntime-node, transformers, gliner) still auto-install
 * on first NER call into ${CLAUDE_PLUGIN_DATA}/deps — unchanged.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
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

function addFileToZip(zip, zipPath, filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  WARN: ${filePath} not found, skipping`);
    return;
  }
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
  // .html text loader can pick it up.
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

  // Step 1b: esbuild server bundle.
  console.log("\n1b. Building server bundle...");
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
      "canvas",
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

  // Step 2: Legacy plugin ZIP (for non-.mcpb hosts).
  console.log("\n2. Creating plugin ZIP...");
  const zip = new JSZip();

  addFileToZip(zip, "server.bundle.mjs", path.join(DIST, "server.bundle.mjs"));

  const pluginJsonPath = path.join(__dirname, ".claude-plugin/plugin.json");
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  if (pluginJson.version !== VERSION) {
    console.log(`   ⚠ plugin.json version ${pluginJson.version} → ${VERSION} (injected from manifest)`);
    pluginJson.version = VERSION;
  }
  zip.file(".claude-plugin/plugin.json", JSON.stringify(pluginJson, null, 2));
  addFileToZip(zip, ".mcp.json", path.join(__dirname, ".mcp.json"));
  addFileToZip(zip, ".claude/launch.json", path.join(__dirname, ".claude/launch.json"));

  const commandsDir = path.join(__dirname, "commands");
  if (fs.existsSync(commandsDir)) {
    addDirToZip(zip, "commands", commandsDir, (rel) => rel.endsWith(".md"));
    console.log(`   ✓ commands/ (slash commands)`);
  }

  const skillDir = path.join(__dirname, "skills/pii-contract-analyze");
  if (fs.existsSync(skillDir)) {
    addDirToZip(zip, "skills/pii-contract-analyze", skillDir);
  } else {
    const rootSkillDir = path.join(ROOT, "..", "pii-contract-analyze");
    if (fs.existsSync(rootSkillDir)) {
      addDirToZip(zip, "skills/pii-contract-analyze", rootSkillDir);
    }
  }

  console.log("   ⊘ models/ (not bundled; user installs via install-model script)");
  console.log("   ⊘ node_modules/ (onnxruntime-node auto-installed on first NER call)");

  console.log("\n3. Generating plugin ZIP...");
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const outPath = path.join(OUT_DIR, ZIP_NAME);
  fs.writeFileSync(outPath, buffer);
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
  console.log(`\n✓ Plugin ZIP created: ${outPath} (${sizeMB} MB)`);

  // Step 4: Stage + pack thin .mcpb.
  console.log("\n4. Packing thin .mcpb (Claude Desktop bundle)...");
  const stageDir = path.join(DIST, "staging", `pii-shield-v${VERSION}`);
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });

  await fsp.copyFile(path.join(ROOT, "manifest.json"), path.join(stageDir, "manifest.json"));
  await fsp.copyFile(path.join(DIST, "server.bundle.mjs"), path.join(stageDir, "server.bundle.mjs"));
  const licenseSrc = path.join(ROOT, "..", "LICENSE");
  if (fs.existsSync(licenseSrc)) {
    await fsp.copyFile(licenseSrc, path.join(stageDir, "LICENSE"));
  }

  console.log("   ⊘ models/ (not bundled — user runs install-model.ps1 / .sh before installing .mcpb)");

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
