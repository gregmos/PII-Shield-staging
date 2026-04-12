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
// ── Jurisdiction context — LOCATION in governing law clauses should NOT be anonymized ──

const JURISDICTION_TYPES = new Set(["LOCATION", "NRP", "ADDRESS", "ORGANIZATION"]);

// Optional trailing article before the location name
const THE = `(?:the\\s+)?`;

// Patterns that appear BEFORE the location (look-behind window)
const JURISDICTION_BEFORE = [
  new RegExp(`\\bgoverned\\s+by\\s+${THE}(?:laws?\\s+of\\s+)?${THE}$`, "i"),
  new RegExp(`\\blaws?\\s+of\\s+${THE}$`, "i"),
  new RegExp(`\\bcourts?\\s+of\\s+${THE}$`, "i"),
  new RegExp(`\\bjurisdiction\\s+of\\s+${THE}$`, "i"),
  new RegExp(`\\bsubject\\s+to\\s+${THE}(?:laws?\\s+of\\s+)?${THE}$`, "i"),
  new RegExp(`\\bunder\\s+${THE}(?:laws?\\s+of\\s+)?${THE}$`, "i"),
  new RegExp(`\\bin\\s+accordance\\s+with\\s+${THE}(?:laws?\\s+of\\s+)?${THE}$`, "i"),
  new RegExp(`\\bconstrued\\s+(?:in\\s+accordance\\s+with|under)\\s+${THE}(?:laws?\\s+of\\s+)?${THE}$`, "i"),
  new RegExp(`\\bapplicable\\s+law\\s+(?:of|in)\\s+${THE}$`, "i"),
  new RegExp(`\\bexclusive\\s+jurisdiction\\s+of\\s+${THE}$`, "i"),
  new RegExp(`\\bcompetent\\s+courts?\\s+(?:of|in)\\s+${THE}$`, "i"),
  new RegExp(`\\bregistered\\s+in\\s+${THE}$`, "i"),
  new RegExp(`\\bincorporated\\s+(?:in|under\\s+the\\s+laws?\\s+of)\\s+${THE}$`, "i"),
  /\bresolved\s+by\s+$/i,
  /\bpursuant\s+to\s+(?:the\s+)?(?:laws?\s+of\s+)?(?:the\s+)?$/i,
  // Arbitration / venue / forum / seat
  new RegExp(`\\barbitration\\s+(?:shall\\s+)?(?:take\\s+place|be\\s+held|be\\s+conducted)\\s+in\\s+${THE}$`, "i"),
  new RegExp(`\\bseat\\s+of\\s+(?:the\\s+)?arbitration\\s+(?:shall\\s+be|is)\\s+${THE}$`, "i"),
  new RegExp(`\\bvenue\\s+(?:shall\\s+be|is|for)\\s+(?:in\\s+)?${THE}$`, "i"),
  new RegExp(`\\bforum\\s+(?:shall\\s+be|is|for\\s+\\w+\\s+shall\\s+be)\\s+${THE}$`, "i"),
  new RegExp(`\\bexclusive\\s+(?:venue|forum)\\s+(?:shall\\s+be|is|for)\\s+(?:in\\s+)?${THE}$`, "i"),
  // "Governing Law:" / "Applicable Law:" with colon
  /\b(?:governing|applicable)\s+law\s*:\s*$/i,
  // Continuation: "England and <Wales>" — jurisdiction chain via "and"/"or"
  /\b(?:courts?|laws?|jurisdiction|legislation|arbitration|venue|forum)\b.*\b(?:and|or)\s+$/i,
];

// Patterns that appear AFTER the location (look-ahead window)
const JURISDICTION_AFTER = [
  /^\s*(?:law|laws|legislation|courts?|jurisdiction|legal\s+system)/i,
  /^\s*(?:courts?\s+shall\s+have)/i,
  /^\s*(?:courts?\s+of\s+competent\s+jurisdiction)/i,
  /^\s*(?:courts?\s+located\s+in)/i,
];

const JURISDICTION_WINDOW = 80; // chars to look before/after the entity

// Entity text that ENDS with a jurisdiction term (e.g. "German courts", "English law")
// Must END with the term to avoid false positives like "Law Firm of Johnson"
const JURISDICTION_INLINE = /\b(?:courts?|laws?|legislation|jurisdiction|legal\s+system|tribunal)$/i;

function isJurisdictionContext(entity: DetectedEntity, text: string, allEntities?: DetectedEntity[]): boolean {
  if (!JURISDICTION_TYPES.has(entity.type)) return false;

  const before = text.slice(Math.max(0, entity.start - JURISDICTION_WINDOW), entity.start);
  const after = text.slice(entity.end, Math.min(text.length, entity.end + JURISDICTION_WINDOW));

  // Check before-context
  for (const re of JURISDICTION_BEFORE) {
    if (re.test(before)) return true;
  }
  // Check after-context
  for (const re of JURISDICTION_AFTER) {
    if (re.test(after)) return true;
  }
  // Check if entity text itself contains jurisdiction terms (e.g. "German courts")
  if (JURISDICTION_INLINE.test(entity.text)) return true;

  return false;
}

/** Remove entities that are in jurisdiction context (for use after propagation) */
export function filterJurisdictionEntities(entities: DetectedEntity[], text: string): DetectedEntity[] {
  return entities.filter((e) => !isJurisdictionContext(e, text));
}

export function filterFalsePositives(entities: DetectedEntity[], text?: string): DetectedEntity[] {
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

    // Rule J: Jurisdiction context — keep LOCATIONs in governing law clauses
    // (they affect legal interpretation and must NOT be anonymized)
    if (text && isJurisdictionContext(e, text)) continue;

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
