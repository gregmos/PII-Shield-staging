/**
 * `pii-shield scan <file>` — preview detected PII without anonymizing.
 */

import fs from "node:fs";
import path from "node:path";
import { initRuntime, getEngine, waitForNer, withAudit } from "../runtime.js";
import { readDocumentText } from "../file-io.js";
import { PATHS } from "../../../src/utils/config.js";
import { confirm } from "../prompts.js";
import { runInstallModel } from "./install-model.js";

interface ScanOptions {
  json?: boolean;
  lang?: string;
  waitNer?: number;
  yes?: boolean;
}

function modelInstalled(): boolean {
  const onnx = path.join(
    PATHS.MODELS_DIR,
    "gliner-pii-base-v1.0",
    "model.onnx",
  );
  if (!fs.existsSync(onnx)) return false;
  return fs.statSync(onnx).size > 100 * 1024 * 1024;
}

export async function runScan(filePath: string, opts: ScanOptions): Promise<number> {
  // Pre-flight: same model check as anonymize. Scan without NER would be
  // patterns-only, missing names/orgs — useless preview.
  if (!modelInstalled()) {
    if (!process.stdin.isTTY && !opts.yes) {
      process.stderr.write(
        "Error: GLiNER model not installed. Run `pii-shield install-model` first.\n",
      );
      return 1;
    }
    const ok = await confirm(
      "GLiNER model not installed (~634 MB). Download now?",
      { defaultValue: true, assumeYes: opts.yes },
    );
    if (!ok) {
      process.stderr.write("Aborted.\n");
      return 1;
    }
    const code = await runInstallModel({ yes: true });
    if (code !== 0) return code;
  }

  initRuntime();

  const waitMs = (opts.waitNer ?? 30) * 1000;
  await waitForNer(waitMs);

  return withAudit("scan_text", { file: filePath, language: opts.lang ?? "en" }, async () => {
    const { text, ext, bytes } = await readDocumentText(filePath);
    const engine = getEngine();
    const entities = await engine.detect(text, opts.lang ?? "en");

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { file: filePath, ext, bytes, char_count: text.length, entities },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    process.stdout.write(`${filePath} — ${text.length} chars, ${entities.length} entities\n\n`);
    if (entities.length === 0) {
      process.stdout.write(`No PII detected.\n`);
      return 0;
    }

    const byType = new Map<string, number>();
    for (const e of entities) {
      byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    }
    process.stdout.write(`Counts by type:\n`);
    for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${t.padEnd(20)} ${n}\n`);
    }

    process.stdout.write(`\nSample entities (first 25):\n`);
    for (const e of entities.slice(0, 25)) {
      const snippet = e.text.length > 50 ? e.text.slice(0, 47) + "..." : e.text;
      process.stdout.write(
        `  [${e.type.padEnd(18)}] ${snippet.padEnd(52)} (score=${e.score.toFixed(2)})\n`,
      );
    }
    if (entities.length > 25) {
      process.stdout.write(`  ... and ${entities.length - 25} more\n`);
    }
    return 0;
  });
}
