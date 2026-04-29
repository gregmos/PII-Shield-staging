/**
 * `pii-shield deanonymize <file> [--session <id>]` — restore PII from placeholders.
 *
 * Session resolution priority:
 *   1. --session arg (explicit)
 *   2. session_id embedded in .docx custom.xml (cross-chat handoff path)
 *   3. latestSessionId() fallback
 */

import fs from "node:fs";
import path from "node:path";
import { initRuntime, withAudit } from "../runtime.js";
import {
  loadMapping,
  latestSessionId,
  isSafeSessionId,
} from "../../../src/mapping/mapping-store.js";
import { readPiiShieldProps } from "../../../src/docx/docx-custom-props.js";
import { deanonymizeDocx } from "../../../src/docx/docx-deanonymizer.js";
import { resolveSessionId, SessionLookupError } from "../session-resolve.js";

interface DeanonymizeOptions {
  session?: string;
  out?: string;
}

function deanonymizeText(text: string, mapping: Record<string, string>): string {
  // Sort placeholders longest-first so <ORG_1a> replaces before <ORG_1>.
  const placeholders = Object.keys(mapping).sort((a, b) => b.length - a.length);
  let result = text;
  for (const ph of placeholders) {
    if (!result.includes(ph)) continue;
    result = result.split(ph).join(mapping[ph]!);
  }
  return result;
}

export async function runDeanonymize(
  filePath: string,
  opts: DeanonymizeOptions,
): Promise<number> {
  initRuntime({ skipNer: true });

  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`Error: file not found: ${abs}\n`);
    return 1;
  }
  const ext = path.extname(abs).toLowerCase();

  let sessionId = (opts.session ?? "").trim();
  let source: "explicit" | "custom_xml" | "latest" = "explicit";
  // If --session was given, expand prefix to a full id.
  if (sessionId) {
    try {
      sessionId = resolveSessionId(sessionId);
    } catch (e) {
      const msg = e instanceof SessionLookupError ? e.message : String(e);
      process.stderr.write(`Error: ${msg}\n`);
      return 1;
    }
  }
  if (!sessionId && ext === ".docx") {
    try {
      const props = await readPiiShieldProps(abs);
      // session_id from .docx metadata is attacker-controllable: validate
      // before letting it flow into mapping-store path construction.
      if (props?.session_id && isSafeSessionId(props.session_id)) {
        sessionId = props.session_id;
        source = "custom_xml";
      } else if (props?.session_id) {
        process.stderr.write(
          `[!] Ignoring session_id from .docx metadata: ${JSON.stringify(props.session_id).slice(0, 80)} — invalid format.\n`,
        );
      }
    } catch {
      /* ignore — fall through */
    }
  }
  if (!sessionId) {
    const latest = latestSessionId();
    if (latest) {
      sessionId = latest;
      source = "latest";
    }
  }
  if (!sessionId) {
    process.stderr.write(
      `Error: no session_id available. Pass --session <id> or supply a .docx anonymized by PII Shield (session embedded in metadata).\n`,
    );
    return 1;
  }

  const mapping = loadMapping(sessionId);
  if (!mapping || Object.keys(mapping).length === 0) {
    process.stderr.write(
      `Error: mapping not found for session '${sessionId}'.\n` +
        (source === "custom_xml"
          ? `The file's metadata references this session, but the mapping is missing locally.\n` +
            `If the mapping lives on another machine, run \`pii-shield sessions import <archive>\`.\n`
          : `Run \`pii-shield sessions list\` to see available sessions.\n`),
    );
    return 1;
  }

  return withAudit(
    "deanonymize_cli",
    { file: abs, session_id: sessionId, session_source: source, ext },
    async () => {
      if (ext === ".docx") {
        const restored = await deanonymizeDocx(abs, mapping);
        const finalOut = opts.out
          ? path.resolve(opts.out)
          : restored;
        if (opts.out && finalOut !== restored) {
          fs.copyFileSync(restored, finalOut);
          fs.unlinkSync(restored);
        }
        process.stdout.write(`Restored: ${finalOut}\n`);
        process.stdout.write(`Session: ${sessionId} (source: ${source})\n`);
        return 0;
      }

      // Plain text / .txt / .md / .csv / etc.
      const text = fs.readFileSync(abs, "utf8");
      const restored = deanonymizeText(text, mapping);
      const base = path.basename(abs, ext);
      const dir = path.dirname(abs);
      const finalOut = opts.out
        ? path.resolve(opts.out)
        : path.join(dir, `${base}_restored${ext}`);
      fs.writeFileSync(finalOut, restored, "utf8");
      process.stdout.write(`Restored: ${finalOut}\n`);
      process.stdout.write(`Session: ${sessionId} (source: ${source})\n`);
      return 0;
    },
  );
}
