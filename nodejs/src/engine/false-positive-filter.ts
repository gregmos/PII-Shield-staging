/**
 * PII Shield v2.0.0 — False positive filtering
 * Ported from pii_shield_server.py lines 715-903
 *
 * Rules:
 * 0. Stop-list: known legal/contract terms → always drop
 * 1. Single lowercase word + named entity type → drop (not a proper noun)
 * 2. Noisy pattern types + stoplist → drop
 * 3. Structural references ("Schedule 1", "Clause 2") → drop
 * 4. ALL-CAPS single word ≤12 chars in stoplist → drop (heading)
 * 5. Frequency filter: >8 occurrences of same text → drop
 */

import { NAMED_ENTITY_TYPES } from "./entity-types.js";
import type { DetectedEntity } from "./pattern-recognizers.js";

// ── Cyrillic → Latin homoglyph map ──────────────────────────────────────────

const CYRILLIC_MAP: Record<string, string> = {
  "\u0421": "C", "\u0441": "c", // С → C
  "\u0410": "A", "\u0430": "a", // А → A
  "\u0415": "E", "\u0435": "e", // Е → E
  "\u041E": "O", "\u043E": "o", // О → O
  "\u0420": "P", "\u0440": "p", // Р → P
  "\u0425": "X", "\u0445": "x", // Х → X
  "\u0412": "B", "\u0432": "b", // В → B
  "\u041C": "M", "\u043C": "m", // М → M
  "\u0422": "T", "\u0442": "t", // Т → T
  "\u041D": "H", "\u043D": "h", // Н → H
};

function normalizeCyrillic(text: string): string {
  let result = text;
  for (const [cyr, lat] of Object.entries(CYRILLIC_MAP)) {
    result = result.replaceAll(cyr, lat);
  }
  return result;
}

// ── Legal stop-list (~200 terms) ────────────────────────────────────────────

const LEGAL_STOPLIST = new Set([
  // Contract parties / roles
  "contractor", "subcontractor", "client", "customer", "vendor",
  "supplier", "distributor", "franchisor", "franchisee",
  "licensor", "licensee", "employer", "employee", "consultant",
  "agent", "principal", "assignee", "assignor",
  "guarantor", "beneficiary", "trustee", "grantor", "grantee",
  "lessee", "lessor", "tenant", "landlord", "borrower", "lender",
  "buyer", "seller", "partner", "shareholder", "director",
  "officer", "secretary", "treasurer", "representative",
  "obligor", "obligee", "indemnitor", "indemnitee",
  "party", "parties", "counterparty",
  // Job titles / corporate roles
  "chairman", "chairwoman", "chairperson", "president",
  "vice president", "manager", "supervisor", "administrator",
  "coordinator", "counsel", "attorney", "auditor", "comptroller",
  "commissioner", "mediator", "arbitrator", "notary",
  "general counsel", "key employee", "key employees",
  "ceo", "cfo", "cto", "coo", "cmo", "cio", "cpo",
  // Document / legal structural terms
  "order", "agreement", "contract", "amendment", "addendum",
  "exhibit", "schedule", "appendix", "annex", "section",
  "article", "clause", "paragraph", "recital", "preamble",
  "purchase order", "statement of work", "scope of work",
  "whereas", "herein", "thereof", "therein", "hereby",
  "definitions", "interpretation", "counterparts", "announcements",
  "variation", "assignment", "notices", "costs",
  // M&A / SPA / corporate transaction terms
  "shares", "share", "sale", "completion", "conditions",
  "warranties", "warranty", "representations", "covenants",
  "obligations", "undertakings", "indemnities", "limitations",
  "transaction", "acquisition", "disposal", "transfer",
  "consideration", "purchase price", "closing", "escrow",
  "due diligence", "disclosure", "material adverse",
  "pre-completion", "post-completion", "longstop",
  "lien", "encumbrance", "pledge", "charge", "mortgage",
  "de minimis", "de minimis amount", "basket", "cap",
  "tax", "taxation", "tax covenant", "tax deed",
  "hmrc", "customs", "revenue",
  // Legal concepts
  "effective date", "termination date", "commencement date",
  "governing law", "force majeure", "confidential information",
  "intellectual property", "indemnification", "arbitration",
  "term", "territory", "termination", "jurisdiction",
  "liability", "negligence", "damages",
  "breach", "remedy", "waiver", "severability",
  "claim", "claims", "dispute", "proceedings", "litigation",
  "consent", "approval", "authority", "resolution",
  // Generic business / corporate terms
  "company", "corporation", "entity", "firm", "business",
  "affiliate", "subsidiary", "parent", "division", "branch",
  "enterprise", "venture", "consortium", "syndicate",
  "board", "committee", "department", "office",
  "body corporate", "government", "association", "partnership",
  // Generic nouns NER misclassifies as PERSON
  "person", "individual", "persons", "individuals",
  "actor", "actors", "creator", "creators", "model", "models",
  "influencer", "influencers", "talent", "talents",
  "candidate", "applicant", "recipient", "subscriber",
  "member", "participant", "attendee", "user", "owner",
  "author", "editor", "contributor", "reviewer", "approver",
  "sender", "receiver", "holder", "bearer", "maker",
  "performer", "speaker", "presenter", "moderator",
  "witness", "signatory", "undersigned",
  "purchase", "invoice", "payment", "delivery", "shipment",
  "name", "practice", "relevant person",
  // Short ambiguous words
  "will", "may", "case", "show", "set", "lead", "head",
  "share", "note", "record", "draft", "release", "notice",
  // Abbreviations
  "cta", "nda", "sow", "msa", "sla", "roi", "kpi",
  "llc", "ltd", "inc", "corp", "plc", "gmbh", "sarl", "llp",
  "usd", "eur", "gbp", "jpy", "cny",
  // Software / product names
  "adobe", "adobe premiere", "adobe premiere pro", "adobe after effects",
  "final cut", "final cut pro", "davinci resolve",
  "photoshop", "illustrator", "figma", "canva",
  "microsoft", "google", "apple", "amazon", "meta",
  // Cyrillic homoglyphs
  "\u0441lient", "сlient",
]);

// Function words to ignore when checking if entity is all-stoplist
const SKIP_WORDS = new Set([
  "the", "a", "an", "of", "and", "or", "for", "in", "to", "by",
  "on", "at", "is", "it", "as", "if", "so", "no", "not", "its",
  "this", "that", "with", "from", "but", "all", "any", "each",
  "such", "than", "into", "upon", "per", "via", "re", "vs",
]);

const ARTICLES = ["the ", "a ", "an "];

const NOISY_PATTERN_TYPES = new Set([
  "DE_SOCIAL_SECURITY", "EU_VAT", "UK_DRIVING_LICENCE",
  "MEDICAL_LICENSE", "NRP",
]);

const STRUCTURAL_RE = /^(schedule|clause|section|article|appendix|annex|exhibit|part|recital)\s+\d/;

/** Strip trailing English possessive: "Seller's" → "seller", "directors'" → "directors". */
function stripPossessive(s: string): string {
  // curly + straight apostrophes
  return s.replace(/[\u2019']s$/i, "").replace(/[\u2019']$/, "");
}

function isInStoplist(text: string): boolean {
  const norm = text.toLowerCase().trim();
  const normLatin = normalizeCyrillic(norm);
  const candidates = new Set<string>([norm, normLatin]);

  // Possessive variants: "Seller's" → "seller", "Buyers'" → "buyers"
  candidates.add(stripPossessive(norm));
  candidates.add(stripPossessive(normLatin));

  // Direct check across all candidates
  for (const c of candidates) {
    if (LEGAL_STOPLIST.has(c)) return true;
  }

  // Strip leading articles ("the seller", "an obligor", …)
  for (const c of candidates) {
    for (const art of ARTICLES) {
      if (c.startsWith(art)) {
        const stripped = c.slice(art.length);
        if (LEGAL_STOPLIST.has(stripped)) return true;
        if (LEGAL_STOPLIST.has(stripPossessive(stripped))) return true;
      }
    }
  }

  return false;
}

/**
 * Filter false positives from entity list.
 * Mutates nothing — returns a new filtered array.
 */
export function filterFalsePositives(entities: DetectedEntity[]): DetectedEntity[] {
  // Collect confirmed high-score texts for cross-reference
  const confirmedTexts = new Set<string>();
  for (const e of entities) {
    if (e.score >= 0.6) {
      confirmedTexts.add(e.text.toLowerCase());
      for (const word of e.text.split(/\s+/)) {
        confirmedTexts.add(word.toLowerCase());
      }
    }
  }

  const cleaned: DetectedEntity[] = [];

  for (const e of entities) {
    const txt = e.text;
    const etype = e.type;
    const normTxt = txt.toLowerCase().trim();

    // Rule 0: Stop-list
    if (isInStoplist(txt)) continue;

    // All words are function words → never PII
    const meaningful = normTxt.split(/\s+/).filter((w) => !SKIP_WORDS.has(w));
    if (meaningful.length === 0) continue;

    // All meaningful words in stoplist
    if (meaningful.every((w) => LEGAL_STOPLIST.has(w))) continue;

    // Rule 1: Single lowercase word + named entity type
    const words = txt.split(/\s+/);
    if (words.length === 1 && NAMED_ENTITY_TYPES.has(etype)) {
      if (txt[0] === txt[0].toLowerCase() && txt[0] !== txt[0].toUpperCase()) {
        if (!confirmedTexts.has(txt.toLowerCase())) continue;
      }
    }

    // Rule 2: Noisy pattern types + stoplist
    if (NOISY_PATTERN_TYPES.has(etype) && LEGAL_STOPLIST.has(normTxt)) continue;

    // Rule 3: Structural references
    if (STRUCTURAL_RE.test(normTxt)) continue;

    // Rule 4: ALL-CAPS heading
    if (txt === txt.toUpperCase() && txt.length <= 12 && LEGAL_STOPLIST.has(normTxt)) continue;

    cleaned.push(e);
  }

  // Rule 5: Frequency filter (>8 occurrences)
  const textCounts = new Map<string, number>();
  for (const e of cleaned) {
    if (NAMED_ENTITY_TYPES.has(e.type)) {
      const key = e.text.toLowerCase().trim();
      textCounts.set(key, (textCounts.get(key) || 0) + 1);
    }
  }

  const highFreq = new Set<string>();
  for (const [text, count] of textCounts) {
    if (count > 8) highFreq.add(text);
  }

  if (highFreq.size === 0) return cleaned;

  return cleaned.filter(
    (e) => !highFreq.has(e.text.toLowerCase().trim()) || !NAMED_ENTITY_TYPES.has(e.type),
  );
}
