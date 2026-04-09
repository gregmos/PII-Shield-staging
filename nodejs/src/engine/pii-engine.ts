/**
 * PII Shield v2.0.0 — PII Engine (singleton)
 * Orchestrates NER + pattern recognizers, dedup, filtering, placeholder assignment.
 */

import { ENV } from "../utils/config.js";
import { SUPPORTED_ENTITIES } from "./entity-types.js";
import { runPatternRecognizers, type DetectedEntity } from "./pattern-recognizers.js";
import { deduplicateOverlaps, cleanBoundaries, assignPlaceholders, type AnonymizeResult } from "./entity-dedup.js";
import { initNer, isNerReady, runNer, nerLog } from "./ner-backend.js";

let _instance: PIIEngine | null = null;

// Manual chunking constants — mirror the Python v1.1.0 reference
// (server/pii_shield_server.py:_analyze_chunked, lines 912-953).
// 4000 char chunks with 250 char overlap, breaking at whitespace.
const NER_CHUNK_SIZE = 4000;
const NER_CHUNK_OVERLAP = 250;

// ── Verbatim propagation (Phase 5 Fix A) ─────────────────────────────────────
// Types eligible for word-boundary propagation across the full document.
// Pattern recognizers already match all occurrences of formatted types
// (EMAIL/PHONE/URL/IBAN/CARD/SSN/...), so propagation only adds value
// for NER-derived natural-language entities.
const PROPAGATE_TYPES = new Set([
  "PERSON",
  "ORGANIZATION",
  "LOCATION",
  "NRP",
  "ADDRESS",
  "DATE_OF_BIRTH",
]);
const PROPAGATE_MIN_LEN = 3;

function normalizeForPropagation(text: string): string {
  return text.toLowerCase().trim().replace(/[.,;:]+$/, "").replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk the full text once and add word-boundary, case-insensitive
 * occurrences of any already-detected NER entity that aren't already
 * covered by an existing span. Closes the title-page miss + the
 * "found later in body, never propagated to earlier title heading" gap.
 */
function propagateVerbatimMatches(
  text: string,
  entities: DetectedEntity[],
): DetectedEntity[] {
  if (entities.length === 0) return entities;

  // Group eligible source entities by normalized text, picking longest
  // per family (so "Acme" doesn't spawn matches when "Acme Holdings Ltd"
  // already exists), then pick highest score among ties.
  type Source = { rawText: string; type: string; score: number; reason?: string };
  const byNorm = new Map<string, Source>();

  for (const e of entities) {
    if (!PROPAGATE_TYPES.has(e.type)) continue;
    if (!e.text || e.text.length < PROPAGATE_MIN_LEN) continue;
    const norm = normalizeForPropagation(e.text);
    if (norm.length < PROPAGATE_MIN_LEN) continue;
    const existing = byNorm.get(norm);
    if (!existing) {
      byNorm.set(norm, { rawText: e.text, type: e.type, score: e.score, reason: e.reason });
    } else if (e.text.length > existing.rawText.length || e.score > existing.score) {
      byNorm.set(norm, { rawText: e.text, type: e.type, score: e.score, reason: e.reason });
    }
  }

  if (byNorm.size === 0) return entities;

  // Drop entries whose normalized text is a substring of another, longer
  // normalized text in the same type — only propagate the longest in each family.
  const sources: Source[] = [];
  const norms = Array.from(byNorm.entries());
  for (const [norm, src] of norms) {
    let dominated = false;
    for (const [otherNorm, otherSrc] of norms) {
      if (otherNorm === norm) continue;
      if (otherSrc.type !== src.type) continue;
      if (otherNorm.length > norm.length && otherNorm.includes(norm)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) sources.push(src);
  }

  // Build interval set of existing spans for fast overlap rejection.
  const sortedExisting = [...entities].sort((a, b) => a.start - b.start);
  const overlapsExisting = (s: number, e: number): boolean => {
    // Linear scan is fine — entity counts are O(hundreds).
    for (const ex of sortedExisting) {
      if (ex.end <= s) continue;
      if (ex.start >= e) return false;
      return true;
    }
    return false;
  };

  const propagated: DetectedEntity[] = [];

  for (const src of sources) {
    let pattern: RegExp;
    try {
      // Unicode-aware word boundary: not preceded/followed by a letter/digit/underscore.
      pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(src.rawText)}(?![\\p{L}\\p{N}_])`,
        "giu",
      );
    } catch {
      continue;
    }

    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      if (m[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      if (overlapsExisting(s, e)) continue;
      propagated.push({
        text: m[0],
        type: src.type,
        start: s,
        end: e,
        score: src.score,
        verified: false,
        reason: `propagated:exact:${src.reason || "ner"}`,
      });
    }
  }

  if (propagated.length === 0) return entities;

  nerLog(`[NER] verbatim propagation: +${propagated.length} spans from ${sources.length} unique sources`);
  return [...entities, ...propagated];
}

/**
 * Manual chunked NER inference. Mirrors Python v1.1.0 _analyze_chunked.
 * Splits long text into 4000-char chunks with 250-char overlap, breaks at
 * whitespace to avoid mid-word splits, calls non-chunked runNer per chunk,
 * offset-shifts results back to full-text positions, dedups by (start,end,type).
 *
 * For text ≤ chunk_size this degenerates to a single runNer call.
 * Visible chunk boundaries (vs gliner's opaque inference_with_chunking)
 * make recall debugging tractable via the audit log.
 */
async function runNerChunkedManual(
  text: string,
  threshold: number,
): Promise<DetectedEntity[]> {
  if (text.length <= NER_CHUNK_SIZE) {
    return await runNer(text, threshold);
  }

  const totalChunks = Math.ceil(text.length / NER_CHUNK_SIZE);
  nerLog(`[NER] manual chunking: ~${totalChunks} chunks, size=${NER_CHUNK_SIZE}, overlap=${NER_CHUNK_OVERLAP}`);

  const allResults: DetectedEntity[] = [];
  let start = 0;
  let chunkNum = 0;

  while (start < text.length) {
    let end = Math.min(start + NER_CHUNK_SIZE, text.length);
    // Try to break at whitespace inside [end-overlap, end]
    if (end < text.length) {
      const wsSearchStart = start + NER_CHUNK_SIZE - NER_CHUNK_OVERLAP;
      const ws = text.lastIndexOf(" ", end);
      if (ws > Math.max(start, wsSearchStart)) {
        end = ws + 1;
      }
    }
    const chunk = text.slice(start, end);
    chunkNum++;
    const t0 = Date.now();
    const chunkResults = await runNer(chunk, threshold);
    nerLog(`[NER] chunk ${chunkNum}/${totalChunks} [${start}:${end}] (${end - start} chars) → ${chunkResults.length} entities (${Date.now() - t0}ms)`);
    // Offset-shift to full-text positions
    for (const r of chunkResults) {
      allResults.push({
        ...r,
        start: r.start + start,
        end: r.end + start,
      });
    }
    if (end >= text.length) break;
    start = end - NER_CHUNK_OVERLAP;
  }

  // Dedup by (start, end, type) keeping highest score
  const seen = new Map<string, DetectedEntity>();
  for (const r of allResults.sort((a, b) => a.start - b.start || b.score - a.score)) {
    const key = `${r.start}:${r.end}:${r.type}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  const unique = Array.from(seen.values());
  nerLog(`[NER] manual chunking done: ${chunkNum} chunks, ${allResults.length} raw → ${unique.length} unique`);
  return unique;
}

export class PIIEngine {
  private _initialized = false;
  private _nerInitPromise: Promise<void> | null = null;

  static getInstance(): PIIEngine {
    if (!_instance) {
      _instance = new PIIEngine();
    }
    return _instance;
  }

  /**
   * Start NER initialization in the background.
   * Does NOT block — patterns work immediately, NER joins when ready.
   */
  startNerBackground(): void {
    if (this._nerInitPromise) return;
    this._nerInitPromise = initNer()
      .then(() => console.error("[PII Engine] NER ready (background init complete)"))
      .catch((e) => console.error(`[PII Engine] NER unavailable: ${e}`));
  }

  async ensureReady(): Promise<void> {
    if (this._initialized) return;

    // Kick off NER in background if not already started
    this.startNerBackground();

    // Don't block on NER — patterns are always available
    console.error("[PII Engine] Ready (patterns mode, NER loading in background)");
    this._initialized = true;
  }

  /**
   * Wait for NER to finish initializing with polling.
   * On first run NER may need minutes (npm install + model download + init).
   * Polls every intervalMs, up to maxAttempts times.
   */
  async waitForNer(intervalMs = 25000, maxAttempts = 20): Promise<void> {
    if (isNerReady()) return;
    if (!this._nerInitPromise) return;

    for (let i = 0; i < maxAttempts; i++) {
      await Promise.race([
        this._nerInitPromise,
        new Promise<void>((r) => setTimeout(r, intervalMs)),
      ]);
      if (isNerReady()) {
        console.error(`[PII Engine] NER became ready after ${i + 1} wait cycle(s)`);
        return;
      }
      console.error(`[PII Engine] NER not ready yet, waiting... (${i + 1}/${maxAttempts})`);
    }
    console.error(`[PII Engine] NER still not ready after ${maxAttempts} attempts, proceeding with patterns only`);
  }

  /**
   * Detect PII entities in text using NER + pattern recognizers.
   * Returns raw entity list (before placeholder assignment).
   */
  async detect(text: string, language = "en"): Promise<DetectedEntity[]> {
    await this.ensureReady();
    // Wait for NER — polls every 10s, up to 5 times (~50s).
    // Fits within Cowork's 60s tool timeout. If NER still loading on first run,
    // returns patterns-only result with warning. User re-runs after NER is ready.
    await this.waitForNer(10000, 5);
    const minScore = ENV.PII_MIN_SCORE;

    // 1. Pattern recognizers
    const patternResults = runPatternRecognizers(text);

    // 2. NER results from GLiNER ONNX (manual chunking — see runNerChunkedManual)
    const nerThreshold = ENV.PII_NER_THRESHOLD;
    const nerResults = await runNerChunkedManual(text, nerThreshold);

    // 3. Merge all results
    let allResults = [...patternResults, ...nerResults];

    // 4. Filter by min score
    allResults = allResults.filter((e) => e.score >= minScore);

    // 5. Deduplicate overlapping spans
    allResults = deduplicateOverlaps(allResults);

    // 6. Clean boundaries (snap words + filter false positives)
    allResults = cleanBoundaries(text, allResults);

    // 7. Verbatim propagation (Phase 5 Fix A): re-anonymize all word-boundary
    //    occurrences of any detected NER entity text. Closes the title-page
    //    miss (GLiNER scores isolated headings low) and the legacy gap where
    //    a name found in the body was never propagated to earlier occurrences.
    allResults = propagateVerbatimMatches(text, allResults);
    allResults = deduplicateOverlaps(allResults);

    return allResults;
  }

  /**
   * Detect + assign placeholders. Returns anonymization result with mapping.
   */
  async anonymize(text: string, language = "en", prefix = ""): Promise<AnonymizeResult> {
    const entities = await this.detect(text, language);
    return assignPlaceholders(entities, prefix);
  }

  /**
   * Apply anonymization to text — replace entity text with placeholders.
   * Returns the anonymized text string.
   */
  async anonymizeText(
    text: string,
    language = "en",
    prefix = "",
  ): Promise<{
    anonymized: string;
    mapping: Record<string, string>;
    entityCount: number;
    nerUsed: boolean;
    entities: Array<{ text: string; type: string; start: number; end: number; score: number; placeholder: string }>;
  }> {
    const nerWasReady = isNerReady();
    const { entities, mapping } = await this.anonymize(text, language, prefix);

    // Replace from end to start to preserve positions
    let result = text;
    const sorted = [...entities].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      result = result.slice(0, e.start) + e.placeholder + result.slice(e.end);
    }

    // Return entities for review data
    const entityList = entities.map((e) => ({
      text: e.text, type: e.type, start: e.start, end: e.end,
      score: e.score, placeholder: e.placeholder!,
    }));

    return { anonymized: result, mapping, entityCount: entities.length, nerUsed: nerWasReady || isNerReady(), entities: entityList };
  }

  get isNerReady(): boolean {
    return isNerReady();
  }

  get supportedEntities(): readonly string[] {
    return SUPPORTED_ENTITIES;
  }
}
