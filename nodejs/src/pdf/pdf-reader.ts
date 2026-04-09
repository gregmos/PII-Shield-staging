/**
 * PII Shield v2.0.0 — PDF text extraction
 * Replaces pdfplumber (Python) with pdf-parse (Node.js)
 */

import fs from "node:fs";

/**
 * Extract text from a PDF file.
 * Returns the concatenated text from all pages.
 * Throws if the file can't be read or has no extractable text.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default;
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);

  const text = data.text || "";

  if (text.trim().length < 50) {
    throw new Error(
      "PDF has no extractable text layer. Scanned PDFs (OCR) are not yet supported.",
    );
  }

  return text;
}
