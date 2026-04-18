/**
 * PII Shield v2.0.0 — DOCX text extraction
 * Reads .docx files using JSZip + @xmldom/xmldom.
 * Ported from pii_shield_server.py lines 1533-1579, 1299-1318, 1582-1660
 */

import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element, Node } from "@xmldom/xmldom";

const WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface DocxModel {
  zip: JSZip;
  mainDocXml: string;
  mainDoc: Document;
  stylesXml: string | null;
  numberingXml: string | null;
  headerXmls: Map<string, string>;
  footerXmls: Map<string, string>;
  mainDocPath: string;
}

/**
 * Load a .docx file and parse its XML structure.
 */
export async function loadDocx(filePath: string): Promise<DocxModel> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  // Find main document path from [Content_Types].xml
  const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
  let mainDocPath = "word/document.xml";
  if (contentTypes) {
    const ctDoc = new DOMParser().parseFromString(contentTypes, "text/xml");
    const overrides = ctDoc.getElementsByTagName("Override");
    for (let i = 0; i < overrides.length; i++) {
      const ct = overrides[i].getAttribute("ContentType") || "";
      if (ct.includes("wordprocessingml.document.main")) {
        const pn = overrides[i].getAttribute("PartName") || "";
        if (pn) mainDocPath = pn.replace(/^\//, "");
        break;
      }
    }
  }

  const mainDocXml = await zip.file(mainDocPath)?.async("string") || "";
  const mainDoc = new DOMParser().parseFromString(mainDocXml, "text/xml");

  const stylesXml = await zip.file("word/styles.xml")?.async("string") || null;
  const numberingXml = await zip.file("word/numbering.xml")?.async("string") || null;

  // Load headers and footers
  const headerXmls = new Map<string, string>();
  const footerXmls = new Map<string, string>();

  zip.forEach((relativePath) => {
    if (relativePath.match(/^word\/header\d+\.xml$/)) {
      headerXmls.set(relativePath, ""); // loaded lazily
    } else if (relativePath.match(/^word\/footer\d+\.xml$/)) {
      footerXmls.set(relativePath, "");
    }
  });

  for (const path of headerXmls.keys()) {
    headerXmls.set(path, await zip.file(path)?.async("string") || "");
  }
  for (const path of footerXmls.keys()) {
    footerXmls.set(path, await zip.file(path)?.async("string") || "");
  }

  return { zip, mainDocXml, mainDoc, stylesXml, numberingXml, headerXmls, footerXmls, mainDocPath };
}

/**
 * Check if an element is inside a tracked delete (w:del).
 */
function isInsideTrackedDelete(elem: Node): boolean {
  let parent = elem.parentNode;
  while (parent) {
    if (parent.nodeName === "w:del" || (parent as Element).localName === "del") {
      return true;
    }
    parent = parent.parentNode;
  }
  return false;
}

/**
 * Iterate all w:p elements in a document, skipping those inside w:del.
 */
export function iterAllWpElements(doc: Document): Element[] {
  const result: Element[] = [];
  const allElements = doc.getElementsByTagNameNS(WNS, "p");
  for (let i = 0; i < allElements.length; i++) {
    const p = allElements[i];
    if (!isInsideTrackedDelete(p)) {
      result.push(p);
    }
  }
  return result;
}

export interface Segment {
  elem: Element;
  text: string;
  kind: "wt" | "br" | "tab" | "cr";
}

/**
 * Collect all inline text-producing elements in a w:p element.
 * w:t → text, w:br → '\n', w:tab → '\t', w:cr → '\r'
 */
export function collectParagraphSegments(pElem: Element): Segment[] {
  const segments: Segment[] = [];

  function walk(node: Node): void {
    if (node.nodeType !== 1) return; // Element nodes only
    const el = node as Element;
    const localName = el.localName || el.nodeName.replace(/^w:/, "");

    if (localName === "t" && (el.namespaceURI === WNS || el.nodeName === "w:t")) {
      segments.push({ elem: el, text: el.textContent || "", kind: "wt" });
    } else if (localName === "br" && (el.namespaceURI === WNS || el.nodeName === "w:br")) {
      const brType = el.getAttributeNS(WNS, "type") || el.getAttribute("w:type") || "";
      if (brType === "page" || brType === "column") return;
      segments.push({ elem: el, text: "\n", kind: "br" });
    } else if (localName === "tab" && (el.namespaceURI === WNS || el.nodeName === "w:tab")) {
      segments.push({ elem: el, text: "\t", kind: "tab" });
    } else if (localName === "cr" && (el.namespaceURI === WNS || el.nodeName === "w:cr")) {
      segments.push({ elem: el, text: "\r", kind: "cr" });
    } else {
      // Recurse into children
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
      }
    }
  }

  for (let i = 0; i < pElem.childNodes.length; i++) {
    walk(pElem.childNodes[i]);
  }
  return segments;
}

/**
 * Get the virtual text of a paragraph from its segments.
 */
export function getParagraphText(pElem: Element): string {
  const segments = collectParagraphSegments(pElem);
  return segments.map(s => s.text).join("");
}

/**
 * Check if an element is inside a table cell (w:tc).
 */
function isInsideTableCell(elem: Node): boolean {
  let parent = elem.parentNode;
  while (parent) {
    const ln = (parent as Element).localName || (parent.nodeName || "").replace(/^w:/, "");
    if (ln === "tc") return true;
    if (ln === "body" || ln === "hdr" || ln === "ftr") return false;
    parent = parent.parentNode;
  }
  return false;
}

/**
 * Extract text from a table element. For 2-column rows, formats as "Label: Value"
 * so downstream pattern recognizers can detect labeled fields (addresses, names, IDs).
 */
function extractTableText(tblElem: Element, parts: string[]): void {
  for (let i = 0; i < tblElem.childNodes.length; i++) {
    const child = tblElem.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const localName = el.localName || el.nodeName.replace(/^w:/, "");
    if (localName !== "tr") continue;

    const cellTexts: string[] = [];
    for (let j = 0; j < el.childNodes.length; j++) {
      const tcNode = el.childNodes[j];
      if (tcNode.nodeType !== 1) continue;
      const tcEl = tcNode as Element;
      const tcLn = tcEl.localName || tcEl.nodeName.replace(/^w:/, "");
      if (tcLn !== "tc") continue;

      const cellParts: string[] = [];
      for (let k = 0; k < tcEl.childNodes.length; k++) {
        const cellChild = tcEl.childNodes[k];
        if (cellChild.nodeType !== 1) continue;
        const cellEl = cellChild as Element;
        const cellLn = cellEl.localName || cellEl.nodeName.replace(/^w:/, "");
        if (cellLn === "p" && !isInsideTrackedDelete(cellEl)) {
          cellParts.push(getParagraphText(cellEl));
        } else if (cellLn === "tbl") {
          extractTableText(cellEl, cellParts); // nested table
        }
      }
      cellTexts.push(cellParts.join(" ").trim());
    }

    // 2-column row with both cells non-empty → "Label: Value"
    if (cellTexts.length === 2 && cellTexts[0] && cellTexts[1]) {
      const label = cellTexts[0].replace(/:\s*$/, ""); // strip trailing colon if present
      parts.push(`${label}: ${cellTexts[1]}`);
    } else {
      // Other layouts: join non-empty cells with " | "
      const nonEmpty = cellTexts.filter(t => t);
      if (nonEmpty.length > 0) parts.push(nonEmpty.join(" | "));
    }
  }
}

/**
 * Recursively extract text from document body/header/footer nodes.
 * Table-aware: 2-column table rows become "Label: Value".
 */
function extractFromNode(node: Node, parts: string[]): void {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const localName = el.localName || el.nodeName.replace(/^w:/, "");

    if (localName === "tbl") {
      extractTableText(el, parts);
    } else if (localName === "p" && !isInsideTableCell(el) && !isInsideTrackedDelete(el)) {
      parts.push(getParagraphText(el));
    } else if (localName !== "p") {
      // Recurse into sectPr, body, hdr, ftr, etc. — but NOT into w:p (handled above)
      extractFromNode(child, parts);
    }
  }
}

/**
 * Extract all text from a DOCX model.
 * Returns text with paragraphs separated by newlines.
 * Table-aware: 2-column table rows are formatted as "Label: Value"
 * so pattern recognizers can detect labeled fields.
 */
export function extractText(model: DocxModel): string {
  const parts: string[] = [];

  // Body — walks paragraphs and tables
  const body = model.mainDoc.getElementsByTagNameNS(WNS, "body")[0];
  if (body) {
    extractFromNode(body, parts);
  }

  // Headers and footers
  for (const [, xml] of model.headerXmls) {
    if (!xml) continue;
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.documentElement) extractFromNode(doc.documentElement, parts);
  }
  for (const [, xml] of model.footerXmls) {
    if (!xml) continue;
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.documentElement) extractFromNode(doc.documentElement, parts);
  }

  return parts.join("\n");
}

/**
 * Convert DOCX to simple HTML for review UI.
 * Preserves bold/italic/underline and heading detection.
 */
export function docxToHtml(model: DocxModel): string {
  const parts: string[] = [];
  const bodyPs = iterAllWpElements(model.mainDoc);

  for (const p of bodyPs) {
    // Detect heading style from w:pPr/w:pStyle
    let tag = "p";
    const pPr = getChildByLocalName(p, "pPr");
    if (pPr) {
      const pStyle = getChildByLocalName(pPr, "pStyle");
      if (pStyle) {
        const styleVal = pStyle.getAttributeNS(WNS, "val") || pStyle.getAttribute("w:val") || "";
        if (styleVal.includes("Heading1") || styleVal.includes("Title")) tag = "h1";
        else if (styleVal.includes("Heading2") || styleVal.includes("Subtitle")) tag = "h2";
        else if (styleVal.includes("Heading3")) tag = "h3";
        else if (styleVal.includes("Heading")) tag = "h4";
      }
    }

    // Process runs
    const runsHtml: string[] = [];
    processRunsForHtml(p, runsHtml);
    parts.push(`<${tag}>${runsHtml.join("")}</${tag}>`);
  }

  return parts.join("\n");
}

function getChildByLocalName(parent: Element, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      const ln = el.localName || el.nodeName.replace(/^w:/, "");
      if (ln === localName) return el;
    }
  }
  return null;
}

function processRunsForHtml(pElem: Element, runsHtml: string[]): void {
  for (let i = 0; i < pElem.childNodes.length; i++) {
    const child = pElem.childNodes[i] as Element;
    if (!child.localName && !child.nodeName) continue;
    const localName = child.localName || child.nodeName.replace(/^w:/, "");

    if (localName === "r") {
      processRunForHtml(child, runsHtml);
    } else if (localName === "hyperlink") {
      // Process runs inside hyperlinks
      for (let j = 0; j < child.childNodes.length; j++) {
        const sub = child.childNodes[j] as Element;
        const subLn = sub.localName || (sub.nodeName || "").replace(/^w:/, "");
        if (subLn === "r") processRunForHtml(sub, runsHtml);
      }
    }
  }
}

function processRunForHtml(rElem: Element, runsHtml: string[]): void {
  // Extract formatting from w:rPr
  let bold = false, italic = false, underline = false;
  const rPr = getChildByLocalName(rElem, "rPr");
  if (rPr) {
    const b = getChildByLocalName(rPr, "b");
    if (b) {
      const bVal = b.getAttributeNS(WNS, "val") || b.getAttribute("w:val") || "true";
      bold = bVal !== "false";
    }
    const i = getChildByLocalName(rPr, "i");
    if (i) {
      const iVal = i.getAttributeNS(WNS, "val") || i.getAttribute("w:val") || "true";
      italic = iVal !== "false";
    }
    const u = getChildByLocalName(rPr, "u");
    if (u) {
      const uVal = u.getAttributeNS(WNS, "val") || u.getAttribute("w:val") || "none";
      underline = uVal !== "none";
    }
  }

  // Process inline elements
  for (let i = 0; i < rElem.childNodes.length; i++) {
    const child = rElem.childNodes[i] as Element;
    const localName = child.localName || (child.nodeName || "").replace(/^w:/, "");

    if (localName === "t") {
      let t = escapeHtml(child.textContent || "");
      if (bold) t = `<b>${t}</b>`;
      if (italic) t = `<i>${t}</i>`;
      if (underline) t = `<u>${t}</u>`;
      runsHtml.push(t);
    } else if (localName === "br") {
      const brType = child.getAttributeNS?.(WNS, "type") || child.getAttribute?.("w:type") || "";
      if (!brType || brType === "textWrapping") runsHtml.push("<br>");
    } else if (localName === "tab" || localName === "ptab") {
      runsHtml.push("&#9;");
    } else if (localName === "cr") {
      runsHtml.push("<br>");
    } else if (localName === "noBreakHyphen") {
      runsHtml.push("-");
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serialize the model's main document back to XML and update the zip.
 */
export function serializeMainDoc(model: DocxModel): void {
  const serializer = new XMLSerializer();
  const xml = serializer.serializeToString(model.mainDoc);
  model.zip.file(model.mainDocPath, xml);
}

/**
 * Save the DOCX model to a file.
 */
export async function saveDocx(model: DocxModel, outputPath: string): Promise<void> {
  serializeMainDoc(model);
  const buffer = await model.zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(outputPath, buffer);
}
