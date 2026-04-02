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

## IMPORTANT: Tool invocation — deferred tools

PII Shield tools load lazily ("deferred") and may NOT appear in Claude's active tool list immediately. **This does NOT mean they are unavailable.** They typically become available within 10–30 seconds. On first install, the server auto-installs packages and downloads the GLiNER NER model (~1 GB total), which can take 5–10 minutes. On subsequent starts (or if user pre-installed via setup script), the server loads models into memory (~1-2 minutes).

**CRITICAL**: Cowork refreshes its deferred tool list only when a new user message arrives. Long sleep-probe loops within a single Claude turn will NOT make tools appear. You MUST yield control to the user when tools are not yet available, so Cowork can refresh.

### Warm-up sequence (MANDATORY before any anonymization call)

**Phase A — Quick probes (~30s, handles the case when tools load fast):**

1. **Probe 1**: Call `mcp__PII_Shield__list_entities`.
   - If `"status": "ready"` → **proceed to anonymization**.
   - If `"status": "loading"` → go to **Phase C** (wait for install).
   - If fails ("No such tool") → do useful prep work (create TodoList, detect mode from user's request).
2. `sleep 10` → **Probe 2**: Call `mcp__PII_Shield__list_entities`.
   - If success → proceed / handle loading as above.
   - If fails → do more prep work (check uploaded file metadata, plan analysis structure).
3. `sleep 10` → **Probe 3**: Call `mcp__PII_Shield__list_entities`.
   - If success → proceed / handle loading as above.
   - If fails → go to **Phase B**.

**Phase B — Ask user for a message to activate tools:**

After 3 quick probes failed, Cowork hasn't loaded the tool definitions yet. Cowork refreshes its tool list ONLY when a new user message arrives. We must yield control.

4. Tell user: **"PII Shield tools are loading. Please send me any message (e.g., 'go') so I can connect to PII Shield and start the analysis."**
   **STOP. Do NOT sleep or retry. Wait for user's next message.**

**Phase C — After user sends a message (or after "loading" detected in Phase A):**

5. Call `mcp__PII_Shield__list_entities`.
   - If `"status": "ready"` → **proceed to anonymization**.
   - If `"status": "loading"` → server is running but first-time install is in progress. Go to **Phase D**.
   - If fails ("No such tool") → tools still not visible. `sleep 30` → probe again. If still fails → `sleep 30` → probe. If still fails → tell user: **"PII Shield is still connecting. Please send one more message."** → STOP. Go to Phase E on next message.

**Phase D — Wait for server to become ready (when server reports "loading"):**

The server is loading. Check the `"phase"` field to determine what's happening:
- `"phase": "packages"` = installing pip packages (first install, ~5-10 min)
- `"phase": "models"` = downloading/loading AI models (~1-3 min)
- `"phase": "engine"` = initializing PII engine (~30-60s)

6. Tell user based on phase:
   - If `packages` phase: **"PII Shield is installing dependencies for the first time. This is a one-time setup (~5-10 minutes). I'll keep you updated."**
   - If `models` or `engine` phase: **"PII Shield is loading AI models (~1-2 minutes). Please wait."**
7. Enter a wait loop (max 15 iterations):
   - `sleep 30` → Probe `list_entities`.
   - If `"status": "ready"` → **proceed to anonymization**.
   - If `"status": "loading"` → show the server's `"message"` field to the user. Continue loop.
   - If fails → show a generic progress message. Continue loop.
8. After 15 iterations: tell user **"PII Shield is taking longer than expected. Please send 'go' to retry."** → STOP. Wait for user message, then go to Phase C.

**Phase E — Second user message (if Phase C didn't work):**

9. Call `mcp__PII_Shield__list_entities`.
   - If `"status": "ready"` → **proceed to anonymization**.
   - If `"status": "loading"` → go to **Phase D**.
   - If fails → `sleep 30` → probe → `sleep 30` → probe.
     If still fails → report error: **"PII Shield tools could not be loaded. Please check: (1) Python 3.10+ is in PATH, (2) PII Shield extension is enabled in Settings > Extensions, (3) try restarting the conversation. Or I can proceed without anonymization if you prefer."**

**Key rules**:
- Do NOT call `anonymize_file` until `list_entities` has succeeded with `"status": "ready"`.
- "No such tool available" = Cowork hasn't loaded the tools yet. Yield control to the user so Cowork can refresh.
- `"status": "loading"` = server is running, loading in progress. Wait in Phase D.
- Non-"tool not found" errors (timeouts, server errors) = retry the specific tool once, then report.
- If user says "try again" / "check again" / "ready" / "go" — call `list_entities` immediately.
- NEVER read the source file directly. If tools are unavailable, WAIT — do not bypass anonymization.
- **Do NOT try to read files on the host machine** (like `~/.pii_shield/status.json`) — Cowork runs in a sandbox and cannot access the host filesystem outside of mounted paths.
- While waiting for PII Shield, do useful prep work in parallel: plan analysis structure, read skill instructions, detect mode from user's request. Do NOT extract text from files — this leaks PII into Claude's context.

All PII Shield tools are registered as MCP tools with prefix `mcp__PII_Shield__`.

## Available MCP tools

| MCP tool name | Parameters | Returns to Claude |
|---|---|---|
| `mcp__PII_Shield__anonymize_file` | file_path, language, prefix, **review_session_id** | output_path (.txt) + session_id + output_dir + docx_output_path (.docx, for .docx input only). All output files are in `output_dir` (a `pii_shield_<session_id>/` subfolder next to the source file). (**text NOT in response — read from output_path**) |
| `mcp__PII_Shield__deanonymize_text` | text, session_id, output_path | **File path only** (takes anonymized text, writes deanonymized file) |
| `mcp__PII_Shield__deanonymize_docx` | file_path, session_id | **File path only** |
| `mcp__PII_Shield__get_mapping` | session_id | Placeholder keys + types only |
| `mcp__PII_Shield__list_entities` | — | Server status and config |
| `mcp__PII_Shield__find_file` | filename | Full host path(s) — searches configured work_dir only |
| `mcp__PII_Shield__start_review` | session_id | URL of local review page |
| `mcp__PII_Shield__get_review_status` | session_id | **status + has_changes only** (no PII or override details) |

**DO NOT USE these tools** (they exist on the server but must not be called for file workflows):
- `anonymize_text` — sends raw text through the API. Only acceptable if user pasted text into chat.
- `scan_text` — sends raw text through the API.
- `anonymize_docx` — use `anonymize_file` instead (handles .docx automatically).

**`prefix` parameter** (new in v5.0): Use for multi-file workflows to avoid placeholder collisions. Example: `prefix="D1"` → `<D1_ORG_1>`, `prefix="D2"` → `<D2_ORG_1>`. Each file gets its own prefix and session_id.

**`review_session_id` parameter** (new in v6.0): Pass the `session_id` from a previous `anonymize_file` call after HITL review. The server fetches the user's overrides internally and re-anonymizes. PII never passes through Claude — no entity text, no override JSON.

**Preferred approach**: Always use `anonymize_file(file_path)` — only the file path (a short string) passes through the API. The MCP server on the host reads and anonymizes the file locally. Use `find_file(filename)` to resolve the host path from a filename visible in the sandbox.

## Skip mode

If user says "skip pii shield", "don't anonymize", "work directly" — skip anonymization, work with the file directly.

---

## Human-in-the-Loop Review (after anonymization)

After every `anonymize_file` call, offer the user a review step. The review page runs **locally on the user's machine** — PII never leaves their computer.

### Review pipeline

1. After `anonymize_file` returns a `session_id`, call `start_review(session_id)` — this starts the local review server and returns the review URL (does NOT open the browser)
2. Ask the user using AskUserQuestion, **including the review URL in the question text**:
   - **"I want to review — open the link"** — user will open the URL in their browser
   - **"Looks good — proceed with analysis"** — user trusts the anonymization, skip review
   - **"Skip review — just proceed"** — user wants to skip entirely

   Example question: "I anonymized N entities. You can review them here: http://localhost:8766/review/abc123 — click entities to remove false positives, select text to add missed ones."
3. If user chose **"I'm reviewing now"**:
   - Wait 15 seconds, then call `get_review_status(session_id)`
   - If `"status": "pending"` — ask again: "Still reviewing? [Done / Need more time]"
   - If `"status": "approved"` — check `has_changes`:
     - If `true`: call `anonymize_file(original_file_path, review_session_id=session_id)` — the server fetches the user's overrides internally and re-anonymizes. **No PII passes through Claude** — neither entity text nor override details. **CRITICAL**: This returns a NEW `session_id`, new `output_path`, and (for .docx) new `docx_output_path`. You MUST use ALL new values for all subsequent steps — discard the old session_id, output_path, and docx_output_path. Re-read the anonymized text from the NEW output_path. For REDLINE mode, apply tracked changes to the NEW docx_output_path (not the old one).
     - If `false`: proceed with the original anonymized text
4. If user chose **"Looks good"** or **"Skip review"** — proceed immediately with the original anonymized text

### What the review page lets users do

- **See** the full document with color-coded entity highlights (persons in blue, organizations in purple, locations in green, contacts in orange)
- **Remove** false positives by clicking on highlighted entities
- **Add** missed entities by selecting text and choosing the entity type
- **Approve** when satisfied — sends overrides back to PII Shield server (localhost only)

### Important rules

- **NEVER** read, log, or forward the output of `get_review_status` override details — it may contain PII. You only need `status` and `has_changes` from it.
- **NEVER** pass `entity_overrides` as a string to any tool — use `review_session_id` so the server handles overrides internally.
- **NEVER** try to find missed PII yourself — this would require reading the original text, which defeats the purpose of anonymization.
- The review page runs on `localhost` — PII never leaves the user's machine.
- The `start_review` tool does NOT open the browser — it only starts the server and returns the URL. Present the URL to the user in AskUserQuestion so they can open it themselves.
- If `start_review` fails (port busy), tell the user and proceed without review.
- Keep the original **file path** — you'll need it for `anonymize_file(file_path, review_session_id=...)`. Do NOT keep raw text or override details.

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

Full legal memorandum with risk assessment. The default mode.

### Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. find_file(filename) → host path (or ask user if not found)
3. anonymize_file(file_path) → output_path, session_id, output_dir
   All output files are in output_dir (pii_shield_<session_id>/ subfolder).
   Read the anonymized text from output_path (the file on disk)
   (PII never leaves the host — only the path goes through the API)
4. HITL Review: start_review(session_id) → offer review to user (see "Human-in-the-Loop Review" section)
   If user made changes: anonymize_file(file_path, review_session_id=session_id) → new output_path, NEW session_id
   Re-read anonymized text from the new output_path. Use the NEW session_id for all subsequent steps.
5. Analyze anonymized text → structured memo with <ORG_1> etc.
6. Create formatted .docx via docx-js (read the `docx` SKILL.md first!)
7. deanonymize_docx(formatted.docx, session_id) → final.docx
8. Copy to mnt/outputs/, present link to user
   **DO NOT read, verify, or pandoc the deanonymized file — it contains real PII. Just give the path.**
```

### Writing Style — see section below

---

## MODE: REDLINE (Tracked Changes)

Apply tracked changes to make the contract more favorable for the specified party. Output is a .docx with Word-native revision marks (accept/reject in Word).

### Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. find_file(filename) → host path (or ask user if not found)
3. anonymize_file(file_path) → output_path (.txt), docx_output_path (.docx), output_dir, session_id
   All output files are in output_dir (a pii_shield_<session_id>/ subfolder next to the source file).
   Read the anonymized text from output_path for analysis.
   Keep docx_output_path — this is the anonymized .docx with original formatting (same placeholders as .txt).
4. HITL Review: start_review(session_id) → offer review to user
   If user made changes: anonymize_file(file_path, review_session_id=session_id) → new output_path, new docx_output_path, NEW output_dir, NEW session_id
   ⚠️ CRITICAL: DISCARD ALL old values. Re-read from NEW output_path. Use NEW session_id for deanonymize.
   Use NEW docx_output_path for Step 6 (tracked changes). The old docx does NOT contain the user's corrections.
5. Analyze: identify clauses to change, draft new wording (all in placeholders)
6. Apply tracked changes to the anonymized .docx (docx_output_path) via OOXML (python-docx + lxml)
   Save the result into the same output_dir.
7. deanonymize_docx(tracked_changes.docx, session_id) → final.docx (saved in output_dir)
8. Copy to mnt/outputs/, present link to user
   **DO NOT read, verify, or pandoc the deanonymized file — it contains real PII. Just give the path.**
```

### Step 6: OOXML Tracked Changes

Tracked changes in .docx are XML elements `w:ins` (insertion) and `w:del` (deletion) inside paragraph runs. They require `w:rPr` (run properties) to preserve formatting and `w:author`/`w:date` attributes.

**Critical implementation details:**
- Work on the **anonymized .docx** (`docx_output_path` from Step 3) — it preserves original formatting with PII replaced by placeholders
- Use `python-docx` to open the document + `lxml` to manipulate XML directly
- For each change: find the target paragraph → locate the text run → split at the change point → wrap deleted text in `w:del > w:r > w:delText` → insert new text in `w:ins > w:r > w:t`
- Preserve all `w:rPr` (font, size, bold, etc.) from the original run
- Set `w:author="Claude"` and `w:date` to current ISO datetime
- Save with `doc.save()`

**Example XML structure for a tracked change:**
```xml
<w:p>
  <w:r><w:rPr>...</w:rPr><w:t>unchanged text before </w:t></w:r>
  <w:del w:author="Claude" w:date="2026-03-27T12:00:00Z">
    <w:r><w:rPr>...</w:rPr><w:delText>old text</w:delText></w:r>
  </w:del>
  <w:ins w:author="Claude" w:date="2026-03-27T12:00:00Z">
    <w:r><w:rPr>...</w:rPr><w:t>new text</w:t></w:r>
  </w:ins>
  <w:r><w:rPr>...</w:rPr><w:t> unchanged text after</w:t></w:r>
</w:p>
```

**Important**: All changes use placeholder text (`<ORG_1>`, `<PERSON_2>`). After `deanonymize_docx`, the tracked changes will contain real names/entities.

---

## MODE: SUMMARY (Brief Overview)

Concise document summary — key parties, subject, term, financial terms, notable risks.

### Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. find_file(filename) → host path (or ask user if not found)
3. anonymize_file(file_path) → output_path, session_id, output_dir
   All output files are in output_dir (pii_shield_<session_id>/ subfolder).
   Read the anonymized text from output_path (the file on disk)
4. HITL Review: start_review(session_id) → offer review to user
   If user made changes: anonymize_file(file_path, review_session_id=session_id) → new output_path, NEW session_id
   Re-read from new output_path. Use NEW session_id for all subsequent steps.
5. Write summary (1–2 pages max) with placeholders
6. Create formatted .docx via docx-js (lighter formatting than MEMO)
7. deanonymize_docx(summary.docx, session_id) → final.docx
8. Copy to mnt/outputs/, present link to user
   **DO NOT read, verify, or pandoc the deanonymized file — it contains real PII. Just give the path.**
```

### Summary structure

1. **Header**: Document type + parties (`Purchase Order between <ORG_1> and <ORG_2>`)
2. **Key terms table**: Party A, Party B, Subject, Term, Total value, Payment terms, Governing law
3. **Notable provisions**: 3–5 bullet points on unusual or important clauses
4. **Risk flags**: Brief list of potential issues (if any)

---

## MODE: COMPARISON (Diff Two Documents)

Compare two versions of a document or two related documents. Show what changed.

### Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. find_file(filename_1), find_file(filename_2) → host paths (or ask user if not found)
3. anonymize_file(file_path_1, prefix="D1") → output_path_1, session_id_1, output_dir_1
   Read the anonymized text from output_path_1
4. anonymize_file(file_path_2, prefix="D2") → output_path_2, session_id_2, output_dir_2
   Read the anonymized text from output_path_2
5. HITL Review: start_review(session_id_1) → offer review for primary document (D1)
   If user made changes: anonymize_file(file_path_1, review_session_id=session_id_1) → new output_path_1, NEW session_id_1
   Re-read from new output_path_1. Use NEW session_id_1 for deanonymization.
6. Compare: structural diff (added/removed/changed clauses)
7. Create comparison report .docx via docx-js
   — Use session_id_1 for deanonymization (primary document)
   — D2 placeholders remain as-is OR use deanonymize_text for D2 references
8. deanonymize_docx(comparison.docx, session_id_1) → final.docx
9. Copy to mnt/outputs/, present link to user
   **DO NOT read, verify, or pandoc the deanonymized file — it contains real PII. Just give the path.**
```

**Note**: With prefix support, `<D1_ORG_1>` and `<D2_ORG_1>` won't collide even if both files mention the same entity. The comparison report can reference both sets of placeholders.

---

## MODE: BULK (Multiple Files)

Process up to 5 files. Wraps any of the modes above.

### Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. For each file i (1..N):
   anonymize_file(file_path_i, prefix=f"D{i}") → output_path_i, session_id_i
   Read the anonymized text from each output_path_i
3. HITL Review: start_review(session_id_1) → offer review for primary document (D1)
   If user made changes: anonymize_file(file_path_1, review_session_id=session_id_1) → new output_path_1, NEW session_id_1
   Re-read from new output_path_1. Use NEW session_id_1 for deanonymization.
4. Apply the requested mode (MEMO/SUMMARY/COMPARISON) across all anonymized texts
5. Create output .docx with all placeholder sets
6. Deanonymize: use session_id_1 (primary document)
   — Other documents' placeholders: deanonymize_text for text snippets,
     or leave as placeholders with a legend table mapping D1/D2/D3 to file names
7. Copy to mnt/outputs/, present link to user
```

**Important**: Each file gets its own `prefix` and `session_id`. The prefix prevents placeholder collisions (`<D1_ORG_1>` vs `<D2_ORG_1>`).

---

## MODE: ANONYMIZE-ONLY

Just anonymize and return the anonymized file. No analysis.

### Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. find_file(filename) → host path (or ask user if not found)
3. anonymize_file(file_path) → output_path, session_id, output_dir
   All output files are in output_dir (pii_shield_<session_id>/ subfolder).
   Read the anonymized text from output_path (the file on disk)
4. HITL Review: start_review(session_id) → offer review to user
   If user made changes: anonymize_file(file_path, review_session_id=session_id) → new output_path, NEW session_id
   Re-read from new output_path. Use NEW session_id if user needs deanonymization later.
5. Copy anonymized file to mnt/outputs/
6. Present link to user
7. Tell user the session_id in case they need deanonymization later
```

---

## File Input Handling

**CRITICAL PRIVACY RULE**: Always use `anonymize_file(file_path)` — NEVER extract text in the sandbox and pass it to `anonymize_text`. When you extract text in the sandbox, the raw text enters Claude's context window and passes through the API — defeating the purpose of anonymization. With `anonymize_file`, only the file PATH (a short string) goes through the API. The MCP server on the host reads and anonymizes the file locally. PII never leaves the user's machine.

### How to determine the host file path

PII Shield runs on the **HOST machine**, not in the Cowork sandbox. `anonymize_file` needs the Windows/Mac/Linux host path.

**Step 1 — VirtioFS mount info** (primary method, no user interaction):
Check the VirtioFS mount to derive the host path:
```bash
ls /mnt/.virtiofs-root/shared/
```
This shows the host user's home folder structure (e.g., `Downloads`, `Documents`, `Desktop`). The connected folder appears here.

Example: if the connected folder is at `/sessions/{name}/mnt/testtest/` and you see `/mnt/.virtiofs-root/shared/Downloads/testtest/`, the host path is:
```
C:\Users\{username}\Downloads\testtest\filename.pdf
```
To get the Windows username, check the mount structure or use the pattern from the path.

You can also try the Windows-style path directly — it often works in the sandbox:
```bash
file "C:\Users\User\Downloads\testtest\contract.pdf"
```

**Step 2 — Use `find_file(filename)`** (fallback): Searches the configured working directory (Settings > Extensions > PII Shield). If found, use the returned path.

**Step 3 — Ask the user** (last resort): If VirtioFS mount info is not available and `find_file` fails, ask the user for the full host path.

**Step 4 — Use `output_dir` for all subsequent files**:
- `anonymize_file` returns `output_dir` like `C:\Users\User\Downloads\testtest\pii_shield_a1b2c3d4e5f6\`
- This is the dedicated subfolder for this session — save all generated files here (tracked changes docx, etc.)
- The parent of `output_dir` is the host working directory — use it to find other source files in the same folder

**Supported formats**: `.pdf`, `.docx`, `.txt`, `.md`, `.csv`

**DO NOT** extract text in the sandbox using pdfplumber/python-docx and pass it to `anonymize_text`. This leaks PII through the API. The ONLY acceptable use of `anonymize_text` is when the user explicitly pastes text into the chat (in which case PII is already in the conversation).

---

## Path Mapping for deanonymize_docx

The `deanonymize_docx` tool runs on the HOST machine (Windows), not in the Linux VM. File paths must be Windows paths.

**Rule**: All anonymized files are already in `output_dir` (a Windows path like `C:\Users\User\Downloads\testtest\pii_shield_abc123\`). Use paths from the `anonymize_file` response directly — they are already valid Windows paths.

**For files you create** (e.g., tracked changes docx saved in the sandbox):
- Your sandbox file is at `/sessions/.../mnt/uploads/output_dir_name/tracked_changes.docx`
- Windows path: take `output_dir` from `anonymize_file` response and append the filename: `output_dir + "\tracked_changes.docx"`

If `deanonymize_docx` returns "Not found" — double-check the path. The file must exist at the Windows path on the host machine.

---

## Writing Style (for MEMO mode)

### Tone

Formal, precise, dispassionate. No hedging ("it seems", "it could potentially"). Direct statements: "Risk is high", "Deadline not established", "Liability is uncapped".

### Sentence structure

Short declarative sentences. Each sentence carries one idea.

### Opening

Bold title: `[Subject]: [Analytical framing]` — e.g., `<ORG_3>: Legal Risks of Purchase Order No. 3`. Below: 1-2 context paragraphs (who, what, why). No abstract.

### Section numbering

Strict hierarchical: `1.`, `2.`, `2.1.`, `2.2.` Section headings are bold and descriptive.

### Each risk/issue subsection:

1. Description of the issue
2. Direct quote from source (indented, italic, original language)
3. Analysis of implications
4. Risk assessment: "Risk: high/medium/low." + justification + recommendations

### Quotes

Original language, indented, italic, 11pt. Introduced with reference: "Section 7 of the Purchase Order states:" or "Section 13.2 provides:"

### Conclusion

Not generic. List of specific action items tied to specific risks: `[Risk label]: [specific action]`.

### Language

Adapts to user's language. Quotes stay in source language. English terms (SaaS, AI, GDPR, UGC) used as-is.

---

## Formatting Reference — Legal Memo (.docx)

**Read the `docx` SKILL.md first** for setup, validation, and critical rules for docx-js.

**CRITICAL: Every TextRun MUST have explicit `font: "Arial"` and `size`.** Do NOT rely on defaults.

### Setup

```javascript
const { Document, Packer, Paragraph, TextRun, AlignmentType,
        Table, TableRow, TableCell, WidthType, ShadingType } = require('docx');
const fs = require('fs');

const BODY_RUN = { font: "Arial", size: 24 };             // 12pt
const BOLD_RUN = { font: "Arial", size: 24, bold: true };  // 12pt bold
const QUOTE_RUN = { font: "Arial", size: 22, italics: true }; // 11pt italic
const STD_SPACING = { before: 0, after: 120, line: 240, lineRule: "auto" };
```

### Paragraph types

| Type | Bold? | Italic? | Size | First-line indent | Left indent | Spacing |
|------|-------|---------|------|-------------------|-------------|---------|
| Title | YES | no | 24 | 0 | 0 | STD_SPACING |
| Body | no | no | 24 | 630 | 0 | STD_SPACING |
| Section heading | YES | no | 24 | 0 | 0 | STD_SPACING |
| Blockquote | no | YES | 22 | 0 | 900 | STD_SPACING |
| Risk line | no | no | 24 | 630 | 0 | STD_SPACING |

**Blockquote**: `indent: { left: 900, firstLine: 0 }` — shifts ENTIRE paragraph right, not just first line.

### Document structure (MEMO)

1. Title (bold)
2. Context paragraphs (1–2)
3. Definitions section
4. Analysis sections (heading → body → blockquote → risk assessment)
5. Conclusion (action items)
6. Risk summary table (optional)

### Validation

```bash
python scripts/office/validate.py output.docx
```
