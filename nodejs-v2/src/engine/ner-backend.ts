/**
 * PII Shield v2.0.0 — GLiNER NER Backend
 * Uses the `gliner` npm package (Node.js variant) with onnxruntime-node.
 * Model: knowledgator/gliner-pii-base-v1.0 (ONNX fp32, 665 MB)
 *
 * The model + tokenizer files are BUNDLED inside the .mcpb at
 * `<extension_root>/models/gliner-pii-base-v1.0/` — no runtime download.
 * See `plugin/build-plugin.mjs` for the bundling step, and the
 * `ensureModelFiles` function below for resolution.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire as _createRequire } from "node:module";
import nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { DetectedEntity } from "./pattern-recognizers.js";
import { PATHS } from "../utils/config.js";
import { logServer } from "../audit/audit-logger.js";
import { updateBeaconNer } from "../sidecar/bootstrap-beacon.js";

function getDepsDir(): string {
  return PATHS.DEPS_DIR;
}

/**
 * Install a CJS Module._load interceptor that returns a no-op shim for any
 * `require('sharp')` call. `sharp` is unused by our text-only NER pipeline,
 * but @xenova/transformers pulls it in transitively. On hosts without libvips
 * or missing the prebuilt native addon for the current platform/arch, the
 * real sharp fails to load and takes down the entire NER init with it. The
 * shim neutralises that failure mode — transformers' image-pipeline code
 * never runs in our flow, so no-oping image methods is safe.
 *
 * The shim implements only the surface area that transformers needs to
 * import without throwing — the chainable image builder and a few static
 * helpers.
 *
 * Idempotent — safe to call more than once (install checks a module-level
 * flag). Non-sharp requires pass through unchanged.
 */
let _sharpShimInstalled = false;
function installSharpShim(): void {
  if (_sharpShimInstalled) return;
  const M: any = nodeModule as any;
  if (!M || typeof M._load !== "function") {
    nerLog("[NER] sharp shim: Module._load not available, skipping shim install");
    return;
  }
  const originalLoad = M._load;

  function makeChain(): any {
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === "then") return undefined; // Not a thenable — don't confuse await
        if (prop === Symbol.toPrimitive) return () => "[sharp-shim]";
        if (prop === "metadata") return async () => ({});
        if (prop === "toBuffer") return async () => Buffer.alloc(0);
        if (prop === "toFile") return async () => ({});
        // Any other property is assumed to be a chainable method.
        return (..._args: unknown[]) => chain;
      },
      apply() { return chain; },
    };
    const chain: any = new Proxy(function sharpInstance() { return chain; }, handler);
    return chain;
  }

  const shim: any = function sharpShim(..._args: unknown[]) { return makeChain(); };
  shim.cache = (_opts?: unknown) => shim;
  shim.concurrency = (_n?: number) => 1;
  shim.simd = (_enable?: boolean) => false;
  shim.versions = { vips: "0.0.0-shim" };
  shim.format = {};
  shim.interpolators = {};
  shim.kernel = {};
  shim.fit = {};
  shim.gravity = {};
  shim.default = shim;
  shim.__esModule = true;

  M._load = function patchedLoad(request: string, parent: any, isMain: boolean): any {
    if (request === "sharp") {
      return shim;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  _sharpShimInstalled = true;
  nerLog("[NER] sharp shim installed (transformers will use no-op image API)");
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
  company: "ORGANIZATION",
  "law firm": "ORGANIZATION",
  bank: "ORGANIZATION",
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
  // Extended-set additions (PII_NER_LABEL_SET=extended)
  "government agency": "ORGANIZATION",
  "court": "ORGANIZATION",
  "educational institution": "ORGANIZATION",
  city: "LOCATION",
  country: "LOCATION",
  "state or province": "LOCATION",
  nationality: "NRP",
  religion: "NRP",
  "job title": "PERSON",           // propagation stop — captured as person-context
  "medical condition": "MEDICAL_LICENSE", // repurpose slot
  date: "DATE_TIME",
  product: "ORGANIZATION",          // product names often map to brand/org
  event: "LOCATION",                // events carry location context
};

// Entity labels for GLiNER — focused on named entities that regex can't detect.
// Pattern recognizers handle structured PII (email, phone, SSN, etc.) much better.
// Fewer labels = higher quality NER results (less attention dilution).
const NER_LABELS_COMPACT = [
  "person",
  "organization",
  "company",
  "law firm",
  "bank",
  "location",
  "political group",
  "address",
  "date of birth",
];

// Extended (enriched) label set — more granular entity types for comparison.
// Trade-off: higher recall on specific types (city vs. location, court vs. org)
// but risk of attention dilution + label competition. Enable with
// `PII_NER_LABEL_SET=extended`.
const NER_LABELS_EXTENDED = [
  "person",
  "organization",
  "company",
  "law firm",
  "bank",
  "government agency",
  "court",
  "educational institution",
  "location",
  "address",
  "city",
  "country",
  "state or province",
  "political group",
  "nationality",
  "religion",
  "job title",
  "medical condition",
  "date of birth",
  "date",
  "product",
  "event",
];

// Tuned (12 labels) — compact + granular ORG sublabels without full extended dilution.
const NER_LABELS_TUNED = [
  "person",
  "organization",
  "company",
  "law firm",
  "bank",
  "government agency",
  "court",
  "educational institution",
  "location",
  "address",
  "political group",
  "date of birth",
];

const _labelSet = (process.env.PII_NER_LABEL_SET || "").toLowerCase();
const NER_LABELS: string[] =
  _labelSet === "extended" ? NER_LABELS_EXTENDED :
  _labelSet === "tuned" ? NER_LABELS_TUNED :
  NER_LABELS_COMPACT;

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
  | "loading_model"
  | "ready"
  | "error";
let _nerPhase: NerPhase = "idle";
let _nerProgressPct = 0;
let _nerMessage = "";

/**
 * Structured diagnostic for a failed NER init. Produced by `enrichNerError`
 * when `initGliner` catches a native-load failure (LoadLibraryExW on Windows,
 * dlopen on macOS/Linux). Surfaced to Claude via `list_entities` so the skill
 * can print actionable recovery steps instead of a bare `%1` / `image not found`.
 */
export interface NerErrorDiagnostic {
  kind: "native_load_failed";
  platform: NodeJS.Platform;
  arch: string;
  node_version: string;
  os_release: string;
  binding_path: string;
  binding_exists: boolean;
  binding_size: number;
  siblings_present: string[];
  siblings_missing: string[];
  likely_cause:
    | "windows_dll_dep_missing"
    | "vcruntime_redist_missing"
    | "arch_mismatch"
    | "darwin_dep_missing"
    | "linux_dep_missing"
    | "model_download_rename"
    | "unknown";
  suggested_actions: string[];
  raw_error: string;
}

let _initDiagnostic: NerErrorDiagnostic | null = null;

/**
 * Classify a native-load failure during `initGliner` into a structured
 * diagnostic with platform-specific recovery steps. Non-fatal — if the error
 * doesn't look like a native-load failure we still return a best-effort
 * diagnostic with `likely_cause: "unknown"` so the caller gets consistent
 * shape.
 */
function enrichNerError(e: unknown): Error & { diagnostic: NerErrorDiagnostic } {
  const err = e instanceof Error ? e : new Error(String(e));
  const msg = err.message || "";

  const platform = process.platform;
  const arch = process.arch;
  const depsDir = getDepsDir();
  const bindingDir = path.join(
    depsDir, "node_modules", "onnxruntime-node", "bin", "napi-v6",
    platform, arch,
  );
  const bindingFile =
    platform === "win32" ? "onnxruntime_binding.node"
    : "onnxruntime_binding.node";
  const bindingPath = path.join(bindingDir, bindingFile);

  let bindingExists = false;
  let bindingSize = 0;
  try {
    const st = fs.statSync(bindingPath);
    bindingExists = st.isFile();
    bindingSize = st.size;
  } catch { /* bindingExists stays false */ }

  // Expected native siblings alongside the .node file. These are what
  // LoadLibraryExW / dlopen actually need to resolve the transitive imports.
  const expectedSiblings =
    platform === "win32"
      ? ["onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"]
      : platform === "darwin"
        ? ["libonnxruntime.dylib"]
        : ["libonnxruntime.so"];

  const siblingsPresent: string[] = [];
  const siblingsMissing: string[] = [];
  for (const sib of expectedSiblings) {
    const sibPath = path.join(bindingDir, sib);
    try {
      if (fs.statSync(sibPath).isFile()) siblingsPresent.push(sib);
      else siblingsMissing.push(sib);
    } catch {
      siblingsMissing.push(sib);
    }
  }

  let likelyCause: NerErrorDiagnostic["likely_cause"] = "unknown";
  const suggestedActions: string[] = [];

  // Model-download rename / ENOENT branch — distinct from native-load failures.
  // Symptom: "Failed to download model: ... ENOENT: no such file or directory, rename '...tmp' -> '...onnx'"
  // Root cause on Windows is almost always antivirus (Defender / SmartScreen)
  // quarantining the freshly-downloaded .tmp file before we can rename it.
  // We already retry with backoff in downloadFile, but if even that exhausts,
  // the user needs to add the model cache dir to AV exclusions.
  if (/Failed to download model|ENOENT.*rename|rename failed after retries/i.test(msg)) {
    likelyCause = "model_download_rename";
    if (platform === "win32") {
      const modelsDir = path.join(path.dirname(depsDir), "models");
      suggestedActions.push(
        `Add the PII Shield model cache directory to your antivirus exclusions: **${modelsDir}** — Windows Defender / SmartScreen is quarantining the freshly-downloaded ONNX model mid-rename.`,
        `How: Settings → Windows Security → Virus & threat protection → Manage settings → Exclusions → Add an exclusion → Folder → pick \`${modelsDir}\`.`,
        `After adding the exclusion, delete any leftover \`*.tmp\` files in that folder and call list_entities again — the retry download will succeed without interference.`,
        "If antivirus exclusion is not an option: try running the server process from an elevated / admin shell, or temporarily pause real-time protection during the 2–5 minute first-run download.",
      );
    } else {
      suggestedActions.push(
        `The downloaded model file could not be renamed from its .tmp location. Check that \`${path.dirname(depsDir)}/models/\` is writable and has enough free disk space (~700 MB).`,
        `Delete any leftover *.tmp files in that folder and call list_entities again.`,
      );
    }
  } else if (platform === "win32") {
    if (!bindingExists) {
      likelyCause = "arch_mismatch";
      suggestedActions.push(
        `onnxruntime-node is missing the prebuild for ${platform}/${arch}. Check that your Node.js build matches your system architecture (x64 vs ARM64).`,
        "If on Windows ARM64: install the native ARM64 Node.js build from https://nodejs.org/en/download instead of the x64 build, then remove " + depsDir + "\\node_modules and call list_entities again.",
      );
    } else if (/%1\b|ERROR_BAD_EXE_FORMAT|could not be loaded|procedure could not be located|Module could not be found/i.test(msg)) {
      likelyCause = "windows_dll_dep_missing";
      if (siblingsMissing.length > 0) {
        suggestedActions.push(
          `The onnxruntime-node install is missing sibling DLL(s): ${siblingsMissing.join(", ")}. Delete ${depsDir}\\node_modules and call list_entities again — the npm install likely failed partway through.`,
        );
      } else {
        // Binding + all siblings present. In v2.0.0 the most frequent cause
        // was a double-dlopen from transformers ESM + gliner CJS racing each
        // other — patched via the CJS pre-load at the top of initGliner. If
        // we're still here, it's probably deps corruption or a genuine
        // OS-level dependency miss.
        suggestedActions.push(
          `Delete ${depsDir}\\node_modules and call list_entities again — this forces a clean reinstall and resolves most "%1" errors in practice.`,
          "Restart Claude (or the host process) after deleting deps, so Node's native-module cache is flushed.",
          "If the error still persists, check Windows Defender / SmartScreen hasn't blocked the downloaded onnxruntime_binding.node — the file path is in ner_error_diagnostic.binding_path above.",
          "As a last resort, install or repair Visual C++ Redistributable 2015-2022 (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe. This is rarely the actual cause on modern Windows 10/11 — VC++ is typically already present — but a corrupt install can surface this error.",
        );
      }
    }
  } else if (platform === "darwin") {
    if (!bindingExists) {
      likelyCause = "arch_mismatch";
      suggestedActions.push(
        `onnxruntime-node is missing the prebuild for ${platform}/${arch}. On Apple Silicon (M1/M2/M3) install the arm64 Node.js build; on Intel Macs install the x64 build.`,
        `Then remove ${depsDir}/node_modules and call list_entities again.`,
      );
    } else if (/image not found|library not loaded|Symbol not found|dlopen/i.test(msg)) {
      likelyCause = "darwin_dep_missing";
      suggestedActions.push(
        "Run `xcode-select --install` in Terminal to install the Xcode Command Line Tools (provides libSystem / dyld).",
        `Then delete ${depsDir}/node_modules and call list_entities again to trigger a clean reinstall.`,
        "If the error persists, try Node.js 22 LTS.",
      );
    }
  } else {
    // linux / others
    if (!bindingExists) {
      likelyCause = "arch_mismatch";
      suggestedActions.push(
        `onnxruntime-node is missing the prebuild for ${platform}/${arch}. Check that your Node.js arch matches your system (x64 vs arm64) and retry.`,
      );
    } else if (/cannot open shared object|undefined symbol|GLIBC/i.test(msg)) {
      likelyCause = "linux_dep_missing";
      suggestedActions.push(
        "A shared library needed by onnxruntime-node is missing or too old (common causes: glibc < 2.28, or missing libstdc++). Update your distribution or try a Node.js build that matches your system glibc.",
      );
    }
  }

  if (suggestedActions.length === 0) {
    const firstLine = msg.split("\n")[0].slice(0, 300);
    suggestedActions.push(
      `Raw error: ${firstLine}`,
      `Try deleting ${depsDir}${path.sep}node_modules and calling list_entities again to force a clean reinstall.`,
    );
  }

  const diagnostic: NerErrorDiagnostic = {
    kind: "native_load_failed",
    platform,
    arch,
    node_version: process.versions.node,
    os_release: os.release(),
    binding_path: bindingPath,
    binding_exists: bindingExists,
    binding_size: bindingSize,
    siblings_present: siblingsPresent,
    siblings_missing: siblingsMissing,
    likely_cause: likelyCause,
    suggested_actions: suggestedActions,
    raw_error: msg,
  };

  (err as Error & { diagnostic: NerErrorDiagnostic }).diagnostic = diagnostic;
  return err as Error & { diagnostic: NerErrorDiagnostic };
}

function setNerStatus(phase: NerPhase, pct: number, message: string): void {
  _nerPhase = phase;
  _nerProgressPct = Math.max(0, Math.min(100, Math.round(pct)));
  _nerMessage = message;
  nerLog(`[NER] status → ${phase} ${_nerProgressPct}% — ${message}`);
  // Mirror into the on-disk beacon so a bash reader sees fresh NER phase
  // without needing MCP tools or the HTTP sidecar to be reachable.
  updateBeaconNer({
    phase,
    progress_pct: _nerProgressPct,
    ready: _gliner !== null && phase === "ready",
    error: phase === "error" ? message : null,
  });
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

// Model + tokenizer file names — bundled inside the .mcpb at
// `<extension_root>/models/<MODEL_SLUG>/`. See plugin/build-plugin.mjs for the
// bundling step and the rationale for why we ship the model pre-extracted
// rather than downloading at runtime.
//
// Why gliner-pii-base/fp32 (665 MB) — every other variant is broken on our stack:
// - base/fp16 (333 MB): onnxruntime-node CPU EP doesn't support fp16 reliably —
//   loads with "Type Error: tensor(float16) ... expected tensor(float)" because
//   the CPU provider doesn't implement most fp16 operators.
// - base/quint8 (197 MB): empirically returns 0 entities even at threshold 0.25.
// - small/fp32 (327 MB): uses jhu-clsp/ettin-encoder-68m with a BPE tokenizer
//   that @xenova/transformers AutoTokenizer can't parse.
// fp32/665 MB is the only execution-stable option, hence it's the variant we
// bundle.
const MODEL_SLUG = "gliner-pii-base-v1.0";
const TOKENIZER_FILES = [
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "gliner_config.json",
] as const;

/** Minimum byte size for an assembled model.onnx to be considered intact. */
const MODEL_MIN_SIZE_BYTES = 600 * 1024 * 1024;

/**
 * Resolve the model + tokenizer paths from the bundled extension directory.
 *
 * The `.mcpb` ships with:
 *   - `models/<MODEL_SLUG>/model.onnx.part-aa`  (500 MB)
 *   - `models/<MODEL_SLUG>/model.onnx.part-ab`  (~134 MB)
 *   - `models/<MODEL_SLUG>/{tokenizer.json, tokenizer_config.json, ...}`
 *
 * The model is SPLIT into two parts at build time because Claude Desktop
 * enforces a 512 MB per-inner-file limit inside .mcpb archives, and the full
 * 634 MB fp32 ONNX exceeds that. On first startup we concat the parts back
 * into `model.onnx` in the same bundle dir and use it for all subsequent runs.
 *
 * Concurrent-instance handling: Claude Desktop may spawn multiple server
 * processes (anthropics/claude-code#28126). All of them check the assembled
 * `model.onnx` first. If it exists with expected size, all use it (Windows
 * shared-read is safe). If missing, each process concats to its own
 * `model.onnx.<pid>.tmp` (process-unique name → no truncate race), then
 * `fs.renameSync` atomically replaces the final path on Windows. Last rename
 * wins; all produce byte-identical output, so concurrent work is wasteful
 * (~5 sec per process) but never produces a corrupt file. No lock, no stale
 * detection, no deadlock.
 *
 * Input files are read-only inside the extension dir — there is no race on
 * READING them, only on WRITING the assembled output.
 */
async function ensureModelFiles(): Promise<{ modelPath: string; tokenizerDir: string }> {
  const bundleRoot = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.join(bundleRoot, "models", MODEL_SLUG);
  const modelPath = path.join(bundledDir, "model.onnx");
  const partA = path.join(bundledDir, "model.onnx.part-aa");
  const partB = path.join(bundledDir, "model.onnx.part-ab");

  // Verify tokenizer presence (cheap fail-fast).
  for (const f of TOKENIZER_FILES) {
    const tokFile = path.join(bundledDir, f);
    if (!fs.existsSync(tokFile)) {
      throw new Error(
        `Bundled tokenizer file '${f}' missing at ${tokFile}. ` +
        `Please reinstall the PII Shield extension.`,
      );
    }
  }

  // Fast path: assembled model already present and intact.
  try {
    const size = fs.statSync(modelPath).size;
    if (size >= MODEL_MIN_SIZE_BYTES) {
      nerLog(`[NER] Using assembled model at ${modelPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      return { modelPath, tokenizerDir: bundledDir };
    }
    nerLog(`[NER] Existing model.onnx is only ${size} bytes (< ${MODEL_MIN_SIZE_BYTES}) — re-assembling`);
    try { fs.unlinkSync(modelPath); } catch { /* best effort */ }
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    // ENOENT — first run, proceed to assembly
  }

  // Cold path: concat parts → model.onnx. Parts MUST be present in a healthy bundle.
  if (!fs.existsSync(partA) || !fs.existsSync(partB)) {
    throw new Error(
      `Bundled model parts missing: expected ${partA} + ${partB}. ` +
      `This indicates a corrupted .mcpb install. Please reinstall the PII Shield extension.`,
    );
  }

  nerLog(`[NER] Assembling model from part-aa + part-ab…`);
  setNerStatus("loading_model", 5, "Preparing GLiNER model (one-time assembly from bundle)…");

  // Write to process-specific tmp so concurrent instances don't collide.
  const tmpPath = `${modelPath}.${process.pid}.tmp`;
  const CHUNK = 1 * 1024 * 1024; // 1 MB read/write chunks
  const buf = Buffer.alloc(CHUNK);
  try {
    const dstFd = fs.openSync(tmpPath, "w");
    try {
      for (const partPath of [partA, partB]) {
        const srcFd = fs.openSync(partPath, "r");
        try {
          let bytesRead: number;
          while ((bytesRead = fs.readSync(srcFd, buf, 0, CHUNK, null)) > 0) {
            fs.writeSync(dstFd, buf, 0, bytesRead);
          }
        } finally {
          fs.closeSync(srcFd);
        }
      }
      try { fs.fsyncSync(dstFd); } catch { /* non-fatal on some FS */ }
    } finally {
      fs.closeSync(dstFd);
    }

    // Atomic rename to final. On Windows, renameSync replaces an existing
    // destination unless it's open. If we lose the race to a peer, we just
    // use theirs (byte-identical content).
    try {
      fs.renameSync(tmpPath, modelPath);
    } catch (e: any) {
      try { fs.unlinkSync(tmpPath); } catch { /* */ }
      if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < MODEL_MIN_SIZE_BYTES) {
        throw new Error(`Failed to finalize assembled model: ${e.message || e}`);
      }
      nerLog(`[NER] Rename race lost; using peer's assembled model at ${modelPath}`);
    }
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* */ }
    throw e;
  }

  const finalSize = fs.statSync(modelPath).size;
  nerLog(`[NER] Assembled model ready at ${modelPath} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`);
  return { modelPath, tokenizerDir: bundledDir };
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
// Bumped from 1.19.2 → 1.22.0 to support Node v24 on Windows.
//
// onnxruntime-node 1.19.2 (Sep 2024) predates Node v24 (Oct 2024 current,
// LTS Apr 2025). Its prebuild in bin/napi-v3/win32/x64/onnxruntime_binding.node
// uses V8-internal APIs that were reorganised in v24 — LoadLibraryExW returns
// ERROR_BAD_EXE_FORMAT ("The operating system cannot run %1") when Node v24
// tries to load it. 1.22.x ships napi-v6 prebuilds with verified Node 22/24
// support on Windows.
//
// The historical concern against 1.20+ was a postinstall script that downloads
// the ~600 MB CUDA GPU runtime. That's irrelevant at our install flags:
// `--ignore-scripts` blocks the postinstall entirely, and
// `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` belt-and-suspenders the env. CPU-only
// inference path is unaffected.
//
// onnxruntime-common is a "ghost dependency" of @xenova/transformers
// (huggingface/transformers.js#1087) — pin it explicitly to match.
const NER_DEPS_PINS = {
  "onnxruntime-node": "1.22.0",
  "onnxruntime-common": "1.22.0",
  "@xenova/transformers": "2.17.2",
  "gliner": "0.0.19",
} as const;

/**
 * Stamp identifying the current dep-pin set. When this changes across plugin
 * versions, the on-disk `deps/node_modules` is from the previous pin set and
 * may be ABI-incompatible with the new runtime (exactly what bit us bumping
 * onnxruntime-node from 1.19.2 → 1.22.0). Write it to `deps/.pii_shield_pins`
 * after a successful install; re-read it on startup and nuke `node_modules`
 * if it disagrees.
 */
const NER_DEPS_STAMP = Object.entries(NER_DEPS_PINS)
  .map(([k, v]) => `${k}@${v}`)
  .sort()
  .join(",");

async function ensureNerDeps(): Promise<string> {
  const depsDir = getDepsDir();
  const nmDir = path.join(depsDir, "node_modules");
  const stampPath = path.join(depsDir, ".pii_shield_pins");

  // Stamp check: if the existing install was built against a different pin
  // set, force a fresh install. Protects against subtle ABI mismatches when
  // we bump a native dep (onnxruntime-node, sharp, etc.) across plugin
  // versions — the user's on-disk deps/ doesn't auto-update otherwise.
  let stampMatches = false;
  try {
    if (fs.existsSync(stampPath)) {
      const existing = fs.readFileSync(stampPath, "utf-8").trim();
      stampMatches = existing === NER_DEPS_STAMP;
      if (!stampMatches) {
        nerLog(`[NER] deps stamp mismatch — got "${existing}", expected "${NER_DEPS_STAMP}". Wiping deps/node_modules.`);
      }
    }
  } catch (e) {
    nerLog(`[NER] stamp read failed (${e}) — assuming stale`);
  }

  // All four packages must exist AND stamp must match; partial installs or
  // pin-set drift both trigger a reinstall.
  const allInstalled = NER_DEP_PACKAGES.every((pkgName) =>
    fs.existsSync(path.join(nmDir, ...pkgName.split("/"), "package.json")),
  );
  if (allInstalled && stampMatches) return depsDir;

  // Stamp drift → wipe existing node_modules so npm can install cleanly
  // (skipping this risks mixing old + new ABI binaries).
  if (!stampMatches && fs.existsSync(nmDir)) {
    try {
      fs.rmSync(nmDir, { recursive: true, force: true });
      nerLog(`[NER] wiped stale ${nmDir}`);
    } catch (e) {
      nerLog(`[NER] deps wipe failed (${e}) — continuing, npm may reconcile`);
    }
  }

  setNerStatus(
    "installing_deps",
    5,
    "Installing onnxruntime-node, @xenova/transformers, gliner into ${CLAUDE_PLUGIN_DATA}/deps (first run only, ~1–2 min)…",
  );
  nerLog(`[NER] Installing NER dependencies in ${depsDir}... (pins: ${NER_DEPS_STAMP})`);
  fs.mkdirSync(depsDir, { recursive: true });

  const pkg = {
    name: "pii-shield-deps",
    version: "1.0.0",
    dependencies: { ...NER_DEPS_PINS },
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
        // Run postinstall scripts — this is what downloads sharp's
        // prebuild (`node_modules/sharp/build/Release/sharp-<platform>-<arch>.node`
        // + `node_modules/sharp/vendor/<ver>/<platform>-<arch>/lib/libvips-*.dll`
        // on Windows, matching dylibs on macOS, .so on Linux). Without these,
        // `@xenova/transformers` → `sharp/lib/sharp.js:9` crashes at runtime
        // with "Cannot find module '../build/Release/sharp-win32-x64.node'" —
        // `installSharpShim()` below hooks `Module._load` but doesn't catch
        // sharp's internal requires, so real install is the only robust fix.
        // See `nodejs/src/local-app/{preload.ts,local-ner.ts}` for the
        // proven reference: same deps, no `--ignore-scripts`, sharp works.
        //
        // CUDA-download protection still in place: `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`
        // env below is the documented way to tell onnxruntime-node's postinstall
        // NOT to fetch the ~600 MB CUDA provider tarball. It was the original
        // reason --ignore-scripts was added; env-level opt-out is cleaner.
        //
        // Do NOT add `--omit=optional`. @xenova/transformers has
        // `optionalDependencies: { "onnxruntime-node": "1.14.0" }`, and
        // transformers/src/backends/onnx.js does a bare `import 'onnxruntime-node'`
        // hard-coded against the 1.14.0 layout (entry at <pkg>/index.js).
        // Skipping optional deps lets the bare-import resolve up to our top-level
        // pin (entry at <pkg>/dist/index.js) and crash with
        // "Cannot find package .../onnxruntime-node/index.js".
        //
        // `--legacy-peer-deps` is REQUIRED because gliner@0.0.19 declares a
        // strict peer `onnxruntime-node@1.19.2`, and our top-level pin is now
        // 1.22.0 (needed for Node v24 Windows prebuilds). npm 10 treats peer
        // conflicts as fatal ERESOLVE by default. The runtime API surface
        // gliner exercises (InferenceSession, Tensor) is stable across 1.x —
        // the peer is cosmetic; `--legacy-peer-deps` downgrades it to a
        // warning and lets our pin win. This is npm's own suggested remedy
        // in the ERESOLVE output.
        ["install", "--production", "--no-audit", "--no-fund", "--legacy-peer-deps"],
        {
          cwd: depsDir,
          timeout: 600000, // 10 min — 4 packages + sharp prebuild (~30 MB libvips) + onnxruntime-node (~80 MB)
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
    // Post-install platform/arch validation. npm's internal platform detection
    // can select the wrong prebuild in edge cases (Windows ARM64 running Node
    // x64 in emulation; os.arch() vs process.arch disagreement; partial npm
    // extract failures). Catching that here gives a concrete error instead of
    // a later `%1` / `image not found` at LoadLibrary time.
    const napiRoot = path.join(nmDir, "onnxruntime-node", "bin", "napi-v6");
    const expectedBinary = path.join(
      napiRoot, process.platform, process.arch, "onnxruntime_binding.node",
    );
    if (!fs.existsSync(expectedBinary)) {
      let availablePlatforms: string[] = [];
      try {
        availablePlatforms = fs.readdirSync(napiRoot);
      } catch { /* napiRoot itself may be missing */ }
      nerLog(
        `[NER] install succeeded but expected binary missing: ${expectedBinary}; ` +
        `available platforms in install: ${availablePlatforms.join(", ") || "<none>"}`,
      );
      throw new Error(
        `onnxruntime-node install is missing the platform binary for ${process.platform}/${process.arch}. ` +
        `This typically means npm detected your system as a different arch (e.g. ARM64 vs x64) and skipped the prebuild. ` +
        `Expected: ${expectedBinary}. Available platforms: ${availablePlatforms.join(", ") || "<none>"}.`,
      );
    }

    // Write stamp AFTER npm install succeeds AND validation passed. Next
    // startup reads this back in ensureNerDeps() and nukes node_modules if
    // the plugin bumped pins.
    try {
      fs.writeFileSync(stampPath, NER_DEPS_STAMP, "utf-8");
    } catch (e) {
      nerLog(`[NER] stamp write failed (${e}) — install will be treated as stale on next boot`);
    }
    setNerStatus("installing_deps", 9, "NER dependencies installed.");
    nerLog(`[NER] ✓ NER dependencies installed (pins: ${NER_DEPS_STAMP})`);
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

    // Neutralise `sharp` BEFORE transformers loads. @xenova/transformers pulls
    // sharp in transitively but only invokes image methods for image pipelines,
    // which our text-only NER never hits. The shim intercepts `require('sharp')`
    // and returns a no-op Proxy so the real native addon is never loaded — safe
    // on hosts without libvips or a matching prebuild.
    installSharpShim();

    // Resolve transformers / gliner from the deps dir explicitly via createRequire,
    // bypassing NODE_PATH which is unreliable in ESM contexts. createRequire
    // anchored at <depsDir>/package.json walks <depsDir>/node_modules/ as if a
    // file in depsDir was doing the require.
    const requireFromDeps = _createRequire(path.join(depsDir, "package.json"));

    // CRITICAL: pre-load `onnxruntime-node` via CJS `require()` BEFORE we touch
    // `@xenova/transformers` or `gliner`. Rationale: transformers' ESM entry
    // (`src/backends/onnx.js:21`) statically imports onnxruntime-node through
    // its ESM graph. When we then CJS-require it again from gliner's CJS node
    // entry (`gliner/dist/node/index.cjs:4`), Node's ESM/CJS dual-loading
    // tries to dlopen the `.node` binding a second time in the same process
    // — and on Windows that second LoadLibrary call fails with
    // `ERROR_BAD_EXE_FORMAT` ("The operating system cannot run %1"), even
    // though the first load succeeded and the DLL is perfectly valid. By
    // CJS-require'ing onnxruntime-node FIRST, we populate Node's CJS module
    // cache; all subsequent imports (both ESM-synth and nested CJS) hit the
    // cache and never attempt a second dlopen.
    nerLog("[NER] pre-loading onnxruntime-node via CJS (load-order fix)...");
    try {
      requireFromDeps("onnxruntime-node");
      nerLog("[NER] onnxruntime-node pre-loaded OK");
    } catch (e) {
      nerLog(`[NER] onnxruntime-node pre-load failed: ${e}`);
      throw e;
    }

    // Belt-and-suspenders: pre-require @xenova/transformers in the CJS cache
    // and configure its env object BEFORE the ESM `await import(...)` below
    // runs. Pattern copied from `nodejs/src/local-app/preload.ts:47-60`, the
    // proven reference setup. Rationale: on Node v24 there are corner cases
    // where the ESM-dynamic-import of a CJS package creates a separate module
    // instance from a later CJS `require()` inside gliner/node.cjs — leaving
    // gliner with a fresh `transformers.env` missing `localModelPath`. Pre-
    // populating the CJS cache ensures both code paths see the same singleton
    // with the env already configured.
    nerLog("[NER] pre-loading @xenova/transformers via CJS (cache-warming)...");
    try {
      const transformersCjs: any = requireFromDeps("@xenova/transformers");
      if (transformersCjs && transformersCjs.env) {
        transformersCjs.env.localModelPath = tokenizerDir;
        transformersCjs.env.allowLocalModels = true;
        transformersCjs.env.useBrowserCache = false;
        transformersCjs.env.allowRemoteModels = false;
        nerLog("[NER] transformers pre-loaded + env configured");
      } else {
        nerLog("[NER] transformers pre-load returned no .env (non-fatal, ESM path will handle it)");
      }
    } catch (e) {
      // Non-fatal — the ESM path below still works, this is just a warm-up.
      nerLog(`[NER] transformers CJS pre-load failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }

    nerLog("[NER] resolving @xenova/transformers from deps (ESM)...");
    const transformersEntry = requireFromDeps.resolve("@xenova/transformers");
    const transformers: any = await import(pathToFileURL(transformersEntry).href);
    const env = transformers.env;
    // Tokenizer files live in the sidecar dir; modelPath is loaded explicitly
    // by gliner from its absolute path. If the CJS pre-load above already set
    // these on the shared module, this is a no-op re-assignment to the same
    // values — safe and idempotent.
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
    const enriched = enrichNerError(e);
    _initDiagnostic = enriched.diagnostic;
    setNerStatus("error", _nerProgressPct, `NER init failed: ${String(e).slice(0, 200)}`);
    nerLog(`[NER] GLiNER init failed: ${e}`);
    nerLog(
      `[NER] diagnostic: likely_cause=${enriched.diagnostic.likely_cause}, ` +
      `binding_exists=${enriched.diagnostic.binding_exists}, ` +
      `binding_size=${enriched.diagnostic.binding_size}, ` +
      `siblings_missing=[${enriched.diagnostic.siblings_missing.join(",")}]`,
    );
    throw enriched;
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
    _initDiagnostic = null;
    _initPromise = null;
  }
  if (!_initPromise) {
    _initPromise = initGliner();
  }
  return _initPromise;
}

/** Structured diagnostic for the most recent NER init failure, or null. */
export function getNerDiagnostic(): NerErrorDiagnostic | null {
  return _initDiagnostic;
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
