/**
 * Quick text extraction from PDFs — saves .txt files for gap analysis.
 * Usage: npx tsx src/local-app/extract-texts.ts "C:/path/to/folder"
 */
import "./preload.js";
import fs from "node:fs";
import path from "node:path";
import { extractPdfText } from "../pdf/pdf-reader.js";

async function main() {
  const folder = process.argv[2];
  if (!folder || !fs.existsSync(folder)) {
    console.error("Usage: npx tsx src/local-app/extract-texts.ts <folder>");
    process.exit(1);
  }

  const outDir = path.join(folder, "extracted_texts");
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith(".pdf")).sort();
  for (const f of files) {
    const fp = path.join(folder, f);
    try {
      const text = await extractPdfText(fp);
      const outPath = path.join(outDir, f.replace(/\.pdf$/i, ".txt"));
      fs.writeFileSync(outPath, text, "utf-8");
      console.log(`OK: ${f} → ${text.length} chars`);
    } catch (e: any) {
      console.error(`FAIL: ${f} — ${e.message}`);
    }
  }
  console.log(`\nDone. Texts saved to: ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
