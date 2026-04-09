#!/usr/bin/env node

/**
 * PII Shield — Node.js MCP Proxy
 * Thin proxy that registers tools instantly and lazily starts the Python backend.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PythonBackend } from "./python-manager.js";
import { TOOLS, HYBRID_TOOLS } from "./config.js";
import { installBundledSkill } from "./install-skill.js";

console.error("[PII Shield Proxy] Starting...");

// Fire-and-forget: copy bundled pii-contract-analyze skill to ~/.claude/skills/
// on startup so Claude Code (standalone, in Desktop, or in Cowork) can discover
// it. Claude Desktop .mcpb extensions are NOT a skill scan location per the
// official docs, so shipping skills inside the .mcpb requires this one-time
// copy. The function is idempotent via a version stamp and never throws.
installBundledSkill().catch(() => {});

const backend = new PythonBackend();
const userPythonPath = process.env.PII_PYTHON_PATH || undefined;

const server = new Server(
  { name: "PII Shield", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

// --- Handle tools/list ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
});

// --- Handle tools/call ---

async function handleToolCall(toolName, args) {
  // Try to start Python if not running
  if (backend.state === "idle" || backend.state === "dead") {
    const isHybrid = HYBRID_TOOLS.has(toolName);

    if (isHybrid) {
      // Start in background, return status immediately
      backend.ensureRunning(userPythonPath).catch(() => {});
      return JSON.stringify({
        status: backend.state === "dead" ? "error" : "loading",
        phase: backend._startupPhase,
        message: backend._startupMessage,
        progress_pct: backend._startupPct,
        retry_after_sec: backend._startupPct > 50 ? 15 : 25,
      }, null, 2);
    }

    // Non-hybrid: try to start, return loading if not ready quickly
    try {
      const startPromise = backend.ensureRunning(userPythonPath);
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("startup_pending")), 5000)
      );
      await Promise.race([startPromise, timeout]);
    } catch (err) {
      if (err.message === "startup_pending") {
        return JSON.stringify({
          status: "loading",
          phase: backend._startupPhase,
          message: backend.startupMessage,
          progress_pct: backend._startupPct,
          retry_after_sec: backend._startupPct > 50 ? 15 : 25,
        }, null, 2);
      }
      // Real error
      const diagnostics = err.diagnostics || { message: err.message };
      return JSON.stringify({
        error: diagnostics.error || "backend_error",
        message: err.message,
        ...diagnostics,
      }, null, 2);
    }
  }

  if (backend.state === "starting") {
    return JSON.stringify({
      status: "loading",
      phase: backend._startupPhase,
      message: backend.startupMessage,
      progress_pct: backend._startupPct,
      retry_after_sec: backend._startupPct > 50 ? 15 : 25,
    }, null, 2);
  }

  // Backend is ready — proxy the call
  try {
    const result = await backend.call(toolName, args || {});
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return text;
  } catch (err) {
    return JSON.stringify({
      error: err.message.includes("Timeout") ? "timeout" : "backend_error",
      message: err.message,
      suggestion: err.message.includes("Timeout")
        ? "The operation took too long. Try with a smaller document or retry."
        : "Python backend encountered an error. Try calling list_entities to check status.",
    }, null, 2);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const text = await handleToolCall(name, args);
  return { content: [{ type: "text", text }] };
});

// --- Graceful shutdown ---

process.on("SIGTERM", () => { backend.shutdown(); process.exit(0); });
process.on("SIGINT", () => { backend.shutdown(); process.exit(0); });

// --- Start (no await, like the official example) ---

const transport = new StdioServerTransport();
server.connect(transport);

console.error("[PII Shield Proxy] Server running, 14 tools registered.");
