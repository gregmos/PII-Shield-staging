/**
 * PII Shield v2.0.0 — Configuration
 * Environment variable defaults and constants.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMarker } from "../path-resolution/bfs-finder.js";

export const VERSION = "2.0.0";

/**
 * Resolve the persistent data directory for this plugin instance.
 *
 * Resolution order:
 * 1. `PII_SHIELD_DATA_DIR` — explicit power-user override.
 * 2. **Marker lookup** — BFS-search for a previously-dropped
 *    `WORKSPACE_MARKER_NAME` file via `findMarker()`. The marker lives next
 *    to a previously-successful cache (`<dir>/.pii_shield_workspace_marker`
 *    sibling of `<dir>/.pii_shield/`). Once we find it, that's our cache
 *    root, no further detection needed. Survives across sessions, across
 *    Cowork session ids, and travels with the workspace folder if the user
 *    moves it. This is the load-bearing path for everything after the very
 *    first run.
 * 3. **First-run pick** — no marker yet. Walk known persistent roots in
 *    priority order, pick the first writable one:
 *      a. `findCoworkWorkspace()` — Cowork workspace mount (the user's
 *         actual host-visible folder).
 *      b. `~/Downloads`, `~`, `process.cwd()` — desktop / dev installs.
 *      c. `CLAUDE_PLUGIN_DATA` — marketplace launcher fallback.
 * 4. Legacy `~/.pii_shield` — last resort.
 *
 * After picking (steps 3 or 4), the marker file is dropped next to the
 * cache so subsequent runs short-circuit via step 2. README.txt + .gitignore
 * are also written on first create.
 */
let _cachedDataDir: string | null = null;
let _cachedDataDirSource: string | null = null;

/**
 * Marker filename used to recognise a previously-cached workspace.
 * Findable by `findMarker()` (BFS over `/home`, `/mnt`, `/media`, and in
 * Cowork also `/sessions/<sid>/mnt/`). See `bfs-finder.ts:linuxBfsRoots`.
 */
export const WORKSPACE_MARKER_NAME = ".pii_shield_workspace_marker";

/** Reset the memoized data-dir choice (for tests). */
export function _resetDataDirCache(): void {
  _cachedDataDir = null;
  _cachedDataDirSource = null;
}

/** Source-of-truth description for the currently resolved data dir. */
export function getDataDirSource(): string {
  // Ensure resolution has run at least once.
  getDataDir();
  return _cachedDataDirSource || "unknown";
}

function getDataDir(): string {
  if (_cachedDataDir) return _cachedDataDir;

  // 1. Explicit env override
  const explicit = process.env.PII_SHIELD_DATA_DIR;
  if (explicit && explicit.length > 0) {
    _cachedDataDir = explicit;
    _cachedDataDirSource = "PII_SHIELD_DATA_DIR env override";
    return explicit;
  }

  // 2. Marker lookup — fast path for every run after the first.
  try {
    // Depth 2 is sufficient: marker file lives at workspace root, one level
    // inside any BFS root (`/sessions/<sid>/mnt/<workspace>/marker`,
    // `/home/<user>/<workspace>/marker`, …). Default depth 6 caused a
    // multi-second sync walk of the entire user repo at module-init time
    // in Cowork, blocking the MCP `initialize` handshake → zero tools.
    const found = findMarker(WORKSPACE_MARKER_NAME, 2);
    if (found) {
      const workspaceDir = path.dirname(found);
      const cacheDir = path.join(workspaceDir, ".pii_shield");
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        _cachedDataDir = cacheDir;
        _cachedDataDirSource = `marker found at ${found}`;
        return cacheDir;
      } catch { /* not writable, fall through */ }
    }
  } catch { /* bfs failed, fall through */ }

  // 3. First-run pick — pick a writable persistent root.
  const candidates: string[] = [];

  // 3a. Cowork workspace mount (host-visible, persistent across sessions).
  const ws = findCoworkWorkspace();
  if (ws) candidates.push(ws);

  // 3b. Desktop / dev fallbacks.
  const home = os.homedir();
  candidates.push(path.join(home, "Downloads"));
  candidates.push(home);
  candidates.push(process.cwd());

  // 3c. Marketplace launcher fallback. Inside Cowork this is ephemeral
  // (`.claude/plugins/data/...`) but on real desktop it's the right place.
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData && pluginData.length > 0) candidates.push(pluginData);

  for (const root of candidates) {
    if (!root) continue;
    const cacheDir = root.endsWith(".pii_shield") || root.endsWith("pii-shield-inline")
      ? root
      : path.join(root, ".pii_shield");
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      // Probe writability with a tiny scratch file.
      const probe = path.join(cacheDir, `.write_probe_${process.pid}`);
      fs.writeFileSync(probe, "x");
      // VirtioFS can fail on unlink even when write succeeded — non-fatal.
      try { fs.unlinkSync(probe); } catch { /* leftover probe is harmless */ }
      // Drop the marker + README + .gitignore on first successful create.
      stampCacheDir(cacheDir);
      _cachedDataDir = cacheDir;
      _cachedDataDirSource = `first-run pick: ${root}`;
      return cacheDir;
    } catch { /* try next */ }
  }

  // 4. Legacy fallback.
  const legacy = path.join(home, ".pii_shield");
  try { fs.mkdirSync(legacy, { recursive: true }); } catch { /* */ }
  _cachedDataDir = legacy;
  _cachedDataDirSource = "legacy ~/.pii_shield";
  return legacy;
}

/**
 * Drop the workspace marker, README, and .gitignore into a freshly-created
 * cache dir. The marker lives at `<workspace>/.pii_shield_workspace_marker`
 * (sibling of the `.pii_shield/` cache itself), so future runs find it via
 * BFS without descending into the cache subtree.
 */
function stampCacheDir(cacheDir: string): void {
  // Marker — sibling of the cache, not inside it. cacheDir ends with
  // ".pii_shield" (or the marketplace fallback "pii-shield-inline"); the
  // marker goes one level up.
  try {
    const workspaceDir = path.dirname(cacheDir);
    const markerPath = path.join(workspaceDir, WORKSPACE_MARKER_NAME);
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(
        markerPath,
        `# PII Shield workspace marker\n` +
        `# Discovered by bfs-finder.ts on subsequent runs.\n` +
        `# Safe to delete — the cache will re-bootstrap on next run.\n` +
        `cache: ${cacheDir}\n` +
        `created: ${new Date().toISOString()}\n` +
        `version: ${VERSION}\n`,
        "utf-8",
      );
    }
  } catch { /* best effort */ }

  // README inside the cache.
  try {
    const readmePath = path.join(cacheDir, "README.txt");
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(
        readmePath,
        "PII Shield plugin cache\n" +
        "=======================\n\n" +
        "This directory holds the GLiNER NER model (~665 MB ONNX) and\n" +
        "runtime dependencies (onnxruntime-node, @xenova/transformers,\n" +
        "gliner) used by the PII Shield Claude Code plugin.\n\n" +
        "A sibling marker file (.pii_shield_workspace_marker, one level up)\n" +
        "lets the plugin re-discover this cache on subsequent runs via the\n" +
        "same BFS marker mechanism that powers `resolve_path` / `find_file`.\n\n" +
        "Safe to delete. If you do, the plugin will re-download the model\n" +
        "on its next run (2–5 minutes on a good connection).\n\n" +
        "Override with the PII_SHIELD_DATA_DIR environment variable if you\n" +
        "prefer to keep the cache somewhere else.\n",
        "utf-8",
      );
    }
    const gitignorePath = path.join(cacheDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n", "utf-8");
    }
  } catch { /* best effort */ }
}

/**
 * Strip the Cowork VM path prefix when displaying a cache dir to the user.
 * Cowork's `/sessions/<sid>/mnt/<workspace>/.pii_shield` is meaningless to
 * the user (it's the VM-internal path, not the host path they recognise).
 * Returns just `<workspace>/.pii_shield/` so the user sees their own folder
 * name. Other path shapes (desktop installs, legacy `~/.pii_shield`,
 * explicit overrides) are returned unchanged because they ARE meaningful.
 */
export function displayCacheDir(rawDir: string): string {
  const m = /^\/sessions\/[^/]+\/mnt\/(.+)$/.exec(rawDir);
  if (m) return m[1].replace(/\/$/, "") + "/";
  return rawDir;
}

/**
 * True when the process is running inside a Claude Cowork VM sandbox.
 *
 * Detection signals (any one is sufficient):
 *   1. `COWORK_VM=1` env var (legacy / explicit)
 *   2. `CLAUDE_COWORK=1` env var (legacy / explicit)
 *   3. `/run/.cowork-marker` file (legacy / explicit)
 *   4. **Filesystem heuristic**: a `/sessions/<sid>/mnt/` directory exists.
 *      In real Cowork sandboxes none of the explicit signals above are
 *      actually set, but the `/sessions/<id>/mnt/` VirtioFS layout is the
 *      load-bearing structural marker — `process.cwd()` even resolves
 *      under `/sessions/<id>/`. If we see that layout, we ARE in Cowork.
 *      Without this fallback the Phase 7b workspace-mount branch in
 *      `getDataDir()` never fires and the model gets re-downloaded every
 *      session because `CLAUDE_PLUGIN_DATA` points at the ephemeral
 *      `.claude/plugins/data/` mount.
 */
export function isCowork(): boolean {
  if (process.env.COWORK_VM === "1") return true;
  if (process.env.CLAUDE_COWORK === "1") return true;
  try {
    if (fs.existsSync("/run/.cowork-marker")) return true;
  } catch { /* ignore */ }
  // Filesystem heuristic — /sessions/<sid>/mnt/ layout is unique to Cowork.
  try {
    if (!fs.existsSync("/sessions")) return false;
    for (const sid of fs.readdirSync("/sessions")) {
      if (fs.existsSync(path.join("/sessions", sid, "mnt"))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Locate the Cowork workspace mount (the VirtioFS-backed dir under
 * `/sessions/<id>/mnt/<workspace_name>/`). This is the ONLY directory inside
 * the VM whose contents are visible to the user's host file browser /
 * Artifacts panel AND survive across conversations — files written outside
 * it (e.g. at `/sessions/<id>/`, which is what `process.cwd()` returns, or
 * inside `.claude/plugins/data/...`) are wiped between sessions per Cowork
 * issues #30751 / #31422.
 *
 * Returns the first writable, **non-dot-prefixed** subdirectory of
 * `/sessions/<id>/mnt/`, or null if not found / not in Cowork. Dot-prefixed
 * entries (`.claude`, `.cache`, etc.) are skipped because they are internal
 * Claude config mounts, NOT the user's workspace folder — picking `.claude`
 * would dump our cache inside the user's Claude config tree where it
 * neither shows up in their file browser nor persists.
 */
export function findCoworkWorkspace(): string | null {
  try {
    const sessions = "/sessions";
    if (!fs.existsSync(sessions)) return null;
    for (const sid of fs.readdirSync(sessions)) {
      const mntDir = path.join(sessions, sid, "mnt");
      if (!fs.existsSync(mntDir)) continue;
      let entries: string[];
      try { entries = fs.readdirSync(mntDir); } catch { continue; }
      // Sort for deterministic selection across runs (filesystem readdir
      // order is otherwise undefined).
      entries.sort();
      console.error(`[config] findCoworkWorkspace: mnt_entries=${JSON.stringify(entries)}`);
      for (const name of entries) {
        // Skip dot-prefixed entries — those are Claude/Cowork internal
        // mounts (`.claude`, `.cache`, ...), never the user's workspace.
        if (name.startsWith(".")) continue;
        const candidate = path.join(mntDir, name);
        try {
          const st = fs.statSync(candidate);
          if (st.isDirectory()) {
            // VirtioFS permission bits are unreliable — fs.accessSync(W_OK)
            // can return EACCES even when the dir IS writable. Use an actual
            // write probe instead (matches the pattern in getDataDir).
            const probe = path.join(candidate, `.pii_shield_probe_${process.pid}`);
            fs.writeFileSync(probe, "x");
            // VirtioFS can fail on unlink even when write succeeded — non-fatal.
            try { fs.unlinkSync(probe); } catch { /* leftover probe is harmless */ }
            console.error(`[config] findCoworkWorkspace: selected ${candidate}`);
            return candidate;
          }
        } catch (e: any) {
          console.error(`[config] findCoworkWorkspace: skip ${candidate}: ${e.message}`);
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

export const ENV = {
  /** Minimum confidence score for pattern-based detections (0.0–1.0) */
  PII_MIN_SCORE: parseFloat(process.env.PII_MIN_SCORE || "0.40"),

  /** Minimum confidence score for NER detections (0.0–1.0) */
  PII_NER_THRESHOLD: parseFloat(process.env.PII_NER_THRESHOLD || "0.40"),

  /** GLiNER model name (for ONNX export reference) */
  PII_GLINER_MODEL: process.env.PII_GLINER_MODEL || "knowledgator/gliner-pii-base-v1.0",

  /** Mapping TTL in days */
  PII_MAPPING_TTL_DAYS: parseInt(process.env.PII_MAPPING_TTL_DAYS || "7", 10),

  /** Working directory for find_file */
  PII_WORK_DIR: process.env.PII_WORK_DIR || "",

  /** Skip HITL review step */
  PII_SKIP_REVIEW: process.env.PII_SKIP_REVIEW === "true",

  /** HITL review server port */
  PII_REVIEW_PORT: parseInt(process.env.PII_REVIEW_PORT || "8766", 10),
} as const;

/** Chunk processing thresholds */
export const CHUNK = {
  /** Documents above this char count trigger chunked processing */
  THRESHOLD: 15_000,
  /** Default chunk size in chars */
  DEFAULT_SIZE: 2500,
  /** Chunk session TTL in ms (30 minutes) */
  SESSION_TTL_MS: 30 * 60 * 1000,
} as const;

/**
 * Paths — all getters so `CLAUDE_PLUGIN_DATA` is re-read lazily. Claude Code
 * sets the env var before spawning our stdio process, but lazy reads also
 * protect against any early-init race and make tests trivially overridable.
 */
export const PATHS = {
  get DATA_DIR()     { return getDataDir(); },
  get MODELS_DIR()   { return path.join(getDataDir(), "models"); },
  get DEPS_DIR()     { return path.join(getDataDir(), "deps"); },
  get MAPPINGS_DIR() { return path.join(getDataDir(), "mappings"); },
  get REVIEWS_DIR()  { return path.join(getDataDir(), "reviews"); },
  get AUDIT_DIR()    { return path.join(getDataDir(), "audit"); },
};

/**
 * Legacy `~/.pii_shield` location. Kept as a read-only fallback so pre-plugin
 * users with a warmed-up model cache (~665 MB ONNX download) don't have to
 * re-download on the first plugin launch.
 */
export const LEGACY_DATA_DIR = path.join(os.homedir(), ".pii_shield");
