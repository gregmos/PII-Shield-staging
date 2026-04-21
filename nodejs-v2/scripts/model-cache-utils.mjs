/**
 * PII Shield v2 — shared helpers for populating a GLiNER model cache from
 * HuggingFace. Used by (legacy) `plugin/build-plugin.mjs` in dev and by future
 * dev tooling that needs the same URL list + download logic.
 *
 * Extracted from `plugin/build-plugin.mjs` when the .mcpb was made thin — the
 * runtime server no longer downloads anything. End users get the model via
 * `install-model.ps1` / `install-model.sh` which are separate, user-run
 * PowerShell/bash scripts (not Node).
 */

import fs from "node:fs";
import path from "node:path";

export const MODEL_SLUG = "gliner-pii-base-v1.0";
export const HF_REPO = `knowledgator/${MODEL_SLUG}`;
export const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;

/** The files the GLiNER runtime needs next to each other in one directory. */
export const BUNDLED_FILES = [
  // { hfPath, localName, required }
  { hfPath: "onnx/model.onnx",         localName: "model.onnx",              required: true },
  { hfPath: "tokenizer.json",          localName: "tokenizer.json",          required: true },
  { hfPath: "tokenizer_config.json",   localName: "tokenizer_config.json",   required: true },
  { hfPath: "special_tokens_map.json", localName: "special_tokens_map.json", required: true },
  { hfPath: "gliner_config.json",      localName: "gliner_config.json",      required: true },
];

/**
 * Stream-download `url` to `destPath` using native fetch + sync fd writes.
 * Overwrites if present. Progress printed to stdout every ~10%. Returns the
 * number of bytes written. Build-time helper — no atomic rename, no lock:
 * single-process dev tool.
 */
export async function fetchTo(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  if (!res.body) throw new Error(`No response body for ${url}`);
  const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const fd = fs.openSync(destPath, "w");
  let downloaded = 0;
  let lastLog = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, value);
      downloaded += value.length;
      if (totalBytes > 0) {
        const pct = Math.round((downloaded / totalBytes) * 100);
        if (pct - lastLog >= 10) {
          process.stdout.write(
            `\r        ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`,
          );
          lastLog = pct;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (lastLog > 0) process.stdout.write("\n");
  return downloaded;
}

/**
 * Ensure all BUNDLED_FILES exist in the given cache dir. Downloads anything
 * missing. Returns the cache dir so the caller can reference it.
 */
export async function ensureDevModelCache(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const f of BUNDLED_FILES) {
    const local = path.join(cacheDir, f.localName);
    if (fs.existsSync(local)) {
      const sz = fs.statSync(local).size;
      console.log(`        ✓ ${f.localName} (cached, ${(sz / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    console.log(`        ↓ ${f.localName} — downloading from HuggingFace...`);
    const got = await fetchTo(`${HF_BASE}/${f.hfPath}`, local);
    console.log(`        ✓ ${f.localName} (${(got / 1024 / 1024).toFixed(1)} MB)`);
  }
  return cacheDir;
}
