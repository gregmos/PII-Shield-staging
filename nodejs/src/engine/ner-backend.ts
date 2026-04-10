/**
 * PII Shield v2.0.0 — GLiNER NER Backend
 * Uses the `gliner` npm package (Node.js variant) with onnxruntime-node.
 * Model: knowledgator/gliner-pii-base-v1.0 (ONNX fp32)
 * Auto-downloads on first run to PATHS.MODELS_DIR
 * (= ${CLAUDE_PLUGIN_DATA}/models or legacy ~/.pii_shield/models).
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire as _createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { DetectedEntity } from "./pattern-recognizers.js";
import { PATHS, LEGACY_DATA_DIR } from "../utils/config.js";
import { logServer } from "../audit/audit-logger.js";

function getDepsDir(): string {
  return PATHS.DEPS_DIR;
}

const NER_DEP_PACKAGES = [
  "onnxruntime-node",
  "onnxruntime-common",
  "@xenova/transformers",
  "gliner",
] as const;

// GLiNER label → our entity type mapping
const LABEL_MAP: Record<string, string> = {
  person: "PERSON",
  organization: "ORGANIZATION",
  location: "LOCATION",
  "political group": "NRP",
  email: "EMAIL_ADDRESS",
  "phone number": "PHONE_NUMBER",
  address: "LOCATION",
  passport: "EU_PASSPORT",
  "credit card number": "CREDIT_CARD",
  "social security number": "US_SSN",
  "health insurance id number": "UK_NHS",
  "national id number": "UK_NIN",
  "medical license number": "MEDICAL_LICENSE",
  "tax identification number": "DE_TAX_ID",
  "date of birth": "PERSON",
  iban: "IBAN_CODE",
  url: "URL",
  "ip address": "IP_ADDRESS",
  "driver license number": "US_DRIVER_LICENSE",
};

// Entity labels for GLiNER — focused on named entities that regex can't detect.
// Pattern recognizers handle structured PII (email, phone, SSN, etc.) much better.
// Fewer labels = higher quality NER results (less attention dilution).
const NER_LABELS = [
  "person",
  "organization",
  "location",
  "political group",
  "address",
  "date of birth",
];

// Singleton state
let _gliner: any = null;
let _initPromise: Promise<void> | null = null;
let _initFailed = false;
let _initError: string = "";
let _lastInferenceError: string = "";
let _inferenceCallCount = 0;
let _inferenceTotalEntities = 0;

// Progress state — exposed via getNerStatus() so the `list_entities` MCP tool
// can surface a useful phase/percent/message to Claude while the first-run
// bootstrap (deps install + model download + gliner.initialize) runs. Without
// this the user sees no feedback during the 2–5 min cold start.
export type NerPhase =
  | "idle"
  | "installing_deps"
  | "downloading_model"
  | "loading_model"
  | "ready"
  | "error";
let _nerPhase: NerPhase = "idle";
let _nerProgressPct = 0;
let _nerMessage = "";

function setNerStatus(phase: NerPhase, pct: number, message: string): void {
  _nerPhase = phase;
  _nerProgressPct = Math.max(0, Math.min(100, Math.round(pct)));
  _nerMessage = message;
  nerLog(`[NER] status → ${phase} ${_nerProgressPct}% — ${message}`);
}

/** Expose current NER init phase / progress for list_entities. */
export function getNerStatus(): {
  phase: NerPhase;
  progress_pct: number;
  message: string;
  ready: boolean;
  error: string;
} {
  return {
    phase: _nerPhase,
    progress_pct: _nerProgressPct,
    message: _nerMessage,
    ready: _gliner !== null && _nerPhase === "ready",
    error: _initFailed ? _initError : "",
  };
}

/** Get the NER initialization error message (empty if no error). */
export function getNerError(): string {
  return _initError;
}

/** Get the most recent NER inference error (empty if last call succeeded). */
export function getNerInferenceError(): string {
  return _lastInferenceError;
}

/** Get NER call statistics for diagnostics. */
export function getNerStats(): { calls: number; totalEntities: number; lastError: string } {
  return {
    calls: _inferenceCallCount,
    totalEntities: _inferenceTotalEntities,
    lastError: _lastInferenceError,
  };
}

/** Write to NER debug log file (stderr is lost in MCP stdio mode). */
export function nerLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}\n`;
  console.error(line.trim());
  try {
    const logDir = PATHS.AUDIT_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "ner_init.log"), line);
  } catch { /* best effort */ }
}

// HuggingFace model files to download.
//
// Why gliner-pii-base/fp32 (665 MB) — every other variant is broken on our stack:
// - base/fp16 (333 MB): onnxruntime-node CPU EP doesn't support fp16 reliably —
//   loads with "Type Error: tensor(float16) ... expected tensor(float)" because
//   the CPU provider doesn't implement most fp16 operators. ORT docs:
//   https://onnxruntime.ai/docs/performance/model-optimizations/float16.html
// - base/quint8 (197 MB): empirically returns 0 entities even at threshold 0.25.
//   uint8 quantization on this model is too lossy.
// - small/fp32 (327 MB): uses jhu-clsp/ettin-encoder-68m with PreTrainedTokenizerFast
//   (BPE), which @xenova/transformers AutoTokenizer can't parse — fails
//   gliner.initialize() with "x.split is not a function".
// So fp32/665 MB is the only execution-stable option. Slow download per ephemeral
// VM session is annoying but functional; waitForNer() polling handles the wait.
const HF_REPO = "knowledgator/gliner-pii-base-v1.0";
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;
const TOKENIZER_FILES = [
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "gliner_config.json",
] as const;
const REMOTE_MODEL = "onnx/model.onnx"; // fp32, ~665 MB

// Content-addressed cache layout — see plan section 5. The model lives as a
// flat self-describing file at the workspace root (or any other persistent
// location); tokenizer JSONs live in a sidecar dir next to it. The slug + sha
// suffix make stale caches unambiguous and let `find_file` glob match them
// across workspace switches.
const MODEL_SLUG = "knowledgator_gliner-pii-base-v1.0";
const MODEL_FILENAME_PREFIX = `pii_shield_model__${MODEL_SLUG}__model_onnx`;
const TOKENIZER_DIRNAME = `pii_shield_tokenizer__${MODEL_SLUG}`;

function modelFilenameWithSha(shaHex: string): string {
  return `${MODEL_FILENAME_PREFIX}__sha256-${shaHex.slice(0, 16)}.onnx`;
}

function getDefaultModelsDir(): string {
  return PATHS.MODELS_DIR;
}

/**
 * Candidate roots for the persistent model cache, in priority order.
 * The first one containing a matching `pii_shield_model__*.onnx` wins on read.
 * The first writable one wins on download.
 *
 * Priority:
 *   1. PATHS.MODELS_DIR — the plugin persistent dir (${CLAUDE_PLUGIN_DATA}/models
 *      when launched by Claude Code, else legacy ~/.pii_shield/models)
 *   2. PII_SHIELD_MODEL_PATH env override (directory containing the file)
 *   3. cwd / parent / Downloads / home — catches warmed caches from previous
 *      dev launches or hand-placed downloads
 *   4. Legacy ~/.pii_shield/models — read-only fallback so pre-plugin installs
 *      with an existing 665 MB cache are still honored without re-downloading
 */
function cacheRoots(): string[] {
  const home = os.homedir();
  const cwd = process.cwd();
  const explicit = process.env.PII_SHIELD_MODEL_PATH;
  const roots: string[] = [];
  roots.push(PATHS.MODELS_DIR);
  if (explicit) roots.push(path.dirname(explicit));
  roots.push(cwd);
  roots.push(path.dirname(cwd));
  roots.push(path.join(home, "Downloads"));
  roots.push(home);
  // Legacy fallback — only adds if different from PATHS.MODELS_DIR
  const legacyModels = path.join(LEGACY_DATA_DIR, "models");
  roots.push(legacyModels);
  return [...new Set(roots.filter(Boolean))];
}

function tokenizerDirComplete(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return TOKENIZER_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Walk cache roots looking for a content-addressed model file + sibling
 * tokenizer dir. Returns null if no complete cache found anywhere.
 */
function findCachedModel(): { modelPath: string; tokenizerDir: string } | null {
  // 1) Explicit env override (highest precedence)
  const explicit = process.env.PII_SHIELD_MODEL_PATH;
  if (explicit && fs.existsSync(explicit)) {
    const dir = path.dirname(explicit);
    const tokDir = path.join(dir, TOKENIZER_DIRNAME);
    if (tokenizerDirComplete(tokDir)) {
      nerLog(`[NER] cache hit (env override): ${explicit}`);
      return { modelPath: explicit, tokenizerDir: tokDir };
    }
  }

  // 2) Walk candidate roots, glob for content-addressed model file
  for (const root of cacheRoots()) {
    try {
      const entries = fs.readdirSync(root);
      const match = entries.find(
        (n) => n.startsWith(MODEL_FILENAME_PREFIX) && n.endsWith(".onnx"),
      );
      if (!match) continue;
      const modelPath = path.join(root, match);
      const tokDir = path.join(root, TOKENIZER_DIRNAME);
      if (tokenizerDirComplete(tokDir)) {
        nerLog(`[NER] cache hit: ${modelPath}`);
        return { modelPath, tokenizerDir: tokDir };
      }
      nerLog(`[NER] found ${match} at ${root} but tokenizer dir incomplete — skipping`);
    } catch { /* not readable, try next */ }
  }

  // 3) Legacy ~/.pii_shield/models/ flat layout (model.onnx + tokenizer files
  //    in the same dir). Honored even when CLAUDE_PLUGIN_DATA points
  //    elsewhere, so pre-plugin users with a warmed 665 MB cache don't have
  //    to re-download after upgrading to the plugin install.
  const legacyDirs = [
    path.join(LEGACY_DATA_DIR, "models"),
    PATHS.MODELS_DIR,
  ];
  for (const legacy of legacyDirs) {
    const legacyModel = path.join(legacy, "model.onnx");
    if (fs.existsSync(legacyModel) && tokenizerDirComplete(legacy)) {
      nerLog(`[NER] cache hit (legacy flat layout): ${legacyModel}`);
      return { modelPath: legacyModel, tokenizerDir: legacy };
    }
  }

  return null;
}

/** Pick the first writable cache root for a fresh download. */
function pickWriteRoot(): string {
  for (const root of cacheRoots()) {
    try {
      fs.mkdirSync(root, { recursive: true });
      const probe = path.join(root, `.pii_shield_probe_${process.pid}`);
      fs.writeFileSync(probe, "x");
      fs.unlinkSync(probe);
      return root;
    } catch { /* try next */ }
  }
  // Last resort — guaranteed to exist in $HOME
  const fallback = getDefaultModelsDir();
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Download a file from URL, following redirects. Returns the SHA-256 hex digest
 * of the downloaded bytes (used to content-address the model file).
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (pct: number, downloadedBytes: number, totalBytes: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proto = parsed.protocol === "https:" ? https : http;
    proto.get(parsed, (res) => {
      // Follow redirects (HuggingFace uses 302/307)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        nerLog(`[NER] Redirect ${res.statusCode} → ${redirectUrl.slice(0, 80)}...`);
        downloadFile(redirectUrl, destPath, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
      let downloaded = 0;
      let lastLog = 0;
      const hash = crypto.createHash("sha256");
      const file = fs.createWriteStream(destPath);
      res.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        hash.update(chunk);
        if (totalBytes > 0) {
          const pct = Math.round((downloaded / totalBytes) * 100);
          if (pct - lastLog >= 2) {
            nerLog(`[NER] Downloading ${path.basename(destPath)}... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
            lastLog = pct;
            onProgress?.(pct, downloaded, totalBytes);
          }
        }
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(hash.digest("hex")); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Write a small README next to the cached model so the user understands what
 * the large file is and that it's safe to keep, move, or delete.
 */
function writeCacheReadme(root: string): void {
  try {
    const readmePath = path.join(root, "pii_shield_model__README.txt");
    if (fs.existsSync(readmePath)) return;
    const body =
`PII Shield model cache
======================

This folder contains a cached PII detection model used by the PII Shield plugin.

Files:
  pii_shield_model__${MODEL_SLUG}__model_onnx__sha256-<hash>.onnx   (~665 MB)
  ${TOKENIZER_DIRNAME}/                                                (~10 MB)

Where it came from:
  HuggingFace repo: ${HF_REPO}

What it does:
  PII Shield uses this model locally to detect names, organizations, locations,
  and other PII in documents. The model never leaves your machine.

Is it safe to delete?
  Yes. PII Shield will re-download it on next use (~5 minutes).

Can I move it?
  Yes. Put it anywhere — PII Shield searches your workspace, parent directory,
  Downloads folder, and home directory on startup. The filename is the marker.
  For best results, keep it somewhere stable like ~/Downloads or a dedicated
  cache folder, so it survives across sessions.
`;
    fs.writeFileSync(readmePath, body, "utf-8");
  } catch { /* best effort */ }
}

/**
 * Resolve the model + tokenizer paths, downloading if necessary.
 * Returns absolute paths usable by gliner. Skips download entirely if a
 * content-addressed cache exists in any of the candidate roots.
 */
async function ensureModelFiles(): Promise<{ modelPath: string; tokenizerDir: string }> {
  // Fast path: anywhere on disk already has a complete cache
  const cached = findCachedModel();
  if (cached) {
    nerLog(`[NER] Using cached model at ${cached.modelPath}`);
    return cached;
  }

  // Cold path: download to first writable cache root
  const writeRoot = pickWriteRoot();
  nerLog(`[NER] No cache found. Downloading to ${writeRoot}`);

  // Download the model to a temp file, compute SHA, rename to content-addressed name.
  const tmpModelPath = path.join(writeRoot, `${MODEL_FILENAME_PREFIX}.tmp`);
  let modelPath: string;
  try {
    setNerStatus(
      "downloading_model",
      10,
      "Downloading GLiNER ONNX model (~665 MB) from HuggingFace… 0%",
    );
    nerLog(`[NER] Downloading ${REMOTE_MODEL} from ${HF_REPO}...`);
    const sha = await downloadFile(
      `${HF_BASE}/${REMOTE_MODEL}`,
      tmpModelPath,
      (pct, dl, _total) => {
        // Map raw 0–100% download pct into our 10–90% bootstrap band.
        const mapped = 10 + Math.round(pct * 0.8);
        setNerStatus(
          "downloading_model",
          mapped,
          `Downloading GLiNER ONNX model (~665 MB): ${pct}% (${(dl / 1024 / 1024).toFixed(1)} MB). First run only — cached for the life of the plugin.`,
        );
      },
    );
    const finalName = modelFilenameWithSha(sha);
    modelPath = path.join(writeRoot, finalName);
    fs.renameSync(tmpModelPath, modelPath);
    const size = fs.statSync(modelPath).size;
    nerLog(`[NER] ✓ ${finalName} (${(size / 1024 / 1024).toFixed(1)} MB, sha256=${sha.slice(0, 16)}…)`);
  } catch (e) {
    try { fs.unlinkSync(tmpModelPath); } catch { /* */ }
    throw new Error(`Failed to download model: ${e}`);
  }

  // Download tokenizer files into sidecar directory
  setNerStatus("downloading_model", 92, "Downloading GLiNER tokenizer files…");
  const tokenizerDir = path.join(writeRoot, TOKENIZER_DIRNAME);
  fs.mkdirSync(tokenizerDir, { recursive: true });
  for (const fname of TOKENIZER_FILES) {
    const dest = path.join(tokenizerDir, fname);
    if (fs.existsSync(dest)) continue;
    const tmpDest = dest + ".tmp";
    nerLog(`[NER] Downloading ${fname}...`);
    try {
      await downloadFile(`${HF_BASE}/${fname}`, tmpDest);
      fs.renameSync(tmpDest, dest);
      const size = fs.statSync(dest).size;
      nerLog(`[NER] ✓ ${fname} (${(size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      try { fs.unlinkSync(tmpDest); } catch { /* */ }
      throw new Error(`Failed to download ${fname}: ${e}`);
    }
  }

  writeCacheReadme(writeRoot);
  nerLog(`[NER] Model + tokenizer cached at ${writeRoot}`);
  return { modelPath, tokenizerDir };
}

/**
 * Ensure all NER native/runtime deps are installed in PATHS.DEPS_DIR
 * (= ${CLAUDE_PLUGIN_DATA}/deps or legacy ~/.pii_shield/deps).
 *
 * We can't bundle these into the esbuild output:
 * - onnxruntime-node ships native .node addons (per-OS/arch).
 * - @xenova/transformers has a known bundler-hostile circular import structure
 *   around onnxruntime (huggingface/transformers.js#875, #1087) that triggers
 *   "Maximum call stack size exceeded" when bundled together with our code.
 * - gliner depends on transformers + onnxruntime-node.
 * - sharp is a native addon transitively pulled in by transformers.
 *
 * So we install the whole stack as a real npm tree at runtime and load it via
 * createRequire anchored at the deps dir.
 */
async function ensureNerDeps(): Promise<string> {
  const depsDir = getDepsDir();
  const nmDir = path.join(depsDir, "node_modules");

  // All four packages must exist; partial installs trigger a reinstall.
  const allInstalled = NER_DEP_PACKAGES.every((pkgName) =>
    fs.existsSync(path.join(nmDir, ...pkgName.split("/"), "package.json")),
  );
  if (allInstalled) return depsDir;

  setNerStatus(
    "installing_deps",
    5,
    "Installing onnxruntime-node, @xenova/transformers, gliner into ${CLAUDE_PLUGIN_DATA}/deps (first run only, ~1–2 min)…",
  );
  nerLog(`[NER] Installing NER dependencies in ${depsDir}...`);
  fs.mkdirSync(depsDir, { recursive: true });

  // Pin onnxruntime-node to 1.19.2 — newer (1.20+) downloads CUDA GPU runtime
  // (~600 MB) which fills /tmp and crashes with ENOSPC in constrained VMs.
  // onnxruntime-common is a "ghost dependency" of @xenova/transformers
  // (huggingface/transformers.js#1087) — pin it explicitly to match.
  const pkg = {
    name: "pii-shield-deps",
    version: "1.0.0",
    dependencies: {
      "onnxruntime-node": "1.19.2",
      "onnxruntime-common": "1.19.2",
      "@xenova/transformers": "2.17.2",
      "gliner": "0.0.19",
    },
  };
  fs.writeFileSync(path.join(depsDir, "package.json"), JSON.stringify(pkg));

  const { execFile } = await import("node:child_process");
  // On Windows `npm` is a `.cmd` shim — execFile won't find it without shell.
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

  // Heartbeat: bump progress every 4 s so the user sees motion instead of a
  // stuck "5%". Caps at 8% to leave room for the post-install bump to 9%.
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const pct = Math.min(8, 5 + Math.floor(secs / 12)); // 5 → 8 over ~36 s
    setNerStatus(
      "installing_deps",
      pct,
      `Installing onnxruntime-node, @xenova/transformers, gliner into deps/ (npm install running, ${secs}s elapsed)…`,
    );
  }, 4000);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        npmCmd,
        ["install", "--production", "--no-audit", "--no-fund"],
        {
          cwd: depsDir,
          timeout: 300000, // 5 min — 4 packages, ~80 MB total
          shell: process.platform === "win32",
          maxBuffer: 32 * 1024 * 1024,
          env: {
            ...process.env,
            // Skip CUDA/GPU runtime download in newer onnxruntime-node versions
            ONNXRUNTIME_NODE_INSTALL_CUDA: "skip",
          },
        },
        (err, stdout, stderr) => {
          if (err) {
            const tail = (stderr || "").split("\n").slice(-30).join("\n");
            reject(new Error(`npm install failed (cwd=${depsDir}): ${err.message}\n--- npm stderr (last 30 lines) ---\n${tail}\n--- npm stdout (last 10 lines) ---\n${(stdout || "").split("\n").slice(-10).join("\n")}`));
          }
          else resolve();
        },
      );
    });
    setNerStatus("installing_deps", 9, "NER dependencies installed.");
    nerLog(`[NER] ✓ NER dependencies installed`);
  } catch (e) {
    nerLog(`[NER] Failed to install NER deps: ${e}`);
    throw e;
  } finally {
    clearInterval(heartbeat);
  }
  return depsDir;
}

async function initGliner(): Promise<void> {
  if (_gliner) return;
  if (_initFailed) throw new Error("GLiNER initialization previously failed");

  try {
    setNerStatus("installing_deps", 2, "Starting PII Shield NER initialization…");
    nerLog("[NER] initGliner starting...");

    // Ensure NER deps (transformers, gliner, onnxruntime-node, onnxruntime-common)
    // are installed in PATHS.DEPS_DIR. Returns the deps directory path.
    const depsDir = await ensureNerDeps();
    nerLog("[NER] NER deps OK");

    const { modelPath, tokenizerDir } = await ensureModelFiles();
    nerLog(`[NER] modelPath=${modelPath}`);
    nerLog(`[NER] tokenizerDir=${tokenizerDir}`);

    // Resolve transformers / gliner from the deps dir explicitly via createRequire,
    // bypassing NODE_PATH which is unreliable in ESM contexts. createRequire
    // anchored at <depsDir>/package.json walks <depsDir>/node_modules/ as if a
    // file in depsDir was doing the require.
    const requireFromDeps = _createRequire(path.join(depsDir, "package.json"));

    nerLog("[NER] resolving @xenova/transformers from deps...");
    const transformersEntry = requireFromDeps.resolve("@xenova/transformers");
    const transformers: any = await import(pathToFileURL(transformersEntry).href);
    const env = transformers.env;
    // Tokenizer files live in the sidecar dir; modelPath is loaded explicitly
    // by gliner from its absolute path.
    env.localModelPath = tokenizerDir;
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    env.allowRemoteModels = false;

    nerLog("[NER] resolving gliner/node from deps...");
    let glinerEntry: string;
    try {
      glinerEntry = requireFromDeps.resolve("gliner/node");
    } catch {
      // Fallback if gliner doesn't expose the ./node subpath in its exports map
      glinerEntry = requireFromDeps.resolve("gliner");
    }
    const glinerMod: any = await import(pathToFileURL(glinerEntry).href);
    const Gliner = glinerMod.Gliner || glinerMod.default?.Gliner;
    if (!Gliner) throw new Error("Gliner export not found in gliner module");

    const gliner = new Gliner({
      // "." is resolved relative to env.localModelPath → modelsDir
      tokenizerPath: ".",
      onnxSettings: {
        modelPath,
      },
      maxWidth: 12,
      modelType: "span-level",
      transformersSettings: {
        allowLocalModels: true,
        useBrowserCache: false,
      },
    });

    setNerStatus("loading_model", 95, "Loading GLiNER model into ONNX runtime…");
    nerLog("[NER] calling gliner.initialize()...");
    await gliner.initialize();
    _gliner = gliner;
    setNerStatus("ready", 100, "PII Shield NER ready.");
    nerLog(`[NER] GLiNER initialized (model=${modelPath})`);
  } catch (e) {
    _initFailed = true;
    _initError = String(e);
    setNerStatus("error", _nerProgressPct, `NER init failed: ${String(e).slice(0, 200)}`);
    nerLog(`[NER] GLiNER init failed: ${e}`);
    throw e;
  }
}

/**
 * Initialize the NER backend. Call once at startup.
 * Resolves when model is loaded and ready for inference.
 */
export async function initNer(): Promise<void> {
  // Reset on previous failure to allow retry (e.g. after network issue)
  if (_initFailed) {
    _initFailed = false;
    _initError = "";
    _initPromise = null;
  }
  if (!_initPromise) {
    _initPromise = initGliner();
  }
  return _initPromise;
}

/**
 * Check if NER is available (model loaded successfully).
 */
export function isNerReady(): boolean {
  return _gliner !== null;
}

/**
 * Run NER inference on text. Returns detected entities.
 * Falls back to empty array if NER is not initialized.
 */
export async function runNer(
  text: string,
  threshold = 0.25,
): Promise<DetectedEntity[]> {
  if (!_gliner) {
    _lastInferenceError = "NER not initialized (_gliner is null)";
    return [];
  }

  _inferenceCallCount++;
  try {
    nerLog(`[NER] runNer: text.length=${text.length}, threshold=${threshold}`);
    logServer(`[NER-Inference] BEFORE _gliner.inference() text=${text.length} chars`);
    const results = await _gliner.inference({
      texts: [text],
      entities: NER_LABELS,
      flatNer: true,
      threshold,
    });
    logServer(`[NER-Inference] AFTER _gliner.inference() — returned OK`);
    nerLog(`[NER] runNer: raw results = ${JSON.stringify(results).slice(0, 200)}`);

    if (!results || results.length === 0) {
      _lastInferenceError = "";
      return [];
    }

    const entities: DetectedEntity[] = [];
    for (const entity of results[0]) {
      const mappedType = LABEL_MAP[entity.label.toLowerCase()] || entity.label.toUpperCase();
      entities.push({
        text: entity.spanText,
        type: mappedType,
        start: entity.start,
        end: entity.end,
        score: entity.score,
        verified: false,
        reason: `ner:gliner:${entity.label}`,
      });
    }

    _lastInferenceError = "";
    _inferenceTotalEntities += entities.length;
    nerLog(`[NER] runNer: returning ${entities.length} entities`);
    return entities;
  } catch (e: any) {
    _lastInferenceError = `${e?.message || e}\n${e?.stack || ""}`.slice(0, 2000);
    nerLog(`[NER] Inference error: ${_lastInferenceError}`);
    return [];
  }
}

/**
 * Run NER with automatic chunking for long texts.
 * GLiNER handles splitting into 512-word chunks internally.
 */
export async function runNerChunked(
  text: string,
  threshold = 0.25,
): Promise<DetectedEntity[]> {
  if (!_gliner) {
    _lastInferenceError = "NER not initialized (_gliner is null)";
    return [];
  }

  _inferenceCallCount++;
  try {
    nerLog(`[NER] runNerChunked: text.length=${text.length}, threshold=${threshold}`);
    const results = await _gliner.inference_with_chunking({
      texts: [text],
      entities: NER_LABELS,
      flatNer: true,
      threshold,
    });
    nerLog(`[NER] runNerChunked: got ${results?.length || 0} result groups`);

    if (!results || results.length === 0) {
      _lastInferenceError = "";
      return [];
    }

    const entities: DetectedEntity[] = [];
    for (const entity of results[0]) {
      const mappedType = LABEL_MAP[entity.label.toLowerCase()] || entity.label.toUpperCase();
      entities.push({
        text: entity.spanText,
        type: mappedType,
        start: entity.start,
        end: entity.end,
        score: entity.score,
        verified: false,
        reason: `ner:gliner:${entity.label}`,
      });
    }

    _lastInferenceError = "";
    _inferenceTotalEntities += entities.length;
    nerLog(`[NER] runNerChunked: returning ${entities.length} entities`);
    return entities;
  } catch (e: any) {
    _lastInferenceError = `chunked: ${e?.message || e}\n${e?.stack || ""}`.slice(0, 2000);
    nerLog(`[NER] Chunked inference error: ${_lastInferenceError}`);
    // Fallback: try non-chunked inference on first 8000 chars (best effort)
    try {
      nerLog(`[NER] Falling back to non-chunked inference on first 8000 chars`);
      return await runNer(text.slice(0, 8000), threshold);
    } catch {
      return [];
    }
  }
}
