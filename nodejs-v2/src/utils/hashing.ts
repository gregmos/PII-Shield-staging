/**
 * PII Shield v2.1 — SHA-256 helpers.
 *
 * Used to tag anonymized .docx with source file integrity so that
 * deanonymize_docx can detect and warn on source/content drift.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

/**
 * Compute SHA-256 of a file's contents via streaming (avoids loading the
 * whole file into memory — safe for multi-MB .pdf / .docx sources).
 * Returns lowercase hex, no prefix.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/** Compute SHA-256 of an in-memory buffer. Lowercase hex, no prefix. */
export function sha256Buffer(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Compute SHA-256 of a UTF-8 string. Lowercase hex, no prefix. */
export function sha256String(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Format a raw hex hash as the `sha256:...` form used in .docx custom.xml
 * so that future algorithms can be swapped in without breaking readers.
 */
export function formatSha256(hex: string): string {
  return `sha256:${hex}`;
}

/** Parse a "sha256:HEX" string; returns null if prefix or hex is invalid. */
export function parseSha256(value: string): string | null {
  if (!value.startsWith("sha256:")) return null;
  const hex = value.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}
