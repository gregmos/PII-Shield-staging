/**
 * PII Shield v2.0.0 — Chunk session management
 * Ported from pii_shield_server.py lines 1728-1791, 2047-2082
 *
 * Manages state for chunked processing of large documents (>15K chars).
 * Each session tracks: chunks, entity counters, mapping, progress.
 * TTL: 30 minutes.
 */

import crypto from "node:crypto";
import { CHUNK } from "../utils/config.js";
import { PIIEngine } from "../engine/pii-engine.js";
import { splitParagraphs } from "./paragraph-splitter.js";
import type { DetectedEntity } from "../engine/pattern-recognizers.js";
import type { PlaceholderEntity } from "../engine/entity-dedup.js";
import { TAG_NAMES } from "../engine/entity-types.js";

export interface ChunkSession {
  text: string;
  chunks: string[];
  currentChunk: number;
  typeCounters: Map<string, number>;
  seenExact: Map<string, string>;
  seenFamily: Map<string, { familyNumber: number; variantCounter: number }>;
  mapping: Record<string, string>;
  allEntities: PlaceholderEntity[];
  prefix: string;
  language: string;
  sourcePath: string;
  sourceSuffix: string;
  charsPerSec: number;
  optimalChunkSize: number;
  entityOverrides: string;
  docxHtml: string | null;
  createdAt: number;
}

const _sessions = new Map<string, ChunkSession>();

/** Create a new chunk session */
export function createChunkSession(opts: {
  text: string;
  chunkSize: number;
  prefix: string;
  language: string;
  sourcePath: string;
  sourceSuffix: string;
  charsPerSec: number;
  entityOverrides: string;
  docxHtml: string | null;
}): { sessionId: string; session: ChunkSession } {
  cleanupStaleSessions();

  const chunks = splitParagraphs(opts.text, opts.chunkSize);
  const sessionId = crypto.randomBytes(6).toString("hex");

  const session: ChunkSession = {
    text: opts.text,
    chunks,
    currentChunk: 0,
    typeCounters: new Map(),
    seenExact: new Map(),
    seenFamily: new Map(),
    mapping: {},
    allEntities: [],
    prefix: opts.prefix,
    language: opts.language,
    sourcePath: opts.sourcePath,
    sourceSuffix: opts.sourceSuffix,
    charsPerSec: opts.charsPerSec,
    optimalChunkSize: opts.chunkSize,
    entityOverrides: opts.entityOverrides,
    docxHtml: opts.docxHtml,
    createdAt: Date.now(),
  };

  _sessions.set(sessionId, session);
  return { sessionId, session };
}

/** Get an existing chunk session */
export function getChunkSession(sessionId: string): ChunkSession | null {
  return _sessions.get(sessionId) || null;
}

/** Process the current chunk in a session */
export async function processChunk(sessionId: string): Promise<PlaceholderEntity[]> {
  const cs = _sessions.get(sessionId);
  if (!cs) throw new Error(`Chunk session not found: ${sessionId}`);
  if (cs.currentChunk >= cs.chunks.length) return [];

  const engine = PIIEngine.getInstance();
  const chunkIdx = cs.currentChunk;
  const chunkText = cs.chunks[chunkIdx];

  // Detect entities in this chunk
  const entities = await engine.detect(chunkText, cs.language);

  // Calculate offset for this chunk in the full text
  let offset = 0;
  for (let i = 0; i < chunkIdx; i++) {
    offset += cs.chunks[i].length + 2; // +2 for \n\n separator
  }

  // Assign placeholders using shared state across all chunks
  const confirmed: PlaceholderEntity[] = [];
  for (const e of entities.sort((a, b) => a.start - b.start)) {
    const placeholder = getOrCreatePlaceholderShared(
      e.type, e.text, cs.typeCounters, cs.seenExact, cs.seenFamily, cs.mapping, cs.prefix,
    );
    confirmed.push({
      ...e,
      start: e.start + offset,
      end: e.end + offset,
      placeholder,
    });
  }

  cs.allEntities.push(...confirmed);
  cs.currentChunk = chunkIdx + 1;
  return confirmed;
}

/** Finalize: assemble anonymized text from all chunks */
export function finalizeChunkSession(sessionId: string): {
  anonymizedText: string;
  mapping: Record<string, string>;
  entityCount: number;
} {
  const cs = _sessions.get(sessionId);
  if (!cs) throw new Error(`Chunk session not found: ${sessionId}`);

  // Replace entities in full text (from end to start)
  let result = cs.text;
  const sorted = [...cs.allEntities].sort((a, b) => b.start - a.start);
  for (const e of sorted) {
    result = result.slice(0, e.start) + e.placeholder + result.slice(e.end);
  }

  // Clean up session
  _sessions.delete(sessionId);

  return {
    anonymizedText: result,
    mapping: cs.mapping,
    entityCount: cs.allEntities.length,
  };
}

/** Remove sessions older than TTL */
function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [sid, cs] of _sessions) {
    if (now - cs.createdAt > CHUNK.SESSION_TTL_MS) {
      _sessions.delete(sid);
    }
  }
}

// ── Shared placeholder logic (reuses state across chunks) ────────────────────

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/[.,;:]+$/, "").replace(/\s+/g, " ");
}

function getOrCreatePlaceholderShared(
  etype: string,
  text: string,
  typeCounters: Map<string, number>,
  seenExact: Map<string, string>,
  seenFamily: Map<string, { familyNumber: number; variantCounter: number }>,
  mapping: Record<string, string>,
  prefix: string,
): string {
  const norm = normalize(text);
  const exactKey = `${etype}::${norm}`;

  if (seenExact.has(exactKey)) {
    return seenExact.get(exactKey)!;
  }

  const tag = TAG_NAMES[etype] || etype;
  let familyKey: string | null = null;

  if (norm.length >= 4) {
    for (const [key] of seenFamily) {
      const [ft, fn] = key.split("::", 2);
      if (ft !== etype) continue;
      if (fn.length >= 4 && (norm.includes(fn) || fn.includes(norm))) {
        familyKey = key;
        break;
      }
    }
  }

  let placeholder: string;

  if (familyKey) {
    const info = seenFamily.get(familyKey)!;
    info.variantCounter++;
    const suffix = info.variantCounter <= 26
      ? String.fromCharCode(96 + info.variantCounter)
      : String(info.variantCounter);
    placeholder = prefix ? `<${prefix}_${tag}_${info.familyNumber}${suffix}>` : `<${tag}_${info.familyNumber}${suffix}>`;
  } else {
    const count = (typeCounters.get(etype) || 0) + 1;
    typeCounters.set(etype, count);
    placeholder = prefix ? `<${prefix}_${tag}_${count}>` : `<${tag}_${count}>`;
    seenFamily.set(`${etype}::${norm}`, { familyNumber: count, variantCounter: 0 });
  }

  seenExact.set(exactKey, placeholder);
  mapping[placeholder] = text;
  return placeholder;
}
