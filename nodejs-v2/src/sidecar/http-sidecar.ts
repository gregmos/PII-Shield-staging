/**
 * PII Shield v2.0.0 — In-memory tool registry
 *
 * Previously this file hosted an HTTP bootstrap sidecar bound to 127.0.0.1:6789
 * to give the skill a bash-curl fallback if MCP stdio tool discovery failed.
 * That sidecar was legacy from v1 (when the plugin ran inside a Cowork VM and
 * needed a host→VM escape hatch). In the current split deployment — MCP stdio
 * server on host + skill in VM — MCP stdio is the reliable wire, and the
 * sidecar added cost without value:
 *   - Claude Desktop occasionally spawns two server processes on the same
 *     host; both tried to bind 6789, the second walked the auto-scan to 6790,
 *     and the sidecar did nothing useful while both processes raced on the
 *     model cache.
 *   - The `sidecar` field in response envelopes was informational only; no
 *     tool logic relied on it.
 *   - HTTP routing code is ~200 lines we don't need for any current flow.
 *
 * What remains here: a pure in-memory registry of tool handlers keyed by
 * short name, so that `--cli` / `--cli-list` CLI modes can invoke tool logic
 * directly via `getSidecarHandler(name)` without the MCP stdio round-trip.
 * The registry is populated by `registerSidecarTool(name, handler)` calls in
 * `src/index.ts`'s tool definitions, and consumed by the CLI modes in the
 * same file.
 *
 * The file name / function names are kept as-is ("sidecar") to minimise churn
 * on the ~dozen call sites that use them. Semantics are now local-only.
 */

/** Handler returning a JSON-string body, matching the stdio plain-tool shape. */
export type SidecarToolHandler = (args: Record<string, unknown>) => Promise<string>;

const _registry: Map<string, SidecarToolHandler> = new Map();

/** Register a handler by short name — mirrors `server.registerTool`. */
export function registerSidecarTool(name: string, handler: SidecarToolHandler): void {
  _registry.set(name, handler);
}

/**
 * Look up a registered handler by short name. Used by the CLI mode
 * (`node server.bundle.mjs --cli <name> <json>`) as the ultimate bypass when
 * MCP stdio discovery fails — bash always works.
 */
export function getSidecarHandler(name: string): SidecarToolHandler | undefined {
  return _registry.get(name);
}

/** List all registered tool names (for CLI help / error messages). */
export function listSidecarTools(): string[] {
  return [..._registry.keys()].sort();
}
