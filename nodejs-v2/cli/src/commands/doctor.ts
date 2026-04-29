/**
 * `pii-shield doctor` — health check.
 *
 * Reports on Node version, data dirs, model presence, NER deps, and current
 * NER phase. Designed to be the first command a user runs when they hit
 * trouble — output should make the cause obvious without needing to dig into
 * audit logs.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { initRuntime, getNerStatus } from "../runtime.js";
import { PATHS, VERSION } from "../../../src/utils/config.js";
import { okTag, failTag, gray, yellow, bold } from "../color.js";

const _require = createRequire(import.meta.url);

// onnxruntime-node ships prebuilt native bindings for these platforms.
// Other targets (e.g. linux-armv7, win32-arm64 on older versions, musl-Alpine)
// either compile from source on install or fail outright. Doctor reports
// this so users on unsupported platforms get an actionable diagnosis instead
// of a cryptic "cannot find native binding" error on first anonymize.
const SUPPORTED_PLATFORMS: Record<string, string[]> = {
  darwin: ["x64", "arm64"],
  linux: ["x64", "arm64"],
  win32: ["x64"],
};

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface DoctorReport {
  version: string;
  node_version: string;
  platform: string;
  checks: CheckResult[];
  ner_phase: string;
  ner_progress: number;
  ner_message: string;
  data_dir: string;
  mappings_dir: string;
  models_dir: string;
  ok: boolean;
}

function check(name: string, fn: () => string | null): CheckResult {
  try {
    const detail = fn();
    return detail === null
      ? { name, ok: true, detail: "ok" }
      : { name, ok: false, detail };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message };
  }
}

function isWritable(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.pii_shield_probe_${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    return `${dir} not writable: ${(e as Error).message}`;
  }
}

function checkModel(): string | null {
  const modelDir = path.join(PATHS.MODELS_DIR, "gliner-pii-base-v1.0");
  if (!fs.existsSync(modelDir)) {
    return `model dir missing — run \`pii-shield install-model\``;
  }
  // ner-backend layout: model.onnx + tokenizer files at the dir root (flat).
  const onnx = path.join(modelDir, "model.onnx");
  if (!fs.existsSync(onnx)) {
    return `model.onnx missing in ${modelDir}`;
  }
  const sizeMb = fs.statSync(onnx).size / 1024 / 1024;
  if (sizeMb < 100) {
    return `model.onnx suspiciously small (${sizeMb.toFixed(1)} MB) — corrupt download?`;
  }
  for (const f of ["gliner_config.json", "tokenizer.json"]) {
    if (!fs.existsSync(path.join(modelDir, f))) {
      return `${f} missing in ${modelDir} — model may be incomplete`;
    }
  }
  return null;
}

function checkDeps(): string | null {
  const depsDir = path.join(PATHS.DEPS_DIR, "installs");
  if (!fs.existsSync(depsDir)) {
    return `deps not installed — first anonymize call will install them (~1-2 min)`;
  }
  const entries = fs.readdirSync(depsDir);
  if (entries.length === 0) {
    return `deps dir empty — first anonymize call will install`;
  }
  return null;
}

function checkPlatform(): string | null {
  const supportedArchs = SUPPORTED_PLATFORMS[process.platform];
  if (!supportedArchs) {
    return `unsupported OS '${process.platform}' (supported: ${Object.keys(SUPPORTED_PLATFORMS).join(", ")})`;
  }
  if (!supportedArchs.includes(process.arch)) {
    return `unsupported arch '${process.arch}' on ${process.platform} (supported: ${supportedArchs.join(", ")})`;
  }
  return null;
}

function checkNativeOrt(): string | null {
  // Probe `onnxruntime-node` so doctor can report a clean "missing native
  // binary" message instead of letting first-anonymize crash with a stack
  // trace. Resolved via `createRequire(import.meta.url)` so the bundled
  // CLI (esbuild --external onnxruntime-node) finds the package in the
  // surrounding node_modules.
  try {
    _require.resolve("onnxruntime-node");
  } catch (e) {
    return `onnxruntime-node not resolvable: ${(e as Error).message}`;
  }
  try {
    _require("onnxruntime-node");
  } catch (e) {
    return (
      `onnxruntime-node failed to load on ${process.platform}-${process.arch}: ` +
      `${(e as Error).message}. Reinstall via \`npm install -g pii-shield\` ` +
      `or check that your platform is supported.`
    );
  }
  return null;
}

function checkNodeVersion(): string | null {
  const major = parseInt(process.versions.node.split(".")[0]!, 10);
  if (major < 18) {
    return `Node ${process.versions.node} is too old — need 18+`;
  }
  return null;
}

export async function runDoctor(opts: { json?: boolean }): Promise<number> {
  initRuntime({ skipNer: true });

  const checks: CheckResult[] = [
    check("Node version", checkNodeVersion),
    check("Platform", checkPlatform),
    check("Data dir", () => isWritable(PATHS.DATA_DIR)),
    check("Mappings dir", () => isWritable(PATHS.MAPPINGS_DIR)),
    check("Audit dir", () => isWritable(PATHS.AUDIT_DIR)),
    check("Home dir", () => isWritable(os.homedir())),
    check("Native ORT", checkNativeOrt),
    check("GLiNER model", checkModel),
    check("NER deps", checkDeps),
  ];

  const ner = getNerStatus();
  const allOk = checks.every((c) => c.ok);

  const report: DoctorReport = {
    version: VERSION,
    node_version: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    checks,
    ner_phase: ner.phase,
    ner_progress: ner.progress_pct ?? 0,
    ner_message: ner.message ?? "",
    data_dir: PATHS.DATA_DIR,
    mappings_dir: PATHS.MAPPINGS_DIR,
    models_dir: PATHS.MODELS_DIR,
    ok: allOk,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return allOk ? 0 : 1;
  }

  process.stdout.write(`${bold("PII Shield " + VERSION)} — Node ${process.versions.node} on ${process.platform}-${process.arch}\n`);
  process.stdout.write(gray(`Data dir:     ${PATHS.DATA_DIR}\n`));
  process.stdout.write(gray(`Mappings dir: ${PATHS.MAPPINGS_DIR}\n`));
  process.stdout.write(gray(`Models dir:   ${PATHS.MODELS_DIR}\n\n`));

  for (const c of checks) {
    const mark = c.ok ? okTag() : failTag();
    process.stdout.write(`  [${mark}] ${c.name.padEnd(18)} ${c.detail}\n`);
  }

  process.stdout.write(`\nNER status: ${ner.phase}`);
  if (ner.progress_pct !== undefined) {
    process.stdout.write(` (${ner.progress_pct}%)`);
  }
  if (ner.message) {
    process.stdout.write(` — ${ner.message}`);
  }
  process.stdout.write("\n");

  if (!allOk) {
    process.stdout.write("\n" + yellow("[!]") + " Some checks failed. Run individual commands to fix:\n");
    if (!checks.find((c) => c.name === "GLiNER model")?.ok) {
      process.stdout.write("    pii-shield install-model\n");
    }
  } else {
    process.stdout.write("\n" + okTag().trim() + " All checks passed.\n");
  }

  return allOk ? 0 : 1;
}
