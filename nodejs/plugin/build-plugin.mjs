#!/usr/bin/env node

/**
 * PII Shield v2.0.0 — Plugin ZIP Builder
 * Creates a distributable ZIP for Cowork containing:
 * - server.bundle.mjs (esbuild output)
 * - .claude-plugin/plugin.json
 * - .mcp.json
 * - commands/*.md (slash commands, e.g. /pii-debug-logs)
 * - skills/pii-contract-analyze/ (SKILL.md + references/)
 * - assets/review_ui.html
 *
 * Models (~665 MB) and runtime deps (onnxruntime-node, transformers, gliner)
 * are NOT bundled — they're auto-provisioned into ${CLAUDE_PLUGIN_DATA}/models
 * and /deps on first NER call by ensureModelFiles() + ensureNerDeps().
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT_DIR = DIST;
const ZIP_NAME = "pii-shield-v2.0.0-plugin.zip";

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
  console.log("=== PII Shield v2.0.0 Plugin Builder ===\n");

  // Step 1: Run esbuild
  console.log("1. Building bundle...");
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

  // Step 2: Create ZIP
  console.log("\n2. Creating ZIP...");
  const zip = new JSZip();

  // Bundle
  addFileToZip(zip, "server.bundle.mjs", path.join(DIST, "server.bundle.mjs"));

  // Plugin metadata
  addFileToZip(zip, ".claude-plugin/plugin.json", path.join(__dirname, ".claude-plugin/plugin.json"));
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

  // Assets
  addFileToZip(zip, "assets/review_ui.html", path.join(ROOT, "assets/review_ui.html"));

  // Models — NOT bundled. Auto-downloaded on first run to PATHS.MODELS_DIR
  // (= ${CLAUDE_PLUGIN_DATA}/models when installed as a Claude Code plugin).
  console.log("   ⊘ models/ (auto-download on first run, ~665 MB)");

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
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
