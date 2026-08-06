/**
 * Per-session interaction serialization — divergence #7 (UPSTREAM.md).
 *
 * Reads and writes against one session must not overlap: they share a
 * destructively-drained output buffer and the session's lifecycle. Codex
 * enforces this with a per-process `interaction_lock`
 * (codex-rs/core/src/unified_exec/process_manager.rs — "reads and writes
 * against one terminal must not overlap because they share a draining output
 * buffer and process lifecycle"). The port had no equivalent while pi runs a
 * turn's tool batch in PARALLEL by default (pi-agent-core `agent-loop.ts`
 * `executeToolCalls`), so two `write_stdin` calls on one session could starve
 * each other's drain (one returning zero bytes for its whole window) and both
 * deliver a terminal result for the same exit.
 *
 * Difference from codex: our waits are far longer (empty polls up to 290 s,
 * `yield_until` unbounded), so a plain FIFO lock would make an interrupt wait
 * behind a parked poll — worse than the race it fixes. Instead:
 *
 *   - A **preemptible** holder (an empty progress poll) must never keep
 *     parking while anything is queued behind it. Preemption is modeled as
 *     STATE, not an edge: the holder's preempt signal is armed whenever the
 *     queue is non-empty, both at acquisition and when a waiter enqueues.
 *     Three queued polls therefore degenerate correctly — each returns as
 *     soon as the next one is waiting, rather than the first preemptor's
 *     abort being "spent" on the active holder.
 *   - **Non-preemptible** holders (input writes, kill drains) are short and
 *     bounded, so they simply run to completion.
 *   - Waiters are **cancellation-aware at dequeue**: a queued interaction
 *     whose own tool call was cancelled while it waited is dropped instead of
 *     executing minutes later — a queued `"y\n"` confirmation must never land
 *     after the user pressed Esc.
 *
 * `yield_until` parks WITHOUT the lock (it never drains while waiting) and
 * takes it only for its terminal/deadline drains, so a long human-requested
 * wait can neither hold the lock for hours nor be preempted out of existence.
 */

/** Thrown by `acquire` when the caller's own signal aborted while queued. */
export class InteractionCancelled extends Error {
	constructor() {
		super("interaction cancelled while queued");
		this.name = "InteractionCancelled";
	}
}

export interface InteractionHandle {
	/**
	 * Aborts when another interaction is waiting and this holder is
	 * preemptible. Pass into the drain as an additional abort source.
	 */
	readonly preempt: AbortSignal;
	/** True once `preempt` fired — lets callers label the result honestly. */
	readonly preempted: boolean;
	release(): void;
}

interface Waiter {
	preemptible: boolean;
	signal: AbortSignal | undefined;
	resolve(handle: InteractionHandle): void;
	reject(err: unknown): void;
}

/**
 * One lock per session. Not reentrant: a holder must never acquire again
 * before releasing (all call sites acquire once per tool call).
 */
export class InteractionLock {
	private queue: Waiter[] = [];
	private holder: { preemptible: boolean; controller: AbortController } | undefined;

	get busy(): boolean {
		return this.holder !== undefined;
	}

	get waiting(): number {
		return this.queue.length;
	}

	/**
	 * Acquire the lock. `preemptible: true` marks a holder that must yield as
	 * soon as anyone else wants the session (empty progress polls).
	 * Rejects with `InteractionCancelled` if `signal` aborts while queued —
	 * callers translate that into their normal cancelled-result path.
	 */
	acquire(opts: { preemptible: boolean; signal?: AbortSignal }): Promise<InteractionHandle> {
		if (opts.signal?.aborted) return Promise.reject(new InteractionCancelled());
		if (!this.holder) {
			return Promise.resolve(this.grant(opts.preemptible));
		}
		return new Promise<InteractionHandle>((resolve, reject) => {
			const waiter: Waiter = { preemptible: opts.preemptible, signal: opts.signal, resolve, reject };
			this.queue.push(waiter);
			// A waiter exists → any preemptible holder must stop parking now.
			this.armPreemption();
		});
	}

	private grant(preemptible: boolean): InteractionHandle {
		const controller = new AbortController();
		this.holder = { preemptible, controller };
		// Queue could already be non-empty when this holder starts (it was
		// granted from a release with others still queued).
		if (preemptible && this.queue.length > 0) controller.abort();
		let released = false;
		const lock = this;
		return {
			preempt: controller.signal,
			get preempted() {
				return controller.signal.aborted;
			},
			release() {
				if (released) return; // idempotent: safe in `finally` after a throw
				released = true;
				if (lock.holder?.controller === controller) lock.holder = undefined;
				lock.pump();
			},
		};
	}

	/** Tell a preemptible holder to stop waiting for more output. */
	private armPreemption(): void {
		if (this.holder?.preemptible) this.holder.controller.abort();
	}

	/** Hand the lock to the next live waiter, dropping cancelled ones. */
	private pump(): void {
		while (!this.holder && this.queue.length > 0) {
			const next = this.queue.shift()!;
			if (next.signal?.aborted) {
				// Cancelled while queued — never execute it.
				next.reject(new InteractionCancelled());
				continue;
			}
			next.resolve(this.grant(next.preemptible));
			return;
		}
	}
}

/** Lazily-created locks keyed by session id, dropped when a session is removed. */
export class InteractionLocks {
	private locks = new Map<number, InteractionLock>();

	for(sessionId: number): InteractionLock {
		let lock = this.locks.get(sessionId);
		if (!lock) {
			lock = new InteractionLock();
			this.locks.set(sessionId, lock);
		}
		return lock;
	}

	/**
	 * Forget a session's lock. Safe while callers are still queued: they hold
	 * their own reference, so pending waiters still drain in order — this only
	 * stops the map from growing per session id.
	 *
	 * Note the invariant this relies on: a caller arriving AFTER the forget
	 * gets a *fresh* lock, so it is not mutually excluded against waiters on
	 * the old one. That is harmless only because forget() happens on removal
	 * and **every drain path re-reads the store while holding its lock** — a
	 * removed session fails that check before touching the buffer. A future
	 * drain path that skips the re-check would turn this into a real race.
	 */
	forget(sessionId: number): void {
		this.locks.delete(sessionId);
	}

	clear(): void {
		this.locks.clear();
	}

	get size(): number {
		return this.locks.size;
	}
}
