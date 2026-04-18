/**
 * PII Shield v2.0.0 — Bootstrap beacon
 *
 * Writes a single JSON file at `$DATA_DIR/server_status.json` that captures
 * everything a troubleshooter or the skill needs to know about this server
 * instance — PID, started-at timestamp, NER phase, registered tool list,
 * data-dir resolution source, Node platform/arch. The file is refreshed on
 * every phase change / tool call and every ~30 seconds as a heartbeat.
 *
 * **Why this exists**: when MCP tool discovery fails (observed in some
 * Cowork VM sessions / first-run bootstrap windows) there is no host-visible
 * signal left to confirm whether the server process is alive. The beacon is
 * a dead-simple `cat /root/.pii_shield/server_status.json` away. Works
 * without a network bind, without ToolSearch matching, without host-side
 * tool propagation. The skill's Step 0 reads this file first.
 *
 * **Atomicity**: each write is `writeFileSync(tmp) → renameSync(tmp, real)`
 * so a reader never sees a half-written JSON. Best-effort on failure —
 * beacon writes never crash the server.
 */

import fs from "node:fs";
import path from "node:path";
import { VERSION, PATHS, getDataDirSource } from "../utils/config.js";
import { logServer } from "../audit/audit-logger.js";

export interface BeaconState {
  service: "pii-shield";
  version: string;
  pid: number;
  started_at: string;
  last_updated_at: string;
  last_tool_call_at: string | null;
  last_tool_call_name: string | null;
  data_dir: string;
  data_dir_source: string;
  ner: {
    phase: string;
    progress_pct: number;
    ready: boolean;
    error: string | null;
  };
  tools: string[];
  node: {
    version: string;
    platform: string;
    arch: string;
  };
}

const _state: BeaconState = {
  service: "pii-shield",
  version: VERSION,
  pid: process.pid,
  started_at: new Date().toISOString(),
  last_updated_at: new Date().toISOString(),
  last_tool_call_at: null,
  last_tool_call_name: null,
  data_dir: "",
  data_dir_source: "",
  ner: { phase: "idle", progress_pct: 0, ready: false, error: null },
  tools: [],
  node: {
    version: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  },
};

let _heartbeatTimer: NodeJS.Timeout | null = null;
let _beaconPath: string | null = null;

function getBeaconPath(): string {
  if (_beaconPath) return _beaconPath;
  _beaconPath = path.join(PATHS.DATA_DIR, "server_status.json");
  return _beaconPath;
}

/**
 * Return all paths the beacon should be written to. `getBeaconPath()` stays
 * the "canonical" location (under `$DATA_DIR`) for back-compat, but we ALSO
 * write to `/tmp` + the plugin-root sibling so bash-tool readers — which
 * run in a different process env than the MCP server (no
 * `$CLAUDE_PLUGIN_DATA`) — can find at least one copy without guessing.
 *
 * `/tmp/pii-shield-beacon.json` is always-writeable on *nix and predictable:
 * the skill's Step 0 always checks there first. On Windows it falls back to
 * `%TEMP%/pii-shield-beacon.json`.
 */
function getAllBeaconPaths(): string[] {
  const out = new Set<string>();
  try { out.add(getBeaconPath()); } catch { /* DATA_DIR resolution may fail */ }

  // /tmp (Linux/macOS) or %TEMP% (Windows).
  const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
  out.add(path.join(tmpDir, "pii-shield-beacon.json"));

  // Plugin-root-sibling: when Cowork / Claude Desktop launch us, the server
  // binary lives at `<plugin_root>/server.bundle.mjs`. Writing next to it
  // gives bash a findable path via `find .../plugin_*/ -name
  // server_status.json`. Use our own module's __filename as the anchor.
  try {
    const rootEnv = process.env.CLAUDE_PLUGIN_ROOT;
    if (rootEnv && rootEnv.length > 0) {
      out.add(path.join(rootEnv, "server_status.json"));
    }
  } catch { /* ignore */ }

  return [...out];
}

function writeBeaconAtomic(): void {
  const payload = JSON.stringify(_state, null, 2);
  for (const dest of getAllBeaconPaths()) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, payload, "utf-8");
      fs.renameSync(tmp, dest);
    } catch (e) {
      // Best-effort per-location — keep trying the rest. A full disk or
      // perms issue on one mount mustn't abort the others.
      logServer(`[Beacon] write ${dest} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Expose current state (read-only snapshot) for debugging endpoints. */
export function getBeaconState(): Readonly<BeaconState> {
  return _state;
}

/** Expose the resolved path for external diagnostics / smoke tests. */
export function getBeaconFilePath(): string {
  return getBeaconPath();
}

/**
 * Start the beacon: write the file once synchronously, then heartbeat every
 * 30 seconds. Idempotent — calling it twice is a no-op.
 */
export function startBeacon(): void {
  if (_heartbeatTimer) return;
  _state.data_dir = PATHS.DATA_DIR;
  _state.data_dir_source = getDataDirSource();
  _state.last_updated_at = new Date().toISOString();
  writeBeaconAtomic();
  _heartbeatTimer = setInterval(() => {
    _state.last_updated_at = new Date().toISOString();
    writeBeaconAtomic();
  }, 30_000);
  // Let the process exit cleanly even if the interval is still pending
  // (stdio disconnect, SIGTERM from host).
  if (_heartbeatTimer && typeof _heartbeatTimer.unref === "function") {
    _heartbeatTimer.unref();
  }
  logServer(`[Beacon] started → ${getBeaconPath()}`);
}

/** Stop the beacon heartbeat (tests + graceful shutdown). */
export function stopBeacon(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

/** Call at the top of every tool handler invocation to record the name + time. */
export function touchBeaconToolCall(name: string): void {
  const now = new Date().toISOString();
  _state.last_tool_call_at = now;
  _state.last_tool_call_name = name;
  _state.last_updated_at = now;
  writeBeaconAtomic();
}

/** Merge a partial NER state update into the beacon and persist. */
export function updateBeaconNer(partial: Partial<BeaconState["ner"]>): void {
  Object.assign(_state.ner, partial);
  _state.last_updated_at = new Date().toISOString();
  writeBeaconAtomic();
}

/** Replace the registered-tool list wholesale (called once at startup). */
export function setBeaconTools(tools: readonly string[]): void {
  _state.tools = [...tools].sort();
  _state.last_updated_at = new Date().toISOString();
  writeBeaconAtomic();
}
