/**
 * SessionStore — keyed registry of ExecSession instances with LRU eviction.
 *
 * Mirrors codex's `ProcessStore` + `prune_processes_if_needed`:
 *   - Caps at `maxSessions` entries.
 *   - When inserting would exceed the cap, prune the LRU entry that is NOT in
 *     the N-most-recent "protected" set. Prefer already-exited entries first.
 *   - IDs are monotonic and never reused.
 *
 * The store does NOT own process lifetime beyond terminate-on-evict and
 * terminate-all-on-shutdown. The ExecSession itself drives its child.
 */

import { ExecSession } from "./session.ts";

export interface SessionStoreOptions {
	maxSessions: number;
	lruProtectedCount: number;
	/** Called when a session is evicted (for UI cleanup). */
	onEvict?: (session: ExecSession, reason: "lru" | "shutdown") => void;
}

export class SessionStore {
	private readonly sessions = new Map<number, ExecSession>();
	private nextId = 1;
	readonly maxSessions: number;
	readonly lruProtectedCount: number;
	private readonly onEvict: SessionStoreOptions["onEvict"];

	constructor(opts: SessionStoreOptions) {
		this.maxSessions = opts.maxSessions;
		this.lruProtectedCount = opts.lruProtectedCount;
		this.onEvict = opts.onEvict;
	}

	/** Allocate a new monotonic session id (never reused). */
	allocateId(): number {
		return this.nextId++;
	}

	get(id: number): ExecSession | undefined {
		return this.sessions.get(id);
	}

	values(): ExecSession[] {
		return Array.from(this.sessions.values());
	}

	get size(): number {
		return this.sessions.size;
	}

	/** Live (not yet exited) sessions currently held. */
	get liveCount(): number {
		let n = 0;
		for (const s of this.sessions.values()) if (!s.hasExited) n++;
		return n;
	}

	/**
	 * Reap every exited session, ignoring the recency-protected set — used
	 * before refusing at the cap (divergence #6). Protecting a LIVE recently
	 * used session from being killed is the point of the protected set;
	 * "protecting" an exited one protects nothing and would make us refuse
	 * while holding reapable corpses. Note this drops the unobserved exit
	 * info of those sessions, same as ordinary LRU eviction of exited
	 * entries (codex's prune prefers exited victims the same way).
	 */
	reapExited(): ExecSession[] {
		const reaped: ExecSession[] = [];
		for (const s of Array.from(this.sessions.values())) {
			if (!s.hasExited) continue;
			this.sessions.delete(s.id);
			this.onEvict?.(s, "lru");
			reaped.push(s);
		}
		return reaped;
	}

	/**
	 * Insert a session. Returns the evicted session, if any. If inserting the
	 * new session would exceed the cap, prune an LRU non-protected entry
	 * first — but only ever an EXITED one (divergence #6): killing a live
	 * process to make room silently breaks whatever depended on it, so
	 * callers must check `wouldEvictLive()` and refuse instead.
	 */
	insert(session: ExecSession): { pruned?: ExecSession; count: number } {
		let pruned: ExecSession | undefined;
		if (this.sessions.size >= this.maxSessions) {
			pruned = this.pruneLru({ exitedOnly: true }) ?? undefined;
		}
		this.sessions.set(session.id, session);
		return { pruned, count: this.sessions.size };
	}

	/**
	 * True when an insert right now could only make room by killing a live
	 * session — i.e. the caller should refuse instead of inserting.
	 */
	wouldEvictLive(): boolean {
		if (this.sessions.size < this.maxSessions) return false;
		for (const s of this.sessions.values()) if (s.hasExited) return false;
		return true;
	}

	/** Remove a session (e.g., when it exits). */
	remove(id: number): ExecSession | undefined {
		const entry = this.sessions.get(id);
		if (!entry) return undefined;
		this.sessions.delete(id);
		return entry;
	}

	/** Terminate all sessions and clear the store. Used on session_shutdown. */
	terminateAll(): ExecSession[] {
		const drained = Array.from(this.sessions.values());
		this.sessions.clear();
		for (const s of drained) {
			try {
				s.terminate();
			} catch {
				// ignore
			}
			this.onEvict?.(s, "shutdown");
		}
		return drained;
	}

	/**
	 * LRU eviction policy (matches codex's `process_id_to_prune_from_meta`):
	 *   1. Protect the N most-recently-used entries.
	 *   2. Among unprotected: prefer already-exited entries (oldest first).
	 *   3. Otherwise: oldest unprotected entry, alive or not.
	 */
	private pruneLru(opts: { exitedOnly?: boolean } = {}): ExecSession | null {
		const entries = Array.from(this.sessions.values());
		if (entries.length === 0) return null;

		// One ascending sort: the last N entries are the protected (most recent) set.
		const byRecencyAsc = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
		const protectedIds = new Set<number>(
			this.lruProtectedCount > 0 ? byRecencyAsc.slice(-this.lruProtectedCount).map((e) => e.id) : [],
		);

		// Prefer oldest exited entries first. With exitedOnly (the insert path,
		// divergence #6) an exited victim is the ONLY acceptable one: exited
		// entries are searched regardless of protection, and a live session is
		// never killed to make room.
		const exitedCandidate =
			byRecencyAsc.find((e) => !protectedIds.has(e.id) && e.hasExited) ??
			(opts.exitedOnly ? byRecencyAsc.find((e) => e.hasExited) : undefined);
		const victim = exitedCandidate ?? (opts.exitedOnly ? undefined : byRecencyAsc.find((e) => !protectedIds.has(e.id)));
		if (!victim) return null;

		this.sessions.delete(victim.id);
		try {
			victim.terminate();
		} catch {
			// ignore
		}
		this.onEvict?.(victim, "lru");
		return victim;
	}
}
