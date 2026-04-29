/**
 * PII Shield CLI — color helpers.
 *
 * Thin wrapper over picocolors. Respects:
 *   - `NO_COLOR` env var (https://no-color.org/) — disables ANSI universally.
 *   - `FORCE_COLOR` env var — overrides isTTY checks.
 *   - `process.stdout.isTTY` — when stdout is not a TTY (piped, CI), skip ANSI.
 *
 * Importing `picocolors` directly already does most of this for stdout, but
 * we sometimes write to stderr; the helper picks the right answer for both.
 */

import pc from "picocolors";

function colorAllowed(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

const stdoutColor = colorAllowed(process.stdout);

function maybeColor(fn: (s: string) => string, s: string): string {
  return stdoutColor ? fn(s) : s;
}

export const green = (s: string): string => maybeColor(pc.green, s);
export const red = (s: string): string => maybeColor(pc.red, s);
export const yellow = (s: string): string => maybeColor(pc.yellow, s);
export const cyan = (s: string): string => maybeColor(pc.cyan, s);
export const gray = (s: string): string => maybeColor(pc.gray, s);
export const bold = (s: string): string => maybeColor(pc.bold, s);
export const dim = (s: string): string => maybeColor(pc.dim, s);

/** OK / FAIL / WARN tags used in doctor + verify summaries. */
export const okTag = (): string => green("OK  ");
export const failTag = (): string => red("FAIL");
export const warnTag = (): string => yellow("WARN");
