#!/usr/bin/env node

/**
 * PII Shield v2.0.0 — Node.js MCP Server
 * Pure Node.js implementation. No Python dependency.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION, PATHS, isCowork, findCoworkWorkspace, getDataDirSource, displayCacheDir, setWorkspaceHint } from "./utils/config.js";
import { PIIEngine } from "./engine/pii-engine.js";
import { SUPPORTED_ENTITIES } from "./engine/entity-types.js";
import { getNerError, getNerStats, getNerStatus } from "./engine/ner-backend.js";
import { sidecarStatus } from "./engine/adeu-sidecar.js";
import {
  saveMapping, loadMapping, getMappingSafe, newSessionId,
  latestSessionId, cleanupOldMappings,
} from "./mapping/mapping-store.js";
import { getReview, getReviewStatus, saveReview, type ReviewData } from "./mapping/review-store.js";
import { logToolCall, logToolResponse, logToolError, logServer } from "./audit/audit-logger.js";
import { CHUNK } from "./utils/config.js";
import { extractPdfText } from "./pdf/pdf-reader.js";
import {
  createChunkSession, getChunkSession, processChunk, finalizeChunkSession,
} from "./chunking/chunk-session.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { startReviewServer, openBrowser } from "./review/review-server.js";
import { resolvePath as resolvePathFn, findFile as findFileFn } from "./path-resolution/path-resolver.js";
import { anonymizeDocx, anonymizeDocxWithMapping } from "./docx/docx-anonymizer.js";
import { deanonymizeDocx } from "./docx/docx-deanonymizer.js";
import { applyTrackedChanges } from "./docx/docx-redliner.js";
import { assignPlaceholders, deduplicateOverlaps } from "./engine/entity-dedup.js";
import type { DetectedEntity } from "./engine/pattern-recognizers.js";
import { logNer } from "./audit/audit-logger.js";

// Phase 7b: one-shot flag so the first-run explainer is emitted only on the
// very first `list_entities` loading response per server process. Subsequent
// polls omit `first_run_notice` to keep the envelope tight.
let _firstRunNoticeSent = false;

// ── Tool definitions (API contract — identical to Python server) ─────────────

const TOOLS = [
  {
    name: "find_file",
    description:
      "Find a file on the host by filename. Searches the configured working directory only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename to search for" },
      },
      required: ["filename"],
    },
  },
  {
    name: "anonymize_text",
    description: "Anonymize PII in text",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to anonymize" },
        language: { type: "string", description: "Language code", default: "en" },
        prefix: {
          type: "string",
          description: "Prefix for placeholders (e.g. 'D1' for multi-file)",
          default: "",
        },
        entity_overrides: {
          type: "string",
          description: "JSON overrides for entity types",
          default: "",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "anonymize_file",
    description:
      "Anonymize PII in a file (.pdf, .docx, .txt, .md, .csv). PREFERRED — PII stays on host. Pass review_session_id for HITL re-anonymization (server applies overrides internally).",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Path to the file to anonymize" },
        language: { type: "string", description: "Language code", default: "en" },
        prefix: { type: "string", description: "Prefix for placeholders", default: "" },
        review_session_id: {
          type: "string",
          description: "Session ID from HITL review for re-anonymization",
          default: "",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "anonymize_docx",
    description: "Anonymize PII in .docx preserving formatting",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Path to .docx file" },
        language: { type: "string", description: "Language code", default: "en" },
        prefix: { type: "string", description: "Prefix for placeholders", default: "" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "deanonymize_text",
    description: "Restore PII to local .docx file (never returns PII to Claude)",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Anonymized text to restore" },
        session_id: {
          type: "string",
          description: "Session ID for mapping lookup",
          default: "",
        },
        output_path: { type: "string", description: "Output file path", default: "" },
      },
      required: ["text"],
    },
  },
  {
    name: "deanonymize_docx",
    description: "Restore PII in .docx preserving formatting (file only)",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Path to anonymized .docx" },
        session_id: {
          type: "string",
          description: "Session ID for mapping lookup",
          default: "",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_mapping",
    description: "Get placeholder keys and types (no real PII values)",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session ID", default: "" },
      },
      required: [],
    },
  },
  {
    name: "scan_text",
    description: "Detect PII without anonymizing (preview mode)",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to scan" },
        language: { type: "string", description: "Language code", default: "en" },
      },
      required: ["text"],
    },
  },
  {
    name: "list_entities",
    description: "Show status, supported types, and recent sessions",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "start_review",
    description:
      "Generate a self-contained HITL review HTML at the workspace root for one or more anonymization sessions. For a single document, pass `session_id`. For BULK mode, pass `session_ids` (array) and one HTML per session is emitted. **In Cowork, you MUST pass `host_workspace_dir`** (the host-form path from `resolve_path(marker).host_dir`) — the VM's `/sessions/.../mnt/...` path is useless to the user, and the JSON-in-Downloads pickup only works when the user drops the decisions file into the workspace folder (the only shared path between VM and host). Returns the path(s) and a `user_message` Claude MUST relay verbatim.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Single session id to review", default: "" },
        session_ids: {
          type: "array",
          items: { type: "string" },
          description: "Multiple session ids (BULK mode). One review HTML per session.",
          default: [],
        },
        host_workspace_dir: {
          type: "string",
          description: "Host-form path of the workspace folder (from `resolve_path(marker).host_dir`). In Cowork this is the user's actual host path like `C:\\Users\\User\\Cowork SPA Test`, NOT the `/sessions/.../mnt/...` VM path. Displayed to the user and used as the primary drop location for the decisions JSON. Strongly recommended; the server falls back to the VM path if omitted.",
          default: "",
        },
      },
      required: [],
    },
  },
  {
    name: "get_review_status",
    description:
      "Check if user approved the HITL review. Returns status and has_changes only (no PII or override details).",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session ID", default: "" },
      },
      required: [],
    },
  },
  {
    name: "anonymize_next_chunk",
    description:
      "Process next chunk of a chunked anonymization session. Returns progress and partial result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Chunked session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_full_anonymized_text",
    description:
      "Assemble all processed chunks and finalize the anonymization. Returns output_path and session_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Chunked session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "apply_tracked_changes",
    description:
      "Apply tracked changes (redline) to a .docx file. Creates Word-native w:del/w:ins revision marks. For REDLINE mode.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Path to the .docx file to apply changes to" },
        changes: {
          type: "string",
          description: "JSON array of {oldText, newText} changes. Each change wraps old text in deletion marks and adds new text as insertion.",
        },
        author: { type: "string", description: "Author name for revision marks", default: "PII Shield" },
      },
      required: ["file_path", "changes"],
    },
  },
  {
    name: "apply_review_decisions",
    description:
      "Apply the user's HITL review decisions. Two input modes: (1) pass `decisions_code` — the opaque PII_DECISIONS_v1:... blob the user copied from the review page (works in Cowork's sandboxed file viewer where downloads are blocked); (2) omit `decisions_code` and the server will look up the downloaded review_<session_id>_decisions.json by filename via find_file. Call this after the user clicks Approve in the review page and either pastes the code or says they're done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Review session id" },
        decisions_code: {
          type: "string",
          description: "Opaque PII_DECISIONS_v1 code copied from the review page (preferred — works everywhere). Optional; if absent, the server falls back to file lookup.",
          default: "",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "resolve_path",
    description:
      "Zero-config file path resolution. Finds a marker file on host via BFS to map VM paths to host paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename to resolve" },
        marker: { type: "string", description: "Marker filename for BFS search" },
        vm_dir: {
          type: "string",
          description: "VM directory path (optional)",
          default: "",
        },
      },
      required: ["filename", "marker"],
    },
  },
  {
    name: "collect_debug_logs",
    description:
      "Package all PII Shield debug logs (audit dir + diagnostics) into a ZIP at the workspace root so the user can download it. Use when the user asks to 'dump logs' or via the /pii-debug-logs slash command.",
    inputSchema: {
      type: "object" as const,
      properties: {
        output_dir: {
          type: "string",
          description: "Directory to write the ZIP into. Defaults to process.cwd() (workspace root).",
          default: "",
        },
      },
    },
  },
  {
    name: "cleanup_cache",
    description:
      "Delete PII Shield cache (models ~665MB, deps, mappings) to free disk space. Use when the VM is running out of disk. Returns bytes freed. Does NOT delete audit logs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        targets: {
          type: "array",
          items: { type: "string", enum: ["models", "deps", "mappings", "all"] },
          description: 'What to delete: "models" (~665MB), "deps" (~150MB), "mappings" (session data), or "all". Default: ["models", "deps"].',
          default: ["models", "deps"],
        },
      },
    },
  },
];

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
      error: `No review session found: ${reviewSessionId}`,
      hint: "The review may have expired, or apply_review_decisions was never called.",
    }, null, 2);
  }
  if (!review.approved) {
    return JSON.stringify({
      error: `Review ${reviewSessionId} is not approved yet.`,
      hint: "Call apply_review_decisions first, or ask the user to click Approve in the review HTML.",
    }, null, 2);
  }

  const overrides = review.overrides || { remove: [], add: [] };
  const baseEntities = review.entities || [];
  const removeCount = (overrides.remove || []).length;
  const addCount = (overrides.add || []).length;
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
    // corrected file (and so a stale path can never sneak through).
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
    return JSON.stringify({
      status: "success",
      session_id: reviewSessionId,
      output_path: correctedTextPath,
      docx_output_path: finalPath,
      output_dir: outDir,
      entity_count: placed.length,
      hitl_applied: { remove: removeCount, add: addCount },
      note: "Re-anonymized with HITL overrides. Read output_path (.txt) for analysis — the previous one is stale. docx_output_path is the formatted version for later tracked-changes or deanonymization.",
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
  return JSON.stringify({
    status: "success",
    session_id: reviewSessionId,
    output_path: outPath,
    output_dir: outDir,
    entity_count: placed.length,
    hitl_applied: { remove: removeCount, add: addCount },
    note: "Re-anonymized with HITL overrides. Read THIS output_path — the previous one is stale and contains the un-corrected entities.",
  }, null, 2);
}

// ── Tool handler dispatch ────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

async function handleToolCall(name: string, args: ToolArgs): Promise<string> {
  // Workspace hint: re-pin data dir from file paths if currently in a generic fallback
  const wsHint = (args.file_path || args.output_path) as string | undefined;
  if (wsHint) setWorkspaceHint(wsHint);

  const engine = PIIEngine.getInstance();

  switch (name) {
    case "anonymize_text": {
      const text = args.text as string;
      const language = (args.language as string) || "en";
      const prefix = (args.prefix as string) || "";
      const result = await engine.anonymizeText(text, language, prefix);
      const sessionId = newSessionId();
      saveMapping(sessionId, result.mapping);
      // Save review data for HITL review
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

    case "scan_text": {
      const text = args.text as string;
      const language = (args.language as string) || "en";
      const entities = await engine.detect(text, language);
      return JSON.stringify({
        status: "success",
        entities: entities.map((e) => ({
          text: e.text, type: e.type, start: e.start, end: e.end,
          score: e.score,
        })),
        entity_count: entities.length,
      }, null, 2);
    }

    case "deanonymize_text": {
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
      // Replace placeholders with original text (longest first to avoid partial matches)
      let restored = text;
      const sorted = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
      for (const [placeholder, original] of sorted) {
        restored = restored.replaceAll(placeholder, original);
      }
      // Write to file if output_path specified
      if (outputPath) {
        const fs = await import("node:fs");
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

    case "get_mapping": {
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

    case "list_entities": {
      const latest = latestSessionId();
      const stats = getNerStats();
      const nerStatus = getNerStatus();
      const ready = engine.isNerReady && nerStatus.ready;

      // While NER is still bootstrapping (first-run deps install or model
      // download), return a `loading` envelope with phase + progress so Claude
      // can surface useful feedback to the user instead of the previous blind
      // `ner_ready: false` with no explanation.
      if (!ready && nerStatus.phase !== "error") {
        // Server-side throttle: while NER is still bootstrapping, hold the
        // response for 20 s before replying. This turns any Claude polling
        // loop into an honest 20-second interval — even if the model calls
        // list_entities back-to-back, it physically cannot get a faster
        // cadence than the server allows. Prevents the "50 seconds, 20
        // polls, still 8%" behaviour without relying on Claude's discipline.
        if (
          nerStatus.phase === "installing_deps" ||
          nerStatus.phase === "downloading_model" ||
          nerStatus.phase === "loading_model"
        ) {
          await new Promise((r) => setTimeout(r, 20000));
        }
        const humanMessage = nerStatus.message ||
          "PII Shield NER is initializing (first run only). This takes 2–5 minutes: installs onnxruntime + downloads ~665 MB GLiNER ONNX model. Cached for the life of the plugin.";
        const progressPct = typeof nerStatus.progress_pct === "number"
          ? `${nerStatus.progress_pct}%`
          : "…";

        // Phase 7b: first-run explainer. On the very first `list_entities`
        // loading response of this process (server start), include a
        // `first_run_notice` field that explains where the cache lives and
        // how to keep it fast across sessions. SKILL.md tells Claude to
        // print this VERBATIM before the polling loop begins. Sent once per
        // process — after that, `first_run_notice` is omitted so the polls
        // stay tight.
        let firstRunNotice: string | undefined;
        if (!_firstRunNoticeSent) {
          _firstRunNoticeSent = true;
          const dataDir = PATHS.DATA_DIR;
          const displayDir = displayCacheDir(dataDir);
          const source = getDataDirSource();
          // The "workspace mount" branch fires whenever the cache landed in a
          // host-visible workspace folder — either via the marker fast-path
          // (subsequent runs) or via the first-run pick that selected a
          // Cowork workspace mount.
          const inWorkspace =
            source.startsWith("marker found at") ||
            source.startsWith("first-run pick: /sessions/");
          if (inWorkspace) {
            firstRunNotice =
              "⏳ **First-run setup** — PII Shield is downloading its NER model (~665 MB ONNX " +
              "GLiNER) and installing runtime dependencies (onnxruntime-node, @xenova/transformers, " +
              "gliner). This takes about 2–5 minutes, once.\n\n" +
              `Everything is being cached inside your **attached workspace folder** at \`${displayDir}\`. ` +
              "That path is VirtioFS-mounted from your host machine, which means:\n\n" +
              "• **Same workspace next time** → instant startup, no re-download. The cache survives " +
              "across Cowork sessions as long as you keep working in this same folder.\n" +
              "• **Different workspace** → one-time re-download into that other folder's " +
              "`.pii_shield/` cache, then fast there too.\n" +
              "• **Safe to delete** → if you need the ~700 MB back, `rm -rf .pii_shield` inside the " +
              "workspace folder. A README.txt in there explains the same thing.\n\n" +
              "You can keep working on other things in the meantime — I'll poll every 20 seconds " +
              "and let you know when PII Shield is ready.";
          } else {
            firstRunNotice =
              "⏳ **First-run setup** — PII Shield is downloading its NER model (~665 MB ONNX " +
              "GLiNER) and installing runtime dependencies (onnxruntime-node, @xenova/transformers, " +
              "gliner). This takes about 2–5 minutes, once. " +
              `Cache location: \`${displayDir}\`. Subsequent runs will be instant.`;
          }
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
          // Phase 7 Fix 7.3: `user_message` is the exact sentence Claude must
          // print VERBATIM to the user before the next poll. The `display_instruction`
          // sibling spells out the contract explicitly so there's no ambiguity.
          user_message:
            `PII Shield is still initializing — ${humanMessage} (${progressPct}). Next poll in 20s.`,
          display_instruction:
            "Print the `user_message` field verbatim to the user as a plain chat message BEFORE calling list_entities again. Do not paraphrase, do not batch, do not skip. Do NOT delegate this polling loop to a sub-agent.",
        };
        if (firstRunNotice) {
          envelope.first_run_notice = firstRunNotice;
          envelope.first_run_display_instruction =
            "Print the `first_run_notice` field verbatim to the user as the very FIRST message before starting the polling loop. This explains where the cache lives and how workspace persistence works. Only sent once per server start — do not expect it on subsequent polls.";
        }
        return JSON.stringify(envelope, null, 2);
      }

      // Storage diagnostics — helps debug Cowork ENOSPC / wrong data_dir
      let storageDiag: Record<string, unknown> | undefined;
      if (isCowork()) {
        storageDiag = { cowork: true, data_dir: PATHS.DATA_DIR, data_dir_source: getDataDirSource() };
        try {
          const sessions = "/sessions";
          if (fs.existsSync(sessions)) {
            for (const sid of fs.readdirSync(sessions)) {
              const mntDir = path.join(sessions, sid, "mnt");
              if (fs.existsSync(mntDir)) {
                const entries = fs.readdirSync(mntDir);
                storageDiag.mnt_entries = entries;
                storageDiag.mnt_dir = mntDir;
                break;
              }
            }
          }
        } catch { /* */ }
        // Free disk space (best-effort)
        try {
          const { execSync } = await import("node:child_process");
          storageDiag.df = execSync("df -h / 2>&1", { encoding: "utf-8", timeout: 3000 }).trim();
        } catch { /* */ }
      }

      return JSON.stringify({
        status: "ready",
        phase: nerStatus.phase,
        progress_pct: nerStatus.progress_pct,
        version: VERSION,
        runtime: "node.js",
        node_version: process.version,
        ner_ready: ready,
        ner_error: getNerError() || undefined,
        ner_inference_calls: stats.calls,
        ner_total_entities_detected: stats.totalEntities,
        ner_last_inference_error: stats.lastError || undefined,
        supported_entities: [...SUPPORTED_ENTITIES],
        recent_sessions: latest ? [latest] : [],
        data_dir: PATHS.DATA_DIR,
        data_dir_source: getDataDirSource(),
        ...(storageDiag ? { storage_diagnostics: storageDiag } : {}),
      }, null, 2);
    }

    case "get_review_status": {
      const sessionId = (args.session_id as string) || latestSessionId() || "";
      console.error(`[get_review_status] sessionId=${sessionId}, args.session_id=${args.session_id}, latestSessionId()=${latestSessionId()}`);

      // Check for standalone decisions file (from self-contained HTML review).
      const reviewData = getReview(sessionId);
      console.error(`[get_review_status] reviewData found=${!!reviewData}, approved=${reviewData?.approved}`);
      if (reviewData && !reviewData.approved) {
        const fname = `review_${sessionId}_decisions.json`;
        const outDir = (reviewData as any).output_dir || process.cwd();
        const wsDir = (reviewData as any).workspace_dir || "";
        const candidates = [
          // Workspace drop zone first — Cowork-safe (only path shared between
          // VM-side server and host-side browser).
          wsDir ? path.join(wsDir, fname) : null,
          path.join(outDir, fname),
          path.join(os.homedir(), "Downloads", fname),
          path.join(os.homedir(), fname),
          path.join(process.cwd(), fname),
          path.join(process.cwd(), "Downloads", fname),
        ].filter(Boolean) as string[];
        let decisionsPath: string | null = null;
        for (const c of candidates) {
          if (fs.existsSync(c)) { decisionsPath = c; break; }
        }
        if (decisionsPath) {
          try {
            const decisions = JSON.parse(fs.readFileSync(decisionsPath, "utf-8"));
            if (decisions.approved) {
              reviewData.overrides = decisions.overrides || { remove: [], add: [] };
              reviewData.approved = true;
              saveReview(sessionId, reviewData);
            }
          } catch { /* ignore malformed file */ }
        }
      }

      // Direct disk check — bypasses in-memory Map entirely
      let diskApproved: boolean | null = null;
      let diskPath = "";
      try {
        diskPath = path.join(PATHS.MAPPINGS_DIR, `review_${sessionId}.json`);
        if (fs.existsSync(diskPath)) {
          const diskData = JSON.parse(fs.readFileSync(diskPath, "utf-8"));
          diskApproved = !!diskData.approved;
          // If disk says approved but memory says no — sync memory from disk
          if (diskData.approved && reviewData && !reviewData.approved) {
            reviewData.approved = true;
            reviewData.overrides = diskData.overrides || reviewData.overrides;
            saveReview(sessionId, reviewData);
          }
        }
      } catch { /* ignore */ }

      const status = getReviewStatus(sessionId);
      console.error(`[get_review_status] RESULT: status=${status.status}, has_changes=${status.has_changes}, diskApproved=${diskApproved}`);
      return JSON.stringify({
        session_id: sessionId,
        ...status,
        _debug: {
          resolved_session_id: sessionId,
          args_session_id: args.session_id || null,
          latest_session_id: latestSessionId(),
          review_found: !!reviewData,
          review_approved: reviewData?.approved ?? null,
          review_has_overrides: !!(reviewData?.overrides),
          disk_review_path: diskPath,
          disk_approved: diskApproved,
          pid: process.pid,
        },
      }, null, 2);
    }

    case "anonymize_file": {
      const filePath = args.file_path as string;
      const language = (args.language as string) || "en";
      const prefix = (args.prefix as string) || "";
      const reviewSessionId = ((args.review_session_id as string) || "").trim();

      // Resolve file path
      let resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        const workDir = process.env.PII_WORK_DIR || "";
        if (workDir) {
          const candidate = path.join(workDir, path.basename(resolvedPath));
          if (fs.existsSync(candidate)) resolvedPath = candidate;
        }
        if (!fs.existsSync(resolvedPath)) {
          return JSON.stringify({
            error: `File not found: ${resolvedPath}`,
            hint: "Ask the user for the full host path to the file.",
          }, null, 2);
        }
      }

      // Phase 6 Fix 6.4 — HITL re-anonymization branch. If the caller passes
      // an approved review_session_id, skip fresh detection entirely and
      // re-apply the original entity list with the user's add/remove
      // overrides baked in. This is the ONLY place that ever used to leak:
      // the previous build silently dropped review_session_id and re-ran
      // detection, missing the same names the user had just manually added.
      if (reviewSessionId) {
        return reanonymizeWithReview(resolvedPath, reviewSessionId, prefix);
      }

      // Extract text based on format
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

        // Save review data for HITL review. Phase 7: also persist the
        // anonymized_text snapshot so reanonymizeWithReview can reuse it
        // without re-deriving from the placed entities.
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
        });

        // Phase 7 Fix 7.1: return BOTH the .txt companion (as output_path —
        // what Claude should Read() for analysis) and the .docx (as
        // docx_output_path — for later deanonymize_docx / apply_tracked_changes).
        // Reading the .txt directly avoids the pandoc → persisted-output
        // cascade that littered .claude/projects/.../tool-results/ with
        // mystery .txt files and made Claude loop.
        return JSON.stringify({
          status: "success",
          session_id: sid,
          entity_count: docxResult.total_entities,
          unique_entities: docxResult.unique_entities,
          output_path: docxResult.text_output_path,
          docx_output_path: docxResult.output_path,
          output_dir: outDir,
          by_type: docxResult.by_type,
          processing_time_ms: docxResult.processing_time_ms,
          note: "Read output_path (.txt) for analysis. docx_output_path is the formatted version for later tracked-changes or deanonymization.",
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
        // Fixed conservative chunk size — no calibration. Calibration was
        // misleading (first NER call after model load is atypically fast,
        // giving 6x inflated chars/sec) and itself took 14s of the timeout.
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

        // Return immediately — no inline chunk processing.
        // Claude calls anonymize_next_chunk(session_id) for each chunk,
        // keeping each tool call within Cowork's 60s timeout.
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

      // Write output file
      const outDir = path.join(path.dirname(resolvedPath), `pii_shield_${sessionId}`);
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `${path.basename(resolvedPath, ext)}_anonymized${ext === ".pdf" ? ".txt" : ext}`);
      fs.writeFileSync(outPath, result.anonymized, "utf-8");

      // Save review data for HITL review
      saveReview(sessionId, {
        session_id: sessionId,
        entities: result.entities,
        original_text: text,
        anonymized_text: result.anonymized,
        overrides: { remove: [], add: [] },
        approved: false,
        timestamp: Date.now(),
        output_dir: outDir,
      });

      const resp: Record<string, unknown> = {
        status: "success",
        session_id: sessionId,
        entity_count: result.entityCount,
        output_path: outPath,
        output_dir: outDir,
        note: "Anonymized text written to output_path. Read the file to get the content.",
      };
      if (!result.nerUsed) {
        resp.warning = "NER model is still loading (first run downloads ~665 MB). Only pattern-based detection was used. Names, organizations, and locations may be missed. Call list_entities to see progress; re-run once `ner_ready: true` for full coverage.";
      }
      return JSON.stringify(resp, null, 2);
    }

    case "anonymize_next_chunk": {
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

    case "get_full_anonymized_text": {
      const sessionId = args.session_id as string;
      try {
        const result = finalizeChunkSession(sessionId);
        const mappingSessionId = newSessionId();
        saveMapping(mappingSessionId, result.mapping);

        // Write output file next to source (like non-chunked path)
        const ext = result.sourceSuffix || ".txt";
        const outDir = path.join(path.dirname(result.sourcePath), `pii_shield_${mappingSessionId}`);
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `${path.basename(result.sourcePath, ext)}_anonymized${ext === ".pdf" ? ".txt" : ext}`);
        fs.writeFileSync(outPath, result.anonymizedText, "utf-8");

        // Save review data so start_review works for chunked documents.
        // Save under BOTH the new UUID and the original chunk hex ID —
        // Claude may pass either one to start_review.
        const reviewData = {
          session_id: mappingSessionId,
          entities: result.entities,
          original_text: result.originalText,
          anonymized_text: result.anonymizedText,
          overrides: { remove: [], add: [] },
          approved: false,
          timestamp: Date.now(),
          output_dir: outDir,
        };
        saveReview(mappingSessionId, reviewData);
        saveMapping(sessionId, result.mapping);
        saveReview(sessionId, { ...reviewData, session_id: sessionId });

        logServer(`[Chunked] Finalized ${sessionId} → ${mappingSessionId}: ${result.entityCount} entities, output=${outPath}`);

        return JSON.stringify({
          status: "success",
          session_id: mappingSessionId,
          entity_count: result.entityCount,
          output_path: outPath,
          note: "Anonymized text assembled and written to output_path. Use this session_id for start_review.",
        }, null, 2);
      } catch (e) {
        return JSON.stringify({
          error: `Failed to finalize: ${e}`,
          hint: "Session may have expired or was already finalized.",
        }, null, 2);
      }
    }

    case "start_review": {
      // Accept either a single session_id or an array of session_ids (BULK).
      const singleId = (args.session_id as string) || "";
      const idArr = Array.isArray(args.session_ids)
        ? (args.session_ids as string[]).filter((x) => typeof x === "string" && x.length > 0)
        : [];
      const sessionIds: string[] = idArr.length > 0
        ? idArr
        : (singleId ? [singleId] : (latestSessionId() ? [latestSessionId() as string] : []));

      if (sessionIds.length === 0) {
        return JSON.stringify({
          error: "No session to review. Run anonymize_file or anonymize_text first.",
        }, null, 2);
      }

      // Host-form workspace dir (from resolve_path marker result). In Cowork
      // the VM's `/sessions/<id>/mnt/<name>` path is meaningless to the user —
      // Claude should pass the host dir so we can display a real path.
      const hostWorkspaceDir = ((args.host_workspace_dir as string) || "").trim();

      // Validate sessions — skip missing ones instead of failing entirely.
      // This way if one session is invalid, the rest still get reviewed.
      const validSessionIds: string[] = [];
      const skippedSessionIds: string[] = [];
      for (const sid of sessionIds) {
        const s = getReviewStatus(sid);
        if (s.status === "not_found") {
          skippedSessionIds.push(sid);
          logServer(`[Review] Session ${sid} not found, skipping`);
        } else {
          validSessionIds.push(sid);
        }
      }
      if (validSessionIds.length === 0) {
        return JSON.stringify({
          error: `No review data found for any session. Tried: ${sessionIds.join(", ")}. Run anonymize_file first.`,
          skipped: skippedSessionIds,
        }, null, 2);
      }
      // Replace sessionIds with valid ones for the rest of the handler
      const effectiveSessionIds = validSessionIds;

      // Primary path: generate a self-contained HTML per session at the
      // workspace root (same folder as the user's source file, so it's visible
      // in the Cowork file browser alongside their original document). Each
      // HTML is a standalone SPA — on Approve it writes
      // `review_<sid>_decisions.json` to the user's browser Downloads folder
      // via an `<a download>` click.
      //
      // In Cowork, the VM-side server CANNOT see the host's Downloads folder
      // (only the VirtioFS-mounted workspace is shared). So the approved
      // overlay tells the user to move/copy the JSON from Downloads into the
      // workspace folder, and `get_review_status` polls the workspace dir
      // first. On a local install (not Cowork), ~/Downloads is polled too and
      // the pickup is fully automatic.
      const stripCoworkPrefix = (p: string): string => {
        if (!p) return p;
        const m = p.match(/^\/sessions\/[^/]+\/mnt\/(.+)$/);
        return m ? m[1] : p;
      };

      const generated: Array<{
        session_id: string;
        workspace_dir: string;
        workspace_dir_display: string;
        source_filename: string;
      }> = [];
      for (const sid of effectiveSessionIds) {
        const reviewData = getReview(sid);
        const sessionOutDir = (reviewData as any)?.output_dir || process.cwd();
        const workspaceRoot = path.dirname(sessionOutDir);

        // Persist workspace_dir + host_workspace_dir on the review record so
        // get_review_status can poll them later without needing the caller to
        // pass them again.
        if (reviewData) {
          reviewData.workspace_dir = workspaceRoot;
          if (hostWorkspaceDir) reviewData.host_workspace_dir = hostWorkspaceDir;
          saveReview(sid, reviewData);
        }

        const sourceFile = (reviewData as any)?.source_filename
          || (reviewData as any)?.original_filename
          || path.basename((reviewData as any)?.output_path || "")
          || sid;

        generated.push({
          session_id: sid,
          workspace_dir: workspaceRoot,
          workspace_dir_display: stripCoworkPrefix(hostWorkspaceDir || workspaceRoot),
          source_filename: sourceFile,
        });
      }

      const inCowork = isCowork();
      const httpPort = parseInt(process.env.PII_SHIELD_HTTP_PORT || "6789", 10);
      const isBulk = generated.length > 1;

      // Per-session review URLs
      const reviewUrls = generated.map((g) => ({
        session_id: g.session_id,
        review_url: `http://127.0.0.1:${httpPort}/review/${g.session_id}`,
      }));
      const bulkUrl = isBulk
        ? `http://127.0.0.1:${httpPort}/review-bulk?sessions=${effectiveSessionIds.join(",")}`
        : null;

      // Primary review URL: bulk page for multiple docs, single page for one
      const primaryReviewUrl = bulkUrl || reviewUrls[0].review_url;

      let userMessage: string;
      if (inCowork) {
        if (isBulk) {
          const fileList = generated.map((g, i) => `${i + 1}. **${g.source_filename}**`).join("\n");
          userMessage =
            `${generated.length} documents ready for review:\n\n${fileList}\n\n` +
            `**Open this link to review all documents:** ${primaryReviewUrl}\n\n` +
            `You'll see document tabs at the top — review each one and click **Approve**. ` +
            `After approving one document, the next one opens automatically.\n\n` +
            `Everything runs locally — nothing leaves your machine. When all documents are approved, tell me **"all approved"** and I'll re-anonymize.\n\n` +
            `⚠️ **I will NOT read any of your documents until its review is approved.**`;
        } else {
          const g = generated[0];
          userMessage =
            `Review page is ready for **${g.source_filename}**.\n\n` +
            `**Open this link to review:** ${primaryReviewUrl}\n\n` +
            `You'll see color-coded PII highlights: ` +
            `click any highlight to remove a false positive, select text to add a missed entity, then click **Approve** at the top.\n\n` +
            `Everything runs locally — nothing leaves your machine. After you approve, tell me **"approved"** or **"continue"** and I'll re-anonymize with your decisions.\n\n` +
            `⚠️ **I will NOT read your document until you approve the review.**`;
        }
      } else {
        // Desktop: open in default browser
        const saveHint =
          `When you click **Approve**, a file called \`review_${generated[0].session_id}_decisions.json\` ` +
          `will either open a Save As dialog (Chrome / Edge) or drop into your browser's Downloads folder. Either is fine — my server will find it automatically.`;
        if (isBulk) {
          const fileList = generated.map((g, i) => `${i + 1}. **${g.source_filename}**`).join("\n");
          userMessage =
            `${generated.length} documents ready for review:\n\n${fileList}\n\n` +
            `Opening the review page in your browser. You'll see document tabs at the top — review each one and click **Approve**.\n\n` +
            `${saveHint}\n\n` +
            `When all documents are approved, tell me **"all approved"** and I'll re-anonymize.\n\n` +
            `⚠️ **I will NOT read any of your documents until its review is approved.**`;
        } else {
          const g = generated[0];
          userMessage =
            `Review page is ready for **${g.source_filename}**.\n\n` +
            `Opening it in your browser now. You'll see color-coded PII highlights: ` +
            `click any highlight to remove a false positive, select text to add a missed entity, then click **Approve** at the top.\n\n` +
            `It runs 100% locally — nothing leaves your machine.\n\n` +
            `${saveHint}\n\n` +
            `Then tell me **"approved"** or **"continue"** and I'll re-anonymize with your decisions.\n\n` +
            `⚠️ **I will NOT read your document until you approve the review.**`;
        }
        // Desktop: auto-open the review URL in the browser
        try {
          const { openBrowser } = await import("./review/review-server.js");
          openBrowser(primaryReviewUrl);
        } catch { /* best effort */ }
      }

      return JSON.stringify({
        status: "review_ready",
        session_id: generated[0].session_id,
        review_url: primaryReviewUrl,
        review_urls: reviewUrls,
        bulk_review_url: bulkUrl,
        skipped_sessions: skippedSessionIds.length > 0 ? skippedSessionIds : undefined,
        workspace_dir: generated[0].workspace_dir,
        workspace_dir_display: generated[0].workspace_dir_display,
        review_files: generated,
        count: generated.length,
        cowork: inCowork,
        user_message: userMessage,
      }, null, 2);
    }

    case "find_file": {
      const filename = args.filename as string;
      const result = findFileFn(filename);
      return JSON.stringify(result, null, 2);
    }

    case "apply_review_decisions": {
      const sessionId = (args.session_id as string) || "";
      if (!sessionId) {
        return JSON.stringify({ error: "session_id is required" }, null, 2);
      }
      const decisionsCode = ((args.decisions_code as string) || "").trim();

      // ── Mode 1: opaque code pasted from review page ──────────────────────
      // Format: PII_DECISIONS_v1:<sid>:<base64(iv||ciphertext+tag)>
      //     or  PII_DECISIONS_v1_PLAIN:<base64(json)>
      if (decisionsCode) {
        let decisionsJson: string;
        try {
          if (decisionsCode.startsWith("PII_DECISIONS_v1_PLAIN:")) {
            const b64 = decisionsCode.slice("PII_DECISIONS_v1_PLAIN:".length);
            decisionsJson = Buffer.from(b64, "base64").toString("utf-8");
          } else if (decisionsCode.startsWith("PII_DECISIONS_v1:")) {
            const rest = decisionsCode.slice("PII_DECISIONS_v1:".length);
            const sep = rest.indexOf(":");
            if (sep < 0) throw new Error("malformed code (missing session id separator)");
            const codeSid = rest.slice(0, sep);
            const b64 = rest.slice(sep + 1);
            if (codeSid !== sessionId) {
              return JSON.stringify({
                error: `session_id mismatch: code has ${codeSid}, expected ${sessionId}`,
              }, null, 2);
            }
            const reviewForKey = getReview(sessionId);
            if (!reviewForKey || !reviewForKey.review_secret) {
              return JSON.stringify({
                error: `No encryption key for session ${sessionId}. Cannot decrypt.`,
              }, null, 2);
            }
            const key = Buffer.from(reviewForKey.review_secret, "base64");
            const packed = Buffer.from(b64, "base64");
            if (packed.length < 12 + 16) throw new Error("ciphertext too short");
            const iv = packed.subarray(0, 12);
            const tag = packed.subarray(packed.length - 16);
            const ct = packed.subarray(12, packed.length - 16);
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
            decisionsJson = plain.toString("utf-8");
          } else {
            return JSON.stringify({
              error: "Unrecognized decisions_code format. Expected PII_DECISIONS_v1:... or PII_DECISIONS_v1_PLAIN:...",
            }, null, 2);
          }
        } catch (e: any) {
          return JSON.stringify({
            error: `Failed to decode decisions_code: ${e?.message || e}`,
          }, null, 2);
        }

        let decisions: any;
        try {
          decisions = JSON.parse(decisionsJson);
        } catch (e) {
          return JSON.stringify({ error: `Failed to parse decoded decisions: ${e}` }, null, 2);
        }
        if (decisions.session_id && decisions.session_id !== sessionId) {
          return JSON.stringify({
            error: `session_id mismatch in payload: ${decisions.session_id} vs ${sessionId}`,
          }, null, 2);
        }

        const review = getReview(sessionId);
        if (!review) {
          return JSON.stringify({ error: `No review session: ${sessionId}` }, null, 2);
        }

        // Archive decrypted decisions next to the per-session output dir
        let archived: string | null = null;
        try {
          const outDir = (review as any).output_dir;
          if (outDir && fs.existsSync(outDir)) {
            archived = path.join(outDir, `review_${sessionId}_decisions.json`);
            fs.writeFileSync(archived, JSON.stringify(decisions, null, 2), "utf-8");
          }
        } catch (e) {
          console.error(`[apply_review_decisions] archive failed: ${e}`);
        }

        review.overrides = {
          remove: (decisions.overrides && decisions.overrides.remove) || [],
          add: (decisions.overrides && decisions.overrides.add) || [],
        };
        review.approved = true;
        saveReview(sessionId, review);

        const hasChanges =
          (review.overrides.remove?.length || 0) > 0 ||
          (review.overrides.add?.length || 0) > 0;

        return JSON.stringify({
          status: "applied",
          session_id: sessionId,
          source: "decisions_code",
          archived_path: archived,
          has_changes: hasChanges,
          remove_count: review.overrides.remove?.length || 0,
          add_count: review.overrides.add?.length || 0,
          note: hasChanges
            ? "Decisions applied. Re-run anonymize_file with review_session_id to regenerate the output using these overrides — discard the previous output_path/session_id."
            : "Decisions applied. The user approved without changes — keep using the existing session_id and output_path.",
        }, null, 2);
      }

      // ── Mode 2: fall back to filename lookup (browser download) ──────────
      const fname = `review_${sessionId}_decisions.json`;

      // Try the configured work-dir search first; on miss, fall back to common
      // browser download locations. The session id in the filename is unique,
      // so first match wins.
      let foundPath: string | null = null;
      // Workspace drop zone first — this is the only path shared between the
      // VM-side server and the host-side browser in Cowork.
      const reviewForLookup = getReview(sessionId);
      const wsDir = (reviewForLookup as any)?.workspace_dir || "";
      if (wsDir) {
        const wsCandidate = path.join(wsDir, fname);
        if (fs.existsSync(wsCandidate)) foundPath = wsCandidate;
      }
      if (!foundPath) {
        const findResult = findFileFn(fname) as { path?: string };
        if (findResult && findResult.path && fs.existsSync(findResult.path)) {
          foundPath = findResult.path;
        } else {
          const candidates = [
            path.join(os.homedir(), "Downloads", fname),
            path.join(os.homedir(), fname),
            path.join(process.cwd(), fname),
            path.join(process.cwd(), "Downloads", fname),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) { foundPath = c; break; }
          }
        }
      }
      if (!foundPath) {
        const wsHint = wsDir
          ? ` In Cowork, the host's Downloads folder is NOT visible from the VM — please ask the user to MOVE or COPY the file from their host Downloads into the workspace folder: ${wsDir}`
          : "";
        return JSON.stringify({
          status: "waiting_for_user",
          session_id: sessionId,
          error: `Decisions file ${fname} not found.`,
          hint: `Ask the user to click Approve in the review page first. The browser will download the file to their Downloads folder; then re-run apply_review_decisions.${wsHint}`,
        }, null, 2);
      }
      const found = { path: foundPath };
      let decisions: any;
      try {
        decisions = JSON.parse(fs.readFileSync(found.path, "utf-8"));
      } catch (e) {
        return JSON.stringify({ error: `Failed to parse ${fname}: ${e}` }, null, 2);
      }
      if (decisions.session_id && decisions.session_id !== sessionId) {
        return JSON.stringify({
          error: `session_id mismatch: file has ${decisions.session_id}, expected ${sessionId}`,
        }, null, 2);
      }

      const review = getReview(sessionId);
      if (!review) {
        return JSON.stringify({ error: `No review session: ${sessionId}` }, null, 2);
      }

      // Archive a copy next to the per-session output dir for audit trail
      let archived: string | null = null;
      try {
        const outDir = (review as any).output_dir;
        if (outDir && fs.existsSync(outDir)) {
          archived = path.join(outDir, fname);
          fs.copyFileSync(found.path, archived);
        }
      } catch (e) {
        console.error(`[apply_review_decisions] archive failed: ${e}`);
      }

      // Apply overrides to the review session
      review.overrides = {
        remove: (decisions.overrides && decisions.overrides.remove) || [],
        add: (decisions.overrides && decisions.overrides.add) || [],
      };
      review.approved = true;
      saveReview(sessionId, review);

      const hasChanges =
        (review.overrides.remove?.length || 0) > 0 ||
        (review.overrides.add?.length || 0) > 0;

      return JSON.stringify({
        status: "applied",
        session_id: sessionId,
        found_at: found.path,
        archived_path: archived,
        has_changes: hasChanges,
        remove_count: review.overrides.remove?.length || 0,
        add_count: review.overrides.add?.length || 0,
        note: hasChanges
          ? "Decisions applied. Re-run anonymize_file with review_session_id to regenerate the output using these overrides — discard the previous output_path/session_id."
          : "Decisions applied. The user approved without changes — keep using the existing session_id and output_path.",
      }, null, 2);
    }

    case "resolve_path": {
      const filename = args.filename as string;
      const marker = args.marker as string;
      const vmDir = (args.vm_dir as string) || "";
      const result = resolvePathFn(filename, marker, vmDir);
      return JSON.stringify(result, null, 2);
    }

    case "apply_tracked_changes": {
      const filePath = (args.file_path as string) || "";
      const changesJson = (args.changes as string) || "[]";
      const author = (args.author as string) || "PII Shield";
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        return JSON.stringify({ error: `Not found: ${resolved}` });
      }
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
      return JSON.stringify({
        status: "success",
        output_path: outPath,
        changes_applied: changes.length,
        note: "Tracked changes applied. Open in Word to see revision marks (w:del/w:ins).",
      }, null, 2);
    }

    case "anonymize_docx": {
      const filePath = (args.file_path as string) || "";
      const language = (args.language as string) || "en";
      const prefix = (args.prefix as string) || "";
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        return JSON.stringify({ error: `Not found: ${resolved}` });
      }
      const result = await anonymizeDocx(resolved, language, prefix);
      const docxSid = result.session_id as string;
      const docxOutDir = path.dirname(result.output_path as string);
      saveReview(docxSid, {
        session_id: docxSid,
        entities: (result.entities as any[]) || [],
        original_text: (result.original_text as string) || "",
        html_text: (result.html_text as string) || "",
        overrides: { remove: [], add: [] },
        approved: false,
        timestamp: Date.now(),
        output_dir: docxOutDir,
      });
      return JSON.stringify(result, null, 2);
    }

    case "deanonymize_docx": {
      const filePath = (args.file_path as string) || "";
      const sessionId = ((args.session_id as string) || "").trim() || latestSessionId();
      if (!sessionId) {
        return JSON.stringify({ error: "No session. Run anonymize first." });
      }
      const mapping = loadMapping(sessionId);
      if (!mapping) {
        return JSON.stringify({ error: `Mapping not found: ${sessionId}` });
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        return JSON.stringify({ error: `Not found: ${resolved}` });
      }
      const restoredPath = await deanonymizeDocx(resolved, mapping);
      return JSON.stringify({ restored_path: restoredPath, session_id: sessionId }, null, 2);
    }

    case "collect_debug_logs": {
      // Package all logs + diagnostics into a ZIP written to the workspace
      // root. When running inside a Cowork VM, the workspace root is the
      // VirtioFS mount that's visible to the user's host file browser /
      // Artifacts pane, so they can download the ZIP from there.
      try {
        // Pick output dir. Cowork's `process.cwd()` is `/sessions/<id>/`,
        // which is OUTSIDE the VirtioFS workspace mount and therefore NOT
        // visible to the user's host file browser. We must write into
        // `/sessions/<id>/mnt/<workspace_name>/` instead, which is the only
        // path the host can see and download from.
        let outDir = ((args.output_dir as string) || "").trim();
        if (!outDir) {
          const ws = findCoworkWorkspace();
          outDir = ws || process.cwd();
        }
        fs.mkdirSync(outDir, { recursive: true });

        const JSZipMod = (await import("jszip")).default;
        const zip = new JSZipMod();

        // 1) Audit log files from PATHS.AUDIT_DIR
        const auditDir = PATHS.AUDIT_DIR;
        const logFiles: string[] = [];
        if (fs.existsSync(auditDir)) {
          for (const name of fs.readdirSync(auditDir)) {
            const full = path.join(auditDir, name);
            try {
              const st = fs.statSync(full);
              if (st.isFile()) {
                logFiles.push(name);
                zip.file(`logs/${name}`, fs.readFileSync(full));
              }
            } catch { /* skip unreadable */ }
          }
        }

        // 2) Startup diagnostic marker (if present)
        const startupLog = path.join(PATHS.DATA_DIR, "startup.log");
        if (fs.existsSync(startupLog)) {
          zip.file("logs/startup.log", fs.readFileSync(startupLog));
        }

        // 3) NER runtime stats + init error
        const nerStats = getNerStats();
        const nerErr = getNerError();

        // 4) Environment / diagnostics report (safe — no PII, only paths +
        //    versions + env var *names*). Explicitly scrub values of any env
        //    var that looks like a secret.
        const safeEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (!v) continue;
          if (/SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL/i.test(k)) {
            safeEnv[k] = `<redacted ${v.length} chars>`;
          } else if (k.startsWith("PII_") || k.startsWith("CLAUDE_") || k === "COWORK_VM" || k === "HOME" || k === "USERPROFILE" || k === "PATH") {
            safeEnv[k] = v.length > 500 ? `${v.slice(0, 500)}… [${v.length} chars]` : v;
          }
        }

        const diag = {
          tool: "collect_debug_logs",
          version: VERSION,
          generated_at: new Date().toISOString(),
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cwd: process.cwd(),
            pid: process.pid,
          },
          paths: {
            DATA_DIR: PATHS.DATA_DIR,
            MODELS_DIR: PATHS.MODELS_DIR,
            DEPS_DIR: PATHS.DEPS_DIR,
            MAPPINGS_DIR: PATHS.MAPPINGS_DIR,
            AUDIT_DIR: auditDir,
          },
          cowork: isCowork(),
          ner: {
            ready: !nerErr,
            init_error: nerErr || null,
            stats: nerStats,
          },
          sidecar: sidecarStatus(),
          log_files_included: logFiles,
          env: safeEnv,
        };
        zip.file("diagnostics.json", JSON.stringify(diag, null, 2));

        // 5) Human-readable README
        const readme =
          `PII Shield v${VERSION} debug bundle\n` +
          `Generated: ${diag.generated_at}\n` +
          `\n` +
          `Contents:\n` +
          `  diagnostics.json — runtime info, paths, NER state, env vars\n` +
          `  logs/*           — ${logFiles.length} log file(s) from ${auditDir}\n` +
          `\n` +
          `This bundle contains NO document PII. Secrets in environment\n` +
          `variables have been redacted. Feel free to share for debugging.\n`;
        zip.file("README.txt", readme);

        // Write ZIP
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const zipName = `pii-shield-debug-${ts}.zip`;
        const zipPath = path.join(outDir, zipName);
        const buf = await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });
        fs.writeFileSync(zipPath, buf);

        return JSON.stringify({
          status: "ok",
          zip_path: zipPath,
          size_bytes: buf.length,
          file_count: logFiles.length + 2,
          cowork: isCowork(),
          user_message:
            `📦 **\`${zipName}\`** (${(buf.length / 1024).toFixed(1)} KB) saved at \`${zipPath}\`. ` +
            `${isCowork()
              ? "It's in your Cowork workspace root — open the file browser / Artifacts panel on the right and download it to your host machine."
              : "Open or share the file for debugging."} ` +
            `Contains ${logFiles.length} log file(s) + diagnostics.json. No document PII is included; environment secrets are redacted.`,
        }, null, 2);
      } catch (e: any) {
        return JSON.stringify({
          error: "collect_debug_logs_failed",
          message: e?.message || String(e),
        }, null, 2);
      }
    }

    case "cleanup_cache": {
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
          // Calculate size before deleting
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
          // Remove recursively
          fs.rmSync(dirPath, { recursive: true, force: true });
          totalFreed += dirSize;
          results[dirName] = { status: "deleted", bytes_freed: dirSize };
        } catch (e: any) {
          results[dirName] = { status: "error", message: e?.message || String(e) };
        }
      }

      // Free disk after cleanup
      let dfAfter = "";
      try {
        const { execSync } = await import("node:child_process");
        dfAfter = execSync("df -h / 2>&1", { encoding: "utf-8", timeout: 3000 }).trim();
      } catch { /* */ }

      return JSON.stringify({
        status: "ok",
        total_bytes_freed: totalFreed,
        total_mb_freed: Math.round(totalFreed / 1024 / 1024),
        results,
        disk_after: dfAfter || undefined,
        note: "Models and deps will re-download on next NER call. Restart the server or call list_entities to trigger re-init.",
      }, null, 2);
    }

    default:
      return JSON.stringify({
        status: "not_implemented",
        tool: name,
        message: `Tool '${name}' is registered but not yet implemented in v${VERSION}.`,
      }, null, 2);
  }
}

// ── MCP Server setup ─────────────────────────────────────────────────────────

const server = new Server(
  { name: "PII Shield", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t: any) => {
    const out: Record<string, unknown> = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    };
    if (t._meta) out._meta = t._meta;
    return out;
  }),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolArgs = (args as ToolArgs) || {};
  logToolCall(name, toolArgs);

  try {
    const text = await handleToolCall(name, toolArgs);
    logToolResponse(name, text);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logToolError(name, error);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
      isError: true,
    };
  }
});

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
  // tools register before any best-effort startup work runs. Anything that
  // touches PATHS.* / the filesystem can hang or throw on Cowork/VirtioFS;
  // those failures must not block tool registration.
  earlyLog("[main] before server.connect");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  earlyLog("[main] server connected, tools=" + TOOLS.length);
  console.error(`[PII Shield v${VERSION}] MCP server running on stdio, ${TOOLS.length} tools registered.`);

  // ── HTTP sidecar — MCP tool fallback + HITL review UI ──────────────────
  // Serves two purposes:
  // 1. JSON-RPC endpoint at POST /mcp for when MCP tool propagation fails
  // 2. Review UI routes (GET /review/:sid, POST /api/approve/:sid, etc.)
  //    so Cowork preview panel can show an interactive HITL review page
  const HTTP_PORT = parseInt(process.env.PII_SHIELD_HTTP_PORT || "6789", 10);
  try {
    const http = await import("node:http");
    const {
      serveReviewPage, serveReviewData, handleApprove, handleApproveGet,
      handleRemoveEntity, handleAddEntity, readBody, sendJson,
      serveReviewBulkPage, serveSessionsList,
    } = await import("./review/review-server.js");

    const httpServer = http.createServer(async (req, res) => {
      try {
      const urlPath = (req.url || "/").split("?")[0];

      // ── CORS + Private Network Access (PNA) ────────────────────────────
      // PNA: Chrome blocks requests from public HTTPS origins (Cowork UI)
      // to private IPs (127.0.0.1) unless server opts in via this header.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      // Prevent browser caching — sidecar responses must always be fresh
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── Version endpoint (diagnostic) ────────────────────────────────
      if (req.method === "GET" && urlPath === "/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "2.1", build: "2026-04-09", pid: process.pid }));
        return;
      }

      // ── Bulk Review UI ──────────────────────────────────────────────
      if (req.method === "GET" && urlPath === "/review-bulk") {
        const queryStr = (req.url || "").split("?")[1] || "";
        const params = new URLSearchParams(queryStr);
        const sessionsParam = params.get("sessions") || "";
        const sessionIds = sessionsParam.split(",").filter((s) => s.length > 0);
        if (sessionIds.length === 0) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing sessions parameter</h1>");
          return;
        }
        // Cache-buster redirect
        if (!queryStr.includes("_t=")) {
          res.writeHead(302, { "Location": `/review-bulk?sessions=${sessionsParam}&_t=${Date.now()}`, "Cache-Control": "no-store" });
          res.end();
          return;
        }
        serveReviewBulkPage(sessionIds, res);
        return;
      }
      if (req.method === "GET" && urlPath === "/api/sessions") {
        const queryStr = (req.url || "").split("?")[1] || "";
        const params = new URLSearchParams(queryStr);
        const idsParam = params.get("ids") || "";
        const sessionIds = idsParam.split(",").filter((s) => s.length > 0);
        serveSessionsList(sessionIds, res);
        return;
      }

      // ── Review UI routes ─────────────────────────────────────────────
      if (req.method === "GET" && urlPath.startsWith("/review/")) {
        const sid = urlPath.split("/review/")[1];
        // Cache-buster redirect: if no _t= param, redirect to add one.
        // This forces the browser to request a fresh URL even if the old
        // response (without Cache-Control headers) is in disk cache.
        if (!(req.url || "").includes("_t=")) {
          res.writeHead(302, { "Location": `/review/${sid}?_t=${Date.now()}`, "Cache-Control": "no-store" });
          res.end();
          return;
        }
        serveReviewPage(sid, res);
        return;
      }
      if (req.method === "GET" && urlPath.startsWith("/api/review/")) {
        const sid = urlPath.split("/api/review/")[1];
        serveReviewData(sid, res);
        return;
      }
      if (req.method === "GET" && urlPath.startsWith("/api/approve-get/")) {
        const sid = urlPath.split("/api/approve-get/")[1];
        const queryStr = (req.url || "").split("?")[1] || "";
        handleApproveGet(sid, queryStr, res);
        return;
      }
      if (req.method === "POST" && urlPath.startsWith("/api/approve/")) {
        const sid = urlPath.split("/api/approve/")[1];
        readBody(req, (body) => handleApprove(sid, body, res));
        return;
      }
      if (req.method === "POST" && urlPath.startsWith("/api/remove_entity/")) {
        const sid = urlPath.split("/api/remove_entity/")[1];
        readBody(req, (body) => handleRemoveEntity(sid, body, res));
        return;
      }
      if (req.method === "POST" && urlPath.startsWith("/api/add_entity/")) {
        const sid = urlPath.split("/api/add_entity/")[1];
        readBody(req, (body) => handleAddEntity(sid, body, res));
        return;
      }

      // ── JSON-RPC MCP endpoint ────────────────────────────────────────
      if (req.method === "POST" && urlPath === "/mcp") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const rawBody = Buffer.concat(chunks).toString("utf-8");

        let jsonrpc: any;
        try { jsonrpc = JSON.parse(rawBody); }
        catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
          return;
        }

        const id = jsonrpc.id ?? null;
        const method = jsonrpc.method as string;

        try {
          if (method === "tools/list") {
            const tools = TOOLS.map((t: any) => ({
              name: t.name, description: t.description, inputSchema: t.inputSchema,
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools } }));
          } else if (method === "tools/call") {
            const { name, arguments: args } = jsonrpc.params || {};
            const toolArgs = (args as ToolArgs) || {};
            logToolCall(name, toolArgs);
            const text = await handleToolCall(name, toolArgs);
            logToolResponse(name, text);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } }));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logToolError(method, err instanceof Error ? err : new Error(msg));
          if (!res.headersSent) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: msg } }));
          }
        }
        return;
      }

      // ── 404 ──────────────────────────────────────────────────────────
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));

      } catch (err) {
        const msg = err instanceof Error ? (err.stack || err.message) : String(err);
        logServer(`[HTTP] CRASH PREVENTED: ${msg}`);
        try { (globalThis as any).__earlyLog?.(`[HTTP CRASH PREVENTED] ${msg}`); } catch {}
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error", detail: msg }));
        }
      }
    });

    httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
      earlyLog(`[main] HTTP sidecar listening on 127.0.0.1:${HTTP_PORT}`);
      logServer(`[HTTP] Sidecar started on 127.0.0.1:${HTTP_PORT} (pid=${process.pid})`);
    });
    httpServer.on("error", (e: any) => {
      logServer(`[HTTP] Sidecar failed to start: ${e.code} ${e.message}`);
      earlyLog(`[main] HTTP sidecar failed: ${e.code} ${e.message}`);
    });
  } catch (e) {
    earlyLog(`[main] HTTP sidecar setup failed: ${e}`);
  }

  // Diagnostic: write startup marker so we can verify Cowork actually invokes the process
  earlyLog("[main] before startup.log diag write");
  try {
    const diagDir = PATHS.DATA_DIR;
    fs.mkdirSync(diagDir, { recursive: true });
    fs.writeFileSync(path.join(diagDir, "startup.log"),
      `[${new Date().toISOString()}] PII Shield v${VERSION} starting\n` +
      `node=${process.version} platform=${process.platform} arch=${process.arch}\n` +
      `cwd=${process.cwd()}\n` +
      `argv=${JSON.stringify(process.argv)}\n` +
      `cowork=${isCowork()}\n` +
      `data_dir=${PATHS.DATA_DIR}\n` +
      `data_dir_source=${getDataDirSource()}\n` +
      `models_dir=${PATHS.MODELS_DIR}\n` +
      `deps_dir=${PATHS.DEPS_DIR}\n`,
    );
    // Also log to stderr so it shows up in the MCP plugin log viewer.
    console.error(
      `[PII Shield] data_dir=${PATHS.DATA_DIR} (source: ${getDataDirSource()})`,
    );
  } catch (e) { earlyLog("[main] startup.log diag failed: " + e); }

  // Cleanup expired mappings on startup
  earlyLog("[main] before cleanupOldMappings");
  try { cleanupOldMappings(); }
  catch (e) { earlyLog("[main] cleanupOldMappings failed: " + e); }

  // Start NER model download/init in background (doesn't block server startup)
  earlyLog("[main] before startNerBackground");
  try { PIIEngine.getInstance().startNerBackground(); }
  catch (e) { earlyLog("[main] startNerBackground failed: " + e); }

  earlyLog("[main] startup complete");
}

main().catch((err) => {
  console.error("[PII Shield] Fatal:", err);
  process.exit(1);
});
