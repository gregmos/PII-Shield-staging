/**
 * PII Shield v2 — auto-resolve input paths without marker ceremony.
 *
 * The MCP server runs on host; the caller (Claude in a Cowork VM session,
 * a Claude Desktop chat, or a CLI user) may know the file by:
 *   - an absolute host path (`C:\Users\...\doc.docx`),
 *   - a VM-mount path (`/sessions/<sid>/mnt/.../doc.docx`) — the shared
 *     filesystem makes this name-equivalent to a host path when the file
 *     lives in the user's workspace,
 *   - or just a filename (`doc.docx`).
 *
 * `resolveInputPath(input)` tries (in order):
 *   1. the input as-given (`path.resolve`) — wins when caller already has a
 *      valid host path;
 *   2. `$PII_WORK_DIR/<basename>` — wins when a workspace dir is configured;
 *   3. BFS (depth 4) over common user dirs — `~/Downloads`, `~/Documents`,
 *      `~/Desktop`, and `$PII_WORK_DIR` — wins for zero-config filename
 *      lookups.
 *
 * Only a single unambiguous match is accepted. Multiple matches return an
 * error with the list so the caller can disambiguate via the explicit
 * `resolve_path(filename, marker)` tool.
 *
 * This replaces the old pattern where the skill had Claude mint a marker
 * file and call `resolve_path` in every pipeline. `resolve_path` stays in
 * the toolset as a reliability net for non-standard locations, but is
 * no longer required on the happy path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bfsFind } from "./bfs-finder.js";

const AUTO_BFS_DEPTH = 4;
const MAX_REPORTED_MATCHES = 5;

export type AutoResolveResult =
  | { ok: true; path: string; strategy: "literal" | "pii_work_dir" | "auto_bfs" }
  | { ok: false; error: string; hint: string; matches?: string[] };

/** Try every strategy; return the first unambiguous hit, or a structured error. */
export function resolveInputPath(input: string): AutoResolveResult {
  // 1. Literal path (happy path — caller already has a valid host path).
  //    `path.resolve` also handles relative paths (rare from Claude but not
  //    forbidden — if CWD is the workspace this JustWorks).
  try {
    const asResolved = path.resolve(input);
    if (fs.existsSync(asResolved) && fs.statSync(asResolved).isFile()) {
      return { ok: true, path: asResolved, strategy: "literal" };
    }
  } catch { /* fall through */ }

  // 2. $PII_WORK_DIR + basename — when the user configured a workspace dir.
  const workDir = process.env.PII_WORK_DIR || "";
  if (workDir) {
    try {
      const candidate = path.join(workDir, path.basename(input));
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { ok: true, path: candidate, strategy: "pii_work_dir" };
      }
    } catch { /* fall through */ }
  }

  // 3. BFS across common user dirs. Collect matches, cap at 5 for error
  //    reporting; require exactly 1 to accept.
  const basename = path.basename(input);
  const home = os.homedir();
  const roots: string[] = [];
  for (const candidate of [
    path.join(home, "Downloads"),
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    workDir,
  ]) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        roots.push(candidate);
      }
    } catch { /* ignore */ }
  }

  const matches: string[] = [];
  for (const root of roots) {
    const found = bfsFind(root, basename, AUTO_BFS_DEPTH);
    if (found && !matches.includes(found)) {
      matches.push(found);
      if (matches.length >= MAX_REPORTED_MATCHES) break;
    }
  }

  if (matches.length === 1) {
    return { ok: true, path: matches[0], strategy: "auto_bfs" };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: `Ambiguous filename: "${basename}" found in multiple locations.`,
      hint:
        "Pass the full host path instead, OR create a marker file next to the " +
        "intended file and call `resolve_path(filename, marker)` to disambiguate.",
      matches,
    };
  }

  return {
    ok: false,
    error: `File not found via auto-search: ${input}`,
    hint:
      `Auto-search checked: the absolute path as-given, $PII_WORK_DIR (${workDir || "<unset>"}), ` +
      `and BFS (depth ${AUTO_BFS_DEPTH}) of ~/Downloads, ~/Documents, ~/Desktop. ` +
      "If the file is in a non-standard location, create a marker file (e.g. " +
      "`touch <folder>/.pii_marker_abc`) next to it, call " +
      "`resolve_path(filename, marker)` to get the absolute host path, then retry " +
      "`anonymize_file(file_path=<resolved>)`.",
  };
}
