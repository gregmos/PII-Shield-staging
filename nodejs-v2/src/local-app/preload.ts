/**
 * Preload — sets PII_SHIELD_DATA_DIR before any engine module loads.
 * Must be imported BEFORE any engine import in server.ts.
 *
 * Uses ~/Downloads/Local_Test_Ner as a completely separate data directory
 * for local testing. Does NOT touch the Cowork/production cache.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const LOCAL_DATA_DIR = path.join(os.homedir(), "Downloads", "Local_Test_Ner");

// Create directory structure
fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
for (const sub of ["models", "deps", "mappings", "reviews", "audit"]) {
  fs.mkdirSync(path.join(LOCAL_DATA_DIR, sub), { recursive: true });
}

// Set env var BEFORE config.ts is imported by any engine module
process.env.PII_SHIELD_DATA_DIR = LOCAL_DATA_DIR;

// Pre-load onnxruntime-node into the module cache BEFORE @xenova/transformers.
// gliner/node imports transformers first, then onnxruntime-node. Transformers
// registers an ONNX-web backend that corrupts the native addon loading on Windows.
// By pre-caching onnxruntime-node here, gliner's require() gets the cached copy.
// Pre-load NER deps into the CJS module cache.
// ner-backend.ts loads @xenova/transformers via ESM dynamic import() then sets
// env.localModelPath. But on Node v24, the ESM import may not populate the CJS
// require cache, so when gliner's CJS code does require('@xenova/transformers'),
// it gets a fresh instance without the env settings. Fix: pre-require both
// onnxruntime-node (must come before transformers to avoid DLL load conflict)
// and transformers (with env configured) into the CJS cache.
const depsDir = path.join(LOCAL_DATA_DIR, "deps");
if (fs.existsSync(path.join(depsDir, "node_modules", "onnxruntime-node"))) {
  try {
    const req = createRequire(path.join(depsDir, "package.json"));

    // 1. Pre-load onnxruntime-node FIRST — must be cached before transformers
    //    loads its ONNX-web backend which corrupts native addon loading on Windows
    req("onnxruntime-node");
    console.error("[LocalApp] Pre-loaded onnxruntime-node into module cache");

    // 2. Pre-load @xenova/transformers and configure env for local model files
    const transformers = req("@xenova/transformers");
    const modelsDir = path.join(LOCAL_DATA_DIR, "models");
    // Find the tokenizer directory (pii_shield_tokenizer__*)
    const tokDirs = fs.readdirSync(modelsDir).filter((d: string) =>
      d.startsWith("pii_shield_tokenizer__")
    );
    if (tokDirs.length > 0) {
      const tokenizerDir = path.join(modelsDir, tokDirs[0]);
      transformers.env.localModelPath = tokenizerDir;
      transformers.env.allowLocalModels = true;
      transformers.env.useBrowserCache = false;
      transformers.env.allowRemoteModels = false;
      console.error(`[LocalApp] Transformers env.localModelPath = ${tokenizerDir}`);
    }
  } catch (e: any) {
    console.error(`[LocalApp] Pre-load failed: ${e.message}`);
  }
}

console.error(`[LocalApp] Data directory: ${LOCAL_DATA_DIR}`);
