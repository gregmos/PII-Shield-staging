/**
 * PII Shield v2.0.0 — Entity deduplication and placeholder assignment
 * Ported from pii_shield_server.py lines 622-1107
 *
 * Pipeline:
 * 1. Overlap resolution (keep higher-score span)
 * 2. Word boundary snapping
 * 3. False positive filtering (separate module)
 * 4. Family-based placeholder assignment: "Acme" → <ORG_1>, "Acme Corp." → <ORG_1a>
 */

import { TAG_NAMES } from "./entity-types.js";
import { filterFalsePositives } from "./false-positive-filter.js";
import type { DetectedEntity } from "./pattern-recognizers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlaceholderEntity extends DetectedEntity {
  placeholder: string;
}

export interface AnonymizeResult {
  entities: PlaceholderEntity[];
  mapping: Record<string, string>; // placeholder → raw text
}

// ── Normalize ────────────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/[.,;:]+$/, "").replace(/\s+/g, " ");
}

// ── 1. Overlap resolution ────────────────────────────────────────────────────

export function deduplicateOverlaps(results: DetectedEntity[]): DetectedEntity[] {
  if (results.length === 0) return [];

  const sorted = [...results].sort((a, b) => a.start - b.start || b.score - a.score);
  const deduped: DetectedEntity[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    const last = deduped[deduped.length - 1];
    if (r.start >= last.end) {
      deduped.push(r);
    } else if (r.score > last.score) {
      // Same type: prefer longer span even if score is slightly lower,
      // UNLESS the shorter span has much higher score (>= 0.90 vs < 0.80)
      // which indicates a precise pattern match vs sloppy NER boundary
      const lastLen = last.end - last.start;
      const rLen = r.end - r.start;
      if (r.type === last.type && lastLen > rLen && !(r.score >= 0.90 && last.score < 0.80)) {
        // Keep last (longer span of same type, scores close enough)
      } else {
        deduped[deduped.length - 1] = r;
      }
    }
  }

  return deduped;
}

// ── 2. Word boundary snapping ────────────────────────────────────────────────

export function snapWordBoundaries(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  const tlen = text.length;
  const splitBuf: DetectedEntity[] = [];

  for (const e of entities) {
    let { start, end } = e;

    // Snap RIGHT: if boundary is mid-word, complete the word
    if (end < tlen && end > 0 && isAlphaNum(text[end]) && isAlphaNum(text[end - 1])) {
      while (end < tlen && isAlphaNum(text[end]) && text[end] !== "\n") {
        end++;
      }
    }

    // Snap LEFT: if boundary is mid-word, complete the word
    if (start > 0 && start < end && isAlphaNum(text[start]) && isAlphaNum(text[start - 1])) {
      while (start > 0 && isAlphaNum(text[start - 1]) && text[start - 1] !== "\n") {
        start--;
      }
    }

    // Trim trailing/leading punctuation
    while (end > start && ".,;:)]'\" \t\n\r".includes(text[end - 1])) {
      end--;
    }
    while (start < end && "(['\"\t\n\r#/ ".includes(text[start])) {
      start++;
    }

    const entityText = text.slice(start, end).trim();

    if (entityText.length <= 2) {
      // Too short — drop
      (e as any)._drop = true;
    } else if (entityText.includes("\n")) {
      // ORGANIZATION entities: join lines instead of splitting.
      // PDF line-breaks in company names ("CANNASOUTH\nLIMITED") should stay
      // as one entity, not be split into "CANNASOUTH" + "LIMITED" (which then
      // gets killed by the ALL-CAPS stoplist filter).
      if (e.type === "ORGANIZATION") {
        const joined = entityText.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        if (joined.length > 2) {
          e.start = start;
          e.end = end;
          e.text = joined;
        } else {
          (e as any)._drop = true;
        }
      } else {
      // Non-ORG entities: split into separate entities per line
      (e as any)._drop = true;
      const lines = entityText.split("\n");
      let searchFrom = start;
      for (const line of lines) {
        // Trim whitespace + trailing/leading punctuation (e.g. "Avenue," → "Avenue")
        const stripped = line.trim().replace(/^[,;:.]+/, "").replace(/[,;:.]+$/, "");
        if (stripped.length > 2) {
          const lineStart = text.indexOf(stripped, searchFrom);
          if (lineStart === -1) continue;
          splitBuf.push({
            start: lineStart,
            end: lineStart + stripped.length,
            text: stripped,
            type: e.type,
            score: e.score,
            verified: e.verified,
            reason: e.reason,
          });
          searchFrom = lineStart + stripped.length;
        } else {
          const pos = text.indexOf(line, searchFrom);
          if (pos !== -1) searchFrom = pos + line.length;
        }
      }
      }
    } else if (start < end) {
      e.start = start;
      e.end = end;
      e.text = entityText;
    } else {
      (e as any)._drop = true;
    }
  }

  entities.push(...splitBuf);
  return entities.filter((e) => !(e as any)._drop);
}

function isAlphaNum(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||  // 0-9
    (code >= 65 && code <= 90) ||  // A-Z
    (code >= 97 && code <= 122) || // a-z
    code > 127                     // unicode letters
  );
}

// ── 2.5. ORG boundary expansion ─────────────────────────────────────────────
// If NER found "Deutsche Bank" as ORGANIZATION but the following word is a
// corporate suffix like "AG", expand the span to include it.

const ORG_SUFFIXES = new Set([
  "ltd", "limited", "inc", "incorporated", "corp", "corporation",
  "co", "company", "llc", "llp", "lp", "plc", "ag", "sa", "sarl",
  "gmbh", "bv", "nv", "pty", "pte", "srl", "spa", "ab", "as",
  "oy", "oyj", "kk", "se", "kg", "ohg", "ev", "eg",
]);

export function expandOrgBoundaries(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  for (const e of entities) {
    // Expand ORG entities by absorbing trailing corporate suffix
    if (e.type === "ORGANIZATION") {
      let pos = e.end;
      while (pos < text.length && text[pos] === " ") pos++;
      let wordEnd = pos;
      while (wordEnd < text.length && /[a-zA-Z.]/.test(text[wordEnd])) wordEnd++;
      if (wordEnd === pos) continue;
      const nextWord = text.slice(pos, wordEnd).replace(/\.$/, "");
      if (nextWord.length > 0 && ORG_SUFFIXES.has(nextWord.toLowerCase())) {
        e.end = wordEnd;
        e.text = text.slice(e.start, e.end);
      }
    }

    // Promote LOCATION → ORGANIZATION when followed by corporate suffix
    // e.g. "New Zealand" + " Exchange Limited" → "New Zealand Exchange Limited" [ORG]
    if (e.type === "LOCATION") {
      let pos = e.end;
      // Collect up to 3 trailing words to check for patterns like "Exchange Limited"
      const trailingWords: string[] = [];
      let scanPos = pos;
      for (let w = 0; w < 3; w++) {
        while (scanPos < text.length && /[\s]/.test(text[scanPos])) scanPos++;
        let wordEnd = scanPos;
        while (wordEnd < text.length && /[a-zA-Z.]/.test(text[wordEnd])) wordEnd++;
        if (wordEnd === scanPos) break;
        trailingWords.push(text.slice(scanPos, wordEnd));
        scanPos = wordEnd;
      }
      // Check if any trailing word is a corporate suffix
      const suffixIdx = trailingWords.findIndex(w => ORG_SUFFIXES.has(w.replace(/\.$/, "").toLowerCase()));
      if (suffixIdx >= 0) {
        // Expand to include all words up to and including the suffix
        let newEnd = e.end;
        let scan2 = e.end;
        for (let w = 0; w <= suffixIdx; w++) {
          while (scan2 < text.length && /[\s]/.test(text[scan2])) scan2++;
          while (scan2 < text.length && /[a-zA-Z.]/.test(text[scan2])) scan2++;
          newEnd = scan2;
        }
        e.end = newEnd;
        e.text = text.slice(e.start, e.end);
        e.type = "ORGANIZATION";
        e.reason = (e.reason || "") + ":promoted:loc→org";
      }
    }
  }
  return entities;
}

// ── 2.6. Trim common English words from ORG prefix ─────────────────────────
// org_mixed_suffix regex matches any capitalized words before a suffix:
// "Of Name To Tescab Holding AB" or "The Shares In Escenda Engineering AB".
// This trims leading non-company words from the start.

const ORG_TRIM_WORDS = new Set([
  // articles, prepositions, conjunctions
  "the", "a", "an", "of", "to", "in", "on", "at", "by", "for", "with", "from",
  "and", "or", "but", "nor", "not", "into", "upon", "between", "among", "through",
  // verbs / auxiliaries
  "is", "are", "was", "were", "be", "been", "being", "has", "had", "have",
  "shall", "will", "must", "should", "would", "could", "may", "might", "do", "does",
  // legal / document words
  "under", "change", "name", "shares", "share", "sale", "purchase", "agreement",
  "contract", "deed", "regarding", "dated", "schedule", "notice", "certificate",
  "resolution", "power", "articles", "memorandum",
  // legal section heading words (e.g. "TERMS A.1 Oakmere..." should not include "TERMS")
  "terms", "annex", "appendix", "section", "clause", "paragraph",
  "part", "exhibit", "recital",
  // other common words that can appear in title-case before company names
  "all", "each", "every", "any", "such", "this", "that", "these", "those",
  "its", "his", "her", "their", "our", "no", "so", "if",
]);

export function trimOrgPrefix(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  for (const e of entities) {
    if (e.type !== "ORGANIZATION") continue;

    // Strip leading section numbering: "A.1\tOakmere..." → "Oakmere..."
    const sectionPrefixRe = /^[A-Z0-9]+(?:\.\d+)+[\s\t]+/;
    const sectionMatch = e.text.match(sectionPrefixRe);
    if (sectionMatch) {
      e.start += sectionMatch[0].length;
      e.text = text.slice(e.start, e.end);
    }

    const words = e.text.split(/\s+/);
    let trimCount = 0;
    for (const w of words) {
      if (ORG_TRIM_WORDS.has(w.toLowerCase())) {
        trimCount++;
      } else {
        break;
      }
    }

    if (trimCount > 0 && trimCount < words.length) {
      // Advance start past trimmed words + whitespace
      let newStart = e.start;
      for (let t = 0; t < trimCount; t++) {
        // Skip the word
        while (newStart < e.end && !/\s/.test(text[newStart])) newStart++;
        // Skip whitespace after word
        while (newStart < e.end && /\s/.test(text[newStart])) newStart++;
      }
      if (newStart < e.end) {
        e.start = newStart;
        e.text = text.slice(e.start, e.end);
      }
    }
  }
  return entities;
}

// ── 2b. Expand truncated multi-word locations ────────────────────────────────
// NER sometimes truncates multi-word locations: "United" instead of
// "United Kingdom" / "United States", "New" instead of "New Zealand", etc.
// This table maps the truncated first word → full location name.

const LOCATION_EXPANSIONS: Record<string, string[]> = {
  "United": ["United Kingdom", "United States", "United Arab Emirates", "United Nations"],
  "New": ["New Zealand", "New York", "New Jersey", "New South Wales", "New Delhi"],
  "South": ["South Africa", "South Korea", "South Carolina", "South Dakota"],
  "North": ["North Korea", "North Carolina", "North Dakota", "North Macedonia"],
  "Sri": ["Sri Lanka"],
  "Costa": ["Costa Rica"],
  "El": ["El Salvador"],
  "Saudi": ["Saudi Arabia"],
  "Sierra": ["Sierra Leone"],
  "Hong": ["Hong Kong"],
  "Puerto": ["Puerto Rico"],
  "San": ["San Francisco", "San Jose", "San Diego", "San Marino"],
  "Los": ["Los Angeles"],
  "Las": ["Las Vegas"],
  "Kuala": ["Kuala Lumpur"],
};

export function expandLocationBoundaries(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  for (const e of entities) {
    if (e.type !== "LOCATION") continue;
    const trimmed = e.text.trim();
    const expansions = LOCATION_EXPANSIONS[trimmed];
    if (!expansions) continue;

    // Try each possible expansion against the actual text
    for (const full of expansions) {
      const candidate = text.slice(e.start, Math.min(text.length, e.start + full.length));
      if (candidate.toLowerCase() === full.toLowerCase()) {
        e.end = e.start + full.length;
        e.text = text.slice(e.start, e.end);
        break;
      }
    }
  }
  return entities;
}

// ── 2c. Merge adjacent LOCATION entities ────────────────────────────────────
// Addresses often fragment into separate LOCATIONs: "Fort", "Mumbai",
// "Maharashtra - 400001", "India". If two LOCATIONs are separated only by
// commas, dashes, whitespace, and/or postal code digits, merge into one span.
// Gap up to 30 chars (covers postal codes + newlines + indentation from
// PDF/DOCX line wrapping). Only alphabetical words (≥3 chars) in the gap
// block the merge — digits, punctuation, and short tokens are allowed.

export function mergeAdjacentLocations(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  const locs = entities
    .filter(e => e.type === "LOCATION")
    .sort((a, b) => a.start - b.start);
  const others = entities.filter(e => e.type !== "LOCATION");

  if (locs.length < 2) return entities;

  const merged: DetectedEntity[] = [];
  let current = { ...locs[0] };

  for (let i = 1; i < locs.length; i++) {
    const next = locs[i];
    const gap = text.slice(current.end, next.start);
    // Allow: commas, dashes, whitespace, digits (postal codes), periods, newlines
    // Block: any alphabetical word ≥3 chars (real text between locations)
    const canMerge =
      gap.length <= 30 &&
      /^[,.\s\-\d]*$/.test(gap);
    if (canMerge) {
      current.end = next.end;
      current.text = text.slice(current.start, current.end);
      current.score = Math.max(current.score, next.score);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return [...others, ...merged];
}

// ── 2d. Expand LOCATION entities upward into multi-line address blocks ──────
// In Notices sections, addresses appear as:
//   c/o S Wedin
//   Helenedalsvägen 14
//   SE-431 36 Mölndal
//   Sweden              ← only this is detected as LOCATION
//
// When a short LOCATION entity (country/city) sits on its own line and the
// preceding lines contain a postal code, expand the entity upward to cover
// the full address block.

const POSTAL_CODE_RE = /\b[A-Z]{0,3}[\s-]?\d{3,6}\b|\b\d{4,6}[\s-]?[A-Z]{0,3}\b/;

export function expandAddressBlocks(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  for (const e of entities) {
    if (e.type !== "LOCATION") continue;

    // Only expand short entities on their own (country/city name, no commas)
    if (e.text.includes(",") || e.text.trim().length > 30) continue;

    // Entity must be near start of its line (allow leading whitespace)
    const lineStart = text.lastIndexOf("\n", e.start - 1) + 1;
    const prefix = text.slice(lineStart, e.start);
    if (prefix.trim().length > 5) continue; // other content before entity on same line

    // Walk backwards through preceding lines
    const lookBack = text.slice(Math.max(0, e.start - 400), lineStart);
    const prevLines = lookBack.split("\n");
    // Remove trailing empty elements (lookBack ends with \n → empty last element)
    while (prevLines.length > 0 && prevLines[prevLines.length - 1].trim() === "") prevLines.pop();

    let hasPostalCode = false;
    let blockStartLine = prevLines.length; // nothing collected yet

    for (let i = prevLines.length - 1; i >= Math.max(0, prevLines.length - 6); i--) {
      const line = prevLines[i].trim();
      if (line.length === 0) break;       // empty line = block boundary
      if (line.length > 80) break;        // too long for address line

      // Check for postal code
      if (POSTAL_CODE_RE.test(line)) hasPostalCode = true;

      blockStartLine = i;
    }

    if (!hasPostalCode || blockStartLine >= prevLines.length) continue;

    // Find the char offset of the first collected line
    const firstLine = prevLines[blockStartLine];
    const searchFrom = Math.max(0, e.start - 400);
    let idx = text.indexOf(firstLine.trim(), searchFrom);
    if (idx === -1 || idx >= e.start) continue;

    // Don't overlap with existing entities
    const overlaps = entities.some(other =>
      other !== e && other.start < e.start && other.end > idx,
    );
    if (overlaps) continue;

    e.start = idx;
    e.text = text.slice(e.start, e.end);
  }

  return entities;
}

// ── 3. Clean boundaries (snap + filter) ──────────────────────────────────────

export function cleanBoundaries(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  entities = snapWordBoundaries(text, entities);
  entities = filterFalsePositives(entities, text);
  return entities;
}

// ── 4. Placeholder assignment (family-based dedup) ───────────────────────────

interface FamilyInfo {
  familyNumber: number;
  variantCounter: number;
}

/** Shared state for cross-document placeholder consistency (batch mode). */
export interface PlaceholderState {
  typeCounters: Map<string, number>;
  seenExact: Map<string, string>;
  seenFamily: Map<string, FamilyInfo>;
  mapping: Record<string, string>;
}

/** Create a fresh, empty PlaceholderState. */
export function createPlaceholderState(): PlaceholderState {
  return {
    typeCounters: new Map(),
    seenExact: new Map(),
    seenFamily: new Map(),
    mapping: {},
  };
}

function getOrCreatePlaceholder(
  etype: string,
  text: string,
  typeCounters: Map<string, number>,
  seenExact: Map<string, string>,
  seenFamily: Map<string, FamilyInfo>,
  mapping: Record<string, string>,
  prefix: string,
): string {
  const norm = normalize(text);
  const exactKey = `${etype}::${norm}`;

  // 1. Exact match — reuse placeholder
  if (seenExact.has(exactKey)) {
    return seenExact.get(exactKey)!;
  }

  const tag = TAG_NAMES[etype] || etype;

  // 2. Family match (substring)
  // Require shorter text ≥ 50% of longer text's length to avoid grouping
  // "Mumbai" (6 chars) with "4th Floor, HSBC Building, Mumbai..." (80 chars).
  let familyKey: string | null = null;
  if (norm.length >= 4) {
    for (const [key, info] of seenFamily) {
      const [ft, fn] = key.split("::", 2);
      if (ft !== etype) continue;
      if (fn.length >= 4 && (norm.includes(fn) || fn.includes(norm))) {
        const shorter = Math.min(norm.length, fn.length);
        const longer = Math.max(norm.length, fn.length);
        if (shorter / longer >= 0.5) {
          familyKey = key;
          break;
        }
      }
    }
  }

  let placeholder: string;

  if (familyKey) {
    // Add as variant to existing family
    const info = seenFamily.get(familyKey)!;
    info.variantCounter++;
    const suffix =
      info.variantCounter <= 26
        ? String.fromCharCode(96 + info.variantCounter) // a, b, c, ...
        : String(info.variantCounter);
    placeholder = prefix
      ? `<${prefix}_${tag}_${info.familyNumber}${suffix}>`
      : `<${tag}_${info.familyNumber}${suffix}>`;
  } else {
    // New family
    const count = (typeCounters.get(etype) || 0) + 1;
    typeCounters.set(etype, count);
    placeholder = prefix
      ? `<${prefix}_${tag}_${count}>`
      : `<${tag}_${count}>`;
    seenFamily.set(`${etype}::${norm}`, { familyNumber: count, variantCounter: 0 });
  }

  seenExact.set(exactKey, placeholder);
  mapping[placeholder] = text;
  return placeholder;
}

/**
 * Assign indexed placeholders to entities.
 * Returns mapping dict (placeholder → raw text).
 *
 * Pass a `sharedState` to reuse counters / mapping across multiple documents
 * (batch mode).  When omitted, fresh state is created per call (default).
 */
export function assignPlaceholders(
  entities: DetectedEntity[],
  prefix = "",
  sharedState?: PlaceholderState,
): AnonymizeResult {
  const state = sharedState || createPlaceholderState();
  const { typeCounters, seenExact, seenFamily, mapping } = state;

  // Sort by position for consistent numbering
  const sorted = [...entities].sort((a, b) => a.start - b.start);

  const result: PlaceholderEntity[] = sorted.map((e) => ({
    ...e,
    placeholder: getOrCreatePlaceholder(
      e.type, e.text, typeCounters, seenExact, seenFamily, mapping, prefix,
    ),
  }));

  return { entities: result, mapping };
}
