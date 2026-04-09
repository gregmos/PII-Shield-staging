---
description: Dump PII Shield debug logs + diagnostics to a downloadable ZIP at the workspace root
allowed-tools: mcp__pii-shield__collect_debug_logs, mcp__plugin_pii-shield_pii-shield__collect_debug_logs, ToolSearch
---

Package all PII Shield audit logs, NER initialization errors, and runtime diagnostics into a single ZIP at the current workspace root. This is an **MCP tool** (`collect_debug_logs`), NOT a skill.

### Step 1 — fetch the tool schema if needed

PII Shield MCP tools are often **deferred** (not in your main tool list) in hosts with many total tools, such as Cowork. `allowed-tools` is only a permission whitelist — it does NOT force-expose deferred tools. If `collect_debug_logs` is not already in your tool list with any `mcp__…__` prefix, fetch it FIRST:

```
ToolSearch(query: "+pii-shield +debug", max_results: 5)
```

Use whichever fully-qualified name comes back:
- `mcp__pii-shield__collect_debug_logs` (local CLI / Desktop form)
- `mcp__plugin_pii-shield_pii-shield__collect_debug_logs` (Cowork / plugin-namespaced form)

If neither name comes back, the MCP server is not running. Tell the user to reinstall the plugin and STOP.

### Step 2 — call the tool

Call the fully-qualified `collect_debug_logs` tool with no arguments.

### Step 3 — report

1. Report the `zip_path` and size to the user.
2. Tell them: in Cowork the file is visible in the file browser / Artifacts panel on the right and can be downloaded to the host machine from there; on a local install the file is in their current working directory.
3. Confirm that the bundle contains **no document PII** and that environment secrets are redacted, so it is safe to share for debugging.

Do not call any other tools beyond `ToolSearch` (Step 1) and `collect_debug_logs` (Step 2). Do not attempt to open or read the ZIP contents yourself.
