/**
 * PII Shield v2.0.0 — Review session persistence
 * Ported from pii_shield_server.py lines 447-478
 *
 * Stores HITL review data (entity list, overrides, approval status).
 * Memory-first with disk fallback at PATHS.MAPPINGS_DIR/review_{sid}.json
 * (reviews share the mappings/ dir so latestSessionId() can filter them out
 * via the `review_` prefix — keeps parity with the Python reference impl).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../utils/config.js";
import { logServer } from "../audit/audit-logger.js";

export interface ReviewData {
  session_id: string;
  entities: Array<{
    text: string;
    type: string;
    start: number;
    end: number;
    score?: number;
    placeholder: string;
  }>;
  original_text?: string;
  anonymized_text?: string;
  html_text?: string;
  overrides?: {
    remove: number[];
    add: Array<{ text: string; type: string; start: number; end: number }>;
  };
  approved?: boolean;
  timestamp: number;
  output_dir?: string;
  /** Original file basename — used as a human-friendly label in BULK user_message. */
  source_filename?: string;
  /**
   * Paths produced by the FIRST `anonymize_file` call for this session.
   * Preserved so that a subsequent `anonymize_file(..., review_session_id=sid)`
   * call — used by the skill's unconditional re-anonymize flow — can return
   * these unchanged when the user approved without edits (`approved_no_changes`
   * branch). Avoids re-running the NER pipeline when nothing actually changed.
   */
  output_path_original?: string;
  docx_output_path_original?: string;
  /** Absolute host path of the source document (input to the first
   *  anonymize_file call). Used to recompute `output_rel_path` for
   *  `approved_no_changes` responses without asking the caller to re-send it. */
  source_file_path?: string;
  /** Set to the error code (e.g. "ENOSPC") if the disk write in saveReview
   *  failed. Surfaced by start_review so the user knows in-memory state is
   *  all we have — a process restart will lose the review. */
  _disk_write_failed?: string;
}

// In-memory store
const _reviews = new Map<string, ReviewData>();

function ensureDir(): void {
  try {
    fs.mkdirSync(PATHS.MAPPINGS_DIR, { recursive: true });
  } catch {
    // will retry
  }
}

/** Save review data to memory + disk */
export function saveReview(sessionId: string, data: ReviewData): void {
  _reviews.set(sessionId, data);

  try {
    ensureDir();
    const filePath = path.join(PATHS.MAPPINGS_DIR, `review_${sessionId}.json`);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
    // Clear any stale failure flag from a prior attempt.
    if (data._disk_write_failed) delete data._disk_write_failed;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code || "UNKNOWN";
    data._disk_write_failed = code;
    const msg = `[Review] disk write FAILED for session=${sessionId} code=${code} dir=${PATHS.MAPPINGS_DIR} err=${e}. ` +
      `In-memory copy kept, but a process restart will lose the review.`;
    console.error(msg);
    try { logServer(msg); } catch { /* audit dir may not exist yet */ }
  }
}

/** Get review data: memory first, then disk. */
export function getReview(sessionId: string): ReviewData | null {
  // Memory first
  const memData = _reviews.get(sessionId);
  if (memData) return memData;

  // Disk fallback — current mappings dir only. Cross-workspace drift is
  // handled upstream by the marker-lookup BFS in config.ts getDataDir().
  try {
    const filePath = path.join(PATHS.MAPPINGS_DIR, `review_${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ReviewData;
      _reviews.set(sessionId, data);
      return data;
    }
  } catch (e) {
    console.error(`[Review] disk read failed: ${e}`);
  }

  return null;
}

/** Update review overrides (from HITL UI) */
export function updateReviewOverrides(
  sessionId: string,
  overrides: ReviewData["overrides"],
): void {
  const data = getReview(sessionId);
  if (!data) return;
  data.overrides = overrides;
  saveReview(sessionId, data);
}

/** Mark review as approved */
export function approveReview(sessionId: string): void {
  const data = getReview(sessionId);
  if (!data) return;
  data.approved = true;
  saveReview(sessionId, data);
}

