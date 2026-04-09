# Human-in-the-Loop Review (after anonymization)

HITL review is **mandatory** after every `anonymize_file` call (unless `PII_SKIP_REVIEW=true` in extension settings). The review page runs **locally on the user's machine** — PII never leaves their computer.

## Review pipeline

1. After `anonymize_file` returns a `session_id`, tell the user what will happen:

   > "I've anonymized N entities in your document. I'm opening a review page in your browser — it runs entirely on your machine, no data leaves your computer. You'll see color-coded highlights: persons (blue), organizations (purple), locations (green), contacts (orange). Click any highlight to remove a false positive, or select text to add a missed entity. When you're satisfied, click **Approve**."

2. Call `start_review(session_id)` — this starts the local review server AND opens the page in the default browser automatically. The response includes `browser_opened: true/false`. If `false`, present the URL manually.

3. Ask via AskUserQuestion: **"I've opened the review page. Let me know when you're done."** with options: **"Done reviewing"** / **"Skip review"**

4. If user chose **"Done reviewing"**:
   - Wait 15 seconds, then call `get_review_status(session_id)`
   - If `"status": "pending"` — ask again: "Still reviewing? [Done / Need more time]"
   - If `"status": "approved"` — check `has_changes`:
     - If `true`: call `anonymize_file(original_file_path, review_session_id=session_id)` — the server fetches the user's overrides internally and re-anonymizes. **No PII passes through Claude** — neither entity text nor override details. **CRITICAL**: This returns a NEW `session_id`, new `output_path`, and (for .docx) new `docx_output_path`. You MUST use ALL new values for all subsequent steps — discard the old session_id, output_path, and docx_output_path. Re-read the anonymized text from the NEW output_path. For REDLINE mode, apply tracked changes to the NEW docx_output_path (not the old one).
     - If `false`: proceed with the original anonymized text
4. If user chose **"Skip review"** — proceed immediately with the original anonymized text

## Important rules

- **NEVER** read, log, or forward the output of `get_review_status` override details — it may contain PII. You only need `status` and `has_changes` from it.
- **NEVER** pass `entity_overrides` as a string to any tool — use `review_session_id` so the server handles overrides internally.
- **NEVER** try to find missed PII yourself — this would require reading the original text, which defeats the purpose of anonymization.
- The review page runs on `localhost` — PII never leaves the user's machine.
- The `start_review` tool does NOT open the browser — it only starts the server and returns the URL. Present the URL to the user in AskUserQuestion so they can open it themselves.
- If `start_review` fails (port busy), tell the user and proceed without review.
- Keep the original **file path** — you'll need it for `anonymize_file(file_path, review_session_id=...)`. Do NOT keep raw text or override details.
