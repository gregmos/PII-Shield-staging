# PII Shield — Testkit

Contents:

| File | Purpose |
|---|---|
| `pii-shield-v2.0.2.mcpb` | MCP server bundle for Windows / legacy hosts |
| `pii-shield-v2.0.2-darwin-universal.mcpb` | MCP server bundle for macOS (bundled Node runtime) |
| `pii-contract-analyze.skill` | Skill file (the workflow / prompts) |
| `install-model.ps1` / `.bat` | Model downloader — Windows |
| `install-model.sh` / `.command` | Model downloader — macOS / Linux |

## Step 1 — Install the GLiNER model (one-time, ~634 MB)

The model is downloaded separately from the MCP server (keeps the bundle small; model survives  MCP server reinstalls).

### Windows
Double-click **`install-model.bat`**. Opens a PowerShell window, downloads `gliner-pii-base-v1.0.zip` (~634 MB) from the PII Shield GitHub release and unpacks it, prints "Press any key" when done.

*SmartScreen warning?* "More info" → "Run anyway". Once.

### macOS
Right-click **`install-model.command`** → "Open" (bypasses Gatekeeper the first time).

### Linux
```bash
chmod +x install-model.sh && ./install-model.sh
```

Final output:
```
[OK] Model installed at ~/.pii_shield/models/gliner-pii-base-v1.0 (634 MB)
```

## Step 2 — Install the artifacts

Choose one MCP server bundle for your OS, plus the skill. Install order does not matter:

- **Windows / legacy hosts**: install **`pii-shield-v2.0.2.mcpb`**.
- **macOS**: install **`pii-shield-v2.0.2-darwin-universal.mcpb`**. It bundles Node.js so Claude Desktop does not use its built-in Node launch path.
- **`pii-contract-analyze.skill`** — the skill (SKILL.md + references).

Drop the chosen MCPB and the skill into your Claude host (Desktop / Cowork / etc.) per the host's extension-install UI.

## Step 3 — Use it

In a chat:
1. **Connect a folder** (not attach a file!) containing `.docx` / `.pdf`. Attached files go through the API before PII Shield can anonymize; connected folders give Claude only paths.
2. Say: `review this contract`, `compare these documents`, `anonymize these files`, `write a memo`, `redline`, etc.
3. First turn replies `Ready to start. Type go or continue to proceed.` → type `go`.
4. On multi-file (N≥2) input Claude asks once: **one matter** (e.g. MSA + Amendment — shared parties, shared pool) or **separate matters** (unrelated NDAs)? Pick the right one.
5. Review panel opens in chat — click highlights to remove false positives, select text to add missed entities, Approve. Send any message to continue.
6. Final memo / redline / comparison delivered with PII restored.

## Features worth trying

- **Cross-chat deanonymize**: close the chat, open a fresh one in the same folder, drop the anonymized `.docx`, ask to "restore PII" — works via `session_id` embedded in the docx's `docProps/custom.xml`, no manual tracking.
- **Multi-file shared pool**: upload 3 related contracts → `Acme Corp` = `<ORG_1>` consistently across all three; one review panel with 3 tabs; one deanonymize call at the end.
- **Team handoff**: `export_session` → you get an encrypted `.pii-session` archive. Share it with a colleague + passphrase separately. They `import_session` and can deanonymize YOUR anonymized files on their machine.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "PII Shield needs its GLiNER model…" | Step 1 not completed. Run the installer; or set the path: Plugin Settings → "GLiNER model directory" = `~/.pii_shield/models/`. |
| SmartScreen / Gatekeeper blocks the script | "More info → Run anyway" (Win); right-click → Open (macOS). |
| macOS: server immediately shuts down after install | Use `pii-shield-v2.0.2-darwin-universal.mcpb`. It runs as `server.type="binary"` with bundled Node.js and avoids Claude Desktop's built-in Node launch path. |
| Deps install takes >5 min on first use | `onnxruntime-node` + `transformers` install once (~600 MB) into a versioned root under `~/.pii_shield/deps/installs/`. This build uses deterministic `npm ci --ignore-scripts` (no sharp postinstall download). Check `~/.pii_shield/audit/ner_init.log` for progress and resolved onnxruntime paths. |
| Review panel shows 1 tab for 2 files | Confirm you're on this build (sha `fb8c03dd…` on the .mcpb). Older builds had this bug. |
| Something else weird | Check `~/.pii_shield/audit/ner_init.log`, `mcp_audit.log`, and (Mac/Linux) `/tmp/piish-banner-debug.log` (Win: `%TEMP%\piish-banner-debug.log`) — every tool call + the full NER init sequence + every banner stage are logged there. |

## Data locations (everything lives under `~/.pii_shield/`)

| Folder | What | Size |
|---|---|---|
| `models/gliner-pii-base-v1.0/` | NER model | 634 MB |
| `deps/` | Runtime node modules | ~600 MB |
| `mappings/` | Anonymization sessions (tiny) | KB-range |
| `audit/` | Logs | small, rotates |

All four survive plugin reinstalls. To fully uninstall: remove plugin in host + `rm -rf ~/.pii_shield/`.

## Feedback welcome on

1. The "one matter vs separate matters" question on multi-file upload — clear or confusing?
2. Review panel with N tabs — usable?
3. Cross-chat deanonymize via custom.xml — did it Just Work?
4. First-run deps install time — tolerable?
