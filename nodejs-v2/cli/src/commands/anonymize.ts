/**
 * `pii-shield anonymize <files...>` — anonymize one or many files.
 *
 * Multi-file batch: all files share one session_id, one PlaceholderState,
 * one mapping pool. Identical entities across files share placeholders.
 *
 * Bypasses the MCP `anonymize_file` handler's chunked-mode guard
 * (src/index.ts:904) by calling PIIEngine.getInstance().anonymizeText
 * directly — engine.detect already chunks NER inference internally
 * via runNerChunkedManual, so passing a >15K-char document with a
 * shared session_id works fine.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getEngine, initRuntime, isNerReady, waitForNer, withAudit, getNerStatus } from "../runtime.js";
import { readDocumentText } from "../file-io.js";
import {
  newSessionId,
  loadSessionState,
  saveSessionState,
  type MappingDocumentEntry,
} from "../../../src/mapping/mapping-store.js";
import { appendDocReview } from "../../../src/mapping/review-store.js";
import {
  createPlaceholderState,
  type PlaceholderState,
} from "../../../src/engine/entity-dedup.js";
import { anonymizeDocx } from "../../../src/docx/docx-anonymizer.js";
import { PATHS } from "../../../src/utils/config.js";
import { createBatchBar } from "../progress.js";
import { confirm } from "../prompts.js";
import { resolveSessionId, SessionLookupError } from "../session-resolve.js";
import { runInstallModel } from "./install-model.js";
import { runReview } from "./review.js";

const PLACEHOLDER_RE = /<[A-Z][A-Z_]*_\d+[a-z]?>/;

function modelInstalled(): boolean {
  const onnx = path.join(
    PATHS.MODELS_DIR,
    "gliner-pii-base-v1.0",
    "model.onnx",
  );
  if (!fs.existsSync(onnx)) return false;
  return fs.statSync(onnx).size > 100 * 1024 * 1024;
}

/**
 * Pre-flight: bail or install before NER would silently degrade to patterns-only.
 * Returns true if the engine should proceed, false if the user opted out.
 */
async function ensureModelOrPrompt(opts: { yes?: boolean }): Promise<boolean> {
  if (modelInstalled()) return true;

  // Non-interactive without --yes: hard fail with actionable message.
  if (!process.stdin.isTTY && !opts.yes) {
    process.stderr.write(
      "Error: GLiNER model not installed. Run `pii-shield install-model` first " +
        "(or pass --yes to auto-install in this run).\n",
    );
    return false;
  }

  const ok = await confirm(
    "GLiNER model not installed (~634 MB). Download now?",
    { defaultValue: true, assumeYes: opts.yes },
  );
  if (!ok) {
    process.stderr.write(
      "Aborted. Run `pii-shield install-model` later, then retry.\n",
    );
    return false;
  }

  const code = await runInstallModel({ yes: true });
  return code === 0;
}

export interface AnonymizeOptions {
  out?: string;
  session?: string;
  /**
   * Commander emits `review: false` when --no-review is passed (and `true`
   * by default). We honour `review === false` as "skip HITL".
   */
  review?: boolean;
  yes?: boolean;
  lang?: string;
  prefix?: string;
  json?: boolean;
}

interface FileResult {
  doc_id: string;
  source_path: string;
  output_path: string;
  docx_output_path?: string;
  entity_count: number;
  bytes: number;
  ext: string;
}

interface PlannedFile {
  source: string;
  ext: string;
  sessionDir: string;
  /** Target text output path. For .docx, paired with `targetDocxOut`. */
  targetTextOut: string;
  targetDocxOut?: string;
}

const SUPPORTED_EXTS = new Set([
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".csv",
  ".log",
  ".html",
  ".htm",
]);

/**
 * Validate every file and compute its target output paths upfront. Fail-fast
 * on missing files / unsupported formats. With `--out`, multiple inputs that
 * share a basename get counter suffixes (`_2`, `_3`, …) to avoid silent
 * overwrites — e.g. `a/case.txt` + `b/case.txt` → `out/case_anonymized.txt`
 * + `out/case_anonymized_2.txt`.
 */
function planBatch(
  files: string[],
  explicitOut: string | null,
  sessionId: string,
): PlannedFile[] {
  const planned: PlannedFile[] = [];
  const used = new Set<string>();

  const claim = (dir: string, base: string, ext: string): string => {
    let candidate = path.join(dir, `${base}_anonymized${ext}`);
    if (!explicitOut) {
      // Per-input-dir mode: collisions across inputs land in different
      // pii_shield_<sid>/ dirs by construction, so no counter needed.
      used.add(candidate);
      return candidate;
    }
    let n = 2;
    while (used.has(candidate)) {
      candidate = path.join(dir, `${base}_anonymized_${n}${ext}`);
      n += 1;
    }
    used.add(candidate);
    return candidate;
  };

  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) {
      throw new Error(`file not found: ${abs}`);
    }
    if (!fs.statSync(abs).isFile()) {
      throw new Error(`not a regular file: ${abs}`);
    }
    const ext = path.extname(abs).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      throw new Error(
        `unsupported format ${ext || "<none>"} for ${abs} (supported: ${[...SUPPORTED_EXTS].join(", ")})`,
      );
    }

    const base = path.basename(abs, ext);
    const sessionDir =
      explicitOut ?? path.join(path.dirname(abs), `pii_shield_${sessionId}`);

    const textExt = ext === ".pdf" ? ".txt" : ext === ".docx" ? ".txt" : ext;
    const targetTextOut = claim(sessionDir, base, textExt);
    const targetDocxOut =
      ext === ".docx" ? claim(sessionDir, base, ".docx") : undefined;

    planned.push({
      source: abs,
      ext,
      sessionDir,
      targetTextOut,
      targetDocxOut,
    });
  }

  return planned;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve("sha256:" + hash.digest("hex")));
  });
}

export async function runAnonymize(
  files: string[],
  opts: AnonymizeOptions,
): Promise<number> {
  if (files.length === 0) {
    process.stderr.write("Error: at least one file required.\n");
    return 2;
  }

  // Pre-flight: ensure NER model is present BEFORE waiting on background load.
  // Otherwise the engine will silently fall back to patterns-only after a
  // 5-minute wait — bad first-run UX.
  const proceed = await ensureModelOrPrompt({ yes: opts.yes });
  if (!proceed) return 1;

  initRuntime();
  const engine = getEngine();
  const lang = opts.lang ?? "en";
  const prefix = opts.prefix ?? "";

  const quiet = process.env.PII_QUIET === "true";

  // Wait up to 5 min for NER (covers warm-cache load + first-run npm ci).
  if (!isNerReady()) {
    if (!quiet) process.stderr.write(`NER model loading...\n`);
    await waitForNer(300_000, (s) => {
      if (s.message && !quiet) {
        process.stderr.write(`  ${s.phase}: ${s.message}\n`);
      }
    });
  }
  if (!isNerReady()) {
    process.stderr.write(
      `[!] NER not ready (${getNerStatus().phase}). Proceeding with patterns-only detection.\n`,
    );
  }

  // Resolve / load session (accepts unique prefix).
  let sessionId: string;
  let state: PlaceholderState;
  let docs: MappingDocumentEntry[];

  if (opts.session) {
    let resolvedSid: string;
    try {
      resolvedSid = resolveSessionId(opts.session);
    } catch (e) {
      const msg = e instanceof SessionLookupError ? e.message : String(e);
      process.stderr.write(`Error: ${msg}\n`);
      return 1;
    }
    const loaded = loadSessionState(resolvedSid);
    if (!loaded) {
      process.stderr.write(`Error: session '${resolvedSid}' could not be loaded.\n`);
      return 1;
    }
    sessionId = resolvedSid;
    state = loaded.state;
    docs = loaded.documents;
    process.stderr.write(
      `Extending session ${sessionId} (${docs.length} prior docs, pool=${Object.keys(state.mapping).length}).\n`,
    );
  } else {
    sessionId = newSessionId();
    state = createPlaceholderState();
    docs = [];
  }

  // Pre-scan textual files for existing placeholder patterns (double-anon
  // detection). PDF / DOCX skipped — re-extracting would double the IO and
  // genuine double-anonymize on those is rare in practice.
  const TEXTUAL_EXT = new Set([".txt", ".md", ".csv", ".log", ".html", ".htm"]);
  if (!opts.yes) {
    const offenders: string[] = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!TEXTUAL_EXT.has(ext)) continue;
      try {
        const text = fs.readFileSync(f, "utf8");
        if (PLACEHOLDER_RE.test(text)) offenders.push(f);
      } catch {
        /* skip — main loop will re-error if file is genuinely unreadable */
      }
    }
    if (offenders.length > 0) {
      process.stderr.write(
        `[!] These files already contain placeholders (possibly already anonymized):\n` +
          offenders.map((f) => `  - ${path.basename(f)}`).join("\n") +
          `\n`,
      );
      const ok = await confirm("Continue anyway?", { defaultValue: false });
      if (!ok) {
        process.stderr.write(`Aborted.\n`);
        return 1;
      }
    }
  }

  // Output directory: --out <dir> or `<input-dir>/pii_shield_<sid>/` per file.
  const explicitOut = opts.out ? path.resolve(opts.out) : null;
  if (explicitOut) {
    fs.mkdirSync(explicitOut, { recursive: true });
  }

  // Preflight: validate every file + compute target output paths up front.
  // Fails BEFORE any anonymized output is written, so a typo in the 5th file
  // doesn't leave docs 1-4 written without a session mapping.
  let planned: PlannedFile[];
  try {
    planned = planBatch(files, explicitOut, sessionId);
  } catch (e) {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const results: FileResult[] = [];
  const showBar = planned.length > 1 && process.stderr.isTTY;
  const bar = showBar ? createBatchBar(planned.length, "Anonymizing") : null;
  bar?.start(planned.length, 0, { filename: "" });

  // try/finally: persist whatever was anonymized so far even if the loop
  // throws halfway. Without this, an unreadable PDF or a parse error could
  // leave anonymized output on disk + a review_*.json without a mapping →
  // deanonymization impossible.
  let loopError: unknown = null;
  try {
    for (let i = 0; i < planned.length; i++) {
      const p = planned[i]!;
      const file = p.source;

      if (!showBar && !quiet) {
        process.stderr.write(`[${i + 1}/${planned.length}] ${path.basename(file)}\n`);
      }

      const docId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
      const anonymizedAt = new Date().toISOString();
      let sourceHash = "";
      try {
        sourceHash = await sha256File(file);
      } catch {
        /* non-fatal */
      }

      fs.mkdirSync(p.sessionDir, { recursive: true });

      if (p.ext === ".docx") {
        const docxResult = await withAudit("anonymize_docx_cli", { file, session_id: sessionId }, async () => {
          return anonymizeDocx(file, lang, prefix, {
            existingSessionId: sessionId,
            sharedState: state,
            sourceHash,
            anonymizedAt,
          });
        });
        // anonymizeDocx writes alongside the source. Move to planned target
        // (handles --out placement + collision-suffix names).
        const sourceTextOut = docxResult.text_output_path as string;
        const sourceDocxOut = docxResult.output_path as string;
        if (sourceTextOut !== p.targetTextOut) {
          fs.copyFileSync(sourceTextOut, p.targetTextOut);
          fs.unlinkSync(sourceTextOut);
        }
        if (p.targetDocxOut && sourceDocxOut !== p.targetDocxOut) {
          fs.copyFileSync(sourceDocxOut, p.targetDocxOut);
          fs.unlinkSync(sourceDocxOut);
        }
        if (explicitOut) {
          const oldDir = path.dirname(sourceTextOut);
          try {
            if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
          } catch { /* ignore */ }
        }
        // anonymizeDocx already mutated `state` via sharedState param.
        docs.push({
          doc_id: docId,
          source_path: file,
          source_hash: sourceHash,
          anonymized_at: anonymizedAt,
        });
        appendDocReview(sessionId, {
          doc_id: docId,
          source_filename: path.basename(file),
          source_file_path: file,
          entities: (docxResult.entities as any[]) ?? [],
          original_text: (docxResult.original_text as string) ?? "",
          anonymized_text: (docxResult.anonymized_text as string) ?? "",
          html_text: (docxResult.html_text as string) ?? "",
          overrides: { remove: [], add: [] },
          approved: false,
          output_dir: path.dirname(p.targetDocxOut!),
          output_path_original: p.targetTextOut,
          docx_output_path_original: p.targetDocxOut!,
          added_at: Date.now(),
        });
        results.push({
          doc_id: docId,
          source_path: file,
          output_path: p.targetTextOut,
          docx_output_path: p.targetDocxOut,
          entity_count: (docxResult.total_entities as number) ?? 0,
          bytes: fs.statSync(file).size,
          ext: p.ext,
        });
      } else {
        const { text } = await readDocumentText(file);
        const result = await withAudit(
          "anonymize_text_cli",
          { file, char_count: text.length, session_id: sessionId },
          async () => engine.anonymizeText(text, lang, prefix, state),
        );
        fs.writeFileSync(p.targetTextOut, result.anonymized, "utf8");

        docs.push({
          doc_id: docId,
          source_path: file,
          source_hash: sourceHash,
          anonymized_at: anonymizedAt,
        });
        appendDocReview(sessionId, {
          doc_id: docId,
          source_filename: path.basename(file),
          source_file_path: file,
          entities: result.entities,
          original_text: text,
          anonymized_text: result.anonymized,
          overrides: { remove: [], add: [] },
          approved: false,
          output_dir: path.dirname(p.targetTextOut),
          output_path_original: p.targetTextOut,
          added_at: Date.now(),
        });
        results.push({
          doc_id: docId,
          source_path: file,
          output_path: p.targetTextOut,
          entity_count: result.entityCount,
          bytes: fs.statSync(file).size,
          ext: p.ext,
        });
      }

      bar?.update(i + 1, { filename: path.basename(file) });
    }
  } catch (e) {
    loopError = e;
  } finally {
    bar?.stop();
    // Always persist whatever we got — even on partial failure — so the
    // already-anonymized files remain deanonymizable.
    if (docs.length > 0) {
      saveSessionState(sessionId, { state, documents: docs });
    }
  }

  if (loopError) {
    const msg = loopError instanceof Error ? loopError.message : String(loopError);
    process.stderr.write(
      `\nError after processing ${results.length}/${planned.length} file(s): ${msg}\n`,
    );
    if (results.length > 0) {
      process.stderr.write(
        `Partial session saved as ${sessionId}. Already-written files remain deanonymizable.\n`,
      );
    }
    return 1;
  }

  if (opts.json) {
    // Machine-friendly structured response — for Python / shell pipelines.
    const report = {
      session_id: sessionId,
      files_count: results.length,
      entity_count: results.reduce((a, r) => a + r.entity_count, 0),
      pool_size: Object.keys(state.mapping).length,
      ner_ready: isNerReady(),
      review_pending: opts.review !== false && process.env.PII_SKIP_REVIEW !== "true",
      results: results.map((r) => ({
        source_path: r.source_path,
        output_path: r.output_path,
        docx_output_path: r.docx_output_path,
        entity_count: r.entity_count,
        ext: r.ext,
        bytes: r.bytes,
        doc_id: r.doc_id,
      })),
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (quiet) {
    // Path-only output (unstructured) — backwards-compatible with --quiet alone.
    for (const r of results) {
      process.stdout.write(`${r.output_path}\n`);
      if (r.docx_output_path) process.stdout.write(`${r.docx_output_path}\n`);
    }
  } else {
    process.stdout.write(`\nSession: ${sessionId}\n`);
    process.stdout.write(
      `${results.length} file(s), ${results.reduce((a, r) => a + r.entity_count, 0)} entities, pool=${Object.keys(state.mapping).length}\n\n`,
    );
    for (const r of results) {
      process.stdout.write(`  ${path.basename(r.source_path)}\n`);
      process.stdout.write(`    -> ${r.output_path}\n`);
      if (r.docx_output_path) {
        process.stdout.write(`    -> ${r.docx_output_path}\n`);
      }
      process.stdout.write(`    ${r.entity_count} entities\n`);
    }
  }

  if (opts.review === false || process.env.PII_SKIP_REVIEW === "true") {
    if (!quiet && !opts.json) {
      process.stdout.write(
        `\nReview skipped. Use \`pii-shield review ${sessionId}\` to open it later.\n`,
      );
    }
    return 0;
  }

  // Hand off to review (HTTP server + browser). Skip the auto-open when
  // --json is set (the script wants paths, not interactive UI).
  if (opts.json) {
    return 0;
  }
  process.stdout.write(`\nOpening review in browser...\n`);
  return runReview(sessionId, { yes: opts.yes });
}
