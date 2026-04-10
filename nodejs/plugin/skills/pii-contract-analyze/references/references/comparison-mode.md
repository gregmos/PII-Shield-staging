# MODE: COMPARISON (Diff Two Documents)

Compare two versions of a document or two related documents. Show what changed.

## Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. Resolve host paths: create marker → resolve_path for each file → host_path_1, host_path_2
   (See path-resolution.md for details. Fallback: find_file or ask user)
3. anonymize_file(file_path_1, prefix="D1") → output_path_1, session_id_1
   DO NOT read output_path yet! (HITL absolute ban — no reading before review)
4. anonymize_file(file_path_2, prefix="D2") → output_path_2, session_id_2
   DO NOT read output_path yet!
5. HITL Review (BOTH documents at once):
   start_review(session_ids=[session_id_1, session_id_2]) → bulk review URL
   User reviews both documents in one tabbed page, approves each.
6. Poll each session: get_review_status(session_id_1), get_review_status(session_id_2)
   until BOTH approved
7. For each sid with has_changes=true:
   anonymize_file(file_path, review_session_id=sid) → new output_path, NEW sid
8. NOW read all output files (only after both reviews are approved)
9. Compare: structural diff (added/removed/changed clauses)
10. Create comparison report .docx via docx-js
    — Use session_id_1 for deanonymization (primary document)
    — D2 placeholders remain as-is OR use deanonymize_text for D2 references
11. deanonymize_docx(comparison.docx, session_id_1) → final.docx
12. Copy to mnt/outputs/, present link to user
    **DO NOT read, verify, or pandoc the deanonymized file — it contains real PII. Just give the path.**
```

**Important**: Do NOT call `start_review` separately for each document. Use `session_ids` array to get a single bulk review URL with tabs for both docs.

**Note**: With prefix support, `<D1_ORG_1>` and `<D2_ORG_1>` won't collide even if both files mention the same entity. The comparison report can reference both sets of placeholders.
