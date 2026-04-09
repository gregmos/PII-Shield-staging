# MODE: BULK (Multiple Files)

Process up to 5 files. Wraps any of the modes above.

## Pipeline

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
