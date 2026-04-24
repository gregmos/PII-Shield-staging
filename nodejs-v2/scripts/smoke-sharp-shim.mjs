#!/usr/bin/env node
/**
 * Focused sharp-shim clean-install smoke test.
 *
 * Mirrors the production flow from src/engine/ner-backend.ts:
 *   1. Build a deps package.json + copy ner-deps-lockfile.json into a fresh
 *      temp dir.
 *   2. Run `npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund`
 *      so sharp's native postinstall is intentionally skipped — this is the
 *      hostile condition the shim protects against on macOS arm64.
 *   3. Install the deps-aware sharp shim (bare + absolute path + nested).
 *   4. Load @xenova/transformers (CJS + ESM) and gliner/node.
 *   5. Assert at least one shim intercept hit, no sharp-<triple>.node errors.
 *
 * Exit 0 = PASS. Non-zero = FAIL.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import nodeModule from "node:module";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LOCKFILE_PATH = path.join(PROJECT_ROOT, "src/engine/ner-deps-lockfile.json");

const PINS = {
  "onnxruntime-node": "1.22.0",
  "onnxruntime-common": "1.22.0",
  "onnxruntime-web": "1.22.0",
  "@xenova/transformers": "2.17.2",
  "gliner": "0.0.19",
};

const TMP_ROOT = path.join(
  os.tmpdir(),
  `piish-sharp-shim-smoke-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);

function log(msg) {
  process.stdout.write(`[smoke] ${msg}\n`);
}

function runNpmCi(cwd) {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const args = [
    npmCli,
    "ci",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    "--omit=optional",
  ];
  log(`npm ci (ignore-scripts) in ${cwd}`);
  const res = spawnSync(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
    throw new Error(`npm ci failed with exit ${res.status}`);
  }
}

// Replica of the deps-aware sharp shim from src/engine/ner-backend.ts.
let shimInstalled = false;
let interceptCount = 0;
const shimEntries = new Set();
const shimRoots = new Set();

function normalizeRequest(req) {
  let n = req;
  if (path.isAbsolute(req)) n = path.resolve(req);
  n = n.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") n = n.toLowerCase();
  return n;
}

function makeShim() {
  function makeChain() {
    const handler = {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive) return () => "[sharp-shim]";
        if (prop === "metadata") return async () => ({});
        if (prop === "toBuffer") return async () => Buffer.alloc(0);
        if (prop === "toFile") return async () => ({});
        return () => chain;
      },
      apply() { return chain; },
    };
    const chain = new Proxy(function si() { return chain; }, handler);
    return chain;
  }
  const shim = function sharpShim() { return makeChain(); };
  shim.cache = () => shim;
  shim.concurrency = () => 1;
  shim.simd = () => false;
  shim.versions = { vips: "0.0.0-shim" };
  shim.format = {};
  shim.interpolators = {};
  shim.kernel = {};
  shim.fit = {};
  shim.gravity = {};
  shim.default = shim;
  shim.__esModule = true;
  return shim;
}

function installShim(requireFromDeps) {
  try {
    const sharpEntry = requireFromDeps.resolve("sharp");
    const sharpRoot = path.dirname(path.dirname(sharpEntry));
    shimEntries.add(normalizeRequest(sharpEntry));
    shimRoots.add(normalizeRequest(sharpRoot));
    log(`shim registered: entry=${sharpEntry} root=${sharpRoot}`);
  } catch (e) {
    log(`shim could not resolve sharp from deps (bare-only fallback): ${e.message}`);
  }

  if (shimInstalled) return;
  const M = nodeModule;
  const originalLoad = M._load;
  const shim = makeShim();
  M._load = function patched(request, parent, isMain) {
    if (typeof request === "string") {
      if (request === "sharp") {
        interceptCount++;
        if (interceptCount <= 5) log(`intercept bare request=sharp parent=${parent?.filename || "?"}`);
        return shim;
      }
      const key = normalizeRequest(request);
      if (shimEntries.has(key)) {
        interceptCount++;
        if (interceptCount <= 5) log(`intercept absolute entry=${request}`);
        return shim;
      }
      for (const root of shimRoots) {
        if (key === root || key.startsWith(`${root}/`)) {
          interceptCount++;
          if (interceptCount <= 5) log(`intercept inside-sharp-root request=${request}`);
          return shim;
        }
        const parentId = parent?.filename || parent?.id || "";
        if (parentId) {
          const pKey = normalizeRequest(parentId);
          if ((pKey === root || pKey.startsWith(`${root}/`)) && (request.startsWith(".") || key.startsWith(`${root}/`))) {
            interceptCount++;
            if (interceptCount <= 5) log(`intercept nested-from-sharp parent=${parentId} request=${request}`);
            return shim;
          }
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  shimInstalled = true;
  log("shim installed (Module._load patched)");
}

async function main() {
  log(`creating ${TMP_ROOT}`);
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  // 1. deps package.json mirroring buildNerDepsPackageJson()
  const depsPkg = {
    name: "pii-shield-deps",
    version: "1.0.0",
    private: true,
    dependencies: { ...PINS },
    overrides: {
      "onnxruntime-node": PINS["onnxruntime-node"],
      "onnxruntime-common": PINS["onnxruntime-common"],
      "onnxruntime-web": PINS["onnxruntime-web"],
    },
  };
  fs.writeFileSync(path.join(TMP_ROOT, "package.json"), JSON.stringify(depsPkg, null, 2));
  const lockTemplate = JSON.parse(fs.readFileSync(LOCKFILE_PATH, "utf-8"));
  lockTemplate.name = "pii-shield-deps";
  lockTemplate.packages[""].name = "pii-shield-deps";
  lockTemplate.packages[""].dependencies = { ...PINS };
  fs.writeFileSync(path.join(TMP_ROOT, "package-lock.json"), JSON.stringify(lockTemplate, null, 2));

  // 2. npm ci --ignore-scripts
  runNpmCi(TMP_ROOT);

  // 3. install shim
  const requireFromDeps = createRequire(path.join(TMP_ROOT, "package.json"));
  installShim(requireFromDeps);

  // Sanity: sharp entry must exist (shim needs to have registered it)
  if (shimRoots.size === 0) {
    throw new Error("sharp was not resolved from deps — shim registration failed");
  }

  // 4. CJS load of @xenova/transformers
  log("loading @xenova/transformers via CJS require...");
  const transformersCjs = requireFromDeps("@xenova/transformers");
  if (!transformersCjs || typeof transformersCjs !== "object") {
    throw new Error("@xenova/transformers CJS load produced non-object");
  }
  log(`  CJS OK (exports: ${Object.keys(transformersCjs).slice(0, 5).join(",")}…)`);

  // 5. ESM import
  log("loading @xenova/transformers via ESM import...");
  const transformersEntry = requireFromDeps.resolve("@xenova/transformers");
  const transformersEsm = await import(pathToFileURL(transformersEntry).href);
  if (!transformersEsm || typeof transformersEsm !== "object") {
    throw new Error("@xenova/transformers ESM load produced non-object");
  }
  log(`  ESM OK (exports: ${Object.keys(transformersEsm).slice(0, 5).join(",")}…)`);

  // 6. gliner/node
  log("loading gliner/node via CJS require...");
  const gliner = requireFromDeps("gliner");
  if (!gliner || typeof gliner !== "object") {
    throw new Error("gliner load produced non-object");
  }
  log(`  gliner OK (exports: ${Object.keys(gliner).slice(0, 5).join(",")}…)`);

  log(`\nintercept count = ${interceptCount}`);
  if (interceptCount < 1) {
    throw new Error("shim intercept count < 1 — shim did not fire (expected ≥1 hit)");
  }
  log("PASS — sharp shim intercepted at least once, transformers+gliner loaded clean");
}

main()
  .then(() => {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`FAIL: ${err?.stack || err}\n`);
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
