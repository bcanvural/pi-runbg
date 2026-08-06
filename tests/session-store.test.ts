/**
 * SessionStore LRU policy tests.
 *
 * We use synthetic ExecSession-like stubs so we don't have to spawn real
 * processes in unit tests. The store only relies on `id`, `lastUsed`,
 * `hasExited`, and `terminate()`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SessionStore } from "../src/session-store.ts";
import type { ExecSession } from "../src/session.ts";

class StubSession {
	readonly id: number;
	private lastUsedAt: number;
	private exited: boolean;
	terminatedWith: NodeJS.Signals | null = null;
	constructor(id: number, lastUsed: number, exited = false) {
		this.id = id;
		this.lastUsedAt = lastUsed;
		this.exited = exited;
	}
	get lastUsed(): number {
		return this.lastUsedAt;
	}
	get hasExited(): boolean {
		return this.exited;
	}
	setExited() {
		this.exited = true;
	}
	setLastUsed(ms: number) {
		this.lastUsedAt = ms;
	}
	terminate(signal: NodeJS.Signals = "SIGTERM") {
		this.terminatedWith = signal;
	}
}

function stub(id: number, lastUsed: number, exited = false): ExecSession {
	return new StubSession(id, lastUsed, exited) as unknown as ExecSession;
}

describe("SessionStore", () => {
	it("allocates monotonic ids starting at 1", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		assert.equal(store.allocateId(), 1);
		assert.equal(store.allocateId(), 2);
		assert.equal(store.allocateId(), 3);
	});

	it("insert+get+remove roundtrip", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		const a = stub(1, 1000);
		store.insert(a);
		assert.equal(store.get(1), a);
		assert.equal(store.size, 1);
		store.remove(1);
		assert.equal(store.get(1), undefined);
		assert.equal(store.size, 0);
	});

	it("evicts nothing when under cap", () => {
		const store = new SessionStore({ maxSessions: 5, lruProtectedCount: 2 });
		for (let i = 1; i <= 4; i++) {
			const { pruned } = store.insert(stub(i, 1000 + i));
			assert.equal(pruned, undefined);
		}
		assert.equal(store.size, 4);
	});

	it("evicts oldest exited entry first", () => {
		// cap=3, protected=1 (only the most recent is protected).
		// Fill with 3 entries; 2 exited. Insert 4th → should evict the oldest exited.
		const store = new SessionStore({ maxSessions: 3, lruProtectedCount: 1 });
		const a = stub(1, 1000, /*exited*/ true); // oldest exited
		const b = stub(2, 2000, /*exited*/ true); // newer exited
		const c = stub(3, 3000, /*exited*/ false); // newest alive
		store.insert(a);
		store.insert(b);
		store.insert(c);
		const d = stub(4, 4000);
		const { pruned } = store.insert(d);
		assert.ok(pruned, "expected a pruned entry");
		assert.equal(pruned!.id, 1, `expected id=1 evicted, got id=${pruned!.id}`);
		assert.equal(store.size, 3);
	});

	// Divergence #6 (UPSTREAM.md): insert NEVER kills a live session to make
	// room. Upstream fell back to "oldest unprotected, alive or not"; callers
	// must now check wouldEvictLive() and refuse instead.
	it("never evicts a live session on insert (all-alive store)", () => {
		const store = new SessionStore({ maxSessions: 3, lruProtectedCount: 1 });
		const a = stub(1, 1000);
		store.insert(a);
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000));
		assert.equal(store.wouldEvictLive(), true, "at cap with only live sessions → caller must refuse");
		const { pruned } = store.insert(stub(4, 4000));
		assert.equal(pruned, undefined, "no victim");
		assert.equal((a as unknown as StubSession).terminatedWith, null, "live session must not be signalled");
	});

	it("reaps an exited entry on insert even when recency-protected", () => {
		// cap=2, protected=2: both entries protected, one exited.
		const store = new SessionStore({ maxSessions: 2, lruProtectedCount: 2 });
		store.insert(stub(1, 1000, /*exited*/ true));
		store.insert(stub(2, 2000));
		assert.equal(store.wouldEvictLive(), false, "an exited entry is free room");
		const { pruned } = store.insert(stub(3, 3000));
		assert.equal(pruned!.id, 1, "the exited entry is reaped despite protection");
	});

	it("reapExited clears every exited entry and reports them", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 8 });
		store.insert(stub(1, 1000, true));
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000, true));
		const reaped = store.reapExited().map((s) => s.id).sort();
		assert.deepEqual(reaped, [1, 3]);
		assert.equal(store.size, 1);
		assert.equal(store.liveCount, 1);
	});

	it("liveCount counts only non-exited entries", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		store.insert(stub(1, 1000, true));
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000));
		assert.equal(store.size, 3);
		assert.equal(store.liveCount, 2);
	});

	it("protects the N most recent entries", () => {
		// cap=5, protected=3. Oldest 2 unprotected. Even though older exist, only unprotected evicted.
		const store = new SessionStore({ maxSessions: 5, lruProtectedCount: 3 });
		store.insert(stub(1, 1000, /*exited*/ true));
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000));
		store.insert(stub(4, 4000));
		store.insert(stub(5, 5000)); // most recent (protected)
		const newEntry = stub(6, 6000);
		const { pruned } = store.insert(newEntry);
		// id 3, 4, 5 are protected (3 most recent). id 1 (exited) is the victim.
		assert.equal(pruned!.id, 1);
	});

	it("terminates the evicted session (exited victim)", () => {
		const store = new SessionStore({ maxSessions: 1, lruProtectedCount: 0 });
		const victim = stub(1, 1000, /*exited*/ true);
		store.insert(victim);
		store.insert(stub(2, 2000));
		// terminate() on an already-exited session is a no-op in the real
		// ExecSession, but the store still calls it — pin that it's the victim.
		assert.equal((victim as unknown as StubSession).terminatedWith, "SIGTERM");
		assert.equal(store.get(1), undefined);
	});

	it("terminateAll clears and signals each session", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		const a = stub(1, 1);
		const b = stub(2, 2);
		store.insert(a);
		store.insert(b);
		const drained = store.terminateAll();
		assert.equal(drained.length, 2);
		assert.equal(store.size, 0);
		assert.equal((a as unknown as StubSession).terminatedWith, "SIGTERM");
		assert.equal((b as unknown as StubSession).terminatedWith, "SIGTERM");
	});

	it("onEvict callback fires for LRU and shutdown", () => {
		const events: Array<{ id: number; reason: string }> = [];
		const store = new SessionStore({
			maxSessions: 2,
			lruProtectedCount: 1,
			onEvict: (s, reason) => events.push({ id: s.id, reason }),
		});
		store.insert(stub(1, 1000, /*exited*/ true));
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000)); // evicts 1
		assert.deepEqual(events, [{ id: 1, reason: "lru" }]);

		store.terminateAll();
		const reasons = events.slice(1).map((e) => e.reason).sort();
		assert.deepEqual(reasons, ["shutdown", "shutdown"]);
	});

	it("allocateId is monotonic (ids are never reused)", () => {
		const store = new SessionStore({ maxSessions: 5, lruProtectedCount: 1 });
		const id = store.allocateId();
		const next = store.allocateId();
		assert.ok(next > id);
	});
});
