/**
 * Shared helpers for manipulating w:r / w:rPr inside .docx.
 * Consumed by both docx-redliner (tracked-change insertions) and docx-anonymizer
 * (in-place PII replacement). The two mechanisms are structurally different but
 * both need to be able to clone run-properties while optionally stripping
 * character-emphasis tags (`b`, `i`, `u`, `caps`, …) so inserted/rewritten text
 * doesn't inherit bold/italic from a partial run overlap.
 */

import type { Document, Element } from "@xmldom/xmldom";

/**
 * Tags inside w:rPr that carry character emphasis / visibility effects.
 * When an anonymized placeholder spans runs with *mixed* formatting we strip
 * these so the host run doesn't render "<ORG_1>" as half-bold.
 * Font / color / size / lang are deliberately kept — they preserve
 * typographical blending with the surrounding paragraph.
 */
export const NEUTRAL_DROP_TAGS = new Set([
  "b", "bCs", "i", "iCs", "u", "strike", "dstrike",
  "highlight", "shd", "caps", "smallCaps", "em",
]);

/**
 * Return the first direct-child w:rPr element of a w:r, or null.
 */
export function findRunProps(rElem: Element): Element | null {
  for (let i = 0; i < rElem.childNodes.length; i++) {
    const child = rElem.childNodes[i] as Element;
    const ln = child.localName || (child.nodeName || "").replace(/^w:/, "");
    if (ln === "rPr") return child;
  }
  return null;
}

/**
 * Clone a w:rPr element (run properties) for use in inserted runs.
 * Returns null if the source run has no rPr.
 */
export function cloneRunProps(rElem: Element, _doc: Document): Element | null {
  const rPr = findRunProps(rElem);
  return rPr ? (rPr.cloneNode(true) as Element) : null;
}

/**
 * Like cloneRunProps but strips character-emphasis tags so inserted/rewritten
 * text doesn't inherit bold/italic/underline from the surrounding run.
 * Phase 6 Fix 6.5 — originated in docx-redliner for tracked-change runs; now
 * also used by docx-anonymizer to fix partial-bold artifacts when a placeholder
 * replaces text that spanned mixed-format runs.
 */
export function cloneNeutralRunProps(rElem: Element, doc: Document): Element | null {
  const rPr = cloneRunProps(rElem, doc);
  if (!rPr) return null;
  const kids: Element[] = [];
  for (let i = 0; i < rPr.childNodes.length; i++) {
    const c = rPr.childNodes[i] as Element;
    if (c.nodeType === 1) kids.push(c);
  }
  for (const c of kids) {
    const ln = c.localName || (c.nodeName || "").replace(/^w:/, "");
    if (NEUTRAL_DROP_TAGS.has(ln)) {
      rPr.removeChild(c);
    }
  }
  return rPr;
}

/**
 * Normalize the run hosting an in-place replacement so it doesn't render
 * partially bold/italic when the original text spanned runs with different
 * rPr. Does nothing if the host already has no emphasis tags (typical case
 * in plain body text — we don't want to pointlessly rewrite rPr there).
 *
 * @param wtElem  The w:t element that received the replacement textContent.
 * @returns true if rPr was normalized, false if no change was needed.
 */
export function neutralizeHostRunEmphasis(wtElem: Element): boolean {
  const rElem = wtElem.parentNode as Element | null;
  if (!rElem) return false;
  const rPr = findRunProps(rElem);
  if (!rPr) return false;

  // Find emphasis children to remove (snapshot — removeChild mutates live list).
  const toRemove: Element[] = [];
  for (let i = 0; i < rPr.childNodes.length; i++) {
    const c = rPr.childNodes[i] as Element;
    if (c.nodeType !== 1) continue;
    const ln = c.localName || (c.nodeName || "").replace(/^w:/, "");
    if (NEUTRAL_DROP_TAGS.has(ln)) toRemove.push(c);
  }
  if (toRemove.length === 0) return false;
  for (const c of toRemove) rPr.removeChild(c);
  return true;
}
