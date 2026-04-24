/**
 * PII Shield v2.0.2 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â GLiNER NER Backend
 * Uses the `gliner` npm package (Node.js variant) with onnxruntime-node.
 * Model: knowledgator/gliner-pii-base-v1.0 (ONNX fp32, ~634 MB)
 *
 * The model is **not** bundled in the .mcpb (keeps the plugin <2 MB for fast
 * install). End users run `scripts/install-model.ps1` (Windows) or
 * `scripts/install-model.sh` (macOS/Linux) before installing the .mcpb ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â these
 * scripts pull `gliner-pii-base-v1.0.zip` from the PII Shield GitHub
 * release and unpack it into `~/.pii_shield/models/gliner-pii-base-v1.0/`.
 * See `ensureModelFiles` below for the runtime
 * auto-BFS that finds the model across several common locations, and the
 * `NEEDS_SETUP` envelope in `src/index.ts:handleListEntities` for the
 * user-facing error path when the model isn't in place.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire as _createRequire } from "node:module";
import nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { DetectedEntity } from "./pattern-recognizers.js";
import NER_DEPS_LOCKFILE_TEMPLATE from "./ner-deps-lockfile.json";
import { PATHS } from "../utils/config.js";
import { logServer } from "../audit/audit-logger.js";
import { updateBeaconNer } from "../sidecar/bootstrap-beacon.js";

function getDepsDir(): string {
  return path.join(getDepsInstallsDir(), getDepsInstallSlug());
}

function getDepsBaseDir(): string {
  return PATHS.DEPS_DIR;
}

function getDepsInstallsDir(): string {
  return path.join(getDepsBaseDir(), "installs");
}

function getDepsStagingRoot(): string {
  return path.join(getDepsBaseDir(), "staging");
}

function getDepsInstallSlug(): string {
  const hash = crypto.createHash("sha256").update(NER_DEPS_STAMP).digest("hex").slice(0, 12);
  const label = `ort-${NER_DEPS_PINS["onnxruntime-node"]}-web-${NER_DEPS_PINS["onnxruntime-web"]}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .toLowerCase();
  return `${label}-${hash}`;
}

function getDepsStageDir(): string {
  return path.join(
    getDepsStagingRoot(),
    `${getDepsInstallSlug()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

function getDepsNodeModulesDir(depsDir = getDepsDir()): string {
  return path.join(depsDir, "node_modules");
}

function getDepsStampPath(depsDir = getDepsDir()): string {
  return path.join(depsDir, ".pii_shield_pins");
}

function getDepsPackageJsonPath(depsDir = getDepsDir()): string {
  return path.join(depsDir, "package.json");
}

// Shared guard for the deps-aware sharp Module._load interceptor below.
let _sharpShimInstalled = false;

let _sharpShimInterceptCount = 0;
let _sharpDepsShim: any = null;
const _sharpShimEntries = new Set<string>();
const _sharpShimRoots = new Set<string>();

function normalizeModuleRequestForMatch(request: string): string {
  let normalized = request;
  if (path.isAbsolute(request)) {
    normalized = path.resolve(request);
  }
  normalized = normalized.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function getSharpDepsShim(): any {
  if (_sharpDepsShim) return _sharpDepsShim;

  function makeChain(): any {
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive) return () => "[sharp-shim]";
        if (prop === "metadata") return async () => ({});
        if (prop === "toBuffer") return async () => Buffer.alloc(0);
        if (prop === "toFile") return async () => ({});
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
  _sharpDepsShim = shim;
  return shim;
}

function registerSharpShimTargets(requireFromDeps: ReturnType<typeof _createRequire>): void {
  try {
    const sharpEntry = requireFromDeps.resolve("sharp");
    const sharpRoot = path.dirname(path.dirname(sharpEntry));
    const entryKey = normalizeModuleRequestForMatch(sharpEntry);
    const rootKey = normalizeModuleRequestForMatch(sharpRoot);
    const alreadyKnown = _sharpShimEntries.has(entryKey) && _sharpShimRoots.has(rootKey);
    _sharpShimEntries.add(entryKey);
    _sharpShimRoots.add(rootKey);
    nerLog(
      `[NER] sharp shim registered entry=${sharpEntry} root=${sharpRoot}` +
      (alreadyKnown ? " (already known)" : ""),
    );
  } catch (e) {
    nerLog(
      "[NER] sharp shim could not resolve sharp from deps (bare-name fallback only): " +
      (e instanceof Error ? e.message : String(e)),
    );
  }
}

function shouldInterceptSharpRequest(request: string, parent: any): boolean {
  if (request === "sharp") return true;

  const requestKey = normalizeModuleRequestForMatch(request);
  if (_sharpShimEntries.has(requestKey)) return true;

  for (const rootKey of _sharpShimRoots) {
    if (requestKey === rootKey || requestKey.startsWith(`${rootKey}/`)) {
      return true;
    }

    const parentId =
      typeof parent?.filename === "string" ? parent.filename :
      typeof parent?.id === "string" ? parent.id :
      "";
    if (!parentId) continue;
    const parentKey = normalizeModuleRequestForMatch(parentId);
    if (parentKey === rootKey || parentKey.startsWith(`${rootKey}/`)) {
      if (request.startsWith(".") || requestKey.startsWith(`${rootKey}/`)) {
        return true;
      }
    }
  }

  return false;
}

function installSharpShimForDeps(requireFromDeps: ReturnType<typeof _createRequire>): void {
  const M: any = nodeModule as any;
  if (!M || typeof M._load !== "function") {
    nerLog("[NER] sharp shim: Module._load not available, skipping shim install");
    return;
  }

  registerSharpShimTargets(requireFromDeps);

  if (_sharpShimInstalled) {
    nerLog(
      `[NER] sharp shim already active (roots=${_sharpShimRoots.size}, entries=${_sharpShimEntries.size})`,
    );
    return;
  }

  const originalLoad = M._load;
  M._load = function patchedLoad(request: string, parent: any, isMain: boolean): any {
    if (typeof request === "string" && shouldInterceptSharpRequest(request, parent)) {
      _sharpShimInterceptCount += 1;
      if (_sharpShimInterceptCount <= 5) {
        const parentId =
          typeof parent?.filename === "string" ? parent.filename :
          typeof parent?.id === "string" ? parent.id :
          "<unknown>";
        nerLog(`[NER] sharp shim intercepted request=${request} parent=${parentId}`);
      }
      return getSharpDepsShim();
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  _sharpShimInstalled = true;
  nerLog("[NER] sharp shim installed (intercepts bare-name and absolute-path sharp loads)");
}

const NER_DEP_PACKAGES = [
  "onnxruntime-node",
  "onnxruntime-common",
  "onnxruntime-web",
  "@xenova/transformers",
  "gliner",
] as const;

// GLiNER label ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ our entity type mapping
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
  "job title": "PERSON",           // propagation stop ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â captured as person-context
  "medical condition": "MEDICAL_LICENSE", // repurpose slot
  date: "DATE_TIME",
  product: "ORGANIZATION",          // product names often map to brand/org
  event: "LOCATION",                // events carry location context
};

// Entity labels for GLiNER ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â focused on named entities that regex can't detect.
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

// Extended (enriched) label set ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â more granular entity types for comparison.
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

// Tuned (12 labels) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â compact + granular ORG sublabels without full extended dilution.
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

// Progress state ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â exposed via getNerStatus() so the `list_entities` MCP tool
// can surface a useful phase/percent/message to Claude while the first-run
// bootstrap (deps install + model download + gliner.initialize) runs. Without
// this the user sees no feedback during the 2ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“5 min cold start.
export type NerPhase =
  | "idle"
  | "installing_deps"
  | "loading_model"
  | "needs_setup"
  | "ready"
  | "error";
let _nerPhase: NerPhase = "idle";
let _nerProgressPct = 0;
let _nerMessage = "";

type NerDepsStateFingerprint = {
  depsDir: string;
  depsDirExists: boolean;
  nodeModulesExists: boolean;
  stamp: string;
};

let _failedInitDepsState: NerDepsStateFingerprint | null = null;

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
    | "sharp_native_missing"
    | "model_download_rename"
    | "onnxruntime_too_old"
    | "onnxruntime_mixed_versions"
    | "unknown";
  suggested_actions: string[];
  raw_error: string;
}

let _initDiagnostic: NerErrorDiagnostic | null = null;

/**
 * Classify a native-load failure during `initGliner` into a structured
 * diagnostic with platform-specific recovery steps. Non-fatal ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â if the error
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
  const depsBaseDir = getDepsBaseDir();
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
  const siblingFiles = (() => {
    try { return fs.readdirSync(bindingDir); }
    catch { return [] as string[]; }
  })();
  const expectedSiblings =
    platform === "win32"
      ? [
          { label: "onnxruntime.dll", test: (name: string) => name === "onnxruntime.dll" },
          { label: "DirectML.dll", test: (name: string) => name === "DirectML.dll" },
          { label: "dxcompiler.dll", test: (name: string) => name === "dxcompiler.dll" },
          { label: "dxil.dll", test: (name: string) => name === "dxil.dll" },
        ]
      : platform === "darwin"
        ? [{ label: "libonnxruntime*.dylib", test: (name: string) => /^libonnxruntime(?:\.\d+\.\d+\.\d+)?\.dylib$/.test(name) }]
        : [{ label: "libonnxruntime.so*", test: (name: string) => /^libonnxruntime\.so(?:\.\d+)?$/.test(name) }];

  const siblingsPresent: string[] = [];
  const siblingsMissing: string[] = [];
  for (const sib of expectedSiblings) {
    const match = siblingFiles.find((name) => sib.test(name));
    if (match) siblingsPresent.push(match);
    else siblingsMissing.push(sib.label);
  }

  let likelyCause: NerErrorDiagnostic["likely_cause"] = "unknown";
  const suggestedActions: string[] = [];

  // Model-download rename / ENOENT branch ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â distinct from native-load failures.
  // Symptom: "Failed to download model: ... ENOENT: no such file or directory, rename '...tmp' -> '...onnx'"
  // Root cause on Windows is almost always antivirus (Defender / SmartScreen)
  // quarantining the freshly-downloaded .tmp file before we can rename it.
  // We already retry with backoff in downloadFile, but if even that exhausts,
  // the user needs to add the model cache dir to AV exclusions.
  if (/Failed to download model|ENOENT.*rename|rename failed after retries/i.test(msg)) {
    likelyCause = "model_download_rename";
    if (platform === "win32") {
      const modelsDir = PATHS.MODELS_DIR;
      suggestedActions.push(
        `Add the PII Shield model cache directory to your antivirus exclusions: **${modelsDir}** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Windows Defender / SmartScreen is quarantining the freshly-downloaded ONNX model mid-rename.`,
        `How: Settings ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Windows Security ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Virus & threat protection ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Manage settings ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Exclusions ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Add an exclusion ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Folder ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ pick \`${modelsDir}\`.`,
        `After adding the exclusion, delete any leftover \`*.tmp\` files in that folder and call list_entities again ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the retry download will succeed without interference.`,
        "If antivirus exclusion is not an option: try running the server process from an elevated / admin shell, or temporarily pause real-time protection during the 2ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“5 minute first-run download.",
      );
    } else {
      suggestedActions.push(
        `The downloaded model file could not be renamed from its .tmp location. Check that \`${PATHS.MODELS_DIR}\` is writable and has enough free disk space (~700 MB).`,
        `Delete any leftover *.tmp files in that folder and call list_entities again.`,
      );
    }
  } else if (
    /Something went wrong installing the "sharp" module|sharp-[^\\/\s]+\.node|(?:^|[\\/])sharp[\\/].*build[\\/]Release/i.test(msg)
  ) {
    likelyCause = "sharp_native_missing";
    suggestedActions.push(
      "PII Shield's pinned onnxruntime-node/common/web set is already healthy; the remaining failure is the optional sharp image addon pulled in by @xenova/transformers.",
      "Text-only GLiNER NER does not use sharp. Install the updated PII Shield build and retry list_entities; it intercepts sharp's absolute-path load path before the native addon is touched.",
      "Do not manually install sharp or enable npm lifecycle scripts for this server. If the issue persists on the updated build, send ~/.pii_shield/audit/ner_init.log so we can inspect the resolved sharp entry/root and shim interception lines.",
    );
  } else if (/Unsupported model IR version/i.test(msg)) {
    likelyCause = "onnxruntime_too_old";
    suggestedActions.push(
      "A stale nested onnxruntime-node copy was loaded instead of PII Shield's pinned runtime. The GLiNER model uses ONNX IR v9; old onnxruntime builds only support IR v8.",
      `Install the updated PII Shield build, then delete ${depsBaseDir} (or at least ${depsDir}) and call list_entities again so dependencies reinstall with the pinned onnxruntime-node/common/web set.`,
      "If this persists, send ~/.pii_shield/audit/ner_init.log; it now logs which onnxruntime-node/common/web package each dependency resolves to.",
    );
  } else if (/not a valid backend/i.test(msg)) {
    likelyCause = "onnxruntime_mixed_versions";
    suggestedActions.push(
      "This usually means multiple onnxruntime-common / onnxruntime-node / onnxruntime-web copies are present and GLiNER loaded the wrong backend registry singleton.",
      `Install the updated PII Shield build, then delete ${depsBaseDir} (or at least ${depsDir}) and call list_entities again so the server rebuilds a clean versioned install root.`,
      "If this persists, send ~/.pii_shield/audit/ner_init.log; it now logs which onnxruntime-node, onnxruntime-common, and onnxruntime-web package each dependency resolves to.",
    );
  } else if (platform === "win32") {
    if (!bindingExists) {
      likelyCause = "arch_mismatch";
      suggestedActions.push(
        `onnxruntime-node is missing the prebuild for ${platform}/${arch}. Check that your Node.js build matches your system architecture (x64 vs ARM64).`,
        "If on Windows ARM64: install the native ARM64 Node.js build from https://nodejs.org/en/download instead of the x64 build, then remove " + depsBaseDir + " and call list_entities again.",
      );
    } else if (/%1\b|ERROR_BAD_EXE_FORMAT|could not be loaded|procedure could not be located|Module could not be found/i.test(msg)) {
      likelyCause = "windows_dll_dep_missing";
      if (siblingsMissing.length > 0) {
        suggestedActions.push(
          `The onnxruntime-node install is missing sibling DLL(s): ${siblingsMissing.join(", ")}. Delete ${depsBaseDir} and call list_entities again ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the npm install likely failed partway through.`,
        );
      } else {
        // Binding + all siblings present. In v2.0.1 the most frequent cause
        // was a double-dlopen from transformers ESM + gliner CJS racing each
        // other ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â patched via the CJS pre-load at the top of initGliner. If
        // we're still here, it's probably deps corruption or a genuine
        // OS-level dependency miss.
        suggestedActions.push(
          `Delete ${depsBaseDir} and call list_entities again ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â this forces a clean reinstall and resolves most "%1" errors in practice.`,
          "No Claude restart should be needed on this build; the next list_entities call will detect the changed deps tree and retry init.",
          "If the error still persists, check Windows Defender / SmartScreen hasn't blocked the downloaded onnxruntime_binding.node ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the file path is in ner_error_diagnostic.binding_path above.",
          "As a last resort, install or repair Visual C++ Redistributable 2015-2022 (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe. This is rarely the actual cause on modern Windows 10/11 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â VC++ is typically already present ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â but a corrupt install can surface this error.",
        );
      }
    }
  } else if (platform === "darwin") {
    if (!bindingExists) {
      likelyCause = "arch_mismatch";
      suggestedActions.push(
        `onnxruntime-node is missing the prebuild for ${platform}/${arch}. On Apple Silicon (M1/M2/M3) install the arm64 Node.js build; on Intel Macs install the x64 build.`,
        `Then remove ${depsBaseDir} and call list_entities again.`,
      );
    } else if (/image not found|library not loaded|Symbol not found|dlopen/i.test(msg)) {
      likelyCause = "darwin_dep_missing";
      suggestedActions.push(
        "Run `xcode-select --install` in Terminal to install the Xcode Command Line Tools (provides libSystem / dyld).",
        `Then delete ${depsBaseDir} and call list_entities again to trigger a clean reinstall.`,
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
      `Try deleting ${depsBaseDir} (or at least ${depsDir}) and calling list_entities again to force a clean reinstall.`,
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
  nerLog(`[NER] status ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ${phase} ${_nerProgressPct}% ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ${message}`);
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

// Model + tokenizer file names ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â bundled inside the .mcpb at
// `<extension_root>/models/<MODEL_SLUG>/`. See plugin/build-plugin.mjs for the
// bundling step and the rationale for why we ship the model pre-extracted
// rather than downloading at runtime.
//
// Why gliner-pii-base/fp32 (665 MB) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â every other variant is broken on our stack:
// - base/fp16 (333 MB): onnxruntime-node CPU EP doesn't support fp16 reliably ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
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
 * `model.onnx.<pid>.tmp` (process-unique name ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ no truncate race), then
 * `fs.renameSync` atomically replaces the final path on Windows. Last rename
 * wins; all produce byte-identical output, so concurrent work is wasteful
 * (~5 sec per process) but never produces a corrupt file. No lock, no stale
 * detection, no deadlock.
 *
 * Input files are read-only inside the extension dir ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â there is no race on
 * READING them, only on WRITING the assembled output.
 */
/**
 * Typed error thrown by `ensureModelFiles` when no candidate directory on
 * disk has a valid GLiNER model. Caught by `initGliner` which translates it
 * into a `phase: "needs_setup"` NER status, which `handleListEntities`
 * serialises into a user-facing `setup_instructions` envelope.
 */
export interface ModelNotFoundError extends Error {
  code: "NEEDS_SETUP";
  searched: string[];
}

/**
 * Ordered list of directories to check for an already-installed GLiNER
 * model. First valid match wins. The list is intentionally short and
 * targets common user-chosen locations ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no deep BFS, no fuzzy matching.
 */
function candidateModelDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  // 1. Explicit override via Claude Desktop Extension settings
  // (`${user_config.models_path}` ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ env PII_SHIELD_MODELS_DIR).
  const userPath = (process.env.PII_SHIELD_MODELS_DIR || "").trim();
  if (userPath) dirs.push(path.join(userPath, MODEL_SLUG));

  // 2. Recommended default ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the location install-model.ps1/.sh writes to.
  dirs.push(path.join(home, ".pii_shield", "models", MODEL_SLUG));

  // 3. CLAUDE_PLUGIN_DATA ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â legacy bundled-with-mcpb location from pre-thin
  // builds. User may have upgraded without moving files.
  if (process.env.CLAUDE_PLUGIN_DATA) {
    dirs.push(path.join(process.env.CLAUDE_PLUGIN_DATA, "models", MODEL_SLUG));
  }

  // 4. User manually dropped the folder in Downloads.
  dirs.push(path.join(home, "Downloads", MODEL_SLUG));

  // 5. Bundle-relative fallback ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â if this bundle ever ships alongside a
  // models dir (dev fat-build staging dir, legacy .mcpb pre-thin), pick it up.
  const bundleRoot = path.dirname(fileURLToPath(import.meta.url));
  dirs.push(path.join(bundleRoot, "models", MODEL_SLUG));

  // De-duplicate while preserving order.
  return [...new Set(dirs)];
}

/**
 * Exported for `handleListEntities` so the `needs_setup` envelope can include
 * the exact paths tried. Re-computed fresh each call so it reflects current
 * env (`PII_SHIELD_MODELS_DIR`, `CLAUDE_PLUGIN_DATA`) without caching.
 */
export function getNeedsSetupSearched(): string[] {
  return candidateModelDirs();
}

/** All required files in one directory, and `model.onnx` at least MIN size. */
function isValidModelDir(dir: string): boolean {
  const modelPath = path.join(dir, "model.onnx");
  if (!fs.existsSync(modelPath)) return false;
  try {
    if (fs.statSync(modelPath).size < MODEL_MIN_SIZE_BYTES) return false;
  } catch {
    return false;
  }
  return TOKENIZER_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Find the GLiNER model on disk via an ordered candidate list. The model is
 * installed by the user via `scripts/install-model.ps1` (Windows) or
 * `scripts/install-model.sh` (macOS/Linux) **before** they install the
 * .mcpb ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â see README for the 3-step install.
 *
 * At runtime this function only **reads** (existsSync, statSync). There is
 * no download, no lock, no multi-process write race ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â any number of Claude
 * Desktop-spawned server instances can call it concurrently and they will
 * all land on the same read-only file.
 *
 * If no candidate passes validation, throws a typed `ModelNotFoundError`
 * with `code: "NEEDS_SETUP"` and the list of paths tried ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â used by
 * `initGliner` to surface an actionable envelope to the user.
 */
async function ensureModelFiles(): Promise<{ modelPath: string; tokenizerDir: string }> {
  for (const dir of candidateModelDirs()) {
    if (isValidModelDir(dir)) {
      const modelPath = path.join(dir, "model.onnx");
      const size = fs.statSync(modelPath).size;
      nerLog(`[NER] auto-detected model at ${dir} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      return { modelPath, tokenizerDir: dir };
    }
  }
  const err = new Error(
    "GLiNER model files not found. Run scripts/install-model.ps1 (Windows) " +
    "or scripts/install-model.sh (macOS/Linux) before using PII Shield. " +
    "See README.md for the one-liner.",
  ) as ModelNotFoundError;
  err.code = "NEEDS_SETUP";
  err.searched = candidateModelDirs();
  throw err;
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
// Bumped from 1.19.2 ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 1.22.0 to support Node v24 on Windows.
//
// onnxruntime-node 1.19.2 (Sep 2024) predates Node v24 (Oct 2024 current,
// LTS Apr 2025). Its prebuild in bin/napi-v3/win32/x64/onnxruntime_binding.node
// uses V8-internal APIs that were reorganised in v24 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â LoadLibraryExW returns
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
// (huggingface/transformers.js#1087) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â pin it explicitly to match.
const NER_DEPS_PINS = {
  "onnxruntime-node": "1.22.0",
  "onnxruntime-common": "1.22.0",
  "onnxruntime-web": "1.22.0",
  "@xenova/transformers": "2.17.2",
  "gliner": "0.0.19",
} as const;
const NER_INSTALL_STRATEGY_VERSION = "ort-triplet-lock-v1";

/**
 * Stamp identifying the current dep-pin set. When this changes across plugin
 * versions, the on-disk deps install is from the previous pin set and may be
 * ABI-incompatible with the new runtime. We keep installs in versioned roots
 * so stale trees are never re-used.
 */
const NER_DEPS_STAMP = Object.entries(NER_DEPS_PINS)
  .map(([k, v]) => `${k}@${v}`)
  .concat(`install_strategy=${NER_INSTALL_STRATEGY_VERSION}`)
  .sort()
  .join(",");

type NpmInstallCommand = {
  command: string;
  argsPrefix: string[];
  shell: boolean;
  source: string;
};

type NerRuntimePackageName =
  | "onnxruntime-node"
  | "onnxruntime-common"
  | "onnxruntime-web";

function buildNerDepsPackageJson(): Record<string, unknown> {
  return {
    name: "pii-shield-deps",
    version: "1.0.0",
    private: true,
    dependencies: { ...NER_DEPS_PINS },
    overrides: {
      "onnxruntime-node": NER_DEPS_PINS["onnxruntime-node"],
      "onnxruntime-common": NER_DEPS_PINS["onnxruntime-common"],
      "onnxruntime-web": NER_DEPS_PINS["onnxruntime-web"],
    },
  };
}

function buildNerDepsLockfile(): Record<string, unknown> {
  const lockfile = JSON.parse(JSON.stringify(NER_DEPS_LOCKFILE_TEMPLATE)) as Record<string, any>;
  lockfile.name = "pii-shield-deps";
  lockfile.packages ||= {};
  lockfile.packages[""] ||= {};
  lockfile.packages[""].name = "pii-shield-deps";
  lockfile.packages[""].dependencies = { ...NER_DEPS_PINS };
  return lockfile;
}

function readDepsStamp(depsDir: string): string {
  const stampPath = getDepsStampPath(depsDir);
  try {
    if (fs.existsSync(stampPath)) return fs.readFileSync(stampPath, "utf-8").trim();
  } catch (e) {
    nerLog(`[NER] stamp read failed for ${stampPath}: ${e}`);
  }
  return "";
}

function captureDepsState(): NerDepsStateFingerprint {
  const depsDir = getDepsDir();
  return {
    depsDir,
    depsDirExists: fs.existsSync(depsDir),
    nodeModulesExists: fs.existsSync(getDepsNodeModulesDir(depsDir)),
    stamp: readDepsStamp(depsDir),
  };
}

function clearNerFailureState(): void {
  _initFailed = false;
  _initError = "";
  _initDiagnostic = null;
  _failedInitDepsState = null;
}

function clearNerRuntimeState(): void {
  _initPromise = null;
  _gliner = null;
  _nerPhase = "idle";
  _nerProgressPct = 0;
  _nerMessage = "";
}

function depsStateChangedSinceFailure(): {
  changed: boolean;
  current: NerDepsStateFingerprint;
} {
  const current = captureDepsState();
  if (!_failedInitDepsState) {
    return { changed: false, current };
  }
  const changed =
    current.depsDir !== _failedInitDepsState.depsDir ||
    current.depsDirExists !== _failedInitDepsState.depsDirExists ||
    current.nodeModulesExists !== _failedInitDepsState.nodeModulesExists ||
    current.stamp !== _failedInitDepsState.stamp;
  return { changed, current };
}

export async function retryNerIfRepairDetected(): Promise<boolean> {
  if (!_initFailed) return false;
  const { changed, current } = depsStateChangedSinceFailure();
  if (!changed) return false;
  nerLog(
    `[retry] deps state changed since failure: ` +
    `failed=${JSON.stringify(_failedInitDepsState)} current=${JSON.stringify(current)}; reinitializing NER`,
  );
  await forceReinitNer();
  return true;
}

function resolveNpmInstallCommand(): NpmInstallCommand {
  const execDir = path.dirname(process.execPath);
  const bundledCandidates = [
    path.resolve(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  for (const npmCli of bundledCandidates) {
    if (fs.existsSync(npmCli)) {
      return {
        command: process.execPath,
        argsPrefix: [npmCli],
        shell: false,
        source: `bundled npm-cli.js (${npmCli})`,
      };
    }
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    argsPrefix: [],
    shell: process.platform === "win32",
    source: process.platform === "win32" ? "PATH npm.cmd fallback" : "PATH npm fallback",
  };
}

function removeNestedOnnxRuntimeCopies(nmDir: string): void {
  const nestedRoots = [
    path.join(nmDir, "@xenova", "transformers", "node_modules"),
    path.join(nmDir, "gliner", "node_modules"),
  ];
  for (const root of nestedRoots) {
    for (const pkgName of ["onnxruntime-node", "onnxruntime-common", "onnxruntime-web"]) {
      const dir = path.join(root, pkgName);
      if (!fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        nerLog(`[NER] removed nested ${pkgName}: ${dir}`);
      } catch (e) {
        throw new Error(`Failed to remove nested ${pkgName} at ${dir}: ${e}`);
      }
    }
  }
}

function resolvePackageRootPackageJson(
  resolver: NodeRequire,
  pkgName: string,
): string {
  const resolvedEntry = resolver.resolve(pkgName);
  let dir = path.dirname(resolvedEntry);

  while (true) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
        if (pkg.name === pkgName) {
          return candidate;
        }
      } catch {
        // Ignore invalid or helper package.json files and keep walking upward.
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Could not locate package.json root for ${pkgName} starting from ${resolvedEntry}`);
}

function assertPinnedResolution(
  depsDir: string,
  pkgName: NerRuntimePackageName,
): void {
  const expected = NER_DEPS_PINS[pkgName];
  const nmDir = getDepsNodeModulesDir(depsDir);
  const roots = [
    { label: "deps root", dir: depsDir },
    { label: "@xenova/transformers", dir: path.join(nmDir, "@xenova", "transformers") },
    { label: "gliner", dir: path.join(nmDir, "gliner") },
  ];

  const resolvedPackages: Array<{ label: string; pkgPath: string; version: string }> = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    const resolver = _createRequire(path.join(root.dir, "package.json"));
    const pkgPath = resolvePackageRootPackageJson(resolver, pkgName);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    const version = pkg.version || "<unknown>";
    nerLog(`[NER] ${root.label} resolves ${pkgName} ${version} at ${pkgPath}`);
    if (version !== expected) {
      throw new Error(
        `${root.label} resolves ${pkgName} ${version} instead of ${expected}. ` +
        "This indicates a mixed onnxruntime install and will break GLiNER backend initialization.",
      );
    }
    resolvedPackages.push({ label: root.label, pkgPath: path.resolve(pkgPath), version });
  }

  const canonicalPath = resolvedPackages[0]?.pkgPath;
  if (!canonicalPath) return;
  for (const resolved of resolvedPackages.slice(1)) {
    if (resolved.pkgPath !== canonicalPath) {
      throw new Error(
        `${resolved.label} resolves ${pkgName} at ${resolved.pkgPath}, but deps root resolves it at ${canonicalPath}. ` +
        "This indicates duplicate onnxruntime packages and will break backend registration.",
      );
    }
  }
}

function assertOnnxRuntimeResolution(depsDir: string): void {
  assertPinnedResolution(depsDir, "onnxruntime-node");
  assertPinnedResolution(depsDir, "onnxruntime-common");
  assertPinnedResolution(depsDir, "onnxruntime-web");
}

function sanitizeOnnxRuntimeTree(depsDir: string): void {
  const nmDir = getDepsNodeModulesDir(depsDir);
  if (!fs.existsSync(nmDir)) {
    throw new Error(`Missing node_modules at ${nmDir}`);
  }
  removeNestedOnnxRuntimeCopies(nmDir);
  assertOnnxRuntimeResolution(depsDir);
}

function ensureDepsLayoutDirs(): void {
  fs.mkdirSync(getDepsBaseDir(), { recursive: true });
  fs.mkdirSync(getDepsInstallsDir(), { recursive: true });
  fs.mkdirSync(getDepsStagingRoot(), { recursive: true });
}

function removeLegacyFlatDepsLayout(): void {
  for (const rel of [
    "node_modules",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    ".pii_shield_pins",
  ]) {
    const target = path.join(getDepsBaseDir(), rel);
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      nerLog(`[NER] removed legacy flat deps path: ${target}`);
    } catch (e) {
      nerLog(`[NER] failed to remove legacy flat deps path ${target}: ${e}`);
    }
  }
}

function pruneOldDepsStagingDirs(): void {
  const stagingRoot = getDepsStagingRoot();
  if (!fs.existsSync(stagingRoot)) return;
  const cutoffMs = Date.now() - (24 * 60 * 60 * 1000);
  try {
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(stagingRoot, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoffMs) continue;
        fs.rmSync(fullPath, { recursive: true, force: true });
        nerLog(`[NER] pruned stale staging dir: ${fullPath}`);
      } catch (e) {
        nerLog(`[NER] failed to prune stale staging dir ${fullPath}: ${e}`);
      }
    }
  } catch (e) {
    nerLog(`[NER] failed to scan staging dir ${stagingRoot}: ${e}`);
  }
}

function writeNerDepsScaffold(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "package.json"),
    `${JSON.stringify(buildNerDepsPackageJson(), null, 2)}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(targetDir, "package-lock.json"),
    `${JSON.stringify(buildNerDepsLockfile(), null, 2)}\n`,
    "utf-8",
  );
  try {
    fs.rmSync(path.join(targetDir, "npm-shrinkwrap.json"), { force: true });
  } catch {
    /* best effort */
  }
}

function validateOnnxRuntimeBinaryLayout(depsDir: string): void {
  const nmDir = getDepsNodeModulesDir(depsDir);
  const napiRoot = path.join(nmDir, "onnxruntime-node", "bin", "napi-v6");
  const expectedBinary = path.join(
    napiRoot, process.platform, process.arch, "onnxruntime_binding.node",
  );
  if (fs.existsSync(expectedBinary)) return;

  let availablePlatforms: string[] = [];
  try {
    availablePlatforms = fs.readdirSync(napiRoot);
  } catch {
    /* napiRoot itself may be missing */
  }
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

async function runNpmCiInstall(cwd: string, timeoutMs: number): Promise<void> {
  const { execFile } = await import("node:child_process");
  const npmInstallCommand = resolveNpmInstallCommand();
  nerLog(`[NER] npm install runner: ${npmInstallCommand.source}`);

  await new Promise<void>((resolve, reject) => {
    execFile(
      npmInstallCommand.command,
      [
        ...npmInstallCommand.argsPrefix,
        "ci",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
        "--ignore-scripts",
      ],
      {
        cwd,
        timeout: timeoutMs,
        shell: npmInstallCommand.shell,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          ONNXRUNTIME_NODE_INSTALL_CUDA: "skip",
        },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const tail = (stderr || "").split("\n").slice(-30).join("\n");
        reject(
          new Error(
            `npm ci failed (cwd=${cwd}): ${err.message}\n` +
            `--- npm stderr (last 30 lines) ---\n${tail}\n` +
            `--- npm stdout (last 10 lines) ---\n${(stdout || "").split("\n").slice(-10).join("\n")}`,
          ),
        );
      },
    );
  });
}

function finalizeDepsInstall(stageDir: string, depsDir: string): void {
  const parentDir = path.dirname(depsDir);
  fs.mkdirSync(parentDir, { recursive: true });
  try {
    fs.renameSync(stageDir, depsDir);
    nerLog(`[NER] installed deps root committed atomically: ${depsDir}`);
    return;
  } catch (e) {
    if (!fs.existsSync(depsDir)) {
      throw e;
    }

    try {
      sanitizeOnnxRuntimeTree(depsDir);
      nerLog(`[NER] another process already prepared healthy deps root: ${depsDir}`);
      fs.rmSync(stageDir, { recursive: true, force: true });
      return;
    } catch (existingErr) {
      nerLog(`[NER] existing deps root at ${depsDir} is unhealthy (${existingErr}); replacing with freshly staged install`);
      fs.rmSync(depsDir, { recursive: true, force: true });
      fs.renameSync(stageDir, depsDir);
      nerLog(`[NER] replaced unhealthy deps root: ${depsDir}`);
    }
  }
}

async function ensureNerDeps(): Promise<string> {
  const depsDir = getDepsDir();
  const nmDir = getDepsNodeModulesDir(depsDir);
  const stampMatches = readDepsStamp(depsDir) === NER_DEPS_STAMP;

  ensureDepsLayoutDirs();
  pruneOldDepsStagingDirs();
  removeLegacyFlatDepsLayout();

  const allInstalled = NER_DEP_PACKAGES.every((pkgName) =>
    fs.existsSync(path.join(nmDir, ...pkgName.split("/"), "package.json")),
  );
  if (allInstalled && stampMatches) {
    try {
      sanitizeOnnxRuntimeTree(depsDir);
      return depsDir;
    } catch (e) {
      nerLog(`[NER] existing deps failed onnxruntime sanity check (${e}) - removing unhealthy install root`);
      try {
        fs.rmSync(depsDir, { recursive: true, force: true });
        nerLog(`[NER] removed unhealthy deps root ${depsDir}`);
      } catch (wipeErr) {
        nerLog(`[NER] unhealthy deps root removal failed (${wipeErr})`);
      }
    }
  } else if (fs.existsSync(depsDir)) {
    try {
      fs.rmSync(depsDir, { recursive: true, force: true });
      nerLog(`[NER] removed stale/incomplete deps root ${depsDir}`);
    } catch (e) {
      nerLog(`[NER] failed to remove stale deps root ${depsDir}: ${e}`);
    }
  }

  setNerStatus(
    "installing_deps",
    5,
    "Installing deterministic NER runtime deps into a versioned cache root (first run only, ~1-2 min)...",
  );
  nerLog(`[NER] Installing NER dependencies in ${depsDir}... (pins: ${NER_DEPS_STAMP})`);

  const stageDir = getDepsStageDir();
  writeNerDepsScaffold(stageDir);

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const pct = Math.min(8, 5 + Math.floor(secs / 12));
    setNerStatus(
      "installing_deps",
      pct,
      `Installing deterministic NER runtime deps (npm ci --ignore-scripts, ${secs}s elapsed)...`,
    );
  }, 4000);

  try {
    await runNpmCiInstall(stageDir, 300_000);
    sanitizeOnnxRuntimeTree(stageDir);
    validateOnnxRuntimeBinaryLayout(stageDir);
    fs.writeFileSync(getDepsStampPath(stageDir), NER_DEPS_STAMP, "utf-8");
    finalizeDepsInstall(stageDir, depsDir);
    sanitizeOnnxRuntimeTree(depsDir);
    setNerStatus("installing_deps", 9, "NER dependencies installed.");
    nerLog(`[NER] OK NER dependencies installed (pins: ${NER_DEPS_STAMP})`);
  } catch (e) {
    nerLog(`[NER] Failed to install NER deps: ${e}`);
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
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
    setNerStatus("installing_deps", 2, "Starting PII Shield NER initialization...");
    nerLog("[NER] initGliner starting...");

    // Ensure NER deps (transformers, gliner, onnxruntime-node/common/web)
    // are installed in PATHS.DEPS_DIR. Returns the deps directory path.
    const depsDir = await ensureNerDeps();
    nerLog("[NER] NER deps OK");

    // Resolve transformers / gliner from the deps dir explicitly via createRequire,
    // bypassing NODE_PATH which is unreliable in ESM contexts. createRequire
    // anchored at <depsDir>/package.json walks <depsDir>/node_modules/ as if a
    // file in depsDir was doing the require.
    const requireFromDeps = _createRequire(path.join(depsDir, "package.json"));

    const { modelPath, tokenizerDir } = await ensureModelFiles();
    nerLog(`[NER] modelPath=${modelPath}`);
    nerLog(`[NER] tokenizerDir=${tokenizerDir}`);

    // Neutralise `sharp` BEFORE transformers loads. @xenova/transformers pulls
    // sharp in transitively but only invokes image methods for image pipelines,
    // which our text-only NER never hits. The shim intercepts `require('sharp')`
    // and returns a no-op Proxy so the real native addon is never loaded ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â safe
    // on hosts without libvips or a matching prebuild.
    installSharpShimForDeps(requireFromDeps);
    // CRITICAL: pre-load `onnxruntime-node` via CJS `require()` BEFORE we touch
    // `@xenova/transformers` or `gliner`. Rationale: transformers' ESM entry
    // (`src/backends/onnx.js:21`) statically imports onnxruntime-node through
    // its ESM graph. When we then CJS-require it again from gliner's CJS node
    // entry (`gliner/dist/node/index.cjs:4`), Node's ESM/CJS dual-loading
    // tries to dlopen the `.node` binding a second time in the same process
    // ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â and on Windows that second LoadLibrary call fails with
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
    // instance from a later CJS `require()` inside gliner/node.cjs ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â leaving
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
      // Non-fatal ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the ESM path below still works, this is just a warm-up.
      nerLog(`[NER] transformers CJS pre-load failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }

    nerLog("[NER] resolving @xenova/transformers from deps (ESM)...");
    const transformersEntry = requireFromDeps.resolve("@xenova/transformers");
    const transformers: any = await import(pathToFileURL(transformersEntry).href);
    const env = transformers.env;
    // Tokenizer files live in the sidecar dir; modelPath is loaded explicitly
    // by gliner from its absolute path. If the CJS pre-load above already set
    // these on the shared module, this is a no-op re-assignment to the same
    // values ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â safe and idempotent.
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
      // "." is resolved relative to env.localModelPath ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ modelsDir
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

    setNerStatus("loading_model", 95, "Loading GLiNER model into ONNX runtime...");
    nerLog("[NER] calling gliner.initialize()...");
    await gliner.initialize();
    _gliner = gliner;
    clearNerFailureState();
    setNerStatus("ready", 100, "PII Shield NER ready.");
    nerLog(`[NER] GLiNER initialized (model=${modelPath})`);
  } catch (e) {
    // Model-not-found is a benign user-setup situation, not a native load
    // failure. Surface it as a dedicated `needs_setup` phase so the skill
    // can prompt the user to run the install-model one-liner instead of
    // printing scary native-addon diagnostics.
    if ((e as ModelNotFoundError)?.code === "NEEDS_SETUP") {
      _initFailed = true;
      _initError = String(e);
      setNerStatus(
        "needs_setup",
        0,
        "GLiNER model not installed. Run the install-model script - see setup_instructions.",
      );
      nerLog(`[NER] needs_setup - searched: ${(e as ModelNotFoundError).searched.join(" | ")}`);
      throw e;
    }
    _initFailed = true;
    _initError = String(e);
    _failedInitDepsState = captureDepsState();
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
    clearNerFailureState();
    _initPromise = null;
  }
  if (!_initPromise) {
    _initPromise = initGliner();
  }
  return _initPromise;
}

/**
 * Force-discard any prior init state and run `initGliner()` from scratch.
 *
 * Used by the `needs_setup` retry path in `handleListEntities` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â after the
 * user installs the model via `install-model.ps1`/`.sh` we want a fresh
 * auto-BFS scan regardless of what `_initFailed` / `_initPromise` happen to
 * hold. Unlike `initNer()` this does NOT gate on `_initFailed`; it
 * unconditionally clears the module-level state and starts a new
 * `initGliner()` call. Safe to invoke repeatedly.
 *
 * Why not just fix `initNer()`: its gated behaviour is relied on by
 * `PIIEngine.startNerBackground()` so two near-simultaneous startup calls
 * share a single in-flight init promise instead of launching two copies.
 * We don't want to break that coordination ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a dedicated retry primitive
 * is safer.
 */
export async function forceReinitNer(): Promise<void> {
  clearNerFailureState();
  clearNerRuntimeState();
  _initPromise = initGliner();
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
    logServer(`[NER-Inference] AFTER _gliner.inference() ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â returned OK`);
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
