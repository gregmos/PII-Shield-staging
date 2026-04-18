/**
 * PII Shield v2.0.0 — DOCX Tracked Changes (REDLINE mode)
 *
 * Uses @ansonlai/docx-redline-js — a pure-JS OOXML reconciliation engine that
 * emits native-looking w:ins/w:del revision markup via word-level diffing.
 * Runs headless with @xmldom/xmldom (no browser / no Python).
 *
 * For accept/reject we keep a small pure-JS path (@xmldom/xmldom only) since
 * those operations are trivial: remove/unwrap w:ins/w:del nodes in place.
 */
import path from "node:path";
import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";
import {
  configureXmlProvider,
  setDefaultAuthor,
} from "@ansonlai/docx-redline-js";
import { applyOperationToDocumentXml } from "@ansonlai/docx-redline-js/services/standalone-operation-runner.js";
import { loadDocx, saveDocx } from "./docx-reader.js";

const WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

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

// One-time init — docx-redline-js needs DOMParser/XMLSerializer injected in Node.
let _xmlConfigured = false;
function ensureXmlConfigured(): void {
  if (_xmlConfigured) return;
  configureXmlProvider({ DOMParser, XMLSerializer });
  _xmlConfigured = true;
}

/**
 * Apply a sequence of {oldText → newText} tracked changes to a full
 * word/document.xml string. Each change is fed through
 * applyOperationToDocumentXml, threading the redlined output into the next
 * call so later changes see the already-annotated XML.
 *
 * Returns the final XML string and the count of changes actually applied
 * (hasChanges=true on that op).
 */
async function applyChangesToDocumentXml(
  documentXml: string,
  changes: TrackedChange[],
  author: string,
): Promise<{ xml: string; applied: number }> {
  let xml = documentXml;
  let applied = 0;
  for (const change of changes) {
    if (!change.oldText) continue;
    try {
      const res: any = await applyOperationToDocumentXml(
        xml,
        { type: "redline", target: change.oldText, modified: change.newText },
        author,
        null,
        { generateRedlines: true },
      );
      if (res && typeof res.documentXml === "string") {
        xml = res.documentXml;
        if (res.hasChanges) applied++;
      }
    } catch (e) {
      console.error(`[REDLINE] change failed for "${change.oldText.slice(0, 40)}": ${e}`);
    }
  }
  return { xml, applied };
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
  ensureXmlConfigured();
  const author = options.author || "PII Shield";
  setDefaultAuthor(author);

  // Sort changes by length descending so longer matches win over prefixes.
  const sortedChanges = [...changes].sort((a, b) => b.oldText.length - a.oldText.length);

  const buf = fs.readFileSync(docxPath);
  const zip = await JSZip.loadAsync(buf);

  const mainPath = "word/document.xml";
  const mainXml = await zip.file(mainPath)?.async("string");
  if (!mainXml) {
    throw new Error(`DOCX missing ${mainPath}: ${docxPath}`);
  }

  let applied = 0;
  const { xml: newMain, applied: mainApplied } = await applyChangesToDocumentXml(mainXml, sortedChanges, author);
  zip.file(mainPath, newMain);
  applied += mainApplied;
  console.error(`[REDLINE] applied ${mainApplied} tracked change(s) to ${mainPath}`);

  // Headers and footers — same tracked-changes pass on each part separately.
  // Matches the old Python sidecar's _walk_paragraphs behaviour (which iterated
  // section.header / section.first_page_header / section.even_page_header and
  // the corresponding footers). Without this, PII in colontituly (signatures,
  // recurring party identifiers) would appear redlined in the body but
  // untouched in headers/footers.
  const partPaths: string[] = [];
  zip.forEach((relPath) => {
    if (/^word\/header\d+\.xml$/.test(relPath) || /^word\/footer\d+\.xml$/.test(relPath)) {
      partPaths.push(relPath);
    }
  });
  for (const partPath of partPaths) {
    const partXml = await zip.file(partPath)?.async("string");
    if (!partXml) continue;
    const { xml: newPart, applied: partApplied } = await applyChangesToDocumentXml(
      partXml, sortedChanges, author,
    );
    zip.file(partPath, newPart);
    applied += partApplied;
    if (partApplied > 0) {
      console.error(`[REDLINE] applied ${partApplied} tracked change(s) to ${partPath}`);
    }
  }

  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_tracked_changes.docx`);
  const outBuf = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(outPath, outBuf);
  return outPath;
}

/**
 * Apply a per-Document transform to each header/footer part, serialising the
 * result back into the zip. headerXmls / footerXmls come as raw XML strings
 * (loadDocx does not parse them), so we parse-transform-serialise here.
 */
function applyToHeaderFooterParts(
  model: { zip: JSZip; headerXmls: Map<string, string>; footerXmls: Map<string, string> },
  transform: (doc: Document) => void,
): void {
  const serializer = new XMLSerializer();
  for (const [partPath, xml] of [...model.headerXmls.entries(), ...model.footerXmls.entries()]) {
    if (!xml) continue;
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    transform(doc);
    model.zip.file(partPath, serializer.serializeToString(doc));
  }
}

/**
 * Accept all tracked changes in a DOCX:
 * - Remove w:del elements entirely (deleted text disappears)
 * - Unwrap w:ins elements (inserted text becomes permanent)
 *
 * Covers main document + all headers/footers (parity with the Python sidecar
 * that v2.0.0 replaced).
 */
export async function acceptAllTrackedChanges(docxPath: string): Promise<string> {
  const model = await loadDocx(docxPath);
  acceptInDoc(model.mainDoc);
  applyToHeaderFooterParts(model, acceptInDoc);

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
 *
 * Covers main document + all headers/footers (parity with the Python sidecar
 * that v2.0.0 replaced).
 */
export async function rejectAllTrackedChanges(docxPath: string): Promise<string> {
  const model = await loadDocx(docxPath);
  rejectInDoc(model.mainDoc);
  applyToHeaderFooterParts(model, rejectInDoc);

  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_rejected.docx`);
  await saveDocx(model, outPath);
  return outPath;
}

function acceptInDoc(doc: Document): void {
  // Unwrap insertions (keep content)
  const insElements = doc.getElementsByTagNameNS(WNS, "ins");
  const insArr: Element[] = [];
  for (let i = 0; i < insElements.length; i++) insArr.push(insElements[i]);
  for (const ins of insArr) {
    const parent = ins.parentNode;
    if (!parent) continue;
    while (ins.firstChild) {
      parent.insertBefore(ins.firstChild, ins);
    }
    parent.removeChild(ins);
  }

  // Remove deletions entirely
  const delElements = doc.getElementsByTagNameNS(WNS, "del");
  const delArr: Element[] = [];
  for (let i = 0; i < delElements.length; i++) delArr.push(delElements[i]);
  for (const del of delArr) {
    const parent = del.parentNode;
    if (parent) parent.removeChild(del);
  }
}

function rejectInDoc(doc: Document): void {
  // Remove insertions
  const insElements = doc.getElementsByTagNameNS(WNS, "ins");
  const insArr: Element[] = [];
  for (let i = 0; i < insElements.length; i++) insArr.push(insElements[i]);
  for (const ins of insArr) {
    const parent = ins.parentNode;
    if (parent) parent.removeChild(ins);
  }

  // Unwrap deletions — convert w:delText back to w:t and keep content
  const delElements = doc.getElementsByTagNameNS(WNS, "del");
  const delArr: Element[] = [];
  for (let i = 0; i < delElements.length; i++) delArr.push(delElements[i]);
  for (const del of delArr) {
    const parent = del.parentNode;
    if (!parent) continue;

    const delTexts = del.getElementsByTagNameNS(WNS, "delText");
    const dtArr: Element[] = [];
    for (let i = 0; i < delTexts.length; i++) dtArr.push(delTexts[i]);
    for (const dt of dtArr) {
      const t = doc.createElementNS(WNS, "w:t");
      t.setAttribute("xml:space", "preserve");
      t.textContent = dt.textContent || "";
      dt.parentNode?.replaceChild(t, dt);
    }

    while (del.firstChild) {
      parent.insertBefore(del.firstChild, del);
    }
    parent.removeChild(del);
  }
}
