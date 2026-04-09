/**
 * PII Shield v2.0.0 — Pattern-based PII recognizers
 * Ported from eu_recognizers.py + Presidio built-in patterns.
 *
 * Each recognizer: regex match → list of detected spans with type, position, score.
 * Context words boost confidence by +0.35.
 */

export interface DetectedEntity {
  text: string;
  type: string;
  start: number;
  end: number;
  score: number;
  verified: boolean;
  reason: string;
}

interface PatternDef {
  name: string;
  regex: RegExp;
  score: number;
}

interface RecognizerDef {
  entityType: string;
  patterns: PatternDef[];
  context: string[];
}

const CONTEXT_BOOST = 0.35;
const CONTEXT_WINDOW = 200;

function buildRecognizers(): RecognizerDef[] {
  const recognizers: RecognizerDef[] = [];

  // ════════════════════════════════════════════════════════════
  // Presidio built-in patterns
  // ════════════════════════════════════════════════════════════

  recognizers.push({
    entityType: "EMAIL_ADDRESS",
    patterns: [
      { name: "email", regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, score: 0.85 },
    ],
    context: ["email", "e-mail", "mail", "address", "contact"],
  });

  recognizers.push({
    entityType: "PHONE_NUMBER",
    patterns: [
      // International: REQUIRES leading + so "2024" can't match.
      { name: "phone_intl", regex: /\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?[\s.\-]?\d{1,4}[\s.\-]?\d{1,9}\b/g, score: 0.6 },
      // US/UK formatted: REQUIRES parentheses or separators between groups.
      // Bare 10-digit blobs without any separator are not matched here on purpose.
      { name: "phone_us_paren", regex: /\(\d{3}\)\s?\d{3}[\s.\-]?\d{4}\b/g, score: 0.6 },
      { name: "phone_us_sep", regex: /\b\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b/g, score: 0.55 },
      // Long bare digit run: 11+ digits is unlikely to be a year/account no.
      // Context boost will rescue legitimate phone hits; otherwise filtered by PII_MIN_SCORE.
      { name: "phone_long_bare", regex: /\b\d{11,15}\b/g, score: 0.2 },
    ],
    context: ["phone", "telephone", "tel", "call", "mobile", "cell", "fax", "contact number"],
  });

  recognizers.push({
    entityType: "URL",
    patterns: [
      { name: "url", regex: /\bhttps?:\/\/[^\s<>"{}|\\^`\[\]]+/g, score: 0.6 },
    ],
    context: ["url", "website", "link", "site", "http", "www"],
  });

  recognizers.push({
    entityType: "IP_ADDRESS",
    patterns: [
      { name: "ipv4", regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, score: 0.6 },
      { name: "ipv6", regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, score: 0.6 },
    ],
    context: ["IP", "address", "server", "host", "network"],
  });

  recognizers.push({
    entityType: "CREDIT_CARD",
    patterns: [
      // Visa
      { name: "cc_visa", regex: /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, score: 0.6 },
      // Mastercard
      { name: "cc_mc", regex: /\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, score: 0.6 },
      // Amex
      { name: "cc_amex", regex: /\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b/g, score: 0.6 },
    ],
    context: ["credit card", "card number", "CC", "Visa", "MasterCard", "Amex", "payment"],
  });

  recognizers.push({
    entityType: "IBAN_CODE",
    patterns: [
      { name: "iban", regex: /\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}[\s]?(?:[\dA-Z]{4}[\s]?){1,7}[\dA-Z]{1,4}\b/g, score: 0.7 },
    ],
    context: ["IBAN", "bank account", "account number", "bank transfer", "SWIFT", "BIC"],
  });

  recognizers.push({
    entityType: "CRYPTO",
    patterns: [
      // Bitcoin
      { name: "btc", regex: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, score: 0.5 },
      // Ethereum
      { name: "eth", regex: /\b0x[0-9a-fA-F]{40}\b/g, score: 0.6 },
    ],
    context: ["bitcoin", "ethereum", "crypto", "wallet", "BTC", "ETH", "blockchain"],
  });

  // US
  recognizers.push({
    entityType: "US_SSN",
    patterns: [
      { name: "us_ssn", regex: /\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/g, score: 0.5 },
    ],
    context: ["SSN", "social security", "social security number"],
  });

  recognizers.push({
    entityType: "US_PASSPORT",
    patterns: [
      { name: "us_passport", regex: /\b[A-Z]\d{8}\b/g, score: 0.1 },
    ],
    context: ["passport", "US passport", "travel document", "State Department"],
  });

  recognizers.push({
    entityType: "US_DRIVER_LICENSE",
    patterns: [
      { name: "us_dl", regex: /\b[A-Z]\d{7,12}\b/g, score: 0.1 },
    ],
    context: ["driver's license", "driver license", "DL", "DMV"],
  });

  // UK
  recognizers.push({
    entityType: "UK_NHS",
    patterns: [
      { name: "uk_nhs", regex: /\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g, score: 0.3 },
    ],
    context: ["NHS", "NHS number", "health service", "patient number", "medical record"],
  });

  // ════════════════════════════════════════════════════════════
  // EU recognizers (ported from eu_recognizers.py)
  // ════════════════════════════════════════════════════════════

  // UK National Insurance Number (NIN/NINO)
  recognizers.push({
    entityType: "UK_NIN",
    patterns: [
      { name: "uk_nin_spaced", regex: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, score: 0.7 },
    ],
    context: ["national insurance", "NI number", "NIN", "NINO", "tax", "HMRC", "PAYE"],
  });

  // UK Passport — 9 digits
  recognizers.push({
    entityType: "UK_PASSPORT",
    patterns: [
      { name: "uk_passport", regex: /\b\d{9}\b/g, score: 0.1 },
    ],
    context: ["passport", "travel document", "UK passport", "HM Passport", "HMPO"],
  });

  // UK Company Registration Number (CRN)
  recognizers.push({
    entityType: "UK_CRN",
    patterns: [
      { name: "uk_crn_numeric", regex: /\b\d{8}\b/g, score: 0.1 },
      { name: "uk_crn_alpha", regex: /\b[A-Z]{2}\d{6}\b/g, score: 0.4 },
    ],
    context: ["company number", "registration number", "Companies House", "CRN", "registered number", "company reg"],
  });

  // UK Driving Licence — 16 chars
  recognizers.push({
    entityType: "UK_DRIVING_LICENCE",
    patterns: [
      { name: "uk_dl", regex: /\b[A-Z]{5}\d{6}[A-Z0-9]{2}\d{2}[A-Z]{2}\b/g, score: 0.75 },
    ],
    context: ["driving licence", "driver's licence", "DVLA", "driving license"],
  });

  // Germany — Tax ID (11 digits)
  recognizers.push({
    entityType: "DE_TAX_ID",
    patterns: [
      { name: "de_tax_id", regex: /\b\d{11}\b/g, score: 0.1 },
    ],
    context: ["Steuer-ID", "Steueridentifikationsnummer", "tax identification", "IdNr", "TIN", "German tax", "Finanzamt"],
  });

  // Germany — Social Security (12 chars)
  recognizers.push({
    entityType: "DE_SOCIAL_SECURITY",
    patterns: [
      { name: "de_sv", regex: /\b\d{2}\s?\d{6}\s?[A-Z]\s?\d{2}\s?\d\b/g, score: 0.6 },
    ],
    context: ["Sozialversicherungsnummer", "SV-Nummer", "social security", "Rentenversicherung", "insurance number"],
  });

  // France — Social Security (NIR/INSEE)
  recognizers.push({
    entityType: "FR_NIR",
    patterns: [
      { name: "fr_nir", regex: /\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g, score: 0.65 },
    ],
    context: ["NIR", "INSEE", "sécurité sociale", "social security", "numéro de sécurité", "carte vitale"],
  });

  // France — National ID (CNI) — 12 digits
  recognizers.push({
    entityType: "FR_CNI",
    patterns: [
      { name: "fr_cni", regex: /\b\d{12}\b/g, score: 0.1 },
    ],
    context: ["carte nationale", "CNI", "national identity", "carte d'identité", "French ID", "pièce d'identité"],
  });

  // Italy — Codice Fiscale (16 chars)
  recognizers.push({
    entityType: "IT_FISCAL_CODE",
    patterns: [
      { name: "it_cf", regex: /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/g, score: 0.8 },
    ],
    context: ["codice fiscale", "fiscal code", "CF", "Italian tax"],
  });

  // Italy — Partita IVA
  recognizers.push({
    entityType: "IT_VAT",
    patterns: [
      { name: "it_vat", regex: /\bIT\s?\d{11}\b/g, score: 0.75 },
    ],
    context: ["partita IVA", "VAT", "P.IVA", "Italian VAT"],
  });

  // Spain — DNI
  recognizers.push({
    entityType: "ES_DNI",
    patterns: [
      { name: "es_dni", regex: /\b\d{8}[A-Z]\b/g, score: 0.6 },
    ],
    context: ["DNI", "documento nacional", "national identity", "NIF", "Spanish ID", "identidad"],
  });

  // Spain — NIE
  recognizers.push({
    entityType: "ES_NIE",
    patterns: [
      { name: "es_nie", regex: /\b[XYZ]\d{7}[A-Z]\b/g, score: 0.7 },
    ],
    context: ["NIE", "número de identidad de extranjero", "foreigner", "residency", "Spanish residence"],
  });

  // Cyprus — TIC
  recognizers.push({
    entityType: "CY_TIC",
    patterns: [
      { name: "cy_tic", regex: /\b\d{8}[A-Z]\b/g, score: 0.5 },
    ],
    context: ["TIC", "tax identification", "Cyprus tax", "φορολογικός", "αριθμός φορολογικού", "ΤΙΜ"],
  });

  // Cyprus — ID Card
  recognizers.push({
    entityType: "CY_ID_CARD",
    patterns: [
      { name: "cy_id", regex: /\b\d{6,8}\b/g, score: 0.05 },
    ],
    context: ["Cyprus ID", "identity card", "ARC number", "ταυτότητα", "αριθμός ταυτότητας", "Cypriot ID"],
  });

  // EU VAT Numbers — 29 country patterns
  recognizers.push({
    entityType: "EU_VAT",
    patterns: [
      { name: "vat_at", regex: /\bATU\d{8}\b/g, score: 0.8 },
      { name: "vat_be", regex: /\bBE[01]\d{9}\b/g, score: 0.8 },
      { name: "vat_bg", regex: /\bBG\d{9,10}\b/g, score: 0.8 },
      { name: "vat_cy", regex: /\bCY\d{8}[A-Z]\b/g, score: 0.8 },
      { name: "vat_cz", regex: /\bCZ\d{8,10}\b/g, score: 0.8 },
      { name: "vat_de", regex: /\bDE\d{9}\b/g, score: 0.8 },
      { name: "vat_dk", regex: /\bDK\d{8}\b/g, score: 0.8 },
      { name: "vat_ee", regex: /\bEE\d{9}\b/g, score: 0.8 },
      { name: "vat_es", regex: /\bES[A-Z0-9]\d{7}[A-Z0-9]\b/g, score: 0.8 },
      { name: "vat_fi", regex: /\bFI\d{8}\b/g, score: 0.8 },
      { name: "vat_fr", regex: /\bFR[A-Z0-9]{2}\d{9}\b/g, score: 0.8 },
      { name: "vat_el", regex: /\bEL\d{9}\b/g, score: 0.8 },
      { name: "vat_hr", regex: /\bHR\d{11}\b/g, score: 0.8 },
      { name: "vat_hu", regex: /\bHU\d{8}\b/g, score: 0.8 },
      { name: "vat_ie", regex: /\bIE\d[A-Z0-9+*]\d{5}[A-Z]\b/g, score: 0.8 },
      { name: "vat_it", regex: /\bIT\d{11}\b/g, score: 0.8 },
      { name: "vat_lt", regex: /\bLT\d{9,12}\b/g, score: 0.8 },
      { name: "vat_lu", regex: /\bLU\d{8}\b/g, score: 0.8 },
      { name: "vat_lv", regex: /\bLV\d{11}\b/g, score: 0.8 },
      { name: "vat_mt", regex: /\bMT\d{8}\b/g, score: 0.8 },
      { name: "vat_nl", regex: /\bNL\d{9}B\d{2}\b/g, score: 0.8 },
      { name: "vat_pl", regex: /\bPL\d{10}\b/g, score: 0.8 },
      { name: "vat_pt", regex: /\bPT\d{9}\b/g, score: 0.8 },
      { name: "vat_ro", regex: /\bRO\d{2,10}\b/g, score: 0.7 },
      { name: "vat_se", regex: /\bSE\d{12}\b/g, score: 0.8 },
      { name: "vat_si", regex: /\bSI\d{8}\b/g, score: 0.8 },
      { name: "vat_sk", regex: /\bSK\d{10}\b/g, score: 0.8 },
      { name: "vat_gb", regex: /\bGB\d{9}\b/g, score: 0.7 },
      { name: "vat_ch", regex: /\bCHE\d{9}\b/g, score: 0.8 },
    ],
    context: ["VAT", "TVA", "Mehrwertsteuer", "MwSt", "IVA", "BTW", "tax number", "VAT number", "VAT ID", "registration"],
  });

  // EU Passport — generic
  recognizers.push({
    entityType: "EU_PASSPORT",
    patterns: [
      { name: "eu_passport_2l7d", regex: /\b[A-Z]{2}\d{7}\b/g, score: 0.3 },
      { name: "eu_passport_1l8d", regex: /\b[A-Z]\d{8}\b/g, score: 0.3 },
      { name: "eu_passport_9d", regex: /\b\d{9}\b/g, score: 0.1 },
    ],
    context: ["passport", "travel document", "passeport", "Reisepass", "pasaporte", "passaporto", "EU passport", "European passport"],
  });

  return recognizers;
}

// Singleton — built once
const ALL_RECOGNIZERS = buildRecognizers();

/**
 * Check if any context word appears near the match position.
 * Returns boosted score if context found, original score otherwise.
 */
function applyContextBoost(
  text: string,
  matchStart: number,
  matchEnd: number,
  contextWords: string[],
  baseScore: number,
): number {
  if (contextWords.length === 0) return baseScore;

  const windowStart = Math.max(0, matchStart - CONTEXT_WINDOW);
  const windowEnd = Math.min(text.length, matchEnd + CONTEXT_WINDOW);
  const window = text.slice(windowStart, windowEnd).toLowerCase();

  for (const cw of contextWords) {
    if (window.includes(cw.toLowerCase())) {
      return Math.min(1.0, baseScore + CONTEXT_BOOST);
    }
  }
  return baseScore;
}

/**
 * Run all pattern-based recognizers on the given text.
 * Returns a list of detected entities with positions and scores.
 */
export function runPatternRecognizers(text: string): DetectedEntity[] {
  const results: DetectedEntity[] = [];

  for (const rec of ALL_RECOGNIZERS) {
    for (const pat of rec.patterns) {
      // Reset regex state (global flag)
      pat.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pat.regex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const score = applyContextBoost(text, start, end, rec.context, pat.score);

        results.push({
          text: match[0],
          type: rec.entityType,
          start,
          end,
          score,
          verified: true,
          reason: `pattern:${pat.name}`,
        });
      }
    }
  }

  return results;
}
