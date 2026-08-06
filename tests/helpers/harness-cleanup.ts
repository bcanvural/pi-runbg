/**
 * Anti-hang net for suites that spawn real child processes.
 *
 * A spawned child keeps Node's event loop alive, so a test that fails an
 * assertion before its cleanup line leaves the child running and the whole
 * FILE hangs instead of reporting the failure — the failure is replaced by a
 * timeout with no useful output. (That is exactly how a `cat -v` buffering
 * mistake presented while writing the interaction-lock tests.)
 *
 * Usage: call `useHarnessCleanup()` once at module scope, and pass each
 * harness through `trackHarness(...)` where it is created. Every tracked
 * harness is shut down after each test, whether the test passed, failed, or
 * threw. Shutdown is best-effort and idempotent, so suites that already clean
 * up explicitly keep working unchanged.
 */

import { afterEach } from "node:test";

export interface CleanableHarness {
	/** Preferred: the harness's own (usually flag-guarded) shutdown. */
	shutdown?: () => Promise<void> | void;
	/** Fallback: emit `session_shutdown` through the extension's handlers. */
	emit?: (event: string, evt?: unknown) => Promise<unknown>;
}

const live = new Set<CleanableHarness>();

/** Register a harness for automatic post-test shutdown. Returns it unchanged. */
export function trackHarness<T extends CleanableHarness>(harness: T): T {
	live.add(harness);
	return harness;
}

/** Install the after-each shutdown net for this file. Call once at module scope. */
export function useHarnessCleanup(): void {
	afterEach(async () => {
		const harnesses = [...live];
		live.clear();
		for (const harness of harnesses) {
			try {
				if (typeof harness.shutdown === "function") await harness.shutdown();
				else if (typeof harness.emit === "function") await harness.emit("session_shutdown", {});
			} catch {
				// Best effort: a cleanup failure must not mask the test's own result.
			}
		}
	});
}
