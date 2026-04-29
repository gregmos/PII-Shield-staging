/**
 * PII Shield v2.0.2 — Audit logging
 * Ported from pii_shield_server.py lines 268-341
 *
 * Two log files in PATHS.AUDIT_DIR (= ${CLAUDE_PLUGIN_DATA}/audit or legacy
 * ~/.pii_shield/audit for non-plugin launches):
 * - ner_debug.log: entity detection diagnostics
 * - mcp_audit.log: every tool call/response (proves no PII leaves the machine)
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, VERSION } from "../utils/config.js";

let _initialized = false;
let _nerLogPath: string;
let _auditLogPath: string;
let _serverLogPath: string;

/**
 * Whether to mirror server logs to stderr in addition to disk. Default true
 * preserves Cowork / Claude Desktop terminal visibility (host captures
 * stderr). The CLI sets `PII_AUDIT_STDERR=false` early in `bin.ts` so
 * `pii-shield --version`, `--help`, etc. stay clean. `--debug` flips it back.
 */
function stderrEchoEnabled(): boolean {
  return process.env.PII_AUDIT_STDERR !== "false";
}

function ensureInit(): void {
  if (_initialized) return;
  const auditDir = PATHS.AUDIT_DIR;
  try {
    fs.mkdirSync(auditDir, { recursive: true });
  } catch {
    // best effort
  }
  _nerLogPath = path.join(auditDir, "ner_debug.log");
  _auditLogPath = path.join(auditDir, "mcp_audit.log");
  _serverLogPath = path.join(auditDir, "server.log");
  _initialized = true;

  appendLine(_nerLogPath, `===== PII Shield v${VERSION} (Node.js) session started =====`);
  appendLine(_serverLogPath, `===== PII Shield v${VERSION} server started (pid=${process.pid}) =====`);
  if (stderrEchoEnabled()) {
    console.error(`[Audit] NER log: ${_nerLogPath}`);
    console.error(`[Audit] MCP audit log: ${_auditLogPath}`);
    console.error(`[Audit] Server log: ${_serverLogPath}`);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function appendLine(logPath: string, message: string): void {
  try {
    fs.appendFileSync(logPath, `${timestamp()} ${message}\n`, "utf-8");
  } catch {
    // best effort — don't crash on log failure
  }
}

/** Log NER detection detail (ner_debug.log) */
export function logNer(message: string): void {
  ensureInit();
  appendLine(_nerLogPath, message);
}

/**
 * PII redaction for the audit log. The audit file is the proof-of-no-leak
 * artefact, so it MUST NOT contain real PII or secrets even if a tool
 * handler returns them in its response payload.
 *
 * Strategy: walk the JSON, scrub fields whose contents are known-sensitive,
 * and special-case `entities[]` to keep type/offset/score (useful for
 * forensics) while dropping the entity text itself.
 *
 * Applied at the audit layer rather than at every callsite — handlers stay
 * readable, redaction stays consistent across CLI and MCP.
 */
const PII_FIELDS: ReadonlySet<string> = new Set([
  "text",                  // anonymize_text input text
  "mapping",               // placeholder → real PII (the secret)
  // Anonymized output text variants. anonymizeDocx returns `anonymized_text`,
  // engine.anonymizeText returns `anonymized`. Both can carry residual PII
  // when NER misses an entity, so neither is safe to log raw.
  "anonymized",
  "anonymized_text",
  "original_text",
  "html_text",
  // Deanonymized output — by definition contains real PII.
  "deanonymized_text",
  "restored",
  "restored_text",
  "output_text",
  // Secrets passed through tool args.
  "passphrase",            // session export / import
  "review_secret",
]);

function redactScalar(value: unknown): unknown {
  if (typeof value === "string") {
    return `[${value.length} chars redacted]`;
  }
  if (Array.isArray(value)) {
    return `[${value.length} items redacted]`;
  }
  if (value && typeof value === "object") {
    return `[${Object.keys(value).length} keys redacted]`;
  }
  return "[redacted]";
}

function redactPii(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactPii);
  if (typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII_FIELDS.has(k)) {
      out[k] = redactScalar(v);
      continue;
    }
    if (k === "entities" && Array.isArray(v)) {
      // Entities carry detected text — strip it but keep counts/offsets/types.
      out[k] = v.map((e: unknown) => {
        if (e && typeof e === "object") {
          const r = e as Record<string, unknown>;
          return {
            type: r.type,
            start: r.start,
            end: r.end,
            score: r.score,
            placeholder: r.placeholder,
          };
        }
        return e;
      });
      continue;
    }
    if (k === "overrides" && v && typeof v === "object") {
      const ov = v as { remove?: unknown; add?: unknown };
      out[k] = {
        remove_count: Array.isArray(ov.remove) ? ov.remove.length : 0,
        add_count: Array.isArray(ov.add) ? ov.add.length : 0,
      };
      continue;
    }
    out[k] = redactPii(v);
  }
  return out;
}

const MAX_LOGGED_CHARS = 1500;

function clipForLog(s: string): string {
  return s.length > MAX_LOGGED_CHARS
    ? s.slice(0, MAX_LOGGED_CHARS) + `... [${s.length} chars total]`
    : s;
}

/** Log MCP tool call (mcp_audit.log). Redacts PII in args. */
export function logToolCall(toolName: string, args: Record<string, unknown>): void {
  ensureInit();
  const redacted = redactPii(args) as Record<string, unknown>;
  appendLine(_auditLogPath, `>>> CALL ${toolName}(${clipForLog(JSON.stringify(redacted))})`);
}

/** Log MCP tool response (mcp_audit.log). Redacts PII in JSON responses. */
export function logToolResponse(toolName: string, response: string): void {
  ensureInit();
  let logged: string;
  // Most handlers return a JSON string. Parse + redact + restringify.
  try {
    const parsed = JSON.parse(response);
    logged = clipForLog(JSON.stringify(redactPii(parsed)));
  } catch {
    // Non-JSON: don't log raw bytes — they could contain PII (e.g. stray text).
    logged = `[non-json response, ${response.length} chars]`;
  }
  appendLine(_auditLogPath, `<<< RESP ${toolName} -> ${logged}`);
}

/** Log MCP tool error (mcp_audit.log) */
export function logToolError(toolName: string, error: Error): void {
  ensureInit();
  appendLine(_auditLogPath, `<<< ERR  ${toolName} -> ${error.constructor.name}: ${error.message}`);
}

/** General-purpose server log (server.log) — HTTP, PDF, review, lifecycle events */
export function logServer(message: string): void {
  ensureInit();
  appendLine(_serverLogPath, message);
  // Also write to stderr for Cowork terminal visibility, gated by env
  // (CLI runs with PII_AUDIT_STDERR=false to keep stderr clean by default).
  if (stderrEchoEnabled()) {
    try { console.error(message); } catch {}
  }
}
