/**
 * PII Shield Proxy — Python Lifecycle Manager
 * Discovers Python, spawns pii_shield_server.py --mode=subprocess, routes JSON-RPC.
 */

import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import which from "which";
import { PYTHON_CONFIG } from "./config.js";
import { ensurePythonRuntime } from "./bootstrap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.resolve(__dirname, "..", "server", "pii_shield_server.py");

/**
 * Find a suitable Python (>= 3.10) on this system.
 * @param {string} [userPath] - Explicit python path from user config
 * @returns {Promise<string>} Resolved python executable path
 */
export async function findPython(userPath) {
  const candidates = [];

  if (userPath) {
    candidates.push(userPath);
  }

  if (process.platform === "win32") {
    candidates.push("python", "python3", "py");
  } else {
    candidates.push("python3", "python");
  }

  const checked = [];

  for (const candidate of candidates) {
    try {
      let resolved;
      if (candidate === "py") {
        // Windows Python Launcher — resolve via direct exec, not which
        resolved = "py";
      } else {
        resolved = await which(candidate);
      }

      const version = await getPythonVersion(resolved);
      if (version) {
        const [major, minor] = version.split(".").map(Number);
        if (major === 3 && minor >= 10) {
          return resolved;
        }
        checked.push({ path: resolved, version, reason: "version < 3.10" });
      }
    } catch {
      checked.push({ path: candidate, version: null, reason: "not found" });
    }
  }

  const diagnostics = {
    error: "python_not_found",
    platform: process.platform,
    arch: process.arch,
    checked,
    suggestion: process.platform === "win32"
      ? "Install Python 3.10+ from https://www.python.org/downloads/ and ensure it is in PATH."
      : process.platform === "darwin"
        ? "Run: brew install python@3.12"
        : "Run: sudo apt install python3",
  };
  throw Object.assign(new Error("Python not found"), { diagnostics });
}

/**
 * Get Python version string, e.g. "3.12.1"
 */
function getPythonVersion(pythonPath) {
  return new Promise((resolve) => {
    const args = pythonPath === "py" ? ["-3", "--version"] : ["--version"];
    execFile(pythonPath, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const out = (stdout || stderr || "").trim();
      const match = out.match(/Python (\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : null);
    });
  });
}

// --- PythonBackend class ---

const State = { IDLE: "idle", STARTING: "starting", READY: "ready", DEAD: "dead" };

export class PythonBackend {
  constructor() {
    this._state = State.IDLE;
    this._proc = null;
    this._startPromise = null;
    this._pendingCalls = new Map();   // id -> { resolve, reject, timer }
    this._nextId = 1;
    this._pythonPath = null;
    this._startupMessage = "PII Shield is starting up...";
    this._startupPhase = "starting";
    this._startupPct = 0;
  }

  get state() { return this._state; }
  get startupMessage() { return this._startupMessage; }

  /**
   * Ensure the Python backend is running. Idempotent.
   * Resolves when ready, rejects on fatal error.
   */
  async ensureRunning(userPythonPath) {
    if (this._state === State.READY) return;
    if (this._state === State.STARTING) return this._startPromise;
    if (this._state === State.DEAD) {
      // Allow one restart attempt
      this._state = State.IDLE;
    }

    this._state = State.STARTING;
    this._startPromise = this._spawn(userPythonPath);
    return this._startPromise;
  }

  async _spawn(userPythonPath) {
    try {
      if (!this._pythonPath) {
        // Bootstrap a self-contained venv with all PII Shield deps installed.
        // Reports phase=bootstrap_runtime / pct 0-90 while it works.
        this._startupPhase = "bootstrap_runtime";
        this._startupMessage = "Preparing PII Shield runtime…";
        this._startupPct = 1;
        const runtime = await ensurePythonRuntime({
          userPythonPath,
          onProgress: ({ phase, message, pct }) => {
            this._startupPhase = phase || this._startupPhase;
            this._startupMessage = message || this._startupMessage;
            this._startupPct = pct ?? this._startupPct;
            console.error(`[PII Shield] ${this._startupPhase} [${this._startupPct}%] ${this._startupMessage}`);
          },
        });
        this._pythonPath = runtime.python;
      }

      const args = this._pythonPath === "py"
        ? ["-3", SERVER_SCRIPT, PYTHON_CONFIG.SUBPROCESS_FLAG]
        : [SERVER_SCRIPT, PYTHON_CONFIG.SUBPROCESS_FLAG];

      // Pass through relevant env vars
      const env = { ...process.env };

      this._proc = spawn(this._pythonPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env,
      });

      // Pipe stderr to our stderr for debugging
      this._proc.stderr.pipe(process.stderr);

      // Read stdout line by line
      const rl = createInterface({ input: this._proc.stdout });

      return new Promise((resolveStartup, rejectStartup) => {
        let startupDone = false;

        const startupTimer = setTimeout(() => {
          if (!startupDone) {
            startupDone = true;
            this._state = State.DEAD;
            rejectStartup(new Error("Python startup timeout"));
            this.shutdown();
          }
        }, PYTHON_CONFIG.STARTUP_TIMEOUT_MS);

        rl.on("line", (line) => {
          if (!line.trim()) return;

          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            return; // skip non-JSON lines
          }

          // Ready signal
          if (!startupDone && parsed.status === "ready") {
            startupDone = true;
            clearTimeout(startupTimer);
            this._state = State.READY;
            resolveStartup();
            return;
          }

          // Startup progress messages (before ready)
          if (!startupDone && (parsed.status === "progress" || parsed.status)) {
            this._startupMessage = parsed.message || this._startupMessage;
            this._startupPhase = parsed.phase || this._startupPhase;
            this._startupPct = parsed.pct ?? this._startupPct;
            console.error(`[PII Shield] Progress: [${this._startupPct}%] ${this._startupMessage}`);
            return;
          }

          // JSON-RPC response
          if (parsed.id != null && this._pendingCalls.has(parsed.id)) {
            const pending = this._pendingCalls.get(parsed.id);
            this._pendingCalls.delete(parsed.id);
            clearTimeout(pending.timer);

            if (parsed.error) {
              pending.reject(new Error(parsed.error.message || "Python error"));
            } else {
              pending.resolve(parsed.result);
            }
          }
        });

        this._proc.on("exit", (code, signal) => {
          this._state = State.DEAD;
          if (!startupDone) {
            startupDone = true;
            clearTimeout(startupTimer);
            rejectStartup(new Error(`Python exited during startup (code=${code}, signal=${signal})`));
          }
          // Reject all pending calls
          for (const [id, pending] of this._pendingCalls) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Python process exited"));
          }
          this._pendingCalls.clear();
        });

        this._proc.on("error", (err) => {
          this._state = State.DEAD;
          if (!startupDone) {
            startupDone = true;
            clearTimeout(startupTimer);
            rejectStartup(err);
          }
        });
      });
    } catch (err) {
      this._state = State.DEAD;
      throw err;
    }
  }

  /**
   * Send a JSON-RPC call to the Python backend.
   * @param {string} method - Tool name
   * @param {object} params - Tool parameters
   * @returns {Promise<string>} The tool result (JSON string from Python)
   */
  call(method, params) {
    if (this._state !== State.READY) {
      return Promise.reject(new Error("Python backend is not ready"));
    }

    const id = this._nextId++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCalls.delete(id);
        reject(new Error(`Timeout calling ${method} (${PYTHON_CONFIG.CALL_TIMEOUT_MS}ms)`));
      }, PYTHON_CONFIG.CALL_TIMEOUT_MS);

      this._pendingCalls.set(id, { resolve, reject, timer });

      try {
        this._proc.stdin.write(request);
      } catch (err) {
        this._pendingCalls.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Gracefully shut down the Python process.
   */
  shutdown() {
    if (!this._proc) return;
    try {
      this._proc.stdin.end();
      if (process.platform === "win32") {
        this._proc.kill();
      } else {
        this._proc.kill("SIGTERM");
        setTimeout(() => {
          try { this._proc?.kill("SIGKILL"); } catch { /* already dead */ }
        }, 5000);
      }
    } catch { /* ignore */ }
    this._proc = null;
  }
}
