/**
 * PII Shield CLI — progress bar wrappers.
 *
 * Thin convenience over `cli-progress`. Emits to stderr so JSON output on
 * stdout stays parseable (`pii-shield scan --json`). Returns a no-op stub
 * under `--quiet` (`PII_QUIET=true`) so callers don't have to branch.
 */

import cliProgress from "cli-progress";

interface BarLike {
  start(total: number, value: number, payload?: object): void;
  update(value: number, payload?: object): void;
  stop(): void;
}

const NOOP_BAR: BarLike = {
  start() {},
  update() {},
  stop() {},
};

function isQuiet(): boolean {
  return process.env.PII_QUIET === "true";
}

export function createDownloadBar(label: string): BarLike {
  if (isQuiet()) return NOOP_BAR;
  return new cliProgress.SingleBar(
    {
      format: `${label} | {bar} | {percentage}% | {value}/{total} MB | ETA: {eta}s`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      stream: process.stderr,
      noTTYOutput: true,
      notTTYSchedule: 5000,
    },
    cliProgress.Presets.shades_classic,
  );
}

export function createBatchBar(total: number, label = "Anonymizing"): BarLike {
  void total; // total is supplied later via .start()
  if (isQuiet()) return NOOP_BAR;
  return new cliProgress.SingleBar(
    {
      format: `${label} | {bar} | {value}/{total} files | {filename}`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      stream: process.stderr,
      noTTYOutput: true,
      notTTYSchedule: 5000,
    },
    cliProgress.Presets.shades_classic,
  );
}
