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
      deduped[deduped.length - 1] = r;
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
      // Entity spans multiple lines — split
      (e as any)._drop = true;
      const lines = entityText.split("\n");
      let searchFrom = start;
      for (const line of lines) {
        const stripped = line.trim();
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
    if (e.type !== "ORGANIZATION") continue;
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
  return entities;
}

// ── 3. Clean boundaries (snap + filter) ──────────────────────────────────────

export function cleanBoundaries(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  entities = snapWordBoundaries(text, entities);
  entities = filterFalsePositives(entities);
  return entities;
}

// ── 4. Placeholder assignment (family-based dedup) ───────────────────────────

interface FamilyInfo {
  familyNumber: number;
  variantCounter: number;
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
  let familyKey: string | null = null;
  if (norm.length >= 4) {
    for (const [key, info] of seenFamily) {
      const [ft, fn] = key.split("::", 2);
      if (ft !== etype) continue;
      if (fn.length >= 4 && (norm.includes(fn) || fn.includes(norm))) {
        familyKey = key;
        break;
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
 */
export function assignPlaceholders(
  entities: DetectedEntity[],
  prefix = "",
): AnonymizeResult {
  const typeCounters = new Map<string, number>();
  const seenExact = new Map<string, string>();
  const seenFamily = new Map<string, FamilyInfo>();
  const mapping: Record<string, string> = {};

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
