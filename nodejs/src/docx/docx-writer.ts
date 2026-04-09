/**
 * PII Shield v2.0.0 — DOCX writer
 * Creates formatted .docx files from plain text.
 * Ported from pii_shield_server.py lines 2419-2450
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel, convertInchesToTwip } from "docx";
import fs from "node:fs";

/**
 * Write text to a formatted .docx file with basic heading detection.
 */
export async function writeDocx(text: string, outputPath: string): Promise<void> {
  const lines = text.split("\n");
  const children: Paragraph[] = [];

  for (const line of lines) {
    const stripped = line.trim();

    if (!stripped) {
      children.push(new Paragraph({ children: [] }));
      continue;
    }

    // Detect headings
    if (stripped.length < 100 && stripped === stripped.toUpperCase() && /[A-Z]/.test(stripped)) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun(stripped)],
      }));
    } else if (stripped.startsWith("#")) {
      const level = Math.min(stripped.length - stripped.replace(/^#+/, "").length, 4);
      const headingText = stripped.replace(/^#+\s*/, "");
      const headingLevel = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ][level - 1] || HeadingLevel.HEADING_4;

      children.push(new Paragraph({
        heading: headingLevel,
        children: [new TextRun(headingText)],
      }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text: stripped, font: "Calibri", size: 22 })],
        spacing: { after: 120 },
      }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1.2),
            right: convertInchesToTwip(1.2),
          },
        },
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}
