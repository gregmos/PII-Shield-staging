/**
 * PII Shield CLI — interactive y/n prompts.
 *
 * No external prompt library — uses node:readline directly so we don't pull
 * inquirer/prompts into the bundle. TTY-aware: when stdin isn't a TTY (CI,
 * piped input) prompts return their default unless --yes was passed by caller.
 */

import readline from "node:readline";
import { registerCleanup } from "./cleanup-registry.js";

/**
 * Thrown when the user hits Ctrl-C during a mask prompt. The bin.ts global
 * error handler catches this and exits with code 130 — keeping the SIGINT
 * exit semantics, but routing through finally blocks so the TTY's raw mode
 * is always restored before exit.
 */
export class PromptInterrupt extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptInterrupt";
  }
}

export interface ConfirmOptions {
  /** What to return when stdin is not a TTY and assumeYes was not passed. */
  defaultValue?: boolean;
  /** Force-yes (e.g., --yes flag). Bypasses prompt entirely. */
  assumeYes?: boolean;
}

export async function confirm(
  question: string,
  opts: ConfirmOptions = {},
): Promise<boolean> {
  if (opts.assumeYes) return true;
  if (!process.stdin.isTTY) return opts.defaultValue ?? false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    const suffix = opts.defaultValue === false ? "[y/N]" : "[Y/n]";
    rl.question(`${question} ${suffix} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") {
        resolve(opts.defaultValue ?? true);
      } else {
        resolve(trimmed === "y" || trimmed === "yes");
      }
    });
  });
}

export async function promptString(
  question: string,
  opts: { default?: string; mask?: boolean } = {},
): Promise<string> {
  if (!process.stdin.isTTY) {
    if (opts.default !== undefined) return opts.default;
    throw new Error(`Cannot prompt for "${question}" — stdin is not a TTY`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  if (opts.mask) {
    // Suppress echo via raw mode so passphrases don't print.
    // Raw mode disables the kernel's Ctrl-C → SIGINT translation, so we
    // detect the  byte directly. The try/finally + cleanup-registry
    // entry guarantee rawMode is restored on every exit path — including
    // SIGINT/SIGTERM from another source while the prompt is open. Without
    // this, an interrupted prompt leaves the terminal echo-less and unusable.
    process.stdin.setRawMode?.(true);
    const restoreRaw = () => {
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        /* terminal already in cooked mode */
      }
    };
    const unregister = registerCleanup(restoreRaw);
    process.stderr.write(`${question} `);
    try {
      return await new Promise<string>((resolve, reject) => {
        let buf = "";
        const onData = (chunk: Buffer) => {
          const ch = chunk.toString("utf8");
          if (ch === "\r" || ch === "\n") {
            process.stdin.removeListener("data", onData);
            rl.close();
            process.stderr.write("\n");
            resolve(buf || opts.default || "");
          } else if (ch === "") {
            // Ctrl-C: route through PromptInterrupt so finally restores TTY
            // before bin.ts exits with 130.
            process.stdin.removeListener("data", onData);
            rl.close();
            process.stderr.write("^C\n");
            reject(new PromptInterrupt());
          } else if (ch === "" || ch === "\b") {
            if (buf.length > 0) buf = buf.slice(0, -1);
          } else {
            buf += ch;
          }
        };
        process.stdin.on("data", onData);
      });
    } finally {
      restoreRaw();
      unregister();
    }
  }

  return new Promise((resolve) => {
    const suffix = opts.default ? ` [${opts.default}]` : "";
    rl.question(`${question}${suffix} `, (answer) => {
      rl.close();
      resolve(answer.trim() || opts.default || "");
    });
  });
}
