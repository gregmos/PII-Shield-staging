/**
 * PII Shield CLI — entry point.
 *
 * Dispatcher built on commander. Each command lazy-imports its handler so
 * `--help` / `--version` don't pay the engine import cost.
 *
 * Stderr discipline: by default the CLI suppresses the audit logger's
 * stderr echo (PII_AUDIT_STDERR=false). `--debug` flips it back; `--quiet`
 * silences progress bars too.
 */

// Set audit-logger default BEFORE the runtime import in any sub-command path.
// The audit-logger reads this env var lazily inside each log call, so flipping
// it later in `--debug` still works.
if (process.env.PII_AUDIT_STDERR === undefined) {
  process.env.PII_AUDIT_STDERR = "false";
}

import { Command } from "commander";
import { VERSION } from "../../src/utils/config.js";
import { expandFileArgs } from "./path-utils.js";
import { runAllCleanup } from "./cleanup-registry.js";
import { PromptInterrupt } from "./prompts.js";

// Cleanup hooks for graceful shutdown on SIGINT/SIGTERM (HTTP server, etc).
// runAllCleanup also restores stdin's raw mode if a passphrase prompt was
// open — without that, Ctrl-C from outside the prompt's data listener
// (e.g. `kill -INT <pid>`) leaves the terminal echo-less.
process.on("SIGINT", async () => {
  await runAllCleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await runAllCleanup();
  process.exit(143);
});

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("pii-shield")
    .description("Anonymize PII in legal documents locally — pure offline, no LLM, no cloud.")
    .version(VERSION, "-v, --version", "Print version")
    .option("-q, --quiet", "Suppress progress + summary output (errors still go to stderr)")
    .option("--debug", "Verbose mode: print full audit trail and stack traces");

  program.on("option:debug", () => {
    process.env.PII_AUDIT_STDERR = "true";
    process.env.PII_DEBUG = "true";
  });
  program.on("option:quiet", () => {
    process.env.PII_AUDIT_STDERR = "false";
    process.env.PII_QUIET = "true";
  });

  program.addHelpText(
    "after",
    `
Examples:
  Anonymize one file (no review)
    $ pii-shield anonymize contract.pdf --no-review

  Anonymize a batch — all files share placeholders
    $ pii-shield anonymize matter/*.pdf matter/*.docx

  Round-trip with an external LLM
    $ pii-shield anonymize nda.docx --no-review
    # → send nda_anonymized.docx to ChatGPT/Gemini/etc, save reply as analysis.docx
    $ pii-shield deanonymize analysis.docx --session 2026-04-29_120000_ab12

Full guide: see USAGE.md (bundled with the npm package, or
https://github.com/gregmos/PII-Shield/blob/main/nodejs-v2/cli/USAGE.md).
`,
  );

  program
    .command("anonymize")
    .description("Anonymize one or more files. Files share a session_id and placeholder pool.")
    .argument("<files...>", "files to anonymize (.pdf, .docx, .txt, .md, .csv) — globs auto-expanded")
    .option("-o, --out <dir>", "output directory (default: <input-dir>/pii_shield_<sid>/ per file)")
    .option("-s, --session <id>", "extend an existing session (id or unique prefix)")
    .option("--no-review", "skip HITL review — write outputs and exit")
    .option("--lang <code>", "language hint for NER (default: en)", "en")
    .option("--prefix <p>", "placeholder prefix (default: empty)", "")
    .option("-y, --yes", "assume yes for prompts (model download, double-anon warning)")
    .option("--json", "emit structured JSON to stdout (for scripting / Python). Implies --no-review.")
    .addHelpText(
      "after",
      `
Examples:
  $ pii-shield anonymize contract.pdf --no-review
  $ pii-shield anonymize *.pdf *.docx --out anonymized/
  $ pii-shield anonymize new.pdf --session 2026-04-29
`,
    )
    .action(async (files: string[], opts) => {
      const expanded = await expandFileArgs(files);
      const { runAnonymize } = await import("./commands/anonymize.js");
      process.exit(await runAnonymize(expanded, opts));
    });

  program
    .command("deanonymize")
    .description("Restore PII from placeholders. Session resolved via --session, .docx metadata, or latest.")
    .argument("<file>", "anonymized file to restore")
    .option("-s, --session <id>", "session id or unique prefix (default: from .docx metadata or latest)")
    .option("-o, --out <path>", "output path (default: alongside input with _restored suffix)")
    .addHelpText(
      "after",
      `
Examples:
  $ pii-shield deanonymize analysis.docx --session 2026-04
  $ pii-shield deanonymize summary.txt --session 2026-04-29_120000_ab12
`,
    )
    .action(async (file: string, opts) => {
      const { runDeanonymize } = await import("./commands/deanonymize.js");
      process.exit(await runDeanonymize(file, opts));
    });

  program
    .command("scan")
    .description("Detect PII in a file without writing — preview mode.")
    .argument("<file>", "file to scan")
    .option("--json", "emit JSON to stdout")
    .option("--lang <code>", "language hint (default: en)", "en")
    .option("--wait-ner <s>", "max seconds to wait for NER model on cold start", "30")
    .option("-y, --yes", "assume yes for model-download prompt")
    .addHelpText(
      "after",
      `
Examples:
  $ pii-shield scan contract.pdf
  $ pii-shield scan contract.pdf --json | jq '.entities | length'
`,
    )
    .action(async (file: string, opts) => {
      // Guard against `--wait-ner abc` → NaN → Date.now() - start < NaN is
      // always false → instant timeout. Surface the bad input early.
      const waitNer = parseInt(opts.waitNer, 10);
      if (!Number.isFinite(waitNer) || waitNer < 0) {
        process.stderr.write(
          `pii-shield: invalid --wait-ner ${JSON.stringify(opts.waitNer)} — expected non-negative integer (seconds).\n`,
        );
        process.exit(2);
      }
      const { runScan } = await import("./commands/scan.js");
      process.exit(
        await runScan(file, {
          json: opts.json,
          lang: opts.lang,
          waitNer,
          yes: opts.yes,
        }),
      );
    });

  program
    .command("review")
    .description("Open the HITL review UI in a browser for an existing session.")
    .argument("<session-id>", "session id or unique prefix from a prior anonymize")
    .option("-y, --yes", "assume yes for any prompts")
    .addHelpText(
      "after",
      `
Example:
  $ pii-shield review 2026-04-29
`,
    )
    .action(async (sessionId: string, opts) => {
      const { runReview } = await import("./commands/review.js");
      process.exit(await runReview(sessionId, opts));
    });

  program
    .command("verify")
    .description("Re-detect PII on an anonymized file. Fails if any non-placeholder PII is found.")
    .argument("<file>", "anonymized file to verify")
    .requiredOption("-s, --session <id>", "session id or unique prefix")
    .option("--json", "emit JSON to stdout")
    .option("--lang <code>", "language hint (default: en)", "en")
    .option("-y, --yes", "auto-confirm model download prompt")
    .addHelpText(
      "after",
      `
Examples:
  $ pii-shield verify contract_anonymized.txt --session 2026-04-29
  $ pii-shield verify summary.docx --session 2026-04 --json
`,
    )
    .action(async (file: string, opts) => {
      const { runVerify } = await import("./commands/verify.js");
      process.exit(await runVerify(file, opts));
    });

  program
    .command("install-model")
    .description("Download and install the GLiNER model (~634 MB).")
    .option("--force", "reinstall even if a valid model is already present")
    .option("-y, --yes", "skip the download confirmation prompt")
    .action(async (opts) => {
      const { runInstallModel } = await import("./commands/install-model.js");
      process.exit(await runInstallModel(opts));
    });

  program
    .command("doctor")
    .description("Run health checks (Node version, model, deps, paths).")
    .option("--json", "emit JSON to stdout")
    .action(async (opts) => {
      const { runDoctor } = await import("./commands/doctor.js");
      process.exit(await runDoctor(opts));
    });

  // ── sessions <subcommand> ──────────────────────────────────────────────
  const sessions = program
    .command("sessions")
    .description("List, inspect, find, export, or import anonymization sessions.");

  sessions
    .command("list")
    .description("List all local sessions.")
    .option("--json", "emit JSON to stdout")
    .action(async (opts) => {
      const { runSessionsList } = await import("./commands/sessions.js");
      process.exit(await runSessionsList(opts));
    });

  sessions
    .command("show")
    .description("Show details for one session.")
    .argument("<session-id>", "session id or unique prefix")
    .option("--json", "emit JSON to stdout")
    .action(async (sid: string, opts) => {
      const { runSessionsShow } = await import("./commands/sessions.js");
      process.exit(await runSessionsShow(sid, opts));
    });

  sessions
    .command("find")
    .description("Find which session(s) include a given file path.")
    .argument("<path>", "file path to look up")
    .option("--json", "emit JSON to stdout")
    .action(async (filePath: string, opts) => {
      const { runSessionsFind } = await import("./commands/sessions.js");
      process.exit(await runSessionsFind(filePath, opts));
    });

  sessions
    .command("export")
    .description("Export an encrypted session archive (.pii-session) for team handoff.")
    .argument("<session-id>", "session id or unique prefix to export")
    .requiredOption("-o, --out <path>", "output archive path")
    .option("-p, --passphrase <p>", "passphrase (prompts if omitted)")
    .action(async (sid: string, opts) => {
      const { runSessionsExport } = await import("./commands/sessions.js");
      process.exit(await runSessionsExport(sid, opts));
    });

  sessions
    .command("import")
    .description("Import a session archive (.pii-session).")
    .argument("<archive>", "path to .pii-session file")
    .option("-p, --passphrase <p>", "passphrase (prompts if omitted)")
    .option("--overwrite", "replace existing session with same id")
    .action(async (arc: string, opts) => {
      const { runSessionsImport } = await import("./commands/sessions.js");
      process.exit(await runSessionsImport(arc, opts));
    });

  await program.parseAsync(process.argv);
}

main().catch(async (err) => {
  // Ctrl-C during a mask prompt: cleanup already ran via the prompt's
  // finally block, but flush any remaining cleanup (e.g. open HITL server)
  // and exit with the standard SIGINT code.
  if (err instanceof PromptInterrupt) {
    await runAllCleanup();
    process.exit(130);
  }
  await runAllCleanup();
  process.stderr.write(`pii-shield: ${err instanceof Error ? err.message : err}\n`);
  if (process.env.PII_DEBUG) {
    process.stderr.write((err as Error).stack + "\n");
  }
  process.exit(1);
});
