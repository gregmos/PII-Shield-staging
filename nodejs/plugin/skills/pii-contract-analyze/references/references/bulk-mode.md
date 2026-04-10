# MODE: BULK (Multiple Files)

Process up to 5 files. Wraps any of the modes above.

## Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. For each file i (1..N):
   anonymize_file(file_path_i, prefix="D{i}") → output_path_i, session_id_i
   DO NOT read output_path yet! (HITL absolute ban — no reading before review)
3. HITL Review (ALL documents at once):
   start_review(session_ids=[sid_1, sid_2, ..., sid_N]) → review_url (single bulk page)
   User reviews ALL documents in one tabbed page, approves each.
4. Poll each session: get_review_status(session_id_i) until ALL approved
5. For each sid with has_changes=true:
   anonymize_file(file_path_i, review_session_id=sid_i) → new output_path_i, NEW sid_i
6. NOW read all output_path files (only after all reviews are approved)
7. Apply the requested mode (MEMO/SUMMARY/COMPARISON) across all anonymized texts
8. Create output .docx with all placeholder sets
9. Deanonymize: use session_id_1 (primary document)
   — Other documents' placeholders: deanonymize_text for text snippets,
     or leave as placeholders with a legend table mapping D1/D2/D3 to file names
10. Copy to mnt/outputs/, present link to user
```

**Important**: Each file gets its own `prefix` and `session_id`. The prefix prevents placeholder collisions (`<D1_ORG_1>` vs `<D2_ORG_1>`).

**Review**: `start_review` accepts `session_ids` array and returns a single bulk review URL. The user sees all documents in one page with tabs. Do NOT call `start_review` separately for each document.
