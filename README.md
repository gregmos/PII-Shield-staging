<p align="center">
  <h1 align="center">🛡️ PII Shield</h1>
  <p align="center">
    <strong>Anonymize documents before Claude sees them. Restore real data after analysis.</strong>
  </p>
  <p align="center">
    <a href="https://github.com/gregmos/PII-Shield/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/gregmos/PII-Shield/test.yml?style=flat-square&label=tests" alt="Tests"></a>
    <a href="https://github.com/gregmos/PII-Shield/stargazers"><img src="https://img.shields.io/github/stars/gregmos/PII-Shield?style=flat-square&color=yellow" alt="GitHub Stars"></a>
    <a href="https://github.com/gregmos/PII-Shield/network/members"><img src="https://img.shields.io/github/forks/gregmos/PII-Shield?style=flat-square" alt="GitHub Forks"></a>
    <a href="https://github.com/gregmos/PII-Shield/releases/latest"><img src="https://img.shields.io/github/v/release/gregmos/PII-Shield?style=flat-square&color=brightgreen" alt="Latest Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License: MIT"></a>
    <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.10+"></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-green?style=flat-square" alt="MCP Server"></a>
    <a href="https://claude.ai/download"><img src="https://img.shields.io/badge/Claude-Desktop-cc785c?style=flat-square&logo=anthropic&logoColor=white" alt="Claude Desktop"></a>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
    <img src="https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS">
    <img src="https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux">
    &nbsp;&nbsp;
    <img src="https://img.shields.io/badge/GLiNER-NER-orange?style=flat-square" alt="GLiNER">
    <img src="https://img.shields.io/badge/Presidio-PII-blueviolet?style=flat-square" alt="Presidio">
    <img src="https://img.shields.io/badge/SpaCy-NLP-09A3D5?style=flat-square&logo=spacy&logoColor=white" alt="SpaCy">
  </p>
</p>

---

MCP server for [Claude Desktop](https://claude.ai/download) that reads your documents locally, replaces all personal data with placeholders (`<PERSON_1>`, `<ORG_1>`, etc.), and sends only the anonymized text to Claude. After analysis, PII Shield restores the original data into the final document — entirely on your machine. **PII never enters the API.**

```
Document ──> [PII Shield on your machine] ──> anonymized text ──> [Claude analyzes] ──> [PII Shield restores] ──> Result
              John Smith  → <PERSON_1>                                                   <PERSON_1> → John Smith
              Acme Corp.  → <ORG_1>                                                      <ORG_1>    → Acme Corp.
```

<!-- TODO: Add GIF/screenshot of HITL review UI here -->

## Features

| | Feature | Details |
|:-:|---------|---------|
| 🔒 | **Zero PII in API** | `anonymize_file` reads locally, returns only a file path. Claude reads the anonymized file from disk. |
| 🧠 | **GLiNER zero-shot NER** | [`knowledgator/gliner-pii-base-v1.0`](https://huggingface.co/knowledgator/gliner-pii-base-v1.0) (DeBERTa-v3). Handles ALL-CAPS, domain-specific names, multilingual text. |
| 👤 | **Human-in-the-Loop review** | Local web UI to verify entities: remove false positives, add missed ones. All occurrences updated automatically. |
| 📄 | **PDF + DOCX + plain text** | `.pdf`, `.docx` (formatting + tracked changes preserved), `.txt`, `.md`, `.csv` |
| 🇪🇺 | **17 EU pattern recognizers** | UK NIN/NHS, DE Tax ID, FR NIR, IT Fiscal Code, ES DNI/NIE, EU VAT/IBAN, and more |
| 🔗 | **Entity deduplication** | "Acme" → `<ORG_1>`, "Acme Corp." → `<ORG_1a>`, "Acme Corporation" → `<ORG_1b>` |
| ⚡ | **Self-bootstrapping** | Auto-installs all dependencies on first run. Optional pre-install for instant start. |
| 📊 | **Audit logging** | Every tool call logged locally. Proof that no PII left the machine. |

## Quick Start

### Prerequisites

- [Python 3.10+](https://www.python.org/downloads/)
  - **Windows**: check "Add Python to PATH" during installation
  - **macOS**: `brew install python` or [python.org](https://www.python.org/downloads/)
  - **Linux**: `sudo apt install python3 python3-pip` (or equivalent)
- [Claude Desktop](https://claude.ai/download) with Cowork

### Install

**1.** Download [`pii-shield-v1.0.0.dxt`](dist/pii-shield-v1.0.0.dxt) and [`pii-contract-analyze.skill`](dist/pii-contract-analyze.skill) from `dist/`

**2.** Install the MCP extension — Claude Desktop → **Settings → Extensions → Install extension** → select `.dxt`

**3.** Upload the skill — Claude Desktop → **Customize → Skills → + → Upload a skill** → select `.skill`

**4.** *(Optional)* Pre-install dependencies for instant startup:

```bash
# Windows
python setup_pii_shield.py

# macOS / Linux
python3 setup_pii_shield.py
```

Downloads ~1 GB of AI models and libraries. Without it, PII Shield auto-installs on first use (2-5 min, once only).

<details>
<summary>One-click installers (no command line)</summary>

- **Windows**: double-click [`setup_pii_shield.bat`](setup_pii_shield.bat)
- **macOS / Linux**: `chmod +x setup_pii_shield.sh && ./setup_pii_shield.sh`

</details>

### Use

1. Start a new conversation in Claude Desktop
2. Select the **pii-contract-analyze** skill
3. **Connect a folder** containing your document (click the folder icon)
4. Tell Claude what you need:

```
Analyze risks for the purchaser in contract.pdf and prepare a short memo
```

> ⚠️ **Do NOT attach files directly.** When you attach a file, Cowork sends its content in the API request — Claude sees raw data before PII Shield can process it. **Connect a folder** instead — Claude only gets the file path and calls `anonymize_file` locally.

## Privacy Architecture

Only **file paths** and **random session IDs** flow through the API. All anonymization and restoration happens locally.

| Stage | What happens | PII in API? |
|-------|-------------|:-----------:|
| **Anonymize** | Server reads file on host, writes anonymized text to disk, returns `output_path` | ❌ |
| **Claude reads** | Claude reads anonymized `.txt` — only sees placeholders | ❌ |
| **Review** | User reviews entities on localhost web UI | ❌ |
| **Re-anonymize** | Server applies user corrections internally | ❌ |
| **Deanonymize** | Server writes restored file to disk, returns only the path | ❌ |
| **Deliver** | Claude gives user the file path. Never reads the restored file. | ❌ |

## Human-in-the-Loop Review

After anonymization, Claude offers a review step with a local web UI:

1. Claude starts a **localhost-only** web server and shows you the URL
2. Full document with **color-coded entity highlights**
3. **Remove false positives** — click any entity (all occurrences removed)
4. **Add missed entities** — select text, choose type (all occurrences added)
5. **Approve** — Claude re-anonymizes with your corrections

Review runs on `localhost:8766`. PII never leaves your machine.

## MCP Tools

| Tool | Description |
|------|-------------|
| `anonymize_file` | Anonymize PII in a file (.pdf, .docx, .txt, .md, .csv). Returns `output_path` and `session_id`. |
| `anonymize_next_chunk` | Process next chunk of a large document. Call repeatedly until complete. |
| `get_full_anonymized_text` | Finalize chunked anonymization. Returns `output_path`, `session_id`, `docx_output_path`. |
| `start_review` | Start localhost HITL review server, return URL. |
| `get_review_status` | Check if user approved review. Returns status only (no PII). |
| `deanonymize_text` | Restore PII — writes to local file, returns path only. |
| `deanonymize_docx` | Restore PII in .docx preserving formatting and tracked changes. |
| `get_mapping` | Get placeholder keys and entity types (no real values). |
| `list_entities` | Server status, supported entity types, recent sessions. |
| `resolve_path` | Zero-config path resolution via marker file (maps VM paths to host paths). |
| `find_file` | Find a file by name in the configured working directory. |
| `scan_text` | Detect PII without anonymizing (preview mode). |

## Skill Modes

The included `pii-contract-analyze` skill supports:

| Mode | Description |
|------|-------------|
| **MEMO** | Legal analysis memo with risk assessment |
| **REDLINE** | Tracked changes with Word-native revision marks |
| **SUMMARY** | Brief overview of key terms and obligations |
| **COMPARISON** | Side-by-side diff of two documents |
| **BULK** | Process up to 5 files with prefixed placeholders |
| **ANONYMIZE-ONLY** | Just anonymize, no analysis |

## Detected Entity Types

**NER-based** (GLiNER zero-shot): `PERSON`, `ORGANIZATION`, `LOCATION`, `NRP`

**Pattern-based** (Presidio + EU recognizers): `EMAIL_ADDRESS`, `PHONE_NUMBER`, `URL`, `IP_ADDRESS`, `CREDIT_CARD`, `IBAN_CODE`, `CRYPTO`, `US_SSN`, `US_PASSPORT`, `US_DRIVER_LICENSE`, `UK_NHS`, `UK_NIN`, `UK_PASSPORT`, `DE_TAX_ID`, `FR_NIR`, `IT_FISCAL_CODE`, `ES_DNI`, `ES_NIE`, `CY_TIC`, `EU_VAT`

## Configuration

Set in Claude Desktop: **Settings → Extensions → PII Shield**

| Setting | Default | Description |
|---------|---------|-------------|
| Minimum NER score | `0.50` | Confidence threshold (0.0–1.0) |
| GLiNER model | `knowledgator/gliner-pii-base-v1.0` | HuggingFace model for zero-shot NER |
| Working directory | *(empty)* | Folder for automatic file resolution |

Environment variable `PII_MAPPING_TTL_DAYS` (default: `7`) — auto-delete mappings older than N days.

## Bootstrap

PII Shield starts accepting MCP connections in ~2 seconds. Heavy dependencies install in the background.

| Phase | What happens | Time |
|-------|-------------|------|
| **1** | Install `mcp` package | ~2s |
| **2** | Install heavy packages (PyTorch, Presidio, SpaCy, GLiNER) | 2-4 min |
| **3** | Download NER models (GLiNER, SpaCy tokenizer) | 1-2 min |

On subsequent launches, startup takes ~30 seconds (model loading only).

## Logs

Two local log files — neither is sent anywhere.

| Log | Location | Purpose |
|-----|----------|---------|
| **Audit** | `~/.pii_shield/audit/mcp_audit.log` | Every tool call and response. Proof that only paths and session IDs flow through the API. |
| **NER debug** | `~/.pii_shield/audit/ner_debug.log` | Raw detections, skip reasons, anonymization mapping. |

## Development

```bash
# Run server (stdio)
python server/pii_shield_server.py

# Run server (SSE)
python server/pii_shield_server.py --sse

# Pre-install dependencies
python setup_pii_shield.py

# Build DXT bundle
npx @anthropic-ai/dxt pack .
```

<details>
<summary>Project structure</summary>

```
PII-Shield/
├── server/
│   ├── pii_shield_server.py    # MCP server
│   ├── eu_recognizers.py       # 17 EU pattern recognizers
│   ├── review_ui.html          # HITL review web UI
│   ├── requirements.txt
│   └── pyproject.toml
├── pii-contract-analyze/
│   └── SKILL.md                # Skill instructions for Claude
├── dist/
│   ├── pii-shield-v1.0.0.dxt  # Ready-to-install MCP extension
│   └── pii-contract-analyze.skill
├── manifest.json               # DXT manifest
├── setup_pii_shield.py         # Pre-install script (Python)
├── setup_pii_shield.bat        # Pre-install script (Windows)
├── setup_pii_shield.sh         # Pre-install script (macOS/Linux)
├── LICENSE
└── README.md
```

</details>

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Python not found" | Install [Python 3.10+](https://www.python.org/downloads/), check "Add to PATH" |
| First run takes long | Run `python setup_pii_shield.py` first, or wait 2-5 min for auto-install |
| Tools not appearing | Send any message to Claude — tool list refreshes on new message |
| pip install failed | Check internet. Corporate firewalls may block PyPI or HuggingFace |
| Review page not loading | Check that port 8766 is free (8767 as fallback) |
| Too many false positives | Raise `PII_MIN_SCORE` in settings. 212-term stoplist active by default. |

## Acknowledgments

PII Shield builds on a number of excellent open-source projects:

- **[GLiNER](https://github.com/urchade/GLiNER)** + [`knowledgator/gliner-pii-base-v1.0`](https://huggingface.co/knowledgator/gliner-pii-base-v1.0) — zero-shot NER backbone.
- **[Microsoft Presidio](https://github.com/microsoft/presidio)** — pattern recognizers and the EU regulatory pack.
- **[spaCy](https://spacy.io/)** — tokenization and linguistic pre-processing.
- **[`dealfluence/adeu`](https://github.com/dealfluence/adeu)** (MIT) — agentic redlining engine for `.docx`. PII Shield's v2.0.0 `.docx` pipeline ships an optional Python sidecar that uses `python-docx` + `lxml` for run-aware text replacement and native Word track-changes (`w:ins` / `w:del`); when `adeu` is reachable on PyPI it's installed alongside as a more robust reconciler. Both code paths fall back gracefully to PII Shield's pure-Node.js docx engine if Python is unavailable.
- **[Claude Desktop](https://claude.ai/download)** + the [Model Context Protocol](https://modelcontextprotocol.io) — host runtime and tool surface.

## Author

**Grigorii Moskalev** — [LinkedIn](https://www.linkedin.com/in/grigorii-moskalev/)

## License

[MIT](LICENSE)
