/**
 * PII Shield v2.0.0 — Python runtime bootstrap
 *
 * ensurePythonRuntime({ onProgress }) → { python, venvDir, requirementsHash }
 *
 * On first run:
 *   1. Pick a cache dir (escape hatch → CLAUDE_PLUGIN_DATA → workspace → ~/.pii_shield)
 *   2. If sentinel matches current requirements.txt → return cached venv
 *   3. Otherwise: find a system Python ≥3.10, or download python-build-standalone
 *   4. Create venv, pip install -r requirements.txt
 *   5. Verify by importing key packages
 *   6. Write sentinel and return
 *
 * Reports progress through the optional onProgress({ phase, message, pct }) callback.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import which from "which";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROXY_DIR = __dirname;
const REQUIREMENTS_PATH = path.join(PROXY_DIR, "requirements.txt");

// Pinned PBS release. Bump together with python version when needed.
const PBS_RELEASE = "20250115";
const PBS_PYTHON = "3.12.8";

const IS_WIN = process.platform === "win32";
const PY_BIN_DIR = IS_WIN ? "Scripts" : "bin";
const PY_EXE = IS_WIN ? "python.exe" : "python";
const PIP_EXE = IS_WIN ? "pip.exe" : "pip";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Cache directory selection                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".pii_shield_write_probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function isCowork() {
  // Best-effort heuristic — Cowork VM marker, or env var.
  if (process.env.COWORK_VM === "1") return true;
  if (process.env.CLAUDE_COWORK === "1") return true;
  try {
    if (fs.existsSync("/run/.cowork-marker")) return true;
  } catch { /* ignore */ }
  return false;
}

function pickWorkspaceCacheDir() {
  // Prefer the cwd if it looks workspace-y (writable, persistent on Cowork VirtioFS).
  const cwd = process.cwd();
  const target = path.join(cwd, ".pii_shield", "venv");
  return isWritable(path.dirname(target)) ? target : null;
}

export function pickVenvDir() {
  // 1. Explicit override always wins.
  if (process.env.PII_SHIELD_VENV) {
    return process.env.PII_SHIELD_VENV;
  }
  // 2. On Cowork: workspace is persistent (VirtioFS), $HOME (and therefore
  //    ${CLAUDE_PLUGIN_DATA} which lives under ~/.claude/...) is ephemeral.
  //    Prefer workspace so the venv survives session restarts.
  if (isCowork()) {
    const ws = pickWorkspaceCacheDir();
    if (ws) return ws;
  }
  // 3. Off-Cowork (Claude Desktop, plain Claude Code): plugin data dir is persistent.
  if (process.env.CLAUDE_PLUGIN_DATA) {
    const candidate = path.join(process.env.CLAUDE_PLUGIN_DATA, "venv");
    if (isWritable(path.dirname(candidate))) return candidate;
  }
  // 4. Local fallback under HOME.
  return path.join(os.homedir(), ".pii_shield", "venv");
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sentinel — venv freshness check                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function requirementsHash() {
  const text = fs.readFileSync(REQUIREMENTS_PATH, "utf-8");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function venvPython(venvDir) {
  return path.join(venvDir, PY_BIN_DIR, PY_EXE);
}

function venvPip(venvDir) {
  return path.join(venvDir, PY_BIN_DIR, PIP_EXE);
}

function readSentinel(venvDir) {
  try {
    const p = path.join(venvDir, ".pii_shield_ready");
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function writeSentinel(venvDir, hash) {
  const p = path.join(venvDir, ".pii_shield_ready");
  const data = {
    requirements_sha256: hash,
    pbs_release: PBS_RELEASE,
    python_version: PBS_PYTHON,
    created_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
  };
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  System Python discovery (≥3.10)                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function checkPythonVersion(pythonPath) {
  try {
    const r = spawnSync(pythonPath, ["-c", "import sys; print(sys.version_info[0]*100+sys.version_info[1])"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (r.status !== 0) return null;
    const v = parseInt((r.stdout || "").trim(), 10);
    if (isNaN(v)) return null;
    return v;
  } catch {
    return null;
  }
}

function findSystemPython() {
  const candidates = IS_WIN
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const name of candidates) {
    try {
      const found = which.sync(name, { nothrow: true });
      if (!found) continue;
      const v = checkPythonVersion(found);
      if (v && v >= 310) return found;
    } catch { /* ignore */ }
  }
  // On Windows, py launcher form
  if (IS_WIN) {
    try {
      const py = which.sync("py", { nothrow: true });
      if (py) {
        const r = spawnSync(py, ["-3", "-c", "import sys; print(sys.executable)"], {
          encoding: "utf-8",
          timeout: 5000,
        });
        if (r.status === 0) {
          const exe = (r.stdout || "").trim();
          const v = checkPythonVersion(exe);
          if (v && v >= 310) return exe;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  python-build-standalone download                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function pbsTriple() {
  const a = process.arch;
  const p = process.platform;
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`Unsupported platform for python-build-standalone: ${p}/${a}`);
}

function pbsUrl() {
  const triple = pbsTriple();
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PBS_PYTHON}+${PBS_RELEASE}-${triple}-install_only_stripped.tar.gz`;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { "User-Agent": "pii-shield-bootstrap" } }, (res) => {
      // Follow redirects (GitHub releases redirect to S3)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        reject(new Error(`PBS download failed: HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let received = 0;
      let lastReport = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (onProgress && received - lastReport > 512 * 1024) {
          lastReport = received;
          onProgress(received, total);
        }
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(destPath)));
    });
    req.on("error", reject);
  });
}

function extractTarGz(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Windows 10+ ships bsdtar; macOS/Linux have GNU/BSD tar.
  const r = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`tar extract failed: ${r.stderr || r.stdout || "unknown"}`);
  }
}

async function downloadPbsPython(cacheDir, onProgress) {
  const pbsDir = path.join(cacheDir, "pbs");
  const pythonExe = path.join(pbsDir, "python", PY_BIN_DIR, PY_EXE);
  if (fs.existsSync(pythonExe)) return pythonExe;

  fs.mkdirSync(pbsDir, { recursive: true });
  const url = pbsUrl();
  const archivePath = path.join(pbsDir, "pbs.tar.gz");

  onProgress?.({ phase: "bootstrap_runtime", message: "Downloading Python runtime…", pct: 5 });

  await downloadFile(url, archivePath, (received, total) => {
    const mb = (received / (1024 * 1024)).toFixed(0);
    const totalMb = total ? (total / (1024 * 1024)).toFixed(0) : "?";
    const ratio = total ? received / total : 0;
    onProgress?.({
      phase: "bootstrap_runtime",
      message: `Downloading Python runtime (${mb}/${totalMb} MB)…`,
      pct: Math.min(20, 5 + Math.floor(ratio * 15)),
    });
  });

  onProgress?.({ phase: "bootstrap_runtime", message: "Extracting Python runtime…", pct: 22 });
  extractTarGz(archivePath, pbsDir);
  try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

  if (!fs.existsSync(pythonExe)) {
    throw new Error(`PBS extracted but python not found at ${pythonExe}`);
  }
  return pythonExe;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  venv + pip install                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function runStreaming(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrBuf = "";
    const handle = (chunk) => {
      const text = chunk.toString("utf-8");
      stderrBuf += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLine(line);
        }
      }
    };
    proc.stdout.on("data", handle);
    proc.stderr.on("data", handle);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}\n${stderrBuf.slice(-2000)}`));
    });
  });
}

async function createVenv(pythonPath, venvDir, onProgress) {
  // Idempotent: if a working venv python already exists, reuse it.
  // This is critical — on retry/reentry we must NOT wipe a venv that's
  // partially populated by a prior pip-install run, otherwise we lose
  // 5+ minutes of download work on every transient failure.
  if (fs.existsSync(venvPython(venvDir))) {
    onProgress?.({ phase: "bootstrap_runtime", message: "Reusing existing virtualenv", pct: 30 });
    return;
  }
  onProgress?.({ phase: "bootstrap_runtime", message: "Creating Python virtual environment…", pct: 28 });
  // Only wipe if there's a stale partial directory blocking us (no python in it).
  try { fs.rmSync(venvDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(path.dirname(venvDir), { recursive: true });
  await runStreaming(pythonPath, ["-m", "venv", venvDir]);
  if (!fs.existsSync(venvPython(venvDir))) {
    throw new Error(`venv creation succeeded but ${venvPython(venvDir)} missing`);
  }
}

async function pipInstall(venvDir, onProgress) {
  const py = venvPython(venvDir);
  // Upgrade pip first (silent unless it fails)
  onProgress?.({ phase: "bootstrap_runtime", message: "Upgrading pip…", pct: 32 });
  await runStreaming(py, ["-m", "pip", "install", "--upgrade", "pip", "--no-warn-script-location"]);

  onProgress?.({ phase: "bootstrap_runtime", message: "Installing PII Shield dependencies…", pct: 35 });

  // Track which package pip is currently working on so we can show it.
  let lastPkg = null;
  const reportPct = { v: 35 };

  await runStreaming(
    py,
    ["-m", "pip", "install", "--no-warn-script-location", "-r", REQUIREMENTS_PATH],
    (line) => {
      const m = line.match(/^(?:Collecting|Downloading|Installing collected packages:)\s+([^\s,]+)/);
      if (m && m[1] !== lastPkg) {
        lastPkg = m[1];
        // Slowly tick the progress bar 35 → 80 as packages stream in.
        reportPct.v = Math.min(80, reportPct.v + 1);
        onProgress?.({
          phase: "bootstrap_runtime",
          message: `Installing ${lastPkg}…`,
          pct: reportPct.v,
        });
      }
    },
  );
}

async function verifyImports(venvDir, onProgress) {
  onProgress?.({ phase: "bootstrap_runtime", message: "Verifying installation…", pct: 82 });
  const py = venvPython(venvDir);
  const probe = "import gliner, presidio_analyzer, spacy, docx; print('OK')";
  const r = spawnSync(py, ["-c", probe], { encoding: "utf-8", timeout: 60000 });
  if (r.status !== 0) {
    throw new Error(`Import verification failed: ${r.stderr || r.stdout || "unknown error"}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Cross-process lock                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

// Defense in depth against multiple Node processes calling ensurePythonRuntime()
// against the same venv dir. The in-process _bootstrapPromise only coalesces
// within one process; this lockfile coalesces across processes.

const STALE_LOCK_MS = 30 * 60 * 1000; // 30 minutes — longer than any realistic bootstrap

function sleepSync(ms) {
  // Tiny busy-wait. Acceptable here because we're already deep in an awaited
  // bootstrap path and there's no useful concurrent work to do.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

async function acquireBootstrapLock(venvDir, onProgress) {
  fs.mkdirSync(venvDir, { recursive: true });
  const lockPath = path.join(venvDir, ".bootstrap.lock");
  const requirementsSha = requirementsHash();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      }));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      // Lock exists. Is it stale?
      let stat;
      try { stat = fs.statSync(lockPath); } catch { continue; /* race, retry */ }
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        try { fs.unlinkSync(lockPath); } catch { /* race */ }
        continue;
      }

      // Active lock — another process is bootstrapping. Wait for it, but
      // give up after a bounded window so the caller can decide how to retry.
      onProgress?.({
        phase: "bootstrap_runtime",
        message: "Waiting for another bootstrap to finish…",
        pct: 5,
      });

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const sentinel = readSentinel(venvDir);
        if (sentinel && sentinel.requirements_sha256 === requirementsSha
            && fs.existsSync(venvPython(venvDir))) {
          return null; // someone else completed the bootstrap
        }
        if (!fs.existsSync(lockPath)) break; // lock released, retry acquire
        sleepSync(500);
      }
      // Loop around — either re-attempt acquire or detect completion.
    }
  }
}

function releaseBootstrapLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public entry point                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

let _bootstrapPromise = null;

export function ensurePythonRuntime({ onProgress, userPythonPath } = {}) {
  // Coalesce concurrent calls — first wins, others await the same promise.
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    let lockPath = null;
    try {
      const hash = requirementsHash();
      const venvDir = pickVenvDir();

      // Fast path: sentinel matches → reuse venv (no lock needed).
      const sentinel = readSentinel(venvDir);
      if (sentinel && sentinel.requirements_sha256 === hash && fs.existsSync(venvPython(venvDir))) {
        return { python: venvPython(venvDir), venvDir, requirementsHash: hash, fromCache: true };
      }

      // Acquire cross-process lock before any destructive work.
      lockPath = await acquireBootstrapLock(venvDir, onProgress);
      if (lockPath === null) {
        // Another process completed the bootstrap while we waited.
        return { python: venvPython(venvDir), venvDir, requirementsHash: hash, fromCache: true };
      }

      // Re-check sentinel after acquiring the lock — the previous holder
      // may have just finished.
      const sentinel2 = readSentinel(venvDir);
      if (sentinel2 && sentinel2.requirements_sha256 === hash && fs.existsSync(venvPython(venvDir))) {
        return { python: venvPython(venvDir), venvDir, requirementsHash: hash, fromCache: true };
      }

      onProgress?.({ phase: "bootstrap_runtime", message: "Preparing PII Shield runtime (one-time setup)…", pct: 1 });

      // 1. Pick a Python interpreter. User override > system Python ≥3.10 > PBS download.
      let pythonExe = null;
      if (userPythonPath && fs.existsSync(userPythonPath)) {
        const v = checkPythonVersion(userPythonPath);
        if (v && v >= 310) pythonExe = userPythonPath;
      }
      if (!pythonExe) pythonExe = findSystemPython();
      if (!pythonExe) {
        const cacheDir = path.dirname(venvDir);
        pythonExe = await downloadPbsPython(cacheDir, onProgress);
      } else {
        onProgress?.({ phase: "bootstrap_runtime", message: "Found system Python — skipping download", pct: 25 });
      }

      // 2. Create venv (idempotent — skips if venvPython already exists)
      await createVenv(pythonExe, venvDir, onProgress);

      // 3. Install requirements (pip is idempotent against an existing venv)
      await pipInstall(venvDir, onProgress);

      // 4. Verify
      await verifyImports(venvDir, onProgress);

      // 5. Write sentinel
      writeSentinel(venvDir, hash);

      onProgress?.({ phase: "bootstrap_runtime", message: "PII Shield runtime ready", pct: 90 });

      return { python: venvPython(venvDir), venvDir, requirementsHash: hash, fromCache: false };
    } catch (err) {
      _bootstrapPromise = null; // allow retry
      throw err;
    } finally {
      releaseBootstrapLock(lockPath);
    }
  })();
  return _bootstrapPromise;
}

// CLI entry: `node bootstrap.js [--eager]`
if (process.argv[1] && process.argv[1].endsWith("bootstrap.js")) {
  ensurePythonRuntime({
    onProgress: ({ message, pct }) => {
      process.stderr.write(`[bootstrap ${pct}%] ${message}\n`);
    },
  })
    .then((r) => {
      process.stderr.write(`[bootstrap] Ready: ${r.python}${r.fromCache ? " (cached)" : ""}\n`);
      process.exit(0);
    })
    .catch((e) => {
      process.stderr.write(`[bootstrap] FAILED: ${e.message}\n`);
      process.exit(1);
    });
}
