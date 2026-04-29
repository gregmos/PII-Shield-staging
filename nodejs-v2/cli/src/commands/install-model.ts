/**
 * `pii-shield install-model` — download + extract the GLiNER model.
 *
 * Idempotent: if the model is already installed and valid, exits 0 without
 * action (override with --force). Reuses the engine's existing
 * `findDownloadedGlinerZip` + `extractAndInstallModelZip` so the install
 * paths match the MCP tool exactly.
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { initRuntime, forceReinitNer } from "../runtime.js";
import {
  findDownloadedGlinerZip,
  extractAndInstallModelZip,
} from "../../../src/engine/ner-backend.js";
import { PATHS, VERSION } from "../../../src/utils/config.js";
import { confirm } from "../prompts.js";
import { createDownloadBar } from "../progress.js";
import { green, gray, bold } from "../color.js";

const RELEASE_URL = `https://github.com/gregmos/PII-Shield/releases/download/v${VERSION}/gliner-pii-base-v1.0.zip`;

interface InstallOptions {
  force?: boolean;
  yes?: boolean;
}

function modelAlreadyInstalled(): boolean {
  const onnx = path.join(
    PATHS.MODELS_DIR,
    "gliner-pii-base-v1.0",
    "model.onnx",
  );
  if (!fs.existsSync(onnx)) return false;
  return fs.statSync(onnx).size > 100 * 1024 * 1024;
}

async function downloadWithProgress(url: string, destPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = destPath + ".part";

  await new Promise<void>((resolve, reject) => {
    const fetchUrl = (currentUrl: string, redirectsLeft: number) => {
      https
        .get(currentUrl, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirectsLeft <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            res.resume();
            fetchUrl(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(
              new Error(`Download failed: HTTP ${res.statusCode} ${res.statusMessage}`),
            );
            return;
          }

          const totalBytes = parseInt(res.headers["content-length"] ?? "0", 10);
          const totalMb = Math.max(1, Math.round(totalBytes / 1024 / 1024));
          const bar = createDownloadBar("Downloading model");
          bar.start(totalMb, 0);

          let received = 0;
          const out = fs.createWriteStream(tmpPath);
          res.on("data", (chunk) => {
            received += chunk.length;
            bar.update(Math.round(received / 1024 / 1024));
          });
          res.pipe(out);
          out.on("finish", () => {
            bar.update(totalMb);
            bar.stop();
            out.close(() => resolve());
          });
          out.on("error", (e) => {
            bar.stop();
            reject(e);
          });
        })
        .on("error", reject);
    };
    fetchUrl(url, 5);
  });

  await fs.promises.rename(tmpPath, destPath);
}

export async function runInstallModel(opts: InstallOptions): Promise<number> {
  initRuntime({ skipNer: true });

  if (modelAlreadyInstalled() && !opts.force) {
    process.stdout.write(
      `Model already installed at ${path.join(PATHS.MODELS_DIR, "gliner-pii-base-v1.0")}\n`,
    );
    process.stdout.write(`Use --force to reinstall.\n`);
    return 0;
  }

  // Tier 1: try to find an already-downloaded ZIP in standard locations.
  // FindZipResult uses `status: "found" | "not_found"` and `zip_path`.
  const found = findDownloadedGlinerZip();
  let zipPath: string | null = null;
  let cleanupZip = false;

  if (found.status === "found" && found.zip_path) {
    process.stdout.write(`Found local ZIP at ${found.zip_path}\n`);
    zipPath = found.zip_path;
  } else {
    process.stdout.write(
      `GLiNER model not found locally. Need to download ~634 MB from:\n  ${RELEASE_URL}\n\n`,
    );
    const ok = await confirm("Download now?", {
      defaultValue: true,
      assumeYes: opts.yes,
    });
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 1;
    }

    const cacheDir = path.join(PATHS.DATA_DIR, "cache");
    zipPath = path.join(cacheDir, "gliner-pii-base-v1.0.zip");
    cleanupZip = true;
    await downloadWithProgress(RELEASE_URL, zipPath);
  }

  process.stdout.write(`Extracting...\n`);
  const result = await extractAndInstallModelZip(zipPath);
  if (result.status !== "installed") {
    process.stdout.write(`Install failed: ${result.error ?? "unknown"}\n`);
    return 1;
  }

  if (cleanupZip) {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* leave cached zip on cleanup failure — non-fatal */
    }
  }

  process.stdout.write(
    green("✓") + ` Model installed at ${gray(result.extracted_to ?? "")} (${bold((result.model_size_mb?.toFixed(1) ?? "?") + " MB")})\n`,
  );

  // Re-init the running engine so subsequent commands see the model.
  await forceReinitNer();
  process.stdout.write(green("✓") + " NER engine reinitialized.\n");
  return 0;
}
