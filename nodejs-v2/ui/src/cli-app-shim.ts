/**
 * Vite-aliased replacement for `@modelcontextprotocol/ext-apps` when
 * building review-cli.html.
 *
 * Provides an App class with the same surface area as the MCP Apps SDK,
 * but talks HTTP to a local PII Shield CLI server instead of the MCP host:
 *
 *   GET  /api/sessions/init?token=…   → drives App.ontoolresult once on connect()
 *   POST /api/sessions/apply          → backs App.callServerTool('apply_review_overrides')
 *   POST /api/sessions/done           → final acknowledgement after all approvals
 *   POST /api/sessions/cancel         → user dismissed the panel
 *
 * Bearer token is read from `?token=…` in the page URL. All API calls send it
 * as `Authorization: Bearer <token>` AND echo it back as `?token=` for browsers
 * that strip Authorization headers from cross-origin XHR (we're same-origin
 * here, but defence-in-depth).
 */

export interface McpUiHostContext {
  theme?: "light" | "dark";
}

interface CallToolArgs {
  name: string;
  arguments: Record<string, unknown>;
}

interface FakeCallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function readToken(): string {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export class App {
  ontoolresult: ((result: FakeCallToolResult) => void) | null = null;
  onhostcontextchanged: ((ctx: McpUiHostContext) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  private token: string;
  private userApproved = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** doc_ids in the order the server delivered them. Index lookup matches
   * the bulk-tab `data-idx` attribute the UI sets on each tab element. */
  private docIdByIdx: string[] = [];
  /** session_id captured from /init payload — included in /approve requests. */
  private sessionId: string = "";

  constructor(_meta: { name: string; version: string }) {
    void _meta;
    this.token = readToken();
  }

  async connect(): Promise<void> {
    if (!this.token) {
      throw new Error(
        "No ?token= in URL — open the URL printed by `pii-shield review`.",
      );
    }
    const res = await fetch(
      `/api/sessions/init?token=${encodeURIComponent(this.token)}`,
      { headers: { "Authorization": `Bearer ${this.token}` } },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`init failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as {
      sessions?: Array<{ doc_id?: string; session_id?: string }>;
      is_bulk?: boolean;
    };
    // Cache doc_ids in the order the server returned them — review-app.ts
    // renders tabs in this same order, so `.doc-tab[data-idx=N]` maps back
    // to docIdByIdx[N].
    this.docIdByIdx = (data.sessions ?? []).map((s) => s?.doc_id ?? "");
    this.sessionId = data.sessions?.[0]?.session_id ?? "";

    // Synthesize a CallToolResult-shaped object so review-app.ts logic stays
    // unchanged. structuredContent shape matches the MCP `start_review`
    // response (status: 'review_ready', sessions: [...]).
    const fakeResult: FakeCallToolResult = {
      content: [{ type: "text", text: "review payload ready" }],
      structuredContent: {
        status: "review_ready",
        sessions: data.sessions ?? [],
        is_bulk: data.is_bulk ?? false,
      },
    };
    if (this.ontoolresult) this.ontoolresult(fakeResult);

    // Fire onhostcontextchanged with whatever theme the user has at OS level.
    if (this.onhostcontextchanged) {
      const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      this.onhostcontextchanged({ theme: dark ? "dark" : "light" });
    }

    // Hook the Approve buttons. Each click is the user's explicit
    // approval of the active tab — we POST /api/sessions/approve with
    // the active tab's doc_id BEFORE the bulk-loop /apply requests fire
    // (the click handler runs synchronously before review-app's async
    // approve() body kicks off). Server uses this to validate /done.
    this.hookApproveButtons();
    // Overlay observer is the "all tabs approved → user is done" signal:
    // review-app.ts adds `visible` to #approved-overlay only when every
    // bulkSessions[i].approved is true (line 939-941). That requires the
    // user to click Approve in each tab one by one. We POST /done then.
    this.observeApprovedOverlay();

    // Heartbeat keeps the server's idle timer alive while the user is
    // reading a long document. Server-side timeout is generous, but a
    // legal review can run >30 min and we don't want the server to die
    // mid-read.
    this.heartbeatTimer = setInterval(() => {
      fetch(
        `/api/sessions/heartbeat?token=${encodeURIComponent(this.token)}`,
        { method: "POST", headers: authHeaders(this.token), body: "{}" },
      ).catch(() => { /* server gone — let beforeunload handle */ });
    }, 30_000);

    // Page-leave handling — deliberately asymmetric:
    //   - If the user already approved (this.userApproved) we re-fire /done
    //     via sendBeacon to make sure the server hears it even if the
    //     in-flight fetch from observeApprovedOverlay was cut off.
    //   - We do NOT auto-fire /cancel on close. F5/Ctrl+R also raises
    //     beforeunload, and the browser exposes no reliable way to tell
    //     reload from real close — auto-cancelling would silently kill a
    //     20-minute review the moment the user accidentally hits refresh.
    //     If the user closes the tab without approving, the server falls
    //     back to its idle timeout (30 min) or a CLI Ctrl-C cancels.
    window.addEventListener("beforeunload", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (!this.userApproved) return;
      try {
        navigator.sendBeacon?.(
          `/api/sessions/done?token=${encodeURIComponent(this.token)}`,
          new Blob([JSON.stringify({})], { type: "application/json" }),
        );
      } catch {
        /* best effort */
      }
    });
  }

  private currentDocId(): string | null {
    // Bulk: read the active tab's data-idx, look up the doc_id.
    const activeTab = document.querySelector<HTMLElement>(".doc-tab.active");
    if (activeTab) {
      const idx = parseInt(activeTab.dataset.idx ?? "-1", 10);
      if (idx >= 0 && idx < this.docIdByIdx.length) {
        return this.docIdByIdx[idx]!;
      }
    }
    // Single-doc review: only one entry, that's the one being approved.
    if (this.docIdByIdx.length === 1) return this.docIdByIdx[0]!;
    return null;
  }

  private hookApproveButtons(): void {
    const handler = () => {
      const docId = this.currentDocId();
      if (!docId) return;
      // Fire-and-forget. Idempotent on the server side, so multiple clicks
      // (and double-fire from #approve-btn vs #approve-btn-bottom) are safe.
      fetch(
        `/api/sessions/approve?token=${encodeURIComponent(this.token)}`,
        {
          method: "POST",
          headers: authHeaders(this.token),
          body: JSON.stringify({
            session_id: this.sessionId,
            doc_id: docId,
          }),
        },
      ).catch(() => { /* swallow — overlay observer is the safety net */ });
    };
    for (const id of ["approve-btn", "approve-btn-bottom"]) {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", handler);
    }
  }

  private observeApprovedOverlay(): void {
    const overlay = document.getElementById("approved-overlay");
    if (!overlay) return;
    const check = () => {
      if (overlay.classList.contains("visible") && !this.userApproved) {
        this.userApproved = true;
        // Fire /done — server closes after responding. Browser tab can
        // remain open showing the success message; CLI exits success.
        fetch(
          `/api/sessions/done?token=${encodeURIComponent(this.token)}`,
          { method: "POST", headers: authHeaders(this.token), body: "{}" },
        ).catch(() => { /* server already closing — fine */ });
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
    // Also check once now in case overlay is somehow already visible.
    check();
  }

  async callServerTool(args: CallToolArgs): Promise<FakeCallToolResult> {
    if (args.name !== "apply_review_overrides") {
      throw new Error(`Unsupported tool in CLI mode: ${args.name}`);
    }
    const res = await fetch(
      `/api/sessions/apply?token=${encodeURIComponent(this.token)}`,
      {
        method: "POST",
        headers: authHeaders(this.token),
        body: JSON.stringify(args.arguments),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`apply failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    };
  }
}
