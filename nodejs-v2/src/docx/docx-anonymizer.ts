/**
 * PII Shield v2.0.0 — DOCX anonymization
 * Replaces PII in .docx preserving formatting. Handles split runs and cross-paragraph text.
 * Ported from pii_shield_server.py lines 1240-1507, 1672-1719
 */

import path from "node:path";
import fs from "node:fs";
import type { Element } from "@xmldom/xmldom";
import {
  loadDocx, saveDocx, iterAllWpElements, collectParagraphSegments,
  getParagraphText, extractText, docxToHtml, type DocxModel, type Segment,
} from "./docx-reader.js";
import { PIIEngine } from "../engine/pii-engine.js";
import { saveMapping, loadMapping, newSessionId } from "../mapping/mapping-store.js";
import { assignPlaceholders, createPlaceholderState, type PlaceholderState } from "../engine/entity-dedup.js";
import { nerLog } from "../engine/ner-backend.js";
import type { DetectedEntity } from "../engine/pattern-recognizers.js";
import { neutralizeHostRunEmphasis, findRunProps } from "./docx-run-utils.js";
import { writePiiShieldProps } from "./docx-custom-props.js";
import { XMLSerializer } from "@xmldom/xmldom";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return an index into `haystack` where `needle` first matches case-insensitively,
 * plus the matched substring (which may differ in case from `needle`). Returns
 * null if not found.
 *
 * Case-insensitive because HITL lets users add entities like "ACME CORP" while
 * the DOCX body may contain "Acme Corp" — both must be anonymized under the
 * same placeholder.
 */
function findCaseInsensitive(
  haystack: string, needle: string,
): { index: number; matched: string } | null {
  if (!needle) return null;
  // Fast path: exact (same-case) match. Common, and avoids regex overhead.
  const exact = haystack.indexOf(needle);
  if (exact !== -1) return { index: exact, matched: needle };
  let re: RegExp;
  try {
    re = new RegExp(escapeRegExp(needle), "iu");
  } catch {
    return null;
  }
  const m = re.exec(haystack);
  if (!m) return null;
  return { index: m.index, matched: m[0] };
}

/**
 * Return the outer XML of a run's w:rPr (as a stable fingerprint), or empty
 * string if the run has no rPr. Used to compare whether all runs in a match
 * range share the same formatting — if they do, we don't need to neutralize
 * the host run's emphasis tags after replacement.
 */
function runPropsFingerprint(wtElem: Element): string {
  const rElem = wtElem.parentNode as Element | null;
  if (!rElem) return "";
  const rPr = findRunProps(rElem);
  if (!rPr) return "";
  try {
    return new XMLSerializer().serializeToString(rPr);
  } catch {
    return "";
  }
}

/**
 * Replace old_text with new_text across split runs within a single paragraph.
 * Handles w:br, w:tab, w:cr elements. Loops for repeated occurrences.
 *
 * Matching is case-insensitive: the caller may pass "ACME CORP" (from a HITL
 * override) while the paragraph contains "Acme Corp"; both should be replaced
 * with the same placeholder.
 *
 * When the match spans runs with *different* w:rPr, the host run's
 * character-emphasis tags (bold/italic/underline/caps/etc.) are stripped so
 * the inserted placeholder doesn't render partially bold. Runs with uniform
 * formatting are left untouched to avoid regressing legitimately-styled
 * headings.
 */
export function replaceAcrossRuns(pElem: Element, oldText: string, newText: string): void {
  if (!oldText) return;

  while (true) {
    const segments = collectParagraphSegments(pElem);
    if (segments.length === 0) break;

    const joined = segments.map(s => s.text).join("");
    const found = findCaseInsensitive(joined, oldText);
    if (!found) break;
    const idx = found.index;
    const matchLen = found.matched.length;

    const endIdx = idx + matchLen;
    let segPos = 0;
    let firstSeg = -1;
    let lastSeg = -1;
    let offsetInFirst = 0;
    let offsetInLastEnd = 0;

    for (let i = 0; i < segments.length; i++) {
      const segEnd = segPos + segments[i].text.length;
      if (firstSeg === -1 && segEnd > idx) {
        firstSeg = i;
        offsetInFirst = idx - segPos;
      }
      if (segEnd >= endIdx) {
        lastSeg = i;
        offsetInLastEnd = endIdx - segPos;
        break;
      }
      segPos = segEnd;
    }

    if (firstSeg === -1 || lastSeg === -1) break;

    // Find first w:t element in match range to host the replacement text
    let hostSeg = -1;
    for (let i = firstSeg; i <= lastSeg; i++) {
      if (segments[i].kind === "wt") {
        hostSeg = i;
        break;
      }
    }
    if (hostSeg === -1) break;

    // Decide whether to neutralize emphasis on the host run. We only do this
    // when the match spans runs with heterogeneous formatting — otherwise a
    // correctly bold heading like "**Acme Corp Ltd**" would lose its bolding
    // when anonymized, which the user doesn't want.
    let heterogeneousFormatting = false;
    if (firstSeg !== lastSeg) {
      const hostFp = runPropsFingerprint(segments[hostSeg].elem);
      for (let i = firstSeg; i <= lastSeg; i++) {
        if (segments[i].kind !== "wt") continue;
        if (runPropsFingerprint(segments[i].elem) !== hostFp) {
          heterogeneousFormatting = true;
          break;
        }
      }
    }

    // Apply replacement across all segments in the match range
    for (let i = firstSeg; i <= lastSeg; i++) {
      const { elem, text, kind } = segments[i];

      if (i === hostSeg) {
        const prefix = i === firstSeg ? text.slice(0, offsetInFirst) : "";
        const suffix = i === lastSeg ? text.slice(offsetInLastEnd) : "";
        elem.textContent = prefix + newText + suffix;
      } else if (kind === "wt") {
        if (i === firstSeg) {
          elem.textContent = text.slice(0, offsetInFirst);
        } else if (i === lastSeg) {
          elem.textContent = text.slice(offsetInLastEnd);
        } else {
          elem.textContent = "";
        }
      } else {
        // Non-text element (br/tab/cr) inside match range: remove from XML
        const parent = elem.parentNode;
        if (parent) parent.removeChild(elem);
      }
    }

    if (heterogeneousFormatting) {
      neutralizeHostRunEmphasis(segments[hostSeg].elem);
    }
  }
}

/**
 * Replace text that spans multiple paragraphs (contains '\n' from paragraph join).
 * Splits old_text by '\n', finds matching consecutive paragraphs.
 */
export function replaceCrossParagraphs(
  allPElems: Element[], oldText: string, newText: string,
): boolean {
  const rawParts = oldText.split("\n");
  const parts = rawParts.filter(p => p);
  if (parts.length < 2) return false;

  let replacedAny = false;

  const partsLc = parts.map(p => p.toLowerCase());

  while (true) {
    // Rebuild per-paragraph text each iteration
    const paraData = allPElems.map(p => getParagraphText(p));
    const paraDataLc = paraData.map(t => t.toLowerCase());

    let found = false;
    for (let start = 0; start <= paraData.length - parts.length; start++) {
      let matched = true;
      for (let j = 0; j < parts.length; j++) {
        const pLc = paraDataLc[start + j];
        if (j === 0) {
          if (!partsLc[j] || !pLc.endsWith(partsLc[j])) { matched = false; break; }
        } else if (j === parts.length - 1) {
          if (!partsLc[j] || !pLc.startsWith(partsLc[j])) { matched = false; break; }
        } else {
          if (pLc !== partsLc[j]) { matched = false; break; }
        }
      }

      if (!matched) continue;

      // Match found — apply replacement
      replaceAcrossRuns(allPElems[start], parts[0], newText);

      // Middle paragraphs: clear all text
      for (let j = 1; j < parts.length - 1; j++) {
        const segs = collectParagraphSegments(allPElems[start + j]);
        for (const seg of segs) {
          if (seg.kind === "wt") {
            seg.elem.textContent = "";
          } else {
            const parent = seg.elem.parentNode;
            if (parent) parent.removeChild(seg.elem);
          }
        }
      }

      // Last paragraph: remove matched prefix
      replaceAcrossRuns(allPElems[start + parts.length - 1], parts[parts.length - 1], "");

      found = true;
      replacedAny = true;
      break;
    }

    if (!found) break;
  }

  return replacedAny;
}

/**
 * Apply a known placeholder mapping to a DOCX file.
 * Handles split runs, w:br/w:tab/w:cr, and cross-paragraph text.
 */
export async function anonymizeDocxWithMapping(
  docxPath: string, mapping: Record<string, string>, outDir?: string,
): Promise<string> {
  const model = await loadDocx(docxPath);
  const reverseMap: Record<string, string> = {};
  for (const [placeholder, realText] of Object.entries(mapping)) {
    reverseMap[realText] = placeholder;
  }
  const sortedTexts = Object.keys(reverseMap).sort((a, b) => b.length - a.length);

  const allPElems = iterAllWpElements(model.mainDoc);

  // Pass 1: single-paragraph replacements (case-insensitive — the mapping may
  // be keyed on "ACME CORP" while the paragraph contains "Acme Corp" after
  // HITL-added overrides are propagated).
  const crossParaTexts: string[] = [];
  for (const realText of sortedTexts) {
    const realTextLc = realText.toLowerCase();
    let found = false;
    for (const pElem of allPElems) {
      const vtext = getParagraphText(pElem);
      if (vtext.toLowerCase().includes(realTextLc)) {
        replaceAcrossRuns(pElem, realText, reverseMap[realText]);
        found = true;
      }
    }
    if (!found && realText.includes("\n")) {
      crossParaTexts.push(realText);
    }
  }

  // Pass 2: cross-paragraph replacements
  for (const realText of crossParaTexts) {
    const freshPElems = iterAllWpElements(model.mainDoc);
    replaceCrossParagraphs(freshPElems, realText, reverseMap[realText]);
  }

  const dir = outDir || path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_anonymized.docx`);
  await saveDocx(model, outPath);
  return outPath;
}

/**
 * Main DOCX anonymization: detect PII on full extracted text, assign
 * placeholders globally, replace in-place per paragraph.
 *
 * Full-text detection (vs. per-paragraph) gives labeled extractors
 * (addresses, persons) the "Label: Value" context from table rows,
 * and enables context-boost for patterns like reg_number. The engine
 * handles chunking internally (NER_CHUNK_SIZE=800). This matches the
 * approach used for PDF and plain-text files.
 *
 * Replacement uses text search (not offsets) — entity text is found
 * verbatim in individual paragraph elements even though detection
 * used the merged extractText() format.
 */
export async function anonymizeDocx(
  docxPath: string,
  language = "en",
  prefix = "",
  options: {
    existingSessionId?: string;
    sharedState?: PlaceholderState;
    sourceHash?: string;
    anonymizedAt?: string;
  } = {},
): Promise<Record<string, unknown> & { state: PlaceholderState }> {
  const t0 = Date.now();
  const engine = PIIEngine.getInstance();
  await engine.ensureReady();

  const model = await loadDocx(docxPath);
  const fullText = extractText(model);
  const html = docxToHtml(model);

  // Full-text detection: run PII engine once on the extractText() output.
  // This gives labeled extractors (addresses, persons) the "Label: Value"
  // context from table rows, and gives context-boosted patterns (reg_number)
  // access to nearby label text. The engine handles chunking internally
  // (NER_CHUNK_SIZE=800). Same approach as PDF and plain-text files.
  const allPElems = iterAllWpElements(model.mainDoc);
  const detected = await engine.detect(fullText, language);
  nerLog(`[DOCX] full-text detection (${fullText.length} chars) → ${detected.length} entities`);
  const state = options.sharedState ?? createPlaceholderState();
  const { entities: placedEntities, mapping } = assignPlaceholders(detected, prefix, state);

  // Map placeholder by exact text so we can apply per-paragraph replacements
  // (the placeholder for "Acme Corp" is the same regardless of where it appeared).
  const reverseMap: Record<string, string> = {};
  for (const [placeholder, realText] of Object.entries(mapping)) {
    reverseMap[realText] = placeholder;
  }

  // Save target session + output dir. If the caller supplied an existing
  // session_id (multi-file extend path), reuse it verbatim; otherwise
  // generate a fresh timestamp-based id (same format as newSessionId in
  // mapping-store) so the mappings dir lists chronologically.
  const sessionId = options.existingSessionId ?? newSessionId();
  const outDir = path.join(path.dirname(docxPath), `pii_shield_${sessionId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${path.basename(docxPath, ".docx")}_anonymized.docx`);

  // Apply replacements by searching each paragraph for entity text.
  // Sort longest-first so "Acme Corp Ltd" replaces before "Acme Corp".
  const sortedTexts = Object.keys(reverseMap).sort((a, b) => b.length - a.length);

  for (const pElem of allPElems) {
    const pText = getParagraphText(pElem);
    if (!pText.trim()) continue;
    const pTextLc = pText.toLowerCase();
    for (const realText of sortedTexts) {
      if (pTextLc.includes(realText.toLowerCase())) {
        replaceAcrossRuns(pElem, realText, reverseMap[realText]);
      }
    }
  }
  await saveDocx(model, outPath);

  // When running inside an existing session (multi-file extend), skip the
  // metadata-wiping saveMapping here — the caller will persist the full
  // state + documents list via saveSessionState afterwards.
  if (!options.existingSessionId) {
    saveMapping(sessionId, mapping, { source: docxPath });
  }

  // Embed session metadata into the emitted .docx via docProps/custom.xml.
  // This makes the file self-describing: deanonymize_docx(path) can pick
  // up the session_id without the caller passing it explicitly. Failure is
  // non-fatal — the mapping on disk is still the authoritative source.
  try {
    await writePiiShieldProps(outPath, {
      session_id: sessionId,
      source_hash: options.sourceHash ?? "",
      anonymized_at: options.anonymizedAt ?? new Date().toISOString(),
    });
  } catch (e) {
    nerLog(`[DOCX] writePiiShieldProps(${outPath}) failed (non-fatal): ${e}`);
  }

  // Write a .txt companion next to the .docx output containing the flattened
  // anonymized text. Claude reads this directly via the Read tool instead of
  // re-parsing the .docx.
  //
  // Splice placeholders into fullText from end to start using the placed
  // entities' absolute offsets — same algorithm as reanonymizeWithReview's
  // text branch in index.ts. Entities without placeholders (shouldn't happen
  // after assignPlaceholders, but be defensive) are skipped.
  const sortedForText = [...placedEntities].sort((a, b) => b.start - a.start);
  let anonymizedText = fullText;
  for (const e of sortedForText) {
    if (!e.placeholder) continue;
    anonymizedText =
      anonymizedText.slice(0, e.start) +
      e.placeholder +
      anonymizedText.slice(e.end);
  }
  const textOutPath = outPath.replace(/\.docx$/i, ".txt");
  fs.writeFileSync(textOutPath, anonymizedText, "utf-8");
  nerLog(`[DOCX] wrote text companion → ${textOutPath} (${anonymizedText.length} chars)`);

  const byType: Record<string, number> = {};
  for (const e of placedEntities) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  return {
    output_path: outPath,
    text_output_path: textOutPath,
    anonymized_text: anonymizedText,
    session_id: sessionId,
    total_entities: placedEntities.length,
    unique_entities: Object.keys(mapping).length,
    by_type: byType,
    processing_time_ms: Date.now() - t0,
    html_text: html,
    original_text: fullText,
    entities: placedEntities.map(e => ({
      text: e.text, type: e.type, start: e.start, end: e.end,
      score: e.score, placeholder: e.placeholder || "",
    })),
    state,
  };
}
