# Human-in-the-Loop Review (after anonymization)

HITL review is **mandatory** after every `anonymize_file` call (unless `PII_SKIP_REVIEW=true` in extension settings). It runs **100% on the user's machine** — PII never leaves their computer.

## The flow in one paragraph

`anonymize_file` writes a SEALED anonymized file to disk and returns `session_id` + `output_path`. Claude then calls `start_review(session_id, host_workspace_dir=<host_dir>)`, which returns a `review_url` (live HTTP URL on the sidecar at localhost:6789) + a `user_message` Claude must relay verbatim. **In Cowork**, Claude opens the review URL in the preview panel via `preview_start("pii-shield-review")` + `preview_eval(serverId, "window.location.href = '<review_url>'")`. The user sees the review page in the panel on the right, clicks highlights to remove false positives or selects text to add missed entities, then clicks **Approve**. The Approve button POSTs to the localhost sidecar, which saves the decision in memory — `get_review_status` picks it up instantly. **On desktop**, `start_review` auto-opens the review URL in the default browser; the Approve button writes a JSON file to Downloads, and `get_review_status` polls the filesystem. In both cases, when the status becomes `approved`, Claude calls `anonymize_file(path, review_session_id=session_id)` to re-anonymize with the overrides. The server applies decisions internally — **no PII ever passes through Claude**.

## Review pipeline

1. `anonymize_file` returned `session_id`, `output_path` (maybe `docx_output_path`). **Do not Read any of these paths.** The file is SEALED.

2. Call `start_review(session_id, host_workspace_dir=<host_dir from your earlier resolve_path(marker)>)`.
   - Pass `host_workspace_dir` — it's the `host_dir` field from `resolve_path(filename, marker)`. Used for display and the static HTML fallback.
   - The response contains:
     - `review_url` — live HTTP URL on the sidecar (e.g. `http://127.0.0.1:6789/review/<session_id>`). **This is the primary review path.**
     - `review_urls` — array of `{session_id, review_url}` (for BULK mode, one per session).
     - `review_file` / `review_file_display` — static HTML fallback (still generated).
     - `workspace_dir` / `workspace_dir_display` — VM-form / host-form workspace folder.
     - `cowork: true|false` — whether inside a Cowork VM.
     - `review_files` — array (BULK mode returns one entry per session).
     - `user_message` — relay to the user **verbatim**.

2b. **Cowork — user opens link in browser:**
   - `start_review` response includes `review_url` in `user_message` — relay it verbatim.
   - Cowork forwards VM ports to host — the user clicks the link and it opens in their browser.
   - The Approve button POSTs to `http://127.0.0.1:6789/api/approve/<session_id>` — same-origin request, works perfectly.
   - The sidecar saves the decision in memory. `get_review_status` picks it up **instantly**.
   - **Do NOT use `preview_start`** — it is not available when MCP tools don't propagate.

2c. **Desktop — auto-opens in browser:**
   - `start_review` automatically opens `review_url` in the default browser.
   - Approve POSTs to the sidecar for instant pickup. As fallback, writes `review_<session_id>_decisions.json` to Downloads.

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
- The primary review path uses the live HTTP sidecar (localhost:6789). A standalone HTML file is also generated as fallback. Both run 100% locally — no data is sent anywhere.
- After HITL, if changes were made, you MUST use the NEW `session_id` / `output_path` / `docx_output_path` for every downstream step. The old values are dead.
- Keep the original source `file_path` around — you need it for the re-anonymize call.

## What if approval never arrives?

**In Cowork (preview panel):** Approve POSTs to the in-process sidecar, so pickup is instant. If after ~1 minute of polling the status is still `pending`:
1. Ask the user to confirm they clicked Approve in the preview panel.
2. Use `preview_screenshot` to verify the review page is loaded correctly.
3. If the preview panel shows an error, try `preview_eval(serverId, "window.location.reload()")`.
4. As a last resort, provide the `review_url` and ask the user to open it manually in a browser.

**On desktop:** If after ~3 minutes of polling the status is still `pending`:
1. Ask the user to confirm they clicked Approve and saw the green success banner.
2. Ask them to check their Downloads folder for `review_<session_id>_decisions.json`.
3. If the file exists but is in an unusual location, ask them to move it to the workspace folder.
4. As a last resort, the user can re-open the review URL and click Approve again — it's idempotent.

Never, under any circumstances, proceed past HITL by reading the sealed file. If HITL truly can't complete, abort and tell the user.
