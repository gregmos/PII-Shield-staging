/**
 * `pii-shield review <session-id>` — open the review UI in a browser.
 *
 * After the user approves, any docs with non-empty overrides are
 * re-anonymized against a fresh shared PlaceholderState (so multi-doc
 * placeholder consistency is preserved across the session). Re-runs do NOT
 * call NER — the entity list is taken from the existing review data,
 * mutated by user overrides, and re-placed.
 */

import fs from "node:fs";
import path from "node:path";
import open from "open";
import { initRuntime, withAudit } from "../runtime.js";
import { runReviewServer } from "../hitl-server.js";
import {
  loadSessionState,
  saveSessionState,
  saveMapping,
} from "../../../src/mapping/mapping-store.js";
import { resolveSessionId, SessionLookupError } from "../session-resolve.js";
import {
  getReview,
  updateDocReview,
} from "../../../src/mapping/review-store.js";
import {
  assignPlaceholders,
  createPlaceholderState,
  type PlaceholderState,
} from "../../../src/engine/entity-dedup.js";
import {
  anonymizeDocxWithMapping,
} from "../../../src/docx/docx-anonymizer.js";
import { applyOverridesToEntities } from "../review-overrides.js";

interface ReviewOptions {
  yes?: boolean;
}

async function reanonymizeBatch(sessionId: string): Promise<{
  rewritten: number;
  unchanged: number;
}> {
  const review = getReview(sessionId);
  if (!review) return { rewritten: 0, unchanged: 0 };

  // Detect which docs have non-empty overrides.
  const docsWithChanges = review.documents.filter(
    (d) =>
      (d.overrides?.remove?.length ?? 0) > 0 ||
      (d.overrides?.add?.length ?? 0) > 0,
  );
  if (docsWithChanges.length === 0) {
    return { rewritten: 0, unchanged: review.documents.length };
  }

  // Rebuild entity lists for ALL docs (so dedup state is consistent across
  // docs even though only some have overrides).
  const correctedPerDoc = review.documents.map((doc) => {
    const corrected = applyOverridesToEntities(
      doc.original_text,
      doc.entities,
      doc.overrides ?? { remove: [], add: [] },
    );
    return { doc, corrected };
  });

  // Fresh shared state — re-assign placeholders deterministically across all docs.
  const state: PlaceholderState = createPlaceholderState();
  const finalMapping: Record<string, string> = {};
  let rewritten = 0;

  for (const { doc, corrected } of correctedPerDoc) {
    const { entities: placed, mapping: docMapping } = assignPlaceholders(
      corrected,
      "",
      state,
    );
    Object.assign(finalMapping, docMapping);

    // Apply replacements end-to-start to preserve offsets.
    const sorted = [...placed].sort((a, b) => b.start - a.start);
    let restored = doc.original_text;
    for (const e of sorted) {
      restored = restored.slice(0, e.start) + e.placeholder + restored.slice(e.end);
    }

    // Write text output.
    fs.writeFileSync(doc.output_path_original, restored, "utf8");

    // For .docx, re-write the docx using the placeholder→realText map.
    // anonymizeDocxWithMapping reads the original .docx, applies the mapping,
    // and writes <stem>_anonymized.docx into outDir — same filename as the
    // first pass, so it overwrites the prior output in place.
    if (doc.docx_output_path_original) {
      const placeholderMap: Record<string, string> = {};
      for (const e of placed) {
        if (e.placeholder) placeholderMap[e.placeholder] = e.text;
      }
      const outDir = path.dirname(doc.docx_output_path_original);
      try {
        await anonymizeDocxWithMapping(
          doc.source_file_path,
          placeholderMap,
          outDir,
        );
      } catch (e) {
        process.stderr.write(
          `[!] Failed to re-anonymize docx ${doc.source_file_path}: ${e instanceof Error ? e.message : e}\n`,
        );
      }
    }

    // Mark the per-doc review as approved + update entities to reflect
    // the post-overrides set.
    updateDocReview(sessionId, doc.doc_id, {
      approved: true,
      anonymized_text: restored,
      entities: placed.map((e) => ({
        text: e.text,
        type: e.type,
        start: e.start,
        end: e.end,
        score: e.score,
        placeholder: e.placeholder!,
      })),
    });
    rewritten += 1;
  }

  // Persist updated mapping + state.
  saveMapping(sessionId, finalMapping);
  const sessionState = loadSessionState(sessionId);
  saveSessionState(sessionId, {
    state,
    documents: sessionState?.documents ?? [],
  });

  return { rewritten, unchanged: review.documents.length - rewritten };
}

export async function runReview(
  sessionId: string,
  _opts: ReviewOptions,
): Promise<number> {
  initRuntime({ skipNer: true });

  let sid: string;
  try {
    sid = resolveSessionId(sessionId);
  } catch (e) {
    const msg = e instanceof SessionLookupError ? e.message : String(e);
    process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }
  sessionId = sid;

  return withAudit("review_cli", { session_id: sessionId }, async () => {
    const { url, result } = await runReviewServer(sessionId);
    process.stdout.write(`Review URL: ${url}\n`);
    process.stdout.write(`(Server idle timeout: 30 minutes; UI heartbeats while open)\n\n`);

    try {
      await open(url);
    } catch (e) {
      process.stderr.write(
        `[!] Could not auto-open browser: ${e instanceof Error ? e.message : e}\n`,
      );
      process.stderr.write(`Open the URL above manually.\n`);
    }

    const outcome = await result;

    if (outcome.status === "cancelled") {
      process.stdout.write(`\nReview cancelled.\n`);
      return 1;
    }
    if (outcome.status === "timeout") {
      process.stdout.write(`\nReview timed out (no activity for 30 min).\n`);
      return 1;
    }

    // Distinct doc_ids — outcome.approvals contains one entry per /apply
    // call, which the bulk UI fires once per doc per Approve click, so
    // .length over-counts for multi-doc sessions. Use approvedDocIds when
    // available, else fall back to deduped approvals.
    const approvedCount =
      outcome.approvedDocIds?.length ??
      new Set(outcome.approvals.map((a) => a.doc_id)).size;
    process.stdout.write(`\nReview approved (${approvedCount} doc(s)).\n`);

    // Re-anonymize any docs whose review carries non-empty overrides.
    const { rewritten, unchanged } = await reanonymizeBatch(sessionId);
    if (rewritten > 0) {
      process.stdout.write(
        `Re-anonymized ${rewritten} doc(s) with corrections.\n`,
      );
    }
    if (unchanged > 0) {
      process.stdout.write(
        `${unchanged} doc(s) approved without changes — outputs unchanged.\n`,
      );
    }

    // Print final paths.
    const review = getReview(sessionId);
    if (review) {
      process.stdout.write(`\nFinal outputs:\n`);
      for (const d of review.documents) {
        process.stdout.write(`  ${d.output_path_original}\n`);
        if (d.docx_output_path_original) {
          process.stdout.write(`  ${d.docx_output_path_original}\n`);
        }
      }
    }

    // Anti-warning for unused param.
    void _opts;
    return 0;
  });
}
