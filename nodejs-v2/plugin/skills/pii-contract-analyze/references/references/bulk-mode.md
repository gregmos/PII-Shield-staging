# MODE: BULK (Multiple Files)

Process up to 5 files. Wraps any of the modes above.

## Pipeline

```
1. Warm-up: list_entities() → confirm ner_ready: true
2. For each file i (1..N):
   anonymize_file(file_path: "<file_i path or filename>", prefix="D{i}")
     → session_id_i, output_path_i, output_rel_path_i
   DO NOT read any output file yet. (HITL absolute ban)
   If "file not found" — fall back to resolve_path + marker per SKILL.md.
3. HITL Review (ALL documents in a single panel):
   start_review(session_ids=[sid_1, sid_2, ..., sid_N])
   → Opens the in-chat review panel with one tab per document.
   Do NOT call start_review separately for each document.
4. Tell the user verbatim: "Review panel opened with N tabs (one per document).
   Click Approve on each tab when done, then send me any short message (e.g. 'done',
   'continue') to proceed." STOP and wait for user's next message.
5. On user's next message, call anonymize_file(file_path_i, review_session_id=sid_i)
   for EVERY document (parallel or sequential). Each returns ONE of:
   - "waiting_for_approval"  → that document still unapproved
   - "approved_no_changes"   → use originals (output_path/rel_path in response)
   - "success"               → REPLACE held values for this doc with new ones
   If ANY response is waiting_for_approval, ask user to click Approve on the
   unapproved tab(s) and send any message; wait next turn and retry just the
   unapproved docs.
6. After ALL docs settled (approved_no_changes or success), read each anonymized
   text via "<input_dir_i>/<output_rel_path_i>".
7. Apply the requested mode (MEMO/SUMMARY/COMPARISON) across all anonymized texts.
8. Create output .docx with all placeholder sets.
9. Deanonymize: use session_id_1 (primary document) — other documents' placeholders
   go through deanonymize_text for text snippets, or stay as placeholders with a
   legend table mapping D1/D2/D3 to file names.
10. Copy to the agreed output folder, present link to user.
```

**Important**: Each file gets its own `prefix` and `session_id`. The prefix prevents placeholder collisions (`<D1_ORG_1>` vs `<D2_ORG_1>`).

**Important**: Never poll, never inspect transcript, never AskUserQuestion. Server is authoritative — `anonymize_file(review_session_id=sid)` on next user message tells you everything via its 3-status response.
