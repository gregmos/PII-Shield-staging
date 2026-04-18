/**
 * Local NER — standalone NER pipeline for local testing.
 * Supports multiple GLiNER models, enriched label sets, hot-swap.
 * Fully independent from production ner-backend.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelDef {
  id: string;
  name: string;
  hfRepo: string;
  onnxFile: string;
  size: string;
  modelType: "span-level" | "token-level" | "bi-encoder";
  maxWidth: number;
  tokenizerFiles: string[];
  /** If true, model requires Python runtime (no ONNX/JS support) */
  pythonOnly?: boolean;
}

export interface LabelPreset {
  id: string;
  name: string;
  description: string;
  labels: string[];
  labelMap: Record<string, string>;
}

export interface NerEntity {
  text: string;
  type: string;
  start: number;
  end: number;
  score: number;
  verified: boolean;
  reason: string;
}

export interface NerStatus {
  phase: string;
  progress_pct: number;
  message: string;
  ready: boolean;
  error: string;
  activeModel: string | null;
  activePreset: string | null;
  stats: { calls: number; totalEntities: number; lastError: string };
}

// ─── Model Registry ─────────────────────────────────────────────────────────

const TOKENIZER_FILES = [
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "gliner_config.json",
];

export const MODEL_REGISTRY: Record<string, ModelDef> = {
  "gliner-pii-base-v1.0": {
    id: "gliner-pii-base-v1.0",
    name: "GLiNER PII Base v1.0 (fp32)",
    hfRepo: "knowledgator/gliner-pii-base-v1.0",
    onnxFile: "onnx/model.onnx",
    size: "~665 MB",
    modelType: "span-level",
    maxWidth: 12,
    tokenizerFiles: TOKENIZER_FILES,
  },
  "gliner-pii-large-v1.0": {
    id: "gliner-pii-large-v1.0",
    name: "GLiNER PII Large v1.0 (fp32)",
    hfRepo: "knowledgator/gliner-pii-large-v1.0",
    onnxFile: "onnx/model.onnx",
    size: "~1.76 GB",
    modelType: "span-level",
    maxWidth: 12,
    tokenizerFiles: TOKENIZER_FILES,
  },
  "gliner-pii-large-v1.0-quint8": {
    id: "gliner-pii-large-v1.0-quint8",
    name: "GLiNER PII Large v1.0 (quint8)",
    hfRepo: "knowledgator/gliner-pii-large-v1.0",
    onnxFile: "onnx/model_quint8.onnx",
    size: "~648 MB",
    modelType: "span-level",
    maxWidth: 12,
    tokenizerFiles: TOKENIZER_FILES,
  },
  "gliner-multitask-large-v0.5": {
    id: "gliner-multitask-large-v0.5",
    name: "GLiNER Multitask Large v0.5",
    hfRepo: "knowledgator/gliner-multitask-large-v0.5",
    onnxFile: "onnx/model.onnx",
    size: "~1.2 GB",
    modelType: "span-level",
    maxWidth: 12,
    tokenizerFiles: TOKENIZER_FILES,
  },
  // ── Bi-encoder (GLiNER2) — Python only, no ONNX export yet ──────────────
  "gliner-bi-base-v2.0": {
    id: "gliner-bi-base-v2.0",
    name: "GLiNER2 Bi-encoder Base v2.0 [Python]",
    hfRepo: "knowledgator/gliner-bi-base-v2.0",
    onnxFile: "",  // no ONNX — PyTorch only
    size: "~776 MB",
    modelType: "bi-encoder",
    maxWidth: 12,
    tokenizerFiles: TOKENIZER_FILES,
    pythonOnly: true,
  },
};

// ─── Label Presets ──────────────────────────────────────────────────────────
// "Enriched" preset inspired by the paper "Safer Reasoning Traces" (2026):
// "For each PII type, we provide a small set of semantically related labels"

export const LABEL_PRESETS: Record<string, LabelPreset> = {
  minimal: {
    id: "minimal",
    name: "Minimal (Production)",
    description: "Current 9 labels — high precision, lower recall",
    labels: [
      "person", "organization", "company", "law firm", "bank",
      "location", "political group", "address", "date of birth",
    ],
    labelMap: {
      person: "PERSON",
      organization: "ORGANIZATION",
      company: "ORGANIZATION",
      "law firm": "ORGANIZATION",
      bank: "ORGANIZATION",
      location: "LOCATION",
      "political group": "NRP",
      address: "LOCATION",
      "date of birth": "DATE_OF_BIRTH",
    },
  },
  enriched: {
    id: "enriched",
    name: "Enriched (Paper-style)",
    description: "Semantically expanded labels — better recall per research",
    labels: [
      // Person variants
      "person", "full name", "individual name",
      // Organization variants
      "organization", "company", "corporation", "law firm", "bank",
      "financial institution", "government agency",
      // Location variants
      "location", "address", "city", "country",
      // ID documents (NER-detectable in context)
      "social security number", "passport number",
      "credit card number", "driver license number",
      // Contact (NER catches contextual mentions regex misses)
      "email address", "phone number",
      // Other
      "date of birth", "political group",
    ],
    labelMap: {
      person: "PERSON",
      "full name": "PERSON",
      "individual name": "PERSON",
      organization: "ORGANIZATION",
      company: "ORGANIZATION",
      corporation: "ORGANIZATION",
      "law firm": "ORGANIZATION",
      bank: "ORGANIZATION",
      "financial institution": "ORGANIZATION",
      "government agency": "ORGANIZATION",
      location: "LOCATION",
      address: "LOCATION",
      city: "LOCATION",
      country: "LOCATION",
      "social security number": "US_SSN",
      "passport number": "EU_PASSPORT",
      "credit card number": "CREDIT_CARD",
      "driver license number": "US_DRIVER_LICENSE",
      "email address": "EMAIL_ADDRESS",
      "phone number": "PHONE_NUMBER",
      "date of birth": "DATE_OF_BIRTH",
      "political group": "NRP",
    },
  },
  full: {
    id: "full",
    name: "Full (All types)",
    description: "All known PII labels — maximum recall, more noise",
    labels: [
      "person", "full name", "individual name",
      "organization", "company", "corporation", "law firm", "bank",
      "financial institution", "government agency",
      "location", "address", "city", "country", "street address",
      "social security number", "passport number", "driver license number",
      "national id number", "tax identification number",
      "credit card number", "iban", "bank account number",
      "email address", "phone number", "ip address", "url",
      "date of birth", "medical license number",
      "health insurance id number", "political group",
    ],
    labelMap: {
      person: "PERSON", "full name": "PERSON", "individual name": "PERSON",
      organization: "ORGANIZATION", company: "ORGANIZATION",
      corporation: "ORGANIZATION", "law firm": "ORGANIZATION",
      bank: "ORGANIZATION", "financial institution": "ORGANIZATION",
      "government agency": "ORGANIZATION",
      location: "LOCATION", address: "LOCATION", city: "LOCATION",
      country: "LOCATION", "street address": "LOCATION",
      "social security number": "US_SSN",
      "passport number": "EU_PASSPORT",
      "driver license number": "US_DRIVER_LICENSE",
      "national id number": "UK_NIN",
      "tax identification number": "DE_TAX_ID",
      "credit card number": "CREDIT_CARD",
      iban: "IBAN_CODE", "bank account number": "IBAN_CODE",
      "email address": "EMAIL_ADDRESS", "phone number": "PHONE_NUMBER",
      "ip address": "IP_ADDRESS", url: "URL",
      "date of birth": "DATE_OF_BIRTH",
      "medical license number": "MEDICAL_LICENSE",
      "health insurance id number": "UK_NHS",
      "political group": "NRP",
    },
  },
};

// ─── State ──────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.PII_SHIELD_DATA_DIR!;
const MODELS_DIR = path.join(DATA_DIR, "models");
const DEPS_DIR = path.join(DATA_DIR, "deps");

let _gliner: any = null;
let _activeModelId: string | null = null;
let _activePresetId: string = "minimal";
let _phase = "idle";
let _progressPct = 0;
let _message = "";
let _error = "";
let _calls = 0;
let _totalEntities = 0;
let _lastError = "";

// ─── Python bridge state (for bi-encoder models) ──────────────────────────
let _pythonProcess: ChildProcess | null = null;
let _pythonReady = false;
let _pythonRl: readline.Interface | null = null;
/** Queue of pending responses — Python inference is sequential, so FIFO */
let _pythonResponseQueue: Array<{
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];

function setStatus(phase: string, pct: number, msg: string): void {
  _phase = phase;
  _progressPct = pct;
  _message = msg;
  console.error(`[LocalNER] status → ${phase} ${pct}% — ${msg}`);
}

export function getNerStatus(): NerStatus & { pythonRequired?: boolean } {
  const isPythonModel = _activeModelId ? MODEL_REGISTRY[_activeModelId]?.pythonOnly === true : false;
  return {
    phase: _phase,
    progress_pct: _progressPct,
    message: _message,
    ready: _phase === "ready",
    error: _error,
    activeModel: _activeModelId,
    activePreset: _activePresetId,
    stats: { calls: _calls, totalEntities: _totalEntities, lastError: _lastError },
    pythonRequired: isPythonModel || undefined,
  };
}

export function isNerReady(): boolean {
  return _phase === "ready" && (_gliner !== null || _pythonReady);
}

export function getModels(): Array<ModelDef & { downloaded: boolean }> {
  return Object.values(MODEL_REGISTRY).map((m) => ({
    ...m,
    downloaded: isModelDownloaded(m.id),
  }));
}

export function getPresets(): LabelPreset[] {
  return Object.values(LABEL_PRESETS);
}

// ─── Model file management ──────────────────────────────────────────────────

function modelDir(modelId: string): string {
  return path.join(MODELS_DIR, modelId);
}

function isModelDownloaded(modelId: string): boolean {
  const def = MODEL_REGISTRY[modelId];
  if (!def) return false;
  // Python-only models are downloaded by HuggingFace on first use —
  // check if the HF cache has the model directory
  if (def.pythonOnly) {
    // HF caches under models--{org}--{name} structure
    const hfCacheDir = path.join(MODELS_DIR, `models--${def.hfRepo.replace("/", "--")}`);
    return fs.existsSync(hfCacheDir);
  }
  const dir = modelDir(modelId);
  if (!fs.existsSync(path.join(dir, "model.onnx"))) {
    // Check legacy naming (production cache)
    return findLegacyModel(def) !== null;
  }
  return def.tokenizerFiles.every((f) => fs.existsSync(path.join(dir, f)));
}

/** Find model cached with production naming: pii_shield_model__*__sha256-*.onnx */
function findLegacyModel(def: ModelDef): { modelPath: string; tokenizerDir: string } | null {
  const repoSlug = def.hfRepo.replace("/", "_");
  try {
    const files = fs.readdirSync(MODELS_DIR);
    const modelFile = files.find((f) =>
      f.startsWith(`pii_shield_model__${repoSlug}`) && f.endsWith(".onnx")
    );
    const tokDir = files.find((f) =>
      f.startsWith(`pii_shield_tokenizer__${repoSlug}`) && fs.statSync(path.join(MODELS_DIR, f)).isDirectory()
    );
    if (modelFile && tokDir) {
      return {
        modelPath: path.join(MODELS_DIR, modelFile),
        tokenizerDir: path.join(MODELS_DIR, tokDir),
      };
    }
  } catch { /* */ }
  return null;
}

/** Get resolved paths for a model (handles both new and legacy layout) */
function resolveModelPaths(modelId: string): { modelPath: string; tokenizerDir: string } | null {
  const def = MODEL_REGISTRY[modelId];
  if (!def) return null;

  const dir = modelDir(modelId);
  if (fs.existsSync(path.join(dir, "model.onnx"))) {
    return { modelPath: path.join(dir, "model.onnx"), tokenizerDir: dir };
  }

  return findLegacyModel(def);
}

// ─── Python bridge (bi-encoder models) ─────────────────────────────────────

const __localNerDir = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__localNerDir, "gliner2_bridge.py");

/** Find a working Python command on this system */
async function findPython(): Promise<string> {
  const candidates = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];

  for (const cmd of candidates) {
    try {
      const { execSync } = await import("node:child_process");
      const ver = execSync(`${cmd} --version`, { encoding: "utf-8", timeout: 5000 }).trim();
      // Ensure Python 3.9+
      const m = ver.match(/Python (\d+)\.(\d+)/);
      if (m && (parseInt(m[1]) > 3 || (parseInt(m[1]) === 3 && parseInt(m[2]) >= 9))) {
        console.error(`[LocalNER] Found ${ver} via '${cmd}'`);
        return cmd;
      }
    } catch { /* not found or wrong version */ }
  }
  throw new Error("Python 3.9+ not found. Install from python.org and ensure it's on PATH.");
}

/** Send a JSON request to the Python bridge and wait for response */
function callPython(request: object, timeoutMs = 120_000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!_pythonProcess || !_pythonProcess.stdin?.writable) {
      reject(new Error("Python bridge not running"));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Python bridge timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    _pythonResponseQueue.push({ resolve, reject, timer });
    _pythonProcess.stdin.write(JSON.stringify(request) + "\n");
  });
}

/** Start the Python sidecar process and load a model */
async function startPythonBridge(def: ModelDef): Promise<void> {
  // Stop any existing bridge
  await stopPythonBridge();

  setStatus("checking-python", 10, "Checking Python installation...");
  const pythonCmd = await findPython();

  setStatus("starting-bridge", 20, "Starting Python bridge...");

  const proc = spawn(pythonCmd, [BRIDGE_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  _pythonProcess = proc;

  // Forward Python stderr to our console
  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString("utf-8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      console.error(`[Python] ${line}`);
    }
  });

  // Parse stdout as JSON lines
  _pythonRl = readline.createInterface({ input: proc.stdout! });
  _pythonRl.on("line", (line: string) => {
    let resp: any;
    try {
      resp = JSON.parse(line);
    } catch {
      console.error(`[LocalNER] Python stdout (non-JSON): ${line}`);
      return;
    }
    const pending = _pythonResponseQueue.shift();
    if (pending) {
      clearTimeout(pending.timer);
      if (resp.error) {
        pending.reject(new Error(resp.error));
      } else {
        pending.resolve(resp);
      }
    }
  });

  proc.on("exit", (code) => {
    console.error(`[LocalNER] Python bridge exited with code ${code}`);
    _pythonReady = false;
    _pythonProcess = null;
    _pythonRl = null;
    // Reject any pending callbacks
    for (const p of _pythonResponseQueue) {
      clearTimeout(p.timer);
      p.reject(new Error(`Python bridge exited (code ${code})`));
    }
    _pythonResponseQueue = [];
    if (_phase === "ready" && _activeModelId && MODEL_REGISTRY[_activeModelId]?.pythonOnly) {
      setStatus("error", 0, `Python bridge crashed (exit code ${code})`);
      _error = `Python bridge exited unexpectedly (code ${code})`;
    }
  });

  // Send init command — model download happens inside Python (HuggingFace cache)
  setStatus("loading-model", 40, `Loading ${def.name} via Python (first run may download ~${def.size})...`);

  try {
    const resp = await callPython({
      cmd: "init",
      model: def.hfRepo,
      cache_dir: MODELS_DIR,
    }, 600_000); // 10 min timeout for initial download

    if (resp.status === "ok") {
      _pythonReady = true;
      _activeModelId = def.id;
      setStatus("ready", 100, `${def.name} ready (Python).`);
    } else {
      throw new Error(resp.error || "Unknown init error");
    }
  } catch (e: any) {
    _pythonReady = false;
    await stopPythonBridge();
    throw e;
  }
}

/** Stop the Python sidecar */
export async function stopPythonBridge(): Promise<void> {
  if (!_pythonProcess) return;
  try {
    if (_pythonProcess.stdin?.writable) {
      _pythonProcess.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    }
  } catch { /* ignore */ }
  // Give it a moment to exit gracefully
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      _pythonProcess?.kill("SIGKILL");
      resolve();
    }, 3000);
    _pythonProcess?.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  _pythonProcess = null;
  _pythonReady = false;
  _pythonRl?.close();
  _pythonRl = null;
  for (const p of _pythonResponseQueue) {
    clearTimeout(p.timer);
    p.reject(new Error("Python bridge stopped"));
  }
  _pythonResponseQueue = [];
}

// ─── Download from HuggingFace ──────────────────────────────────────────────

async function downloadFile(url: string, destPath: string, label: string): Promise<void> {
  console.error(`[LocalNER] Downloading ${label}...`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);

  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body!.getReader();

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = destPath + ".tmp";
  const fd = fs.openSync(tmpPath, "w");
  let downloaded = 0;
  let lastLogPct = -10;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, value);
      downloaded += value.length;
      if (total > 0) {
        const pct = Math.round((downloaded / total) * 100);
        if (pct - lastLogPct >= 10) {
          setStatus("downloading", pct, `Downloading ${label}: ${pct}%`);
          lastLogPct = pct;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, destPath);
  console.error(`[LocalNER] Downloaded ${label} (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
}

async function downloadModel(modelId: string): Promise<void> {
  const def = MODEL_REGISTRY[modelId];
  if (!def) throw new Error(`Unknown model: ${modelId}`);

  const dir = modelDir(modelId);
  fs.mkdirSync(dir, { recursive: true });

  const hfBase = `https://huggingface.co/${def.hfRepo}/resolve/main`;

  // Download ONNX model
  const modelDest = path.join(dir, "model.onnx");
  if (!fs.existsSync(modelDest)) {
    await downloadFile(`${hfBase}/${def.onnxFile}`, modelDest, `${def.name} model`);
  }

  // Download tokenizer files
  for (const fname of def.tokenizerFiles) {
    const dest = path.join(dir, fname);
    if (!fs.existsSync(dest)) {
      await downloadFile(`${hfBase}/${fname}`, dest, fname);
    }
  }
}

// ─── GLiNER initialization ──────────────────────────────────────────────────

export async function initNer(
  modelId: string = "gliner-pii-base-v1.0",
  presetId: string = "minimal",
): Promise<void> {
  if (_phase === "loading" || _phase === "downloading") {
    throw new Error("NER init already in progress");
  }

  const def = MODEL_REGISTRY[modelId];
  if (!def) throw new Error(`Unknown model: ${modelId}. Available: ${Object.keys(MODEL_REGISTRY).join(", ")}`);
  if (!LABEL_PRESETS[presetId]) throw new Error(`Unknown preset: ${presetId}`);

  _error = "";
  _gliner = null;
  _pythonReady = false;
  _activeModelId = null;

  try {
    // ── Python bridge path for bi-encoder models ──
    if (def.pythonOnly) {
      _activePresetId = presetId;
      await startPythonBridge(def);
      return;
    }

    // ── ONNX/JS path for span-level models ──

    // 1. Ensure model files exist
    if (!isModelDownloaded(modelId)) {
      setStatus("downloading", 0, `Downloading ${def.name}...`);
      await downloadModel(modelId);
    }

    setStatus("loading", 50, `Loading ${def.name}...`);

    const paths = resolveModelPaths(modelId);
    if (!paths) throw new Error(`Model files not found for ${modelId}`);

    console.error(`[LocalNER] modelPath=${paths.modelPath}`);
    console.error(`[LocalNER] tokenizerDir=${paths.tokenizerDir}`);

    // 2. Load deps from Local_Test_Ner/deps via createRequire
    const requireFromDeps = createRequire(path.join(DEPS_DIR, "package.json"));

    // onnxruntime-node should already be pre-loaded by preload.ts
    // Load transformers and configure for local files
    setStatus("loading", 60, "Loading @xenova/transformers...");
    const transformersEntry = requireFromDeps.resolve("@xenova/transformers");
    const transformers: any = await import(pathToFileURL(transformersEntry).href);
    transformers.env.localModelPath = paths.tokenizerDir;
    transformers.env.allowLocalModels = true;
    transformers.env.useBrowserCache = false;
    transformers.env.allowRemoteModels = false;

    // 3. Load gliner
    setStatus("loading", 80, "Loading GLiNER module...");
    let glinerEntry: string;
    try {
      glinerEntry = requireFromDeps.resolve("gliner/node");
    } catch {
      glinerEntry = requireFromDeps.resolve("gliner");
    }
    const glinerMod: any = await import(pathToFileURL(glinerEntry).href);
    const Gliner = glinerMod.Gliner || glinerMod.default?.Gliner;
    if (!Gliner) throw new Error("Gliner export not found in gliner module");

    // 4. Initialize GLiNER with the model
    setStatus("loading", 90, "Initializing ONNX runtime...");
    const gliner = new Gliner({
      tokenizerPath: ".",
      onnxSettings: { modelPath: paths.modelPath },
      maxWidth: def.maxWidth,
      modelType: def.modelType,
      transformersSettings: { allowLocalModels: true, useBrowserCache: false },
    });

    await gliner.initialize();
    _gliner = gliner;
    _activeModelId = modelId;
    _activePresetId = presetId;
    setStatus("ready", 100, `${def.name} ready.`);
  } catch (e: any) {
    _error = String(e);
    setStatus("error", _progressPct, `NER init failed: ${String(e).slice(0, 200)}`);
    console.error(`[LocalNER] Init failed:`, e);
    throw e;
  }
}

// ─── Inference ──────────────────────────────────────────────────────────────

export async function runNer(
  text: string,
  threshold?: number,
  presetOverride?: string,
): Promise<NerEntity[]> {
  if (!_activeModelId) {
    throw new Error("NER not initialized. Call initNer() first.");
  }

  const activeDef = MODEL_REGISTRY[_activeModelId];
  const presetId = presetOverride || _activePresetId;
  const preset = LABEL_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);

  const th = threshold ?? 0.25;

  console.error(`[LocalNER] runNer: text=${text.length} chars, labels=${preset.labels.length}, threshold=${th}, python=${!!activeDef?.pythonOnly}`);
  _calls++;

  try {
    // ── Python path (bi-encoder) ──
    if (activeDef?.pythonOnly && _pythonReady) {
      const resp = await callPython({
        cmd: "predict",
        text,
        labels: preset.labels,
        threshold: th,
      });

      const entities: NerEntity[] = [];
      for (const e of resp.entities || []) {
        const label = (e.label || "").toLowerCase();
        const mappedType = preset.labelMap[label] || label.toUpperCase();
        entities.push({
          text: e.text || "",
          type: mappedType,
          start: e.start ?? 0,
          end: e.end ?? 0,
          score: e.score ?? 0,
          verified: false,
          reason: `ner:${_activeModelId}:${presetId}`,
        });
      }

      _totalEntities += entities.length;
      console.error(`[LocalNER] runNer (Python): returning ${entities.length} entities`);
      return entities;
    }

    // ── ONNX/JS path (span-level) ──
    if (!_gliner) {
      throw new Error("NER not initialized. Call initNer() first.");
    }

    const results = await _gliner.inference({
      texts: [text],
      entities: preset.labels,
      flatNer: true,
      threshold: th,
    });

    console.error(`[LocalNER] runNer: raw results = ${JSON.stringify(results).slice(0, 500)}`);

    const entities: NerEntity[] = [];
    const batch = Array.isArray(results[0]) ? results[0] : results;

    for (const r of batch) {
      const label = (r.label || r.entity || "").toLowerCase();
      const mappedType = preset.labelMap[label] || label.toUpperCase();
      entities.push({
        text: r.spanText || r.text || r.word || "",
        type: mappedType,
        start: r.start ?? 0,
        end: r.end ?? 0,
        score: r.score ?? 0,
        verified: false,
        reason: `ner:${_activeModelId}:${presetId}`,
      });
    }

    _totalEntities += entities.length;
    console.error(`[LocalNER] runNer: returning ${entities.length} entities`);
    return entities;
  } catch (e: any) {
    _lastError = String(e);
    console.error(`[LocalNER] runNer error:`, e);
    throw e;
  }
}

/** Chunked NER for long texts — splits into chunks with overlap */
export async function runNerChunked(
  text: string,
  threshold?: number,
  chunkSize = 800,
  overlap = 100,
): Promise<NerEntity[]> {
  if (text.length <= chunkSize) {
    return runNer(text, threshold);
  }

  console.error(`[LocalNER] chunked: text=${text.length} chars, chunkSize=${chunkSize}, overlap=${overlap}`);
  const allEntities: NerEntity[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(offset + chunkSize, text.length);
    // Break at whitespace to avoid mid-word splits
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > offset + chunkSize / 2) end = lastSpace;
    }

    const chunk = text.slice(offset, end);
    console.error(`[LocalNER] chunk [${offset}:${end}] (${chunk.length} chars)`);

    const chunkEntities = await runNer(chunk, threshold);

    // Offset-shift back to full-text positions
    for (const e of chunkEntities) {
      e.start += offset;
      e.end += offset;
      e.text = text.slice(e.start, e.end);
    }
    allEntities.push(...chunkEntities);

    if (end >= text.length) break;        // processed the last chunk
    offset = end - overlap;
  }

  // Dedup overlapping entities from chunk boundaries
  const seen = new Set<string>();
  return allEntities.filter((e) => {
    const key = `${e.start}:${e.end}:${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Model switching ────────────────────────────────────────────────────────

export async function switchModel(modelId: string): Promise<void> {
  if (modelId === _activeModelId) {
    console.error(`[LocalNER] Model ${modelId} already active`);
    return;
  }
  // Stop existing Python bridge if switching away from a Python model
  if (_pythonReady || _pythonProcess) {
    await stopPythonBridge();
  }
  _gliner = null;
  _activeModelId = null;
  _phase = "idle";
  await initNer(modelId, _activePresetId);
}

export function switchLabels(presetId: string): void {
  if (!LABEL_PRESETS[presetId]) throw new Error(`Unknown preset: ${presetId}`);
  _activePresetId = presetId;
  console.error(`[LocalNER] Switched labels to: ${presetId}`);
}
