/**
 * PII Shield CLI — path / glob expansion.
 *
 * Bash and zsh expand globs before invoking the CLI, but cmd.exe and the
 * Windows PowerShell built-ins do not. This helper bridges the gap so the
 * same `pii-shield anonymize *.pdf` command works on every shell.
 *
 * Behavior:
 *   - If no argument contains a glob meta-char, return as-is (cheap path).
 *   - Otherwise resolve each arg via tinyglobby with `onlyFiles: true`,
 *     dot-files excluded by default, dedup, sort.
 *   - Non-glob args that point to existing files are passed through verbatim
 *     (so a mixed `pii-shield anonymize doc1.pdf *.docx` works).
 */

import path from "node:path";
import fs from "node:fs";
import { glob } from "tinyglobby";

const GLOB_RE = /[*?[\]{}]/;

export async function expandFileArgs(args: string[]): Promise<string[]> {
  if (args.length === 0) return [];

  const hasAnyGlob = args.some((a) => GLOB_RE.test(a));
  if (!hasAnyGlob) return args;

  const out = new Set<string>();
  for (const arg of args) {
    if (!GLOB_RE.test(arg)) {
      out.add(path.resolve(arg));
      continue;
    }
    // tinyglobby treats backslashes as escapes on POSIX. Normalize Windows
    // paths to forward slashes for the pattern match; resolved hits get
    // path.resolve()-d back to native separators.
    const pattern = arg.replace(/\\/g, "/");
    const matches = await glob(pattern, {
      onlyFiles: true,
      absolute: true,
      dot: false,
    });
    for (const m of matches) out.add(path.resolve(m));
  }

  const result = Array.from(out).sort();
  if (result.length === 0) {
    throw new Error(
      `No files matched: ${args.join(", ")}\n` +
        `Hint: check the pattern; tinyglobby uses POSIX-style globs (use forward slashes).`,
    );
  }
  // Drop entries that don't exist on disk (defensive — shouldn't happen).
  return result.filter((p) => fs.existsSync(p));
}
