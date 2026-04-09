---
name: pii-contract-analyze
description: "Universal legal document processor with PII anonymization. Anonymize → Work → Deanonymize. Modes: MEMO (legal analysis), REDLINE (tracked changes in contract), SUMMARY (brief overview), COMPARISON (diff two docs), BULK (up to 5 files). Supports .docx and .pdf input. Trigger for: contract review, risk analysis, compliance check, GDPR review, clause analysis, tracked changes, redline, 'anonymize', 'pii shield'. If user uploads contract/NDA/DSAR/HR doc — USE THIS SKILL. If user says 'skip pii' or 'don't anonymize' — skip anonymization and work directly."
---

# PII Shield — Universal Legal Document Processor

Anonymize → Work → Deanonymize → Deliver. Claude NEVER sees raw PII at any stage.

## CRITICAL: PII never flows through Claude

**File handling**: The user must connect a folder (not attach the file directly to the message). When a file is attached to a Cowork message, its content is rendered and sent to the API as part of the prompt — Claude sees the raw data before PII Shield can process it. When a folder is connected, Claude only sees the file path and calls `anonymize_file(path)` — the MCP server on the host reads and anonymizes the file locally. PII never enters Claude's context.

**If the user attaches a file directly**: Warn them politely: "For full PII protection, please connect the folder containing your document instead of attaching it directly. When a file is attached to a message, its content is included in the API request before PII Shield can anonymize it. I can still process it, but the privacy guarantee is stronger when you connect the folder."

- `anonymize_file` reads the file on the host, anonymizes locally, writes result to disk, returns only `output_path` + `session_id` to Claude. **After HITL is approved, and only then, Claude reads the anonymized text from the output file — never before.**
- `deanonymize_*` tools write results to LOCAL FILES and return only the file path
- `get_mapping` returns only placeholder keys and types — no real values
- **ABSOLUTE BAN #1 — HITL GATE**: Claude must NEVER read, open, `cat`, `head`, `pandoc`, use the `Read` tool, `python`, `bash`, or in any way access the anonymized output file (`output_path`, `docx_output_path`) BEFORE `get_review_status(session_id)` returns `status: "approved"`. Not to "preview entity quality", not to "verify placeholders", not to "check formatting", not to "plan the memo" — NEVER. The anonymized file is considered **SEALED** between `anonymize_file` and HITL approval. The HITL reviewer is the human, not Claude. Claude's only permitted actions in that window are: (a) relay the `start_review` `user_message` to the user, (b) poll `get_review_status` every ~15 s, (c) when the user confirms done, call `apply_review_decisions`. Any `Read(output_path)` / `Bash(cat … | head …)` / `pandoc output_path` in that window is a PII-leak violation of the same severity as reading a deanonymized file — the user explicitly flagged this behaviour as «грубейшее нарушение».
- **ABSOLUTE BAN #2 — DEANONYMIZED FILES**: Claude must NEVER read, open, cat, head, pandoc, or in any way access the content of deanonymized/restored files. Not to "verify", not to "check formatting", not to "validate" — NEVER. These files contain real PII. Just give the user the file path and STOP. Any "verification" of deanonymized output is a PII leak.
- Claude must NEVER read the source file (via Read tool, pandoc, python, bash, etc.) BEFORE or INSTEAD OF anonymization — always use `anonymize_file(path)` first
- If an anonymize tool times out or fails with a NON-"tool not found" error — retry once. If it still fails, tell the user PII Shield is unavailable and ask whether to proceed without anonymization or abort. NEVER fall back to reading the raw file.
- **NEVER** use `anonymize_text` or `scan_text` — these take raw text as input which means PII passes through the API. The ONLY exception is if the user explicitly pastes text into the chat (PII is already in the conversation).

## Startup

PII Shield v2.0.0 starts instantly (pure Node.js, no Python dependency). On first run, the NER model (~665 MB fp32 ONNX GLiNER) and its runtime deps (`onnxruntime-node`, `@xenova/transformers`, `gliner`) download into `${CLAUDE_PLUGIN_DATA}/models` and `${CLAUDE_PLUGIN_DATA}/deps`. This takes 2–5 minutes once per plugin install and is cached for the full life of the plugin (survives Claude Code restarts, only wiped by `/plugin remove`).

**`.docx` Python sidecar (Phase 5 Fix C)**: the very first `.docx` call additionally bootstraps a small Python sidecar — discovers `python3` (already present in Cowork VMs and on Linux/macOS), then runs `pip install --target ${CLAUDE_PLUGIN_DATA}/py_deps python-docx lxml adeu`. This adds ~10 seconds the first time; subsequent `.docx` calls reuse the cache. The sidecar gives more robust run-aware text replacement and native Word track-changes (`w:ins` / `w:del`) for REDLINE mode. **If `python3` is not available** (rare — only on local Windows installs without Python), PII Shield logs a one-time warning and silently falls back to its pure-Node.js docx pipeline. No user action required either way.

### ⛔ ABSOLUTE RULE — NO SUB-AGENT DELEGATION

**NEVER delegate PII Shield tool calls to a sub-agent.** Not to a general-purpose agent, not to a Task agent, not to an Explore agent — NEVER. Sub-agents do not stream text to the user; they return one final message only when they exit. If PII Shield is initializing, a sub-agent will poll silently for minutes while the user sees nothing. This is the single worst UX failure mode. All PII Shield tool calls (`list_entities`, `anonymize_file`, `start_review`, `apply_review_decisions`, etc.) MUST happen in the MAIN conversation.

If you cannot call a PII Shield tool because it shows "No such tool available" — the fix is ToolSearch (Step 0 below), NOT a sub-agent. Spawning a sub-agent to "work around" missing schemas is the exact failure mode this rule exists to prevent.

### Step 0 — Connect to PII Shield tools (MANDATORY, before ANY tool call)

PII Shield MCP tools may be **deferred** — they exist on the server but are not in your callable tool list until you fetch their schemas. Run the following discovery sequence ONCE at the start of every session. Do NOT skip this step; do NOT call any PII Shield tool before completing it.

**Attempt A — ToolSearch (preferred).** If `ToolSearch` is in your tool list:
```
ToolSearch(query: "+pii-shield", max_results: 15)
```
This returns the fully-qualified tool names for your environment. Use whichever prefix comes back.

**Attempt B — direct call (fallback when ToolSearch is unavailable).** In some Cowork sessions, ToolSearch itself is not available. In that case, try calling `list_entities` directly using both possible prefixes in order:
1. `mcp__plugin_pii-shield_pii-shield__list_entities` (Cowork plugin-namespaced form)
2. `mcp__pii-shield__list_entities` (local CLI / Desktop form)

Whichever call succeeds — that is your prefix for all subsequent PII Shield tool calls in this session. Remember it and use it consistently.

**Attempt C — HTTP sidecar (when server is running but tools aren't propagated).**

If both A and B fail, the MCP server may still be running — Cowork sometimes fails to propagate tool schemas even though the server process is alive. PII Shield v2.0.0 runs an HTTP endpoint alongside stdio on `127.0.0.1:6789`. Test it:

```bash
curl -s -X POST http://127.0.0.1:6789/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print(len(r.get('result',{}).get('tools',[])), 'tools available')"
```

If this prints `17 tools available` — the server IS running. Use this `pii_tool` helper for ALL tool calls for the rest of the session:

```bash
pii_tool() {
  local name="$1" args="$2"
  curl -s -X POST http://127.0.0.1:6789/mcp \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}" \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('result',{}).get('content',[{}])[0].get('text',''))"
}
```

Usage examples:
```bash
pii_tool "list_entities" "{}"
pii_tool "resolve_path" "{\"filename\":\"contract.docx\",\"marker\":\".pii_marker\"}"
pii_tool "anonymize_file" "{\"file_path\":\"/path/to/contract.docx\"}"
pii_tool "start_review" "{\"session_id\":\"abc123\"}"
pii_tool "get_review_status" "{\"session_id\":\"abc123\"}"
pii_tool "apply_review_decisions" "{\"session_id\":\"abc123\"}"
pii_tool "deanonymize_text" "{\"text\":\"<PERSON_1> signed...\",\"session_id\":\"abc123\",\"output_path\":\"/path/to/output.txt\"}"
```

When using the HTTP sidecar: all tool responses are plain JSON strings (not MCP-wrapped). Parse them with `python3 -c "import sys,json; ..."` as needed. All HITL rules, ABSOLUTE BANs, and the no-sub-agent rule still apply exactly the same way.

**If Attempt C also fails** (curl returns connection refused or empty), the MCP server truly did not start. Tell the user:

> "PII Shield MCP server is not active in this session. Please try: (1) start a new Cowork chat, or (2) disable and re-enable the PII Shield plugin in Settings → Extensions, then retry. This is a known Cowork session initialization issue — the plugin is installed but the server did not start."

Then STOP. Do NOT proceed without the tools. Do NOT spawn a sub-agent to work around this. Do NOT attempt to run the server binary manually via bash — MCP servers must be started by the Claude Code runtime, not by the user or by Claude.

After Step 0, all PII Shield tools are callable directly from the main conversation for the rest of this session (via MCP tools if A/B succeeded, or via the `pii_tool` bash helper if only C succeeded).

### Startup procedure

1. **Connect to PII Shield tools** — run Step 0 above if you haven't already in this session. You MUST have a working prefix before proceeding.
2. Identify the file(s) to process and determine the mode (MEMO, REDLINE, etc.)
3. Create the marker file for path resolution (see `references/path-resolution.md`)
4. Call `list_entities` (using the fully-qualified name from Step 0) to check status
   - If `"ner_ready": true` — proceed to `anonymize_file`
   - If `"ner_ready": false` — NER is still initializing. The response includes `phase` (`installing_deps` / `downloading_model` / `loading_model`), `progress_pct`, a human `message`, and a pre-formatted `user_message` field. **If the response ALSO contains a `first_run_notice` field (only present on the very first loading response per server process), print `first_run_notice` VERBATIM to the user as a plain chat message BEFORE anything else.** It explains where the ~700 MB NER cache will live (Cowork workspace mount, host `CLAUDE_PLUGIN_DATA`, or legacy `~/.pii_shield`) and why the next session in the same workspace folder will be instant — the user needs to see this once, up front. The companion `first_run_display_instruction` field spells out the same contract. Subsequent polls will NOT contain `first_run_notice`. **On every poll (including the first), print the `user_message` field VERBATIM to the user as a plain chat message BEFORE calling `list_entities` again.** This is the ONLY thing the user sees during the wait — do not paraphrase, do not summarize, do not skip it, do not batch it silently. Example: if `user_message` is `"PII Shield is still initializing — installing NER dependencies (8%). Next poll in 20s."`, print exactly that sentence to the user, then call `list_entities` again. **Wait and retry**: the server enforces a ~20 second throttle by holding the `list_entities` response for 20 s internally while `phase` is `installing_deps` / `downloading_model` / `loading_model`, so back-to-back calls cannot poll faster than that — don't try to work around it. First run may take 2–5 minutes (downloads ~665 MB model + installs onnxruntime-node/@xenova/transformers/gliner into `${CLAUDE_PLUGIN_DATA}/deps`). Between polls (inside the 20 s window) you MAY do useful prep work in the MAIN conversation only — read skill references, plan the analysis, create marker files. Do NOT delegate any of this to a sub-agent (see the ABSOLUTE RULE above). **Do NOT call `anonymize_file` until `ner_ready: true`** — without NER, only regex patterns work, missing PERSON/ORGANIZATION/LOCATION entities.
   - If `"error"` field present — show error and suggestion to user

### Long document handling (chunked processing)

For documents >15K characters, `anonymize_file` returns `"status": "chunked"`. **Chunked processing flow:**
1. `anonymize_file(path)` returns `session_id`, `total_chunks`, `processed_chunks: 1`
2. Loop: call `anonymize_next_chunk(session_id)` until `status` is `"complete"` — show "Anonymizing... [chunk X/Y]"
3. Call `get_full_anonymized_text(session_id)` to finalize — returns `output_path`, `session_id`, `output_dir`
4. Continue with the normal pipeline using the returned values

For short documents (<15K chars), `anonymize_file` processes everything in one call.

### File path resolution

MCP tools run on the HOST, not in the VM. Create a marker file next to the target, call `resolve_path(filename, marker)` to get the host path. For full details and fallback methods, read `references/path-resolution.md`.

## Available MCP tools

| Tool name (suffix) | Parameters | Returns to Claude |
|---|---|---|
| `anonymize_file` | file_path, language, prefix, **review_session_id** | output_path (.txt) + session_id + output_dir + docx_output_path (.docx, for .docx input only). For long docs: returns `status: "chunked"` with session_id and total_chunks. |
| `anonymize_next_chunk` | session_id | Progress: processed_chunks, total_chunks, progress_pct, entities_so_far |
| `get_full_anonymized_text` | session_id | output_path, session_id, output_dir, docx_output_path (same as anonymize_file) |
| `resolve_path` | filename, marker, vm_dir | host_path, host_dir (zero-config VM-to-host path resolution) |
| `deanonymize_text` | text, session_id, output_path | **File path only** (takes anonymized text, writes deanonymized file) |
| `deanonymize_docx` | file_path, session_id | **File path only** |
| `get_mapping` | session_id | Placeholder keys + types only |
| `list_entities` | — | Server status and config |
| `find_file` | filename | Full host path(s) — searches configured work_dir only (fallback) |
| `start_review` | session_id | URL of local review page |
| `get_review_status` | session_id | **status + has_changes only** (no PII or override details) |
| `apply_tracked_changes` | file_path, changes (JSON), author | Output .docx with Word-native w:del/w:ins revision marks |

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

**When review is active** (default), first explain what will happen, then call `start_review(session_id)` — the review page opens automatically in the user's browser.

Tell the user BEFORE calling `start_review`:

> "I've anonymized N entities in your document. I'm opening a review page in your browser — it runs entirely on your machine, no data is sent anywhere. You'll see color-coded highlights: click any to remove false positives, select text to add missed entities. Click **Approve** when done."

After `start_review` returns, ask via AskUserQuestion: **"I've opened the review page. Let me know when you're done."** with options: **"Done reviewing"** / **"Skip review"**.

**Read `references/hitl-review.md` for the full pipeline, polling logic, and important rules.** Key rule: if review produces changes, `anonymize_file(path, review_session_id=session_id)` returns ALL NEW values — you MUST discard old session_id, output_path, docx_output_path and use the new ones.

**Cowork path rule (very important):** when calling `start_review`, you MUST pass `host_workspace_dir` = the `host_dir` field from your earlier `resolve_path(marker)` call. Without it, the user_message will display a `/sessions/<id>/mnt/...` VM path that the user cannot use, AND the server cannot tell the user where to drop the decisions JSON. In Cowork, the host's Downloads folder is NOT visible from the VM — the workspace folder is the only path shared between the user's browser and the server, so the user must move/copy the downloaded JSON into it after Approve.

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

1. Warm-up: `list_entities()` → confirm tools loaded and `ner_ready: true`
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → remember `output_path`, `session_id`, `output_dir`. **DO NOT Read `output_path` yet. The file is SEALED until HITL approves.**
4. HITL Review (mandatory — see `references/hitl-review.md`):
   - Call `start_review(session_id, host_workspace_dir=<host_dir from resolve_path>)`, relay its `user_message` verbatim to the user.
   - Poll `get_review_status(session_id)` every ~15 s until `status == "approved"`.
   - If HITL produced changes, call `anonymize_file(path, review_session_id=session_id)` and REPLACE `output_path` / `session_id` with the NEW values. The old file is still SEALED — do not read it.
5. **Only now** Read `output_path` → pull anonymized text into context.
6. Analyze anonymized text → structured memo with `<ORG_1>` etc.
7. Create formatted .docx via docx-js (see `references/docx-formatting.md`)
8. `deanonymize_docx(formatted.docx, session_id)` → final.docx
9. Copy to mnt/outputs/, present link. **DO NOT read/verify deanonymized file.**

---

## MODE: REDLINE (Tracked Changes)

Apply tracked changes to make the contract more favorable. Output: .docx with Word-native revision marks. Read `references/redline-tracked-changes.md` before starting.

### Pipeline

1. Warm-up: `list_entities()` → confirm tools loaded and `ner_ready: true`
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → remember `output_path` (.txt), `docx_output_path` (.docx), `output_dir`, `session_id`. **DO NOT Read `output_path` or `docx_output_path` yet. Both files are SEALED until HITL approves.**
4. HITL Review (mandatory — see `references/hitl-review.md`):
   - Call `start_review(session_id, host_workspace_dir=<host_dir from resolve_path>)`, relay its `user_message` verbatim to the user.
   - Poll `get_review_status(session_id)` every ~15 s until `status == "approved"`.
   - If HITL produced changes, re-anonymize with `review_session_id=session_id` and REPLACE ALL values including the NEW `docx_output_path`. The old files remain SEALED.
5. **Only now** Read the new `output_path` → pull anonymized text into context.
6. Analyze: identify clauses to change, draft new wording (all in placeholders).
7. Apply tracked changes to the anonymized .docx at `docx_output_path` via OOXML (see `references/redline-tracked-changes.md`). Save in `output_dir`.
8. `deanonymize_docx(tracked_changes.docx, session_id)` → final.docx
9. Copy to mnt/outputs/, present link. **DO NOT read/verify deanonymized file.**

---

## MODE: SUMMARY (Brief Overview)

Concise document summary. Read `references/docx-formatting.md` before creating .docx.

### Pipeline

1. Warm-up: `list_entities()` → confirm tools loaded and `ner_ready: true`
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → remember `output_path`, `session_id`, `output_dir`. **DO NOT Read `output_path` yet. The file is SEALED until HITL approves.**
4. HITL Review (mandatory — see `references/hitl-review.md`):
   - Call `start_review(session_id, host_workspace_dir=<host_dir from resolve_path>)`, relay its `user_message` verbatim to the user.
   - Poll `get_review_status(session_id)` every ~15 s until `status == "approved"`.
   - If HITL produced changes, re-anonymize with `review_session_id=session_id` and REPLACE ALL values. The old file remains SEALED.
5. **Only now** Read `output_path` → pull anonymized text into context.
6. Write summary (1–2 pages max) with placeholders.
7. Create formatted .docx via docx-js.
8. `deanonymize_docx(summary.docx, session_id)` → final.docx
9. Copy to mnt/outputs/, present link. **DO NOT read/verify deanonymized file.**

### Summary structure

1. **Header**: Document type + parties (`Purchase Order between <ORG_1> and <ORG_2>`)
2. **Key terms table**: Party A, Party B, Subject, Term, Total value, Payment terms, Governing law
3. **Notable provisions**: 3–5 bullet points on unusual or important clauses
4. **Risk flags**: Brief list of potential issues (if any)

---

## MODE: COMPARISON (Diff Two Documents)

Read `references/comparison-mode.md` + `references/docx-formatting.md` before starting. Full pipeline is in the reference file. **HITL gate (ABSOLUTE BAN #1) applies to every `anonymize_file` call in this mode — never Read any `output_path` before its `session_id` is approved.**

---

## MODE: BULK (Multiple Files)

Read `references/bulk-mode.md` + reference file(s) for the wrapped mode before starting. Full pipeline is in the reference file. **HITL gate (ABSOLUTE BAN #1) applies to every `anonymize_file` call in this mode.** Each file gets its own `session_id`, its own review HTML, and its own `review_<session_id>_decisions.json` in Downloads. Wait for **every** session to reach `approved` before reading any output file.

---

## MODE: ANONYMIZE-ONLY

Just anonymize and return the anonymized file. No analysis. No reference files needed.

### Pipeline

1. Warm-up: `list_entities()` → confirm tools loaded and `ner_ready: true`
2. Resolve host path: create marker → `resolve_path(filename, marker)` → host_path
3. `anonymize_file(file_path)` → remember `output_path`, `session_id`, `output_dir`. **DO NOT Read `output_path`.** In ANONYMIZE-ONLY mode, Claude never reads the file at all — not before HITL, not after. The user is the only one who sees the anonymized content.
4. HITL Review (mandatory — see `references/hitl-review.md`):
   - Call `start_review(session_id, host_workspace_dir=<host_dir from resolve_path>)`, relay its `user_message` verbatim to the user.
   - Poll `get_review_status(session_id)` every ~15 s until `status == "approved"`.
   - If HITL produced changes, re-anonymize with `review_session_id=session_id` and REPLACE ALL values.
5. Copy the (approved) anonymized file to `mnt/outputs/`.
6. Present the link to the user and tell them the `session_id` in case they need deanonymization later.
