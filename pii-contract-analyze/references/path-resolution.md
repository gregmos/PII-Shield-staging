# File Input Handling & Path Resolution

## CRITICAL PRIVACY RULE

Always use `anonymize_file(file_path)` — NEVER extract text in the sandbox and pass it to `anonymize_text`. When you extract text in the sandbox, the raw text enters Claude's context window and passes through the API — defeating the purpose of anonymization. With `anonymize_file`, only the file PATH (a short string) goes through the API. The MCP server on the host reads and anonymizes the file locally. PII never leaves the user's machine.

## How to determine the host file path

PII Shield runs on the **HOST machine**, not in the Cowork sandbox. `anonymize_file` needs the Windows/Mac/Linux host path.

**Step 1 — Marker-based resolution** (primary method, zero-config):
Create a unique marker file next to the target file, then call `resolve_path`:
```bash
MARKER=".pii_marker_$(openssl rand -hex 4)"
touch /path/to/folder/$MARKER
```
Then: `resolve_path(filename="contract.docx", marker=$MARKER)` returns the host path. Marker is auto-deleted. The mapping is cached for the session.

**Step 2 — VirtioFS mount info** (alternative, no user interaction):
Check the VirtioFS mount to derive the host path:
```bash
ls /mnt/.virtiofs-root/shared/
```
This shows the host user's home folder structure. Derive the host path from the mount structure.

**Step 3 — Use `find_file(filename)`** (fallback): Searches the configured working directory (Settings > Extensions > PII Shield). If found, use the returned path.

**Step 4 — Ask the user** (last resort): If all above fail, ask the user for the full host path.

**Use `output_dir` for all subsequent files**:
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
