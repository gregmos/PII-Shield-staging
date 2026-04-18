/**
 * PII Shield — Local Testing App Server
 *
 * Standalone HTTP server for testing anonymization locally.
 * Uses the exact same PIIEngine pipeline as the MCP server.
 *
 * Launch: npm run local (or npx tsx src/local-app/server.ts)
 */

// ── MUST be first import — sets PII_SHIELD_DATA_DIR before config.ts loads ──
import "./preload.js";

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ── Local pipeline imports (no PIIEngine — fully parallel NER) ──────────────
import {
  initNer, runNerChunked, isNerReady, getNerStatus,
  switchModel, switchLabels, getModels, getPresets,
  stopPythonBridge, MODEL_REGISTRY, LABEL_PRESETS,
} from "./local-ner.js";
import { runPatternRecognizers, type DetectedEntity } from "../engine/pattern-recognizers.js";
import {
  deduplicateOverlaps, expandOrgBoundaries, trimOrgPrefix, expandLocationBoundaries, mergeAdjacentLocations, expandAddressBlocks, cleanBoundaries, assignPlaceholders,
  createPlaceholderState, type PlaceholderState,
} from "../engine/entity-dedup.js";
import { filterJurisdictionEntities, filterCurrencyEntities, filterFalsePositives, filterGarbageNerEntities } from "../engine/false-positive-filter.js";
import {
  newSessionId, saveMapping, loadMapping, latestSessionId,
} from "../mapping/mapping-store.js";
import { saveReview, getReview } from "../mapping/review-store.js";
import { logServer } from "../audit/audit-logger.js";
import { ENV, CHUNK, PATHS } from "../utils/config.js";
import {
  verifyEntitiesWithLlm, checkOllama, setLlmLogger,
  DEFAULT_LLM_CONFIG, type LlmConfig,
} from "./llm-verifier.js";
import { SUPPORTED_ENTITIES } from "../engine/entity-types.js";
import { exec } from "node:child_process";

/** Open a URL in the default browser (copied from review-server.ts to avoid HTML import chain) */
function openBrowser(url: string): void {
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors */ });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8767;
const PORT = parseInt(process.env.PII_LOCAL_PORT || String(DEFAULT_PORT), 10);

// ── LLM Verification Config ─────────────────────────────────────────────────
const LLM: LlmConfig = { ...DEFAULT_LLM_CONFIG };
setLlmLogger(logServer);

// ── Batch Session (cross-document shared placeholder state) ─────────────────
// ── Persistent shared state (cross-document placeholder consistency) ─────────
interface BatchDocument {
  filename: string;
  sessionId: string;
  entityCount: number;
  anonymizedText: string;
  originalText: string;
}

interface BatchSession {
  id: string;
  state: PlaceholderState;
  documents: BatchDocument[];
  createdAt: number;
}

/** Always-active session — every upload/anonymize reuses the same placeholder
 *  counters so identical entities across documents get the same placeholder. */
let activeBatch: BatchSession = newBatchSession();

function newBatchSession(): BatchSession {
  return {
    id: newSessionId(),
    state: createPlaceholderState(),
    documents: [],
    createdAt: Date.now(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, msg: string, status = 400): void {
  sendJson(res, { error: msg }, status);
}

// ── Local detect pipeline (parallel to PIIEngine) ───────────────────────────
// Same 7-stage pipeline but uses local-ner.ts instead of ner-backend.ts

// Verbatim propagation constants (same as pii-engine.ts)
const PROPAGATE_TYPES = new Set(["PERSON", "ORGANIZATION", "LOCATION", "NRP", "ADDRESS", "DATE_OF_BIRTH"]);
const PROPAGATE_MIN_LEN = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function propagateVerbatimMatches(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  if (entities.length === 0) return entities;
  type Source = { rawText: string; type: string; score: number; reason?: string };
  const byNorm = new Map<string, Source>();

  for (const e of entities) {
    if (!PROPAGATE_TYPES.has(e.type)) continue;
    if (!e.text || e.text.length < PROPAGATE_MIN_LEN) continue;
    const norm = e.text.toLowerCase().trim().replace(/[.,;:]+$/, "").replace(/\s+/g, " ");
    if (norm.length < PROPAGATE_MIN_LEN) continue;
    const ex = byNorm.get(norm);
    if (!ex || e.text.length > ex.rawText.length || e.score > ex.score) {
      byNorm.set(norm, { rawText: e.text, type: e.type, score: e.score, reason: e.reason });
    }
  }
  if (byNorm.size === 0) return entities;

  // Drop substrings
  const sources: Source[] = [];
  const norms = Array.from(byNorm.entries());
  for (const [norm, src] of norms) {
    let dominated = false;
    for (const [oNorm, oSrc] of norms) {
      if (oNorm !== norm && oSrc.type === src.type && oNorm.length > norm.length && oNorm.includes(norm)) {
        dominated = true; break;
      }
    }
    if (!dominated) sources.push(src);
  }

  const sortedExisting = [...entities].sort((a, b) => a.start - b.start);
  const overlaps = (s: number, e: number) => {
    for (const ex of sortedExisting) {
      if (ex.end <= s) continue;
      if (ex.start >= e) return false;
      return true;
    }
    return false;
  };

  const propagated: DetectedEntity[] = [];
  for (const src of sources) {
    try {
      // Fuzzy whitespace: "NICHOLAS JON FOREMAN" matches "NICHOLAS\n \nJON\n \nFOREMAN"
      const escapedWords = src.rawText.split(/\s+/).map(w => escapeRegExp(w));
      const fuzzyPattern = escapedWords.join("\\s+");
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${fuzzyPattern}(?![\\p{L}\\p{N}_])`, "giu");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const s = m.index, e = s + m[0].length;
        if (!overlaps(s, e)) {
          propagated.push({
            text: m[0], type: src.type, start: s, end: e,
            score: src.score, verified: false,
            reason: `propagated:fuzzy:${src.reason || "ner"}`,
          });
        }
      }
    } catch { /* invalid regex */ }
  }

  return propagated.length > 0 ? [...entities, ...propagated] : entities;
}

// filterGarbageNerEntities — imported from ../engine/false-positive-filter.js

// mergeAdjacentLocations — imported from ../engine/entity-dedup.js

async function localDetect(text: string): Promise<DetectedEntity[]> {
  logServer(`[Detect] START text=${text.length} chars`);
  const minScore = ENV.PII_MIN_SCORE;

  // 1. Pattern recognizers
  logServer(`[Detect] step 1: patterns...`);
  const patternResults = runPatternRecognizers(text);
  logServer(`[Detect] step 1 done: ${patternResults.length} pattern entities`);

  // 2. NER (local pipeline)
  let nerResults: DetectedEntity[] = [];
  if (isNerReady()) {
    logServer(`[Detect] step 2: NER (local-ner)...`);
    const nerThreshold = ENV.PII_NER_THRESHOLD;
    nerResults = await runNerChunked(text, nerThreshold, CHUNK.DEFAULT_SIZE) as DetectedEntity[];
    logServer(`[Detect] step 2 done: ${nerResults.length} NER entities`);
    for (const e of nerResults) {
      logServer(`[Detect]   NER: "${e.text}" [${e.type}] score=${e.score.toFixed(3)} at [${e.start}:${e.end}]`);
    }

    // 2.3. Filter garbage NER entities (chunking artifacts, boilerplate)
    const beforeGarbage = nerResults.length;
    nerResults = filterGarbageNerEntities(text, nerResults);
    if (nerResults.length < beforeGarbage) {
      logServer(`[Detect] step 2.3: filtered ${beforeGarbage - nerResults.length} garbage entities → ${nerResults.length} remaining`);
    }

    // 2.5. Merge adjacent LOCATION fragments into full addresses
    nerResults = mergeAdjacentLocations(text, nerResults);
  } else {
    logServer(`[Detect] step 2: NER not ready, patterns only`);
  }

  // 3. Merge + filter
  logServer(`[Detect] step 3: merge + filter (minScore=${minScore})...`);
  let all = [...patternResults, ...nerResults].filter((e) => e.score >= minScore);
  logServer(`[Detect] step 3 done: ${all.length} after filter`);

  // 3.5. Expand ORG boundaries + trim prefix + truncated multi-word locations
  all = expandOrgBoundaries(text, all);
  all = trimOrgPrefix(text, all);
  all = expandLocationBoundaries(text, all);

  // 4. Dedup
  logServer(`[Detect] step 4: dedup...`);
  all = deduplicateOverlaps(all);
  logServer(`[Detect] step 4 done: ${all.length} after dedup`);

  // 5. Clean boundaries + false positive filter
  logServer(`[Detect] step 5: cleanBoundaries...`);
  all = cleanBoundaries(text, all);
  logServer(`[Detect] step 5 done: ${all.length} after clean`);

  // 5.5. Merge adjacent LOCATION entities (address fragments from patterns + NER)
  const locsBefore = all.filter(e => e.type === "LOCATION").length;
  all = mergeAdjacentLocations(text, all);
  const locsAfter = all.filter(e => e.type === "LOCATION").length;
  if (locsBefore !== locsAfter) {
    logServer(`[Detect] step 5.5: merged ${locsBefore} LOCATION fragments → ${locsAfter} entities`);
  }

  // 5.6. Expand LOCATION entities upward into multi-line address blocks
  all = expandAddressBlocks(text, all);

  // 7. Re-filter jurisdiction + currency (merge may re-create filtered spans)
  all = filterJurisdictionEntities(all, text);
  all = filterCurrencyEntities(all, text);

  // 6. Verbatim propagation
  logServer(`[Detect] step 6: propagateVerbatimMatches...`);
  all = propagateVerbatimMatches(text, all);
  all = deduplicateOverlaps(all);

  // 6.5. LLM verification (if enabled)
  if (LLM.enabled) {
    logServer(`[Detect] step 6.5: LLM verification (model=${LLM.model})...`);
    const beforeLlm = all.length;
    all = await verifyEntitiesWithLlm(text, all, LLM, (batch, total) => {
      logServer(`[Detect] step 6.5: LLM batch ${batch}/${total}...`);
    });
    all = deduplicateOverlaps(all);
    logServer(`[Detect] step 6.5 done: ${beforeLlm} → ${all.length} entities`);

    // 6.6. Re-propagate LLM-discovered entities (e.g. person name found by LLM
    //       may appear elsewhere with different whitespace: "NICHOLAS\n \nJON\n \nFOREMAN")
    const hasDiscovered = all.some(e => e.reason?.includes("llm:discovered"));
    if (hasDiscovered) {
      logServer(`[Detect] step 6.6: re-propagate LLM discoveries...`);
      const before66 = all.length;
      all = propagateVerbatimMatches(text, all);
      all = deduplicateOverlaps(all);
      logServer(`[Detect] step 6.6 done: ${before66} → ${all.length} entities`);
    }

    // 6.7. Re-filter false positives (LLM discoveries bypass step 5's filterFalsePositives)
    logServer(`[Detect] step 6.7: re-filter false positives after LLM...`);
    const before67 = all.length;
    all = filterFalsePositives(all, text);
    logServer(`[Detect] step 6.7 done: ${before67} → ${all.length} entities`);
  }

  // 7. Re-filter jurisdiction + currency entities (propagation/LLM may re-add them)
  all = filterJurisdictionEntities(all, text);
  all = filterCurrencyEntities(all, text);

  logServer(`[Detect] DONE: ${all.length} entities`);
  for (const e of all) {
    logServer(`[Detect]   FINAL: "${e.text}" [${e.type}] score=${e.score.toFixed(3)} at [${e.start}:${e.end}] reason=${e.reason || "?"}`);
  }
  return all;
}

async function localAnonymize(text: string, prefix = "", sharedState?: PlaceholderState): Promise<{
  anonymized: string;
  mapping: Record<string, string>;
  entityCount: number;
  nerUsed: boolean;
  entities: Array<{ text: string; type: string; start: number; end: number; score: number; placeholder: string }>;
}> {
  const nerWasReady = isNerReady();
  const detected = await localDetect(text);
  const { entities, mapping } = assignPlaceholders(detected, prefix, sharedState);

  // Replace from end to start
  let result = text;
  const sorted = [...entities].sort((a, b) => b.start - a.start);
  for (const e of sorted) {
    result = result.slice(0, e.start) + e.placeholder + result.slice(e.end);
  }

  return {
    anonymized: result,
    mapping,
    entityCount: entities.length,
    nerUsed: nerWasReady || isNerReady(),
    entities: entities.map((e) => ({
      text: e.text, type: e.type, start: e.start, end: e.end,
      score: e.score, placeholder: e.placeholder!,
    })),
  };
}

// ── API Handlers ─────────────────────────────────────────────────────────────

async function handleAnonymize(body: string, res: http.ServerResponse): Promise<void> {
  try {
    const { text, language, prefix } = JSON.parse(body);
    if (!text || typeof text !== "string") {
      sendError(res, "Missing 'text' field");
      return;
    }
    const result = await localAnonymize(text, prefix || "", activeBatch.state);
    const sessionId = newSessionId();
    saveMapping(sessionId, activeBatch.state.mapping);
    saveReview(sessionId, {
      session_id: sessionId,
      entities: result.entities,
      original_text: text,
      anonymized_text: result.anonymized,
      overrides: { remove: [], add: [] },
      approved: false,
      timestamp: Date.now(),
    });

    activeBatch.documents.push({
      filename: "text-input",
      sessionId,
      entityCount: result.entityCount,
      anonymizedText: result.anonymized,
      originalText: text,
    });

    sendJson(res, {
      status: "success",
      anonymized_text: result.anonymized,
      original_text: text,
      entity_count: result.entityCount,
      session_id: sessionId,
      entities: result.entities,
      mapping: result.mapping,
      ner_used: result.nerUsed,
      batch_mapping: activeBatch.state.mapping,
      batch_document_count: activeBatch.documents.length,
      warning: result.nerUsed
        ? undefined
        : "NER model still loading. Only pattern-based detection was used. Re-run once NER is ready for full coverage.",
    });
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
}

async function handleScan(body: string, res: http.ServerResponse): Promise<void> {
  try {
    const { text, language } = JSON.parse(body);
    if (!text || typeof text !== "string") {
      sendError(res, "Missing 'text' field");
      return;
    }
    const entities = await localDetect(text);
    sendJson(res, {
      status: "success",
      entities: entities.map((e) => ({
        text: e.text,
        type: e.type,
        start: e.start,
        end: e.end,
        score: e.score,
      })),
      entity_count: entities.length,
    });
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
}

async function handleDeanonymize(body: string, res: http.ServerResponse): Promise<void> {
  try {
    const { text, session_id } = JSON.parse(body);
    if (!text || typeof text !== "string") {
      sendError(res, "Missing 'text' field");
      return;
    }
    const sid = session_id || latestSessionId() || "";
    const mapping = loadMapping(sid);
    if (Object.keys(mapping).length === 0) {
      sendError(res, `No mapping found for session '${sid}'`, 404);
      return;
    }
    let restored = text;
    const sorted = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
    for (const [placeholder, original] of sorted) {
      restored = restored.replaceAll(placeholder, original);
    }
    sendJson(res, { status: "success", deanonymized_text: restored, session_id: sid });
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
}

async function handleUpload(body: string, res: http.ServerResponse): Promise<void> {
  try {
    const { filename, content_base64, language, prefix } = JSON.parse(body);
    if (!filename || !content_base64) {
      sendError(res, "Missing 'filename' or 'content_base64'");
      return;
    }
    const ext = path.extname(filename).toLowerCase();
    const buf = Buffer.from(content_base64, "base64");
    let text: string;

    if (ext === ".pdf") {
      // Write to temp, extract, delete
      const tmpPath = path.join(os.tmpdir(), `pii_local_${Date.now()}${ext}`);
      fs.writeFileSync(tmpPath, buf);
      try {
        const { extractPdfText } = await import("../pdf/pdf-reader.js");
        text = await extractPdfText(tmpPath);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* */ }
      }
    } else if (ext === ".docx") {
      // Extract text from DOCX using table-aware extraction
      // (formats 2-column table rows as "Label: Value")
      const tmpPath = path.join(os.tmpdir(), `pii_upload_${Date.now()}${ext}`);
      fs.writeFileSync(tmpPath, buf);
      try {
        const { loadDocx, extractText } = await import("../docx/docx-reader.js");
        const model = await loadDocx(tmpPath);
        text = extractText(model);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* */ }
      }
    } else {
      // Plain text files
      text = buf.toString("utf-8");
    }

    if (!text || text.trim().length === 0) {
      sendError(res, "No extractable text found in file");
      return;
    }

    // Run through the local anonymize pipeline (shared state for cross-doc consistency)
    const result = await localAnonymize(text, prefix || "", activeBatch.state);
    const sessionId = newSessionId();
    saveMapping(sessionId, activeBatch.state.mapping);
    saveReview(sessionId, {
      session_id: sessionId,
      entities: result.entities,
      original_text: text,
      anonymized_text: result.anonymized,
      overrides: { remove: [], add: [] },
      approved: false,
      timestamp: Date.now(),
    });

    activeBatch.documents.push({
      filename,
      sessionId,
      entityCount: result.entityCount,
      anonymizedText: result.anonymized,
      originalText: text,
    });

    sendJson(res, {
      status: "success",
      anonymized_text: result.anonymized,
      original_text: text,
      entity_count: result.entityCount,
      session_id: sessionId,
      entities: result.entities,
      mapping: result.mapping,
      ner_used: result.nerUsed,
      source_filename: filename,
      batch_mapping: activeBatch.state.mapping,
      batch_document_count: activeBatch.documents.length,
    });
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
}

function handleNerStatus(res: http.ServerResponse): void {
  sendJson(res, getNerStatus());
}

function handleGetSettings(res: http.ServerResponse): void {
  const status = getNerStatus();
  sendJson(res, {
    PII_MIN_SCORE: ENV.PII_MIN_SCORE,
    PII_NER_THRESHOLD: ENV.PII_NER_THRESHOLD,
    CHUNK_THRESHOLD: CHUNK.THRESHOLD,
    CHUNK_DEFAULT_SIZE: CHUNK.DEFAULT_SIZE,
    supported_entities: SUPPORTED_ENTITIES,
    // Model & labels
    activeModel: status.activeModel,
    activePreset: status.activePreset,
    models: getModels(),
    presets: getPresets(),
    // LLM verification
    LLM_ENABLED: LLM.enabled,
    LLM_MODEL: LLM.model,
    LLM_URL: LLM.baseUrl,
  });
}

async function handleSetSettings(body: string, res: http.ServerResponse): Promise<void> {
  try {
    const data = JSON.parse(body);
    if (data.PII_MIN_SCORE !== undefined) {
      (ENV as any).PII_MIN_SCORE = Math.max(0, Math.min(1, Number(data.PII_MIN_SCORE)));
    }
    if (data.PII_NER_THRESHOLD !== undefined) {
      (ENV as any).PII_NER_THRESHOLD = Math.max(0, Math.min(1, Number(data.PII_NER_THRESHOLD)));
    }
    if (data.CHUNK_THRESHOLD !== undefined) {
      (CHUNK as any).THRESHOLD = Math.max(1000, Number(data.CHUNK_THRESHOLD));
    }
    if (data.CHUNK_DEFAULT_SIZE !== undefined) {
      (CHUNK as any).DEFAULT_SIZE = Math.max(500, Number(data.CHUNK_DEFAULT_SIZE));
    }
    // LLM settings
    if (data.LLM_ENABLED !== undefined) {
      LLM.enabled = !!data.LLM_ENABLED;
    }
    if (data.LLM_MODEL !== undefined && typeof data.LLM_MODEL === "string") {
      LLM.model = data.LLM_MODEL;
    }
    if (data.LLM_URL !== undefined && typeof data.LLM_URL === "string") {
      LLM.baseUrl = data.LLM_URL;
    }
    logServer(`[LocalApp] Settings updated: MIN_SCORE=${ENV.PII_MIN_SCORE}, NER_THRESHOLD=${ENV.PII_NER_THRESHOLD}, CHUNK=${CHUNK.THRESHOLD}/${CHUNK.DEFAULT_SIZE}, LLM=${LLM.enabled ? LLM.model : "off"}`);
    handleGetSettings(res);
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
}

async function handleSwitchModel(body: string, res: http.ServerResponse): Promise<void> {
  try {
    const { modelId } = JSON.parse(body);
    if (!modelId) { sendError(res, "Missing 'modelId'"); return; }
    await switchModel(modelId);
    sendJson(res, { status: "success", activeModel: modelId });
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
}

function handleSwitchLabels(body: string, res: http.ServerResponse): void {
  try {
    const { presetId } = JSON.parse(body);
    if (!presetId) { sendError(res, "Missing 'presetId'"); return; }
    switchLabels(presetId);
    sendJson(res, { status: "success", activePreset: presetId });
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
}

function handleSessions(res: http.ServerResponse): void {
  const sessions: Array<{ session_id: string; timestamp: number; entity_count: number; source_filename?: string }> = [];
  try {
    const files = fs.readdirSync(PATHS.MAPPINGS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("review_"));
    for (const f of files) {
      try {
        const filePath = path.join(PATHS.MAPPINGS_DIR, f);
        const stat = fs.statSync(filePath);
        const sid = f.replace(".json", "");
        const review = getReview(sid);
        sessions.push({
          session_id: sid,
          timestamp: stat.mtimeMs,
          entity_count: review?.entities?.length || 0,
          source_filename: (review as any)?.source_filename,
        });
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }
  sessions.sort((a, b) => b.timestamp - a.timestamp);
  sendJson(res, { sessions: sessions.slice(0, 50) });
}

function handleSessionDetail(sessionId: string, res: http.ServerResponse): void {
  const review = getReview(sessionId);
  const mapping = loadMapping(sessionId);
  if (!review && Object.keys(mapping).length === 0) {
    sendError(res, `Session '${sessionId}' not found`, 404);
    return;
  }
  sendJson(res, {
    session_id: sessionId,
    entities: review?.entities || [],
    original_text: review?.original_text || "",
    anonymized_text: review?.anonymized_text || "",
    mapping,
    approved: review?.approved || false,
    timestamp: review?.timestamp || 0,
  });
}

// ── Batch Reset Handler ─────────────────────────────────────────────────────

function handleBatchReset(res: http.ServerResponse): void {
  const oldCount = activeBatch.documents.length;
  logServer(`[Batch] Reset — discarding ${oldCount} documents, ${Object.keys(activeBatch.state.mapping).length} placeholders`);
  activeBatch = newBatchSession();
  sendJson(res, { status: "success", message: `Reset batch (was ${oldCount} docs)` });
}

function handleBatchStatus(res: http.ServerResponse): void {
  sendJson(res, {
    batch_id: activeBatch.id,
    documents: activeBatch.documents.map((d) => ({
      filename: d.filename,
      session_id: d.sessionId,
      entity_count: d.entityCount,
    })),
    mapping: activeBatch.state.mapping,
    total_entities: Object.keys(activeBatch.state.mapping).length,
  });
}

// ── SSE Log Streaming ────────────────────────────────────────────────────────

function handleLogSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("retry: 2000\n\n");

  const logFiles: Record<string, string> = {
    ner: path.join(PATHS.AUDIT_DIR, "ner_debug.log"),
    audit: path.join(PATHS.AUDIT_DIR, "mcp_audit.log"),
    server: path.join(PATHS.AUDIT_DIR, "server.log"),
  };

  // Start from current end of each file
  const offsets: Record<string, number> = {};
  for (const [name, filePath] of Object.entries(logFiles)) {
    try {
      offsets[name] = fs.statSync(filePath).size;
    } catch {
      offsets[name] = 0;
    }
  }

  const interval = setInterval(() => {
    for (const [name, filePath] of Object.entries(logFiles)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > offsets[name]) {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(stat.size - offsets[name]);
          fs.readSync(fd, buf, 0, buf.length, offsets[name]);
          fs.closeSync(fd);
          offsets[name] = stat.size;
          const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim());
          for (const line of lines) {
            res.write(`event: ${name}\ndata: ${JSON.stringify(line)}\n\n`);
          }
        } else if (stat.size < offsets[name]) {
          // File was truncated/rotated
          offsets[name] = 0;
        }
      } catch { /* file may not exist yet */ }
    }
  }, 1000);

  req.on("close", () => clearInterval(interval));
}

// ── Static HTML Serving ──────────────────────────────────────────────────────

let _cachedHtml: string | null = null;

function serveHtml(res: http.ServerResponse): void {
  if (!_cachedHtml) {
    const htmlPath = path.join(__dirname, "local-app.html");
    try {
      _cachedHtml = fs.readFileSync(htmlPath, "utf-8");
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("local-app.html not found");
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(_cachedHtml);
}

// ── Request Router ───────────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Static
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      // Clear cache on each request in dev mode for live reload
      _cachedHtml = null;
      serveHtml(res);
      return;
    }

    // API routes
    if (req.method === "POST" && pathname === "/api/anonymize") {
      await handleAnonymize(await readBody(req), res);
    } else if (req.method === "POST" && pathname === "/api/scan") {
      await handleScan(await readBody(req), res);
    } else if (req.method === "POST" && pathname === "/api/deanonymize") {
      await handleDeanonymize(await readBody(req), res);
    } else if (req.method === "POST" && pathname === "/api/upload") {
      await handleUpload(await readBody(req), res);
    } else if (req.method === "GET" && pathname === "/api/ner-status") {
      handleNerStatus(res);
    } else if (req.method === "GET" && pathname === "/api/settings") {
      handleGetSettings(res);
    } else if (req.method === "POST" && pathname === "/api/settings") {
      await handleSetSettings(await readBody(req), res);
    } else if (req.method === "GET" && pathname === "/api/sessions") {
      handleSessions(res);
    } else if (req.method === "GET" && pathname.startsWith("/api/session/")) {
      const sessionId = pathname.split("/api/session/")[1];
      handleSessionDetail(sessionId, res);
    } else if (req.method === "GET" && pathname === "/api/models") {
      sendJson(res, { models: getModels(), presets: getPresets() });
    } else if (req.method === "POST" && pathname === "/api/switch-model") {
      await handleSwitchModel(await readBody(req), res);
    } else if (req.method === "POST" && pathname === "/api/switch-labels") {
      handleSwitchLabels(await readBody(req), res);
    } else if (req.method === "POST" && pathname === "/api/batch/reset") {
      handleBatchReset(res);
    } else if (req.method === "GET" && pathname === "/api/batch/status") {
      handleBatchStatus(res);
    } else if (req.method === "GET" && pathname === "/api/logs") {
      handleLogSSE(req, res);
    } else if (req.method === "GET" && pathname === "/api/ollama-status") {
      const status = await checkOllama({ baseUrl: LLM.baseUrl });
      sendJson(res, { ...status, currentModel: LLM.model, enabled: LLM.enabled });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  } catch (e: any) {
    console.error(`[LocalApp] Request error: ${e.message}`);
    sendError(res, e.message, 500);
  }
}

// ── Server Startup ───────────────────────────────────────────────────────────

function start(): void {
  console.error("╔══════════════��═══════════════════════════╗");
  console.error("║    PII Shield — Local Testing App        ║");
  console.error("╚══════════════════════════════════════════╝");
  console.error("");

  // Initialize local NER in background (parallel pipeline — no PIIEngine)
  initNer("gliner-pii-base-v1.0", "minimal").catch((e) => {
    console.error(`[LocalApp] NER init failed (will use patterns only): ${e.message}`);
  });
  console.error(`[LocalApp] Local NER initializing in background...`);
  console.error(`[LocalApp] Data dir: ${PATHS.DATA_DIR}`);
  console.error(`[LocalApp] Audit dir: ${PATHS.AUDIT_DIR}`);

  // Ensure audit dir exists for log streaming
  try { fs.mkdirSync(PATHS.AUDIT_DIR, { recursive: true }); } catch { /* */ }

  const server = http.createServer(handleRequest);

  let nextPort = PORT;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && nextPort < PORT + 10) {
      nextPort++;
      console.error(`[LocalApp] Port ${nextPort - 1} in use, trying ${nextPort}...`);
      server.listen(nextPort, "127.0.0.1");
    } else {
      console.error(`[LocalApp] Server error: ${err.message}`);
      process.exit(1);
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    console.error(`[LocalApp] Server running at ${url}`);
    console.error(`[LocalApp] Press Ctrl+C to stop\n`);
    logServer(`[LocalApp] Server started at ${url}`);
    openBrowser(url);
  });
}

// ── Graceful shutdown — stop Python bridge ──────────────────────────────────
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.error(`\n[LocalApp] ${sig} received, shutting down...`);
    await stopPythonBridge();
    process.exit(0);
  });
}

start();
