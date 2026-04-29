/**
 * `pii-shield sessions <list|show|export|import>` — session management.
 */

import fs from "node:fs";
import path from "node:path";
import { initRuntime, withAudit } from "../runtime.js";
import { PATHS } from "../../../src/utils/config.js";
import {
  loadMappingData,
} from "../../../src/mapping/mapping-store.js";
import { getReview } from "../../../src/mapping/review-store.js";
import {
  exportSessionToFile,
  importSessionFromFile,
} from "../../../src/portability/session-archive.js";
import { promptString } from "../prompts.js";
import { resolveSessionId, SessionLookupError } from "../session-resolve.js";

function tryResolve(input: string): string | null {
  try {
    return resolveSessionId(input);
  } catch (e) {
    const msg = e instanceof SessionLookupError ? e.message : String(e);
    process.stderr.write(`Error: ${msg}\n`);
    return null;
  }
}

interface ListOptions {
  json?: boolean;
}

interface ShowOptions {
  json?: boolean;
}

interface ExportOptions {
  passphrase?: string;
  out: string;
}

interface ImportOptions {
  passphrase?: string;
  overwrite?: boolean;
}

interface FindOptions {
  json?: boolean;
}

export async function runSessionsList(opts: ListOptions): Promise<number> {
  initRuntime({ skipNer: true });
  const dir = PATHS.MAPPINGS_DIR;
  if (!fs.existsSync(dir)) {
    if (opts.json) process.stdout.write("[]\n");
    else process.stdout.write(`(no sessions in ${dir})\n`);
    return 0;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("review_"))
    .sort()
    .reverse();

  const rows = files.map((f) => {
    const sid = f.replace(/\.json$/, "");
    const stat = fs.statSync(path.join(dir, f));
    let docCount = 0;
    let entityCount = 0;
    try {
      const data = loadMappingData(sid);
      if (data) {
        entityCount = Object.keys(data.mapping).length;
        const docs = (data.metadata as { documents?: unknown[] })?.documents;
        docCount = Array.isArray(docs) ? docs.length : 0;
      }
    } catch {
      /* corrupt — show 0 */
    }
    return {
      session_id: sid,
      modified: stat.mtime.toISOString(),
      docs: docCount,
      entities: entityCount,
    };
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }

  if (rows.length === 0) {
    process.stdout.write(`(no sessions)\n`);
    return 0;
  }
  process.stdout.write(
    `${"session_id".padEnd(24)}  ${"modified".padEnd(22)}  docs  entities\n`,
  );
  process.stdout.write(`${"".padEnd(70, "-")}\n`);
  for (const r of rows) {
    process.stdout.write(
      `${r.session_id.padEnd(24)}  ${r.modified.padEnd(22)}  ${String(r.docs).padStart(4)}  ${String(r.entities).padStart(8)}\n`,
    );
  }
  return 0;
}

export async function runSessionsShow(
  sessionId: string,
  opts: ShowOptions,
): Promise<number> {
  initRuntime({ skipNer: true });
  const sid = tryResolve(sessionId);
  if (!sid) return 1;
  sessionId = sid;
  const data = loadMappingData(sessionId);
  if (!data) {
    process.stderr.write(`Error: session '${sessionId}' not found.\n`);
    return 1;
  }
  const review = getReview(sessionId);
  const docs =
    (data.metadata as { documents?: Array<Record<string, unknown>> }).documents ?? [];

  const summary = {
    session_id: sessionId,
    timestamp: new Date(data.timestamp * 1000).toISOString(),
    entity_count: Object.keys(data.mapping).length,
    documents: docs.map((d) => ({
      doc_id: d.doc_id,
      source_path: d.source_path,
      source_hash: d.source_hash,
      anonymized_at: d.anonymized_at,
    })),
    review: review
      ? {
          documents: review.documents.length,
          approved_count: review.documents.filter((d) => d.approved).length,
        }
      : null,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Session ${sessionId}\n`);
  process.stdout.write(`  Created:    ${summary.timestamp}\n`);
  process.stdout.write(`  Entities:   ${summary.entity_count}\n`);
  process.stdout.write(`  Documents:  ${summary.documents.length}\n`);
  for (const d of summary.documents) {
    process.stdout.write(`    - ${d.source_path}\n`);
    process.stdout.write(`      doc_id=${d.doc_id} hash=${d.source_hash}\n`);
  }
  if (summary.review) {
    process.stdout.write(
      `  Review:     ${summary.review.approved_count}/${summary.review.documents} approved\n`,
    );
  } else {
    process.stdout.write(`  Review:     (none)\n`);
  }
  return 0;
}

async function readPassphrase(initial: string | undefined, action: string): Promise<string> {
  if (initial && initial.length > 0) return initial;
  const value = await promptString(`Passphrase to ${action}:`, { mask: true });
  if (!value) {
    throw new Error("Passphrase is required");
  }
  return value;
}

export async function runSessionsExport(
  sessionId: string,
  opts: ExportOptions,
): Promise<number> {
  initRuntime({ skipNer: true });
  const sid = tryResolve(sessionId);
  if (!sid) return 1;
  sessionId = sid;
  const passphrase = await readPassphrase(opts.passphrase, "encrypt");
  const outPath = path.resolve(opts.out);

  return withAudit("sessions_export_cli", { session_id: sessionId, out: outPath }, async () => {
    const result = await exportSessionToFile(sessionId, passphrase, outPath);
    process.stdout.write(
      `Exported session ${sessionId} → ${result.archive_path} (${(result.archive_size_bytes / 1024).toFixed(1)} KB)\n`,
    );
    process.stdout.write(
      `Send the .pii-session file to your colleague — they need the passphrase to decrypt.\n`,
    );
    return 0;
  });
}

/**
 * `pii-shield sessions find <path>` — find sessions that include a file.
 *
 * Linear scan over all session JSONs in MAPPINGS_DIR. Compares the supplied
 * path (resolved + normalised) against every `metadata.documents[].source_path`.
 */
export async function runSessionsFind(
  filePath: string,
  opts: FindOptions,
): Promise<number> {
  initRuntime({ skipNer: true });
  const target = path.resolve(filePath);

  const dir = PATHS.MAPPINGS_DIR;
  if (!fs.existsSync(dir)) {
    if (opts.json) process.stdout.write("[]\n");
    else process.stdout.write(`(no sessions in ${dir})\n`);
    return 0;
  }

  const sessionFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("review_"));

  type Hit = {
    session_id: string;
    doc_id: string;
    source_path: string;
    anonymized_at: string;
  };
  const hits: Hit[] = [];

  for (const f of sessionFiles) {
    const sid = f.replace(/\.json$/, "");
    let data;
    try {
      data = loadMappingData(sid);
    } catch {
      continue;
    }
    if (!data) continue;
    const docs = (data.metadata as { documents?: Array<Record<string, unknown>> })
      .documents;
    if (!Array.isArray(docs)) continue;
    for (const d of docs) {
      const sp = d.source_path;
      if (typeof sp !== "string") continue;
      if (path.resolve(sp) !== target) continue;
      hits.push({
        session_id: sid,
        doc_id: String(d.doc_id ?? ""),
        source_path: sp,
        anonymized_at: String(d.anonymized_at ?? ""),
      });
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
    return hits.length === 0 ? 1 : 0;
  }

  if (hits.length === 0) {
    process.stdout.write(`No sessions reference ${target}\n`);
    return 1;
  }
  process.stdout.write(`Found ${hits.length} session(s) including ${target}:\n`);
  for (const h of hits) {
    process.stdout.write(`  ${h.session_id}  doc_id=${h.doc_id}  ${h.anonymized_at}\n`);
  }
  return 0;
}

export async function runSessionsImport(
  archivePath: string,
  opts: ImportOptions,
): Promise<number> {
  initRuntime({ skipNer: true });
  const abs = path.resolve(archivePath);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`Error: archive not found: ${abs}\n`);
    return 1;
  }
  const passphrase = await readPassphrase(opts.passphrase, "decrypt");
  return withAudit("sessions_import_cli", { archive: abs, overwrite: opts.overwrite }, async () => {
    try {
      const result = await importSessionFromFile(abs, passphrase, {
        overwrite: opts.overwrite,
      });
      process.stdout.write(
        `Imported session ${result.session_id} (${result.document_count} doc(s), review=${result.had_review}, overwritten=${result.overwritten}).\n`,
      );
      return 0;
    } catch (e) {
      process.stderr.write(
        `Import failed: ${e instanceof Error ? e.message : e}\n`,
      );
      return 1;
    }
  });
}
