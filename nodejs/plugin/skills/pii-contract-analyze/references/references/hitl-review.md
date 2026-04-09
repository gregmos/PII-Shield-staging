# Human-in-the-Loop Review (after anonymization)

HITL review is **mandatory** after every `anonymize_file` call (unless `PII_SKIP_REVIEW=true` in extension settings). It runs **100% on the user's machine** — PII never leaves their computer.

## The flow in one paragraph

`anonymize_file` writes a SEALED anonymized file to disk and returns `session_id` + `output_path`. Claude then calls `start_review(session_id, host_workspace_dir=<host_dir>)`, which writes a standalone self-contained HTML review page to the workspace root and returns its host-form path + a `user_message` Claude must relay verbatim. The user opens that HTML in their own browser (Chrome/Safari/Firefox), clicks highlights to remove false positives or selects text to add missed entities, then clicks **Approve**. On Approve, the page auto-downloads a plain JSON file `review_<session_id>_decisions.json` to the user's Downloads folder. Claude polls `get_review_status(session_id)` every ~15 s; the server searches the **workspace folder first** (the only path shared between VM and host in Cowork), then `output_dir`, `~/Downloads`, `~`, `cwd`, `cwd/Downloads`. **In Cowork the user MUST move the downloaded JSON from the host's Downloads into the workspace folder** — the VM cannot see the host's Downloads directly. When the JSON is found, `get_review_status` returns `status: "approved"`, and Claude calls `anonymize_file(path, review_session_id=session_id)` to re-anonymize with the overrides. The server reads the JSON and applies it internally — **no PII ever passes through Claude**.

## Review pipeline

1. `anonymize_file` returned `session_id`, `output_path` (maybe `docx_output_path`). **Do not Read any of these paths.** The file is SEALED.

2. Call `start_review(session_id, host_workspace_dir=<host_dir from your earlier resolve_path(marker)>)`.
   - **You MUST pass `host_workspace_dir`.** It's the `host_dir` field returned by `resolve_path(filename, marker)` for the original source file. Without it, the user_message will display a useless `/sessions/<id>/mnt/...` VM path and the user won't be able to find the review HTML.
   - The response contains:
     - `review_file` — VM-form absolute path to the review HTML (the actual disk location used by the server).
     - `review_file_display` — host-form path you should mention to the user (already used inside `user_message`).
     - `workspace_dir` / `workspace_dir_display` — VM-form / host-form workspace folder. In Cowork this is the **drop zone**: the user must move/copy the downloaded JSON here.
     - `cowork: true|false` — whether the server is running inside a Cowork VM.
     - `review_files` — array (BULK mode returns one entry per session).
     - `user_message` — the exact text you must tell the user. Relay it verbatim, do not paraphrase. It already includes the host-form path, the instructions, the "I will NOT read your document until you approve" promise, and (in Cowork) the move-to-workspace instruction.

3. Poll `get_review_status(session_id)` every ~15 seconds. While waiting, you MAY:
   - Read skill reference files (memo style, docx formatting, etc.)
   - Create marker files for other documents
   - Plan the analysis structure in your head

   While waiting, you MUST NOT:
   - `Read` the `output_path` or `docx_output_path` — both are SEALED
   - `Bash(cat/head/pandoc/python …)` against either path
   - Call `get_mapping`, `anonymize_text`, or any tool that touches the anonymized content

4. `get_review_status(session_id)` responses:
   - `status: "pending"` — user hasn't approved yet. Wait 15 s and poll again. After ~4–5 polls (≈ 1 min) you MAY ask the user "still reviewing?" but do not block on AskUserQuestion — the server finds the decisions JSON on its own as soon as the user clicks Approve.
   - `status: "approved"`, `has_changes: false` — user approved without changes. Use the ORIGINAL `output_path` unchanged. Now you may Read it.
   - `status: "approved"`, `has_changes: true` — user made changes. Call `anonymize_file(original_file_path, review_session_id=<old_session_id>)`. This returns a **brand new** `session_id`, `output_path`, `output_dir`, and (for .docx) `docx_output_path`. **REPLACE every value you were holding.** The old files are stale — do not touch them. Now you may Read the NEW `output_path`.
   - `status: "waiting_for_user"` (rare) — treat same as `pending`, poll again.
   - `status: "error"` — show the error, ask whether to retry or skip.

5. If the user explicitly tells you to skip review (e.g. "just proceed"), you MAY call `apply_review_decisions(session_id, skip: true)` (or simply proceed with the original `output_path`). But HITL-skip is the user's call, never Claude's.

## Absolute rules

- **NEVER** Read, `cat`, `head`, `pandoc`, or otherwise access `output_path` / `docx_output_path` before `get_review_status` returns `status: "approved"`. This is ABSOLUTE BAN #1 in SKILL.md. Violations are PII leaks of the same severity as reading a deanonymized file.
- **NEVER** read, log, or forward the contents of the decisions JSON. You do not need to; the server applies it.
- **NEVER** pass `entity_overrides` as an inline parameter — always use `review_session_id` so the server handles overrides internally.
- **NEVER** try to find missed PII yourself by reading the source file — that defeats anonymization.
- The review HTML is a standalone file. It does NOT phone home, does NOT open a localhost server, does NOT require an internet connection. Everything is inlined.
- After HITL, if changes were made, you MUST use the NEW `session_id` / `output_path` / `docx_output_path` for every downstream step. The old values are dead.
- Keep the original source `file_path` around — you need it for the re-anonymize call.

## What if the decisions JSON never shows up?

If after ~3 minutes of polling the status is still `pending`:
1. Ask the user to confirm they clicked Approve and saw the green success banner.
2. Ask them to check their Downloads folder for `review_<session_id>_decisions.json`.
3. If the file exists but is in an unusual location, ask them to move it to the workspace folder.
4. As a last resort, the user can re-open the HTML and click Approve again — it's idempotent.

Never, under any circumstances, proceed past HITL by reading the sealed file. If HITL truly can't complete, abort and tell the user.
