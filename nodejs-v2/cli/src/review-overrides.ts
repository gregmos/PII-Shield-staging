/**
 * Apply HITL overrides to a doc's base entity list.
 *
 * Mirrors the private `applyOverridesToEntities` in src/index.ts (around
 * line 158) — duplicated here to avoid importing from index.ts (which
 * starts the MCP server as a side effect).
 *
 * `remove[i]` drops baseEntities[i].
 * `add` propagates each user-added entity across the text via word-boundary
 *   scan so every occurrence is anonymized.
 */

import { deduplicateOverlaps } from "../../src/engine/entity-dedup.js";
import type { DetectedEntity } from "../../src/engine/pattern-recognizers.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface BaseEntity {
  text: string;
  type: string;
  start: number;
  end: number;
  score?: number;
  placeholder?: string;
}

export interface ReviewOverrides {
  remove?: number[];
  add?: Array<{ text: string; type: string; start?: number; end?: number }>;
}

export function applyOverridesToEntities(
  text: string,
  baseEntities: BaseEntity[],
  overrides: ReviewOverrides,
): DetectedEntity[] {
  const removeSet = new Set(overrides.remove ?? []);
  const out: DetectedEntity[] = [];

  baseEntities.forEach((e, i) => {
    if (removeSet.has(i)) return;
    out.push({
      text: e.text,
      type: e.type,
      start: e.start,
      end: e.end,
      score: e.score ?? 1.0,
      verified: true,
      reason: "hitl:kept",
    });
  });

  for (const a of overrides.add ?? []) {
    if (!a.text || a.text.length < 1) continue;
    try {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(a.text)}(?![\\p{L}\\p{N}_])`,
        "giu",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        out.push({
          text: m[0],
          type: a.type,
          start: m.index,
          end: m.index + m[0].length,
          score: 1.0,
          verified: true,
          reason: "hitl:user_added",
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } catch (e) {
      console.error(`[hitl] regex build failed for "${a.text}": ${e}`);
    }
  }

  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return deduplicateOverlaps(out);
}
