/**
 * PII Shield CLI — process-wide cleanup registry.
 *
 * Long-lived resources (HITL HTTP server, etc.) register a teardown
 * callback here. On SIGINT/SIGTERM the entry point (bin.ts) drains the
 * queue so ports are freed and pending writes flush before exit.
 *
 * Lives in a stand-alone module so command files can register without
 * importing bin.ts (avoids circular module init at SIGINT time).
 */

type CleanupFn = () => void | Promise<void>;

const fns: CleanupFn[] = [];
let running = false;

export function registerCleanup(fn: CleanupFn): () => void {
  fns.push(fn);
  return () => {
    const idx = fns.indexOf(fn);
    if (idx >= 0) fns.splice(idx, 1);
  };
}

export async function runAllCleanup(): Promise<void> {
  if (running) return;
  running = true;
  const list = fns.splice(0);
  for (const fn of list) {
    try {
      await Promise.resolve(fn());
    } catch {
      /* never block shutdown */
    }
  }
}
