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
  /** Directory where the standalone review HTML was written. This is the
   *  primary place to look for the decisions JSON, because in Cowork the
   *  VM's `~/Downloads` is NOT the host's Downloads — the workspace mount
   *  is the only path the VM and host share. Set by `start_review`. */
  workspace_dir?: string;
  /** Host-form equivalent of workspace_dir, passed in by the skill from
   *  `resolve_path(marker)`. Displayed to the user in the start_review
   *  user_message so they see a real path, not a /sessions/.../mnt/... VM path. */
  host_workspace_dir?: string;
  /** Original file basename — used as a human-friendly label in BULK user_message. */
  source_filename?: string;
  /** Base64 32-byte AES-256-GCM key for encrypting review decisions in transit
   *  through the LLM (so PII the user added in the review never appears as
   *  plaintext in conversation history). Server keeps this secret; HTML
   *  receives a copy embedded in the standalone payload. */
  review_secret?: string;
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
  } catch (e) {
    console.error(`[Review] disk write failed (in-memory OK): ${e}`);
  }
}

/** Get review data: memory first, then disk */
export function getReview(sessionId: string): ReviewData | null {
  // Memory first
  const memData = _reviews.get(sessionId);
  if (memData) return memData;

  // Disk fallback
  try {
    const filePath = path.join(PATHS.MAPPINGS_DIR, `review_${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ReviewData;
      // Cache in memory
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

/** Get review status (PII-safe — no entity details) */
export function getReviewStatus(sessionId: string): {
  status: string;
  has_changes: boolean;
} {
  const data = getReview(sessionId);
  if (!data) {
    return { status: "not_found", has_changes: false };
  }

  if (data.approved) {
    const hasChanges = !!(
      data.overrides &&
      ((data.overrides.remove && data.overrides.remove.length > 0) ||
        (data.overrides.add && data.overrides.add.length > 0))
    );
    return { status: "approved", has_changes: hasChanges };
  }

  return { status: "pending", has_changes: false };
}
