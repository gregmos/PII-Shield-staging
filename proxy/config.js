/**
 * PII Shield Proxy — Configuration
 * All values derived from the Python server (pii_shield_server.py) and manifest.json.
 */

// Tool definitions — names, descriptions and input schemas matching the Python backend exactly.
export const TOOLS = [
  {
    name: "find_file",
    description: "Find a file on the host by filename. Searches the configured working directory only.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename to search for" },
      },
      required: ["filename"],
    },
  },
  {
    name: "anonymize_text",
    description: "Anonymize PII in text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to anonymize" },
        language: { type: "string", description: "Language code", default: "en" },
        prefix: { type: "string", description: "Prefix for placeholders (e.g. 'D1' for multi-file)", default: "" },
        entity_overrides: { type: "string", description: "JSON overrides for entity types", default: "" },
      },
      required: ["text"],
    },
  },
  {
    name: "anonymize_file",
    description: "Anonymize PII in a file (.pdf, .docx, .txt, .md, .csv). PREFERRED \u2014 PII stays on host. Pass review_session_id for HITL re-anonymization (server applies overrides internally).",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file to anonymize" },
        language: { type: "string", description: "Language code", default: "en" },
        prefix: { type: "string", description: "Prefix for placeholders", default: "" },
        review_session_id: { type: "string", description: "Session ID from HITL review for re-anonymization", default: "" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "anonymize_docx",
    description: "Anonymize PII in .docx preserving formatting",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to .docx file" },
        language: { type: "string", description: "Language code", default: "en" },
        prefix: { type: "string", description: "Prefix for placeholders", default: "" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "deanonymize_text",
    description: "Restore PII to local .docx file (never returns PII to Claude)",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Anonymized text to restore" },
        session_id: { type: "string", description: "Session ID for mapping lookup", default: "" },
        output_path: { type: "string", description: "Output file path", default: "" },
      },
      required: ["text"],
    },
  },
  {
    name: "deanonymize_docx",
    description: "Restore PII in .docx preserving formatting (file only)",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to anonymized .docx" },
        session_id: { type: "string", description: "Session ID for mapping lookup", default: "" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_mapping",
    description: "Get placeholder keys and types (no real PII values)",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID", default: "" },
      },
      required: [],
    },
  },
  {
    name: "scan_text",
    description: "Detect PII without anonymizing (preview mode)",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to scan" },
        language: { type: "string", description: "Language code", default: "en" },
      },
      required: ["text"],
    },
  },
  {
    name: "list_entities",
    description: "Show status, supported types, and recent sessions",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "start_review",
    description: "Start local review server and return URL for HITL verification. Does NOT open browser. PII stays on your machine.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to review", default: "" },
      },
      required: [],
    },
  },
  {
    name: "get_review_status",
    description: "Check if user approved the HITL review. Returns status and has_changes only (no PII or override details).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID", default: "" },
      },
      required: [],
    },
  },
  {
    name: "anonymize_next_chunk",
    description: "Process next chunk of a chunked anonymization session. Returns progress and partial result.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Chunked session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_full_anonymized_text",
    description: "Assemble all processed chunks and finalize the anonymization. Returns output_path and session_id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Chunked session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "resolve_path",
    description: "Zero-config file path resolution. Finds a marker file on host via BFS to map VM paths to host paths.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename to resolve" },
        marker: { type: "string", description: "Marker filename for BFS search" },
        vm_dir: { type: "string", description: "VM directory path (optional)", default: "" },
      },
      required: ["filename", "marker"],
    },
  },
];

// Python subprocess config
export const PYTHON_CONFIG = {
  MIN_PYTHON_VERSION: "3.10",
  SUBPROCESS_FLAG: "--mode=subprocess",
  STARTUP_TIMEOUT_MS: 600_000, // 10 min — matches _engine_ready.wait(timeout=600) in Python
  CALL_TIMEOUT_MS: 55_000,     // under 60s Cowork limit
};

// Environment variable defaults (from pii_shield_server.py)
export const ENV_DEFAULTS = {
  PII_MIN_SCORE: "0.50",
  PII_GLINER_MODEL: "knowledgator/gliner-pii-base-v1.0",
  PII_MAPPING_TTL_DAYS: "7",
  PII_PORT: "8765",
  PII_REVIEW_PORT: "8766",
};

// Tools that can respond without Python backend
export const HYBRID_TOOLS = new Set(["list_entities"]);
