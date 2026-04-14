/**
 * PII Shield v2.0.0 — DOCX anonymization
 * Replaces PII in .docx preserving formatting. Handles split runs and cross-paragraph text.
 * Ported from pii_shield_server.py lines 1240-1507, 1672-1719
 */

import path from "node:path";
import fs from "node:fs";
import {
  loadDocx, saveDocx, iterAllWpElements, collectParagraphSegments,
  getParagraphText, extractText, docxToHtml, type DocxModel, type Segment,
} from "./docx-reader.js";
import { PIIEngine } from "../engine/pii-engine.js";
import { saveMapping, loadMapping } from "../mapping/mapping-store.js";
import { assignPlaceholders } from "../engine/entity-dedup.js";
import { nerLog } from "../engine/ner-backend.js";
import type { DetectedEntity } from "../engine/pattern-recognizers.js";
import { ensureSidecar, isSidecarReady, adeuExtract, adeuApply } from "../engine/adeu-sidecar.js";

/**
 * Replace old_text with new_text across split runs within a single paragraph.
 * Handles w:br, w:tab, w:cr elements. Loops for repeated occurrences.
 */
export function replaceAcrossRuns(pElem: Element, oldText: string, newText: string): void {
  if (!oldText) return;

  while (true) {
    const segments = collectParagraphSegments(pElem);
    if (segments.length === 0) break;

    const joined = segments.map(s => s.text).join("");
    const idx = joined.indexOf(oldText);
    if (idx === -1) break;

    const endIdx = idx + oldText.length;
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

  while (true) {
    // Rebuild per-paragraph text each iteration
    const paraData = allPElems.map(p => getParagraphText(p));

    let found = false;
    for (let start = 0; start <= paraData.length - parts.length; start++) {
      let matched = true;
      for (let j = 0; j < parts.length; j++) {
        const pText = paraData[start + j];
        if (j === 0) {
          if (!parts[j] || !pText.endsWith(parts[j])) { matched = false; break; }
        } else if (j === parts.length - 1) {
          if (!parts[j] || !pText.startsWith(parts[j])) { matched = false; break; }
        } else {
          if (pText !== parts[j]) { matched = false; break; }
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

  // Pass 1: single-paragraph replacements
  const crossParaTexts: string[] = [];
  for (const realText of sortedTexts) {
    let found = false;
    for (const pElem of allPElems) {
      const vtext = getParagraphText(pElem);
      if (vtext.includes(realText)) {
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
  docxPath: string, language = "en", prefix = "",
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const engine = PIIEngine.getInstance();
  await engine.ensureReady();

  // Phase 5 Fix C: kick off Python sidecar bootstrap in the background.
  // First .docx call after a fresh install pays the one-time pip install
  // cost; subsequent calls reuse the cached py_deps. We don't await here —
  // we only await right before we'd use it (during the apply step).
  ensureSidecar().catch(() => { /* fallback path handles it */ });

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
  const { entities: placedEntities, mapping } = assignPlaceholders(detected, prefix);

  // Map placeholder by exact text so we can apply per-paragraph replacements
  // (the placeholder for "Acme Corp" is the same regardless of where it appeared).
  const reverseMap: Record<string, string> = {};
  for (const [placeholder, realText] of Object.entries(mapping)) {
    reverseMap[realText] = placeholder;
  }

  // Save target session + output dir
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const outDir = path.join(path.dirname(docxPath), `pii_shield_${sessionId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${path.basename(docxPath, ".docx")}_anonymized.docx`);

  // Phase 5 Fix C: apply mapping via Python sidecar when available.
  // python-docx is more robust against split runs / lxml-only quirks than
  // our hand-rolled JSZip + xmldom replaceAcrossRuns. Falls back to the
  // existing Node.js path if the sidecar isn't ready (Windows local without
  // python3, or first-call bootstrap still in flight).
  let usedSidecar = false;
  try {
    if (!isSidecarReady()) {
      // Wait briefly — sidecar bootstrap was kicked off above. If it's
      // still installing pip deps, don't block the whole pipeline; fall
      // through to Node.js path.
      await Promise.race([
        ensureSidecar(),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    }
    if (isSidecarReady()) {
      const pairs: Array<[string, string]> = Object.keys(reverseMap)
        .sort((a, b) => b.length - a.length)
        .map((realText) => [realText, reverseMap[realText]]);
      const r = await adeuApply(docxPath, outPath, pairs);
      nerLog(`[DOCX] sidecar apply → ${r.replacements} replacements at ${outPath}`);
      usedSidecar = true;
    }
  } catch (e) {
    nerLog(`[DOCX] sidecar apply failed, falling back to Node.js path: ${e}`);
  }

  if (!usedSidecar) {
    // Apply replacements by searching each paragraph for entity text.
    // Sort longest-first so "Acme Corp Ltd" replaces before "Acme Corp".
    const sortedTexts = Object.keys(reverseMap).sort((a, b) => b.length - a.length);

    for (const pElem of allPElems) {
      if (!getParagraphText(pElem).trim()) continue;
      for (const realText of sortedTexts) {
        if (getParagraphText(pElem).includes(realText)) {
          replaceAcrossRuns(pElem, realText, reverseMap[realText]);
        }
      }
    }
    await saveDocx(model, outPath);
  }

  saveMapping(sessionId, mapping, { source: docxPath });

  // Phase 7 Fix 7.1: write a .txt companion next to the .docx output containing
  // the flattened anonymized text. Claude reads this directly via the Read tool
  // instead of falling back to `pandoc … -t plain`, which trips Cowork's
  // output-capture auto-persist path and creates a cascade of mystery .txt
  // files in .claude/projects/.../tool-results/.
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
  };
}
