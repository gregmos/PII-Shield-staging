/**
 * `pii-shield verify <file>` — re-detect PII on an anonymized file.
 *
 * Re-runs the engine over the anonymized output. For every detected
 * entity that is NOT itself a placeholder string from the session's
 * mapping, the file is considered to have a real-PII leak. Useful as a
 * compliance gate after `anonymize` — confirms the output is safe to
 * send to an external LLM.
 *
 * Exit 0 — clean. Exit 1 — possible leak (entities listed). Exit 2 — usage error.
 */

import path from "node:path";
import fs from "node:fs";
import { initRuntime, getEngine, waitForNer, withAudit } from "../runtime.js";
import { readDocumentText } from "../file-io.js";
import { loadMapping } from "../../../src/mapping/mapping-store.js";
import { resolveSessionId, SessionLookupError } from "../session-resolve.js";
import { green, red, yellow, gray, bold } from "../color.js";
import { PATHS } from "../../../src/utils/config.js";
import { confirm } from "../prompts.js";
import { runInstallModel } from "./install-model.js";

const PLACEHOLDER_RE = /^<[A-Z][A-Z_]*_\d+[a-z]?>$/;

interface VerifyOptions {
  session: string;
  json?: boolean;
  lang?: string;
  yes?: boolean;
}

interface Leak {
  text: string;
  type: string;
  start: number;
  end: number;
  context: string;
}

function modelInstalled(): boolean {
  const onnx = path.join(
    PATHS.MODELS_DIR,
    "gliner-pii-base-v1.0",
    "model.onnx",
  );
  return fs.existsSync(onnx) && fs.statSync(onnx).size > 100 * 1024 * 1024;
}

export async function runVerify(filePath: string, opts: VerifyOptions): Promise<number> {
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
    if (!ok) return 1;
    const code = await runInstallModel({ yes: true });
    if (code !== 0) return code;
  }

  initRuntime();
  await waitForNer(60_000);

  let sessionId: string;
  try {
    sessionId = resolveSessionId(opts.session);
  } catch (e) {
    const msg = e instanceof SessionLookupError ? e.message : String(e);
    process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }

  const mapping = loadMapping(sessionId);
  if (!mapping || Object.keys(mapping).length === 0) {
    process.stderr.write(
      `Error: mapping not found for session '${sessionId}'.\n`,
    );
    return 1;
  }
  const placeholderSet = new Set(Object.keys(mapping));

  return withAudit("verify_cli", { file: filePath, session_id: sessionId }, async () => {
    const { text } = await readDocumentText(filePath);
    const engine = getEngine();
    const entities = await engine.detect(text, opts.lang ?? "en");

    const leaks: Leak[] = [];
    for (const e of entities) {
      // Skip if the detected entity IS one of our placeholders. NER may
      // occasionally tag <PERSON_1> as PERSON; pattern recognizers should
      // never match placeholders but defence in depth.
      if (PLACEHOLDER_RE.test(e.text)) continue;
      if (placeholderSet.has(e.text)) continue;

      // Context window: 30 chars either side, single-lined.
      const ctxStart = Math.max(0, e.start - 30);
      const ctxEnd = Math.min(text.length, e.end + 30);
      const context = text
        .slice(ctxStart, ctxEnd)
        .replace(/\s+/g, " ")
        .trim();
      leaks.push({
        text: e.text,
        type: e.type,
        start: e.start,
        end: e.end,
        context: context,
      });
    }

    const report = {
      file: filePath,
      session_id: sessionId,
      char_count: text.length,
      entities_detected: entities.length,
      leaks_found: leaks.length,
      ok: leaks.length === 0,
      leaks,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return leaks.length === 0 ? 0 : 1;
    }

    if (leaks.length === 0) {
      process.stdout.write(
        green("✓") + ` ${bold("verified clean")} — ${gray(filePath)}\n` +
          gray(`  ${entities.length} entities re-detected, all placeholder strings\n`),
      );
      return 0;
    }

    process.stdout.write(
      red("✗") + ` ${bold(`${leaks.length} possible PII leak(s)`)} in ${gray(filePath)}\n\n`,
    );
    for (const l of leaks) {
      const head = `${yellow("[" + l.type.padEnd(18) + "]")} ${bold(l.text)}`;
      process.stdout.write(`  ${head}\n    at offset ${l.start}-${l.end}\n    ${gray("…" + l.context + "…")}\n`);
    }
    process.stdout.write(
      `\nThe LLM-bound output may still contain real PII. Re-anonymize with the --session id, ` +
        `or open \`pii-shield review ${sessionId}\` to add the missed entities.\n`,
    );
    return 1;
  });
}
