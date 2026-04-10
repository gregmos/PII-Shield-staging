/**
 * PII Shield v2.0.0 — Audit logging
 * Ported from pii_shield_server.py lines 268-341
 *
 * Two log files in PATHS.AUDIT_DIR (= ${CLAUDE_PLUGIN_DATA}/audit or legacy
 * ~/.pii_shield/audit for non-plugin launches):
 * - ner_debug.log: entity detection diagnostics
 * - mcp_audit.log: every tool call/response (proves no PII leaves the machine)
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../utils/config.js";

let _initialized = false;
let _nerLogPath: string;
let _auditLogPath: string;
let _serverLogPath: string;

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

  appendLine(_nerLogPath, "===== PII Shield v2.0.0 (Node.js) session started =====");
  appendLine(_serverLogPath, "===== PII Shield v2.0.0 server started (pid=" + process.pid + ") =====");
  console.error(`[Audit] NER log: ${_nerLogPath}`);
  console.error(`[Audit] MCP audit log: ${_auditLogPath}`);
  console.error(`[Audit] Server log: ${_serverLogPath}`);
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

/** Log MCP tool call (mcp_audit.log) */
export function logToolCall(toolName: string, args: Record<string, unknown>): void {
  ensureInit();
  // Truncate long text values
  const safeArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 500) {
      safeArgs[k] = v.slice(0, 200) + `... [${v.length} chars total]`;
    } else {
      safeArgs[k] = v;
    }
  }
  appendLine(_auditLogPath, `>>> CALL ${toolName}(${JSON.stringify(safeArgs)})`);
}

/** Log MCP tool response (mcp_audit.log) */
export function logToolResponse(toolName: string, response: string): void {
  ensureInit();
  const logged = response.length > 1000
    ? response.slice(0, 500) + `... [${response.length} chars total]`
    : response;
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
  // Also write to stderr for Cowork terminal visibility
  try { console.error(message); } catch {}
}
