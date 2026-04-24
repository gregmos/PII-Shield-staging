# PII Shield v2 — Claude Desktop Extension

MCP server that **anonymizes PII in documents before Claude reads them** and restores the real data after analysis. PII never leaves your machine.

Key features:

- **Legal-domain NER** via GLiNER (ONNX, 634 MB) — detects parties, contacts, addresses, emails, IDs, registration numbers, etc.
- **Human-in-the-Loop review** in an in-chat panel (no browser) — you approve every placeholder before Claude touches the file
- **`.docx` (with tracked changes / redline) + `.pdf` + `.txt` / `.md` / `.csv`**
- **Cross-session persistence**: each anonymized `.docx` carries its `session_id` in its metadata, so you can deanonymize it in a new chat weeks later without remembering anything
- **Multi-file sessions**: anonymize N documents under one session; identical entities get the same placeholder everywhere (write your own memo mixing placeholders, one command restores PII in the whole thing)
- **Team handoff**: export an encrypted `.pii-session` archive for a colleague, they import and restore on their machine
- Pure Node.js, no Python dependency

## Install — 3 steps, ~3-5 min total

### Step 1 — install the GLiNER model (~634 MB, one-time)

The model is installed separately from the plugin so Claude Desktop's extension install stays instant.

**Windows (PowerShell):**
```powershell
iwr https://raw.githubusercontent.com/gregmos/PII-Shield/main/nodejs-v2/scripts/install-model.ps1 | iex
```

**macOS / Linux (Terminal):**
```bash
curl -fsSL https://raw.githubusercontent.com/gregmos/PII-Shield/main/nodejs-v2/scripts/install-model.sh | bash
```

The one-liner downloads a single `gliner-pii-base-v1.0.zip` (~634 MB) from the PII Shield GitHub release and unpacks it into `~/.pii_shield/models/gliner-pii-base-v1.0/` (~2–5 min depending on your connection). No file is saved to disk — that avoids Windows SmartScreen and macOS Gatekeeper prompts.

Prefer to read the script first? Download `install-model.ps1` or `install-model.sh` from the [GitHub Release page](https://github.com/gregmos/PII-Shield/releases) (~3 KB, ~30 lines of code) and run it locally:

- **Windows**: right-click `install-model.ps1` → Properties → Unblock → `powershell -ExecutionPolicy Bypass -File install-model.ps1`
- **macOS**: `xattr -d com.apple.quarantine install-model.sh && chmod +x install-model.sh && ./install-model.sh`
- **Linux**: `chmod +x install-model.sh && ./install-model.sh`

### Step 2 — install the plugin

Download the package for your OS from the [GitHub Release page](https://github.com/gregmos/PII-Shield/releases) and drag-drop it into Claude Desktop (Settings → Extensions).

- **Windows / legacy hosts**: `pii-shield-v2.0.2.mcpb` (thin Node MCPB).
- **macOS**: `pii-shield-v2.0.2-darwin-universal.mcpb` (bundles Node.js so it avoids Claude Desktop's built-in Node launch path).

### Step 3 — use it

Upload a contract to Claude Desktop, ask to anonymize it. First tool call will take ~1-2 min (onnxruntime + transformers auto-install, one-time). After that: instant.

## Data locations

PII Shield keeps data in two separate directories by design:

| Path | What lives here | Wiped on `/plugin remove`? |
|---|---|---|
| `~/.pii_shield/models/` | GLiNER model (634 MB ONNX + tokenizer files) | **No** — manual deletion only |
| `~/.pii_shield/deps/installs/<stamp>/` | Runtime npm deps (onnxruntime-node, transformers, gliner; versioned install roots under `~/.pii_shield/deps/`) | **No** |
| `~/.pii_shield/audit/`  | Append-only audit logs (proves PII never left the machine) | **No** |
| `~/.pii-shield/mappings/` *(dash, note!)* | Session mappings (placeholder ↔ real PII), per session | **No** — so your cases survive plugin upgrades |

Both directories survive `/plugin remove`, so re-installing the extension never loses existing cases or re-downloads the model. The dash vs underscore split is historical (models dir predates mappings dir); both are respected by the runtime.

Override either via env vars: `PII_SHIELD_MODELS_DIR` (model) and `PII_SHIELD_MAPPINGS_DIR` (mappings). Or set "GLiNER model directory" in Claude Desktop → Extensions → PII Shield → Settings.

## Troubleshooting

### macOS: server immediately disconnects after install ("transport closed unexpectedly")

Install `pii-shield-v2.0.2-darwin-universal.mcpb` instead of the thin `pii-shield-v2.0.2.mcpb`. The macOS package runs as `server.type="binary"` with bundled Node.js, avoiding Claude Desktop's built-in Node launch path that can close immediately after `initialize` on Tahoe-era builds.

If still failing on a recent Claude Desktop, check `/tmp/piish-banner-debug.log` (macOS/Linux) or `%TEMP%\piish-banner-debug.log` (Windows). Each banner stage logs there even when stderr is dropped — share the file when reporting.

### "PII Shield needs its GLiNER model"

You installed the `.mcpb` without running the model installer. Open a terminal and paste the one-liner from Step 1 above. Then ask Claude again — the plugin picks up the model automatically via an auto-BFS across several common locations:

1. Path you set in Extension settings (`models_path`)
2. `~/.pii_shield/models/gliner-pii-base-v1.0/` (default install path)
3. `$CLAUDE_PLUGIN_DATA/models/gliner-pii-base-v1.0/` (if you used a pre-thin dev build)
4. `~/Downloads/gliner-pii-base-v1.0/` (if you manually moved the folder)
5. Plugin-relative (if the model is sitting next to the `.mcpb`'s `server.bundle.mjs`)

The error envelope Claude shows you also prints the exact paths the server checked — helpful if you extracted the model to an unusual place.

### "Windows protected your PC" when running the downloaded `install-model.ps1`

Expected for an unsigned script downloaded via browser (Mark-of-the-Web quarantine). Either:

- Use the one-liner (`iwr ... | iex`) — no file is written to disk, no quarantine, no warning
- Or: right-click the file → Properties → Unblock → OK, then run with `-ExecutionPolicy Bypass -File`

### macOS: "install-model.sh cannot be opened because it is from an unidentified developer"

Same deal — the one-liner (`curl | bash`) avoids this. If you prefer the file:
```bash
xattr -d com.apple.quarantine install-model.sh
chmod +x install-model.sh
./install-model.sh
```

### First-run npm install is still running

The first PII Shield run installs `onnxruntime-node` + `@xenova/transformers` + `gliner` into a versioned root under `~/.pii_shield/deps/installs/` (~600 MB). This build uses deterministic `npm ci --ignore-scripts`, so there is no sharp postinstall download anymore. If it still fails, check `~/.pii_shield/audit/ner_init.log` — it now logs the exact resolved `onnxruntime-node`, `onnxruntime-common`, and `onnxruntime-web` paths for root / transformers / gliner.

### Corporate firewall blocks github.com

Download `gliner-pii-base-v1.0.zip` manually from the [GitHub release page](https://github.com/gregmos/PII-Shield/releases) on a machine with access (or an internal mirror), unzip into `~/.pii_shield/models/gliner-pii-base-v1.0/` — the zip contains `model.onnx`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `gliner_config.json` at the root.

If you cannot reach GitHub at all, the same five files are also mirrored upstream at `https://huggingface.co/knowledgator/gliner-pii-base-v1.0/` — grab them individually and drop them into the same target dir.

### Had a pre-thin "fat" dev build? You don't need to re-download

If you were a developer testing an older build that bundled the model inside the `.mcpb`, the model is likely in your `$CLAUDE_PLUGIN_DATA/models/` or in the plugin staging dir next to the old `server.bundle.mjs`. The runtime auto-BFS finds it there too (candidate #3 or #5). You can leave it or move it to `~/.pii_shield/models/` for cleanliness.

## License

MIT. See `LICENSE`.
