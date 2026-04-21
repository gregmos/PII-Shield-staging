/**
 * PII Shield v2.1 — OPC Custom Properties (docProps/custom.xml) read/write.
 *
 * Embeds session_id / source_hash / anonymized_at into emitted anonymized .docx
 * so that deanonymize_docx(path) can restore without the caller passing
 * session_id manually. The file becomes self-describing across chats and
 * machines.
 *
 * Called as a post-step after saveDocx() has already written the document.
 * Works directly on the zipped .docx via jszip; does not touch the
 * docx-reader/docx-anonymizer XML model.
 */

import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const CUSTOM_FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
const CUSTOM_NS = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
const VT_NS = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const CUSTOM_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
const CUSTOM_CT =
  "application/vnd.openxmlformats-officedocument.custom-properties+xml";

/** Generic name → value map for OPC custom props. */
export type CustomProps = Record<string, string>;

/** The subset of custom props written by PII Shield. */
export interface PiiShieldDocxProps {
  session_id: string;
  source_hash: string;     // e.g. "sha256:abc123..."
  anonymized_at: string;   // ISO-8601 UTC
}

const KEY_SESSION_ID = "pii_shield.session_id";
const KEY_SOURCE_HASH = "pii_shield.source_hash";
const KEY_ANONYMIZED_AT = "pii_shield.anonymized_at";

/**
 * Read all custom properties from a .docx. Returns an empty object if
 * docProps/custom.xml is missing or malformed.
 */
export async function readCustomProps(docxPath: string): Promise<CustomProps> {
  const buf = await fs.promises.readFile(docxPath);
  const zip = await JSZip.loadAsync(buf);
  const customFile = zip.file("docProps/custom.xml");
  if (!customFile) return {};
  const xml = await customFile.async("string");
  try {
    return parseCustomXml(xml);
  } catch {
    return {};
  }
}

/**
 * Update or insert custom properties in-place. Preserves any existing
 * properties not listed in `props`. Registers the custom.xml part in
 * [Content_Types].xml and adds the package relationship if missing.
 */
export async function writeCustomProps(
  docxPath: string,
  props: CustomProps,
): Promise<void> {
  const buf = await fs.promises.readFile(docxPath);
  const zip = await JSZip.loadAsync(buf);

  // Merge with existing custom.xml (preserve other authors' props).
  let existing: CustomProps = {};
  const customFile = zip.file("docProps/custom.xml");
  if (customFile) {
    try {
      existing = parseCustomXml(await customFile.async("string"));
    } catch {
      // Malformed existing custom.xml — we'll overwrite it.
    }
  }
  const merged: CustomProps = { ...existing, ...props };

  // Rewrite custom.xml.
  zip.file("docProps/custom.xml", buildCustomXml(merged));

  // Register content type if absent.
  const ctFile = zip.file("[Content_Types].xml");
  if (!ctFile) {
    throw new Error(`Invalid .docx at ${docxPath}: missing [Content_Types].xml`);
  }
  const ctXml = await ctFile.async("string");
  zip.file("[Content_Types].xml", ensureContentTypeOverride(ctXml));

  // Register package-level relationship if absent.
  const relsFile = zip.file("_rels/.rels");
  if (!relsFile) {
    throw new Error(`Invalid .docx at ${docxPath}: missing _rels/.rels`);
  }
  const relsXml = await relsFile.async("string");
  zip.file("_rels/.rels", ensureCustomPropsRelationship(relsXml));

  const outBuf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await fs.promises.writeFile(docxPath, outBuf);
}

/**
 * Typed wrapper for writing the PII Shield trio of properties.
 */
export async function writePiiShieldProps(
  docxPath: string,
  props: PiiShieldDocxProps,
): Promise<void> {
  await writeCustomProps(docxPath, {
    [KEY_SESSION_ID]: props.session_id,
    [KEY_SOURCE_HASH]: props.source_hash,
    [KEY_ANONYMIZED_AT]: props.anonymized_at,
  });
}

/**
 * Typed wrapper for reading the PII Shield trio. Returns null if
 * session_id is missing (the file was not anonymized by PII Shield, or the
 * custom.xml was stripped by a downstream tool).
 */
export async function readPiiShieldProps(
  docxPath: string,
): Promise<PiiShieldDocxProps | null> {
  const all = await readCustomProps(docxPath);
  const sessionId = all[KEY_SESSION_ID];
  if (!sessionId) return null;
  return {
    session_id: sessionId,
    source_hash: all[KEY_SOURCE_HASH] || "",
    anonymized_at: all[KEY_ANONYMIZED_AT] || "",
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

function parseCustomXml(xml: string): CustomProps {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const result: CustomProps = {};
  const propEls = doc.getElementsByTagName("property");
  for (let i = 0; i < propEls.length; i++) {
    const el = propEls[i];
    const name = el.getAttribute("name");
    if (!name) continue;
    // The value child is <vt:lpwstr>; accept any namespace prefix.
    let value = "";
    for (let j = 0; j < el.childNodes.length; j++) {
      const child = el.childNodes[j];
      if (child.nodeType !== 1) continue;
      const localName = (child as unknown as { localName?: string }).localName;
      const nodeName = (child as unknown as { nodeName?: string }).nodeName || "";
      if (localName === "lpwstr" || nodeName === "vt:lpwstr" || nodeName === "lpwstr") {
        value = child.textContent || "";
        break;
      }
    }
    result[name] = value;
  }
  return result;
}

function buildCustomXml(props: CustomProps): string {
  const entries = Object.entries(props);
  const body = entries
    .map(([name, value], i) => {
      // pid must be unique within the Properties element and start at 2
      // (pid=1 is reserved per [MS-OE376]).
      const pid = i + 2;
      return `  <property fmtid="${CUSTOM_FMTID}" pid="${pid}" name="${escapeAttr(name)}"><vt:lpwstr>${escapeText(value)}</vt:lpwstr></property>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="${CUSTOM_NS}" xmlns:vt="${VT_NS}">
${body}
</Properties>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ensureContentTypeOverride(ctXml: string): string {
  if (ctXml.includes('PartName="/docProps/custom.xml"')) return ctXml;
  const override = `<Override PartName="/docProps/custom.xml" ContentType="${CUSTOM_CT}"/>`;
  return ctXml.replace("</Types>", `${override}</Types>`);
}

function ensureCustomPropsRelationship(relsXml: string): string {
  if (relsXml.includes(`Type="${CUSTOM_REL_TYPE}"`)) return relsXml;
  // Find the highest existing rId and use +1.
  const ids = Array.from(relsXml.matchAll(/Id="rId(\d+)"/g)).map((m) =>
    parseInt(m[1], 10),
  );
  const nextId = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  const rel = `<Relationship Id="rId${nextId}" Type="${CUSTOM_REL_TYPE}" Target="docProps/custom.xml"/>`;
  return relsXml.replace("</Relationships>", `${rel}</Relationships>`);
}
