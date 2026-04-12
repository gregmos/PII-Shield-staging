/**
 * PII Shield v2.0.0 — BFS file finder
 * Ported from pii_shield_server.py lines 2252-2305
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BFS_SKIP = new Set([
  "node_modules", "__pycache__", ".git", ".svn", ".hg",
  "venv", ".venv", "env", ".env", ".tox",
  "dist", "build", "target", "out", ".cache",
  "Library", "AppData", "Application Data",
  "$RECYCLE.BIN", "System Volume Information",
  "Windows", "Program Files", "Program Files (x86)",
]);

/**
 * Depth-limited BFS for a file by exact name. Returns full path or null.
 */
export function bfsFind(root: string, targetName: string, maxDepth = 6): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.name === targetName && entry.isFile()) {
          return fullPath;
        }
        if (
          entry.isDirectory() &&
          depth < maxDepth &&
          (!entry.name.startsWith(".") || entry.name === ".pii_shield") &&
          !BFS_SKIP.has(entry.name)
        ) {
          queue.push({ dir: fullPath, depth: depth + 1 });
        }
      }
    } catch {
      // PermissionError, etc. — skip
    }
  }

  return null;
}

/**
 * Search for a unique marker file across home dir and platform-specific roots.
 */
export function findMarker(marker: string, maxDepth: number = 6): string | null {
  // Home directory first
  const homeDir = os.homedir();
  let result = bfsFind(homeDir, marker, maxDepth);
  if (result) return result;

  // Platform-specific roots
  if (process.platform === "win32") {
    const homeDrive = path.parse(homeDir).root;
    for (let i = 65; i <= 90; i++) { // A-Z
      const drive = `${String.fromCharCode(i)}:\\`;
      if (drive === homeDrive) continue;
      try {
        if (fs.existsSync(drive)) {
          result = bfsFind(drive, marker, maxDepth);
          if (result) return result;
        }
      } catch { /* skip */ }
    }
  } else if (process.platform === "darwin") {
    const volumes = "/Volumes";
    try {
      if (fs.existsSync(volumes)) {
        for (const vol of fs.readdirSync(volumes)) {
          if (vol !== "Macintosh HD") {
            result = bfsFind(path.join(volumes, vol), marker, maxDepth);
            if (result) return result;
          }
        }
      }
    } catch { /* skip */ }
  } else {
    // Linux — including Cowork VM mounts at /sessions/<sid>/mnt/
    for (const root of linuxBfsRoots()) {
      try {
        if (fs.existsSync(root)) {
          result = bfsFind(root, marker, maxDepth);
          if (result) return result;
        }
      } catch { /* skip */ }
    }
  }

  return null;
}

/**
 * Linux BFS root list. Static `/home`, `/mnt`, `/media` plus any Cowork
 * workspace mount roots present at call time (`/sessions/<sid>/mnt/`).
 * Each Cowork session id gets its `mnt/` enumerated so the existing
 * marker BFS naturally reaches `<workspace>/.pii_shield_workspace_marker`
 * without any Cowork-specific detection upstream.
 */
export function linuxBfsRoots(): string[] {
  const roots = ["/home", "/mnt", "/media"];
  try {
    if (fs.existsSync("/sessions")) {
      for (const sid of fs.readdirSync("/sessions")) {
        const mnt = path.join("/sessions", sid, "mnt");
        try {
          if (fs.existsSync(mnt)) roots.push(mnt);
        } catch { /* skip */ }
      }
    }
  } catch { /* not Cowork, nothing to add */ }
  return roots;
}
