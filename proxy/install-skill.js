/**
 * install-skill.js — copy bundled pii-contract-analyze skill to ~/.claude/skills/
 *
 * Claude Desktop .mcpb extensions are NOT one of the 4 locations Claude Code
 * scans for skills (see https://code.claude.com/docs/en/skills — skills live
 * in enterprise, personal `~/.claude/skills/`, project `.claude/skills/`, or
 * plugin `<plugin>/skills/`). A skill bundled inside a .mcpb is invisible.
 *
 * To still ship the skill + MCP as a single drag-drop artifact, the proxy
 * copies the bundled skill into the Personal location (~/.claude/skills/)
 * on startup. This is idempotent: we write a version stamp and skip when
 * it matches. A version bump in manifest.json automatically refreshes the
 * installed skill on next proxy startup.
 *
 * Non-fatal: errors are logged to stderr but never throw — the MCP must
 * still start even if the skill install fails.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// proxy/install-skill.js → extension root is parent of proxy/
const EXT_ROOT = path.resolve(__dirname, "..");
const SKILL_SRC = path.join(EXT_ROOT, "skills", "pii-contract-analyze");
const SKILL_DEST = path.join(
  os.homedir(),
  ".claude",
  "skills",
  "pii-contract-analyze",
);
const STAMP_FILE = path.join(SKILL_DEST, ".pii_shield_version");

function readManifestVersion() {
  try {
    const manifestPath = path.join(EXT_ROOT, "manifest.json");
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return m.version || "unknown";
  } catch {
    return "unknown";
  }
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyDir(s, d);
    } else if (e.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

export async function installBundledSkill() {
  try {
    if (!fs.existsSync(SKILL_SRC)) {
      // No bundled skill in this build — nothing to do.
      return;
    }

    const version = readManifestVersion();

    // Fast path: stamp file matches current version → already installed.
    if (fs.existsSync(STAMP_FILE)) {
      try {
        const existing = fs.readFileSync(STAMP_FILE, "utf8").trim();
        if (existing === version) {
          console.error(
            `[PII Shield Proxy] Skill pii-contract-analyze already installed (v${version}).`,
          );
          return;
        }
      } catch {
        // fall through to reinstall
      }
    }

    // Wipe any previous install (version bump, partial install, etc.)
    // so the copy is clean and we don't leave stale files from older versions.
    if (fs.existsSync(SKILL_DEST)) {
      await fsp.rm(SKILL_DEST, { recursive: true, force: true });
    }

    console.error(
      `[PII Shield Proxy] Installing bundled skill pii-contract-analyze (v${version}) → ${SKILL_DEST}`,
    );
    await copyDir(SKILL_SRC, SKILL_DEST);
    await fsp.writeFile(STAMP_FILE, version, "utf8");
    console.error("[PII Shield Proxy] Skill installed.");
  } catch (err) {
    // Non-fatal. The MCP must still start.
    console.error(
      `[PII Shield Proxy] Skill install failed (non-fatal): ${err.message}`,
    );
  }
}
