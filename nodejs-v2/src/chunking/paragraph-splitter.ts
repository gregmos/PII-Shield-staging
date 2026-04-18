/**
 * PII Shield v2.0.0 — Paragraph splitter for chunked processing
 * Ported from pii_shield_server.py lines 1733-1751
 */

/**
 * Split text into chunks on paragraph boundaries (\n\n).
 * Each chunk is at most targetSize chars (unless a single paragraph exceeds it).
 */
export function splitParagraphs(text: string, targetSize: number): string[] {
  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    const paraLen = para.length + (current.length > 0 ? 2 : 0); // +2 for \n\n separator
    if (currentLen + paraLen > targetSize && current.length > 0) {
      chunks.push(current.join("\n\n"));
      current = [para];
      currentLen = para.length;
    } else {
      current.push(para);
      currentLen += paraLen;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }

  return chunks.length > 0 ? chunks : [text];
}
