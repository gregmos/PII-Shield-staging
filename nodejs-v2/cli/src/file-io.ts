/**
 * PII Shield CLI — file IO helpers.
 *
 * Wraps the engine's PDF/DOCX readers with a uniform `readDocumentText` for
 * commands that only need plain text (scan). Anonymize uses the per-format
 * pipelines directly to preserve DOCX formatting.
 */

import fs from "node:fs";
import path from "node:path";
import { extractPdfText } from "../../src/pdf/pdf-reader.js";
import { loadDocx, extractText } from "../../src/docx/docx-reader.js";

const PLAIN_EXTS = new Set([".txt", ".md", ".csv", ".log", ".html", ".htm"]);

export interface ReadResult {
  text: string;
  ext: string;
  bytes: number;
}

export async function readDocumentText(filePath: string): Promise<ReadResult> {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  const ext = path.extname(abs).toLowerCase();
  const bytes = fs.statSync(abs).size;

  if (ext === ".pdf") {
    const text = await extractPdfText(abs);
    return { text, ext, bytes };
  }
  if (ext === ".docx") {
    const model = await loadDocx(abs);
    const text = extractText(model);
    return { text, ext, bytes };
  }
  if (PLAIN_EXTS.has(ext) || ext === "") {
    const text = fs.readFileSync(abs, "utf8");
    return { text, ext, bytes };
  }
  throw new Error(
    `Unsupported file type: ${ext} (supported: .pdf, .docx, .txt, .md, .csv)`,
  );
}

export function deriveOutputPath(
  inputPath: string,
  outDir: string | undefined,
  suffix = ".anonymized",
): string {
  const abs = path.resolve(inputPath);
  const dir = outDir ? path.resolve(outDir) : path.dirname(abs);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  return path.join(dir, `${base}${suffix}${ext}`);
}
