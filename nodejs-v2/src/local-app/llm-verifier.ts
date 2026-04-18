/**
 * LLM PII Extraction via local Ollama — "Extraction Mode".
 *
 * Instead of asking the LLM to verify/reject individual NER entities,
 * we ask it to independently extract ALL PII from text windows near
 * detected entities. Then we cross-reference: NER+LLM match → confirmed,
 * NER-only → kept, LLM-only → discovered.
 *
 * Designed for 2-4B parameter models (Qwen 3.5, Gemma 4, etc.)
 */

import type { DetectedEntity } from "../engine/pattern-recognizers.js";
import { SUPPORTED_ENTITIES } from "../engine/entity-types.js";

const VALID_ENTITY_TYPES = new Set<string>(SUPPORTED_ENTITIES);

// ── Configuration ────────────────────────────────────────────────────────────

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;        // default: "http://localhost:11434"
  model: string;          // default: "qwen3.5-4b:latest"
  confirmBoost: number;   // score boost when LLM confirms entity (default: 0.1)
  keepAlive: string;      // Ollama keep_alive duration (default: "10m")
  timeout: number;        // per-request timeout ms (default: 120000)
  maxBatches: number;     // cap batches for very long docs (default: 10)
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  baseUrl: "http://localhost:11434",
  model: "qwen3.5-4b:latest",
  confirmBoost: 0.1,
  keepAlive: "10m",
  timeout: 180000,
  maxBatches: 15,
};

// ── Types ────────────────────────────────────────────────────────────────────

interface LlmExtractedEntity {
  text: string;
  type: string;
}

interface LlmExtractionResponse {
  entities: LlmExtractedEntity[];
}

interface EntityBatch {
  entities: DetectedEntity[];
  windowStart: number;
  windowEnd: number;
}

type LogFn = (msg: string) => void;
let _log: LogFn = () => {};

export function setLlmLogger(fn: LogFn): void {
  _log = fn;
}

// ── Ollama Health Check ──────────────────────────────────────────────────────

export async function checkOllama(
  config: Pick<LlmConfig, "baseUrl">,
): Promise<{ ok: boolean; models: string[] }> {
  try {
    const resp = await fetch(`${config.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { ok: false, models: [] };
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    const models = (data.models || []).map((m) => m.name);
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

// ── Ollama Warmup (prevents cold-start timeouts) ────────────────────────────

let _warmedUpModel = "";

async function warmupOllama(config: LlmConfig): Promise<void> {
  if (_warmedUpModel === config.model) return;
  _warmedUpModel = config.model;

  _log(`[LLM] Warming up model ${config.model}...`);
  const t0 = Date.now();
  try {
    const resp = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        options: { num_predict: 1, num_ctx: 256 },
      }),
      signal: AbortSignal.timeout(120000), // 2 min for model loading
    });
    if (resp.ok) {
      _log(`[LLM] Warmup done in ${Date.now() - t0}ms`);
    } else {
      _log(`[LLM] Warmup failed: HTTP ${resp.status}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    _log(`[LLM] Warmup failed: ${msg}`);
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function verifyEntitiesWithLlm(
  text: string,
  entities: DetectedEntity[],
  config: LlmConfig,
  onProgress?: (batch: number, total: number) => void,
): Promise<DetectedEntity[]> {
  if (!config.enabled || entities.length === 0) return entities;

  // Warmup: send a tiny request to force Ollama to load the model into memory.
  // Without this, the first real batch often times out due to cold-start model loading.
  await warmupOllama(config);

  // Separate pattern-based entities (pass through) from NER entities (cross-reference)
  const patternEntities: DetectedEntity[] = [];
  const nerEntities: DetectedEntity[] = [];

  for (const e of entities) {
    if (e.reason?.startsWith("pattern:")) {
      patternEntities.push(e);
    } else {
      nerEntities.push(e);
    }
  }

  // Use ALL entities for proximity grouping (determines which text windows to send)
  // but only NER entities participate in cross-referencing
  const allForGrouping = [...entities].sort((a, b) => a.start - b.start);

  if (allForGrouping.length === 0) {
    return entities;
  }

  const batches = groupEntitiesByProximity(allForGrouping, text, 500, 300, 1500);
  const cappedBatches = selectBatches(batches, config.maxBatches);

  if (batches.length > config.maxBatches) {
    _log(`[LLM] Selected ${cappedBatches.length} of ${batches.length} batches (pattern-priority)`);
  }

  _log(`[LLM] Extraction mode: ${cappedBatches.length} batches, ${entities.length} entities (${patternEntities.length} pattern, ${nerEntities.length} NER)`);

  // Collect all LLM extractions across batches
  const allLlmEntities: Array<LlmExtractedEntity & { windowStart: number; windowEnd: number }> = [];

  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;

  for (let i = 0; i < cappedBatches.length; i++) {
    const batch = cappedBatches[i];
    onProgress?.(i + 1, cappedBatches.length);
    _log(`[LLM] Batch ${i + 1}/${cappedBatches.length}: window [${batch.windowStart}:${batch.windowEnd}] (${batch.windowEnd - batch.windowStart} chars)`);

    try {
      const extracted = await extractFromWindow(text, batch, config);

      // Batch hallucination guard: real windows (600-1200 chars) yield 1-5 entities,
      // max ~13 on entity-dense sections. 15+ is likely hallucination.
      // Instead of discarding, send a confirmation request to the LLM to filter.
      const MAX_ENTITIES_PER_BATCH = 15;
      let finalExtracted = extracted;
      if (extracted.length > MAX_ENTITIES_PER_BATCH) {
        _log(`[LLM] Batch ${i + 1} has ${extracted.length} entities (>${MAX_ENTITIES_PER_BATCH}) — sending confirmation request`);
        try {
          finalExtracted = await confirmBatchEntities(extracted, config);
          _log(`[LLM] Batch ${i + 1} confirmation: ${extracted.length} → ${finalExtracted.length} entities`);
          // If confirmation still returns too many, something is wrong — discard
          if (finalExtracted.length > MAX_ENTITIES_PER_BATCH) {
            _log(`[LLM] Batch ${i + 1} DISCARDED: confirmation still returned ${finalExtracted.length} entities`);
            continue;
          }
        } catch (err) {
          _log(`[LLM] Batch ${i + 1} confirmation FAILED: ${err}. Discarding batch.`);
          continue;
        }
      }

      consecutiveFailures = 0; // reset on success
      for (const e of finalExtracted) {
        allLlmEntities.push({ ...e, windowStart: batch.windowStart, windowEnd: batch.windowEnd });
      }
      _log(`[LLM] Batch ${i + 1} done: ${finalExtracted.length} entities extracted`);
    } catch (err) {
      consecutiveFailures++;
      _log(`[LLM] Batch ${i + 1} FAILED: ${err}. Skipping.`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        _log(`[LLM] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — aborting LLM verification`);
        break;
      }
    }
  }

  // Cross-reference LLM extractions with all existing entities
  const result = crossReferenceResults(text, entities, allLlmEntities, config.confirmBoost);

  _log(`[LLM] Final: ${result.length} entities (${patternEntities.length} pattern + ${nerEntities.length} NER + ${result.length - entities.length} discovered)`);
  return result;
}

// ── Batch Processing ─────────────────────────────────────────────────────────

async function extractFromWindow(
  fullText: string,
  batch: EntityBatch,
  config: LlmConfig,
): Promise<LlmExtractedEntity[]> {
  const textWindow = fullText.slice(batch.windowStart, batch.windowEnd);
  const prompt = buildExtractionPrompt(textWindow);

  let llmResp = await callOllama(config, prompt);

  // Retry once if empty
  if (llmResp.entities.length === 0) {
    _log(`[LLM] Empty response, retrying...`);
    llmResp = await callOllama(config, prompt);
  }

  // Repair entities truncated at window boundaries.
  // E.g., "rister Andersson" when "Christer" was cut at windowStart.
  const entities = llmResp.entities;
  for (const e of entities) {
    const posInWindow = textWindow.indexOf(e.text);
    if (posInWindow === -1) continue;
    const globalStart = batch.windowStart + posInWindow;

    // If entity starts near the beginning of the window, it may be truncated
    if (posInWindow < 3 && globalStart > 0) {
      let expandedStart = globalStart;
      while (expandedStart > 0 && /[\p{L}]/u.test(fullText[expandedStart - 1])) {
        expandedStart--;
      }
      if (expandedStart < globalStart) {
        const prefix = fullText.slice(expandedStart, globalStart);
        e.text = prefix + e.text;
        _log(`[LLM] Boundary repair: expanded to "${e.text}"`);
      }
    }

    // If entity ends near the end of the window, it may be truncated
    const posEnd = posInWindow + e.text.length;
    const windowLen = textWindow.length;
    if (posEnd > windowLen - 3) {
      const globalEnd = batch.windowStart + posEnd;
      let expandedEnd = globalEnd;
      while (expandedEnd < fullText.length && /[\p{L}]/u.test(fullText[expandedEnd])) {
        expandedEnd++;
      }
      if (expandedEnd > globalEnd) {
        const suffix = fullText.slice(globalEnd, expandedEnd);
        e.text = e.text + suffix;
        _log(`[LLM] Boundary repair: expanded to "${e.text}"`);
      }
    }
  }

  return entities;
}

// ── Batch Confirmation (hallucination filter) ───────────────────────────────

/**
 * When the initial extraction returns too many entities (likely hallucination),
 * send a second LLM request asking it to filter the list down to real PII only.
 * This preserves genuine entities while discarding hallucinated ones.
 */
async function confirmBatchEntities(
  entities: LlmExtractedEntity[],
  config: LlmConfig,
): Promise<LlmExtractedEntity[]> {
  const entityList = entities
    .map((e, i) => `${i + 1}. "${e.text}" [${e.type}]`)
    .join("\n");

  const prompt = `You previously extracted ${entities.length} entities from a text. Many of these are NOT real personal data — they are common words, legal terms, or hallucinations.

Review this list and keep ONLY entities that are ACTUAL:
- Real person names (first + last name, not roles like "Buyer" or "Seller")
- Real company/organization names (not generic words like "Company" or "Party")
- Real addresses, emails, phone numbers, ID numbers

REMOVE: generic nouns, legal terms, single common words, section titles, job roles, and anything that is not identifiable personal information about a specific person or organization.

Entity list:
${entityList}

Return ONLY the real PII entities in the same JSON format.`;

  const resp = await callOllama(config, prompt);
  return resp.entities;
}

// ── Batch Selection (pattern-priority) ──────────────────────────────────────

/**
 * Select up to maxBatches from all batches, prioritizing those that contain
 * pattern-detected entities (emails, regexes). Where there's an email →
 * there's almost always a name + address nearby that only LLM can find.
 * After selection, re-sort by document position for logical processing.
 */
function selectBatches(batches: EntityBatch[], maxBatches: number): EntityBatch[] {
  if (batches.length <= maxBatches) return batches;

  const scored = batches.map((b, idx) => {
    const patternCount = b.entities.filter(e => e.reason?.startsWith("pattern:")).length;
    const nerCount = b.entities.filter(e => !e.reason?.startsWith("pattern:")).length;
    // Pattern batches get 10× priority weight
    const priority = patternCount * 10 + nerCount;
    return { batch: b, idx, priority };
  });

  // Sort by priority descending — pattern-rich batches first
  scored.sort((a, b) => b.priority - a.priority);

  // Take top maxBatches, then re-sort by document position
  const selected = scored.slice(0, maxBatches);
  selected.sort((a, b) => a.idx - b.idx);

  return selected.map(s => s.batch);
}

// ── Grouping (entity-proximity based) ───────────────────────────────────────

function groupEntitiesByProximity(
  entities: DetectedEntity[],
  text: string,
  maxGap: number,
  padding: number,
  maxWindow: number,
): EntityBatch[] {
  const sorted = [...entities].sort((a, b) => a.start - b.start);
  const batches: EntityBatch[] = [];
  let group: DetectedEntity[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = group[group.length - 1];
    const curr = sorted[i];

    if (curr.start - prev.end <= maxGap) {
      group.push(curr);
    } else {
      batches.push(makeBatch(group, text.length, padding, maxWindow));
      group = [curr];
    }
  }
  batches.push(makeBatch(group, text.length, padding, maxWindow));

  return batches;
}

function makeBatch(
  entities: DetectedEntity[],
  textLen: number,
  padding: number,
  maxWindow: number,
): EntityBatch {
  const first = entities[0];
  const last = entities[entities.length - 1];

  let windowStart = Math.max(0, first.start - padding);
  let windowEnd = Math.min(textLen, last.end + padding);

  if (windowEnd - windowStart > maxWindow) {
    windowEnd = windowStart + maxWindow;
  }

  return { entities, windowStart, windowEnd };
}

// ── Extraction Prompt ────────────────────────────────────────────────────────

function buildExtractionPrompt(textWindow: string): string {
  return `Find all person names, company names, addresses, phone numbers, email addresses, and ID numbers in this text. Copy each one exactly as written.

Do NOT extract: legal role words (Buyer, Seller, Company, Party, Person, Contractor), section numbers, job titles, generic nouns, or technical specifications.

Text:
"""
${textWindow}
"""`;
}

// ── Ollama API Call ──────────────────────────────────────────────────────────

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          type: { type: "string" },
        },
        required: ["text", "type"],
      },
    },
  },
  required: ["entities"],
};

async function callOllama(config: LlmConfig, prompt: string): Promise<LlmExtractionResponse> {
  const body = {
    model: config.model,
    messages: [
      {
        role: "system",
        content: "You extract PII from text. Output valid JSON only. Example: {\"entities\":[{\"text\":\"Acme Holdings Ltd\",\"type\":\"ORGANIZATION\"},{\"text\":\"Jane Doe\",\"type\":\"PERSON\"},{\"text\":\"jane@example.com\",\"type\":\"EMAIL_ADDRESS\"},{\"text\":\"10 Downing Street, London\",\"type\":\"LOCATION\"}]}",
      },
      { role: "user", content: prompt },
    ],
    stream: false,
    format: EXTRACTION_SCHEMA,
    keep_alive: config.keepAlive,
    options: {
      temperature: 0,
      num_predict: 2048,
      num_ctx: 8192,
    },
  };

  const resp = await fetch(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "unknown");
    throw new Error(`Ollama HTTP ${resp.status}: ${errText}`);
  }

  const data = (await resp.json()) as { message?: { content?: string } };
  const content = data.message?.content || "";

  _log(`[LLM] Raw response (${content.length} chars): ${content.slice(0, 500)}`);

  return parseExtractionResponse(content);
}

function parseExtractionResponse(content: string): LlmExtractionResponse {
  const empty: LlmExtractionResponse = { entities: [] };

  // Strip thinking tags (Qwen: <think>...</think>, Gemma 4: <|think|>...<|/think|>)
  let cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/g, "")
    .trim();

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(cleaned);
    const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
    return { entities: entities.filter((e: any) => e && typeof e.text === "string" && typeof e.type === "string") };
  } catch { /* fall through */ }

  // Try extracting JSON from markdown code block
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
      return { entities: entities.filter((e: any) => e && typeof e.text === "string" && typeof e.type === "string") };
    } catch { /* fall through */ }
  }

  // Try brace-matching to find first valid JSON object
  const braceStart = cleaned.indexOf("{");
  if (braceStart >= 0) {
    let depth = 0;
    for (let i = braceStart; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(braceStart, i + 1));
          const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
          return { entities: entities.filter((e: any) => e && typeof e.text === "string" && typeof e.type === "string") };
        } catch { /* keep scanning */ }
      }
    }
  }

  _log(`[LLM] Failed to parse extraction response: ${cleaned.slice(0, 200)}`);
  return empty;
}

// ── Cross-Reference NER ↔ LLM ───────────────────────────────────────────────

function crossReferenceResults(
  fullText: string,
  nerEntities: DetectedEntity[],
  llmEntities: LlmExtractedEntity[],
  confirmBoost: number,
): DetectedEntity[] {
  // Track which LLM entities matched an NER entity
  const llmMatched = new Set<number>();
  const result: DetectedEntity[] = [];

  // 1. For each NER entity, check if LLM also found it
  for (const ner of nerEntities) {
    let matched = false;

    for (let j = 0; j < llmEntities.length; j++) {
      if (llmMatched.has(j)) continue;
      // Check type compatibility first — PERSON shouldn't match EMAIL_ADDRESS etc.
      const llmType = normalizeEntityType(llmEntities[j].type);
      if (!isTypeCompatible(ner.type, llmType)) continue;
      if (isTextMatch(ner.text, llmEntities[j].text)) {
        llmMatched.add(j);
        matched = true;

        // LLM confirmed this entity — boost score
        const boosted = Math.min(1.0, ner.score + confirmBoost);
        result.push({
          ...ner,
          score: boosted,
          verified: true,
          reason: (ner.reason || "") + ":llm:confirmed",
        });
        _log(`[LLM] CONFIRMED: "${ner.text}" [${ner.type}] — LLM found "${llmEntities[j].text}" [${llmEntities[j].type}]`);
        break;
      }
    }

    if (!matched) {
      // LLM didn't find it — keep as-is (conservative, never reject)
      result.push({
        ...ner,
        reason: (ner.reason || "") + ":llm:unconfirmed",
      });
    }
  }

  // 2. For each unmatched LLM entity, check if it's a discovery
  for (let j = 0; j < llmEntities.length; j++) {
    if (llmMatched.has(j)) continue;

    const llm = llmEntities[j];
    if (!llm.text || llm.text.length < 2) continue;

    // Skip garbage text (PDF artifacts like "$VV Mcosr", non-printable chars)
    // Reject if >30% of chars are non-alphanumeric/space/common punctuation
    const cleanChars = llm.text.replace(/[a-zA-Z0-9\s.,@'"\-()\/]/g, "").length;
    if (cleanChars / llm.text.length > 0.3) {
      _log(`[LLM] SKIP discovery: "${llm.text}" — garbage text`);
      continue;
    }

    // Skip very short entities (abbreviations like "PPA", "STU")
    if (llm.text.length <= 3) {
      _log(`[LLM] SKIP discovery: "${llm.text}" — too short`);
      continue;
    }

    // Skip section/clause numbers: "1.1.17", "2.3", "10.2.1"
    if (/^\d+(\.\d+)+$/.test(llm.text.trim())) {
      _log(`[LLM] SKIP discovery: "${llm.text}" — section number`);
      continue;
    }

    // Skip technical specifications (voltage, power ratings)
    if (/^\d+\s*(?:k[Vv]|[Mm][Vv][Aa]?|[Mm][Ww]|[Kk][Ww])/.test(llm.text.trim())) {
      _log(`[LLM] SKIP discovery: "${llm.text}" — technical spec`);
      continue;
    }

    // Skip legal role words that are never real PII
    const DISCOVERY_BLOCKLIST = new Set([
      "buyer", "seller", "company", "party", "parties", "person", "persons",
      "contractor", "agreement", "contract", "schedule", "clause",
      "section", "article", "appendix", "exhibit", "recital",
      "director", "officer", "employee", "agent", "trustee",
      "plaintiff", "defendant", "claimant", "respondent",
      "lender", "borrower", "landlord", "tenant", "licensor", "licensee",
      "guarantor", "indemnifier", "assignor", "assignee",
      "purchaser", "vendor", "supplier", "customer", "client",
      "shareholder", "partner", "member", "subscriber",
    ]);
    if (DISCOVERY_BLOCKLIST.has(llm.text.toLowerCase().trim())) {
      _log(`[LLM] SKIP discovery: "${llm.text}" — legal role word`);
      continue;
    }

    // Skip prompt example leakage
    if (/(?:ACME HOLDINGS|John Smith|js@example\.com|42 Park Lane)/i.test(llm.text)) {
      _log(`[LLM] SKIP discovery: "${llm.text}" — prompt example`);
      continue;
    }

    const normalizedType = normalizeEntityType(llm.type);

    // Skip unrecognized entity types (garbled LLM output like "NLP", "ORGATION", "MONEY")
    if (!VALID_ENTITY_TYPES.has(normalizedType)) {
      _log(`[LLM] SKIP discovery: "${llm.text}" — unknown type "${llm.type}"`);
      continue;
    }

    // Search for the exact text in the full document
    const positions = findAllOccurrences(fullText, llm.text);
    for (const pos of positions) {
      // Skip if overlaps any existing entity
      const overlaps = result.some(
        (e) => pos.start < e.end && pos.end > e.start,
      );
      if (!overlaps) {
        result.push({
          text: llm.text,
          type: normalizedType,
          start: pos.start,
          end: pos.end,
          score: 0.65,
          verified: true,
          reason: "llm:discovered",
        });
        _log(`[LLM] DISCOVERED: "${llm.text}" [${normalizedType}] at [${pos.start}:${pos.end}]`);
      }
    }
  }

  return result;
}

// ── Fuzzy Text Matching ─────────────────────────────────────────────────────

/** Check if two entity types are compatible (same category) */
function isTypeCompatible(nerType: string, llmType: string): boolean {
  if (nerType === llmType) return true;

  // Group compatible types
  const GROUPS: string[][] = [
    ["PERSON"],
    ["ORGANIZATION"],
    ["LOCATION", "ADDRESS"],
    ["EMAIL_ADDRESS"],
    ["PHONE_NUMBER"],
    ["ID_DOC", "US_SSN", "US_PASSPORT", "US_DRIVER_LICENSE", "UK_NIN", "UK_PASSPORT", "UK_CRN", "EU_PASSPORT", "CREDIT_CARD", "IBAN_CODE"],
    ["URL"],
    ["IP_ADDRESS"],
  ];

  let nerInGroup = false;
  let llmInGroup = false;

  for (const group of GROUPS) {
    const hasNer = group.includes(nerType);
    const hasLlm = group.includes(llmType);
    if (hasNer) nerInGroup = true;
    if (hasLlm) llmInGroup = true;
    // Both in the same group → compatible
    if (hasNer && hasLlm) return true;
  }

  // If either type is known (in a group) but they're in different groups → incompatible
  if (nerInGroup || llmInGroup) return false;

  // Both unknown types — be permissive
  return true;
}

/** Check if two entity texts refer to the same thing (case-insensitive, word-based) */
function isTextMatch(nerText: string, llmText: string): boolean {
  const a = nerText.toLowerCase().trim();
  const b = llmText.toLowerCase().trim();

  // Exact match
  if (a === b) return true;

  // One fully contains the other as a whole substring (min 4 chars to avoid noise)
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;

  // Word-level overlap: extract words from both, count shared words
  const wordsA = a.split(/[\s,.@_-]+/).filter(w => w.length >= 2);
  const wordsB = b.split(/[\s,.@_-]+/).filter(w => w.length >= 2);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const shared = wordsA.filter(w => setB.has(w)).length;

  // Require overlap in BOTH directions to prevent false matches like
  // "New Zealand Exchange Limited" (4 words) matching "CANNASOUTH PLANT RESEARCH NEW ZEALAND LIMITED" (6 words)
  // shared=3, 3/4=75% of shorter BUT 3/6=50% of longer — not enough
  const ratioA = shared / wordsA.length;
  const ratioB = shared / wordsB.length;

  return ratioA >= 0.6 && ratioB >= 0.6 && shared >= 1;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find all occurrences of a string in text (whitespace-flexible).
 *  PDF text often has different whitespace than what the LLM extracts,
 *  e.g. "30 N Gould St, Ste R,\nSheridan" vs "30 N Gould St, Ste R, Sheridan".
 *  We split the search string into tokens and match with \s+ between them. */
function findAllOccurrences(
  text: string,
  search: string,
): Array<{ start: number; end: number }> {
  const results: Array<{ start: number; end: number }> = [];

  // First try exact match (fast path)
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) break;
    results.push({ start: idx, end: idx + search.length });
    pos = idx + 1;
  }
  if (results.length > 0) return results;

  // Fuzzy: split into tokens (by whitespace AND commas), rejoin with [\s,]+ pattern.
  // This handles PDF line breaks AND LLM-added commas in addresses like
  // "30 N Gould St, Ste R, Sheridan" vs actual "30 N Gould St\nSte R\nSheridan"
  const tokens = search.split(/[\s,]+/).filter(t => t.length > 0);
  if (tokens.length < 2) return results; // single token — exact match is authoritative

  const escaped = tokens.map(t => {
    // For purely numeric tokens, match any digits of same length.
    // Handles LLM digit hallucination: "83801" matches actual "82801"
    if (/^\d+$/.test(t)) return `\\d{${t.length}}`;
    return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const pattern = new RegExp(escaped.join("[\\s,]+"), "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    results.push({ start: match.index, end: match.index + match[0].length });
    pattern.lastIndex = match.index + 1; // avoid infinite loop on zero-length
  }
  return results;
}

/** Normalize LLM entity type to our standard types */
function normalizeEntityType(type: string): string {
  const upper = type.toUpperCase().replace(/[\s_-]+/g, "_");
  const MAP: Record<string, string> = {
    PERSON: "PERSON",
    NAME: "PERSON",
    PERSON_NAME: "PERSON",
    FULL_NAME: "PERSON",
    INDIVIDUAL: "PERSON",
    ORGANIZATION: "ORGANIZATION",
    ORG: "ORGANIZATION",
    COMPANY: "ORGANIZATION",
    COMPANY_NAME: "ORGANIZATION",
    FIRM: "ORGANIZATION",
    LOCATION: "LOCATION",
    ADDRESS: "LOCATION",
    CITY: "LOCATION",
    COUNTRY: "LOCATION",
    STATE: "LOCATION",
    PHONE: "PHONE_NUMBER",
    PHONE_NUMBER: "PHONE_NUMBER",
    TELEPHONE: "PHONE_NUMBER",
    EMAIL: "EMAIL_ADDRESS",
    EMAIL_ADDRESS: "EMAIL_ADDRESS",
    ID: "ID_DOC",
    ID_DOC: "ID_DOC",
    ID_NUMBER: "ID_DOC",
    REGISTRATION_NUMBER: "ID_DOC",
    COMPANY_NUMBER: "ID_DOC",
    CIN: "ID_DOC",
    PAN: "ID_DOC",
    CREDIT_CARD: "CREDIT_CARD",
    SSN: "US_SSN",
    IBAN: "IBAN_CODE",
    URL: "URL",
    IP_ADDRESS: "IP_ADDRESS",
  };
  if (MAP[upper]) return MAP[upper];

  // Fuzzy fallback for garbled LLM types: "ORGA", "ORGATION", "PERS", etc.
  if (upper.startsWith("ORG")) return "ORGANIZATION";
  if (upper.startsWith("PER") && !upper.startsWith("PHONE")) return "PERSON";
  if (upper.startsWith("LOC") || upper.startsWith("ADDR")) return "LOCATION";
  if (upper.startsWith("EMAIL")) return "EMAIL_ADDRESS";
  if (upper.startsWith("PHONE") || upper.startsWith("TEL")) return "PHONE_NUMBER";

  return upper;
}
