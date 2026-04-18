/**
 * Batch PII Detection Test Runner
 *
 * Processes a folder of PDFs through the full detection pipeline (no LLM),
 * collecting per-document entity stats, full logs, and summary metrics.
 *
 * Usage:
 *   npx tsx src/local-app/batch-test.ts "C:/path/to/folder"
 *
 * Output (written to the same folder):
 *   batch_results.json   — full entity data per document
 *   batch_summary.txt    — human-readable summary stats
 *   batch_logs.txt       — full detection logs
 */

import "./preload.js";

import fs from "node:fs";
import path from "node:path";
import { extractPdfText } from "../pdf/pdf-reader.js";
import { runPatternRecognizers, type DetectedEntity } from "../engine/pattern-recognizers.js";
import {
  deduplicateOverlaps, expandOrgBoundaries, trimOrgPrefix,
  expandLocationBoundaries, mergeAdjacentLocations, expandAddressBlocks,
  cleanBoundaries,
} from "../engine/entity-dedup.js";
import {
  filterJurisdictionEntities, filterCurrencyEntities,
  filterGarbageNerEntities, filterFalsePositives,
} from "../engine/false-positive-filter.js";
import {
  initNer, runNerChunked, isNerReady, getNerStatus,
} from "./local-ner.js";
// logServer used internally by engine modules (audit log to file)
import { ENV, CHUNK } from "../utils/config.js";

// ── Config ──────────────────────────────────────────────────────────────────
const WAIT_FOR_NER = true;       // Wait for NER model to load before processing
const NER_TIMEOUT_MS = 120_000;  // Max wait for NER model (2 min)

// ── Logging ─────────────────────────────────────────────────────────────────
const logBuffer: string[] = [];

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logBuffer.push(line);
  process.stderr.write(line + "\n");
}

// ── Verbatim propagation (same as server.ts) ────────────────────────────────
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

// ── Detect pipeline (same as localDetect, no LLM) ──────────────────────────
async function detect(text: string): Promise<DetectedEntity[]> {
  const minScore = ENV.PII_MIN_SCORE;

  // 1. Pattern recognizers
  const patternResults = runPatternRecognizers(text);
  log(`  Step 1 patterns: ${patternResults.length} entities`);

  // 2. NER
  let nerResults: DetectedEntity[] = [];
  if (isNerReady()) {
    const nerThreshold = ENV.PII_NER_THRESHOLD;
    nerResults = await runNerChunked(text, nerThreshold, CHUNK.DEFAULT_SIZE) as DetectedEntity[];
    log(`  Step 2 NER: ${nerResults.length} entities`);

    // 2.3 Filter garbage NER
    nerResults = filterGarbageNerEntities(text, nerResults);

    // 2.5 Early location merge
    nerResults = mergeAdjacentLocations(text, nerResults);
  } else {
    log(`  Step 2 NER: not ready, patterns only`);
  }

  // 3. Merge + filter
  let all = [...patternResults, ...nerResults].filter(e => e.score >= minScore);
  log(`  Step 3 merge: ${all.length} entities (minScore=${minScore})`);

  // 3.5 Expand boundaries
  all = expandOrgBoundaries(text, all);
  all = trimOrgPrefix(text, all);
  all = expandLocationBoundaries(text, all);

  // 4. Dedup
  all = deduplicateOverlaps(all);
  log(`  Step 4 dedup: ${all.length}`);

  // 5. Clean boundaries + FP filter
  all = cleanBoundaries(text, all);
  log(`  Step 5 clean: ${all.length}`);

  // 5.5 Merge adjacent locations
  all = mergeAdjacentLocations(text, all);

  // 5.6 Expand address blocks
  all = expandAddressBlocks(text, all);

  // 5.7 Pre-propagation jurisdiction/currency filter
  all = filterJurisdictionEntities(all, text);
  all = filterCurrencyEntities(all, text);

  // 6. Verbatim propagation
  all = propagateVerbatimMatches(text, all);
  all = deduplicateOverlaps(all);

  // 7. Post-propagation filter
  all = filterJurisdictionEntities(all, text);
  all = filterCurrencyEntities(all, text);

  log(`  FINAL: ${all.length} entities`);
  return all;
}

// ── Main ────────────────────────────────────────────────────────────────────
interface DocResult {
  filename: string;
  textLength: number;
  extractionTimeMs: number;
  detectionTimeMs: number;
  entityCount: number;
  entities: Array<{
    text: string;
    type: string;
    start: number;
    end: number;
    score: number;
    reason?: string;
  }>;
  byType: Record<string, number>;
}

async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: npx tsx src/local-app/batch-test.ts <folder-path>");
    process.exit(1);
  }

  if (!fs.existsSync(folder)) {
    console.error(`Folder not found: ${folder}`);
    process.exit(1);
  }

  const files = fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith(".pdf"))
    .sort();

  if (files.length === 0) {
    console.error(`No PDF files found in: ${folder}`);
    process.exit(1);
  }

  log(`=== Batch PII Test: ${files.length} PDFs in ${folder} ===`);

  // Initialize NER
  log("Initializing NER model...");
  initNer();

  if (WAIT_FOR_NER) {
    log(`Waiting for NER model (timeout: ${NER_TIMEOUT_MS / 1000}s)...`);
    const start = Date.now();
    while (!isNerReady() && Date.now() - start < NER_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 1000));
      const status = getNerStatus();
      if (status.phase) {
        log(`  NER loading: ${status.phase} ${status.progress_pct || 0}%`);
      }
    }
    if (isNerReady()) {
      log("NER model ready.");
    } else {
      log("WARNING: NER model not ready after timeout. Running patterns-only.");
    }
  }

  const results: DocResult[] = [];
  const totalStart = Date.now();

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filePath = path.join(folder, filename);
    log(`\n--- [${i + 1}/${files.length}] ${filename} ---`);

    // Extract text
    const t0 = Date.now();
    let text: string;
    try {
      text = await extractPdfText(filePath);
    } catch (err: any) {
      log(`  ERROR extracting: ${err.message}`);
      results.push({
        filename,
        textLength: 0,
        extractionTimeMs: Date.now() - t0,
        detectionTimeMs: 0,
        entityCount: 0,
        entities: [],
        byType: {},
      });
      continue;
    }
    const extractTime = Date.now() - t0;
    log(`  Extracted: ${text.length} chars in ${extractTime}ms`);

    // Detect
    const t1 = Date.now();
    const entities = await detect(text);
    const detectTime = Date.now() - t1;

    // Stats by type
    const byType: Record<string, number> = {};
    for (const e of entities) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }

    // Log each entity
    for (const e of entities) {
      log(`  ENTITY: [${e.type}] "${e.text}" score=${e.score.toFixed(3)} [${e.start}:${e.end}] reason=${e.reason || "?"}`);
    }

    results.push({
      filename,
      textLength: text.length,
      extractionTimeMs: extractTime,
      detectionTimeMs: detectTime,
      entityCount: entities.length,
      entities: entities.map(e => ({
        text: e.text,
        type: e.type,
        start: e.start,
        end: e.end,
        score: e.score,
        reason: e.reason,
      })),
      byType,
    });

    log(`  Done: ${entities.length} entities in ${detectTime}ms | ${JSON.stringify(byType)}`);
  }

  const totalTime = Date.now() - totalStart;

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalEntities = results.reduce((s, r) => s + r.entityCount, 0);
  const totalChars = results.reduce((s, r) => s + r.textLength, 0);
  const globalByType: Record<string, number> = {};
  for (const r of results) {
    for (const [t, c] of Object.entries(r.byType)) {
      globalByType[t] = (globalByType[t] || 0) + c;
    }
  }

  const summaryLines: string[] = [
    `=== PII Detection Batch Test Summary ===`,
    `Date: ${new Date().toISOString()}`,
    `NER ready: ${isNerReady()}`,
    `Documents: ${results.length}`,
    `Total chars: ${totalChars.toLocaleString()}`,
    `Total entities: ${totalEntities}`,
    `Total time: ${(totalTime / 1000).toFixed(1)}s`,
    ``,
    `--- Entities by type (global) ---`,
    ...Object.entries(globalByType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `  ${t}: ${c}`),
    ``,
    `--- Per-document summary ---`,
    `${"Document".padEnd(50)} | Chars  | Entities | Extract | Detect  | Types`,
    `${"-".repeat(50)}-|--------|----------|---------|---------|------`,
  ];

  for (const r of results) {
    const types = Object.entries(r.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}:${c}`)
      .join(", ");
    summaryLines.push(
      `${r.filename.padEnd(50)} | ${String(r.textLength).padStart(6)} | ${String(r.entityCount).padStart(8)} | ${String(r.extractionTimeMs).padStart(5)}ms | ${String(r.detectionTimeMs).padStart(5)}ms | ${types}`
    );
  }

  summaryLines.push("");
  summaryLines.push("--- Unique entity values by type ---");

  // Collect unique entity texts per type across all documents
  const uniqueByType: Record<string, Set<string>> = {};
  for (const r of results) {
    for (const e of r.entities) {
      if (!uniqueByType[e.type]) uniqueByType[e.type] = new Set();
      uniqueByType[e.type].add(e.text);
    }
  }
  for (const [type, texts] of Object.entries(uniqueByType).sort((a, b) => a[0].localeCompare(b[0]))) {
    summaryLines.push(`\n  ${type} (${texts.size} unique):`);
    for (const t of [...texts].sort()) {
      summaryLines.push(`    - "${t}"`);
    }
  }

  const summaryText = summaryLines.join("\n");
  log("\n" + summaryText);

  // ── Write output files ────────────────────────────────────────────────────
  const outResults = path.join(folder, "batch_results.json");
  const outSummary = path.join(folder, "batch_summary.txt");
  const outLogs = path.join(folder, "batch_logs.txt");

  fs.writeFileSync(outResults, JSON.stringify(results, null, 2), "utf-8");
  fs.writeFileSync(outSummary, summaryText, "utf-8");
  fs.writeFileSync(outLogs, logBuffer.join("\n"), "utf-8");

  log(`\nOutput written to:`);
  log(`  ${outResults}`);
  log(`  ${outSummary}`);
  log(`  ${outLogs}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
