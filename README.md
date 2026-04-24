<p align="center">
  <h1 align="center">🛡️ PII Shield</h1>
  <p align="center">
    <strong>Anonymize documents before Claude sees them. Restore real data after analysis.</strong>
  </p>
  <p align="center">
    <a href="https://github.com/gregmos/PII-Shield/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/gregmos/PII-Shield/test.yml?style=flat-square&label=CI" alt="CI"></a>
    <a href="https://github.com/gregmos/PII-Shield/stargazers"><img src="https://img.shields.io/github/stars/gregmos/PII-Shield?style=flat-square&color=yellow" alt="GitHub Stars"></a>
    <a href="https://github.com/gregmos/PII-Shield/network/members"><img src="https://img.shields.io/github/forks/gregmos/PII-Shield?style=flat-square" alt="GitHub Forks"></a>
    <a href="https://github.com/gregmos/PII-Shield/releases/latest"><img src="https://img.shields.io/github/v/release/gregmos/PII-Shield?style=flat-square&color=brightgreen" alt="Latest Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License: MIT"></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 18+"></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-green?style=flat-square" alt="MCP Server"></a>
    <a href="https://claude.ai/download"><img src="https://img.shields.io/badge/Claude-Desktop-cc785c?style=flat-square&logo=anthropic&logoColor=white" alt="Claude Desktop"></a>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
    <img src="https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS">
    <img src="https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux">
    &nbsp;&nbsp;
    <img src="https://img.shields.io/badge/GLiNER-NER-orange?style=flat-square" alt="GLiNER">
    <img src="https://img.shields.io/badge/ONNX-runtime-005CED?style=flat-square&logo=onnx&logoColor=white" alt="ONNX Runtime">
    <img src="https://img.shields.io/badge/MCPB-package-green?style=flat-square" alt="MCPB package">
  </p>
</p>

---

MCP server for [Claude Desktop](https://claude.ai/download) that reads your documents locally, replaces all personal data with placeholders (`<PERSON_1>`, `<ORG_1>`, etc.), and sends only the anonymized text to Claude. After analysis, PII Shield restores the original data into the final document — entirely on your machine. **PII never enters the API.**

```
Document ──> [PII Shield on your machine] ──> anonymized text ──> [Claude analyzes] ──> [PII Shield restores] ──> Result
              John Smith  → <PERSON_1>                                                   <PERSON_1> → John Smith
              Acme Corp.  → <ORG_1>                                                      <ORG_1>    → Acme Corp.
```

> **v2.0.2 is a complete Node.js rewrite.** The original Python product is still available — see [What happened to v1?](#what-happened-to-v1) below.

## Features

| | Feature | Details |
|:-:|---------|---------|
| 🔒 | **Zero PII in API** | `anonymize_file` reads locally, returns only a file path. Claude reads the anonymized file from disk. |
| 🧠 | **GLiNER zero-shot NER** | [`knowledgator/gliner-pii-base-v1.0`](https://huggingface.co/knowledgator/gliner-pii-base-v1.0) via ONNX Runtime. Handles ALL-CAPS, domain-specific names, multilingual text. No Python, no PyTorch. |
| 👤 | **Human-in-the-Loop review** | MCP Apps iframe UI rendered directly in Claude Desktop. Remove false positives, add missed entities — all occurrences updated automatically. |
| 📄 | **PDF + DOCX + plain text** | `.pdf`, `.docx` (formatting + tracked changes preserved), `.txt`, `.md`, `.csv` |
| 🇪🇺 | **17 EU pattern recognizers** | UK NIN/NHS, DE Tax ID, FR NIR, IT Fiscal Code, ES DNI/NIE, EU VAT/IBAN, and more |
| 🔗 | **Entity deduplication** | "Acme" → `<ORG_1>`, "Acme Corp." → `<ORG_1a>`, "Acme Corporation" → `<ORG_1b>` |
| ⚡ | **Thin bundle** | ~660 KB `.mcpb` thin-installs in Claude Desktop; runtime deps self-install deterministically on first call. |
| 🍎 | **macOS binary variant** | Ships with bundled Node 24.15.0 for macOS arm64 + x64 — avoids Claude Desktop's darwin host-runtime launch bug. |
| 📊 | **Audit logging** | Every tool call logged locally to `~/.pii_shield/audit/`. Proof that no PII left the machine. |

## Quick Start

### Prerequisites

- [Claude Desktop](https://claude.ai/download) (any recent version)
- Windows or Linux: any system Node will do — Claude Desktop already ships a compatible runtime. No install needed.
- macOS: download the macOS-specific `.mcpb` below; it bundles its own Node runtime. No system Node install needed.

### Step 1 — download the model (~634 MB, one time)

**Windows (PowerShell):**
```powershell
iwr https://raw.githubusercontent.com/gregmos/PII-Shield/main/nodejs-v2/scripts/install-model.ps1 | iex
```

**macOS / Linux (Terminal):**
```bash
curl -fsSL https://raw.githubusercontent.com/gregmos/PII-Shield/main/nodejs-v2/scripts/install-model.sh | bash
```

The one-liner downloads `gliner-pii-base-v1.0.zip` from the [GitHub release page](https://github.com/gregmos/PII-Shield/releases) and unpacks it into `~/.pii_shield/models/gliner-pii-base-v1.0/`. No file left on disk — avoids Windows SmartScreen and macOS Gatekeeper prompts.

Prefer to download the script and inspect it first? Grab `install-model.ps1` / `install-model.sh` (+ the double-click wrappers `install-model.bat` / `install-model.command`) from the same [release page](https://github.com/gregmos/PII-Shield/releases).

### Step 2 — install the plugin

Download the MCPB for your OS from the [release page](https://github.com/gregmos/PII-Shield/releases) and drag-drop it into Claude Desktop (**Settings → Extensions**):

| OS | Download |
|---|---|
| **Windows / Linux** | `pii-shield-v2.0.2-windows-linux.mcpb` (~660 KB — uses host Node) |
| **macOS** (arm64 + x64) | `pii-shield-v2.0.2-macos.mcpb` (~82 MB — bundles Node 24.15.0) |

On the first call the plugin runs `npm ci --ignore-scripts` to install a pinned, deterministic set of runtime deps (`onnxruntime-node`, `@xenova/transformers`, `gliner`) into `~/.pii_shield/deps/installs/<slug>/`. 2–3 minutes once per machine, instant thereafter.

### Step 3 — install the skill (optional but recommended)

Grab `pii-contract-analyze.zip` from the same release, unpack into `~/.claude/skills/` (or load it via Cowork). The skill orchestrates end-to-end contract anonymization + analysis; without it the MCP tools still work but you'd be driving them by hand.

### Use

1. Start a new conversation in Claude Desktop
2. Select the **pii-contract-analyze** skill
3. **Connect a folder** containing your document (click the folder icon)
4. Tell Claude what you need:

```
Analyze risks for the purchaser in contract.pdf and prepare a short memo
```

> ⚠️ **Do NOT attach files directly.** When you attach a file, Claude Desktop sends its content in the API request — Claude sees raw data before PII Shield can process it. **Connect a folder** instead — Claude only gets the file path and calls `anonymize_file` locally.

## Privacy architecture

Only **file paths** and **random session IDs** flow through the API. All anonymization and restoration happens locally.

| Stage | What happens | PII in API? |
|-------|-------------|:-----------:|
| **Anonymize** | Server reads file on host, writes anonymized text to disk, returns `output_path` | ❌ |
| **Claude reads** | Claude reads anonymized `.txt` — only sees placeholders | ❌ |
| **Review** | User reviews entities in MCP Apps iframe (rendered in Claude Desktop) | ❌ |
| **Re-anonymize** | Server applies user corrections internally | ❌ |
| **Deanonymize** | Server writes restored file to disk, returns only the path | ❌ |
| **Deliver** | Claude gives user the file path. Never reads the restored file. | ❌ |

## Human-in-the-Loop review

After anonymization, Claude offers a review step rendered directly in Claude Desktop via [MCP Apps](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#mcp-apps):

1. Claude calls `start_review` — Claude Desktop opens a panel inside the conversation
2. Full document with **color-coded entity highlights**
3. **Remove false positives** — click any entity (all occurrences removed)
4. **Add missed entities** — select text, choose type (all occurrences added)
5. **Approve** — Claude calls `apply_review_overrides`, the server re-anonymizes with your corrections

No localhost web server, no browser detours — the UI is a Vite single-file iframe served to Claude Desktop as a `ui://` MCP resource.

## Cross-session deanonymize

Every anonymized `.docx` PII Shield writes carries its `session_id` inside Word custom document properties (`docProps/custom.xml`). Later, in a brand new chat, you can:

1. Drop the anonymized `.docx` into a connected folder — no need to remember the session id, no screenshots of placeholders, nothing.
2. Ask Claude to "restore PII in this file."
3. PII Shield's `deanonymize_docx` reads the embedded `session_id`, looks up the mapping in `~/.pii_shield/mappings/`, and writes the restored file next to the input.

Mappings live at `~/.pii_shield/mappings/` — same root as `models/`, `deps/`, and `audit/`. The root survives plugin upgrades and `/plugin remove` because it's in the user's home dir, not Claude Desktop's per-plugin `CLAUDE_PLUGIN_DATA` (which isn't set for MCPB plugins anyway).

Time-based TTL is controlled by `PII_MAPPING_TTL_DAYS` (default: **7 days**) — the server cleans up mappings older than that on startup. Bump it for longer-lived matters (`PII_MAPPING_TTL_DAYS=90`, etc.) via Claude Desktop → Extensions → PII Shield → Settings. If a mapping is missing when you try to deanonymize, `deanonymize_docx` returns a clean error with a hint to `import_session` (see Team handoff below) rather than silently skipping entities.

Plain `.txt` / `.md` output has no place to embed metadata, so the `deanonymize_text` tool takes the `session_id` explicitly as an argument.

## Multi-file sessions

Anonymize several related documents under one `session_id`:

1. First call: `anonymize_file(path_A)` — server returns `session_id=SID123`.
2. Second call: `anonymize_file(path_B, session_id="SID123")` — PII Shield extends the same mapping. Identical entities across the two files share the **same placeholder** (`Acme Corp.` becomes `<ORG_1>` in both).
3. You write a memo in Claude that mixes placeholders from both files.
4. One `deanonymize_text(..., session_id="SID123")` call on the memo restores PII everywhere.

The `pii-contract-analyze` skill drives this automatically when the user uploads N ≥ 2 files and confirms they belong to one matter. See `plugin/skills/pii-contract-analyze/references/bulk-mode.md` for the full decision tree.

## Team handoff — export / import a session

If a colleague needs to work on the same documents without you re-sharing PII:

1. You call `export_session(session_id, passphrase)` — server packs the mapping + anonymized documents into an encrypted `.pii-session` archive (AES-GCM with a key derived from the passphrase via scrypt).
2. Send them the `.pii-session` file (email, Slack, thumb drive — it's useless without the passphrase).
3. They call `import_session(path, passphrase)` on their machine — the mapping lands under their `~/.pii_shield/mappings/` and they can now `deanonymize_docx` locally.

PII never leaves the anonymized documents in transit. The archive format is versioned (`.pii-session` v1), so future schema changes will stay readable.

## MCP tools

| Tool | Description |
|------|-------------|
| `anonymize_file` | Anonymize PII in a file (.pdf, .docx, .txt, .md, .csv). Returns `output_path` and `session_id`. |
| `anonymize_next_chunk` | Process next chunk of a large document. Call repeatedly until complete. |
| `get_full_anonymized_text` | Finalize chunked anonymization. Returns `output_path`, `session_id`, `docx_output_path`. |
| `start_review` | Open the in-conversation review panel. |
| `apply_review_overrides` | Apply reviewer corrections and re-anonymize. |
| `deanonymize_text` | Restore PII — writes to local file, returns path only. |
| `deanonymize_docx` | Restore PII in .docx preserving formatting and tracked changes. |
| `get_mapping` | Get placeholder keys and entity types (no real values). |
| `list_entities` | Server status, supported entity types, recent sessions. |
| `resolve_path` | Zero-config path resolution via marker file (maps VM paths to host paths). |
| `find_file` | Find a file by name in the configured working directory. |
| `scan_text` | Detect PII without anonymizing (preview mode). |
| `export_session` / `import_session` | Portability — hand a session between hosts. |

## Skill modes

The included `pii-contract-analyze` skill supports:

| Mode | Description |
|------|-------------|
| **MEMO** | Legal analysis memo with risk assessment |
| **REDLINE** | Tracked changes with Word-native revision marks |
| **SUMMARY** | Brief overview of key terms and obligations |
| **COMPARISON** | Side-by-side diff of two documents |
| **BULK** | Process up to 5 files with prefixed placeholders |
| **ANONYMIZE-ONLY** | Just anonymize, no analysis |

## Detected entity types

**NER-based** (GLiNER zero-shot over ONNX Runtime): `PERSON`, `ORGANIZATION`, `LOCATION`, `NRP`

**Pattern-based** (pure-JS recognizers, covering the EU regulatory pack): `EMAIL_ADDRESS`, `PHONE_NUMBER`, `URL`, `IP_ADDRESS`, `CREDIT_CARD`, `IBAN_CODE`, `CRYPTO`, `US_SSN`, `US_PASSPORT`, `US_DRIVER_LICENSE`, `UK_NHS`, `UK_NIN`, `UK_PASSPORT`, `DE_TAX_ID`, `FR_NIR`, `IT_FISCAL_CODE`, `ES_DNI`, `ES_NIE`, `CY_TIC`, `EU_VAT`

## Logs

| Log | Location | Purpose |
|-----|----------|---------|
| **Audit** | `~/.pii_shield/audit/mcp_audit.log` | Every tool call and response. Proof that only paths and session IDs flow through the API. |
| **NER init** | `~/.pii_shield/audit/ner_init.log` | Bootstrap trace — resolved ORT paths for root / transformers / gliner, sanity-check outcome, install timings. |
| **Server** | `~/.pii_shield/audit/pii_shield_server.log` | stdout/stderr of the Node MCP server process. |

## Development

All code lives in `nodejs-v2/`. From that directory:

```bash
# Install exact-pinned dev deps
npm ci --ignore-scripts --legacy-peer-deps

# Type-check
node node_modules/typescript/bin/tsc --noEmit

# Build the thin .mcpb (Windows / Linux + darwin via platform overrides)
npm run build:plugin

# Also build the darwin-universal .mcpb (downloads Node 24.15.0 arm64 + x64)
npm run build:plugin:mac

# MCP protocol smoke test
npm run smoke

# Focused clean-install smoke for the sharp shim + transformers + gliner
npm run smoke:sharp-shim
```

<details>
<summary>Project structure</summary>

```
PII-Shield/
├── nodejs-v2/                                        # The product
│   ├── src/
│   │   ├── index.ts                                  # MCP tool handlers
│   │   ├── engine/ner-backend.ts                     # GLiNER + ONNX runtime boot
│   │   ├── docx/ pdf/ mapping/ audit/                # Document pipelines
│   │   └── portability/                              # session export/import
│   ├── plugin/
│   │   ├── build-plugin.mjs                          # thin .mcpb builder
│   │   ├── build-mac-binary.mjs                      # darwin-universal .mcpb builder (bundles Node 24.15.0)
│   │   └── skills/
│   │       ├── pii-contract-analyze/                 # canonical skill source (SKILL.md + references/*.md)
│   │       └── pii-contract-analyze.zip              # release artefact — auto-rebuilt from the source dir by build-plugin.mjs
│   ├── scripts/
│   │   ├── install-model.{ps1,bat,sh,command}
│   │   ├── smoke-protocol.mjs
│   │   └── smoke-sharp-shim.mjs
│   ├── manifest.json                                 # MCPB manifest (server.type=node)
│   └── package.json
├── .github/workflows/test.yml                        # Node CI (ubuntu + windows + macos, Node 18 + 20)
├── LICENSE
└── README.md
```

</details>

## Troubleshooting

| Problem | Solution |
|---------|----------|
| First run is slow | First-ever call does `npm ci` into `~/.pii_shield/deps/` (~2–3 min). Subsequent runs are instant. |
| "GLiNER model not found" / `needs_setup` response | Run `install-model.ps1` (Windows) or `install-model.sh` (macOS / Linux). See Quick Start Step 1. |
| `Unsupported model IR version: 9` | Old `onnxruntime-node` cached. Delete `~/.pii_shield/deps/` — next run reinstalls with the pinned 1.22.0 triplet. |
| `Cannot find module '../build/Release/sharp-*.node'` | `sharp` has no native addon for your platform. PII Shield's shim intercepts `sharp` loads (text-only NER doesn't use it). If you still see this, you're on an older build — upgrade to v2.0.2. |
| Review panel blank | Check `~/.pii_shield/audit/pii_shield_server.log` for MCP Apps resource errors. Claude Desktop version < 0.10 doesn't render `ui://` resources. |
| Tools not appearing | Restart Claude Desktop or send any message — the tool list refreshes on reconnect. |

## What happened to v1?

v1.0.0 was a Python MCP server built on presidio + SpaCy + GLiNER/py, shipped as a `.dxt` bundle. It's still available:

- Tag [`v1.0.0`](https://github.com/gregmos/PII-Shield/releases/tag/v1.0.0) — pinned source.
- Branch `python-legacy` — full tree before the Node.js rewrite.

v2 is a complete architectural reset — Node.js, pure-JS `.docx`, MCP Apps UI, thin `.mcpb` — not a drop-in upgrade.

## Acknowledgments

PII Shield builds on excellent open-source projects:

- **[GLiNER](https://github.com/urchade/GLiNER)** + [`knowledgator/gliner-pii-base-v1.0`](https://huggingface.co/knowledgator/gliner-pii-base-v1.0) — zero-shot NER backbone.
- **[onnxruntime-node](https://github.com/microsoft/onnxruntime)** — the CPU inference engine.
- **[`@xenova/transformers`](https://github.com/xenova/transformers.js)** — tokenizer + HF weights loader on top of ONNX Runtime.
- **[docx](https://github.com/dolanmiu/docx)** + **[jszip](https://stuk.github.io/jszip/)** + **[@ansonlai/docx-redline-js](https://github.com/ansonlai/docx-redline-js)** — pure-JS `.docx` read / write / track-changes.
- **[Claude Desktop](https://claude.ai/download)** + the [Model Context Protocol](https://modelcontextprotocol.io) — host runtime and tool surface.

## Author

**Grigorii Moskalev** — [LinkedIn](https://www.linkedin.com/in/grigorii-moskalev/)

## License

[MIT](LICENSE)
