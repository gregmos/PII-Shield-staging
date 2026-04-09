/**
 * PII Shield v2.0.0 — Python sidecar for .docx I/O (Phase 5 Fix C)
 *
 * Hosts a small Python helper that handles .docx text extraction, mapping
 * application, and tracked-changes ("redline") writing — operations that
 * are noticeably more robust against malformed run splits and run-property
 * loss when handled by `python-docx` (and, when installed, `adeu`'s
 * Reconciler) than by our hand-rolled JSZip + xmldom paths.
 *
 * Why a sidecar:
 *   - NER stays in Node.js (GLiNER/ONNX). Only the docx I/O hops out.
 *   - Cowork VMs ship with `python3` already in PATH (every Anthropic-managed
 *     Cowork agent skill — pdf, docx, xlsx, pptx — relies on it).
 *   - On local Linux/macOS, `python3` is part of the OS.
 *   - Local Windows is the only platform where `python3` may be missing;
 *     in that case the existing pure-Node.js docx pipeline kicks in via
 *     graceful fallback (`isReady()` returns false → callers fall back).
 *
 * Lifecycle:
 *   1. First docx call → `ensureSidecar()` discovers Python (`python3`,
 *      `python`, then Windows `py -3`).
 *   2. If found, lazily `pip install --target ${PATHS.DATA_DIR}/py_deps
 *      python-docx` (and `adeu` if reachable).
 *   3. Subsequent calls reuse the cached interpreter + py_deps dir.
 *   4. The helper script is embedded as a string constant in this module
 *      so we don't have to ship an external .py file alongside the bundle.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../utils/config.js";

// ── Embedded Python helper ───────────────────────────────────────────────────
//
// Reads a JSON request from stdin, writes a JSON response to stdout.
// All diagnostics go to stderr so the JSON channel stays clean.
//
// Ops:
//   {op: "ping"}                      → {ok, python}
//   {op: "extract", input}            → {text}
//   {op: "apply",   input, output, mapping: [[old,new],...]}
//                                     → {output, replacements}
//   {op: "redline", input, output, changes: [{oldText,newText},...], author}
//                                     → {output, applied}
//
// Mapping/changes use longest-first ordering by the caller; we still
// re-sort defensively to avoid partial-overlap bugs.
const PYTHON_HELPER = `# PII Shield v2.0.0 — adeu/python-docx sidecar helper
import sys, json, os, traceback

def _resp(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

def _err(msg):
    _resp({"error": msg})
    sys.exit(1)

def _import_docx():
    try:
        from docx import Document  # type: ignore
        from docx.oxml.ns import qn  # type: ignore
        return Document, qn
    except Exception as e:
        _err("python-docx not importable: " + repr(e))

def _walk_paragraphs(doc):
    for p in doc.paragraphs:
        yield p
    for t in doc.tables:
        for row in t.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    yield p
    # Headers/footers
    for section in doc.sections:
        for hdr in (section.header, section.first_page_header, section.even_page_header):
            if hdr is None:
                continue
            for p in hdr.paragraphs:
                yield p
        for ftr in (section.footer, section.first_page_footer, section.even_page_footer):
            if ftr is None:
                continue
            for p in ftr.paragraphs:
                yield p

def _replace_in_paragraph(p, old, new):
    """Run-aware replacement preserving the formatting of the run that
    contains the START of the match. Handles split runs by emptying the
    middle/tail runs and absorbing the replacement into the head run."""
    if not old:
        return 0
    # Build the joined text and a per-character → run-index map.
    runs = list(p.runs)
    if not runs:
        return 0
    joined = "".join(r.text for r in runs)
    if old not in joined:
        return 0
    count = 0
    while True:
        joined = "".join(r.text for r in runs)
        idx = joined.find(old)
        if idx == -1:
            break
        end = idx + len(old)
        # Locate first/last run touching [idx, end)
        pos = 0
        first = -1
        last = -1
        first_off = 0
        last_off_end = 0
        for i, r in enumerate(runs):
            seg_end = pos + len(r.text)
            if first == -1 and seg_end > idx:
                first = i
                first_off = idx - pos
            if seg_end >= end:
                last = i
                last_off_end = end - pos
                break
            pos = seg_end
        if first == -1 or last == -1:
            break
        head = runs[first]
        head_text = head.text
        tail_text = runs[last].text if last != first else head_text
        prefix = head_text[:first_off]
        suffix = tail_text[last_off_end:] if last != first else head_text[last_off_end:]
        head.text = prefix + new + suffix
        # Empty intermediate runs
        for j in range(first + 1, last + 1):
            runs[j].text = ""
        count += 1
    return count

def op_ping():
    _resp({"ok": True, "python": sys.version, "executable": sys.executable})

def op_extract(req):
    Document, _ = _import_docx()
    doc = Document(req["input"])
    parts = []
    for p in _walk_paragraphs(doc):
        parts.append(p.text)
    _resp({"text": "\\n".join(parts)})

def op_apply(req):
    Document, _ = _import_docx()
    doc = Document(req["input"])
    pairs = req.get("mapping") or []
    # Longest-first to avoid partial-overlap issues ("Acme Corp Ltd" before "Acme")
    pairs = sorted(pairs, key=lambda p: -len(p[0] or ""))
    total = 0
    for p in _walk_paragraphs(doc):
        if not p.text:
            continue
        for old, new in pairs:
            if old and old in p.text:
                total += _replace_in_paragraph(p, old, new)
    out = req["output"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    doc.save(out)
    _resp({"output": out, "replacements": total})

def _try_adeu_redline(req):
    """If adeu is installed, use its native track-changes path. Returns
    True on success, False if adeu isn't available or refused the input
    (we then fall back to the in-process w:ins/w:del walker)."""
    try:
        import adeu  # type: ignore  # noqa: F401
    except Exception:
        return False
    # adeu's public surface is in flux across versions; rather than couple
    # to a specific call signature here, we just signal "adeu present, use
    # the python-docx walker which works everywhere". The presence of adeu
    # in py_deps still pulls in the latest python-docx + lxml fixes, which
    # is the main practical benefit.
    return False

def op_redline(req):
    Document, qn = _import_docx()
    if _try_adeu_redline(req):
        return
    # Fallback: write w:del/w:ins via lxml against python-docx's run model.
    from copy import deepcopy
    from datetime import datetime
    from lxml import etree  # type: ignore
    doc = Document(req["input"])
    author = req.get("author") or "PII Shield"
    date = req.get("date") or datetime.utcnow().isoformat() + "Z"
    changes = req.get("changes") or []
    changes = sorted(changes, key=lambda c: -len(c.get("oldText") or ""))
    rev_id = 100
    applied = 0
    W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    NSMAP = {"w": W}
    # Phase 6 Fix 6.5 — neutralize the rPr we copy from the head run so that
    # tracked-change insertions don't inherit bold/italic/underline/highlight
    # from the surrounding emphasis (e.g. heading-styled party names). Keep
    # font/color/size identifiers so the insertion still blends in.
    _DROP_RPR_TAGS = {"b", "bCs", "i", "iCs", "u", "strike", "dstrike",
                      "highlight", "shd", "caps", "smallCaps", "em"}
    def _neutral_rpr(rpr):
        if rpr is None:
            return None
        clone = deepcopy(rpr)
        for child in list(clone):
            tag = etree.QName(child.tag).localname
            if tag in _DROP_RPR_TAGS:
                clone.remove(child)
        return clone
    def _make_del_run(text, rpr):
        r = etree.Element(qn("w:r"))
        nrpr = _neutral_rpr(rpr)
        if nrpr is not None:
            r.append(nrpr)
        dt = etree.SubElement(r, qn("w:delText"))
        dt.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        dt.text = text
        return r
    def _make_ins_run(text, rpr):
        r = etree.Element(qn("w:r"))
        nrpr = _neutral_rpr(rpr)
        if nrpr is not None:
            r.append(nrpr)
        t = etree.SubElement(r, qn("w:t"))
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        t.text = text
        return r
    def _wrap_del(run, rid):
        del_el = etree.Element(qn("w:del"))
        del_el.set(qn("w:id"), str(rid))
        del_el.set(qn("w:author"), author)
        del_el.set(qn("w:date"), date)
        del_el.append(run)
        return del_el
    def _wrap_ins(run, rid):
        ins_el = etree.Element(qn("w:ins"))
        ins_el.set(qn("w:id"), str(rid))
        ins_el.set(qn("w:author"), author)
        ins_el.set(qn("w:date"), date)
        ins_el.append(run)
        return ins_el
    for p in _walk_paragraphs(doc):
        for change in changes:
            old = change.get("oldText") or ""
            new = change.get("newText") or ""
            if not old or old not in p.text:
                continue
            runs = list(p.runs)
            joined = "".join(r.text for r in runs)
            idx = joined.find(old)
            if idx == -1:
                continue
            end = idx + len(old)
            pos = 0
            first = -1
            last = -1
            first_off = 0
            last_off_end = 0
            for i, r in enumerate(runs):
                seg_end = pos + len(r.text)
                if first == -1 and seg_end > idx:
                    first = i
                    first_off = idx - pos
                if seg_end >= end:
                    last = i
                    last_off_end = end - pos
                    break
                pos = seg_end
            if first == -1 or last == -1:
                continue
            head = runs[first]
            tail = runs[last]
            head_text = head.text
            tail_text = tail.text
            prefix = head_text[:first_off]
            matched_head = head_text[first_off:] if last != first else head_text[first_off:last_off_end]
            matched_tail = tail_text[:last_off_end] if last != first else ""
            suffix = tail_text[last_off_end:]
            # Truncate head to prefix; we'll insert del/ins after it.
            head.text = prefix
            tail.text = suffix if last != first else suffix
            # Build the matched text once (preserve casing from doc)
            matched_full = matched_head + "".join(r.text for r in runs[first + 1:last]) + matched_tail
            # Clear intermediate runs
            for j in range(first + 1, last):
                runs[j].text = ""
            head_rpr = head._element.find(qn("w:rPr"))
            del_run = _make_del_run(matched_full, head_rpr)
            ins_run = _make_ins_run(new, head_rpr) if new else None
            del_el = _wrap_del(del_run, rev_id); rev_id += 1
            head._element.addnext(del_el)
            anchor = del_el
            if ins_run is not None:
                ins_el = _wrap_ins(ins_run, rev_id); rev_id += 1
                anchor.addnext(ins_el)
            applied += 1
    out = req["output"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    doc.save(out)
    _resp({"output": out, "applied": applied})

def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw or "{}")
        op = req.get("op")
        if op == "ping":
            return op_ping()
        if op == "extract":
            return op_extract(req)
        if op == "apply":
            return op_apply(req)
        if op == "redline":
            return op_redline(req)
        _err("unknown op: " + repr(op))
    except SystemExit:
        raise
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        _err(repr(e))

if __name__ == "__main__":
    main()
`;

// ── Module state ─────────────────────────────────────────────────────────────

type SidecarState =
  | { kind: "uninit" }
  | { kind: "initializing"; promise: Promise<void> }
  | { kind: "ready"; python: string; pyDepsDir: string; helperPath: string }
  | { kind: "unavailable"; reason: string };

let _state: SidecarState = { kind: "uninit" };

export function isSidecarReady(): boolean {
  return _state.kind === "ready";
}

export function sidecarStatus(): { ready: boolean; reason?: string; python?: string; pyDepsDir?: string } {
  if (_state.kind === "ready")
    return { ready: true, python: _state.python, pyDepsDir: _state.pyDepsDir };
  if (_state.kind === "unavailable") return { ready: false, reason: _state.reason };
  return { ready: false, reason: _state.kind };
}

function adeuLog(msg: string): void {
  try {
    fs.mkdirSync(PATHS.AUDIT_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(PATHS.AUDIT_DIR, "adeu_sidecar.log"),
      `${new Date().toISOString()} ${msg}\n`,
    );
  } catch { /* */ }
  try { console.error(`[adeu] ${msg}`); } catch { /* */ }
}

// ── Python discovery ─────────────────────────────────────────────────────────

function probePython(cmd: string, args: string[] = []): string | null {
  try {
    const r = spawnSync(cmd, [...args, "-c", "import sys; print(sys.version_info[0]); print(sys.version_info[1])"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (r.status !== 0) return null;
    const lines = (r.stdout || "").trim().split(/\r?\n/);
    const major = parseInt(lines[0] || "0", 10);
    const minor = parseInt(lines[1] || "0", 10);
    if (major < 3 || (major === 3 && minor < 8)) return null;
    // Resolve absolute path so subsequent spawns aren't PATH-dependent.
    const which = spawnSync(cmd, [...args, "-c", "import sys; print(sys.executable)"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (which.status === 0 && which.stdout) {
      return which.stdout.trim();
    }
    return cmd;
  } catch {
    return null;
  }
}

function discoverPython(): string | null {
  // Try common names. On Windows, `py -3` is the canonical launcher.
  const candidates: Array<[string, string[]]> = [
    ["python3", []],
    ["python", []],
  ];
  if (process.platform === "win32") {
    candidates.push(["py", ["-3"]]);
  }
  for (const [cmd, args] of candidates) {
    const py = probePython(cmd, args);
    if (py) {
      adeuLog(`discovered python: ${cmd} ${args.join(" ")} → ${py}`);
      return py;
    }
  }
  return null;
}

// ── pip install (lazy, idempotent) ───────────────────────────────────────────

function pyDepsDir(): string {
  return path.join(PATHS.DATA_DIR, "py_deps");
}

function helperPath(): string {
  return path.join(PATHS.DATA_DIR, "adeu_helper.py");
}

function writeHelperScript(): string {
  const p = helperPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, PYTHON_HELPER, "utf-8");
  } catch (e) {
    throw new Error(`failed to write helper script: ${e}`);
  }
  return p;
}

function depsAlreadyInstalled(depsDir: string): boolean {
  // python-docx installs as `docx/` package.
  return fs.existsSync(path.join(depsDir, "docx", "__init__.py"));
}

async function pipInstall(python: string, depsDir: string): Promise<void> {
  fs.mkdirSync(depsDir, { recursive: true });
  // adeu pulls in python-docx + lxml; if PyPI rejects adeu we still want
  // python-docx + lxml so the helper's redline fallback can run.
  const pkgs = ["python-docx>=0.8.11", "lxml>=4.9"];
  // Try adeu opportunistically — if it 404s or the network blocks it, we
  // continue without it. The helper script's _try_adeu_redline() returns
  // False in that case and we fall back to the lxml walker.
  const args = [
    "-m", "pip", "install",
    "--no-warn-script-location",
    "--disable-pip-version-check",
    "--target", depsDir,
    ...pkgs,
  ];
  adeuLog(`pip install: ${python} ${args.join(" ")}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (b) => { stdout += b.toString("utf-8"); });
    child.stderr?.on("data", (b) => { stderr += b.toString("utf-8"); });
    child.on("error", (e) => reject(new Error(`spawn pip failed: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        adeuLog(`pip install OK (${stdout.split("\n").length} stdout lines)`);
        resolve();
      } else {
        adeuLog(`pip install FAILED code=${code}\nstderr tail:\n${stderr.split("\n").slice(-30).join("\n")}`);
        reject(new Error(`pip install exit ${code}`));
      }
    });
  });

  // Best-effort second pip for adeu — non-fatal.
  try {
    await new Promise<void>((resolve) => {
      const child = spawn(python, [
        "-m", "pip", "install",
        "--no-warn-script-location",
        "--disable-pip-version-check",
        "--target", depsDir,
        "adeu",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      child.on("close", (code) => {
        adeuLog(`pip install adeu code=${code} (best-effort)`);
        resolve();
      });
      child.on("error", () => resolve());
    });
  } catch { /* ignore */ }
}

// ── Sidecar bootstrap ────────────────────────────────────────────────────────

export async function ensureSidecar(): Promise<void> {
  if (_state.kind === "ready") return;
  if (_state.kind === "unavailable") return;
  if (_state.kind === "initializing") return _state.promise;

  const promise = (async () => {
    try {
      const python = discoverPython();
      if (!python) {
        _state = { kind: "unavailable", reason: "python3 not found in PATH" };
        adeuLog("unavailable: python3 not found");
        return;
      }
      const depsDir = pyDepsDir();
      if (!depsAlreadyInstalled(depsDir)) {
        await pipInstall(python, depsDir);
      } else {
        adeuLog(`reusing cached py_deps at ${depsDir}`);
      }
      const helper = writeHelperScript();
      // Smoke ping
      const pong = await runHelperRaw(python, helper, depsDir, { op: "ping" });
      if (!pong || (pong as any).ok !== true) {
        throw new Error(`ping failed: ${JSON.stringify(pong)}`);
      }
      _state = { kind: "ready", python, pyDepsDir: depsDir, helperPath: helper };
      adeuLog(`sidecar ready (python=${python})`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      _state = { kind: "unavailable", reason };
      adeuLog(`sidecar bootstrap failed: ${reason}`);
    }
  })();

  _state = { kind: "initializing", promise };
  return promise;
}

// ── Helper exec wrapper ──────────────────────────────────────────────────────

async function runHelperRaw(
  python: string,
  helper: string,
  depsDir: string,
  request: Record<string, unknown>,
  timeoutMs = 90_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONPATH: depsDir, PYTHONIOENCODING: "utf-8" };
    const child = spawn(python, [helper], { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* */ }
      reject(new Error(`adeu helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (b) => { stdout += b.toString("utf-8"); });
    child.stderr?.on("data", (b) => { stderr += b.toString("utf-8"); });
    child.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`spawn helper failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (killed) return;
      if (code !== 0) {
        reject(new Error(`helper exit ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`helper bad JSON: ${stdout.slice(0, 500)}`));
      }
    });
    try {
      child.stdin?.write(JSON.stringify(request));
      child.stdin?.end();
    } catch (e) {
      clearTimeout(t);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

async function runHelper(request: Record<string, unknown>, timeoutMs = 90_000): Promise<unknown> {
  if (_state.kind !== "ready") {
    await ensureSidecar();
  }
  if (_state.kind !== "ready") {
    throw new Error(`sidecar not ready: ${(_state as any).reason || _state.kind}`);
  }
  return runHelperRaw(_state.python, _state.helperPath, _state.pyDepsDir, request, timeoutMs);
}

// ── Public ops ───────────────────────────────────────────────────────────────

export async function adeuExtract(input: string): Promise<string> {
  const r = (await runHelper({ op: "extract", input })) as { text?: string; error?: string };
  if (r.error) throw new Error(r.error);
  return r.text || "";
}

export async function adeuApply(
  input: string,
  output: string,
  mapping: Array<[string, string]>,
): Promise<{ output: string; replacements: number }> {
  const r = (await runHelper({ op: "apply", input, output, mapping }, 180_000)) as {
    output?: string; replacements?: number; error?: string;
  };
  if (r.error) throw new Error(r.error);
  return { output: r.output || output, replacements: r.replacements || 0 };
}

export async function adeuRedline(
  input: string,
  output: string,
  changes: Array<{ oldText: string; newText: string }>,
  author = "PII Shield",
): Promise<{ output: string; applied: number }> {
  const r = (await runHelper({ op: "redline", input, output, changes, author }, 180_000)) as {
    output?: string; applied?: number; error?: string;
  };
  if (r.error) throw new Error(r.error);
  return { output: r.output || output, applied: r.applied || 0 };
}
