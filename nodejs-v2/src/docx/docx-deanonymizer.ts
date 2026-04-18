/**
 * PII Shield v2.0.0 — DOCX deanonymization
 * Restores placeholders in .docx preserving formatting.
 * Ported from pii_shield_server.py lines 1516-1529
 */

import path from "node:path";
import { loadDocx, saveDocx, iterAllWpElements } from "./docx-reader.js";
import { replaceAcrossRuns } from "./docx-anonymizer.js";

/**
 * Restore real PII values in a .docx file using a mapping.
 * Replaces placeholders like <PERSON_1> with original text.
 */
export async function deanonymizeDocx(
  docxPath: string, mapping: Record<string, string>,
): Promise<string> {
  const model = await loadDocx(docxPath);
  // Sort placeholders longest first to avoid partial matches
  const sortedPh = Object.keys(mapping).sort((a, b) => b.length - a.length);

  const allPElems = iterAllWpElements(model.mainDoc);

  // Placeholders like <PERSON_1> don't contain \n, so single-pass is enough
  for (const pElem of allPElems) {
    for (const ph of sortedPh) {
      replaceAcrossRuns(pElem, ph, mapping[ph]);
    }
  }

  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_restored.docx`);
  await saveDocx(model, outPath);
  return outPath;
}
