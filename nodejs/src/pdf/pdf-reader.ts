/**
 * PII Shield v2.0.0 — PDF text extraction
 * Uses pdf.js-extract for layout-aware extraction (preserves reading order).
 * Replaces pdf-parse which produced "one word per line" on many PDFs.
 */

import fs from "node:fs";
import path from "node:path";
import { logServer } from "../audit/audit-logger.js";

/** Max PDF file size we attempt to parse (100 MB). Beyond this, likely OOM. */
const MAX_PDF_SIZE = 100 * 1024 * 1024;

/**
 * Extract text from a PDF file using layout-aware extraction.
 * Groups text items by Y-coordinate into proper lines, preserving reading order.
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
    logServer(`[PDF] Loading pdf.js-extract module...`);
    const { PDFExtract } = await import("pdf.js-extract");

    const pdfExtract = new PDFExtract();
    logServer(`[PDF] Extracting with layout preservation...`);

    const data = await pdfExtract.extract(filePath, {
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });

    const numPages = data.pages.length;
    const pageTexts: string[] = [];

    for (const page of data.pages) {
      // Group text items by Y-coordinate into lines (tolerance = 2 units)
      const lines = PDFExtract.utils.pageToLines(page, 2);
      const pageLines: string[] = [];

      for (const lineItems of lines) {
        // Each lineItems is an array of text items with x, y, str, width, etc.
        const items = (lineItems as Array<{ x: number; str: string; width: number }>)
          .filter((it) => it.str.trim().length > 0)
          .sort((a, b) => a.x - b.x);

        if (items.length === 0) continue;

        // Detect table-like 2-column layout: look for a large X-gap between items
        if (items.length >= 2) {
          let maxGap = 0, gapIdx = 0;
          for (let i = 1; i < items.length; i++) {
            const gap = items[i].x - (items[i - 1].x + items[i - 1].width);
            if (gap > maxGap) { maxGap = gap; gapIdx = i; }
          }

          // 30+ pt gap + short label (< 40 chars) → likely table "Label  Value"
          if (maxGap > 30) {
            const label = items.slice(0, gapIdx).map((it) => it.str).join(" ").trim();
            const value = items.slice(gapIdx).map((it) => it.str).join(" ").trim();
            if (label && value && label.length < 40) {
              // Format as "Label: Value" (strip trailing colon from label if present)
              const cleanLabel = label.replace(/:\s*$/, "");
              pageLines.push(`${cleanLabel}: ${value}`);
              continue;
            }
          }
        }

        // Default: join all fragments with space
        pageLines.push(items.map((it) => it.str).join(" ").trim());
      }

      pageTexts.push(pageLines.filter((l) => l.length > 0).join("\n"));
    }

    const text = pageTexts.join("\n\n"); // page break = double newline

    logServer(`[PDF] Extraction complete: ${numPages} pages, ${text.length} chars`);

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
