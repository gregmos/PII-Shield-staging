# MODE: COMPARISON (Diff Two Documents)

Compare two versions of a document or two related documents. Show what changed.

## Pipeline

```
1. Warm-up: list_entities() → confirm tools loaded
2. Resolve host paths: create marker → resolve_path for each file → host_path_1, host_path_2
   (See path-resolution.md for details. Fallback: find_file or ask user)
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
