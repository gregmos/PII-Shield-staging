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

interface MappingData {
  session_id: string;
  mapping: Record<string, string>;
  metadata: Record<string, unknown>;
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

/** Generate a new session ID */
export function newSessionId(): string {
  return crypto.randomUUID();
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
