/**
 * PII Shield v2.0.0 — DOCX Tracked Changes (REDLINE mode)
 * Implements Word-native revision marks (w:del / w:ins) via direct OOXML manipulation.
 * No browser DOM required — works headless with @xmldom/xmldom.
 */

import path from "node:path";
import fs from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import {
  loadDocx, saveDocx, iterAllWpElements, collectParagraphSegments,
  getParagraphText, type DocxModel, type Segment,
} from "./docx-reader.js";
import { ensureSidecar, isSidecarReady, adeuRedline } from "../engine/adeu-sidecar.js";

const WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

let nextRevId = 100;

interface TrackedChange {
  /** Text to find in the document */
  oldText: string;
  /** Replacement text (empty string = pure deletion) */
  newText: string;
}

interface RedlineOptions {
  author?: string;
  date?: string;
}

/**
 * Clone a w:rPr element (run properties) for use in inserted runs.
 * Returns null if the source run has no rPr.
 */
function cloneRunProps(rElem: Element, doc: Document): Element | null {
  for (let i = 0; i < rElem.childNodes.length; i++) {
    const child = rElem.childNodes[i] as Element;
    const ln = child.localName || (child.nodeName || "").replace(/^w:/, "");
    if (ln === "rPr") {
      return child.cloneNode(true) as Element;
    }
  }
  return null;
}

/**
 * Phase 6 Fix 6.5 — like cloneRunProps but strips character-emphasis
 * properties so tracked-change insertions don't inherit bold/italic/underline
 * /highlight from the surrounding heading-styled run. We keep font/color/size
 * (`rFonts`, `color`, `sz`, `szCs`, `lang`) so the insertion still blends in
 * typographically.
 */
const NEUTRAL_DROP_TAGS = new Set([
  "b", "bCs", "i", "iCs", "u", "strike", "dstrike",
  "highlight", "shd", "caps", "smallCaps", "em",
]);
function cloneNeutralRunProps(rElem: Element, doc: Document): Element | null {
  const rPr = cloneRunProps(rElem, doc);
  if (!rPr) return null;
  // Walk children and drop emphasis tags. Iterate over a snapshot because
  // removeChild mutates the live NodeList.
  const kids: Element[] = [];
  for (let i = 0; i < rPr.childNodes.length; i++) {
    const c = rPr.childNodes[i] as Element;
    if (c.nodeType === 1) kids.push(c);
  }
  for (const c of kids) {
    const ln = c.localName || (c.nodeName || "").replace(/^w:/, "");
    if (NEUTRAL_DROP_TAGS.has(ln)) {
      rPr.removeChild(c);
    }
  }
  return rPr;
}

/**
 * Create a w:r element containing a w:t with the given text,
 * optionally copying run properties from a source run.
 */
function createTextRun(doc: Document, text: string, rPrSource: Element | null): Element {
  const r = doc.createElementNS(WNS, "w:r");
  if (rPrSource) {
    r.appendChild(rPrSource);
  }
  const t = doc.createElementNS(WNS, "w:t");
  t.setAttribute("xml:space", "preserve");
  t.textContent = text;
  r.appendChild(t);
  return r;
}

/**
 * Wrap an existing w:r element inside a w:del element.
 */
function wrapInDel(rElem: Element, doc: Document, author: string, date: string): Element {
  const del = doc.createElementNS(WNS, "w:del");
  del.setAttribute("w:id", String(nextRevId++));
  del.setAttribute("w:author", author);
  del.setAttribute("w:date", date);

  // Convert w:t elements to w:delText inside the run
  const walker = (node: Node): void => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i] as Element;
      const ln = child.localName || (child.nodeName || "").replace(/^w:/, "");
      if (ln === "t" && (child.namespaceURI === WNS || child.nodeName === "w:t")) {
        // Replace w:t with w:delText
        const delText = doc.createElementNS(WNS, "w:delText");
        delText.setAttribute("xml:space", "preserve");
        delText.textContent = child.textContent || "";
        node.replaceChild(delText, child);
      } else if (child.nodeType === 1) {
        walker(child);
      }
    }
  };
  walker(rElem);

  del.appendChild(rElem);
  return del;
}

/**
 * Create a w:ins element containing a text run.
 */
function createInsertElement(
  doc: Document, text: string, rPrSource: Element | null,
  author: string, date: string,
): Element {
  const ins = doc.createElementNS(WNS, "w:ins");
  ins.setAttribute("w:id", String(nextRevId++));
  ins.setAttribute("w:author", author);
  ins.setAttribute("w:date", date);
  ins.appendChild(createTextRun(doc, text, rPrSource));
  return ins;
}

/**
 * Apply a single tracked change to a paragraph.
 * Finds oldText across runs, wraps matched runs in w:del,
 * inserts w:ins with newText after the deletion.
 *
 * Returns true if a replacement was made.
 */
function applyTrackedChangeInParagraph(
  pElem: Element, oldText: string, newText: string,
  author: string, date: string,
): boolean {
  const segments = collectParagraphSegments(pElem);
  if (segments.length === 0) return false;

  const joined = segments.map(s => s.text).join("");
  const idx = joined.indexOf(oldText);
  if (idx === -1) return false;

  const endIdx = idx + oldText.length;
  const doc = pElem.ownerDocument!;

  // Find which segments are affected
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

  if (firstSeg === -1 || lastSeg === -1) return false;

  // Collect the w:r elements that contain the matched segments
  // Strategy: split runs at match boundaries, wrap matched portion in w:del, add w:ins
  const affectedRuns = new Map<Element, { segments: Segment[]; indices: number[] }>();

  for (let i = firstSeg; i <= lastSeg; i++) {
    const seg = segments[i];
    // Walk up to find the parent w:r element
    let rElem: Element | null = null;
    let node: Node | null = seg.elem;
    while (node && node !== pElem) {
      const ln = (node as Element).localName || ((node as Element).nodeName || "").replace(/^w:/, "");
      if (ln === "r") { rElem = node as Element; break; }
      node = node.parentNode;
    }
    if (!rElem) continue;

    if (!affectedRuns.has(rElem)) {
      affectedRuns.set(rElem, { segments: [], indices: [] });
    }
    affectedRuns.get(rElem)!.segments.push(seg);
    affectedRuns.get(rElem)!.indices.push(i);
  }

  // Get rPr from first affected run for the insertion. Use the NEUTRAL clone
  // so the inserted text doesn't inherit bold/italic/highlight from the head
  // run (Phase 6 Fix 6.5).
  let rPrForInsert: Element | null = null;
  for (const [rElem] of affectedRuns) {
    rPrForInsert = cloneNeutralRunProps(rElem, doc);
    if (rPrForInsert) break;
  }

  // Process each affected run
  let insertionPoint: Element | null = null;
  const runsProcessed: Element[] = [];

  for (const [rElem, data] of affectedRuns) {
    const segIndices = data.indices;
    const isFirst = segIndices.includes(firstSeg);
    const isLast = segIndices.includes(lastSeg);

    // Get the text of this run
    let runText = "";
    for (const seg of data.segments) {
      runText += seg.text;
    }

    // Determine the parent of the run (paragraph or another wrapper)
    const runParent = rElem.parentNode as Element;
    if (!runParent) continue;

    // Calculate what part of this run is matched
    let matchStart = 0;
    let matchEnd = runText.length;

    // For the first affected run, the match starts at offsetInFirst relative to the run's start in the match
    if (isFirst) {
      // How much text in this run comes before the match?
      let textBeforeInRun = 0;
      for (const seg of data.segments) {
        const globalSegIdx = segments.indexOf(seg);
        if (globalSegIdx < firstSeg) {
          textBeforeInRun += seg.text.length;
        }
      }
      matchStart = offsetInFirst - textBeforeInRun;
      if (matchStart < 0) matchStart = 0;
    }

    if (isLast) {
      let textBeforeInRun = 0;
      for (const seg of data.segments) {
        const globalSegIdx = segments.indexOf(seg);
        if (globalSegIdx < firstSeg) {
          textBeforeInRun += seg.text.length;
        }
      }
      matchEnd = offsetInLastEnd - textBeforeInRun;
      if (matchEnd < 0) matchEnd = 0;
    }

    const beforeText = runText.slice(0, matchStart);
    const matchedText = runText.slice(matchStart, matchEnd);
    const afterText = runText.slice(matchEnd);

    // Get original rPr
    const originalRPr = cloneRunProps(rElem, doc);

    // Build replacement nodes
    const newNodes: Element[] = [];

    // Before-match portion stays as normal run
    if (beforeText) {
      newNodes.push(createTextRun(doc, beforeText, originalRPr ? originalRPr.cloneNode(true) as Element : null));
    }

    // Matched portion goes into w:del
    if (matchedText) {
      const delRun = createTextRun(doc, matchedText, originalRPr ? originalRPr.cloneNode(true) as Element : null);
      // Convert w:t to w:delText in the del run
      const delWrapped = wrapInDel(delRun, doc, author, date);
      newNodes.push(delWrapped);
      insertionPoint = delWrapped;
    }

    // After-match portion stays as normal run
    if (afterText) {
      newNodes.push(createTextRun(doc, afterText, originalRPr ? originalRPr.cloneNode(true) as Element : null));
    }

    // Replace the original run with the new nodes
    for (const newNode of newNodes) {
      runParent.insertBefore(newNode, rElem);
    }
    runParent.removeChild(rElem);
    runsProcessed.push(rElem);
  }

  // Insert w:ins element after the last w:del
  if (newText && insertionPoint) {
    const insElem = createInsertElement(doc, newText, rPrForInsert, author, date);
    const insParent = insertionPoint.parentNode;
    if (insParent) {
      insParent.insertBefore(insElem, insertionPoint.nextSibling);
    }
  }

  return true;
}

/**
 * Apply tracked changes to a DOCX file.
 * Each change wraps old text in w:del and adds new text in w:ins.
 * The result is a .docx that shows revision marks in Microsoft Word.
 *
 * @param docxPath Path to the input .docx file
 * @param changes Array of {oldText, newText} changes to apply
 * @param options Author and date for revision marks
 * @returns Path to the output .docx file with tracked changes
 */
export async function applyTrackedChanges(
  docxPath: string,
  changes: TrackedChange[],
  options: RedlineOptions = {},
): Promise<string> {
  const author = options.author || "PII Shield";
  const date = options.date || new Date().toISOString();

  // Phase 5 Fix C: prefer Python sidecar (python-docx + lxml) for tracked
  // changes — its run-walking is more robust against split runs and
  // formatting-aware insertion than our hand-rolled xmldom path. Falls
  // back to the Node.js path if the sidecar isn't ready.
  const dirSidecar = path.dirname(docxPath);
  const stemSidecar = path.basename(docxPath, path.extname(docxPath));
  const outPathSidecar = path.join(dirSidecar, `${stemSidecar}_tracked_changes.docx`);
  try {
    if (!isSidecarReady()) {
      await Promise.race([
        ensureSidecar(),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    }
    if (isSidecarReady()) {
      const r = await adeuRedline(docxPath, outPathSidecar, changes, author);
      console.error(`[REDLINE] sidecar applied ${r.applied} tracked changes → ${outPathSidecar}`);
      return r.output;
    }
  } catch (e) {
    console.error(`[REDLINE] sidecar failed, falling back to Node.js path: ${e}`);
  }

  const model = await loadDocx(docxPath);
  const allPElems = iterAllWpElements(model.mainDoc);

  // Sort changes by length descending (longer matches first to avoid partial overlap)
  const sortedChanges = [...changes].sort((a, b) => b.oldText.length - a.oldText.length);

  for (const change of sortedChanges) {
    if (!change.oldText) continue;

    // Try each paragraph
    let applied = false;
    for (const pElem of allPElems) {
      const pText = getParagraphText(pElem);
      if (!pText.includes(change.oldText)) continue;

      // Apply tracked change (one occurrence per paragraph)
      while (applyTrackedChangeInParagraph(pElem, change.oldText, change.newText, author, date)) {
        applied = true;
        // Check if there are more occurrences
        const newPText = getParagraphText(pElem);
        if (!newPText.includes(change.oldText)) break;
      }
    }
  }

  // Save output
  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_tracked_changes.docx`);
  await saveDocx(model, outPath);

  return outPath;
}

/**
 * Accept all tracked changes in a DOCX:
 * - Remove w:del elements entirely (deleted text disappears)
 * - Unwrap w:ins elements (inserted text becomes permanent)
 */
export async function acceptAllTrackedChanges(docxPath: string): Promise<string> {
  const model = await loadDocx(docxPath);
  const doc = model.mainDoc;

  // Accept insertions: unwrap w:ins (keep content)
  const insElements = doc.getElementsByTagNameNS(WNS, "ins");
  // Process in reverse to avoid index shifting
  const insArr: Element[] = [];
  for (let i = 0; i < insElements.length; i++) insArr.push(insElements[i]);
  for (const ins of insArr) {
    const parent = ins.parentNode;
    if (!parent) continue;
    // Move children before the ins element
    while (ins.firstChild) {
      parent.insertBefore(ins.firstChild, ins);
    }
    parent.removeChild(ins);
  }

  // Remove deletions: remove w:del entirely
  const delElements = doc.getElementsByTagNameNS(WNS, "del");
  const delArr: Element[] = [];
  for (let i = 0; i < delElements.length; i++) delArr.push(delElements[i]);
  for (const del of delArr) {
    const parent = del.parentNode;
    if (parent) parent.removeChild(del);
  }

  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_accepted.docx`);
  await saveDocx(model, outPath);
  return outPath;
}

/**
 * Reject all tracked changes in a DOCX:
 * - Remove w:ins elements entirely (inserted text disappears)
 * - Unwrap w:del elements (deleted text is restored)
 * - Convert w:delText back to w:t
 */
export async function rejectAllTrackedChanges(docxPath: string): Promise<string> {
  const model = await loadDocx(docxPath);
  const doc = model.mainDoc;

  // Remove insertions
  const insElements = doc.getElementsByTagNameNS(WNS, "ins");
  const insArr: Element[] = [];
  for (let i = 0; i < insElements.length; i++) insArr.push(insElements[i]);
  for (const ins of insArr) {
    const parent = ins.parentNode;
    if (parent) parent.removeChild(ins);
  }

  // Unwrap deletions (restore deleted text)
  const delElements = doc.getElementsByTagNameNS(WNS, "del");
  const delArr: Element[] = [];
  for (let i = 0; i < delElements.length; i++) delArr.push(delElements[i]);
  for (const del of delArr) {
    const parent = del.parentNode;
    if (!parent) continue;

    // Convert w:delText back to w:t
    const delTexts = del.getElementsByTagNameNS(WNS, "delText");
    const dtArr: Element[] = [];
    for (let i = 0; i < delTexts.length; i++) dtArr.push(delTexts[i]);
    for (const dt of dtArr) {
      const t = doc.createElementNS(WNS, "w:t");
      t.setAttribute("xml:space", "preserve");
      t.textContent = dt.textContent || "";
      dt.parentNode?.replaceChild(t, dt);
    }

    // Move children before the del element
    while (del.firstChild) {
      parent.insertBefore(del.firstChild, del);
    }
    parent.removeChild(del);
  }

  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_rejected.docx`);
  await saveDocx(model, outPath);
  return outPath;
}
