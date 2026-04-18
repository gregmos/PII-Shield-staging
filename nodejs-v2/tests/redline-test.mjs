#!/usr/bin/env node

/**
 * PII Shield v2.0.0 — Redline (tracked changes) test
 * Tests apply_tracked_changes tool via stdio protocol.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import JSZip from "jszip";

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

// ID-based response routing
const waiterById = new Map();
const responseById = new Map();
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

async function createTestDocx() {
  const docxPath = path.join(PROJECT, "test_redline_input.docx");
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("SERVICE AGREEMENT")] }),
        new Paragraph({ children: [new TextRun("This Agreement is entered into between Party A and Party B.")] }),
        new Paragraph({ children: [new TextRun("The term of this Agreement shall be 12 months from the effective date.")] }),
        new Paragraph({ children: [
          new TextRun("Party A shall indemnify Party B against "),
          new TextRun({ text: "all claims", bold: true }),
          new TextRun(" arising from negligence."),
        ] }),
        new Paragraph({ children: [new TextRun("This Agreement shall be governed by the laws of England and Wales.")] }),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buffer);
  return docxPath;
}

async function main() {
  console.log("=== PII Shield v2.0.0 Redline Tests ===\n");

  // Create test fixture
  const docxPath = await createTestDocx();

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

  const initResp = await readResponseById(0, 5000);
  assert(initResp?.result?.serverInfo?.version === "2.0.0", "Server initialized v2.0.0");

  let nextId = 1;
  async function tool(name, args = {}) {
    const id = nextId++;
    const msg = JSON.stringify({
      jsonrpc: "2.0", id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    proc.stdin.write(msg + "\n");
    const resp = await readResponseById(id, 30000);
    if (!resp) {
      console.log(`  ⚠ No response for ${name} (id:${id}, timeout)`);
      return {};
    }
    const content = resp?.result?.content?.[0]?.text || "";
    try { return JSON.parse(content); } catch { return content; }
  }

  // Test apply_tracked_changes
  console.log("\n--- apply_tracked_changes ---");
  const changes = JSON.stringify([
    { oldText: "12 months", newText: "24 months" },
    { oldText: "all claims", newText: "direct claims only" },
    { oldText: "England and Wales", newText: "the State of New York" },
  ]);

  const tc = await tool("apply_tracked_changes", {
    file_path: docxPath,
    changes,
    author: "Legal Review",
  });

  assert(tc.status === "success", "Tracked changes applied");
  assert(tc.changes_applied === 3, `${tc.changes_applied} changes applied`);
  assert(tc.output_path?.includes("tracked_changes"), "Output path has tracked_changes suffix");

  // Verify the output file exists and contains revision marks
  if (tc.output_path && fs.existsSync(tc.output_path)) {
    assert(true, "Output file exists");

    // Read the DOCX ZIP and check word/document.xml for w:del and w:ins
    const buffer = fs.readFileSync(tc.output_path);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");

    assert(docXml?.includes("w:del"), "Contains w:del elements (deletions)");
    assert(docXml?.includes("w:ins"), "Contains w:ins elements (insertions)");
    assert(docXml?.includes("w:delText"), "Contains w:delText (deleted text preserved)");
    assert(docXml?.includes("Legal Review"), "Author attribute set correctly");
    assert(docXml?.includes("24 months"), "New text (24 months) present");
    assert(docXml?.includes("12 months"), "Old text (12 months) preserved in delText");
    assert(docXml?.includes("direct claims only"), "New text (direct claims only) present");
    assert(docXml?.includes("the State of New York"), "New text (State of New York) present");

    // Cleanup output
    try { fs.unlinkSync(tc.output_path); } catch { /* */ }
  } else {
    assert(false, "Output file exists");
  }

  // Summary
  console.log(`\n=============================`);
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  console.log(`=============================\n`);

  // Cleanup
  proc.kill();
  try { fs.unlinkSync(docxPath); } catch { /* */ }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Redline test failed:", e);
  process.exit(1);
});
