/**
 * PII Shield v2.0.0 — Mapping persistence
 * Ported from pii_shield_server.py lines 395-445
 *
 * In-memory primary + disk fallback at PATHS.MAPPINGS_DIR
 * (= ${CLAUDE_PLUGIN_DATA}/mappings or legacy ~/.pii_shield/mappings).
 * TTL-based cleanup (default 7 days).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS, ENV } from "../utils/config.js";
import {
  serializePlaceholderState,
  deserializePlaceholderState,
  reconstructPlaceholderState,
  type PlaceholderState,
  type SerializedPlaceholderState,
} from "../engine/entity-dedup.js";

/**
 * Per-document record kept in `MappingData.metadata.documents[]`. Tracks
 * which files have been anonymized into this session so downstream tools
 * can verify the file's source_hash and timeline of additions.
 */
export interface MappingDocumentEntry {
  doc_id: string;          // ULID-ish; distinguishes N docs in one session
  source_path: string;     // absolute path at anonymize time
  source_hash: string;     // "sha256:..." of original bytes
  anonymized_at: string;   // ISO-8601 UTC
}

/** Shape of the `metadata` object we write — generic dict with known extras. */
export interface MappingMetaExtras {
  placeholder_state?: SerializedPlaceholderState;
  documents?: MappingDocumentEntry[];
  source?: string;                       // legacy: single source path; kept for BC
  [k: string]: unknown;
}

export interface MappingData {
  session_id: string;
  mapping: Record<string, string>;
  metadata: MappingMetaExtras;
  timestamp: number;
}

// In-memory primary store
const _inMemory = new Map<string, MappingData>();

function ensureDir(): void {
  try {
    fs.mkdirSync(PATHS.MAPPINGS_DIR, { recursive: true });
  } catch {
    // will retry on save; in-memory fallback always works
  }
}

ensureDir();

/**
 * Generate a new session ID with a human-readable timestamp prefix.
 *
 * Format: `YYYY-MM-DD_HHMMSS_XXXX` — local time, 22 characters,
 * filesystem-safe, lexicographically sortable (so the mappings dir lists
 * chronologically in any file manager). Legacy UUID-based session_ids
 * created by older installs still resolve via `loadMapping(sessionId)` —
 * session_id is opaque to the server, filename is just `<session_id>.json`.
 *
 * Collisions within the same second are guarded by 16 bits of randomness
 * (65 K space — enough for interactive anonymize bursts; `saveMapping`'s
 * atomic rename would overwrite on true collision, which is benign here).
 */
export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = crypto.randomBytes(2).toString("hex");
  return `${date}_${time}_${rand}`;
}

/** Save mapping to memory + disk */
export function saveMapping(
  sessionId: string,
  mapping: Record<string, string>,
  metadata: Record<string, unknown> = {},
): string {
  const data: MappingData = {
    session_id: sessionId,
    mapping,
    metadata,
    timestamp: Date.now() / 1000,
  };

  // Always keep in memory first
  _inMemory.set(sessionId, data);

  // Try to persist to disk
  let diskPath: string | null = null;
  try {
    ensureDir();
    const filePath = path.join(PATHS.MAPPINGS_DIR, `${sessionId}.json`);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
    diskPath = filePath;
  } catch (e) {
    console.error(`[Mapping] disk write failed (in-memory OK): ${e}`);
  }

  return diskPath || `memory://${sessionId}`;
}

/** Load mapping by session ID */
export function loadMapping(sessionId: string): Record<string, string> {
  // Try disk first
  try {
    const filePath = path.join(PATHS.MAPPINGS_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as MappingData;
      // Cache in memory
      _inMemory.set(sessionId, data);
      return data.mapping || {};
    }
  } catch (e) {
    console.error(`[Mapping] disk read failed: ${e}`);
  }

  // Fallback to in-memory
  const memData = _inMemory.get(sessionId);
  if (memData) return memData.mapping || {};

  return {};
}

/**
 * Load the full MappingData record (mapping + metadata + timestamp).
 * Returns null if the session doesn't exist on disk or in memory.
 */
export function loadMappingData(sessionId: string): MappingData | null {
  try {
    const filePath = path.join(PATHS.MAPPINGS_DIR, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as MappingData;
      if (!data.metadata || typeof data.metadata !== "object") data.metadata = {};
      _inMemory.set(sessionId, data);
      return data;
    }
  } catch (e) {
    console.error(`[Mapping] disk read failed: ${e}`);
  }
  const mem = _inMemory.get(sessionId);
  return mem || null;
}

/**
 * Load a session as the three things the anonymize pipeline needs to
 * extend it: mapping, live PlaceholderState, and the documents list.
 *
 * If the session has no serialized placeholder_state (legacy session from
 * before multi-file support), the state is best-effort reconstructed from
 * the mapping via `reconstructPlaceholderState`.
 *
 * Returns null if the session doesn't exist.
 */
export function loadSessionState(sessionId: string): {
  mapping: Record<string, string>;
  state: PlaceholderState;
  documents: MappingDocumentEntry[];
} | null {
  const data = loadMappingData(sessionId);
  if (!data) return null;
  const meta = data.metadata || {};
  let state: PlaceholderState;
  if (meta.placeholder_state) {
    try {
      state = deserializePlaceholderState(meta.placeholder_state);
    } catch (e) {
      console.error(`[Mapping] deserialize state failed, reconstructing: ${e}`);
      state = reconstructPlaceholderState(data.mapping);
    }
  } else {
    state = reconstructPlaceholderState(data.mapping);
  }
  const documents = Array.isArray(meta.documents) ? meta.documents : [];
  return { mapping: data.mapping, state, documents };
}

/**
 * Save a session with its live PlaceholderState and documents list
 * serialized inside metadata. Thin wrapper around `saveMapping` — uses
 * `state.mapping` as the canonical mapping and serializes the rest of
 * state into `metadata.placeholder_state`.
 *
 * If the session already has a `documents` list in memory/disk and the
 * caller doesn't pass one, the existing list is preserved.
 */
export function saveSessionState(
  sessionId: string,
  args: {
    state: PlaceholderState;
    documents?: MappingDocumentEntry[];
    extraMetadata?: Record<string, unknown>;
  },
): string {
  const existingMeta = (_inMemory.get(sessionId)?.metadata) || {};
  const metadata: MappingMetaExtras = {
    ...existingMeta,
    ...(args.extraMetadata || {}),
    placeholder_state: serializePlaceholderState(args.state),
    documents: args.documents ?? existingMeta.documents ?? [],
  };
  return saveMapping(sessionId, args.state.mapping, metadata);
}

/** Check if a session exists on disk or in memory. */
export function sessionExists(sessionId: string): boolean {
  if (_inMemory.has(sessionId)) return true;
  try {
    const filePath = path.join(PATHS.MAPPINGS_DIR, `${sessionId}.json`);
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Get mapping metadata (placeholder keys + types, no real PII values) */
export function getMappingSafe(sessionId: string): Record<string, string> {
  const mapping = loadMapping(sessionId);
  const safe: Record<string, string> = {};
  for (const placeholder of Object.keys(mapping)) {
    // Extract tag from placeholder: <EMAIL_1> → EMAIL, <D1_ORG_2a> → ORG
    // Format: <[PREFIX_]TAG_NUMBER[variant]>
    const inner = placeholder.replace(/^</, "").replace(/>$/, "");
    const parts = inner.split("_");
    // Tag is the part before the last segment (which is the number+variant)
    // e.g. "EMAIL_1" → tag=EMAIL, "UK_NIN_1" → tag=UK_NIN, "D1_ORG_2a" → tag=ORG
    if (parts.length >= 2) {
      // Last part is number[variant], everything before is tag (possibly with prefix)
      parts.pop();
      // If first part looks like a prefix (D1, D2, etc.), remove it
      if (parts.length > 1 && /^D\d+$/.test(parts[0])) {
        parts.shift();
      }
      safe[placeholder] = parts.join("_");
    } else {
      safe[placeholder] = "UNKNOWN";
    }
  }
  return safe;
}

/** Find the latest session by file modification time */
export function latestSessionId(): string | null {
  // Check disk first
  try {
    const files = fs.readdirSync(PATHS.MAPPINGS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("review_"));

    if (files.length > 0) {
      let latest = "";
      let latestMtime = 0;
      for (const f of files) {
        const stat = fs.statSync(path.join(PATHS.MAPPINGS_DIR, f));
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latest = f.replace(".json", "");
        }
      }
      if (latest) return latest;
    }
  } catch {
    // fall through to in-memory
  }

  // Check in-memory
  let latest = "";
  let latestTs = 0;
  for (const [sid, data] of _inMemory) {
    if (!sid.startsWith("review:") && data.timestamp > latestTs) {
      latestTs = data.timestamp;
      latest = sid;
    }
  }

  return latest || null;
}

/** Cleanup mappings older than TTL */
export function cleanupOldMappings(): void {
  const cutoffSec = Date.now() / 1000 - ENV.PII_MAPPING_TTL_DAYS * 86400;
  let removed = 0;

  try {
    const files = fs.readdirSync(PATHS.MAPPINGS_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const filePath = path.join(PATHS.MAPPINGS_DIR, f);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs / 1000 < cutoffSec) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {
        // skip individual file errors
      }
    }
  } catch {
    // dir doesn't exist or not readable
  }

  if (removed) {
    console.error(`[Mapping] Cleaned up ${removed} expired mappings (>${ENV.PII_MAPPING_TTL_DAYS} days)`);
  }
}
