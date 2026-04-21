/**
 * PII Shield v2.1 — Session portability (export / import).
 *
 * Serialises a session (mapping + metadata + optional review data) into a
 * passphrase-encrypted archive for team handoff between machines. Uses only
 * Node built-in crypto + the already-vendored jszip dep — no new deps, no
 * external crypto libraries in the supply chain.
 *
 * ## Wire format (`.pii-session`)
 *
 * Byte layout, little is endian-sensitive:
 *
 *   offset  size  field
 *   ──────  ────  ─────
 *        0     4  MAGIC  = "PII1"
 *        4     1  FORMAT_VERSION = 0x01
 *        5     3  reserved (must be zero)
 *        8    16  salt (scrypt)
 *       24    12  nonce (AES-GCM IV)
 *       36     4  ciphertext_len (uint32 big-endian)
 *       40    CT  ciphertext (len bytes)
 *    40+CT    16  AES-GCM auth tag
 *
 * Plaintext is a ZIP containing:
 *   - manifest.json   { archive_version, session_id, created_at, source_hash_sha256 }
 *   - mapping.json    full MappingData (mapping + metadata incl. placeholder_state + documents[])
 *   - review.json     ReviewData (optional — absent if HITL never ran)
 *
 * ## Crypto choice
 *
 * - AES-256-GCM for authenticated encryption: 32-byte key, 12-byte nonce,
 *   16-byte auth tag. Wrong passphrase → decryption fails loudly on `final()`.
 * - scrypt (N=16384, r=8, p=1) for passphrase KDF: industry-standard
 *   memory-hard function, Node built-in, no deps. Approximately 100 ms per
 *   derive on modern CPUs — slow enough to resist offline brute force with
 *   weak passphrases, fast enough for interactive use.
 * - Random 16-byte salt and 12-byte nonce per export.
 *
 * No forward secrecy, no asymmetric sharing — intentional scope limit.
 * Passphrase must travel to the recipient out-of-band (Signal, phone, etc.).
 */

import fs from "node:fs";
import crypto from "node:crypto";
import JSZip from "jszip";
import {
  loadMappingData,
  saveMapping,
  sessionExists,
  type MappingData,
  type MappingMetaExtras,
} from "../mapping/mapping-store.js";
import {
  getReview,
  saveReview,
  type ReviewData,
} from "../mapping/review-store.js";

const MAGIC = Buffer.from("PII1", "ascii");
const FORMAT_VERSION = 0x01;
const HEADER_LEN = 4 + 4 + 16 + 12 + 4; // magic + version/reserved + salt + nonce + ct_len
const AUTH_TAG_LEN = 16;
const SCRYPT_KEY_LEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface SessionManifest {
  archive_version: 1;
  session_id: string;
  created_at: string;
  source_hash_sha256: string; // SHA-256 of mapping.json plaintext (integrity)
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      passphrase, salt, SCRYPT_KEY_LEN, SCRYPT_OPTS,
      (err, key) => (err ? reject(err) : resolve(key as Buffer)),
    );
  });
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * Build an encrypted archive buffer for the given session. The caller is
 * responsible for writing the buffer to disk (or transferring it otherwise).
 *
 * Throws when the session doesn't exist or the passphrase is too short.
 */
export async function exportSession(
  sessionId: string,
  passphrase: string,
): Promise<Buffer> {
  if (!passphrase || passphrase.length < 4) {
    throw new Error("Passphrase must be at least 4 characters long");
  }
  const data = loadMappingData(sessionId);
  if (!data) {
    throw new Error(`Session '${sessionId}' not found`);
  }

  const review = getReview(sessionId);
  const mappingJson = JSON.stringify(data, null, 2);
  const manifest: SessionManifest = {
    archive_version: 1,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    source_hash_sha256: crypto
      .createHash("sha256")
      .update(mappingJson, "utf-8")
      .digest("hex"),
  };

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("mapping.json", mappingJson);
  if (review) {
    zip.file("review.json", JSON.stringify(review, null, 2));
  }
  const innerBuf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(innerBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(ct.length, 0);
  return Buffer.concat([
    MAGIC,                                            // 4
    Buffer.from([FORMAT_VERSION, 0, 0, 0]),           // 4
    salt,                                             // 16
    nonce,                                            // 12
    lenBuf,                                           // 4
    ct,                                               // variable
    authTag,                                          // 16
  ]);
}

/** Convenience: build + write the archive to disk in one call. */
export async function exportSessionToFile(
  sessionId: string,
  passphrase: string,
  outputPath: string,
): Promise<{ archive_path: string; archive_size_bytes: number }> {
  const buf = await exportSession(sessionId, passphrase);
  await fs.promises.writeFile(outputPath, buf);
  return { archive_path: outputPath, archive_size_bytes: buf.length };
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportResult {
  session_id: string;
  overwritten: boolean;
  document_count: number;
  had_review: boolean;
  imported_at: string;
}

/**
 * Decrypt, validate, and save a session archive locally. Returns info about
 * what was imported.
 *
 * Throws on wrong passphrase, corrupted archive, unsupported version,
 * or session-already-exists without `overwrite: true`.
 */
export async function importSession(
  archive: Buffer,
  passphrase: string,
  options: { overwrite?: boolean } = {},
): Promise<ImportResult> {
  if (archive.length < HEADER_LEN + AUTH_TAG_LEN) {
    throw new Error("Archive is too small — not a PII Shield session archive");
  }
  if (!MAGIC.equals(archive.subarray(0, 4))) {
    throw new Error("Archive magic mismatch — not a PII Shield session archive");
  }
  const version = archive[4];
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported archive version: ${version} (this build expects ${FORMAT_VERSION})`,
    );
  }
  const salt = archive.subarray(8, 24);
  const nonce = archive.subarray(24, 36);
  const ctLen = archive.readUInt32BE(36);
  const expectedTotal = HEADER_LEN + ctLen + AUTH_TAG_LEN;
  if (archive.length !== expectedTotal) {
    throw new Error(
      `Archive length mismatch: got ${archive.length}, expected ${expectedTotal} (ciphertext_len=${ctLen})`,
    );
  }
  const ct = archive.subarray(HEADER_LEN, HEADER_LEN + ctLen);
  const authTag = archive.subarray(HEADER_LEN + ctLen);

  const key = await deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  let inner: Buffer;
  try {
    inner = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error(
      "Decryption failed — wrong passphrase or corrupted archive",
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(inner);
  } catch (e) {
    throw new Error(`Archive inner zip is corrupt: ${e}`);
  }
  const manifestFile = zip.file("manifest.json");
  const mappingFile = zip.file("mapping.json");
  if (!manifestFile || !mappingFile) {
    throw new Error("Archive is missing manifest.json or mapping.json");
  }
  const manifestJson = await manifestFile.async("string");
  const mappingJson = await mappingFile.async("string");
  const manifest = JSON.parse(manifestJson) as SessionManifest;
  const data = JSON.parse(mappingJson) as MappingData;

  const computedHash = crypto
    .createHash("sha256")
    .update(mappingJson, "utf-8")
    .digest("hex");
  if (computedHash !== manifest.source_hash_sha256) {
    throw new Error(
      "Mapping integrity check failed (SHA-256 mismatch inside archive)",
    );
  }
  if (data.session_id !== manifest.session_id) {
    throw new Error(
      `Archive is inconsistent: manifest.session_id=${manifest.session_id} vs mapping.session_id=${data.session_id}`,
    );
  }

  const sid = data.session_id;
  const existed = sessionExists(sid);
  if (existed && !options.overwrite) {
    throw new Error(
      `Session '${sid}' already exists locally. Pass overwrite: true to replace.`,
    );
  }

  // Persist mapping + metadata (metadata carries placeholder_state + documents[]).
  saveMapping(sid, data.mapping, data.metadata as MappingMetaExtras);

  // Persist review if present.
  let hadReview = false;
  const reviewFile = zip.file("review.json");
  if (reviewFile) {
    const reviewData = JSON.parse(await reviewFile.async("string")) as ReviewData;
    saveReview(sid, reviewData);
    hadReview = true;
  }

  const docsCount = Array.isArray((data.metadata as MappingMetaExtras)?.documents)
    ? ((data.metadata as MappingMetaExtras).documents as unknown[]).length
    : 0;

  return {
    session_id: sid,
    overwritten: existed,
    document_count: docsCount,
    had_review: hadReview,
    imported_at: new Date().toISOString(),
  };
}

/** Convenience: read file from disk and import it. */
export async function importSessionFromFile(
  archivePath: string,
  passphrase: string,
  options: { overwrite?: boolean } = {},
): Promise<ImportResult> {
  const buf = await fs.promises.readFile(archivePath);
  return importSession(buf, passphrase, options);
}
