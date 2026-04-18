#!/usr/bin/env node

/**
 * PII Shield v2.0.0 — Node.js MCP Server
 * Pure Node.js implementation. No Python dependency.
 *
 * Review UI is rendered in-chat via MCP Apps (io.modelcontextprotocol/ui
 * extension). No HTTP sidecar, no browser fallback.
 */

// @ts-ignore — esbuild rewrites this import to the bundled HTML string at build
// time via `{ loader: { ".html": "text" } }`. The source path is
// dist/ui/review.html (produced by the vite step), NOT the raw ui/review.html.
import REVIEW_HTML from "../dist/ui/review.html";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { VERSION, PATHS, getDataDirSource } from "./utils/config.js";
import { PIIEngine } from "./engine/pii-engine.js";
import { SUPPORTED_ENTITIES } from "./engine/entity-types.js";
import { getNerDiagnostic, getNerError, getNerStats, getNerStatus } from "./engine/ner-backend.js";
import {
  saveMapping, loadMapping, getMappingSafe, newSessionId,
  latestSessionId, cleanupOldMappings,
} from "./mapping/mapping-store.js";
import { getReview, saveReview } from "./mapping/review-store.js";
import { logToolCall, logToolResponse, logToolError, logServer } from "./audit/audit-logger.js";
import {
  registerSidecarTool,
  getSidecarHandler,
  listSidecarTools,
} from "./sidecar/http-sidecar.js";
import {
  startBeacon,
  touchBeaconToolCall,
  setBeaconTools,
  getBeaconFilePath,
} from "./sidecar/bootstrap-beacon.js";
import { CHUNK } from "./utils/config.js";
import { extractPdfText } from "./pdf/pdf-reader.js";
import {
  createChunkSession, getChunkSession, processChunk, finalizeChunkSession,
} from "./chunking/chunk-session.js";
import fs from "node:fs";
import path from "node:path";
import { resolvePath as resolvePathFn, findFile as findFileFn } from "./path-resolution/path-resolver.js";
import { resolveInputPath } from "./path-resolution/auto-resolve.js";
import { anonymizeDocx, anonymizeDocxWithMapping } from "./docx/docx-anonymizer.js";
import { deanonymizeDocx } from "./docx/docx-deanonymizer.js";
import { applyTrackedChanges } from "./docx/docx-redliner.js";
import { assignPlaceholders, deduplicateOverlaps } from "./engine/entity-dedup.js";
import type { DetectedEntity } from "./engine/pattern-recognizers.js";
import { logNer } from "./audit/audit-logger.js";

// Fire the on-disk beacon as EARLY as possible — before any tool
// registrations, before `main()`, before NER init. The rest of module-init
// and `main()` can crash or hang and we still leave behind a
// `/tmp/pii-shield-beacon.json` that says "this server process launched".
// Skill Step 0 uses this as the single most reliable proof-of-life.
try { startBeacon(); } catch { /* beacon must never block server bootstrap */ }

const REVIEW_RESOURCE_URI = "ui://pii-shield/review.html";

// Phase 7b: one-shot flag so the first-run explainer is emitted only on the
// very first `list_entities` loading response per server process. Subsequent
// polls omit `first_run_notice` to keep the envelope tight.
let _firstRunNoticeSent = false;

// ── HITL re-anonymization (Phase 6 Fix 6.4) ──────────────────────────────────
//
// CRITICAL — closes a PII-leak path. The previous build silently ignored
// `review_session_id` on `anonymize_file`, so when Claude was told to
// "re-run anonymize_file with review_session_id" after the user added missed
// entities in HITL, the second call ran fresh detection on the original file,
// missed the same names again, and Claude read a still-leaky output. This
// helper fetches the approved review record, applies overrides directly to
// the entity list (no re-detection), and writes a NEW output file with the
// corrections baked in.

function escapeRegExpForOverride(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a corrected entity list by applying HITL overrides to the original
 * detected entities. `remove` indices reference positions in `baseEntities`.
 * `add` items are user-added entities — we propagate each across the full
 * text via word-boundary scan so every occurrence is covered.
 */
function applyOverridesToEntities(
  text: string,
  baseEntities: Array<{
    text: string; type: string; start: number; end: number;
    score?: number; placeholder?: string;
  }>,
  overrides: { remove?: number[]; add?: Array<{ text: string; type: string; start?: number; end?: number }> },
): DetectedEntity[] {
  const removeSet = new Set(overrides.remove || []);
  const out: DetectedEntity[] = [];
  baseEntities.forEach((e, i) => {
    if (removeSet.has(i)) return;
    out.push({
      text: e.text,
      type: e.type,
      start: e.start,
      end: e.end,
      score: e.score ?? 1.0,
      verified: true,
      reason: "hitl:kept",
    });
  });
  for (const a of overrides.add || []) {
    if (!a.text || a.text.length < 1) continue;
    try {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExpForOverride(a.text)}(?![\\p{L}\\p{N}_])`,
        "giu",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        out.push({
          text: m[0],
          type: a.type,
          start: m.index,
          end: m.index + m[0].length,
          score: 1.0,
          verified: true,
          reason: "hitl:user_added",
        });
        if (m.index === re.lastIndex) re.lastIndex++; // safety against zero-width
      }
    } catch (e) {
      console.error(`[HITL] regex build failed for "${a.text}": ${e}`);
    }
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return deduplicateOverlaps(out);
}

/**
 * Re-anonymize a file using a previously approved HITL review.
 * Reuses review.original_text, applies overrides, writes a NEW output file
 * (different path so the caller is forced to read the corrected version).
 */
async function reanonymizeWithReview(
  resolvedPath: string,
  reviewSessionId: string,
  prefix: string,
): Promise<string> {
  const review = getReview(reviewSessionId);
  if (!review) {
    return JSON.stringify({
      status: "error",
      error: `No review session found: ${reviewSessionId}`,
      hint: "The review may have expired, or `start_review` was never called for this session.",
    }, null, 2);
  }

  // Skill's unconditional re-anonymize flow: on the user's next turn after
  // `start_review`, the skill calls `anonymize_file(path, review_session_id=sid)`
  // regardless of whether the user has clicked Approve yet. We classify the
  // current review state into one of three actionable statuses so the skill
  // doesn't have to inspect the transcript (which is unreliable across hosts).
  if (!review.approved) {
    return JSON.stringify({
      status: "waiting_for_approval",
      session_id: reviewSessionId,
      note:
        "The review panel has not been approved yet. Ask the user to click " +
        "Approve in the panel, then call this tool again.",
    }, null, 2);
  }

  const overrides = review.overrides || { remove: [], add: [] };
  const baseEntities = review.entities || [];
  const removeCount = (overrides.remove || []).length;
  const addCount = (overrides.add || []).length;

  // No-op branch: user clicked Approve without adding or removing anything.
  // Return the ORIGINAL paths from the first anonymize_file call so the
  // skill can proceed immediately without re-running the NER pipeline.
  if (removeCount === 0 && addCount === 0) {
    const origText = review.output_path_original;
    const origDocx = review.docx_output_path_original;
    const inputDir = path.dirname(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    logNer(`[HITL] approved-no-changes for review ${reviewSessionId} — returning original paths`);
    const resp: Record<string, unknown> = {
      status: "approved_no_changes",
      session_id: reviewSessionId,
      note:
        "User approved without edits. Use the original output paths unchanged. " +
        "No re-anonymization needed.",
    };
    if (origText) {
      resp.output_path = origText;
      resp.output_rel_path = path.relative(inputDir, origText).split(path.sep).join("/");
    }
    if (ext === ".docx" && origDocx) {
      resp.docx_output_path = origDocx;
      resp.docx_output_rel_path = path.relative(inputDir, origDocx).split(path.sep).join("/");
    }
    return JSON.stringify(resp, null, 2);
  }

  logNer(`[HITL] applying ${addCount} adds, ${removeCount} removes for review ${reviewSessionId} (base entities: ${baseEntities.length})`);

  const ext = path.extname(resolvedPath).toLowerCase();

  // Build corrected entities from the original text. For .docx we use
  // review.original_text which was the flattened text snapshot at
  // anonymization time (already stored by anonymizeDocx). Same for text files.
  const originalText = review.original_text || "";
  if (!originalText) {
    return JSON.stringify({
      error: `Review ${reviewSessionId} has no original_text snapshot — cannot re-anonymize.`,
    }, null, 2);
  }

  const correctedEntities = applyOverridesToEntities(originalText, baseEntities, overrides);
  const { entities: placed, mapping } = assignPlaceholders(correctedEntities, prefix);

  // Persist the new mapping under the SAME session_id so subsequent
  // deanonymize_text / deanonymize_docx calls keep working transparently.
  saveMapping(reviewSessionId, mapping, { source: resolvedPath });

  // Update the review record so future status checks see the new state.
  review.entities = placed.map((e) => ({
    text: e.text, type: e.type, start: e.start, end: e.end,
    score: e.score, placeholder: e.placeholder || "",
  }));
  saveReview(reviewSessionId, review);

  if (ext === ".docx") {
    // Write the corrected .docx via the existing mapping-applier so formatting
    // is preserved. Use a NEW filename so Claude is forced to read the
    // corrected version (and so a stale path can never sneak through).
    const outDir = (review as any).output_dir || path.dirname(resolvedPath);
    fs.mkdirSync(outDir, { recursive: true });
    const stem = path.basename(resolvedPath, ext);
    const correctedPath = path.join(outDir, `${stem}_anonymized_corrected.docx`);
    await anonymizeDocxWithMapping(resolvedPath, mapping, outDir);
    // anonymizeDocxWithMapping uses `<stem>_anonymized.docx` as its output
    // name; rename to make it explicit this is the HITL-corrected version.
    const defaultOut = path.join(outDir, `${stem}_anonymized.docx`);
    try {
      if (fs.existsSync(defaultOut)) fs.renameSync(defaultOut, correctedPath);
    } catch { /* keep default name on rename failure */ }
    const finalPath = fs.existsSync(correctedPath) ? correctedPath : defaultOut;

    // Phase 7 Fix 7.1: also write the corrected .txt companion. Build it by
    // splicing the NEW placed entities' placeholders into the original text
    // end-to-start. This is the file Claude should Read() for analysis;
    // finalPath (.docx) is for later apply_tracked_changes / deanonymize_docx.
    const sortedForText = [...placed].sort((a, b) => b.start - a.start);
    let correctedText = originalText;
    for (const e of sortedForText) {
      if (!e.placeholder) continue;
      correctedText =
        correctedText.slice(0, e.start) +
        e.placeholder +
        correctedText.slice(e.end);
    }
    const correctedTextPath = path.join(outDir, `${stem}_anonymized_corrected.txt`);
    fs.writeFileSync(correctedTextPath, correctedText, "utf-8");
    // Refresh anonymized_text snapshot so future reviews see the corrected state.
    review.anonymized_text = correctedText;
    saveReview(reviewSessionId, review);

    logNer(`[HITL] re-anonymized .docx → ${finalPath}`);
    logNer(`[HITL] re-anonymized .txt  → ${correctedTextPath} (${correctedText.length} chars)`);
    const inputDir = path.dirname(resolvedPath);
    return JSON.stringify({
      status: "success",
      session_id: reviewSessionId,
      output_path: correctedTextPath,
      output_rel_path: path.relative(inputDir, correctedTextPath).split(path.sep).join("/"),
      docx_output_path: finalPath,
      docx_output_rel_path: path.relative(inputDir, finalPath).split(path.sep).join("/"),
      output_dir: outDir,
      entity_count: placed.length,
      hitl_applied: { remove: removeCount, add: addCount },
      note: "Re-anonymized with HITL overrides. Read output_path (.txt) for analysis — the previous one is stale. docx_output_path is the formatted version for later tracked-changes or deanonymization. Use output_rel_path / docx_output_rel_path if the absolute host path isn't reachable.",
    }, null, 2);
  }

  // Text-style output (.txt/.md/.csv/.pdf): replace from end to start.
  let result = originalText;
  const sorted = [...placed].sort((a, b) => b.start - a.start);
  for (const e of sorted) {
    result = result.slice(0, e.start) + (e.placeholder || "") + result.slice(e.end);
  }

  const outDir = (review as any).output_dir || path.join(path.dirname(resolvedPath), `pii_shield_${reviewSessionId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.basename(resolvedPath, ext);
  const outExt = ext === ".pdf" ? ".txt" : ext;
  const outPath = path.join(outDir, `${stem}_anonymized_corrected${outExt}`);
  fs.writeFileSync(outPath, result, "utf-8");

  // Refresh anonymized_text snapshot for any subsequent review.
  review.anonymized_text = result;
  saveReview(reviewSessionId, review);

  logNer(`[HITL] re-anonymized text → ${outPath}`);
  const inputDirText = path.dirname(resolvedPath);
  return JSON.stringify({
    status: "success",
    session_id: reviewSessionId,
    output_path: outPath,
    output_rel_path: path.relative(inputDirText, outPath).split(path.sep).join("/"),
    output_dir: outDir,
    entity_count: placed.length,
    hitl_applied: { remove: removeCount, add: addCount },
    note: "Re-anonymized with HITL overrides. Read THIS output_path (or output_rel_path joined with the original input's directory) — the previous one is stale.",
  }, null, 2);
}

// ── Plain tool handlers ──────────────────────────────────────────────────────
// Each returns a JSON string that gets wrapped in content[{type:"text"}] by
// wrapPlainTool below.

type ToolArgs = Record<string, unknown>;

async function handleAnonymizeText(args: ToolArgs): Promise<string> {
  const engine = PIIEngine.getInstance();
  const text = args.text as string;
  const language = (args.language as string) || "en";
  const prefix = (args.prefix as string) || "";
  const result = await engine.anonymizeText(text, language, prefix);
  const sessionId = newSessionId();
  saveMapping(sessionId, result.mapping);
  saveReview(sessionId, {
    session_id: sessionId,
    entities: result.entities,
    original_text: text,
    anonymized_text: result.anonymized,
    overrides: { remove: [], add: [] },
    approved: false,
    timestamp: Date.now(),
  });
  const resp: Record<string, unknown> = {
    status: "success",
    anonymized_text: result.anonymized,
    entity_count: result.entityCount,
    session_id: sessionId,
  };
  if (!result.nerUsed) {
    resp.warning = "NER model is still loading (first run downloads ~665 MB). Only pattern-based detection was used. Names, organizations, and locations may be missed. Call list_entities to see progress; re-run once `ner_ready: true` for full coverage.";
  }
  return JSON.stringify(resp, null, 2);
}

async function handleScanText(args: ToolArgs): Promise<string> {
  const engine = PIIEngine.getInstance();
  const text = args.text as string;
  const language = (args.language as string) || "en";
  const entities = await engine.detect(text, language);
  return JSON.stringify({
    status: "success",
    entities: entities.map((e) => ({
      text: e.text, type: e.type, start: e.start, end: e.end, score: e.score,
    })),
    entity_count: entities.length,
  }, null, 2);
}

async function handleDeanonymizeText(args: ToolArgs): Promise<string> {
  const text = args.text as string;
  const sessionId = (args.session_id as string) || latestSessionId() || "";
  const outputPath = (args.output_path as string) || "";
  const mapping = loadMapping(sessionId);
  if (Object.keys(mapping).length === 0) {
    return JSON.stringify({
      error: "no_mapping",
      message: `No mapping found for session '${sessionId}'.`,
    }, null, 2);
  }
  let restored = text;
  const sorted = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
  for (const [placeholder, original] of sorted) {
    restored = restored.replaceAll(placeholder, original);
  }
  if (outputPath) {
    fs.writeFileSync(outputPath, restored, "utf-8");
    return JSON.stringify({
      status: "success",
      message: `Deanonymized text written to ${outputPath}. PII restored locally, never sent to Claude.`,
      output_path: outputPath,
    }, null, 2);
  }
  return JSON.stringify({
    status: "success",
    message: "Deanonymized text returned. WARNING: contains real PII.",
    deanonymized_text: restored,
  }, null, 2);
}

async function handleGetMapping(args: ToolArgs): Promise<string> {
  const sessionId = (args.session_id as string) || latestSessionId() || "";
  const safe = getMappingSafe(sessionId);
  return JSON.stringify({
    status: "success",
    session_id: sessionId,
    placeholders: safe,
    count: Object.keys(safe).length,
    note: "Only placeholder keys and entity types shown. Real PII values are NOT included.",
  }, null, 2);
}

async function handleListEntities(_args: ToolArgs): Promise<string> {
  const engine = PIIEngine.getInstance();
  const latest = latestSessionId();
  const stats = getNerStats();
  const nerStatus = getNerStatus();
  const ready = engine.isNerReady && nerStatus.ready;

  if (!ready && nerStatus.phase !== "error") {
    if (
      nerStatus.phase === "installing_deps" ||
      nerStatus.phase === "loading_model"
    ) {
      // Server-side throttle: while NER is still bootstrapping, hold the
      // response for 20 s before replying. This turns any Claude polling
      // loop into an honest 20-second interval.
      await new Promise((r) => setTimeout(r, 20000));
    }
    const humanMessage = nerStatus.message ||
      "PII Shield NER is initializing (first run only). This takes ~1–2 minutes while onnxruntime + transformers install; the GLiNER model is bundled in the extension so no download is needed.";
    const progressPct = typeof nerStatus.progress_pct === "number"
      ? `${nerStatus.progress_pct}%`
      : "…";

    let firstRunNotice: string | undefined;
    if (!_firstRunNoticeSent) {
      _firstRunNoticeSent = true;
      const dataDir = PATHS.DATA_DIR;
      firstRunNotice =
        "⏳ **First-run setup** — PII Shield is installing runtime dependencies " +
        "(onnxruntime-node, @xenova/transformers, gliner). This takes about 1–2 " +
        "minutes, once. The GLiNER NER model (~665 MB) is already bundled in the " +
        "extension — no runtime download needed. " +
        `Cache location: \`${dataDir}\`. Subsequent runs will be instant.`;
    }

    const envelope: Record<string, unknown> = {
      status: "loading",
      phase: nerStatus.phase,
      progress_pct: nerStatus.progress_pct,
      message: humanMessage,
      retry_after_sec: 20,
      ner_ready: false,
      version: VERSION,
      runtime: "node.js",
      supported_entities: [...SUPPORTED_ENTITIES],
      recent_sessions: latest ? [latest] : [],
      data_dir: PATHS.DATA_DIR,
      data_dir_source: getDataDirSource(),
      user_message:
        `PII Shield is still initializing — ${humanMessage} (${progressPct}). Next poll in 20s.`,
      display_instruction:
        "Print the `user_message` field verbatim to the user as a plain chat message BEFORE calling list_entities again. Do not paraphrase, do not batch, do not skip. Do NOT delegate this polling loop to a sub-agent.",
    };
    if (firstRunNotice) {
      envelope.first_run_notice = firstRunNotice;
      envelope.first_run_display_instruction =
        "Print the `first_run_notice` field verbatim to the user as the very FIRST message before starting the polling loop. This explains where the cache lives. Only sent once per server start.";
    }
    return JSON.stringify(envelope, null, 2);
  }

  const diagnostic = getNerDiagnostic();
  return JSON.stringify({
    status: "ready",
    phase: nerStatus.phase,
    progress_pct: nerStatus.progress_pct,
    version: VERSION,
    runtime: "node.js",
    node_version: process.version,
    ner_ready: ready,
    ner_error: getNerError() || undefined,
    ner_error_diagnostic: diagnostic ?? undefined,
    ner_error_suggestions: diagnostic?.suggested_actions ?? undefined,
    ner_inference_calls: stats.calls,
    ner_total_entities_detected: stats.totalEntities,
    ner_last_inference_error: stats.lastError || undefined,
    supported_entities: [...SUPPORTED_ENTITIES],
    recent_sessions: latest ? [latest] : [],
    data_dir: PATHS.DATA_DIR,
    data_dir_source: getDataDirSource(),
  }, null, 2);
}

async function handleAnonymizeFile(args: ToolArgs): Promise<string> {
  const engine = PIIEngine.getInstance();
  const filePath = args.file_path as string;
  const language = (args.language as string) || "en";
  const prefix = (args.prefix as string) || "";
  const reviewSessionId = ((args.review_session_id as string) || "").trim();

  // Resolve file path via auto-resolve (literal → $PII_WORK_DIR → BFS of
  // common user dirs). No marker ceremony needed on the happy path; if the
  // file is in a non-standard location, the returned `hint` tells the
  // caller to fall back to `resolve_path(filename, marker)`.
  const resolution = resolveInputPath(filePath);
  if (!resolution.ok) {
    return JSON.stringify({
      status: "error",
      error: resolution.error,
      hint: resolution.hint,
      matches: resolution.matches,
    }, null, 2);
  }
  const resolvedPath = resolution.path;

  // HITL re-anonymization branch.
  if (reviewSessionId) {
    return reanonymizeWithReview(resolvedPath, reviewSessionId, prefix);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  let text: string;

  if (ext === ".pdf") {
    try {
      text = await extractPdfText(resolvedPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      return JSON.stringify({
        error: `Failed to read PDF: ${msg}`,
        file: path.basename(resolvedPath),
        file_size_bytes: fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0,
        traceback: stack || null,
      }, null, 2);
    }
  } else if (ext === ".docx") {
    const docxResult = await anonymizeDocx(resolvedPath, language, prefix);
    const sid = docxResult.session_id as string;
    const outDir = path.dirname(docxResult.output_path as string);
    const inputDir = path.dirname(resolvedPath);
    const textOutPath = docxResult.text_output_path as string;
    const docxOutPath = docxResult.output_path as string;

    saveReview(sid, {
      session_id: sid,
      entities: (docxResult.entities as any[]) || [],
      original_text: (docxResult.original_text as string) || "",
      anonymized_text: (docxResult.anonymized_text as string) || "",
      html_text: (docxResult.html_text as string) || "",
      overrides: { remove: [], add: [] },
      approved: false,
      timestamp: Date.now(),
      output_dir: outDir,
      output_path_original: textOutPath,
      docx_output_path_original: docxOutPath,
      source_file_path: resolvedPath,
    });

    return JSON.stringify({
      status: "success",
      session_id: sid,
      entity_count: docxResult.total_entities,
      unique_entities: docxResult.unique_entities,
      output_path: textOutPath,
      output_rel_path: path.relative(inputDir, textOutPath).split(path.sep).join("/"),
      docx_output_path: docxOutPath,
      docx_output_rel_path: path.relative(inputDir, docxOutPath).split(path.sep).join("/"),
      output_dir: outDir,
      by_type: docxResult.by_type,
      processing_time_ms: docxResult.processing_time_ms,
      note: "Read output_path (.txt) for analysis. docx_output_path is the formatted version for later tracked-changes or deanonymization. Use output_rel_path / docx_output_rel_path (relative to the input file's directory) if the absolute host path isn't reachable from your environment (e.g. Cowork VM where only the shared mount is visible).",
    }, null, 2);
  } else if ([".txt", ".md", ".csv", ".log", ".text"].includes(ext)) {
    text = fs.readFileSync(resolvedPath, "utf-8");
  } else {
    return JSON.stringify({
      error: `Unsupported format: ${ext}. Supported: .pdf .docx .txt .md .csv`,
    }, null, 2);
  }

  // Chunked processing for long documents
  if (text.length > CHUNK.THRESHOLD) {
    const chunkSize = 5000;
    logServer(`[Anonymize] Text ${text.length} chars > threshold ${CHUNK.THRESHOLD}, entering chunked mode (chunk_size=${chunkSize})`);

    const { sessionId: chunkSessionId, session: cs } = createChunkSession({
      text,
      chunkSize,
      prefix,
      language,
      sourcePath: resolvedPath,
      sourceSuffix: ext,
      charsPerSec: 0,
      entityOverrides: "",
      docxHtml: null,
    });
    logServer(`[Anonymize] Chunk session ${chunkSessionId}: ${cs.chunks.length} chunks created`);

    return JSON.stringify({
      status: "chunked",
      session_id: chunkSessionId,
      total_chunks: cs.chunks.length,
      processed_chunks: 0,
      progress_pct: 0,
      entities_so_far: 0,
      chunk_size: chunkSize,
      note: "Document is large. Call anonymize_next_chunk(session_id) repeatedly to process each chunk (one per call), then get_full_anonymized_text(session_id) to finalize.",
    }, null, 2);
  }

  // Standard (non-chunked) processing
  logServer(`[Anonymize] Standard mode: ${text.length} chars, running NER...`);
  const result = await engine.anonymizeText(text, language, prefix);
  const sessionId = newSessionId();
  saveMapping(sessionId, result.mapping);

  const outDir = path.join(path.dirname(resolvedPath), `pii_shield_${sessionId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${path.basename(resolvedPath, ext)}_anonymized${ext === ".pdf" ? ".txt" : ext}`);
  fs.writeFileSync(outPath, result.anonymized, "utf-8");

  const inputDir = path.dirname(resolvedPath);
  saveReview(sessionId, {
    session_id: sessionId,
    entities: result.entities,
    original_text: text,
    anonymized_text: result.anonymized,
    overrides: { remove: [], add: [] },
    approved: false,
    timestamp: Date.now(),
    output_dir: outDir,
    output_path_original: outPath,
    source_file_path: resolvedPath,
  });

  const resp: Record<string, unknown> = {
    status: "success",
    session_id: sessionId,
    entity_count: result.entityCount,
    output_path: outPath,
    output_rel_path: path.relative(inputDir, outPath).split(path.sep).join("/"),
    output_dir: outDir,
    note: "Anonymized text written to output_path. Read the file to get the content. Use output_rel_path (relative to the input file's directory) if the absolute host path isn't reachable from your environment.",
  };
  if (!result.nerUsed) {
    resp.warning = "NER model is still loading (first run downloads ~665 MB). Only pattern-based detection was used. Names, organizations, and locations may be missed. Call list_entities to see progress; re-run once `ner_ready: true` for full coverage.";
  }
  return JSON.stringify(resp, null, 2);
}

async function handleAnonymizeNextChunk(args: ToolArgs): Promise<string> {
  const sessionId = args.session_id as string;
  const cs = getChunkSession(sessionId);
  if (!cs) {
    return JSON.stringify({
      error: `Chunk session not found: ${sessionId}`,
      hint: "Session may have expired (30 min TTL) or was already finalized.",
    }, null, 2);
  }

  if (cs.currentChunk >= cs.chunks.length) {
    return JSON.stringify({
      status: "complete",
      session_id: sessionId,
      total_entities: cs.allEntities.length,
      note: "All chunks processed. Call get_full_anonymized_text(session_id) to finalize.",
    }, null, 2);
  }

  const confirmed = await processChunk(sessionId);

  return JSON.stringify({
    status: "processing",
    session_id: sessionId,
    total_chunks: cs.chunks.length,
    processed_chunks: cs.currentChunk,
    progress_pct: Math.round((cs.currentChunk / cs.chunks.length) * 100),
    entities_this_chunk: confirmed.length,
    entities_so_far: cs.allEntities.length,
    note: cs.currentChunk >= cs.chunks.length
      ? "All chunks processed. Call get_full_anonymized_text(session_id) to finalize."
      : "Call anonymize_next_chunk(session_id) to continue.",
  }, null, 2);
}

async function handleGetFullAnonymizedText(args: ToolArgs): Promise<string> {
  const sessionId = args.session_id as string;
  try {
    const result = finalizeChunkSession(sessionId);
    const mappingSessionId = newSessionId();
    saveMapping(mappingSessionId, result.mapping);

    const ext = result.sourceSuffix || ".txt";
    const outDir = path.join(path.dirname(result.sourcePath), `pii_shield_${mappingSessionId}`);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${path.basename(result.sourcePath, ext)}_anonymized${ext === ".pdf" ? ".txt" : ext}`);
    fs.writeFileSync(outPath, result.anonymizedText, "utf-8");

    const reviewData = {
      session_id: mappingSessionId,
      entities: result.entities,
      original_text: result.originalText,
      anonymized_text: result.anonymizedText,
      overrides: { remove: [], add: [] },
      approved: false,
      timestamp: Date.now(),
      output_dir: outDir,
      output_path_original: outPath,
      source_file_path: result.sourcePath,
    };
    saveReview(mappingSessionId, reviewData);
    saveMapping(sessionId, result.mapping);
    saveReview(sessionId, { ...reviewData, session_id: sessionId });

    logServer(`[Chunked] Finalized ${sessionId} → ${mappingSessionId}: ${result.entityCount} entities, output=${outPath}`);

    const inputDir = path.dirname(result.sourcePath);
    return JSON.stringify({
      status: "success",
      session_id: mappingSessionId,
      entity_count: result.entityCount,
      output_path: outPath,
      output_rel_path: path.relative(inputDir, outPath).split(path.sep).join("/"),
      note: "Anonymized text assembled and written to output_path. Use this session_id for start_review. Use output_rel_path (relative to the input file's directory) if the absolute host path isn't reachable.",
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      error: `Failed to finalize: ${e}`,
      hint: "Session may have expired or was already finalized.",
    }, null, 2);
  }
}

async function handleFindFile(args: ToolArgs): Promise<string> {
  const filename = args.filename as string;
  const result = findFileFn(filename);
  return JSON.stringify(result, null, 2);
}

async function handleResolvePath(args: ToolArgs): Promise<string> {
  const filename = args.filename as string;
  const marker = args.marker as string;
  const result = resolvePathFn(filename, marker);
  return JSON.stringify(result, null, 2);
}

async function handleApplyTrackedChanges(args: ToolArgs): Promise<string> {
  const filePath = (args.file_path as string) || "";
  const changesJson = (args.changes as string) || "[]";
  const author = (args.author as string) || "PII Shield";
  const resolution = resolveInputPath(filePath);
  if (!resolution.ok) {
    return JSON.stringify({
      status: "error",
      error: resolution.error,
      hint: resolution.hint,
      matches: resolution.matches,
    }, null, 2);
  }
  const resolved = resolution.path;
  let changes: Array<{ oldText: string; newText: string }>;
  try {
    changes = JSON.parse(changesJson);
  } catch {
    return JSON.stringify({ error: "Invalid JSON in changes parameter" });
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    return JSON.stringify({ error: "changes must be a non-empty array of {oldText, newText}" });
  }
  const outPath = await applyTrackedChanges(resolved, changes, { author });
  const inputDir = path.dirname(resolved);
  return JSON.stringify({
    status: "success",
    output_path: outPath,
    output_rel_path: path.relative(inputDir, outPath).split(path.sep).join("/"),
    changes_applied: changes.length,
    note: "Tracked changes applied. Open in Word to see revision marks (w:del/w:ins). Use output_rel_path (relative to the input file's directory) if the absolute host path isn't reachable.",
  }, null, 2);
}

async function handleAnonymizeDocx(args: ToolArgs): Promise<string> {
  const filePath = (args.file_path as string) || "";
  const language = (args.language as string) || "en";
  const prefix = (args.prefix as string) || "";
  const resolution = resolveInputPath(filePath);
  if (!resolution.ok) {
    return JSON.stringify({
      status: "error",
      error: resolution.error,
      hint: resolution.hint,
      matches: resolution.matches,
    }, null, 2);
  }
  const resolved = resolution.path;
  const result = await anonymizeDocx(resolved, language, prefix);
  const docxSid = result.session_id as string;
  const docxOutDir = path.dirname(result.output_path as string);
  const inputDir = path.dirname(resolved);
  const docxOutPath = result.output_path as string;
  const textOutPath = result.text_output_path as string | undefined;
  saveReview(docxSid, {
    session_id: docxSid,
    entities: (result.entities as any[]) || [],
    original_text: (result.original_text as string) || "",
    html_text: (result.html_text as string) || "",
    overrides: { remove: [], add: [] },
    approved: false,
    timestamp: Date.now(),
    output_dir: docxOutDir,
    output_path_original: textOutPath,
    docx_output_path_original: docxOutPath,
    source_file_path: resolved,
  });
  // Augment the raw result with relative paths so in-VM callers can read
  // without host↔VM string-replace.
  const augmented: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  if (docxOutPath) {
    augmented.docx_output_rel_path = path.relative(inputDir, docxOutPath).split(path.sep).join("/");
  }
  if (textOutPath) {
    augmented.output_rel_path = path.relative(inputDir, textOutPath).split(path.sep).join("/");
  }
  return JSON.stringify(augmented, null, 2);
}

async function handleDeanonymizeDocx(args: ToolArgs): Promise<string> {
  const filePath = (args.file_path as string) || "";
  const sessionId = ((args.session_id as string) || "").trim() || latestSessionId();
  if (!sessionId) {
    return JSON.stringify({ error: "No session. Run anonymize first." });
  }
  const mapping = loadMapping(sessionId);
  if (!mapping) {
    return JSON.stringify({ error: `Mapping not found: ${sessionId}` });
  }
  const resolution = resolveInputPath(filePath);
  if (!resolution.ok) {
    return JSON.stringify({
      status: "error",
      error: resolution.error,
      hint: resolution.hint,
      matches: resolution.matches,
    }, null, 2);
  }
  const resolved = resolution.path;
  const restoredPath = await deanonymizeDocx(resolved, mapping);
  const inputDir = path.dirname(resolved);
  return JSON.stringify({
    restored_path: restoredPath,
    restored_rel_path: path.relative(inputDir, restoredPath).split(path.sep).join("/"),
    session_id: sessionId,
    note: "Restored file written to restored_path. Use restored_rel_path (relative to the input file's directory) if the absolute host path isn't reachable from your environment.",
  }, null, 2);
}

async function handleCleanupCache(args: ToolArgs): Promise<string> {
  const targets = (args.targets as string[]) || ["models", "deps"];
  const doAll = targets.includes("all");
  const dirs: Array<{ name: string; path: string }> = [];
  if (doAll || targets.includes("models")) dirs.push({ name: "models", path: PATHS.MODELS_DIR });
  if (doAll || targets.includes("deps"))    dirs.push({ name: "deps", path: PATHS.DEPS_DIR });
  if (doAll || targets.includes("mappings")) dirs.push({ name: "mappings", path: PATHS.MAPPINGS_DIR });

  let totalFreed = 0;
  const results: Record<string, unknown> = {};

  for (const { name: dirName, path: dirPath } of dirs) {
    try {
      if (!fs.existsSync(dirPath)) {
        results[dirName] = { status: "not_found" };
        continue;
      }
      let dirSize = 0;
      const walkSize = (p: string) => {
        try {
          const entries = fs.readdirSync(p, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) walkSize(full);
            else try { dirSize += fs.statSync(full).size; } catch { /* */ }
          }
        } catch { /* */ }
      };
      walkSize(dirPath);
      fs.rmSync(dirPath, { recursive: true, force: true });
      totalFreed += dirSize;
      results[dirName] = { status: "deleted", bytes_freed: dirSize };
    } catch (e: any) {
      results[dirName] = { status: "error", message: e?.message || String(e) };
    }
  }

  return JSON.stringify({
    status: "ok",
    total_bytes_freed: totalFreed,
    total_mb_freed: Math.round(totalFreed / 1024 / 1024),
    results,
    note: "Models and deps will re-download on next NER call. Restart the server or call list_entities to trigger re-init.",
  }, null, 2);
}

// ── apply_review_overrides (plain tool) ──────────────────────────────────────
// Called from the in-chat iframe with the user's final decisions. No browser
// download, no opaque code — decisions flow straight through as structured args.

async function handleApplyReviewOverrides(args: ToolArgs): Promise<string> {
  const sessionId = (args.session_id as string) || "";
  if (!sessionId) {
    return JSON.stringify({ error: "session_id is required" }, null, 2);
  }
  const overrides = (args.overrides as {
    remove?: number[];
    add?: Array<{ text: string; type: string; start?: number; end?: number }>;
  }) || { remove: [], add: [] };

  const review = getReview(sessionId);
  if (!review) {
    return JSON.stringify({ error: `No review session: ${sessionId}` }, null, 2);
  }

  // Archive decisions next to the per-session output dir for audit trail.
  let archived: string | null = null;
  try {
    const outDir = (review as any).output_dir;
    if (outDir && fs.existsSync(outDir)) {
      archived = path.join(outDir, `review_${sessionId}_decisions.json`);
      fs.writeFileSync(
        archived,
        JSON.stringify({ session_id: sessionId, approved: true, overrides, timestamp: Date.now() }, null, 2),
        "utf-8",
      );
    }
  } catch (e) {
    console.error(`[apply_review_overrides] archive failed: ${e}`);
  }

  // Normalise shape: ReviewData.overrides.add requires concrete start/end
  // (the anonymizer needs character offsets to locate the span), so any
  // entry missing them gets filled from the first occurrence of `text` in
  // the review's original_text. If text is not found, drop the entry rather
  // than persist an unlocatable span.
  const originalText = review.original_text || "";
  const normalisedAdd: Array<{ text: string; type: string; start: number; end: number }> = [];
  for (const a of (overrides.add || [])) {
    let start = typeof a.start === "number" ? a.start : -1;
    let end = typeof a.end === "number" ? a.end : -1;
    if (start < 0 || end < 0) {
      const idx = originalText.indexOf(a.text);
      if (idx < 0) continue;
      start = idx;
      end = idx + a.text.length;
    }
    normalisedAdd.push({ text: a.text, type: a.type, start, end });
  }

  const overridesForReview = {
    remove: overrides.remove || [],
    add: normalisedAdd,
  };
  review.overrides = overridesForReview;
  review.approved = true;
  saveReview(sessionId, review);

  const hasChanges = overridesForReview.remove.length > 0 || overridesForReview.add.length > 0;

  return JSON.stringify({
    status: "applied",
    session_id: sessionId,
    archived_path: archived,
    has_changes: hasChanges,
    remove_count: overridesForReview.remove.length,
    add_count: overridesForReview.add.length,
    note: hasChanges
      ? "Decisions applied. Re-run anonymize_file with review_session_id to regenerate the output using these overrides — discard the previous output_path/session_id."
      : "Decisions applied. The user approved without changes — keep using the existing session_id and output_path.",
  }, null, 2);
}

// ── start_review (MCP Apps tool) ─────────────────────────────────────────────
// Opens the in-chat review iframe. The UI iframe gets the review data via the
// tool's `structuredContent` — no HTTP, no file pickup, no browser.

async function handleStartReview(args: ToolArgs): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}> {
  const singleId = (args.session_id as string) || "";
  const idArr = Array.isArray(args.session_ids)
    ? (args.session_ids as string[]).filter((x) => typeof x === "string" && x.length > 0)
    : [];
  const sessionIds: string[] = idArr.length > 0
    ? idArr
    : (singleId ? [singleId] : (latestSessionId() ? [latestSessionId() as string] : []));

  if (sessionIds.length === 0) {
    const err = {
      status: "error",
      error: "No session to review. Run anonymize_file or anonymize_text first.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
      structuredContent: err,
    };
  }

  const validSessionIds: string[] = [];
  const skippedSessionIds: string[] = [];
  const reviewPayloads: Array<Record<string, unknown>> = [];
  for (const sid of sessionIds) {
    const data = getReview(sid);
    if (!data) {
      skippedSessionIds.push(sid);
      logServer(`[Review] Session ${sid} not found, skipping`);
      continue;
    }
    validSessionIds.push(sid);
    reviewPayloads.push({
      session_id: sid,
      entities: data.entities || [],
      original_text: data.original_text || "",
      anonymized_text: data.anonymized_text || "",
      html_text: (data as any).html_text || "",
      overrides: data.overrides || { remove: [], add: [] },
      approved: !!data.approved,
      source_filename:
        (data as any).source_filename
        || (data as any).original_filename
        || path.basename((data as any).output_path || "")
        || sid,
    });
  }

  if (validSessionIds.length === 0) {
    const err = {
      status: "error",
      error: `No review data found for any session. Tried: ${sessionIds.join(", ")}. Run anonymize_file first.`,
      skipped: skippedSessionIds,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
      structuredContent: err,
    };
  }

  const isBulk = reviewPayloads.length > 1;
  const text = isBulk
    ? `Review panel opened for ${reviewPayloads.length} documents. Review each one in the panel below and click **Approve**. I will NOT read any document until its review is approved.`
    : `Review panel opened for **${reviewPayloads[0].source_filename}**. Click highlights to remove false positives, select text to add missed entities, then click **Approve** at the top of the panel. I will NOT read the document until you approve.`;

  const structured: Record<string, unknown> = {
    status: "review_ready",
    version: VERSION,
    sessions: reviewPayloads,
    count: reviewPayloads.length,
    is_bulk: isBulk,
    skipped_sessions: skippedSessionIds.length > 0 ? skippedSessionIds : undefined,
  };

  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

// ── Tool wrapper — logs + error handling ────────────────────────────────────

// Collected at module init — every call to `wrapPlainTool` appends the tool
// name here. We publish the full list into the beacon on startup so a
// bash-level `cat server_status.json` surfaces all registered tool names
// even when ToolSearch can't see them.
const _registeredToolNames: string[] = [];

function wrapPlainTool(name: string, handler: (args: ToolArgs) => Promise<string>) {
  _registeredToolNames.push(name);

  // Mirror the raw handler into the in-memory tool registry so the CLI
  // modes (`--cli <name>`, `--cli-list`) can invoke it directly without
  // an MCP stdio round-trip. No HTTP binding — that legacy sidecar was
  // removed (racy on Windows, Claude Desktop sometimes spawns two server
  // processes which fought over the bind). See src/sidecar/http-sidecar.ts
  // for the tiny registry that remains.
  registerSidecarTool(name, handler as (args: Record<string, unknown>) => Promise<string>);

  return async (args: ToolArgs) => {
    touchBeaconToolCall(name);
    logToolCall(name, args);
    try {
      const text = await handler(args);
      logToolResponse(name, text);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logToolError(name, error);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: error.message }) }],
        isError: true,
      };
    }
  };
}

// ── McpServer setup ──────────────────────────────────────────────────────────

const server = new McpServer({ name: "PII Shield", version: VERSION });

server.registerTool("find_file", {
  title: "Find file",
  description: "Find a file on the host by filename. Searches the configured working directory only.",
  inputSchema: {
    filename: z.string().describe("Filename to search for"),
  },
}, wrapPlainTool("find_file", handleFindFile));

server.registerTool("anonymize_text", {
  title: "Anonymize text",
  description: "Anonymize PII in text",
  inputSchema: {
    text: z.string().describe("Text to anonymize"),
    language: z.string().default("en").describe("Language code"),
    prefix: z.string().default("").describe("Prefix for placeholders (e.g. 'D1' for multi-file)"),
    entity_overrides: z.string().default("").describe("JSON overrides for entity types"),
  },
}, wrapPlainTool("anonymize_text", handleAnonymizeText));

server.registerTool("anonymize_file", {
  title: "Anonymize file",
  description:
    "Anonymize PII in a file (.pdf, .docx, .txt, .md, .csv). PREFERRED — PII stays on host. " +
    "Pass review_session_id for HITL re-anonymization (server applies overrides internally).",
  inputSchema: {
    file_path: z.string().describe("Path to the file to anonymize"),
    language: z.string().default("en").describe("Language code"),
    prefix: z.string().default("").describe("Prefix for placeholders"),
    review_session_id: z.string().default("").describe("Session ID from HITL review for re-anonymization"),
  },
}, wrapPlainTool("anonymize_file", handleAnonymizeFile));

server.registerTool("anonymize_docx", {
  title: "Anonymize .docx",
  description: "Anonymize PII in .docx preserving formatting",
  inputSchema: {
    file_path: z.string().describe("Path to .docx file"),
    language: z.string().default("en").describe("Language code"),
    prefix: z.string().default("").describe("Prefix for placeholders"),
  },
}, wrapPlainTool("anonymize_docx", handleAnonymizeDocx));

server.registerTool("deanonymize_text", {
  title: "Deanonymize text",
  description: "Restore PII to local .docx file (never returns PII to Claude)",
  inputSchema: {
    text: z.string().describe("Anonymized text to restore"),
    session_id: z.string().default("").describe("Session ID for mapping lookup"),
    output_path: z.string().default("").describe("Output file path"),
  },
}, wrapPlainTool("deanonymize_text", handleDeanonymizeText));

server.registerTool("deanonymize_docx", {
  title: "Deanonymize .docx",
  description: "Restore PII in .docx preserving formatting (file only)",
  inputSchema: {
    file_path: z.string().describe("Path to anonymized .docx"),
    session_id: z.string().default("").describe("Session ID for mapping lookup"),
  },
}, wrapPlainTool("deanonymize_docx", handleDeanonymizeDocx));

server.registerTool("get_mapping", {
  title: "Get mapping",
  description: "Get placeholder keys and types (no real PII values)",
  inputSchema: {
    session_id: z.string().default("").describe("Session ID"),
  },
}, wrapPlainTool("get_mapping", handleGetMapping));

server.registerTool("scan_text", {
  title: "Scan text",
  description: "Detect PII without anonymizing (preview mode)",
  inputSchema: {
    text: z.string().describe("Text to scan"),
    language: z.string().default("en").describe("Language code"),
  },
}, wrapPlainTool("scan_text", handleScanText));

server.registerTool("list_entities", {
  title: "List entities",
  description: "Show status, supported types, and recent sessions",
  inputSchema: {},
}, wrapPlainTool("list_entities", handleListEntities));

server.registerTool("anonymize_next_chunk", {
  title: "Anonymize next chunk",
  description:
    "Process next chunk of a chunked anonymization session. Returns progress and partial result.",
  inputSchema: {
    session_id: z.string().describe("Chunked session ID"),
  },
}, wrapPlainTool("anonymize_next_chunk", handleAnonymizeNextChunk));

server.registerTool("get_full_anonymized_text", {
  title: "Finalize chunked anonymization",
  description:
    "Assemble all processed chunks and finalize the anonymization. Returns output_path and session_id.",
  inputSchema: {
    session_id: z.string().describe("Chunked session ID"),
  },
}, wrapPlainTool("get_full_anonymized_text", handleGetFullAnonymizedText));

server.registerTool("apply_tracked_changes", {
  title: "Apply tracked changes",
  description:
    "Apply tracked changes (redline) to a .docx file. Creates Word-native w:del/w:ins revision marks. For REDLINE mode.",
  inputSchema: {
    file_path: z.string().describe("Path to the .docx file to apply changes to"),
    changes: z.string().describe(
      "JSON array of {oldText, newText} changes. Each change wraps old text in deletion marks and adds new text as insertion.",
    ),
    author: z.string().default("PII Shield").describe("Author name for revision marks"),
  },
}, wrapPlainTool("apply_tracked_changes", handleApplyTrackedChanges));

server.registerTool("apply_review_overrides", {
  title: "Apply review overrides",
  description:
    "Apply the user's HITL review decisions (typically called by the in-chat review iframe on Approve). " +
    "Takes `session_id` and an `overrides` object with `remove` (indices) and `add` (new entities).",
  inputSchema: {
    session_id: z.string().describe("Review session id"),
    overrides: z.object({
      remove: z.array(z.number()).optional(),
      add: z.array(z.object({
        text: z.string(),
        type: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
      })).optional(),
    }).default({}).describe("User's add/remove decisions from the review panel"),
  },
}, wrapPlainTool("apply_review_overrides", handleApplyReviewOverrides));

server.registerTool("resolve_path", {
  title: "Resolve path",
  description:
    "Zero-config file path resolution. Finds a marker file on host via BFS to locate the workspace.",
  inputSchema: {
    filename: z.string().describe("Filename to resolve"),
    marker: z.string().describe("Marker filename for BFS search"),
  },
}, wrapPlainTool("resolve_path", handleResolvePath));

server.registerTool("cleanup_cache", {
  title: "Cleanup cache",
  description:
    "Delete PII Shield cache (models ~665MB, deps, mappings) to free disk space. Returns bytes freed. Does NOT delete audit logs.",
  inputSchema: {
    targets: z.array(z.enum(["models", "deps", "mappings", "all"])).default(["models", "deps"]).describe(
      'What to delete: "models" (~665MB), "deps" (~150MB), "mappings" (session data), or "all".',
    ),
  },
}, wrapPlainTool("cleanup_cache", handleCleanupCache));

// ── start_review — MCP Apps tool (renders iframe in chat) ────────────────────

registerAppTool(server,
  "start_review",
  {
    title: "Open HITL review panel",
    description:
      "Open the in-chat HITL review panel for one or more anonymization sessions. " +
      "The panel renders directly in the chat (MCP Apps io.modelcontextprotocol/ui extension); " +
      "no browser, no local HTTP server. User reviews entities, clicks Approve, and the panel " +
      "calls apply_review_overrides internally with their decisions. For a single document, pass " +
      "`session_id`. For BULK mode, pass `session_ids` (array) and the panel switches between tabs.",
    inputSchema: {
      session_id: z.string().default("").describe("Single session id to review"),
      session_ids: z.array(z.string()).default([]).describe("Multiple session ids (BULK mode)"),
    },
    _meta: {
      ui: { resourceUri: REVIEW_RESOURCE_URI },
    },
  },
  async (args) => {
    const toolArgs = (args || {}) as ToolArgs;
    touchBeaconToolCall("start_review");
    logToolCall("start_review", toolArgs);
    try {
      const result = await handleStartReview(toolArgs);
      logToolResponse("start_review", JSON.stringify(result.structuredContent));
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logToolError("start_review", error);
      const errPayload = { status: "error", error: error.message };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(errPayload, null, 2) }],
        structuredContent: errPayload,
        isError: true,
      };
    }
  },
);

// ── Review UI resource ───────────────────────────────────────────────────────

registerAppResource(server,
  "PII Shield Review UI",
  REVIEW_RESOURCE_URI,
  {
    description: "Interactive HITL review panel for PII Shield",
    mimeType: RESOURCE_MIME_TYPE,
  },
  async (uri) => {
    return {
      contents: [
        {
          uri: REVIEW_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: REVIEW_HTML as unknown as string,
        },
      ],
    };
  },
);

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// Prevent NER background init crashes from killing the MCP server.
// @xenova/transformers can throw uncaught RangeError (stack overflow) during init,
// outside our try/catch. Log and continue — patterns mode still works.
process.on("uncaughtException", (err) => {
  const msg = `[UNCAUGHT] ${err.stack || err}`;
  try {
    const logDir = PATHS.AUDIT_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "ner_init.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* */ }
  console.error(msg);
});
process.on("unhandledRejection", (reason) => {
  const msg = `[UNHANDLED] ${reason}`;
  try {
    const logDir = PATHS.AUDIT_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "ner_init.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* */ }
  console.error(msg);
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const earlyLog = (msg: string) => {
    try { (globalThis as any).__earlyLog?.(msg); } catch { /* */ }
  };

  earlyLog("[main] enter");

  // Connect transport FIRST so the MCP `initialize` handshake completes and
  // tools register before any best-effort startup work runs.
  earlyLog("[main] before server.connect");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  earlyLog("[main] server connected");
  console.error(`[PII Shield v${VERSION}] MCP server running on stdio.`);

  // Diagnostic: write startup marker so we can verify the process is invoked.
  earlyLog("[main] before startup.log diag write");
  try {
    const diagDir = PATHS.DATA_DIR;
    fs.mkdirSync(diagDir, { recursive: true });
    fs.writeFileSync(path.join(diagDir, "startup.log"),
      `[${new Date().toISOString()}] PII Shield v${VERSION} starting\n` +
      `node=${process.version} platform=${process.platform} arch=${process.arch}\n` +
      `cwd=${process.cwd()}\n` +
      `argv=${JSON.stringify(process.argv)}\n` +
      `data_dir=${PATHS.DATA_DIR}\n` +
      `data_dir_source=${getDataDirSource()}\n` +
      `models_dir=${PATHS.MODELS_DIR}\n` +
      `deps_dir=${PATHS.DEPS_DIR}\n`,
    );
    console.error(
      `[PII Shield] data_dir=${PATHS.DATA_DIR} (source: ${getDataDirSource()})`,
    );
  } catch (e) { earlyLog("[main] startup.log diag failed: " + e); }

  // Cleanup expired mappings on startup
  earlyLog("[main] before cleanupOldMappings");
  try { cleanupOldMappings(); }
  catch (e) { earlyLog("[main] cleanupOldMappings failed: " + e); }

  // Start the on-disk bootstrap beacon BEFORE anything else that could
  // influence its fields. The first write captures pid + started_at; later
  // writes (heartbeat + phase changes) overlay NER / tool-call state. The
  // skill reads this file via Bash when MCP tool discovery is still warming
  // up — it's the last-line-of-defence diagnostic.
  earlyLog("[main] before startBeacon");
  try {
    startBeacon();
    setBeaconTools(_registeredToolNames);
    earlyLog(`[main] beacon writing to ${getBeaconFilePath()}`);
  } catch (e) { earlyLog("[main] startBeacon failed: " + e); }

  // Start NER model download/init in background (doesn't block server startup).
  // The model-download step is protected by an inter-process lockfile so that
  // if Claude Desktop spawns two pii-shield instances simultaneously they
  // serialize cleanly instead of racing on the cache file — see
  // ensureModelFiles() in engine/ner-backend.ts.
  earlyLog("[main] before startNerBackground");
  try { PIIEngine.getInstance().startNerBackground(); }
  catch (e) { earlyLog("[main] startNerBackground failed: " + e); }

  earlyLog("[main] startup complete");
}

// All tool registrations have completed at this point (they were all at
// module-init above). Publish the full tool list into the beacon NOW so it
// lands in `server_status.json` regardless of which path we take below
// (CLI one-shot vs main() stdio server). If we deferred this to inside
// main(), CLI invocations would leave `tools: []` in the beacon and
// mislead diagnostic readers.
try { setBeaconTools(_registeredToolNames); } catch { /* non-fatal */ }

/**
 * CLI mode — the ultimate escape hatch.
 *
 * Invocation:
 *   node server.bundle.mjs --cli <tool_name> '<json_args>'
 *   node server.bundle.mjs --cli list_entities
 *   node server.bundle.mjs --cli anonymize_file '{"file_path":"/path/doc.docx"}'
 *   node server.bundle.mjs --cli-list   # print registered tool names
 *   node server.bundle.mjs --cli-status # print beacon JSON to stdout
 *
 * This runs the tool handler directly — no MCP stdio, no `server.connect`.
 * Used by the skill's Step 0 bash fallback when the CLI's MCP tool discovery
 * is broken for plugin-provided servers (known Cowork bug:
 * github.com/anthropics/claude-code/issues/40106). All tool registrations
 * above this point have already populated the in-memory tool registry at
 * module-init time, so handlers are ready to invoke.
 */
const _argv = process.argv;
const _cliListIdx = _argv.indexOf("--cli-list");
const _cliStatusIdx = _argv.indexOf("--cli-status");
const _cliIdx = _argv.indexOf("--cli");

if (_cliListIdx !== -1) {
  process.stdout.write(JSON.stringify({ tools: listSidecarTools() }, null, 2) + "\n");
  process.exit(0);
}

if (_cliStatusIdx !== -1) {
  // Beacon was already started at module-init (see `startBeacon()` call at
  // the top of imports). Just dump its current in-memory state.
  import("./sidecar/bootstrap-beacon.js").then(({ getBeaconState }) => {
    process.stdout.write(JSON.stringify(getBeaconState(), null, 2) + "\n");
    process.exit(0);
  });
} else if (_cliIdx !== -1) {
  const toolName = _argv[_cliIdx + 1];
  const argsJson = _argv[_cliIdx + 2] || "{}";
  if (!toolName) {
    process.stderr.write(
      `[CLI] usage: node server.bundle.mjs --cli <tool_name> [<json_args>]\n` +
      `[CLI] known tools: ${listSidecarTools().join(", ")}\n`,
    );
    process.exit(2);
  }
  (async () => {
    try {
      const args = JSON.parse(argsJson);
      const handler = getSidecarHandler(toolName);
      if (!handler) {
        process.stderr.write(
          `[CLI] tool not found: ${toolName}\n` +
          `[CLI] known tools: ${listSidecarTools().join(", ")}\n`,
        );
        process.exit(3);
      }
      touchBeaconToolCall(toolName);
      const text = await handler(args as Record<string, unknown>);
      process.stdout.write(text + "\n");
      process.exit(0);
    } catch (e) {
      process.stderr.write(
        `[CLI] execution failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exit(1);
    }
  })();
} else {
  main().catch((err) => {
    console.error("[PII Shield] Fatal:", err);
    process.exit(1);
  });
}
