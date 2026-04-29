/**
 * PII Shield CLI — shared runtime initialization.
 *
 * Every command calls initRuntime() once at startup. Idempotent.
 * Initializes the singleton PIIEngine, kicks off NER background load,
 * and writes a server-start audit line. Mirrors the MCP server's startup
 * sequence in src/index.ts but without stdio transport.
 */

import { PIIEngine } from "../../src/engine/pii-engine.js";
import {
  isNerReady,
  getNerStatus,
  forceReinitNer,
} from "../../src/engine/ner-backend.js";
import {
  logServer,
  logToolCall,
  logToolResponse,
  logToolError,
} from "../../src/audit/audit-logger.js";
import { PATHS, VERSION, getDataDirSource } from "../../src/utils/config.js";

let _initialized = false;
let _engine: PIIEngine | null = null;

export interface RuntimeOptions {
  /** Skip starting NER background load (e.g. for `doctor --quick`). */
  skipNer?: boolean;
  /** Stream init diagnostics to stderr. */
  verbose?: boolean;
}

/**
 * Initialize the engine + audit logger. Idempotent — second call returns
 * the same engine instance without re-running side effects.
 */
export function initRuntime(opts: RuntimeOptions = {}): PIIEngine {
  if (_initialized) return _engine!;

  // Force PATHS.DATA_DIR to resolve early so audit dir is created before any
  // logServer call. The getter has the side effect of mkdir-p.
  const dataDir = PATHS.DATA_DIR;
  const mappingsDir = PATHS.MAPPINGS_DIR;

  logServer(`=== PII Shield CLI v${VERSION} session start ===`);
  logServer(`data_dir=${dataDir} (source: ${getDataDirSource()})`);
  logServer(`mappings_dir=${mappingsDir}`);

  if (opts.verbose) {
    process.stderr.write(`[pii-shield] data dir: ${dataDir}\n`);
    process.stderr.write(`[pii-shield] mappings: ${mappingsDir}\n`);
  }

  _engine = PIIEngine.getInstance();

  if (!opts.skipNer) {
    _engine.startNerBackground();
  }

  _initialized = true;
  return _engine;
}

export function getEngine(): PIIEngine {
  if (!_engine) {
    throw new Error("Runtime not initialized — call initRuntime() first");
  }
  return _engine;
}

/**
 * Block until the NER model is ready or until `maxWaitMs` elapses.
 * Returns true if ready, false on timeout. On timeout the caller may proceed
 * with patterns-only detection (the engine handles that gracefully).
 */
export async function waitForNer(
  maxWaitMs: number,
  onProgress?: (status: ReturnType<typeof getNerStatus>) => void,
): Promise<boolean> {
  if (isNerReady()) return true;
  const start = Date.now();
  let lastPhase = "";
  while (Date.now() - start < maxWaitMs) {
    const status = getNerStatus();
    if (onProgress && status.phase !== lastPhase) {
      onProgress(status);
      lastPhase = status.phase;
    }
    if (isNerReady()) return true;
    if (status.phase === "error" || status.phase === "needs_setup") return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Wrap a command body in the same audit pattern that wrapPlainTool() uses
 * for MCP handlers. Errors are re-thrown after logging so the CLI exits
 * non-zero with the original message.
 */
export async function withAudit<T>(
  toolName: string,
  args: Record<string, unknown>,
  body: () => Promise<T>,
): Promise<T> {
  logToolCall(toolName, args);
  try {
    const result = await body();
    const summary =
      typeof result === "string" ? result : JSON.stringify(result);
    logToolResponse(toolName, summary);
    return result;
  } catch (e) {
    logToolError(toolName, e as Error);
    throw e;
  }
}

export { isNerReady, getNerStatus, forceReinitNer };
