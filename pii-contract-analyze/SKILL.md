---
name: pii-contract-analyze
description: "Universal legal document processor with PII anonymization. Anonymize → Work → Deanonymize. Modes: MEMO (legal analysis), REDLINE (tracked changes in contract), SUMMARY (brief overview), COMPARISON (diff two docs), BULK (up to 5 files). Supports .docx and .pdf input. Trigger for: contract review, risk analysis, compliance check, GDPR review, clause analysis, tracked changes, redline, 'anonymize', 'pii shield'. If user uploads contract/NDA/DSAR/HR doc — USE THIS SKILL. If user says 'skip pii' or 'don't anonymize' — skip anonymization and work directly."
---

# PII Shield — Universal Legal Document Processor

Anonymize → Work → Deanonymize → Deliver. Claude NEVER sees raw PII at any stage.

## CRITICAL: PII never flows through Claude

**File handling**: The user must connect a folder (not attach the file directly to the message). When a file is attached to a Cowork message, its content is rendered and sent to the API as part of the prompt — Claude sees the raw data before PII Shield can process it. When a folder is connected, Claude only sees the file path and calls `anonymize_file(path)` — the MCP server on the host reads and anonymizes the file locally. PII never enters Claude's context.

**If the user attaches a file directly**: Warn them politely: "For full PII protection, please connect the folder containing your document instead of attaching it directly. When a file is attached to a message, its content is included in the API request before PII Shield can anonymize it. I can still process it, but the privacy guarantee is stronger when you connect the folder."

- `anonymize_file` reads the file on the host, anonymizes locally, writes result to disk, returns only `output_path` + `session_id` to Claude. Claude reads the anonymized text from the output file.
- `deanonymize_*` tools write results to LOCAL FILES and return only the file path
- `get_mapping` returns only placeholder keys and types — no real values
- **ABSOLUTE BAN**: Claude must NEVER read, open, cat, head, pandoc, or in any way access the content of deanonymized/restored files. Not to "verify", not to "check formatting", not to "validate" — NEVER. These files contain real PII. Just give the user the file path and STOP. Any "verification" of deanonymized output is a PII leak.
- Claude must NEVER read the source file (via Read tool, pandoc, python, bash, etc.) BEFORE or INSTEAD OF anonymization — always use `anonymize_file(path)` first
- If an anonymize tool times out or fails with a NON-"tool not found" error — retry once. If it still fails, tell the user PII Shield is unavailable and ask whether to proceed without anonymization or abort. NEVER fall back to reading the raw file.
- **NEVER** use `anonymize_text` or `scan_text` — these take raw text as input which means PII passes through the API. The ONLY exception is if the user explicitly pastes text into the chat (PII is already in the conversation).

## Startup

PII Shield tools are always visible in the tool list immediately after installation.

On first use (or after updates), the backend downloads AI models. Any tool call during this time returns a loading status with progress details.

### Startup procedure

1. Identify the file(s) to process and determine the mode (MEMO, REDLINE, etc.)
2. Create the marker file for path resolution (see `references/path-resolution.md`)
3. Call `list_entities` to check status, or go straight to `anonymize_file`
   - If `"status": "ready"` — proceed
   - If `"status": "loading"` — display progress to user (see below), wait `retry_after_sec` seconds, retry. Repeat up to 15 times.
   - If `"error"` field present — show error and suggestion to user

### How to display loading progress

When PII Shield returns `"status": "loading"`, the response includes `phase`, `message`, and `progress_pct`. Show the user a **single concise status line** that updates on each retry. Format:

**PII Shield loading [{progress_pct}%]: {message}**

Phase meanings (for your context, don't show phase names to user):
- `starting` (0%) — Python subprocess just launched
- `packages` (5-20%) — Installing dependencies (first run only, takes 3-8 min)
- `models` (30-55%) — Downloading/loading SpaCy and GLiNER models
- `engine` (85%) — Initializing PII detection engine
- `ready` (100%) — Ready

**RULES**:
- Do NOT say "this is taking longer than usual" — first startup IS long (3-8 min), that's normal
- Do NOT say "hang tight" or other filler — just show the progress line
- Do NOT offer to "work without anonymization" or skip PII Shield
- Do NOT repeat explanations on each retry — just update the progress line
- While waiting, you CAN do useful prep work (create marker files, read skill docs, plan the analysis)

### Long document handling (chunked processing)

For documents >15K characters, `anonymize_file` returns `"status": "chunked"`. **Chunked processing flow:**
1. `anonymize_file(path)` returns `session_id`, `total_chunks`, `processed_chunks: 1`
2. Loop: call `anonymize_next_chunk(session_id)` until `status` is `"complete"` — show "Anonymizing... [chunk X/Y]"
3. Call `get_full_anonymized_text(session_id)` to finalize — returns `output_path`, `session_id`, `output_dir`
4. Continue with the normal pipeline using the returned values

For short documents (<15K chars), `anonymize_file` processes everything in one call.

### File path resolution

MCP tools run on the HOST, not in the VM. Create a marker file next to the target, call `resolve_path(filename, marker)` to get the host path. For full details and fallback methods, read `references/path-resolution.md`.

All PII Shield tools are registered as MCP tools with prefix `mcp__PII_Shield__`.

## Available MCP tools

| MCP tool name | Parameters | Returns to Claude |
|---|---|---|
| `mcp__PII_Shield__anonymize_file` | file_path, language, prefix, **review_session_id** | output_path (.txt) + session_id + output_dir + docx_output_path (.docx, for .docx input only). For long docs: returns `status: "chunked"` with session_id and total_chunks. |
| `mcp__PII_Shield__anonymize_next_chunk` | session_id | Progress: processed_chunks, total_chunks, progress_pct, entities_so_far |
| `mcp__PII_Shield__get_full_anonymized_text` | session_id | output_path, session_id, output_dir, docx_output_path (same as anonymize_file) |
| `mcp__PII_Shield__resolve_path` | filename, marker, vm_dir | host_path, host_dir (zero-config VM-to-host path resolution) |
| `mcp__PII_Shield__deanonymize_text` | text, session_id, output_path | **File path only** (takes anonymized text, writes deanonymized file) |
| `mcp__PII_Shield__deanonymize_docx` | file_path, session_id | **File path only** |
| `mcp__PII_Shield__get_mapping` | session_id | Placeholder keys + types only |
| `mcp__PII_Shield__list_entities` | — | Server status and config |
| `mcp__PII_Shield__find_file` | filename | Full host path(s) — searches configured work_dir only (fallback) |
| `mcp__PII_Shield__start_review` | session_id | URL of local review page |
| `mcp__PII_Shield__get_review_status` | session_id | **status + has_changes only** (no PII or override details) |

**DO NOT USE these tools** (they exist on the server but must not be called for file workflows):
- `anonymize_text` — sends raw text through the API. Only acceptable if user pasted text into chat.
- `scan_text` — sends raw text through the API.
- `anonymize_docx` — use `anonymize_file` instead (handles .docx automatically).

**`prefix` parameter**: Use for multi-file workflows to avoid placeholder collisions. Example: `prefix="D1"` → `<D1_ORG_1>`, `prefix="D2"` → `<D2_ORG_1>`. Each file gets its own prefix and session_id.

**`review_session_id` parameter**: Pass the `session_id` from a previous `anonymize_file` call after HITL review. The server fetches the user's overrides internally and re-anonymizes. PII never passes through Claude.

**Preferred approach**: Always use `anonymize_file(file_path)` — only the file path passes through the API. Use `resolve_path(filename, marker)` to resolve the host path, or `find_file(filename)` as fallback.

## Skip mode

If user says "skip pii shield", "don't anonymize", "work directly" — skip anonymization, work with the file directly.

---

## Reference files — read BEFORE starting the mode

Load the appropriate reference file(s) based on the detected mode. Reference files are in the `references/` directory next to this SKILL.md.

| Mode / Phase | Read BEFORE starting work |
|---|---|
| All modes | `references/hitl-review.md` (at the HITL Review step) |
| Path issues | `references/path-resolution.md` (for host path resolution details) |
| MEMO | `references/memo-writing-style.md` + `references/docx-formatting.md` |
| REDLINE | `references/redline-tracked-changes.md` |
| SUMMARY | `references/docx-formatting.md` |
| COMPARISON | `references/comparison-mode.md` + `references/docx-formatting.md` |
| BULK | `references/bulk-mode.md` + reference file(s) for the wrapped mode |
| ANONYMIZE-ONLY | No reference files needed |

**You MUST read the listed reference file(s) BEFORE starting analysis, not after.**

---

## Human-in-the-Loop Review (mandatory)

HITL review is **mandatory** after every `anonymize_file` call, unless the user has set `skip_review: true` in extension settings (Settings → Extensions → PII Shield). Check the `PII_SKIP_REVIEW` environment variable — if it equals `"true"`, skip the review step entirely.

**When review is active** (default), call `start_review(session_id)` — it returns a self-contained HTML review file. Then follow this two-step protocol exactly:

1. **Read the file first.** The response contains a `next_action` object with a `file_path`. **You MUST call your built-in `Read` tool on that path before saying anything to the user.** Reading the file is what registers it with Cowork's Artifacts pane so the user can click to preview — if you skip this step, no preview affordance appears and the user has nothing to click.
2. **Then send the `user_message` field verbatim** as your reply. Do not paraphrase, shorten, or add to it — it tells the user exactly what to do (open the artifact, review highlighted PII, click Approve, then say "done").

After sending the user_message, ask via AskUserQuestion: **"Let me know once you've clicked Approve in the review page."** with options: **"Done — apply my changes"** / **"Skip — keep original detections"**.

When the user picks **Done**:

1. **Preferred path (works in Cowork's sandboxed file viewer):** the review page will display an opaque code starting with `PII_DECISIONS_v1:` after the user clicks Approve. Ask the user to **paste that code** into the chat, then call `apply_review_decisions(session_id, decisions_code=<the pasted code>)`. The code is encrypted with a per-session key the server holds — you (the LLM) only ever see ciphertext, never the user's PII decisions. Do NOT try to read, parse, or interpret the code yourself; pass it through verbatim.
2. **Fallback path (regular browser, file actually downloaded):** if the user says they didn't see a code but the JSON file downloaded normally, call `apply_review_decisions(session_id)` with no `decisions_code`. The server will locate `review_<session_id>_decisions.json` in Downloads / the workspace automatically — **never ask the user for a path**.

If the call returns `error: "Decisions file ... not found"` or `error: "Failed to decode decisions_code"`, prompt the user once more (ask them to either click Approve again, or copy the code more carefully), then retry. Do not loop more than twice.

If `apply_review_decisions` returns `has_changes: true`, you MUST re-run `anonymize_file(path, review_session_id=session_id)` and discard the old `session_id`, `output_path`, and `docx_output_path` — use ALL the new values returned by the second call. If `has_changes: false`, keep the original session.

**Read `references/hitl-review.md` for the full pipeline and edge cases.**

---

## MODE DETECTION

Detect the mode from the user's request. If ambiguous, ask.

| User says | Mode |
|---|---|
| "review contract", "risk analysis", "legal analysis", "write a memo", "compliance check" | **MEMO** |
| "tracked changes", "redline", "mark up", "make client-friendly", "edit the contract" | **REDLINE** |
| "summarize", "overview", "brief summary", "what's in the contract" | **SUMMARY** |
| "compare documents", "diff", "what changed", "differences" | **COMPARISON** |
| Multiple files uploaded + any of the above | **BULK** (wraps any mode above) |
| "just anonymize", "anonymize only", "only anonymization" | **ANONYMIZE-ONLY** |

---

## MODE: MEMO (Legal Analysis)

Full legal memorandum with risk assessment. The default mode. Read `references/memo-writing-style.md` + `references/docx-formatting.md` before starting.

### Pipeline

1. Warm-up: `list_entities()` → confirm tools loaded
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → output_path, session_id, output_dir. Read anonymized text from output_path.
4. HITL Review (see `references/hitl-review.md`). If changes: re-anonymize, use ALL new values.
5. Analyze anonymized text → structured memo with `<ORG_1>` etc.
6. Create formatted .docx via docx-js (see `references/docx-formatting.md`)
7. `deanonymize_docx(formatted.docx, session_id)` → final.docx
8. Copy to mnt/outputs/, present link. **DO NOT read/verify deanonymized file.**

---

## MODE: REDLINE (Tracked Changes)

Apply tracked changes to make the contract more favorable. Output: .docx with Word-native revision marks. Read `references/redline-tracked-changes.md` before starting.

### Pipeline

1. Warm-up: `list_entities()` → confirm tools loaded
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → output_path (.txt), docx_output_path (.docx), output_dir, session_id. Read anonymized text from output_path. Keep docx_output_path for Step 6.
4. HITL Review (see `references/hitl-review.md`). If changes: re-anonymize, use ALL new values including NEW docx_output_path.
5. Analyze: identify clauses to change, draft new wording (all in placeholders)
6. Apply tracked changes to anonymized .docx via OOXML (see `references/redline-tracked-changes.md`). Save in output_dir.
7. `deanonymize_docx(tracked_changes.docx, session_id)` → final.docx
8. Copy to mnt/outputs/, present link. **DO NOT read/verify deanonymized file.**

---

## MODE: SUMMARY (Brief Overview)

Concise document summary. Read `references/docx-formatting.md` before creating .docx.

### Pipeline

1. Warm-up: `list_entities()` → confirm tools loaded
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → output_path, session_id, output_dir. Read anonymized text from output_path.
4. HITL Review (see `references/hitl-review.md`). If changes: re-anonymize, use ALL new values.
5. Write summary (1–2 pages max) with placeholders
6. Create formatted .docx via docx-js
7. `deanonymize_docx(summary.docx, session_id)` → final.docx
8. Copy to mnt/outputs/, present link. **DO NOT read/verify deanonymized file.**

### Summary structure

1. **Header**: Document type + parties (`Purchase Order between <ORG_1> and <ORG_2>`)
2. **Key terms table**: Party A, Party B, Subject, Term, Total value, Payment terms, Governing law
3. **Notable provisions**: 3–5 bullet points on unusual or important clauses
4. **Risk flags**: Brief list of potential issues (if any)

---

## MODE: COMPARISON (Diff Two Documents)

Read `references/comparison-mode.md` + `references/docx-formatting.md` before starting. Full pipeline is in the reference file.

---

## MODE: BULK (Multiple Files)

Read `references/bulk-mode.md` + reference file(s) for the wrapped mode before starting. Full pipeline is in the reference file.

---

## MODE: ANONYMIZE-ONLY

Just anonymize and return the anonymized file. No analysis. No reference files needed.

### Pipeline

1. Warm-up: `list_entities()` → confirm tools loaded
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → output_path, session_id, output_dir. Read anonymized text from output_path.
4. HITL Review (see `references/hitl-review.md`). If changes: re-anonymize, use ALL new values.
5. Copy anonymized file to mnt/outputs/
6. Present link to user
7. Tell user the session_id in case they need deanonymization later
