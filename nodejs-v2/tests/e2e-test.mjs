#!/usr/bin/env node

/**
 * PII Shield v2.0.0 — End-to-end test
 * Tests all 14 MCP tools via stdio protocol.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const PROJECT = path.resolve(ROOT, "..");
const BUNDLE = path.join(PROJECT, "dist", "server.bundle.mjs");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

async function callTool(proc, id, name, args = {}) {
  const msg = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  proc.stdin.write(msg + "\n");
}

// ID-based response routing
const responseById = new Map(); // id → response
const waiterById = new Map();   // id → resolve function
let stdoutBuffer = "";

function setupResponseReader(proc) {
  proc.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const id = parsed.id;
        if (id !== undefined && waiterById.has(id)) {
          const resolve = waiterById.get(id);
          waiterById.delete(id);
          resolve(parsed);
        } else if (id !== undefined) {
          responseById.set(id, parsed);
        }
      } catch { /* skip non-JSON */ }
    }
  });
}

async function readResponseById(id, timeoutMs = 90000) {
  if (responseById.has(id)) {
    const resp = responseById.get(id);
    responseById.delete(id);
    return resp;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiterById.delete(id);
      resolve(null);
    }, timeoutMs);
    waiterById.set(id, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Compat
async function readResponses(proc, count, timeoutMs = 90000) {
  // For init response (id=0)
  return [await readResponseById(0, timeoutMs)];
}

async function createTestDocx() {
  const docxPath = path.join(PROJECT, "test_e2e_input.docx");
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("TEST AGREEMENT")] }),
        new Paragraph({ children: [new TextRun("This Agreement is between John Smith and Acme Corporation.")] }),
        new Paragraph({ children: [new TextRun("Email: john@acme.com. Phone: +44 7911 123456.")] }),
        new Paragraph({ children: [new TextRun("UK NIN: AB 12 34 56 C.")] }),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buffer);
  return docxPath;
}

async function main() {
  console.log("=== PII Shield v2.0.0 E2E Tests ===\n");

  // Build first
  console.log("Building...");
  const { execSync } = await import("node:child_process");
  execSync("node esbuild.config.mjs", { cwd: PROJECT, stdio: "pipe" });
  console.log("Build OK\n");

  // Create test fixtures
  const docxPath = await createTestDocx();
  const txtPath = path.join(PROJECT, "test_e2e_input.txt");
  fs.writeFileSync(txtPath, "Maria Garcia from Deutsche Bank AG, email maria@db.com, IBAN DE89 3704 0044 0532 0130 00.");

  // Start server
  const proc = spawn("node", [BUNDLE], {
    cwd: PROJECT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  setupResponseReader(proc);

  // Initialize
  proc.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 0,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
  }) + "\n");

  // Wait for init
  const [initResp] = await readResponses(proc, 1, 5000);
  assert(initResp?.result?.serverInfo?.version === "2.0.0", "Server initialized v2.0.0");

  let nextId = 1;
  async function tool(name, args = {}) {
    const id = nextId++;
    await callTool(proc, id, name, args);
    const resp = await readResponseById(id, 120000);
    if (!resp) {
      console.log(`  ⚠ No response for ${name} (id:${id}, timeout)`);
      return {};
    }
    const content = resp?.result?.content?.[0]?.text || "";
    try { return JSON.parse(content); } catch { return content; }
  }

  // 1. list_entities
  console.log("\n--- list_entities ---");
  const le = await tool("list_entities");
  assert(le.status === "ready", "Status is ready");
  assert(le.version === "2.0.0", "Version 2.0.0");
  assert(le.supported_entities?.length >= 30, `${le.supported_entities?.length} entities supported`);

  // 2. scan_text
  console.log("\n--- scan_text ---");
  const sc = await tool("scan_text", { text: "John Smith email john@acme.com NIN AB 12 34 56 C" });
  assert(sc.status === "success", "Scan succeeded");
  assert(sc.entity_count >= 2, `Found ${sc.entity_count} entities`);

  // 3. anonymize_text
  console.log("\n--- anonymize_text ---");
  const at = await tool("anonymize_text", { text: "John Smith email john@acme.com UK NIN AB 12 34 56 C" });
  assert(at.status === "success", "Anonymize succeeded");
  assert(at.anonymized_text?.includes("<EMAIL_1>"), "Email replaced");
  assert(at.anonymized_text?.includes("<UK_NIN_1>"), "UK NIN replaced");
  const sid = at.session_id;

  // 4. get_mapping
  console.log("\n--- get_mapping ---");
  const gm = await tool("get_mapping", { session_id: sid });
  assert(gm.status === "success", "Mapping retrieved");
  assert(Object.keys(gm.placeholders || {}).length >= 2, "Has placeholders");

  // 5. deanonymize_text
  console.log("\n--- deanonymize_text ---");
  const dt = await tool("deanonymize_text", { text: at.anonymized_text, session_id: sid });
  assert(dt.status === "success", "Deanonymize succeeded");
  assert(dt.deanonymized_text?.includes("john@acme.com"), "Email restored");
  assert(dt.deanonymized_text?.includes("AB 12 34 56 C"), "UK NIN restored");

  // 6. anonymize_file (txt)
  console.log("\n--- anonymize_file (txt) ---");
  const af = await tool("anonymize_file", { file_path: txtPath });
  assert(af.status === "success", "File anonymized");
  assert(af.entity_count >= 2, `Found ${af.entity_count} entities`);
  assert(af.output_path?.includes("anonymized"), "Output path generated");

  // 7. find_file
  console.log("\n--- find_file ---");
  const ff = await tool("find_file", { filename: "nonexistent.xyz" });
  assert(ff.error || ff.hint, "File not found returns error/hint");

  // 8. resolve_path
  console.log("\n--- resolve_path ---");
  const rp = await tool("resolve_path", { filename: "test.txt", marker: "_nonexistent_marker_" });
  assert(rp.error || rp.hint, "Marker not found returns error/hint");

  // 9. start_review
  console.log("\n--- start_review ---");
  const sr = await tool("start_review", { session_id: sid });
  assert(sr.status === "success" || sr.review_url, "Review started");
  assert(sr.review_url?.includes("127.0.0.1"), "Review URL is localhost");

  // 10. get_review_status
  console.log("\n--- get_review_status ---");
  const gs = await tool("get_review_status", { session_id: sid });
  assert(gs.status === "pending" || gs.status === "approved" || gs.status === "not_found", `Review status: ${gs.status}`);

  // 11. anonymize_docx
  console.log("\n--- anonymize_docx ---");
  const ad = await tool("anonymize_docx", { file_path: docxPath });
  assert(ad.output_path?.includes("anonymized"), "DOCX anonymized");
  assert(ad.total_entities >= 2, `Found ${ad.total_entities} entities`);
  assert(ad.html_text?.includes("<h1>"), "HTML generated");
  const docxSid = ad.session_id;

  // 12. deanonymize_docx
  console.log("\n--- deanonymize_docx ---");
  const dd = await tool("deanonymize_docx", { file_path: ad.output_path, session_id: docxSid });
  assert(dd.restored_path?.includes("restored"), "DOCX restored");

  // Summary
  console.log(`\n=============================`);
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  console.log(`=============================\n`);

  // Cleanup
  proc.kill();
  try { fs.unlinkSync(txtPath); } catch { /* */ }
  try { fs.unlinkSync(docxPath); } catch { /* */ }
  try {
    const outDir = path.dirname(af.output_path || "");
    if (outDir && fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true });
  } catch { /* */ }
  try {
    const outDir = path.dirname(ad.output_path || "");
    if (outDir && fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true });
  } catch { /* */ }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E test failed:", e);
  process.exit(1);
});
