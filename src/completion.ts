import { formatElapsedShort } from "./format-time.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { nowUtcIso } from "./time.ts";

/**
 * CompletionCoordinator — agent-level wake scheduling for
 * `exec_command(on_exit: "wake")` and `exec_command(on_output: {...})`,
 * kept deliberately separate from the low-level ExecSession process
 * transport.
 *
 * The central exactly-once invariant, per arm:
 *
 *     A wake event (process exit / output match) is delivered through a
 *     finalized tool result
 *                          OR
 *     the wake event causes one synthetic model prompt,
 *               normally never both — and one session never produces two.
 *
 * How the invariant is enforced:
 *   - A record is only created ("armed") once exec_command has committed to
 *     returning a background session_id. Each arm (exit, match) carries its
 *     own armed/suppressed/wakeQueued flags plus a monotonic generation;
 *     first event wins between two armed arms (a match suppresses the exit
 *     arm and vice versa — a match-only arm yields NO wake on
 *     exit-before-match, IV-0004 § Semantics).
 *   - Any write_stdin call that could return terminal status takes an
 *     OBSERVATION LEASE (keyed by toolCallId). While at least one observer is
 *     active, process exit is recorded but a wake is never enqueued — and a
 *     fired match is held too, because the poll's bounded result body may
 *     contain the excerpt that consumes it.
 *   - "Observed" is committed at Pi's finalized tool-result event
 *     (`tool_execution_end` with isError=false), NOT merely when the handler
 *     returns — a result that was constructed but finalized as error/cancelled
 *     keeps the completion wake-eligible. Match wakes are consumed by
 *     CONTAINMENT instead: a finalized result's post-truncation body must
 *     contain the sanitized excerpt. The check is staged per toolCallId WITH
 *     the arm generation at result build time and committed/rolled back at
 *     `tool_execution_end`; it fails closed to delivery (an empty excerpt
 *     never stages).
 *   - Wake records are RESERVED (wakeQueued=true) before sending, so
 *     concurrent flush triggers can never double-send; a failed send
 *     un-reserves (generation-carrying) and is retried at the next flush
 *     trigger. A flush groups eligible records BY KIND — at most one message
 *     per kind per flush — and the mid-flight deliver filter re-checks
 *     per-arm suppression AND generation-vs-reservation before handing a
 *     message to the sender.
 *   - Kill paths suppress BOTH arms at the record level BEFORE signaling the
 *     process; a failed kill restores eligibility without resurrecting an
 *     arm that first-event-wins already suppressed.
 */

export type OnExitPolicy = "none" | "wake";

/** Minimal session surface the coordinator needs (test-fakeable). */
export interface CompletionSessionLike {
	readonly id: number;
	readonly displayCommand: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly logPath: string | undefined;
	readonly hasExited: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failureMessage: string | null;
	readonly matchArmed: boolean;
	readonly matchPattern: string | null;
	readonly matchHasFired: boolean;
	readonly matchExcerptBytes: Uint8Array | undefined;
	onExit(listener: (session: unknown) => void): () => void;
	onMatch?(listener: (session: unknown) => void): () => void;
	setMatchArm?(pattern: string | null, caseSensitive: boolean): string;
}

/** Bounded completion metadata captured at exit time. */
export interface CompletionSnapshot {
	sessionId: number;
	command: string;
	cwd: string;
	startedAtMs: number;
	elapsedMs: number;
	exitCode: number | null;
	signal: string | null;
	failureMessage: string | null;
	logPath: string | undefined;
}

/**
 * Bounded readiness-match metadata captured at fire time (IV-0004). The
 * excerpt is the sanitized stream slice (child output — never case-folded);
 * `running`/`exitCode`/`signal`/`failureMessage` are refreshed at flush time
 * so a process that died during the debounce is reported truthfully.
 */
export interface MatchSnapshot {
	sessionId: number;
	command: string;
	cwd: string;
	startedAtMs: number;
	elapsedMs: number;
	running: boolean;
	logPath: string | undefined;
	matchPattern: string;
	matchExcerpt: string;
	toolTimeUtc: string;
	exitCode?: number | null;
	signal?: string | null;
	failureMessage?: string | null;
}

/** Match-arm policy value (on_output) — the shape the coordinator arms. */
export interface MatchArmPolicy {
	pattern: string;
	caseSensitive: boolean;
}

/** Per-arm wake policy change for setWakePolicy; omitted field = unchanged. */
export interface WakePolicyChange {
	onExit?: OnExitPolicy;
	onOutput?: MatchArmPolicy | null;
}

export type ExitArmStatus = "disarmed" | "already_none" | "armed" | "already_armed" | "too_late" | "unchanged";
export type MatchArmStatus = "disarmed" | "already_none" | "armed" | "replaced" | "already_armed" | "too_late" | "unchanged";

export interface WakePolicyResult {
	exit: ExitArmStatus;
	match: MatchArmStatus;
}

/** Match arm state on a record; the generation tags staged/reserved decisions. */
interface MatchArmState {
	armed: boolean;
	suppressed: boolean;
	wakeQueued: boolean;
	generation: number;
	snapshot: MatchSnapshot | undefined;
	excerpt: string | undefined;
	/** The arm's matching mode — the identical-arm fast path must compare it. */
	caseSensitive: boolean;
}

interface CompletionRecord {
	sessionId: number;
	// Exit arm — the pre-IV-0004 fields, plus a generation for reservations.
	armed: boolean;
	exited: boolean;
	observed: boolean;
	suppressed: boolean;
	wakeQueued: boolean;
	generation: number;
	/** toolCallIds of active observation leases. */
	observers: Set<string>;
	/** toolCallIds that returned a terminal result awaiting finalization. */
	pendingTerminal: Set<string>;
	snapshot: CompletionSnapshot | undefined;
	// Match arm — absent until an on_output arm is requested.
	match: MatchArmState | undefined;
	/** Monotonic per-record counter so a re-armed match never reuses a stale generation. */
	matchGenerationCounter: number;
	/** Record-level kill suppression: never clobbers first-event-wins per-arm state. */
	killSuppressed: boolean;
	session: CompletionSessionLike;
	unsubscribeExit: () => void;
	unsubscribeMatch: (() => void) | undefined;
}

export type WakeMessage =
	| { kind: "exit"; content: string; details: { sessions: CompletionSnapshot[] } }
	| { kind: "match"; content: string; details: { sessions: MatchSnapshot[] } };

export interface CompletionCoordinatorOptions {
	/** Deliver one synthetic model prompt (pi.sendMessage wrapper). May throw. */
	send: (message: WakeMessage) => void | Promise<void>;
	/** Debounce so naturally simultaneous completions batch into one prompt. */
	debounceMs?: number;
	/** Optional error sink for failed sends (ui.notify wrapper). */
	onSendError?: (error: unknown) => void;
	/** Injectable timers. Test hooks. */
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
	nowFn?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 250;
const MAX_COMMAND_CHARS = 160;
const MAX_FAILURE_CHARS = 200;
const MAX_SESSIONS_PER_WAKE = 16;
const EMPTY_BYTES = new Uint8Array(0);
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Strip terminal control characters from untrusted interpolated strings. */
export function sanitizeMeta(raw: string): string {
	// eslint-disable-next-line no-control-regex
	return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function oneLine(raw: string, max: number): string {
	const flat = sanitizeMeta(raw).replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export class CompletionCoordinator {
	private readonly records = new Map<number, CompletionRecord>();
	/** Staged containment decisions keyed by toolCallId: { sessionId, generation }. */
	private readonly stagedMatch = new Map<string, { sessionId: number; generation: number }>();
	private readonly opts: Required<Pick<CompletionCoordinatorOptions, "send" | "debounceMs">> &
		CompletionCoordinatorOptions;
	private debounceHandle: unknown;
	private stopped = false;

	constructor(options: CompletionCoordinatorOptions) {
		this.opts = { debounceMs: DEFAULT_DEBOUNCE_MS, ...options };
	}

	private now(): number {
		return this.opts.nowFn ? this.opts.nowFn() : Date.now();
	}

	private setTimer(cb: () => void, ms: number): unknown {
		return this.opts.setTimeoutFn ? this.opts.setTimeoutFn(cb, ms) : setTimeout(cb, ms);
	}

	private clearTimer(handle: unknown): void {
		if (this.opts.clearTimeoutFn) this.opts.clearTimeoutFn(handle);
		else clearTimeout(handle as NodeJS.Timeout);
	}

	/** Number of live records (test helper). */
	get recordCount(): number {
		return this.records.size;
	}

	/**
	 * Arm wake arms for a session. Call ONLY once exec_command has committed
	 * to returning a background session_id (or from setWakePolicy's arm
	 * paths). Handles both boundary races: the exit listener fires (via
	 * microtask) even if the session already exited, so a register-vs-exit
	 * race cannot lose the completion; and a match that already fired
	 * pre-commit (a fast banner during the attach window) is adopted here so
	 * it is staged for containment instead of lost.
	 */
	register(
		session: CompletionSessionLike,
		opts: { onExit?: boolean; onOutput?: MatchArmPolicy | null } = {},
	): void {
		if (this.stopped) return;
		if (this.records.has(session.id)) return;
		const onExit = opts.onExit ?? true;
		const onOutput = opts.onOutput;
		if (!onExit && !onOutput) return; // nothing armed — no record needed
		const record: CompletionRecord = {
			sessionId: session.id,
			armed: onExit,
			exited: false,
			observed: false,
			suppressed: false,
			wakeQueued: false,
			generation: 1,
			observers: new Set(),
			pendingTerminal: new Set(),
			snapshot: undefined,
			match: undefined,
			matchGenerationCounter: 1,
			killSuppressed: false,
			session,
			unsubscribeExit: () => {},
			unsubscribeMatch: undefined,
		};
		this.records.set(session.id, record);
		// ExecSession.onExit fires (via microtask) even if the session already
		// exited, so the register-vs-exit race cannot lose the completion.
		record.unsubscribeExit = session.onExit(() => this.recordExit(record));
		if (onOutput) {
			record.match = {
				armed: true,
				suppressed: false,
				wakeQueued: false,
				generation: record.matchGenerationCounter,
				snapshot: undefined,
				excerpt: undefined,
				caseSensitive: onOutput.caseSensitive,
			};
			if (session.onMatch) {
				record.unsubscribeMatch = session.onMatch(() => this.recordMatch(record));
			}
			// Pre-commit adoption: the matcher is armed at spawn, so a fast
			// banner can fire during exec_command's attach window. Containment
			// decides observed-vs-deliver from here (IV-0004 § Consumption).
			if (session.matchHasFired) this.recordMatch(record);
		}
	}

	/** Whether the EXIT wake arm is armed (and not yet resolved) for a session. */
	isArmed(sessionId: number): boolean {
		const r = this.records.get(sessionId);
		return !!r && r.armed && !r.observed && !r.suppressed;
	}
	/**
	 * Whether the match wake arm is still armed for a session. A fired arm
	 * (snapshot set) is one-shot-consumed: it audits as NOT armed even while
	 * its wake is pending delivery — "armed" means "can still fire".
	 */
	isMatchArmed(sessionId: number): boolean {
		const r = this.records.get(sessionId);
		const m = r?.match;
		return !!m && m.armed && !m.suppressed && m.snapshot === undefined;
	}

	/**
	 * The match arm's armed state plus its raw pattern for the set_on_exit
	 * echo. The caller sanitizes/truncates the pattern for display.
	 */
	matchArmInfo(sessionId: number): { armed: boolean; pattern: string | null } {
		const r = this.records.get(sessionId);
		const m = r?.match;
		if (!m || !m.armed || m.snapshot !== undefined) return { armed: false, pattern: null };
		return { armed: true, pattern: r.session.matchPattern };
	}
	/**
	 * Change wake policy by session id, per arm.
	 *   - onExit "none": disarm ONLY the exit arm (including LRU tombstones
	 *     that no longer have a store session). Does not kill the process.
	 *   - onExit "wake": arm auto-resume; requires a still-running session.
	 *   - onOutput {pattern, caseSensitive}: arm/replace the one-shot match
	 *     arm with a FRESH generation (re-arm goes through the session's
	 *     setMatchArm, so a fired arm gets a fresh matcher + ring + latch).
	 *   - onOutput null: disarm ONLY the match arm.
	 *   - Omitted field: that arm is left unchanged, so a both-omitted call
	 *     is a valid no-op audit.
	 *
	 * Disarm cannot recall a follow-up that `send` has already handed to pi.
	 */
	setWakePolicy(
		sessionId: number,
		policy: WakePolicyChange,
		session?: CompletionSessionLike | null,
	): WakePolicyResult {
		if (this.stopped) {
			return {
				exit: policy.onExit === "wake" ? "too_late" : policy.onExit === "none" ? "already_none" : "unchanged",
				match: policy.onOutput ? "too_late" : policy.onOutput === null ? "already_none" : "unchanged",
			};
		}
		const existing = this.records.get(sessionId);
		return {
			exit: this.changeExitArm(existing, sessionId, policy.onExit, session),
			match: this.changeMatchArm(existing, sessionId, policy.onOutput, session),
		};
	}

	private changeExitArm(
		existing: CompletionRecord | undefined,
		sessionId: number,
		policy: OnExitPolicy | undefined,
		session: CompletionSessionLike | null | undefined,
	): ExitArmStatus {
		if (policy === undefined) return "unchanged";
		if (policy === "none") {
			if (!existing) return "already_none";
			// Suppress even if a flush already reserved the wake but has not
			// resolved the record yet — the deliver filter drops it.
			existing.suppressed = true;
			this.resolveExitArm(existing);
			return "disarmed";
		}
		// policy === "wake"
		if (existing) {
			if (existing.observed || existing.killSuppressed) return "too_late";
			if (existing.suppressed || !existing.armed) {
				// Re-arm with a fresh generation: covers a previously disarmed
				// exit arm (setWakePolicy "none") and a first-event-wins-
				// suppressed one — but only while the session still lives.
				if (existing.session.hasExited) return "too_late";
				existing.armed = true;
				existing.suppressed = false;
				existing.wakeQueued = false;
				existing.generation += 1;
				// A still-registered listener (kept by resolveExitArm while a
				// match arm lives) must be dropped before re-subscribing, or
				// the session accumulates duplicate exit callbacks.
				existing.unsubscribeExit();
				existing.unsubscribeExit = existing.session.onExit(() => this.recordExit(existing));
				return "armed";
			}
			return "already_armed";
		}
		if (!session || session.id !== sessionId || session.hasExited) return "too_late";
		this.register(session, { onExit: true });
		return "armed";
	}

	private changeMatchArm(
		existing: CompletionRecord | undefined,
		sessionId: number,
		policy: MatchArmPolicy | null | undefined,
		session: CompletionSessionLike | null | undefined,
	): MatchArmStatus {
		if (policy === undefined) return "unchanged";
		if (policy === null) {
			if (!existing?.match) return "already_none";
			existing.match.suppressed = true;
			existing.match.wakeQueued = false;
			// Stop the session matcher too (idempotent on a fired/disarmed arm).
			existing.session.setMatchArm?.(null, false);
			this.resolveMatchArm(existing);
			return "disarmed";
		}
		if (!existing) {
			if (!session || session.id !== sessionId || session.hasExited) return "too_late";
			session.setMatchArm?.(policy.pattern, policy.caseSensitive);
			this.register(session, { onExit: false, onOutput: policy });
			return "armed";
		}
		const s = existing.session;
		if (s.hasExited || existing.killSuppressed) return "too_late";
		const m = existing.match;
		if (
			m &&
			m.armed &&
			!m.suppressed &&
			!m.wakeQueued &&
			m.snapshot === undefined &&
			s.matchPattern === policy.pattern &&
			m.caseSensitive === policy.caseSensitive
		) {
			// An identical, never-fired arm (same pattern AND matching mode)
			// is already in place: audit no-op. A case_sensitive toggle is a
			// real change and falls through to re-arm below.
			return "already_armed";
		}
		// Re-arm: fresh generation (stale staged/reserved decisions cannot
		// touch the new arm) and a fresh session matcher + ring + fire latch.
		existing.matchGenerationCounter += 1;
		existing.match = {
			armed: true,
			suppressed: false,
			wakeQueued: false,
			generation: existing.matchGenerationCounter,
			snapshot: undefined,
			excerpt: undefined,
			caseSensitive: policy.caseSensitive,
		};
		if (!existing.unsubscribeMatch && s.onMatch) {
			existing.unsubscribeMatch = s.onMatch(() => this.recordMatch(existing));
		}
		return "replaced";
	}

	private recordExit(record: CompletionRecord): void {
		// Repeated exit callbacks must never create duplicate wakes: the exited
		// flag latches and the snapshot is captured once.
		if (record.exited) return;
		record.exited = true;
		// EXIT-FIRST-WINS, only between two armed arms (IV-0004): the exit
		// event won. A match arm that never fired is resolved outright — the
		// session matcher checks hasExited, so it can never fire now, and it
		// can never be re-armed on a dead session; resolving (rather than
		// suppressing) prevents the coordinator record from leaking. This
		// subsumes the both-arms case: the exit wake proceeds alone. A match
		// arm that DID fire keeps its pending wake (match-only arms deliver
		// even though the process died afterwards — the spec's match-only +
		// exit rule applies to never-fired arms only).
		const m = record.match;
		if (m && m.armed && !m.suppressed && !m.wakeQueued && m.snapshot === undefined) {
			this.resolveMatchArm(record);
		}
		if (!record.armed) return;
		const s = record.session;
		record.snapshot = {
			sessionId: s.id,
			command: s.displayCommand,
			cwd: s.cwd,
			startedAtMs: s.startedAt,
			elapsedMs: this.now() - s.startedAt,
			exitCode: s.exitCode,
			signal: s.signal,
			failureMessage: s.failureMessage,
			logPath: s.logPath,
		};
		this.scheduleFlush();
	}

	private recordMatch(record: CompletionRecord): void {
		const m = record.match;
		if (!m || !m.armed || m.suppressed || m.snapshot) return;
		// Raw ring bytes frozen at fire time → sanitize as CHILD OUTPUT
		// (IV-0002), not metadata, and stored WITHOUT trimming: the excerpt
		// in details is the full sanitized slice and doubles as the
		// containment needle (the CONTENT copy is the only flattened one,
		// via oneLine). An empty-after-sanitize excerpt still delivers
		// (fail closed) — containment just never consumes it.
		const s = record.session;
		const excerpt = sanitizeOutputText(textDecoder.decode(s.matchExcerptBytes ?? EMPTY_BYTES));
		m.excerpt = excerpt;
		m.snapshot = {
			sessionId: s.id,
			command: s.displayCommand,
			cwd: s.cwd,
			startedAtMs: s.startedAt,
			elapsedMs: this.now() - s.startedAt,
			running: !s.hasExited,
			logPath: s.logPath,
			matchPattern: s.matchPattern ?? "",
			matchExcerpt: excerpt,
			toolTimeUtc: nowUtcIso(this.now()),
			...(s.hasExited ? { exitCode: s.exitCode, signal: s.signal, failureMessage: s.failureMessage } : {}),
		};
		// FIRST-EVENT-WINS: the match won — suppress the exit arm so this
		// session never produces two wakes.
		if (record.armed) record.suppressed = true;
		this.scheduleFlush();
	}

	// ---------------- Observation leases ----------------

	/**
	 * A write_stdin call that may return terminal status becomes an observer.
	 * While any observer is active, exit is recorded but no wake is enqueued
	 * — and a fired match is held too, because the poll's bounded result body
	 * may contain the excerpt that consumes it (containment, IV-0004).
	 */
	beginObservation(sessionId: number, toolCallId: string): void {
		this.records.get(sessionId)?.observers.add(toolCallId);
	}

	/**
	 * Release an observer WITHOUT marking completion observed (relative or
	 * absolute deadline reached while still running, cancellation, handler
	 * error). The exit wake stays armed; a match wake held by the lease
	 * becomes deliverable at the next flush (the pending-stage gate keeps
	 * holding it if the just-built result staged a containment decision).
	 */
	releaseObservation(sessionId: number, toolCallId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.observers.delete(toolCallId);
		r.pendingTerminal.delete(toolCallId);
		if (r.exited || this.hasPendingMatch(r)) this.scheduleFlush();
	}

	private hasPendingMatch(r: CompletionRecord): boolean {
		const m = r.match;
		return !!m && m.armed && !m.suppressed && !m.wakeQueued && m.snapshot !== undefined;
	}

	/**
	 * The handler constructed a terminal result for this tool call. The
	 * observation lease is HELD until Pi finalizes the tool result
	 * (`tool_execution_end`), at which point the completion is either marked
	 * observed (success) or released back to wake eligibility (error/cancel).
	 */
	markPendingTerminal(sessionId: number, toolCallId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.observers.add(toolCallId);
		r.pendingTerminal.add(toolCallId);
	}

	/**
	 * Pi finalized a tool result. Commits "observed" for pending-terminal
	 * observations on success; releases the lease (keeping the wake eligible)
	 * on error/cancellation. ALSO commits staged match consumptions: a
	 * successful finalization whose body contained the excerpt consumes the
	 * match arm (suppress + clear — never touches the exit arm); an errored
	 * finalization or a stale generation rolls back. Then flushes — any tool
	 * boundary is a safe point to retry failed sends.
	 */
	handleToolExecutionEnd(toolCallId: string, isError: boolean): void {
		for (const r of this.records.values()) {
			if (r.pendingTerminal.has(toolCallId)) {
				r.pendingTerminal.delete(toolCallId);
				r.observers.delete(toolCallId);
				if (!isError) {
					this.commitObserved(r);
				} else if (r.exited) {
					this.scheduleFlush();
				}
			} else if (r.observers.has(toolCallId)) {
				// Handler failed/cancelled before releasing: clean up the lease.
				r.observers.delete(toolCallId);
				if (r.exited) this.scheduleFlush();
			}
		}
		const staged = this.stagedMatch.get(toolCallId);
		if (staged) {
			this.stagedMatch.delete(toolCallId);
			const r = this.records.get(staged.sessionId);
			const m = r?.match;
			if (!isError && m && m.generation === staged.generation && m.excerpt && m.excerpt.length > 0) {
				// Containment committed: the finalized body carried the excerpt.
				m.suppressed = true;
				m.wakeQueued = false;
				this.resolveMatchArm(r);
			}
			// Otherwise the staged decision rolls back: nothing was reserved,
			// so a pending match wake stays eligible for the flush below.
		}
		this.flushPending();
	}

	private commitObserved(record: CompletionRecord): void {
		record.observed = true;
		this.resolveExitArm(record);
	}

	/**
	 * list_sessions (or another status read) reported terminal completion.
	 * EXIT arm only: listing carries the completion facts themselves, but it
	 * never shows a match excerpt — so it never consumes a match wake. If the
	 * exit wake was not yet queued, the report counts as direct observation;
	 * if a wake was already queued/sent, the session may be reaped without
	 * generating another notification.
	 */
	observeViaListing(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		if (r.wakeQueued) return;
		this.commitObserved(r);
	}

	// ---------------- Kill / eviction / shutdown suppression ----------------

	/** Suppress BOTH arms BEFORE signaling the process on an explicit kill. */
	suppress(sessionId: number): void {
		const r = this.records.get(sessionId);
		// killSuppressed is record-level on purpose: it never clobbers the
		// per-arm suppressed flags, so restoreAfterFailedKill cannot resurrect
		// an arm that first-event-wins already disarmed.
		if (r) r.killSuppressed = true;
	}

	/** The kill landed; the record is finished. */
	confirmKill(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (r) this.resolveRecord(r);
	}

	/** The kill did NOT land and the process is still alive: restore eligibility. */
	restoreAfterFailedKill(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.killSuppressed = false;
		if (r.exited) this.scheduleFlush();
	}

	/**
	 * A session was evicted from the store.
	 *   - Live process (LRU terminating it): suppress both arms.
	 *   - Naturally exited before notification: keep a bounded tombstone
	 *     snapshot long enough to send the one wake; resolve a never-fired
	 *     match arm (dead weight on a dead session).
	 */
	handleEviction(session: CompletionSessionLike): void {
		const r = this.records.get(session.id);
		if (!r) return;
		if (!session.hasExited) {
			// Being terminated by the eviction — not a natural completion.
			r.killSuppressed = true;
			this.resolveRecord(r);
			return;
		}
		// Natural exit, not yet notified. A match arm that never fired is
		// dead weight — the session matcher checks hasExited, so it can
		// never fire now. Resolve it: for exit-arm-disarmed sessions this
		// is the ONLY cleanup (recordExit never ran for them), and without
		// it the record leaks.
		if (r.match && !r.match.snapshot && !r.match.wakeQueued) {
			this.resolveMatchArm(r);
		}
		// A fired match arm keeps its record: the snapshot IS the
		// tombstone and the flush will deliver exactly one wake.
		this.scheduleFlush();
	}
	/** Session shutdown / reset / teardown: cancel timers, drop all records. */
	shutdown(): void {
		this.stopped = true;
		if (this.debounceHandle !== undefined) {
			this.clearTimer(this.debounceHandle);
			this.debounceHandle = undefined;
		}
		for (const r of this.records.values()) {
			r.unsubscribeExit();
			r.unsubscribeMatch?.();
		}
		this.records.clear();
		this.stagedMatch.clear();
	}

	/** Re-arm after a new session_start (never resurrects old records). */
	reset(): void {
		this.shutdown();
		this.stopped = false;
	}

	// ---------------- Per-arm resolution ----------------

	/**
	 * Settle the EXIT arm; the record survives while the match arm is live.
	 * The exit listener is deliberately KEPT while a match arm lives: a
	 * natural exit must still run recordExit, which resolves a never-fired
	 * match arm (its `!record.armed` early-return skips exit-snapshot
	 * building) — otherwise an exit-disarmed match-armed session would leak
	 * its record until eviction.
	 */
	private resolveExitArm(record: CompletionRecord): void {
		record.armed = false;
		if (!this.matchArmLive(record)) {
			record.unsubscribeExit();
			this.resolveRecord(record);
		}
	}

	/** Settle the MATCH arm; the record survives while the exit arm is live. */
	private resolveMatchArm(record: CompletionRecord): void {
		record.unsubscribeMatch?.();
		record.unsubscribeMatch = undefined;
		record.match = undefined;
		this.dropStagedFor(record.sessionId);
		if (!this.exitArmLive(record)) this.resolveRecord(record);
	}

	private exitArmLive(record: CompletionRecord): boolean {
		return record.armed && !record.observed && !record.suppressed && !record.killSuppressed;
	}

	private matchArmLive(record: CompletionRecord): boolean {
		const m = record.match;
		return !!m && m.armed && !m.suppressed && !record.killSuppressed;
	}

	private resolveRecord(record: CompletionRecord): void {
		record.unsubscribeExit();
		record.unsubscribeMatch?.();
		this.dropStagedFor(record.sessionId);
		this.records.delete(record.sessionId);
	}

	/** Staged containment decisions for a resolved arm/record are moot. */
	private dropStagedFor(sessionId: number): void {
		for (const [toolCallId, staged] of this.stagedMatch) {
			if (staged.sessionId === sessionId) this.stagedMatch.delete(toolCallId);
		}
	}
	// ---------------- Wake delivery ----------------

	private scheduleFlush(): void {
		if (this.stopped) return;
		if (this.debounceHandle !== undefined) return;
		this.debounceHandle = this.setTimer(() => {
			this.debounceHandle = undefined;
			this.flushPending();
		}, this.opts.debounceMs);
	}

	/**
	 * Deliver pending wakes, grouped BY KIND: exit-eligible records batch
	 * into one buildWakeMessage ("exit"), match-eligible records into one
	 * buildMatchWakeMessage ("match") — at most one message per kind per
	 * flush. Safe to call from any flush trigger (debounce timer,
	 * agent_settled, tool_execution_end); reservation via wakeQueued plus a
	 * per-arm generation re-check guarantees at most one prompt per arm.
	 */
	flushPending(): void {
		if (this.stopped) return;
		const exitEligible: CompletionRecord[] = [];
		const matchEligible: { record: CompletionRecord; generation: number }[] = [];
		for (const r of this.records.values()) {
			if (
				r.armed &&
				r.exited &&
				!r.observed &&
				!r.suppressed &&
				!r.wakeQueued &&
				!r.killSuppressed &&
				r.observers.size === 0 &&
				r.snapshot
			) {
				// First-event-wins at flush time: when the exit arm wins the
				// session, a fired-but-unflushed match arm is suppressed too —
				// one session never produces two wakes.
				if (r.match?.snapshot && !r.match.suppressed) r.match.suppressed = true;
				exitEligible.push(r);
			} else if (
				r.match &&
				r.match.armed &&
				r.match.snapshot &&
				!r.match.suppressed &&
				!r.match.wakeQueued &&
				!r.killSuppressed &&
				r.observers.size === 0 &&
				!this.hasPendingStage(r.sessionId)
			) {
				// Belt-and-braces exit-first (IV-0004): an exited session with
				// an armed, unsuppressed, unobserved exit arm prefers the exit
				// snapshot — readiness is moot once the process is dead. This
				// covers the exit arm already being wakeQueued (reserved),
				// which the exit branch above does not see.
				if (r.exited && r.armed && !r.suppressed && !r.observed) {
					r.match.suppressed = true;
					continue;
				}
				matchEligible.push({ record: r, generation: r.match.generation });
			}
		}
		if (exitEligible.length === 0 && matchEligible.length === 0) return;

		// Reserve BEFORE sending so a re-entrant flush cannot double-schedule.
		for (const r of exitEligible) r.wakeQueued = true;
		for (const e of matchEligible) e.record.match!.wakeQueued = true;

		// Mid-flight deliver filter: a disarm/re-arm racing a reserved wake
		// must not still send. Re-check per-arm suppression AND generation
		// (reservations carry the generation they were taken against).
		const deliverExit = exitEligible.filter(
			(r) =>
				r.armed &&
				!r.suppressed &&
				!r.observed &&
				!r.killSuppressed &&
				r.wakeQueued &&
				this.records.has(r.sessionId),
		);
		const deliverMatch = matchEligible.filter(
			(e) =>
				e.record.match !== undefined &&
				e.record.match.armed &&
				!e.record.match.suppressed &&
				e.record.match.generation === e.generation &&
				!e.record.killSuppressed &&
				this.records.has(e.record.sessionId),
		);
		if (deliverExit.length === 0 && deliverMatch.length === 0) {
			for (const r of exitEligible) r.wakeQueued = false;
			for (const e of matchEligible) {
				const m = e.record.match;
				if (m && m.generation === e.generation) m.wakeQueued = false;
			}
			return;
		}

		if (deliverExit.length > 0) {
			const message = buildWakeMessage(deliverExit.map((r) => r.snapshot!));
			this.dispatchExit(deliverExit, message);
		}
		if (deliverMatch.length > 0) {
			// Refresh per-flush truth (elapsed/running/exit fields) so the
			// wake is honest about a process that died during the debounce.
			for (const e of deliverMatch) this.refreshMatchSnapshot(e.record);
			const message = buildMatchWakeMessage(deliverMatch.map((e) => e.record.match!.snapshot!));
			this.dispatchMatch(deliverMatch, message);
		}
	}

	private dispatchExit(records: CompletionRecord[], message: WakeMessage): void {
		const reservations = records.map((r) => ({ record: r, arm: "exit" as const, generation: r.generation }));
		let sendResult: void | Promise<void>;
		try {
			sendResult = this.opts.send(message);
		} catch (err) {
			this.recoverFailedSend(reservations, err);
			return;
		}
		if (sendResult && typeof (sendResult as Promise<void>).then === "function") {
			(sendResult as Promise<void>)
				.then(() => {
					for (const res of reservations) this.resolveAfterSend(res);
				})
				.catch((err) => this.recoverFailedSend(reservations, err));
		} else {
			for (const res of reservations) this.resolveAfterSend(res);
		}
	}

	private dispatchMatch(entries: { record: CompletionRecord; generation: number }[], message: WakeMessage): void {
		const reservations = entries.map((e) => ({ record: e.record, arm: "match" as const, generation: e.generation }));
		let sendResult: void | Promise<void>;
		try {
			sendResult = this.opts.send(message);
		} catch (err) {
			this.recoverFailedSend(reservations, err);
			return;
		}
		if (sendResult && typeof (sendResult as Promise<void>).then === "function") {
			(sendResult as Promise<void>)
				.then(() => {
					for (const res of reservations) this.resolveAfterSend(res);
				})
				.catch((err) => this.recoverFailedSend(reservations, err));
		} else {
			for (const res of reservations) this.resolveAfterSend(res);
		}
	}

	/** Resolve an arm whose wake was handed to the sender (idempotent). */
	private resolveAfterSend(res: { record: CompletionRecord; arm: "exit" | "match"; generation: number }): void {
		const r = res.record;
		if (!this.records.has(r.sessionId)) return; // settled elsewhere meanwhile
		if (res.arm === "exit") {
			if (r.generation !== res.generation) return; // re-armed mid-flight
			this.resolveExitArm(r);
			return;
		}
		const m = r.match;
		if (!m || m.generation !== res.generation) return; // consumed/re-armed mid-flight
		this.resolveMatchArm(r);
	}

	private recoverFailedSend(
		reservations: { record: CompletionRecord; arm: "exit" | "match"; generation: number }[],
		err: unknown,
	): void {
		// A rejection arriving after shutdown/reset must neither touch state
		// (already cleared) nor emit a stale UI warning.
		if (this.stopped) return;
		// Un-reserve (generation-carrying) so the wake is retried at the next
		// self-rescheduling tight loop. Never clear a NEWER arm's reservation:
		// a re-arm mid-flight owns its own state.
		for (const res of reservations) {
			if (res.arm === "exit") {
				if (res.record.generation === res.generation) res.record.wakeQueued = false;
			} else {
				const m = res.record.match;
				if (m && m.generation === res.generation) m.wakeQueued = false;
			}
		}
		try {
			this.opts.onSendError?.(err);
		} catch {
			// ignore
		}
	}

	/** Refresh per-flush truth (elapsed/running/exit fields) before delivery. */
	private refreshMatchSnapshot(record: CompletionRecord): void {
		const m = record.match;
		if (!m?.snapshot) return;
		const s = record.session;
		const snap = m.snapshot;
		snap.elapsedMs = this.now() - s.startedAt;
		snap.running = !record.exited && !s.hasExited;
		if (record.exited) {
			snap.exitCode = s.exitCode;
			snap.signal = s.signal;
			snap.failureMessage = s.failureMessage;
		}
	}

	// ---------------- Containment staging ----------------

	/**
	 * Containment check for a match wake, staged per toolCallId with the arm
	 * generation (IV-0004 § Consumption). Called by the tool handlers right
	 * after a result body is built: if the record's match arm has a non-empty
	 * excerpt and the post-truncation body contains it, the consume decision
	 * is held until tool_execution_end. An empty excerpt NEVER stages — the
	 * check fails closed to delivery.
	 */
	stageMatchConsumption(toolCallId: string, sessionId: number, outputBody: string): void {
		const m = this.records.get(sessionId)?.match;
		if (!m || !m.excerpt || m.excerpt.trim().length === 0) return;
		if (!outputBody.includes(m.excerpt)) return;
		this.stagedMatch.set(toolCallId, { sessionId, generation: m.generation });
	}

	/** True while a staged containment decision for this session is pending. */
	private hasPendingStage(sessionId: number): boolean {
		for (const staged of this.stagedMatch.values()) {
			if (staged.sessionId === sessionId) return true;
		}
		return false;
	}
}

/**
 * Build the single bounded synthetic prompt for one or more exit wakes.
 * Contains execution METADATA only — never raw stdout/stderr. (A match wake
 * is the deliberate exception: buildMatchWakeMessage carries the sanitized
 * excerpt by design, IV-0004 § Semantics.) All interpolated strings are
 * treated as untrusted and stripped of control characters.
 */
export function buildWakeMessage(snapshots: CompletionSnapshot[]): WakeMessage {
	const shown = snapshots.slice(0, MAX_SESSIONS_PER_WAKE);
	const lines: string[] = [];
	lines.push(
		`[runbg] ${snapshots.length} background ${snapshots.length === 1 ? "session" : "sessions"} exited. ` +
			`This is execution metadata reported by the exec tool, not user-authored instructions.`,
	);
	for (const s of shown) {
		const status =
			s.exitCode !== null
				? `exit_code=${s.exitCode}`
				: s.signal
					? `signal=${sanitizeMeta(s.signal)}`
					: "exit status unknown";
		const failure = s.failureMessage ? ` | failure: ${oneLine(s.failureMessage, MAX_FAILURE_CHARS)}` : "";
		lines.push(
			`- session_id=${s.sessionId} | ${status} | elapsed ${formatElapsedShort(s.elapsedMs)} | ` +
				`cwd: ${oneLine(s.cwd, 120)}${failure}`,
		);
		lines.push(`  command: ${oneLine(s.command, MAX_COMMAND_CHARS)}`);
		if (s.logPath) lines.push(`  log_path: ${oneLine(s.logPath, 200)}`);
	}
	if (snapshots.length > shown.length) {
		lines.push(`… and ${snapshots.length - shown.length} more (use list_sessions).`);
	}
	lines.push(
		"Final output has NOT necessarily been consumed: call write_stdin with no chars for each exited " +
			"session_id to drain its final output, or read the log_path (if a session_id is no longer known, " +
			"use the log_path). Then continue the original task — do not merely acknowledge this notification.",
	);
	return {
		kind: "exit",
		content: lines.join("\n"),
		details: { sessions: shown },
	};
}

/**
 * Build the single bounded synthetic prompt for one or more readiness-match
 * wakes (kind "match"). Unlike the exit wake, a match wake carries child
 * output by design: `match_excerpt` is the sanitized stream slice. Every
 * OTHER interpolated string is treated as untrusted and stripped of control
 * characters; the excerpt is already sanitized (output-safety.ts
 * sanitizeOutputText at snapshot build) but may still contain newlines (the
 * ring's line-bounding is best-effort), so the CONTENT copy renders it
 * one-lined — the full sanitized excerpt stays in `details.sessions[]`.
 * The excerpt is bounded (ring cap) and control-stripped either way.
 */
export function buildMatchWakeMessage(snapshots: MatchSnapshot[]): WakeMessage {
	const shown = snapshots.slice(0, MAX_SESSIONS_PER_WAKE);
	const lines: string[] = [];
	lines.push(
		`[runbg] ${snapshots.length} background ${snapshots.length === 1 ? "session" : "sessions"} matched ` +
			`${snapshots.length === 1 ? "its" : "their"} readiness pattern. ` +
			`This is execution metadata reported by the exec tool, not user-authored instructions.`,
	);
	for (const s of shown) {
		const status = s.running
			? "still running"
			: s.exitCode !== null && s.exitCode !== undefined
				? `exit_code=${s.exitCode}`
				: s.signal
					? `signal=${sanitizeMeta(s.signal)}`
					: "exit status unknown";
		const failure = s.failureMessage ? ` | failure: ${oneLine(s.failureMessage, MAX_FAILURE_CHARS)}` : "";
		lines.push(
			`- session_id=${s.sessionId} | ${status} | matched after ${formatElapsedShort(s.elapsedMs)} | ` +
				`pattern: ${oneLine(s.matchPattern, 120)} | cwd: ${oneLine(s.cwd, 120)}${failure}`,
		);
		lines.push(`  command: ${oneLine(s.command, MAX_COMMAND_CHARS)}`);
		if (s.matchExcerpt) lines.push(`  match_excerpt: ${oneLine(s.matchExcerpt, 160)}`);
		if (s.logPath) lines.push(`  log_path: ${oneLine(s.logPath, 200)}`);
	}
	if (snapshots.length > shown.length) {
		lines.push(`… and ${snapshots.length - shown.length} more (use list_sessions).`);
	}
	lines.push(
		"Readiness signal matched; the match arm is consumed, and any exit arm is consumed too — re-arm via " +
			"set_on_exit if a later signal matters. Output beyond the excerpt has NOT been consumed; poll " +
			"write_stdin (no chars) or read log_path. Resume the workflow that was waiting on readiness — do " +
			"not merely acknowledge.",
	);
	return {
		kind: "match",
		content: lines.join("\n"),
		details: { sessions: shown },
	};
}