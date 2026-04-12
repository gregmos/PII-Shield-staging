/**
 * PII Shield v2.0.0 — Path resolution + dir cache
 * Ported from pii_shield_server.py lines 2200-2370
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, ENV } from "../utils/config.js";
import { bfsFind, findMarker } from "./bfs-finder.js";

// In-memory dir cache: vm_dir/marker → host_dir
let _dirCache: Record<string, string> = {};
let _cacheLoaded = false;

/**
 * Lazily resolve the cache file path. Touching `PATHS.DATA_DIR` triggers the
 * full marker-BFS in `getDataDir()`, which on Linux/Cowork can do a slow
 * sync walk of `/sessions/<sid>/mnt/<workspace>` over VirtioFS. We MUST NOT
 * do that at ESM module-init time (it blocks the MCP `initialize` handshake
 * → zero tools registered). Resolve it lazily on first tool invocation
 * instead.
 */
function getCachePath(): string {
  return path.join(PATHS.DATA_DIR, "dir_cache.json");
}

function ensureCacheLoaded(): void {
  if (_cacheLoaded) return;
  _cacheLoaded = true;
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      _dirCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    }
  } catch {
    _dirCache = {};
  }
}

function saveDirCache(): void {
  try {
    const cachePath = getCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(_dirCache, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

/**
 * Resolve a file path using marker-based BFS.
 * Returns { host_path, host_dir } or { error, hint }.
 */
export function resolvePath(
  filename: string,
  marker: string,
  vmDir = "",
): Record<string, unknown> {
  ensureCacheLoaded();
  // Check cache first
  const cacheKey = vmDir || marker;
  if (_dirCache[cacheKey]) {
    const cachedDir = _dirCache[cacheKey];
    const candidate = path.join(cachedDir, filename);
    if (fs.existsSync(candidate)) {
      // Clean up marker if it exists
      const markerPath = path.join(cachedDir, marker);
      try { if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath); } catch { /* */ }
      return { host_path: candidate, host_dir: cachedDir, cached: true };
    }
  }

  // BFS search for marker
  const found = findMarker(marker);
  if (!found) {
    return {
      error: `Marker file '${marker}' not found on host.`,
      hint: "Ensure the marker was created in the connected folder. Ask the user for the full host path as fallback.",
    };
  }

  const hostDir = path.dirname(found);

  // Clean up marker + any other stale .pii_marker_* files in the same dir
  try { fs.unlinkSync(found); } catch { /* */ }
  try {
    for (const f of fs.readdirSync(hostDir)) {
      if (f.startsWith(".pii_marker_") && f !== path.basename(found)) {
        try { fs.unlinkSync(path.join(hostDir, f)); } catch { /* */ }
      }
    }
  } catch { /* */ }

  // Cache the mapping
  _dirCache[cacheKey] = hostDir;
  if (vmDir) _dirCache[vmDir] = hostDir;
  saveDirCache();

  // Find the target file
  const target = path.join(hostDir, filename);
  if (fs.existsSync(target)) {
    return { host_path: target, host_dir: hostDir };
  }

  return {
    error: `Marker found at ${hostDir} but '${filename}' not in that directory.`,
    hint: `Files in directory: check manually.`,
  };
}

/**
 * Find a file by name in the configured working directory.
 */
export function findFile(filename: string): Record<string, unknown> {
  ensureCacheLoaded();
  const workDir = ENV.PII_WORK_DIR;
  if (!workDir) {
    return {
      error: "No working directory configured.",
      hint: "Set PII_WORK_DIR environment variable or use resolve_path with a marker file.",
    };
  }

  // Direct check
  const direct = path.join(workDir, filename);
  if (fs.existsSync(direct)) {
    return { path: direct };
  }

  // BFS within work_dir
  const found = bfsFind(workDir, filename, 6);
  if (found) {
    return { path: found };
  }

  return {
    error: `File '${filename}' not found in ${workDir}`,
    hint: "Check filename spelling or provide the full path.",
  };
}
