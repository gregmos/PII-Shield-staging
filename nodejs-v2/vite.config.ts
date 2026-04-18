/**
 * Vite config for the PII Shield review iframe UI.
 *
 * Mirrors `apps-tester/vite.config.ts`:
 *   - `viteSingleFile` inlines every .ts / .css / <link> / <script src=> into
 *     one self-contained `dist/ui/review.html`. That file is then imported in
 *     `src/index.ts` via esbuild's text loader and served as the
 *     `ui://pii-shield/review.html` MCP resource.
 *   - INPUT env var selects the entry HTML (default: review.html).
 *
 * Output path is `dist/ui/review.html` — NOT `dist/review.html` — because
 * esbuild also writes `dist/server.bundle.mjs` and we don't want them
 * colliding or relying on emptyOutDir. Final artifacts:
 *   dist/ui/review.html            ← this config
 *   dist/server.bundle.mjs         ← esbuild step in plugin/build-plugin.mjs
 *   dist/pii-shield-v2.0.0.mcpb    ← mcpb pack step in plugin/build-plugin.mjs
 */
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT = process.env.INPUT || "review.html";
const INPUT_ABS = path.resolve(__dirname, "ui", INPUT);
const isDev = process.env.NODE_ENV === "development";

export default defineConfig({
  root: "ui",
  plugins: [viteSingleFile()],
  build: {
    sourcemap: isDev ? "inline" : false,
    cssMinify: !isDev,
    minify: !isDev,
    rollupOptions: {
      input: INPUT_ABS,
    },
    // `outDir` is relative to `root` (= ui/), so this writes to nodejs-v2/dist/ui.
    outDir: "../dist/ui",
    // Don't wipe dist/ — esbuild writes server.bundle.mjs there in build-plugin.mjs.
    emptyOutDir: false,
  },
});
