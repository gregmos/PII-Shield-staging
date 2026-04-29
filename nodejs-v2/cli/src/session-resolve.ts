/**
 * Resolve a session id from a user-supplied prefix (git-style).
 *
 * Lookup behavior:
 *   1. If the input matches an existing `<input>.json` exactly, return it
 *      verbatim — fast-path, also lets the user paste a full session id.
 *   2. Otherwise treat the input as a prefix and scan
 *      `<MAPPINGS_DIR>/<prefix>*.json` (excluding `review_*.json` files).
 *      - 0 matches → throw with hint to run `pii-shield sessions list`.
 *      - 1 match → return its full session id.
 *      - >1 matches → throw with the candidate list so the user can disambiguate.
 *
 * Used by review/deanonymize/sessions show/sessions export and by
 * anonymize when extending an existing session via `--session`.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../src/utils/config.js";
import { isSafeSessionId } from "../../src/mapping/mapping-store.js";

export class SessionLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLookupError";
  }
}

// Lightweight prefix-scan filter: lets the user paste *some* unsafe input
// (e.g. accidental wildcard) and still get an actionable error from the
// prefix path, without reaching the filesystem with a path-traversal-y
// string. The full whitelist lives in mapping-store.ts; this is the
// session-resolve-side guard.
const SESSION_PREFIX_RE = /^[A-Za-z0-9_-]{1,128}$/;

function listSessionFiles(): string[] {
  const dir = PATHS.MAPPINGS_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("review_"))
    .filter((f) => isSafeSessionId(f.replace(/\.json$/, "")));
}

/**
 * Resolve a session prefix to a full session id. Throws SessionLookupError
 * with an actionable message on miss / ambiguity.
 *
 * Input is restricted to `[A-Za-z0-9_-]{1,128}` — anything with `..`, `/`,
 * `\`, or path-shape characters fails fast with a clear error rather than
 * letting `path.join(MAPPINGS_DIR, "${input}.json")` traverse out.
 */
export function resolveSessionId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new SessionLookupError("session id is empty");
  }
  if (!SESSION_PREFIX_RE.test(trimmed)) {
    throw new SessionLookupError(
      `Invalid session id ${JSON.stringify(trimmed)}: only letters, digits, '-' and '_' are allowed.`,
    );
  }

  // 1. Exact match wins.
  const exactPath = path.join(PATHS.MAPPINGS_DIR, `${trimmed}.json`);
  if (fs.existsSync(exactPath)) {
    return trimmed;
  }

  // 2. Prefix scan.
  const all = listSessionFiles();
  const matches = all
    .filter((f) => f.startsWith(trimmed))
    .map((f) => f.replace(/\.json$/, ""));

  if (matches.length === 0) {
    throw new SessionLookupError(
      `session not found for '${trimmed}'.\n` +
        `Hint: run \`pii-shield sessions list\` to see available sessions.`,
    );
  }
  if (matches.length === 1) {
    return matches[0]!;
  }
  throw new SessionLookupError(
    `Ambiguous prefix '${trimmed}' matches ${matches.length} sessions:\n` +
      matches.map((m) => `  ${m}`).join("\n") +
      `\nProvide a longer prefix to disambiguate.`,
  );
}
