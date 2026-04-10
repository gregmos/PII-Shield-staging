/**
 * PII Shield v2.0.0 — PDF text extraction
 * Replaces pdfplumber (Python) with pdf-parse (Node.js)
 */

import fs from "node:fs";
import path from "node:path";
import { logServer } from "../audit/audit-logger.js";

/** Max PDF file size we attempt to parse (100 MB). Beyond this, likely OOM. */
const MAX_PDF_SIZE = 100 * 1024 * 1024;

/**
 * Extract text from a PDF file.
 * Returns the concatenated text from all pages.
 * Throws if the file can't be read or has no extractable text.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  const basename = path.basename(filePath);
  logServer(`[PDF] Starting extraction: ${basename} (${sizeMB} MB)`);

  if (stat.size > MAX_PDF_SIZE) {
    throw new Error(
      `PDF too large (${sizeMB} MB). Max supported: ${MAX_PDF_SIZE / 1024 / 1024} MB.`
    );
  }

  try {
    logServer(`[PDF] Loading pdf-parse module...`);
    const pdfParse = (await import("pdf-parse")).default;

    logServer(`[PDF] Reading file into buffer...`);
    const buffer = fs.readFileSync(filePath);
    logServer(`[PDF] Buffer ready (${buffer.length} bytes). Parsing...`);

    const data = await pdfParse(buffer);
    const text = data.text || "";
    const pages = data.numpages || 0;

    logServer(`[PDF] Extraction complete: ${pages} pages, ${text.length} chars`);

    if (text.trim().length < 50) {
      throw new Error(
        "PDF has no extractable text layer. Scanned PDFs (OCR) are not yet supported.",
      );
    }

    return text;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logServer(`[PDF] Extraction FAILED for ${basename}: ${msg}`);
    throw new Error(`PDF extraction failed (${basename}, ${sizeMB} MB): ${msg}`);
  }
}
