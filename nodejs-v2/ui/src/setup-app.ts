/**
 * @file PII Shield setup-panel iframe.
 *
 * Three-step UI rendered for `ui://pii-shield/setup.html`:
 *   1. Click "Download model" — calls `app.openLink({ url: MODEL_ZIP_URL })`,
 *      the host opens it in the user's default browser. The browser handles
 *      the 634 MB download (Defender treats it like any normal browser file,
 *      no SmartScreen on an unsigned process).
 *   2. Click "Install downloaded ZIP" — calls the server tool
 *      `install_model_from_download`. The server scans Downloads / OneDrive /
 *      Desktop / etc. for `gliner-pii-base-v1.0*.zip`, validates, atomic-moves
 *      into `~/.pii_shield/models/gliner-pii-base-v1.0/`, re-inits NER.
 *   3. "Check status" — calls `list_entities`. When phase = "ready", we flash
 *      the "Model installed" overlay and the user can dismiss the panel.
 *
 * No PII is ever rendered in this iframe — it's strictly install orchestration.
 */

import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./setup.css";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Release-asset URL for the model zip. Currently points at the staging repo
 * for the v2.0.2 dry-run; flipped to the public `gregmos/PII-Shield` host
 * when we promote to public. Kept in lockstep with `RELEASE_SCRIPT_BASE` in
 * `src/index.ts` and `MODEL_ZIP_URL` in `scripts/install-model.{ps1,sh}`.
 */
const MODEL_ZIP_URL =
  "https://github.com/gregmos/PII-Shield/releases/download/v2.0.2/gliner-pii-base-v1.0.zip";

/** Marker filename for the Tier-2 fallback in `findDownloadedGlinerZip`. */
const MARKER_NAME = ".pii_shield_model_here";

// ── Types ───────────────────────────────────────────────────────────────────

interface InstallModelResult {
  status: "installed" | "not_found" | "validation_failed" | "extract_failed" | "error";
  found_zip_path?: string;
  extracted_to?: string;
  model_size_mb?: number;
  hint?: "marker_required" | "configure_dir";
  marker_name?: string;
  error?: string;
  searched?: string[];
}

interface ListEntitiesEnvelope {
  status?: string;
  phase?: string;
  ner_ready?: boolean;
  ner_error?: string;
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element #${id} not found in setup.html shell`);
  return el;
}

function setStatus(state: "checking" | "ready" | "installing" | "error" | "not_found", text: string): void {
  const pill = $("status-pill");
  pill.textContent = text;
  pill.dataset.state = state;
}

function appendLog(line: string, kind: "info" | "error" | "success" = "info"): void {
  const log = $("install-log");
  log.hidden = false;
  log.classList.remove("error", "success");
  if (kind === "error") log.classList.add("error");
  if (kind === "success") log.classList.add("success");
  const stamp = new Date().toLocaleTimeString();
  log.textContent += `[${stamp}] ${line}\n`;
  log.scrollTop = log.scrollHeight;
}

function showReady(): void {
  $("ready-overlay").classList.add("visible");
}

function readToolResult<T>(result: CallToolResult): T | null {
  // Server-side handlers return JSON-stringified text in `content[0].text`.
  // `structuredContent` is also populated when registered as a structured tool.
  const sc = (result as { structuredContent?: T }).structuredContent;
  if (sc) return sc;
  const text = result.content?.[0];
  if (text && text.type === "text") {
    try {
      return JSON.parse(text.text) as T;
    } catch {
      return null;
    }
  }
  return null;
}

// ── Boot ────────────────────────────────────────────────────────────────────

const app = new App({ name: "pii-shield-setup-ui", version: "2.0.2" });

// Initial state
setStatus("checking", "Checking…");
($("marker-name") as HTMLElement).textContent = MARKER_NAME;

// ── Action handlers ─────────────────────────────────────────────────────────

async function handleDownload(): Promise<void> {
  const btn = $("btn-download") as HTMLButtonElement;
  btn.disabled = true;
  setStatus("installing", "Downloading…");
  $("download-hint").textContent = "Switch to your browser — the download started there.";

  try {
    const res = await app.openLink({ url: MODEL_ZIP_URL });
    if ((res as { isError?: boolean }).isError) {
      setStatus("error", "Open denied");
      $("download-hint").textContent =
        "Host blocked the link. Copy this URL into your browser manually: " + MODEL_ZIP_URL;
      btn.disabled = false;
      return;
    }
    // Enable Install once the user has had a chance to start the download.
    setTimeout(() => {
      ($("btn-install") as HTMLButtonElement).disabled = false;
      $("install-hint").textContent =
        "Once the download finishes (~2–5 min), click Install.";
    }, 800);
  } catch (err) {
    setStatus("error", "Open failed");
    $("download-hint").textContent =
      "Could not open browser. Copy this URL manually: " + MODEL_ZIP_URL;
    btn.disabled = false;
    console.error("[setup-app] openLink rejected:", err);
  }
}

async function handleInstall(): Promise<void> {
  const btn = $("btn-install") as HTMLButtonElement;
  btn.disabled = true;
  setStatus("installing", "Installing…");
  appendLog("Searching for downloaded ZIP…");

  try {
    const result = await app.callServerTool({
      name: "install_model_from_download",
      arguments: {},
    });
    const payload = readToolResult<InstallModelResult>(result);

    if (!payload) {
      setStatus("error", "Bad response");
      appendLog("Server returned an unparsable response.", "error");
      btn.disabled = false;
      return;
    }

    if (payload.status === "installed") {
      appendLog(`Found ZIP at: ${payload.found_zip_path}`);
      appendLog(`Extracted to: ${payload.extracted_to}`);
      if (payload.model_size_mb) {
        appendLog(`model.onnx size: ${payload.model_size_mb} MB`, "success");
      }
      appendLog("NER re-initialized. Ready to anonymize.", "success");
      setStatus("ready", "Ready");
      ($("step-check") as HTMLElement).classList.add("step-active");
      showReady();
      return;
    }

    if (payload.status === "not_found") {
      setStatus("error", "ZIP not found");
      const searchedHint = (payload.searched && payload.searched.length > 0)
        ? "Looked in: " + payload.searched.join(", ")
        : "";
      if (payload.hint === "marker_required") {
        appendLog(
          "Couldn't auto-detect the ZIP. Drop a marker file `" + (payload.marker_name || MARKER_NAME) +
          "` next to the downloaded ZIP, then click Install again.",
          "error",
        );
      } else if (payload.hint === "configure_dir") {
        appendLog(
          "Still no luck. Open Claude Desktop → Settings → Extensions → PII Shield → " +
          "Model Downloads Folder, point at the folder where your browser saves files, " +
          "then click Install again.",
          "error",
        );
      } else {
        appendLog("Couldn't find the ZIP. " + searchedHint, "error");
      }
      btn.disabled = false;
      return;
    }

    if (payload.status === "validation_failed") {
      setStatus("error", "ZIP invalid");
      appendLog("ZIP found but failed validation: " + (payload.error || "unknown error"), "error");
      appendLog("Check that you downloaded the full file (~613 MB compressed).", "error");
      btn.disabled = false;
      return;
    }

    if (payload.status === "extract_failed") {
      setStatus("error", "Extract failed");
      appendLog("Extraction failed: " + (payload.error || "unknown error"), "error");
      btn.disabled = false;
      return;
    }

    setStatus("error", "Install failed");
    appendLog("Server error: " + (payload.error || JSON.stringify(payload)), "error");
    btn.disabled = false;
  } catch (err) {
    setStatus("error", "Tool call failed");
    appendLog("Error: " + (err instanceof Error ? err.message : String(err)), "error");
    btn.disabled = false;
    console.error("[setup-app] install_model_from_download rejected:", err);
  }
}

async function handleCheck(): Promise<void> {
  const btn = $("btn-check") as HTMLButtonElement;
  btn.disabled = true;
  setStatus("checking", "Checking…");

  try {
    const result = await app.callServerTool({
      name: "list_entities",
      arguments: {},
    });
    const payload = readToolResult<ListEntitiesEnvelope>(result);

    if (payload?.ner_ready === true || payload?.phase === "ready") {
      setStatus("ready", "Ready");
      showReady();
      return;
    }

    if (payload?.phase === "needs_setup") {
      setStatus("error", "Model not found");
      appendLog(
        "NER still reports needs_setup. Make sure you've completed Step 1 (download) and Step 2 (install).",
        "error",
      );
      return;
    }

    if (payload?.phase === "installing_deps" || payload?.phase === "loading_model") {
      setStatus("installing", "Loading…");
      appendLog(`NER phase: ${payload.phase}. Wait ~30 s and check again.`);
      return;
    }

    if (payload?.phase === "error" || payload?.status === "error") {
      setStatus("error", "NER error");
      appendLog("NER reports an error: " + (payload?.ner_error || "unknown"), "error");
      return;
    }

    setStatus("error", payload?.phase || "Unknown");
    appendLog("Unexpected response. Phase: " + (payload?.phase || "?"));
  } catch (err) {
    setStatus("error", "Check failed");
    appendLog("Error: " + (err instanceof Error ? err.message : String(err)), "error");
    console.error("[setup-app] list_entities rejected:", err);
  } finally {
    btn.disabled = false;
  }
}

// ── Wire up ─────────────────────────────────────────────────────────────────

$("btn-download").addEventListener("click", () => { void handleDownload(); });
$("btn-install").addEventListener("click", () => { void handleInstall(); });
$("btn-check").addEventListener("click", () => { void handleCheck(); });

app.ontoolresult = () => {
  // start_model_setup may pass an initial state via structuredContent — we
  // also probe via list_entities once we're connected, so this hook is
  // optional. If the server includes `model_state` we use it.
  void handleCheck();
};

app.onhostcontextchanged = (_ctx: McpUiHostContext) => {
  // Theme already auto-resolves via `prefers-color-scheme` in setup.css.
};

app.onerror = (err) => {
  console.error("[setup-app] App error:", err);
};

app.connect().catch((err: unknown) => {
  console.error("[setup-app] app.connect() rejected:", err);
  setStatus("error", "Bridge error");
  appendLog("Failed to connect to MCP host: " + (err instanceof Error ? err.message : String(err)), "error");
});
