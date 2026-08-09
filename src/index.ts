/**
 * runbg — pi extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM:
 *   - exec_command(cmd, workdir?, shell?, tty?, yield_time_ms?, on_exit?)
 *   - write_stdin(session_id, chars?, yield_time_ms?, yield_until?)
 *   - set_on_exit(session_id, on_exit)            [disarm/re-arm wake without kill]
 *   - kill_session(session_id, signal?)          [pi-flavor; codex has no equivalent]
 *   - list_sessions()                            [pi-flavor]
 *
 * Semantics:
 *   - Every exec_command starts a long-lived session. If the process is still
 *     alive when the call's yield deadline expires, the tool returns with
 *     `session_id` in its body and the LLM can follow up with write_stdin.
 *   - `write_stdin` with empty `chars` is a pure poll; with non-empty, it also
 *     writes the bytes (including \\x03 for Ctrl-C, \\x04 for EOF).
 *   - Aborting the tool call (Esc) breaks the wait but does not kill the
 *     session; the next turn can still drive it.
 *   - Sessions are terminated on session_shutdown (codex parity).
 *   - Every byte the child writes goes to a per-session log file at
 *     /tmp/pi-runbg-<sid>-<random>.log. The LLM sees the last ~50 KiB
 *     / 2000 lines per call and the full file is available via `read`.
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";

import type { CollectResult } from "./collect.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed } from "./format-time.ts";
import { InteractionCancelled, type InteractionHandle, InteractionLocks } from "./interaction-lock.ts";
import { cleanupStaleLogs, LOG_HEARTBEAT_INTERVAL_MS, type LogStatus } from "./log-archive.ts";
import { type LongWaitOutcome, startRateLimitedStream, waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { getPtyLoadError, isPtyAvailable, killWindowsTreeSync } from "./pty.ts";
import {
	clearAllRenderTickers,
	renderExecCommandCall,
	renderKillSessionCall,
	renderKillSessionResult,
	renderListSessionsCall,
	renderListSessionsResult,
	renderProcessResult,
	renderSetOnExitCall,
	renderSetOnExitResult,
	renderWriteStdinCall,
} from "./render.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { buildShellCommand, IS_WINDOWS, resolveDefaultShell, resolveWindowsShell } from "./shell.ts";
import { nowUtcIso, parseYieldUntil } from "./time.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	type FinalizeProcessInput,
	type ProcessResultDetails,
} from "./tool-result.ts";
import { unescapeChars } from "./unescape.ts";

// ---------------- Constants (mirror codex) ----------------

const MIN_YIELD_TIME_MS = 250;
const MIN_EMPTY_YIELD_TIME_MS = 5_000;
// Diverges from codex (30 min): kept below Anthropic's 5-minute prompt-cache
// TTL so a long empty poll never outlives the cached prompt prefix. This is a
// HARD cache-friendly ceiling: the env override below may lower it but never
// raise the relative cap above 290 s — longer waits must use `yield_until`.
const DEFAULT_MAX_BACKGROUND_POLL_MS = 290_000;
export const MAX_EMPTY_POLL_ENV_VAR = "PI_RUNBG_MAX_EMPTY_POLL_MS";
/**
 * Ceiling for an ATTACHED wait: `exec_command`, and `write_stdin` WITH input.
 *
 * Diverges from codex/upstream's 30 s (divergence #9). That value arrived
 * under a "mirror codex" banner with no recorded rationale, while the line
 * above it carries an argued one. Its effect was that every job in the
 * 30 s–5 min band — test suites, builds, installs, migrations — cost two
 * calls: a short yield to obtain a session_id, then an empty poll. An empty
 * poll of the same length blocks the same turn for the same time, so the
 * asymmetry bought nothing but a wasted round trip. Now the same
 * cache-friendly bound, for the same reason: stay under the 5-minute
 * prompt-cache TTL.
 *
 * `PI_RUNBG_MAX_EMPTY_POLL_MS` deliberately does NOT lower this — it names
 * the empty-poll path, and silently shrinking attached waits for anyone who
 * had set it would be a surprising regression. Defaults are unchanged
 * (`DEFAULT_EXEC_YIELD_MS` is still 10 s), so nothing waits longer unless a
 * call explicitly asks it to.
 */
const MAX_YIELD_TIME_MS = DEFAULT_MAX_BACKGROUND_POLL_MS;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const MAX_SESSIONS = 64;
export const MAX_SESSIONS_ENV_VAR = "PI_RUNBG_MAX_SESSIONS";
/** Warn this many slots before the cap (upstream warned at 60 of 64). */
const WARNING_HEADROOM = 4;
const LRU_PROTECTED_COUNT = 8;

/**
 * Concurrent-session cap (codex's constant is preserved as the default).
 * Overridable because the cap is now a REFUSAL boundary (divergence #6), so
 * operators may want it lower — and tests need a small one. Values are
 * floored at 1; garbage falls back to the default.
 */
export function resolveMaxSessions(env: Record<string, string | undefined> = process.env): number {
	const raw = env[MAX_SESSIONS_ENV_VAR];
	if (raw === undefined || raw.trim() === "") return MAX_SESSIONS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return MAX_SESSIONS;
	return Math.max(1, Math.floor(parsed));
}
const OUTPUT_POLL_INTERVAL_MS = 250; // onUpdate cadence (relative waits only)
// PTY dimension clamps for exec_command's cols/rows (tty: true only).
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;
// Absolute (`yield_until`) waits must not run the 250 ms heartbeat for hours;
// output-driven TUI updates are rate-limited to this interval instead.
const LONG_WAIT_UPDATE_INTERVAL_MS = 30_000;
const SESSION_UI_KEY = "runbg.sessions";

/**
 * Google-compatible string enum schema (plain `type: "string"` + `enum`,
 * mirroring pi-ai's StringEnum helper) — a TypeBox literal union (anyOf/const)
 * breaks Google models.
 */
function StringEnum<T extends readonly string[]>(values: T, description: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: values as unknown as string[], description });
}

// ---------------- Helpers ----------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/** Exported for tests: pins the attached-wait ceiling (divergence #9). */
export function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

export function resolveMaxEmptyPollMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MAX_EMPTY_POLL_ENV_VAR]?.trim();
	if (!raw) return DEFAULT_MAX_BACKGROUND_POLL_MS;

	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BACKGROUND_POLL_MS;
	// The env var may LOWER the cap, but the effective cache-friendly maximum
	// never exceeds 290 s — waits beyond that must use `yield_until`.
	return clamp(Math.floor(parsed), MIN_EMPTY_YIELD_TIME_MS, DEFAULT_MAX_BACKGROUND_POLL_MS);
}

/**
 * Resolve the yield for an empty poll. Oversized values are REJECTED with an
 * actionable error (including the host UTC time so the model can compute a
 * `yield_until` deadline) instead of being silently clamped; undersized values
 * keep the historical clamp-up-to-minimum behavior.
 */
function resolveEmptyPollYield(ms: number | undefined): number {
	const cap = resolveMaxEmptyPollMs();
	if (typeof ms === "number" && Math.floor(ms) > cap) {
		throw new Error(
			`write_stdin: yield_time_ms ${Math.floor(ms)} exceeds the empty-poll cap of ${cap} ms. ` +
				`Waits longer than ${cap} ms require \`yield_until\`: omit yield_time_ms and pass an absolute ` +
				`UTC deadline such as "2026-07-21T18:30:00Z" (compute it from the current host time below). ` +
				`tool_time_utc: ${nowUtcIso()}`,
		);
	}
	const v = typeof ms === "number" && ms > 0 ? ms : DEFAULT_WRITE_STDIN_YIELD_MS;
	return clamp(Math.floor(v), MIN_EMPTY_YIELD_TIME_MS, cap);
}

/**
 * Normalize a user/LLM-supplied signal name ("TERM", "sigint", "SIGKILL") to
 * a valid NodeJS.Signals for the current platform. Throws on unknown names so
 * a typo doesn't silently no-op and then escalate to SIGKILL.
 */
function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

type ResponseShape = ProcessResultDetails;
type FinalizeInput = Omit<FinalizeProcessInput, "operation">;

function decode(bytes: Uint8Array): string {
	return textDecoder.decode(bytes);
}

function encode(str: string): Uint8Array {
	return textEncoder.encode(str);
}

// ---------------- Extension ----------------

interface ExtensionCtx {
	store: SessionStore;
	/** Agent-level wake scheduling for on_exit: "wake" (see completion.ts). */
	coordinator: CompletionCoordinator;
	ui: ExtensionContext["ui"] | undefined;
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
	warnedShellFallback: boolean;
	notifiedBashSource: boolean;
	warnedForeignTools: boolean;
	/**
	 * Sessions spawned but not yet inserted into the store (inside the
	 * early-exit grace window). session_shutdown must see these too —
	 * otherwise a shutdown racing exec_command orphans the child.
	 */
	pendingSessions: Set<ExecSession>;
	/** Set on session_shutdown; new exec_commands are rejected. */
	shuttingDown: boolean;
	/** Crash-path reaper registered on process "exit" (divergence #2). */
	processExitHandler: (() => void) | undefined;
	/** Liveness-touch timer for open session logs (divergence #3). */
	logHeartbeat: NodeJS.Timeout | undefined;
	/** True while a stale-log sweep is running, so reloads don't stack them. */
	logSweepInFlight: boolean;
	/** True only while WE removed pi's built-in bash (divergence #1 latch). */
	removedBuiltinBash: boolean;
	/** Edge-trigger latch for the near-cap warning (pi warnings are permanent). */
	warnedNearCap: boolean;
	/** Yields still allowed in the current pending-message episode (steerSignal). */
	steerYieldsLeft: number;
	/** Per-session interaction serialization (divergence #7). */
	locks: InteractionLocks;
	/** Recently reaped sessions, for graceful echoes to queued callers. */
	reaped: Map<number, ReapedSession>;
}

/** Bounded exit facts kept after a session leaves the store. */
interface ReapedSession {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	failure: string | null;
	tty: boolean;
	logPath: string;
	logStatus: LogStatus;
	cwd: string;
	command: string;
	totalBytes: number;
}

const RUNBG_TOOL_NAMES = ["exec_command", "write_stdin", "set_on_exit", "kill_session", "list_sessions"];

/** How many just-reaped sessions keep exit facts for graceful echoes (divergence #7). */
const MAX_REAPED_TOMBSTONES = 32;

/**
 * Divergence #2 (UPSTREAM.md, design §7.2): last-resort child reaping for
 * host exits that skip session_shutdown — pi's uncaughtException and
 * dead-terminal paths call process.exit() after killing only its own bash
 * children, which would orphan every runbg session. Runs inside the process
 * "exit" event, so it must be fully synchronous: SIGKILL each live session's
 * process group (both pipes and PTY children are group leaders on POSIX;
 * Windows gets a synchronous taskkill tree). Graceful shutdowns have already
 * emptied the store by the time "exit" fires, making this a no-op there.
 * A SIGKILL'd host still orphans — nothing can run then.
 */
export function killLiveSessionsSync(
	sessions: Iterable<Pick<ExecSession, "hasExited" | "pid">>,
): number {
	let killed = 0;
	for (const s of sessions) {
		if (s.hasExited || typeof s.pid !== "number") continue;
		if (IS_WINDOWS) {
			killWindowsTreeSync(s.pid);
			killed++;
			continue;
		}
		try {
			process.kill(-s.pid, "SIGKILL");
			killed++;
		} catch {
			try {
				process.kill(s.pid, "SIGKILL");
				killed++;
			} catch {
				// already gone
			}
		}
	}
	return killed;
}

/** Best-effort canonicalization; falls back to the input on any fs error. */
function tryRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** This extension's entry file and repo root, canonicalized once. */
const SELF_FILE = tryRealpath(fileURLToPath(import.meta.url));
const SELF_ROOT = dirname(dirname(SELF_FILE)); // <repo>/src/index.ts → <repo>

/**
 * Is a tool registration ours? Compares canonical paths so symlinked installs
 * (`~/.pi` symlink conventions, npm link) resolve to the same answer, and
 * accepts anything under our repo root in case pi records the package root
 * rather than the entry file.
 */
function isSelfPath(path: string | undefined): boolean {
	if (!path) return false;
	const canonical = tryRealpath(path);
	return canonical === SELF_FILE || canonical.startsWith(SELF_ROOT + sep);
}

/**
 * Winning registration paths for our five tool names, or null when the host
 * can't tell us (`getAllTools` is probed defensively: the peer floor (0.80.5)
 * and the test harnesses may not provide it). pi's registry is last-wins by
 * name, so this reflects who currently owns each name.
 */
function toolWinners(pi: ExtensionAPI): Map<string, string | undefined> | null {
	const getAllTools = (pi as { getAllTools?: () => Array<{ name: string; sourceInfo?: { path?: string } }> })
		.getAllTools;
	if (typeof getAllTools !== "function") return null;
	let infos: Array<{ name: string; sourceInfo?: { path?: string } }>;
	try {
		infos = getAllTools.call(pi);
	} catch {
		return null;
	}
	const winners = new Map<string, string | undefined>();
	for (const info of infos) {
		if (RUNBG_TOOL_NAMES.includes(info.name)) winners.set(info.name, info.sourceInfo?.path);
	}
	return winners;
}

/**
 * Whether gating may touch this tool name. True when the host can't tell us
 * who owns it (assume ours — the pre-ownership-check behavior), when the name
 * has no winning registration (activating an unknown name is a no-op), or
 * when the winning registration is ours. Never manipulate a name another
 * package's registration won — deactivating or activating *their* live tools
 * is worse than the collision itself.
 */
function ownsToolName(winners: Map<string, string | undefined> | null, name: string): boolean {
	if (winners === null || !winners.has(name)) return true;
	return isSelfPath(winners.get(name));
}

/**
 * The upstream package this fork derives from (pi-unified-exec) registers the
 * same five tool names; installing both means one registration silently
 * shadows the other and prompt guidance may drive the wrong one. Detect the
 * known collision by source path and warn once per session. Best-effort and
 * load-order-dependent: when OUR registration won, the upstream package is
 * invisible in the registry and no warning can fire. Self registrations are
 * excluded by canonical path, so a checkout of this fork living in a
 * directory named `pi-unified-exec` does not warn against itself.
 */
function warnIfUpstreamPackagePresent(ctx: ExtensionCtx, pi: ExtensionAPI): void {
	if (ctx.warnedForeignTools) return;
	const getAllTools = (pi as { getAllTools?: () => Array<{ name: string; sourceInfo?: { path?: string } }> })
		.getAllTools;
	if (typeof getAllTools !== "function") return;
	let infos: Array<{ name: string; sourceInfo?: { path?: string } }>;
	try {
		infos = getAllTools.call(pi);
	} catch {
		return;
	}
	const foreign = infos.filter(
		(t) =>
			RUNBG_TOOL_NAMES.includes(t.name) &&
			(t.sourceInfo?.path ?? "").includes("pi-unified-exec") &&
			!isSelfPath(t.sourceInfo?.path),
	);
	if (foreign.length === 0) return;
	ctx.warnedForeignTools = true;
	ctx.ui?.notify(
		`runbg: pi-unified-exec is also installed and registers ${foreign.length} of the same tool name(s) — uninstall one of the two packages.`,
		"warning",
	);
}

// ---------------- Settings (/runbg command) ----------------

/**
 * Divergence #5 (UPSTREAM.md, design §14): the session tools ship dormant.
 * `/runbg on` activates them (persisted), so the extension can stay
 * installed globally while prompts that don't know the tools never see
 * them. Settings live in `<agentDir>/runbg.json` — the file is the
 * namespace for future extension settings, so unknown keys are preserved
 * verbatim on every write.
 *
 * Known keys are normalized so a hand-edited `"true"` or `1` cannot half-enable
 * anything. Which direction is "safe" depends on the setting: the tool-removal
 * keys use a strict `=== true` (never leave pi shell-less by accident), while
 * `steerYield` uses `!== false` (never make a waiting human sit out a 290 s
 * attach by accident). Each field documents its own choice.
 */
interface RunbgSettings {
	enabled: boolean;
	/** Divergence #1: remove pi's built-in `bash` while runbg is enabled. */
	replaceBuiltinBash: boolean;
	/** Divergence #10: end an attached wait early when the human has typed. */
	steerYield: boolean;
	[key: string]: unknown;
}

const SETTINGS_FILE_NAME = "runbg.json";

export function runbgSettingsPath(): string {
	return join(getAgentDir(), SETTINGS_FILE_NAME);
}

export function readRunbgSettings(): RunbgSettings {
	try {
		const raw: unknown = JSON.parse(readFileSync(runbgSettingsPath(), "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const obj = raw as Record<string, unknown>;
			return {
				...obj,
				enabled: obj.enabled === true,
				replaceBuiltinBash: obj.replaceBuiltinBash === true,
				// Default TRUE, so normalized with `!== false` rather than the
				// `=== true` used above. The safe default differs by setting:
				// for tool removal it is "off" (never leave pi shell-less); for
				// yielding to a waiting human it is "on" (never make someone
				// wait out a 290 s attach to be heard).
				steerYield: obj.steerYield !== false,
			};
		}
	} catch {
		// missing or corrupt file → defaults
	}
	return { enabled: false, replaceBuiltinBash: false, steerYield: true };
}

/** State a setting's toast may report on, beyond the value being written. */
interface SettingNoticeInfo {
	/** The stored value already equalled the requested one. */
	already: boolean;
	/** Live sessions right now (a disable leaves them running). */
	live: number;
	/** The primary switch, after the write — settings are inert while off. */
	enabled: boolean;
	/** `--replace-builtin-bash` was passed at startup (forces the setting on). */
	flagForced: boolean;
	/**
	 * Bash removal was in force before this write and is not any more, yet
	 * `bash` is still inactive — i.e. the user has reason to expect it back
	 * and the latch could not deliver it (see BASH_NOT_RESTORED_NOTE).
	 */
	bashRestorePending: boolean;
}

/**
 * One boolean setting of `/runbg`. The table below is the single source of
 * truth for the command's grammar, its argument completions, and its status
 * line, so adding a setting is one entry rather than four parallel edits.
 *
 * Grammar for every entry: `/runbg <name>` reports, `/runbg <name> on|off`
 * writes. `enabled` additionally answers to the bare `/runbg on|off` it has
 * always had, which is why it opts out of completions — offering
 * `enabled on` next to `on` would just be the same switch twice.
 */
interface BooleanSetting {
	/** Canonical `/runbg <name> …` word. */
	name: string;
	/** Extra accepted spellings; never offered in completions. */
	aliases: readonly string[];
	/** Key in runbg.json. */
	key: "enabled" | "replaceBuiltinBash" | "steerYield";
	/** Offer `<name> on|off` in argument completions. */
	offerCompletions: boolean;
	onHint: string;
	offHint: string;
	/** Toast for a write (or a no-op write) of this setting. */
	notice: (value: boolean, info: SettingNoticeInfo) => { message: string; type: "info" | "warning" };
	/**
	 * Reported value, when the stored boolean is not the whole truth (a flag
	 * forcing it, another setting making it inert). Defaults to on/off.
	 */
	label?: (pi: ExtensionAPI, settings: RunbgSettings) => string;
}

/** What `/runbg status` and `/runbg <setting>` print for one setting. */
function settingLabel(setting: BooleanSetting, pi: ExtensionAPI, settings: RunbgSettings): string {
	if (setting.label) return setting.label(pi, settings);
	return settings[setting.key] === true ? "on" : "off";
}

/**
 * `/reload` builds a fresh ExtensionCtx, which clears the "we removed bash"
 * latch while pi's active-tool set keeps bash removed. Turning replacement
 * off after that must still not resurrect a bash we cannot prove we took
 * (divergence #1's never-resurrect rule), so say so instead of silently
 * leaving pi shell-less-looking.
 */
const BASH_NOT_RESTORED_NOTE =
	"; pi's built-in `bash` stays inactive — runbg has no record of removing it in this session (a /reload clears that record), re-enable it in pi's tool settings if you want it back";

/** The primary switch — the one bare `/runbg on|off` targets. */
const ENABLED_SETTING: BooleanSetting = {
	name: "enabled",
	aliases: [],
	key: "enabled",
	// Bare `/runbg on|off` already covers this one; offering `enabled on`
	// beside `on` would just be the same switch listed twice.
	offerCompletions: false,
	onHint: "Enable the session tools (persists across sessions)",
	offHint: "Disable the session tools (persists; running sessions keep running)",
	notice: (value, info) =>
		value
			? {
					message: info.already
						? "runbg: already enabled — tool state re-applied for this session"
						: "runbg: session tools enabled (persists across sessions) — disable with /runbg off",
					type: "info",
				}
			: {
					message:
						(info.already
							? "runbg: already disabled — tool state re-applied for this session"
							: `runbg: session tools disabled (persists)${info.live ? ` — ${info.live} live session(s) keep running; /runbg-sessions to manage them` : ""}`) +
						(info.bashRestorePending ? BASH_NOT_RESTORED_NOTE : ""),
					type: !info.already && info.live ? "warning" : "info",
				},
};

/** Divergence #1 as a runtime setting rather than a startup-only flag. */
const REPLACE_BASH_SETTING: BooleanSetting = {
	name: "replace-bash",
	// Exact flag parity, so `--replace-builtin-bash` muscle memory works.
	aliases: ["replace-builtin-bash"],
	key: "replaceBuiltinBash",
	offerCompletions: true,
	onHint: "Remove pi's built-in `bash` so the session tools are the only shell (codex parity)",
	offHint: "Keep pi's built-in `bash` alongside the session tools (default)",
	notice: (value, info) => {
		if (value) {
			const base = info.already
				? "runbg: replace-bash already on — tool state re-applied for this session"
				: "runbg: replace-bash on (persists) — pi's built-in `bash` is removed while runbg is enabled";
			// Removal is gated on `enabled` (never leave pi shell-less), so
			// saving this while runbg is dormant must not look like it took
			// effect.
			return { message: info.enabled ? base : `${base}; inert until /runbg on`, type: "info" };
		}
		const base = info.already
			? "runbg: replace-bash already off — tool state re-applied for this session"
			: "runbg: replace-bash off (persists) — pi's built-in `bash` stays available";
		// A saved `off` that the startup flag overrules would otherwise look
		// like a broken toggle: bash stays gone with no explanation.
		if (info.flagForced) {
			return {
				message: `${base}, but --replace-builtin-bash was passed at startup and forces it back on — restart pi without the flag`,
				type: "warning",
			};
		}
		return { message: base + (info.bashRestorePending ? BASH_NOT_RESTORED_NOTE : ""), type: "info" };
	},
	label: (pi, settings) => {
		const { effective, fromFlag } = replaceBuiltinBashRequest(pi, settings);
		if (!effective) return "off";
		// Both qualifiers answer "bash is/isn't gone, and why" — the two
		// questions a bare `on` would leave the reader guessing at.
		return `on${fromFlag ? " (--replace-builtin-bash)" : ""}${settings.enabled ? "" : " (inert while disabled)"}`;
	},
};

/**
 * Divergence #10: end an attached wait as soon as the human has typed.
 *
 * pi delivers a steering message only after every tool call in the batch has
 * finished, so a long attached wait makes the human wait it out to be heard —
 * with `bash` the only alternative is Esc, which kills the command. Ending the
 * wait is safe here precisely because the session owns the process: the wait
 * stops, the work does not. Modelled on oh-my-pi, which skips a pending tool
 * call outright when a user message is queued.
 */
const STEER_SETTING: BooleanSetting = {
	name: "steer",
	aliases: ["steer-yield"],
	key: "steerYield",
	offerCompletions: true,
	onHint: "End an attached wait early when you type, so long waits never delay your message (default)",
	offHint: "Keep waiting for the full yield_time_ms even while a message is queued",
	notice: (value, info) => {
		if (value) {
			return {
				message: info.already
					? "runbg: steer already on — tool state re-applied for this session"
					: "runbg: steer on (persists) — attached waits end as soon as you type; the process keeps running",
				type: "info",
			};
		}
		return {
			message: info.already
				? "runbg: steer already off — tool state re-applied for this session"
				: "runbg: steer off (persists) — a long attached wait will now hold your message until it finishes",
			type: "info",
		};
	},
};

const BOOLEAN_SETTINGS: readonly BooleanSetting[] = [ENABLED_SETTING, REPLACE_BASH_SETTING, STEER_SETTING];

function findBooleanSetting(word: string): BooleanSetting | undefined {
	return BOOLEAN_SETTINGS.find((setting) => setting.name === word || setting.aliases.includes(word));
}

/** `on|off` vocabulary accepted for every setting (and bare, for `enabled`). */
const BOOLEAN_WORDS: Record<string, boolean | undefined> = {
	on: true,
	enable: true,
	off: false,
	disable: false,
};

/**
 * Is the built-in-bash replacement (divergence #1) requested, and by what?
 *
 * The persisted setting is the primary switch (`/runbg replace-bash on`).
 * `--replace-builtin-bash` is a per-invocation FORCE-ON rather than a
 * two-way override: pi reports a boolean flag's default for "absent", so
 * `--replace-builtin-bash=false` and "not passed at all" are
 * indistinguishable here and only the true direction carries information.
 * Union semantics is the only honest reading — and the status line names
 * whichever source is active so a setting the flag overrules never looks
 * like a broken toggle.
 */
function replaceBuiltinBashRequest(
	pi: ExtensionAPI,
	settings: RunbgSettings,
): { effective: boolean; fromFlag: boolean } {
	const fromFlag = (pi.getFlag("replace-builtin-bash") ?? pi.getFlag("--replace-builtin-bash")) === true;
	return { effective: fromFlag || settings.replaceBuiltinBash === true, fromFlag };
}

function writeRunbgSettings(settings: RunbgSettings): void {
	const path = runbgSettingsPath();
	mkdirSync(dirname(path), { recursive: true });
	// Atomic replace (tmp + rename), matching the sysprompt.json convention.
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, "\t")}\n`);
	renameSync(tmp, path);
}

/**
 * Activate or deactivate the session tools we own. Registration is
 * unconditional (pi needs the definitions for renderers and resume), only
 * membership in the active set changes; `setActiveTools` is called only
 * when that membership actually changes. Names whose winning registration
 * belongs to another package are left strictly alone.
 */
function applyToolGating(pi: ExtensionAPI, enabled: boolean): void {
	const winners = toolWinners(pi);
	const owned = RUNBG_TOOL_NAMES.filter((name) => ownsToolName(winners, name));
	const active = pi.getActiveTools();
	const target = enabled
		? [...active, ...owned.filter((name) => !active.includes(name))]
		: active.filter((name) => !owned.includes(name));
	if (target.length !== active.length) {
		pi.setActiveTools(target);
	}
}

/**
 * The full session-tool policy, applied at session_start AND on every
 * `/runbg` write (unconditionally — a settings file another pi process
 * already flipped must still take effect in THIS session):
 *   1. gate our tools by the persisted enabled state;
 *   2. while enabled and bash replacement is requested (the `replace-bash`
 *      setting or `--replace-builtin-bash`), remove pi's built-in `bash`
 *      (divergence #1) and LATCH that we did;
 *   3. otherwise restore `bash` only if the latch says we removed it —
 *      never resurrect a bash the user or another extension disabled
 *      independently of us.
 * The latch is what keeps the "never leave pi shell-less" invariant true
 * across a mid-session `/runbg off` or `/runbg replace-bash off`.
 */
function applySessionToolPolicy(ctx: ExtensionCtx, pi: ExtensionAPI): void {
	const settings = readRunbgSettings();
	const enabled = settings.enabled;
	applyToolGating(pi, enabled);
	const replace = replaceBuiltinBashRequest(pi, settings).effective;
	if (enabled && replace) {
		const active = pi.getActiveTools();
		// Trade `bash` away only for a session shell that is actually active.
		// Gating above adds our tools, but it deliberately skips names another
		// package's registration won — if that package left `exec_command`
		// inactive, removing `bash` too would leave pi with no shell at all,
		// which is strictly worse than ignoring the request.
		if (active.includes("bash") && active.includes("exec_command")) {
			pi.setActiveTools(active.filter((name) => name !== "bash"));
			ctx.removedBuiltinBash = true;
		}
	} else if (ctx.removedBuiltinBash) {
		const active = pi.getActiveTools();
		if (!active.includes("bash")) {
			pi.setActiveTools([...active, "bash"]);
		}
		ctx.removedBuiltinBash = false;
	}
}

/** Host capability probe for steering (divergence #10); undefined on older pi. */
type SteerHost = { hasPendingMessages?: () => boolean } | undefined;

/** How often an attached wait checks whether the human has queued a message. */
const STEER_POLL_INTERVAL_MS = 250;
/**
 * Yields allowed per pending-message episode. Generous on purpose: it must
 * comfortably exceed any one tool batch (see steerSignal for why a tighter
 * bound is actively harmful), while still capping the follow-up case at a
 * handful of wasted early returns instead of an unbounded loop.
 */
export const STEER_YIELDS_PER_EPISODE = 8;

/**
 * Abort signal that fires once the human has input queued (divergence #10).
 *
 * Semantically a PREEMPTION, not a cancellation: the caller merges it into
 * `preemptAbort` so the wait drains what is already buffered and only then
 * stops. Cancelling instead would discard that output (see collect.ts).
 *
 * ONE YIELD PER EPISODE, PLUS WHATEVER WAS ALREADY WAITING. `hasPendingMessages()`
 * counts steering AND follow-up messages together (agent-session.js:
 * `_steeringMessages.length + _followUpMessages.length`) and an extension
 * cannot tell them apart. pi drains them at different points: steering between
 * tool batches, follow-ups only after the whole turn ends (agent-loop.js —
 * `getSteeringMessages()` inside the `while (hasMoreToolCalls)` loop,
 * `getFollowUpMessages()` after it). So an Alt+Enter follow-up leaves the flag
 * true for the REST OF THE TURN, and yielding on every wait would leave the
 * model unable to wait for anything until it stopped calling tools.
 *
 * But a plain once-per-episode latch is worse than none: pi runs a turn's tool
 * batch in PARALLEL, so if the first call consumed the episode its siblings
 * would sit out full-length waits — the batch could never end, so the very
 * message that caused the yield would never be delivered.
 *
 * Hence a small BUDGET rather than a latch. A start-time rule ("siblings that
 * were already underway may also yield") was tried and rejected: it assumes
 * batch members start within milliseconds of each other, which held on an idle
 * machine and failed under load — a sibling that started late was denied and
 * sat out a full 20 s wait, reproducing the exact stall the rule existed to
 * prevent. A counter has no timing assumption at all. Observing the flag clear
 * refills the budget.
 */
function steerSignal(
	ctx: ExtensionCtx,
	eventCtx: SteerHost,
): { signal: AbortSignal; dispose: () => void } | undefined {
	// Probed rather than assumed: `hasPendingMessages` has existed since pi
	// 0.32.0 (renamed from `hasQueuedMessages`) so every supported host has it,
	// but the rename is precisely why this stays defensive — and the test
	// harnesses construct contexts by hand. Checked before the settings read,
	// which touches disk.
	const hasPending = eventCtx?.hasPendingMessages;
	if (typeof hasPending !== "function") return undefined;
	const probe = (): boolean | undefined => {
		try {
			return hasPending.call(eventCtx) === true;
		} catch {
			return undefined; // host threw — treat as "no steering support"
		}
	};
	const already = probe();
	if (already === undefined) return undefined;
	// Episode bookkeeping happens even when the setting is off, so toggling it
	// on mid-turn cannot inherit a stale latch.
	if (!already) ctx.steerYieldsLeft = STEER_YIELDS_PER_EPISODE;
	if (!readRunbgSettings().steerYield) return undefined;
	if (ctx.steerYieldsLeft <= 0) return undefined; // episode budget spent
	const controller = new AbortController();
	const fire = () => {
		if (ctx.steerYieldsLeft > 0) ctx.steerYieldsLeft--;
		controller.abort();
	};
	if (already) {
		fire();
		return { signal: controller.signal, dispose: () => {} };
	}
	// Not yet pending: watch for it. On a live host with the setting on this is
	// the COMMON path, so the timer is unref'd and cleared on every exit.
	const timer = setInterval(() => {
		const pending = probe();
		if (pending === undefined) {
			clearInterval(timer); // host started throwing; stop watching
			return;
		}
		if (pending) {
			clearInterval(timer);
			fire();
		}
	}, STEER_POLL_INTERVAL_MS);
	timer.unref?.();
	return { signal: controller.signal, dispose: () => clearInterval(timer) };
}

type ExecCommandArgs = {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	cols?: number;
	rows?: number;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
};

type WriteStdinArgs = {
	session_id: number;
	chars?: string;
	chars_b64?: string;
	yield_time_ms?: number;
	yield_until?: string;
};

/**
 * Resolve the two mutually-exclusive input channels (`chars` and
 * `chars_b64`) to a single byte payload. Throws on conflicts or malformed
 * base64.
 */
function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasChars = typeof args.chars === "string" && args.chars.length > 0;
	const hasB64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
	if (hasChars && hasB64) {
		throw new Error("write_stdin: pass either `chars` or `chars_b64`, not both.");
	}
	if (hasB64) {
		const b64 = args.chars_b64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `chars_b64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	if (hasChars) {
		// Decode C-style escapes so the LLM can send \x03, \x1b, \n, etc.
		return encode(unescapeChars(args.chars!));
	}
	return undefined;
}

/**
 * At the session cap with nothing reapable: pending (spawned, pre-insert)
 * sessions count, so two parallel exec_commands can't both slip past the
 * pre-spawn check at cap-1.
 *
 * `excluding` is the caller's own session on the post-grace re-check: it is
 * already in `pendingSessions` and is the very session asking for the slot,
 * so counting it would refuse (and kill) every session that reaches the cap
 * exactly.
 */
function atSessionCap(ctx: ExtensionCtx, excluding?: ExecSession): boolean {
	if (ctx.store.wouldEvictLive()) return true;
	let pending = ctx.pendingSessions.size;
	if (excluding && ctx.pendingSessions.has(excluding)) pending--;
	return ctx.store.liveCount + pending >= ctx.store.maxSessions;
}

function capError(ctx: ExtensionCtx): string {
	return (
		`runbg: session cap reached (${ctx.store.maxSessions} max, ${ctx.store.liveCount} running` +
		`${ctx.pendingSessions.size ? ` + ${ctx.pendingSessions.size} starting` : ""}). ` +
		`Free a slot first: kill_session on a session you no longer need (list_sessions to review them), ` +
		`or /runbg-sessions to clean up by hand. No new session was started.`
	);
}

async function runExecCommand(
	ctx: ExtensionCtx,
	args: ExecCommandArgs,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void) | undefined,
	cwd: string,
	eventCtx: SteerHost,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "exec_command" });
	if (ctx.shuttingDown) {
		throw new Error("runbg: session is shutting down; not starting new commands.");
	}
	// Refuse at the cap BEFORE spawning (divergence #6): upstream silently
	// SIGTERM'd the LRU live session to make room, which breaks whatever
	// depended on it and (once out of the store) hides it from list_sessions,
	// kill_session and the crash reaper. Reap exited corpses first — they are
	// free room, protected-set or not.
	for (const reaped of ctx.store.reapExited()) afterSessionRemoved(ctx, reaped);
	if (atSessionCap(ctx)) {
		throw new Error(capError(ctx));
	}
	const tty = args.tty ?? false;
	if (tty && !isPtyAvailable()) {
		throw new Error(
			`tty: true requires @homebridge/node-pty-prebuilt-multiarch but it failed to load: ${getPtyLoadError() ?? "unknown"}.\n` +
				`Run:  cd .pi/extensions/runbg && npm install\n` +
				`Or call with tty: false (default).`,
		);
	}

	let shellBin = args.shell;
	if (!shellBin) {
		const resolved = resolveDefaultShell();
		shellBin = resolved.shell;
		if (resolved.fellBack && !ctx.warnedShellFallback) {
			ctx.warnedShellFallback = true;
			ctx.ui?.notify(
				"runbg: no bash found (PATH, git-derived, or known install roots); falling back to powershell. Install Git Bash or set PI_RUNBG_BASH.",
				"warning",
			);
		} else if (
			!resolved.fellBack &&
			resolved.bashSource &&
			resolved.bashSource !== "path" &&
			resolved.bashSource !== "env" &&
			!ctx.notifiedBashSource
		) {
			// bash located off PATH (derived from git.exe or a known install
			// root) — say so once, so shell selection is never mysterious.
			ctx.notifiedBashSource = true;
			ctx.ui?.notify(`runbg: using bash at ${resolved.shell} (not on PATH)`, "info");
		}
	} else if (IS_WINDOWS) {
		// Resolve bare names to the absolute PATH match, failing closed —
		// Windows' CreateProcess checks the child's cwd (the LLM-supplied
		// workdir) before PATH for bare names, so an unresolved name must
		// never reach spawn.
		shellBin = resolveWindowsShell(shellBin);
	}
	const shellCommand = buildShellCommand(shellBin, args.cmd);
	const effectiveCwd = args.workdir && args.workdir.length > 0 ? args.workdir : cwd;
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
	const wantsWake = args.on_exit === "wake";

	const id = ctx.store.allocateId();
	const session = ExecSession.spawn(id, {
		command: shellCommand.command,
		cwd: effectiveCwd,
		env: process.env,
		tty,
		cols: args.cols !== undefined ? clamp(Math.floor(args.cols), MIN_PTY_COLS, MAX_PTY_COLS) : undefined,
		rows: args.rows !== undefined ? clamp(Math.floor(args.rows), MIN_PTY_ROWS, MAX_PTY_ROWS) : undefined,
		displayCommand: args.cmd,
		shell: shellBin,
		windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
	});

	if (session.failureMessage) {
		return finalizeResponse({
			wallTimeSec: 0,
			collected: new Uint8Array(0),
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			tty,
			logPath: undefined, // spawn failed — no log file
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
		});
	}

	// Track the session from spawn to store-insertion: session_shutdown must
	// be able to terminate children that are still inside the grace window.
	ctx.pendingSessions.add(session);
	try {
		// Early-exit grace: if the process dies within 150 ms, treat it as a
		// short-lived command and never register it.
		const start = Date.now();
		const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
		await Promise.race([
			new Promise<void>((resolve) => {
				if (session.hasExited) return resolve();
				session.exited.addEventListener("abort", () => resolve(), { once: true });
			}),
			sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal),
		]);

		if (session.hasExited && Date.now() <= earlyDeadline + 20) {
			// Fully short-lived: collect everything in the buffer + any trailing
			// bytes. macOS can deliver stdout/stderr shortly after the exit event
			// for very fast commands — give the trailing drain a bounded window.
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			const wallSec = (Date.now() - start) / 1000;
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				tty,
				logPath: session.logPath,
				logStatus: session.logStatus,
				cwd: effectiveCwd,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					// Exit delivered in this very result: a requested wake is
					// satisfied directly without ever being armed.
					...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
				},
			});
		}

		// The child outlived the grace window. Re-check both refusal conditions
		// now — shutdown may have started, and two parallel exec_commands can
		// both have passed the pre-spawn check at cap-1. In either case the
		// child is ALREADY RUNNING, so refusing means killing it: returning an
		// error while leaving it alive would leak a process that no longer
		// appears in the store, the picker, or the crash reaper.
		if (ctx.shuttingDown || atSessionCap(ctx, session)) {
			const reason = ctx.shuttingDown
				? "runbg: session shut down while this command was starting; the process was terminated."
				: capError(ctx);
			ctx.coordinator.suppress(session.id);
			session.kill("SIGTERM");
			await waitForExitOrDeadline({ exited: session.exited, durationMs: 2000 });
			if (!session.hasExited && !IS_WINDOWS) {
				session.kill("SIGKILL");
				await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
			}
			if (!session.hasExited) {
				// The kill did not land (SIGKILL denied, unkillable state, taskkill
				// failure). An untracked live child is strictly worse than being one
				// over the cap: register it so list_sessions, kill_session, the
				// picker, and the crash reaper can all still reach it.
				// Same bookkeeping the normal insert path owes: this insert can
				// still prune an exited victim, which needs its tombstone, lock
				// cleanup, and coordinator eviction handling.
				const { pruned: overCapPruned } = ctx.store.insert(session);
				if (overCapPruned) {
					afterSessionRemoved(ctx, overCapPruned);
					ctx.coordinator.handleEviction(overCapPruned);
				}
				watchSessionExit(ctx, session);
				updateRunningSessionsUi(ctx);
				throw new Error(
					`${reason} WARNING: the new process (session ${session.id}, pid ${session.pid ?? "unknown"}) did not respond to SIGTERM/SIGKILL and is still running; it is registered so you can retry kill_session on it.`,
				);
			}
			throw new Error(reason);
		}

		// Live session: register it BEFORE we keep polling, so an early abort
		// doesn't let the session be GC'd / lose its place.
		const { pruned, count } = ctx.store.insert(session);
		watchSessionExit(ctx, session);
		if (pruned) {
			afterSessionRemoved(ctx, pruned);
			// Suppresses the wake for live victims; keeps a tombstone for a
			// naturally-exited wake session so its completion is not silently lost.
			ctx.coordinator.handleEviction(pruned);
			// Only ever an already-exited session (divergence #6): live ones make
			// exec_command refuse instead of being killed to free a slot.
			ctx.ui?.notify(`runbg: reaped exited session ${pruned.id} (LRU, at cap ${ctx.store.maxSessions})`, "info");
		}
		// Derived from the (configurable) cap so a lowered cap still warns.
		// EDGE-triggered: `notify(_, "warning")` is not a transient toast — pi's
		// showWarning permanently appends a Spacer plus a `Warning: …` line to
		// the transcript. Warning on every call past the threshold therefore
		// accumulated two yellow lines per exec_command for the rest of the
		// session, and a lowered PI_RUNBG_MAX_SESSIONS collapses the threshold
		// to 1, which made that every single call from the first one on.
		if (count >= capWarningThreshold(ctx)) {
			if (!ctx.warnedNearCap) {
				ctx.warnedNearCap = true;
				ctx.ui?.notify(`runbg: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
			}
		} else {
			ctx.warnedNearCap = false;
		}
		// Note: sessions stay in the store until a later tool call observes the
		// exit: write_stdin returns the final exit_code/output, and list_sessions
		// reports exited sessions one last time (with exit info) before removing
		// them. Matches codex's lazy-drain so exit information is never silently
		// lost across turns.

		// Wait until the yield deadline (or abort/exit). Stream updates meanwhile.
		// The session is in the store now, so the picker/kill path can contend:
		// take the lock preemptibly for the remainder of the initial yield.
		const deadlineMs = start + yieldTimeMs;
		let initialHandle: InteractionHandle | undefined;
		try {
			initialHandle = await ctx.locks.for(session.id).acquire({ preemptible: true, signal });
		} catch (err) {
			if (!(err instanceof InteractionCancelled)) throw err;
			// Cancelled while queued behind a kill: fall through unlocked with
			// no drain — the terminal path below reports the session state.
		}
		// Cancellation and preemption are kept SEPARATE (see collect.ts): a
		// cancelled call must not drain (its result may be discarded), while a
		// preempted call's result IS delivered and must drain first. Streaming
		// stops on either, so the UI signal is still the merged one.
		// A queued user message ends the attach the same way a competing
		// interaction does: drain, then stop. The process is untouched.
		const steer = steerSignal(ctx, eventCtx);
		const initialPreempt =
			initialHandle?.preempt && steer
				? AbortSignal.any([initialHandle.preempt, steer.signal])
				: (initialHandle?.preempt ?? steer?.signal);
		const streamAbort =
			signal && initialPreempt ? AbortSignal.any([signal, initialPreempt]) : (initialPreempt ?? signal);
		const pollStream = startStreaming(session, onUpdate, deadlineMs, streamAbort);
		// Release in `finally`: a throw here would otherwise hold this session's
		// lock forever, hanging every later interaction with it.
		let collected: CollectResult;
		try {
			collected = initialHandle
				? await session.collect({ deadlineMs, externalAbort: signal, preemptAbort: initialPreempt })
				: { bytes: new Uint8Array(0), omittedBytes: 0 };
		} finally {
			initialHandle?.release();
			pollStream.stop();
			steer?.dispose();
		}

		session.touch();
		const stillAlive = !session.hasExited;
		const wallSec = (Date.now() - start) / 1000;

		if (stillAlive) {
			// COMMIT POINT for on_exit: "wake" — we are now returning a background
			// session_id, so arm the wake. If the process exits a moment after this
			// check, the coordinator's exit listener (which fires even for
			// already-exited sessions) still delivers the completion exactly once.
			if (wantsWake) ctx.coordinator.register(session);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				tty,
				logPath: session.logPath,
				logStatus: session.logStatus,
				cwd: effectiveCwd,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					...(wantsWake ? { completion_notification: "armed" as const } : {}),
					// The attach can also be cut short by a waiting human. Without
					// this the model cannot tell that from "the yield elapsed".
					...(steer?.signal.aborted ? { wait_status: "yielded_for_user_message" as const } : {}),
					tool_time_utc: nowUtcIso(),
				},
			});
		}
		// Process exited during this call → respond with exit info, not a
		// session_id. The wake is never armed: the exit was delivered directly.
		removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			totalBytes: session.totalBytesSeen,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			tty,
			logPath: session.logPath,
			logStatus: session.logStatus,
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
			extra: {
				on_exit: args.on_exit,
				...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
			},
		});
	} finally {
		ctx.pendingSessions.delete(session);
	}
}

/**
 * Drive or poll an existing session.
 *
 * Maintainer note: this function has five `finalizeResponse` sites (already
 * exited before the write, interrupt-then-exited, interrupt-then-running,
 * poll-then-exited, poll-then-running) and they are INTENTIONALLY parallel —
 * the mechanical fields are copies of each other, while `failure`, `extra`,
 * and the coordinator calls around them differ per path because that is where
 * the wake exactly-once protocol lives. When editing one, check its siblings:
 * a divergence in the copied fields is a bug, not a variation. (One such
 * divergence silently dropped `failure_message` from the still-running path.)
 * A `sessionResultFields(session, terminal)` spread for the mechanical fields
 * only — leaving `failure`/`extra`/`collected`/`wallTimeSec`/`yieldTimeMs`
 * explicit at each site — is the agreed consolidation whenever this protocol
 * is next touched; a builder that also owns `extra` would hide that invariant
 * and is deliberately NOT the plan.
 */
async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void) | undefined,
	toolCallId: string,
	eventCtx: SteerHost,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "write_stdin" });
	// NOTE: the store lookup is deliberately repeated after the lock is held
	// (below) — a call queued behind the one that observed the exit must see
	// the reaped state, not the pre-lock snapshot.
	if (!ctx.store.get(args.session_id) && !ctx.reaped.has(args.session_id)) {
		throw new Error(`unknown session_id: ${args.session_id}`);
	}
	const writeBytes = resolveWriteInput(args);
	const isEmptyPoll = writeBytes === undefined || writeBytes.length === 0;
	const hasYieldUntil = typeof args.yield_until === "string" && args.yield_until.length > 0;

	// `yield_time_ms` (relative, cache-friendly, ≤290 s) and `yield_until`
	// (absolute UTC deadline) are never both accepted.
	if (hasYieldUntil && args.yield_time_ms !== undefined) {
		throw new Error(
			`write_stdin: pass either yield_time_ms (relative wait, max ${resolveMaxEmptyPollMs()} ms) or ` +
				`yield_until (absolute UTC deadline), not both. tool_time_utc: ${nowUtcIso()}`,
		);
	}
	// `yield_until` is only valid for an empty poll (no input bytes).
	if (hasYieldUntil && !isEmptyPoll) {
		throw new Error(
			`write_stdin: yield_until is only valid for an empty poll (no non-empty chars or chars_b64). ` +
				`Send the input with a relative yield_time_ms first, then follow up with an empty yield_until poll. ` +
				`tool_time_utc: ${nowUtcIso()}`,
		);
	}
	if (hasYieldUntil) {
		const waitSession = ctx.store.get(args.session_id);
		if (!waitSession) return reapedEcho(ctx, args.session_id, "absolute");
		return runAbsoluteWait(ctx, waitSession, args.yield_until!, signal, onUpdate, toolCallId);
	}

	const yieldTimeMs = isEmptyPoll
		? resolveEmptyPollYield(args.yield_time_ms)
		: clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);

	const start = Date.now();

	// Serialize against other interactions with this session (divergence #7).
	// Empty polls are preemptible: they must not keep parking once anything
	// else wants the session. Input writes are short and bounded, so they run
	// to completion.
	// A reaped id needs no lock (nothing to serialize against) and creating one
	// would outlive every `forget()`, so answer the tombstone before acquiring.
	if (!ctx.store.get(args.session_id) && ctx.reaped.has(args.session_id)) {
		return reapedEcho(ctx, args.session_id, isEmptyPoll ? "relative" : undefined);
	}
	let handle: InteractionHandle;
	try {
		handle = await ctx.locks.for(args.session_id).acquire({ preemptible: isEmptyPoll, signal });
	} catch (err) {
		if (err instanceof InteractionCancelled) {
			// Cancelled while queued: never write, never drain. Report the
			// session as-is so the model knows nothing was delivered.
			return cancelledWhileQueued(ctx, args.session_id, isEmptyPoll);
		}
		throw err;
	}

	// Re-read under the lock: a call queued behind the observer of the exit
	// must produce a truthful terminal echo, not "unknown session_id".
	const session = ctx.store.get(args.session_id);
	if (!session) {
		handle.release();
		return reapedEcho(ctx, args.session_id, isEmptyPoll ? "relative" : undefined);
	}
	session.touch();

	// Observation lease: while this call may return terminal status, a
	// concurrent exit is held instead of enqueuing a wake (see completion.ts).
	ctx.coordinator.beginObservation(session.id, toolCallId);
	// The drain must end on the caller's cancellation OR on preemption.
	// Streaming stops on cancellation OR preemption; the DRAIN keeps them
	// separate (see collect.ts) so a preempted poll still returns its bytes.
	// A queued user message joins the preempt side for the same reason: drain
	// first, then stop (divergence #10).
	const steer = steerSignal(ctx, eventCtx);
	const waitPreempt = steer ? AbortSignal.any([handle.preempt, steer.signal]) : handle.preempt;
	const streamAbort = signal ? AbortSignal.any([signal, waitPreempt]) : waitPreempt;
	try {
		let writeFailure: string | null = null;
		// Divergence #8 / codex parity: in a PTY the terminal line discipline
		// turns 0x03 into SIGINT for the foreground group. On pipes there is no
		// line discipline, so writing 0x03 to stdin is an inert byte almost no
		// child interprets — the model's "Ctrl-C" would silently do nothing.
		// Codex maps interrupt input to a real signal for non-tty processes;
		// mirror that for `chars` input that is EXACTLY the interrupt byte.
		//
		// Two deliberate limits keep the literal-byte capability intact:
		//   - embedded 0x03 in longer input stays a write (mixed write/signal
		//     semantics would be unpredictable);
		//   - `chars_b64` is never reinterpreted — it is the documented raw-
		//     bytes escape hatch, so a child that consumes 0x03 as protocol
		//     data can still be fed one.
		// The chars_b64 exemption tests for a NON-EMPTY string, matching
		// resolveWriteInput: an empty chars_b64 is treated as absent there, so
		// `{chars: "\x03", chars_b64: ""}` must still interrupt.
		const usedRawBytes = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
		if (!isEmptyPoll && writeBytes && !session.tty && !usedRawBytes && writeBytes.length === 1 && writeBytes[0] === 0x03) {
			session.interrupt();
			await sleep(100, signal);
			const collected = await session.collect({
				deadlineMs: start + yieldTimeMs,
				externalAbort: signal,
				preemptAbort: waitPreempt,
			});
			const wallSec = (Date.now() - start) / 1000;
			if (session.hasExited) {
				const armed = ctx.coordinator.isArmed(session.id);
				removeSession(ctx, session.id);
				ctx.coordinator.markPendingTerminal(session.id, toolCallId);
				return finalizeResponse({
					wallTimeSec: wallSec,
					collected: collected.bytes,
					omittedBytes: collected.omittedBytes,
					totalBytes: session.totalBytesSeen,
					sessionId: undefined,
					exitCode: session.exitCode,
					signal: session.signal,
					failure: session.failureMessage ?? writeFailure,
					tty: session.tty,
					logPath: session.logPath,
					logStatus: session.logStatus,
					cwd: session.cwd,
					command: session.displayCommand,
					yieldTimeMs,
					extra: terminalWaitExtra(undefined, armed),
				});
			}
			const armed = ctx.coordinator.isArmed(session.id);
			ctx.coordinator.releaseObservation(session.id, toolCallId);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: session.failureMessage,
				tty: session.tty,
				logPath: session.logPath,
				logStatus: session.logStatus,
				cwd: session.cwd,
				command: session.displayCommand,
				yieldTimeMs,
				extra: {
					tool_time_utc: nowUtcIso(),
					...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
				},
			});
		}
		if (!isEmptyPoll && writeBytes) {
			const ok = session.write(writeBytes);
			if (!ok && !session.hasExited) {
				// Still running but stdin is gone (child closed it / EPIPE earlier).
				writeFailure = "stdin write failed: the child closed its stdin; bytes were not delivered";
			}
			if (!ok && session.hasExited) {
				// Session already exited; return its final state.
				const collected = await session.collect({
					deadlineMs: Date.now() + 50,
					externalAbort: signal,
					preemptAbort: waitPreempt,
				});
				const armed = ctx.coordinator.isArmed(session.id);
				removeSession(ctx, session.id);
				ctx.coordinator.markPendingTerminal(session.id, toolCallId);
				const wallSec = (Date.now() - start) / 1000;
				return finalizeResponse({
					wallTimeSec: wallSec,
					collected: collected.bytes,
					omittedBytes: collected.omittedBytes,
					totalBytes: session.totalBytesSeen,
					sessionId: undefined,
					exitCode: session.exitCode,
					signal: session.signal,
					failure: session.failureMessage,
					tty: session.tty,
					logPath: session.logPath,
					logStatus: session.logStatus,
					cwd: session.cwd,
					command: session.displayCommand,
					yieldTimeMs,
					// This path is only reachable for input writes (never an empty
					// poll), so no wait_mode is reported — just direct delivery.
					extra: terminalWaitExtra(undefined, armed),
				});
			}
			// Give the child a small window to react before the poll.
			await sleep(100, signal);
		}

		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, streamAbort);
		// Stop in `finally`: a rejection here would otherwise leave the
		// self-rescheduling 250 ms streamer emitting partial updates into an
		// already-failed tool call until the deadline (up to 290 s of them).
		let collected: CollectResult;
		try {
			collected = await session.collect({ deadlineMs, externalAbort: signal, preemptAbort: waitPreempt });
		} finally {
			pollStream.stop();
		}
		const wallSec = (Date.now() - start) / 1000;

		if (session.hasExited) {
			const armed = ctx.coordinator.isArmed(session.id);
			removeSession(ctx, session.id);
			// Terminal result constructed: keep the lease until Pi finalizes it
			// (tool_execution_end) so an error/cancelled finalization keeps the
			// completion wake-eligible.
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage ?? writeFailure,
				tty: session.tty,
				logPath: session.logPath,
				logStatus: session.logStatus,
				cwd: session.cwd,
				command: session.displayCommand,
				yieldTimeMs,
				extra: terminalWaitExtra(isEmptyPoll ? "relative" : undefined, armed),
			});
		}
		// Still running: release the lease WITHOUT marking observed — the wake
		// (if armed) stays eligible.
		const armed = ctx.coordinator.isArmed(session.id);
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			totalBytes: session.totalBytesSeen,
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			// A LIVE session can carry a failure too: recordFailure sets it when
			// log mirroring breaks without killing the child. Report both, same
			// precedence as the exited sibling below.
			failure: session.failureMessage ?? writeFailure,
			tty: session.tty,
			logPath: session.logPath,
			logStatus: session.logStatus,
			cwd: session.cwd,
			command: session.displayCommand,
			yieldTimeMs,
			extra: {
				// Input writes take the lock non-preemptibly, so before steering
				// existed this path could never end early and needed no status.
				// It can now, and a silent early return on a write is exactly the
				// "I waited, nothing happened" trap.
				...(!isEmptyPoll && steer?.signal.aborted
					? { wait_status: "yielded_for_user_message" as const }
					: {}),
				...(isEmptyPoll
					? {
							wait_mode: "relative" as const,
							// "preempted" is distinct from "cancelled": nobody cancelled
							// this call — another interaction wanted the session, so this
							// poll returned early WITH its drained output. The model may
							// simply poll again.
							// Steering is reported distinctly from "preempted": the
							// model must not read it as "the wait completed and
							// nothing happened" and conclude the job is done.
							wait_status: signal?.aborted
								? ("cancelled" as const)
								: steer?.signal.aborted
									? ("yielded_for_user_message" as const)
									: handle.preempted
										? ("preempted" as const)
										: ("relative_deadline_reached" as const),
						}
					: {}),
				tool_time_utc: nowUtcIso(),
				...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
			},
		});
	} catch (err) {
		// Handler failure: release the lease so the wake stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		throw err;
	} finally {
		handle.release();
		steer?.dispose();
	}
}

/**
 * Result for a call that was cancelled while queued behind another
 * interaction: nothing was written, nothing drained.
 */
function cancelledWhileQueued(ctx: ExtensionCtx, sessionId: number, isEmptyPoll: boolean): ResponseShape {
	const session = ctx.store.get(sessionId);
	const reaped = ctx.reaped.get(sessionId);
	return finalizeProcessResult({
		operation: "write_stdin",
		wallTimeSec: 0,
		collected: new Uint8Array(0),
		totalBytes: session?.totalBytesSeen ?? reaped?.totalBytes,
		sessionId: session ? session.id : undefined,
		exitCode: session ? undefined : (reaped?.exitCode ?? undefined),
		signal: session ? null : (reaped?.signal ?? null),
		failure: "cancelled before this interaction ran: no input was written and no output was drained",
		tty: session?.tty ?? reaped?.tty ?? false,
		logPath: session?.logPath ?? reaped?.logPath,
		logStatus: session?.logStatus ?? reaped?.logStatus,
		cwd: session?.cwd ?? reaped?.cwd,
		command: session?.displayCommand ?? reaped?.command,
		extra: {
			...(isEmptyPoll ? { wait_mode: "relative" as const, wait_status: "cancelled" as const } : {}),
			tool_time_utc: nowUtcIso(),
		},
	});
}

/**
 * Terminal echo for a session that another call already observed and reaped
 * while this one waited for the lock. Carries the exit facts and points at
 * the log for the output that went to the concurrent call.
 */
function reapedEcho(
	ctx: ExtensionCtx,
	sessionId: number,
	waitMode: "relative" | "absolute" | undefined,
): ResponseShape {
	const reaped = ctx.reaped.get(sessionId);
	if (!reaped) {
		throw new Error(`unknown session_id: ${sessionId}`);
	}
	return finalizeProcessResult({
		operation: "write_stdin",
		wallTimeSec: 0,
		collected: new Uint8Array(0),
		totalBytes: reaped.totalBytes,
		sessionId: undefined,
		exitCode: reaped.exitCode ?? undefined,
		signal: reaped.signal,
		failure:
			reaped.failure ??
			"session already exited; its final output was delivered to a concurrent call — full stream at log_path",
		tty: reaped.tty,
		logPath: reaped.logPath,
		logStatus: reaped.logStatus,
		cwd: reaped.cwd,
		command: reaped.command,
		extra: {
			wait_mode: waitMode,
			wait_status: waitMode ? ("completed" as const) : undefined,
			completion_delivery: "direct",
			tool_time_utc: nowUtcIso(),
		},
	});
}

/** Shared "exited" extra fields for direct terminal delivery. */
function terminalWaitExtra(
	waitMode: "relative" | "absolute" | undefined,
	wakeWasArmed: boolean,
): Partial<ResponseShape> {
	return {
		wait_mode: waitMode,
		wait_status: waitMode ? ("completed" as const) : undefined,
		completion_delivery: "direct",
		tool_time_utc: nowUtcIso(),
		...(wakeWasArmed ? { on_exit: "wake" as const, on_exit_wake: "consumed" as const } : {}),
	};
}

/**
 * Absolute-deadline wait (`yield_until`): stay attached, event-driven, until
 * the process exits, the tool call is cancelled, or the UTC deadline arrives.
 *
 * Unlike relative polls this NEVER drains output while waiting (a 10-hour
 * noisy process must not accumulate unbounded history in this call); the
 * session machinery keeps its bounded head/tail buffer, rolling UI tail, and
 * complete on-disk log.
  *
 * NOT steer-aware (divergence #10 covers relative waits only). These are the
 * longest waits in the system, so it is the mode where a human is most likely
 * to be held hostage — but they are also explicitly heartbeat-free ("no 250 ms
 * heartbeat for hours" below), and adding a poller for a multi-day wait would
 * undo that. `yield_until` is already gated on the human having asked for a
 * long attached wait, so they have opted into it; Esc still cancels the wait
 * without killing the process. Revisit if that trade stops feeling right.
 */async function runAbsoluteWait(
	ctx: ExtensionCtx,
	session: ExecSession,
	yieldUntilRaw: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void) | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "write_stdin" });
	const startMs = Date.now();
	// Parse/validate the wall-clock instant and compute the remaining duration
	// ONCE; the wait below runs purely on the monotonic clock.
	const parsed = parseYieldUntil(yieldUntilRaw, startMs);
	session.touch();

	// Observation lease (see completion.ts): exit is held while we observe.
	ctx.coordinator.beginObservation(session.id, toolCallId);

	// No 250 ms heartbeat for hours: one initial update, heavily rate-limited
	// output-driven updates from a NON-destructive tail snapshot, one final.
	const streamer = onUpdate
		? startRateLimitedStream({
				outputNotify: session.outputNotify,
				minIntervalMs: LONG_WAIT_UPDATE_INTERVAL_MS,
				emit: () => onUpdate(buildStreamUpdate(session, { yield_until: parsed.normalized })),
			})
		: undefined;

	let outcome: LongWaitOutcome;
	try {
		outcome = await waitForExitOrDeadline({
			exited: session.exited,
			externalAbort: signal,
			durationMs: parsed.remainingMs,
		});
	} catch (err) {
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		streamer?.stop();
		throw err;
	}
	streamer?.stop();

	// Exit wins close races: if the session is already terminal when the result
	// is assembled, deliver the terminal result regardless of which event won.
	if (session.hasExited) outcome = "exit";
	const armed = ctx.coordinator.isArmed(session.id);

	if (outcome === "exit") {
		// Let trailing stdout/stderr and the log flush settle (outputClosed),
		// then drain the bounded retained output once. externalAbort is
		// deliberately NOT passed: exit won, and the bounded final drain must
		// complete even if cancellation fired at the same instant.
		// The park above ran lock-free (it never drains); the DRAIN takes the
		// lock, non-preemptibly and briefly (divergence #7).
		const drainHandle = await ctx.locks.for(session.id).acquire({ preemptible: false });
		const collected = await session
			.collect({ deadlineMs: Date.now() + 1000 })
			.finally(() => drainHandle.release());
		removeSession(ctx, session.id);
		ctx.coordinator.markPendingTerminal(session.id, toolCallId);
		return finalizeResponse({
			wallTimeSec: (Date.now() - startMs) / 1000,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			totalBytes: session.totalBytesSeen,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			tty: session.tty,
			logPath: session.logPath,
			logStatus: session.logStatus,
			cwd: session.cwd,
			command: session.displayCommand,
			extra: {
				...terminalWaitExtra("absolute", armed),
				yield_until: parsed.normalized,
			},
		});
	}

	if (outcome === "cancelled") {
		// Do NOT drain: if pi discards the result of a cancelled call, drained
		// output would be lost. Buffered + logged output stays with the session,
		// and the process survives. The wake (if armed) stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		return finalizeResponse({
			wallTimeSec: (Date.now() - startMs) / 1000,
			collected: new Uint8Array(0),
			totalBytes: session.totalBytesSeen,
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: session.tty,
			logPath: session.logPath,
			logStatus: session.logStatus,
			cwd: session.cwd,
			command: session.displayCommand,
			extra: {
				wait_mode: "absolute" as const,
				wait_status: "cancelled" as const,
				yield_until: parsed.normalized,
				tool_time_utc: nowUtcIso(),
				...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
			},
		});
	}

	// Absolute deadline reached while still running: one bounded drain
	// (ordinary poll semantics, lock held briefly), release the lease, keep
	// the wake armed.
	const deadlineHandle = await ctx.locks.for(session.id).acquire({ preemptible: false });
	const collected = await session
		.collect({ deadlineMs: Date.now(), externalAbort: signal })
		.finally(() => deadlineHandle.release());
	session.touch();
	ctx.coordinator.releaseObservation(session.id, toolCallId);
	return finalizeResponse({
		wallTimeSec: (Date.now() - startMs) / 1000,
		collected: collected.bytes,
		omittedBytes: collected.omittedBytes,
		totalBytes: session.totalBytesSeen,
		sessionId: session.id,
		exitCode: undefined,
		signal: null,
		failure: null,
		tty: session.tty,
		logPath: session.logPath,
		logStatus: session.logStatus,
		cwd: session.cwd,
		command: session.displayCommand,
		extra: {
			wait_mode: "absolute" as const,
			wait_status: "absolute_deadline_reached" as const,
			yield_until: parsed.normalized,
			effective_wait_ms: Date.now() - startMs,
			tool_time_utc: nowUtcIso(),
			...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
		},
	});
}

/** Result of terminating a session via kill_session or the sessions command. */
interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	collected: CollectResult;
	/** true when the process is confirmed dead; false = kill did NOT land. */
	killed: boolean;
}

/**
 * Kill a session (initial signal → 2s grace → SIGKILL escalation), drain its
 * trailing output, and remove it from the store — but ONLY on confirmed
 * exit. A kill that doesn't land (taskkill failure, access denied,
 * unkillable state) keeps the session in the store and returns
 * killed: false, so ownership of a live process is never silently dropped.
 * Shared by the kill_session tool and the /runbg-sessions command.
 */
async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
): Promise<TerminateOutcome | undefined> {
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	// Explicit kill (model tool or human slash command): suppress the wake
	// BEFORE signaling so the induced exit can never race a wake enqueue.
	ctx.coordinator.suppress(sid);
	session.kill(initial);
	// Event-driven wait (resolves the instant the exit fires): up to 2s.
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 2000 });
	let escalated = false;
	// On Windows every kill is already a force tree-kill (taskkill /T /F);
	// a "SIGKILL escalation" would spawn a byte-identical taskkill that
	// cannot behave differently, so skip it there.
	if (!session.hasExited && !IS_WINDOWS) {
		session.kill("SIGKILL");
		escalated = true;
		await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	}
	// Final drain — serialized against any live poll (divergence #7) so the
	// trailing output lands in exactly one result. The kill/escalation above
	// runs OUTSIDE the lock so a SIGTERM-ignoring child can never make the
	// kill wait behind an in-flight interaction.
	const drainHandle = await ctx.locks.for(sid).acquire({ preemptible: false });
	const collected = await session
		.collect({ deadlineMs: Date.now() + 100 })
		.finally(() => drainHandle.release());
	const killed = session.hasExited;
	if (killed) {
		ctx.coordinator.confirmKill(sid);
		removeSession(ctx, sid);
	} else {
		// The kill did NOT land — the process is still alive and still owned.
		// Restore its prior wake eligibility.
		ctx.coordinator.restoreAfterFailedKill(sid);
	}
	return { session, escalated, collected, killed };
}

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return n === 1 ? singular : pluralForm;
}

function oneLineCommand(command: string, max = 120): string {
	// sanitizeMeta strips control chars (ESC included) — \s+ alone would let
	// terminal escape sequences through to widgets and pickers.
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatRunningSessionsWidget(ctx: ExtensionCtx, sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		// `●`, not `⚠`: live sessions are this extension's NORMAL state, and the
		// widget sits `aboveEditor` — the strip users scan for problems. A
		// warning triangle parked there for the whole life of every background
		// job reads as "something is wrong" (it was reported as exactly that).
		// `⚠` is reserved for states that want attention: at/near the session
		// cap, a session that would not die, an undeliverable wake.
		`● runbg: ${sessions.length} ${plural(sessions.length, "session")} still running`,
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
			return `  #${s.id} ${formatElapsed(now - s.startedAt)}${wake} ${oneLineCommand(s.displayCommand, 72)} (${s.cwd})`;
		}),
	];
	if (sessions.length > shown.length) lines.push(`  … ${sessions.length - shown.length} more; use list_sessions`);
	lines.push("  Use list_sessions, write_stdin, set_on_exit (disarm wake), or kill_session.");
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length ? `runbg: ${sessions.length} ${plural(sessions.length, "session")} running` : undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			`runbg: ${sessions.length} ${plural(sessions.length, "session")} still running after /tree.`,
			"warning",
		);
	}

	// Runtime-guarded for older hosts, but typed (pi >= 0.80.5 ships setWidget).
	if (typeof ui.setWidget !== "function") return;

	if (sessions.length === 0) {
		if (ctx.widgetVisible) {
			ui.setWidget(SESSION_UI_KEY, undefined);
			ctx.widgetVisible = false;
		}
		return;
	}

	if (opts.showWidget || ctx.widgetVisible) {
		ui.setWidget(SESSION_UI_KEY, formatRunningSessionsWidget(ctx, sessions), { placement: "aboveEditor" });
		ctx.widgetVisible = true;
	}
}

function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		// Preserve lazy-drain semantics: an exited session stays in the store until
		// write_stdin/list_sessions/kill_session observes it. The UI only reflects
		// currently running processes.
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	const removed = ctx.store.remove(id);
	if (removed) afterSessionRemoved(ctx, removed);
	else unwatchSessionExit(ctx, id);
	return removed;
}

/**
 * Bookkeeping every per-session removal path owes, whoever performed the
 * store delete. `session_shutdown` is the deliberate exception: it tears the
 * whole instance down with `terminateAll()` and then clears `locks`/`reaped`
 * wholesale, so per-session tombstones there would be created and discarded in
 * the same breath.
 *
 * drop the UI exit watcher, leave an exit tombstone so a call queued behind
 * the observer can still echo the truth, and forget the interaction lock.
 * (`unwatchSessionExit` only detaches OUR ui watcher — the completion
 * coordinator's own exit registration is deliberately untouched, so an
 * unobserved exit can still deliver its wake.)
 */
function afterSessionRemoved(ctx: ExtensionCtx, session: ExecSession): void {
	unwatchSessionExit(ctx, session.id);
	rememberReaped(ctx, session);
	ctx.locks.forget(session.id);
	// Re-arm the near-cap warning once the pressure is actually gone, so a
	// second approach to the cap still warns once (see the notify site).
	if (ctx.store.size < capWarningThreshold(ctx)) ctx.warnedNearCap = false;
}

/** Session count at which exec_command warns once that the cap is near. */
function capWarningThreshold(ctx: ExtensionCtx): number {
	return Math.max(1, ctx.store.maxSessions - WARNING_HEADROOM);
}

/**
 * Remember a just-reaped session so a call that was queued behind the one
 * that observed the exit gets a truthful `[exited]` echo instead of a thrown
 * "unknown session_id" (which pi renders as a failed tool call and invites
 * retry loops). Bounded ring; cleared on session_start.
 */
function rememberReaped(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.reaped.set(session.id, {
		exitCode: session.exitCode,
		signal: session.signal,
		failure: session.failureMessage,
		tty: session.tty,
		logPath: session.logPath,
		logStatus: session.logStatus,
		cwd: session.cwd,
		command: session.displayCommand,
		totalBytes: session.totalBytesSeen,
	});
	while (ctx.reaped.size > MAX_REAPED_TOMBSTONES) {
		const oldest = ctx.reaped.keys().next();
		if (oldest.done) break;
		ctx.reaped.delete(oldest.value);
	}
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

/** Shared streaming-update payload (relative polls and absolute waits). */
function buildStreamUpdate(
	session: ExecSession,
	extra?: Record<string, unknown>,
): { content: [{ type: "text"; text: string }]; details: unknown } {
	const tailText = sanitizeOutputText(decode(session.snapshotStreamTail()));
	return {
		content: [{ type: "text", text: tailText }],
		details: {
			session_id: session.id,
			pid: session.pid,
			running: !session.hasExited,
			total_bytes: session.totalBytesSeen,
			tty: session.tty,
			command: session.displayCommand,
			cwd: session.cwd,
			log_path: session.logPath,
			...(session.logStatus !== "complete" ? { log_status: session.logStatus } : {}),
			// Populate `output` so renderResult has a single source regardless
			// of streaming vs final state.
			output: tailText,
			...extra,
		},
	};
}

function startStreaming(
	session: ExecSession,
	onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void) | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
): { stop: () => void } {
	if (!onUpdate) return { stop: () => {} };
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	// Emit only when the child actually produced something since the last tick.
	// An unconditional 250 ms cadence sent a byte-identical update ~1160 times
	// over a full 290 s poll, and every one costs a snapshot + sanitize here
	// plus a full renderCall/renderResult/TUI diff in the host (measured
	// ~164 µs + ~425-710 µs each). Elapsed time in the row is refreshed by the
	// renderer's own 1 Hz ticker, so a quiet tick has nothing to say.
	// `-1` guarantees the first tick emits, preserving the "session started"
	// update even for a child that never writes.
	let lastBytesSeen = -1;
	const tick = () => {
		if (stopped) return;
		const seen = session.totalBytesSeen;
		if (seen !== lastBytesSeen) {
			lastBytesSeen = seen;
			try {
				onUpdate(buildStreamUpdate(session));
			} catch {
				// ignore transient errors
			}
		}
		if (stopped) return;
		if (Date.now() >= deadlineMs) return;
		if (externalAbort?.aborted) return;
		timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	};
	timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

export default function (pi: ExtensionAPI) {
	const coordinator = new CompletionCoordinator({
		send: (message) => {
			// If pi is idle this starts a model turn; if a run is active it is
			// queued as a follow-up — never steering/interrupting the current turn.
			pi.sendMessage(
				{
					customType: "runbg-completed",
					content: message.content,
					display: true,
					details: message.details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		onSendError: (err) => {
			ctx.ui?.notify(
				`runbg: failed to deliver completion notification: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		},
	});
	const ctx: ExtensionCtx = {
		coordinator,
		// Eviction UI (status clear + warning) is handled at the insert site;
		// no onEvict callback needed.
		store: new SessionStore({ maxSessions: resolveMaxSessions(), lruProtectedCount: LRU_PROTECTED_COUNT }),
		ui: undefined,
		widgetVisible: false,
		exitUnsubscribers: new Map(),
		warnedShellFallback: false,
		notifiedBashSource: false,
		warnedForeignTools: false,
		pendingSessions: new Set(),
		shuttingDown: false,
		processExitHandler: undefined,
		logHeartbeat: undefined,
		logSweepInFlight: false,
		removedBuiltinBash: false,
		warnedNearCap: false,
		steerYieldsLeft: STEER_YIELDS_PER_EPISODE,
		locks: new InteractionLocks(),
		reaped: new Map(),
	};

	// Divergence #1 from upstream (see UPSTREAM.md): upstream removes pi's
	// built-in `bash` unless --keep-builtin-bash is passed; runbg keeps it
	// unless asked. System-prompt templates that never mention the session
	// tools — and extensions that guard `bash` calls — need a working `bash`,
	// so exec_command stays additive by default.
	//
	// `/runbg replace-bash on|off` is the primary switch (persisted, toggleable
	// mid-session). This flag stays as a force-on for one invocation, so a
	// codex-parity wrapper script needs no state in the agent dir; see
	// replaceBuiltinBashRequest for why it can only force ON.
	pi.registerFlag("replace-builtin-bash", {
		description:
			"Force-remove pi's built-in `bash` tool for this run so exec_command/write_stdin are the only shell (upstream pi-unified-exec's default). Persistent equivalent: /runbg replace-bash on. By default runbg keeps bash.",
		type: "boolean",
		default: false,
	});

	// Observation finalization: "observed" is committed at pi's finalized
	// tool-result event, not merely when the handler returns — see completion.ts.
	pi.on("tool_execution_end", async (event) => {
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true);
	});
	// agent_settled (pi >= 0.80.5, our peer minimum) is a safe point to flush
	// pending completions (e.g. retry a failed send). Wrapped so an older
	// runtime that rejects unknown events degrades gracefully — wakes still
	// deliver via the debounce timer and tool boundaries.
	try {
		pi.on("agent_settled", async () => {
			ctx.coordinator.flushPending();
		});
	} catch {
		// pi < 0.80.5: no agent_settled event — non-fatal.
	}

	pi.on("session_start", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		ctx.shuttingDown = false; // reload/new/resume re-arms the extension
		ctx.coordinator.reset(); // never resurrect wakes from a previous session
		ctx.locks.clear();
		ctx.reaped.clear(); // session ids restart; stale tombstones must not echo
		updateRunningSessionsUi(ctx);
		// Tool gating (divergence #5) + built-in-bash policy (divergence #1):
		// dormant unless /runbg enabled; bash removed only while enabled AND
		// --replace-builtin-bash, restored only if we removed it (latch).
		applySessionToolPolicy(ctx, pi);
		warnIfUpstreamPackagePresent(ctx, pi);
		// Stale-log cleanup (divergence #3): age-based and best-effort, so a
		// concurrent pi process's fresh logs are never touched. Fire and
		// forget — session start must not block on tmpdir scanning — but never
		// stack sweeps: each one is a readdir plus an lstat per matching file,
		// and reloads can fire session_start repeatedly in quick succession.
		if (!ctx.logSweepInFlight) {
			ctx.logSweepInFlight = true;
			void cleanupStaleLogs().finally(() => {
				ctx.logSweepInFlight = false;
			});
		}
		// Crash-path reaper (divergence #2): removed again on session_shutdown,
		// so graceful teardowns never stack listeners across /reload cycles and
		// the handler can only ever fire while this instance owns sessions.
		if (!ctx.processExitHandler) {
			ctx.processExitHandler = () => {
				killLiveSessionsSync([...ctx.store.values(), ...ctx.pendingSessions]);
			};
			process.on("exit", ctx.processExitHandler);
		}
		// Log liveness heartbeat (divergence #3): the TTL sweep is mtime-based,
		// so a quiet-but-live session (dev server idle for days) would look
		// stale to another pi process. Unref'd: never holds the process open.
		if (!ctx.logHeartbeat) {
			ctx.logHeartbeat = setInterval(() => {
				for (const session of [...ctx.store.values(), ...ctx.pendingSessions]) {
					if (!session.hasExited) session.touchLog();
				}
			}, LOG_HEARTBEAT_INTERVAL_MS);
			ctx.logHeartbeat.unref?.();
		}
		if (!isPtyAvailable() && eventCtx.hasUI) {
			// Non-fatal: pipes mode still works.
			eventCtx.ui.notify(
				"runbg: node-pty not available; tty: true will fail. Pipes (tty: false) still work.",
				"info",
			);
		}
	});

	pi.on("session_tree", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
	});

	pi.on("session_shutdown", async () => {
		// Reject new sessions from here on and terminate everything we own —
		// including sessions still inside exec_command's early-exit grace
		// window (spawned but not yet inserted into the store).
		ctx.shuttingDown = true;
		// Cancel wake timers/listeners first: no stale prompt may ever be
		// injected into a new or closed session.
		ctx.coordinator.shutdown();
		const drained = ctx.store.terminateAll();
		for (const s of ctx.pendingSessions) {
			if (!s.hasExited) {
				s.terminate();
				drained.push(s);
			}
		}
		clearSessionExitWatchers(ctx);
		updateRunningSessionsUi(ctx);
		// Children run detached (own process groups), so anything that ignores
		// SIGTERM would outlive pi as an orphan. Give them a short grace, then
		// SIGKILL survivors and wait briefly for confirmation. On Windows the
		// initial kill is already a force tree-kill and a second taskkill is
		// byte-identical, so skip the escalation there (the grace wait above
		// still confirms exits). Event-driven per session: each wait resolves
		// the instant that session's exit fires.
		await Promise.all(drained.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 1000 })));
		if (!IS_WINDOWS) {
			const survivors = drained.filter((s) => !s.hasExited);
			for (const s of survivors) s.kill("SIGKILL");
			await Promise.all(survivors.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 500 })));
		}
		if (drained.length && ctx.ui) {
			const leftover = drained.filter((s) => !s.hasExited).length;
			ctx.ui.notify(
				`runbg: terminated ${drained.length - leftover} live session(s) on shutdown` +
					(leftover ? `; ${leftover} did not confirm exit` : ""),
				 leftover ? "warning" : "info",
			);
		}
		// Graceful teardown complete — the crash-path reaper has nothing left
		// to cover, and a /reload's fresh instance will install its own.
		if (ctx.processExitHandler) {
			process.removeListener("exit", ctx.processExitHandler);
			ctx.processExitHandler = undefined;
		}
		if (ctx.logHeartbeat) {
			clearInterval(ctx.logHeartbeat);
			ctx.logHeartbeat = undefined;
		}
		// Renderer tickers: pi has no component-disposal callback, so a partial
		// render whose component pi dropped would otherwise keep invalidating
		// forever (see render.ts).
		clearAllRenderTickers();
		// Hygiene: session_start clears these, so shutdown should too — ids are
		// never reused, and a fresh instance builds its own.
		ctx.locks.clear();
		ctx.reaped.clear();
	});

	// Configuration surface for the extension: `/runbg <setting> on|off`, with
	// bare `/runbg on|off` kept as shorthand for the primary switch.
	// BOOLEAN_SETTINGS is the grammar — every entry there is automatically
	// readable, writable, completable and reported by `status`, so a future
	// setting is one table entry rather than four parallel edits here.
	const USAGE = `/runbg on|off | ${BOOLEAN_SETTINGS.filter((s) => s.offerCompletions)
		.map((s) => `${s.name} on|off`)
		.join(" | ")} | status`;
	pi.registerCommand("runbg", {
		description:
			`Configure runbg — ${USAGE}. on|off enables/disables the session tools (persisted; default off); replace-bash removes/keeps pi's built-in bash; steer ends an attached wait as soon as you type; status shows the current state.`,
		getArgumentCompletions: (prefix: string) => {
			// pi replaces the ENTIRE argument text with the chosen `value`
			// (CombinedAutocompleteProvider.applyCompletion substitutes the
			// prefix it handed us), so every value must be a complete argument
			// string: returning a bare "on" for the prefix "replace-bash "
			// would rewrite the line to "/runbg on".
			const needle = prefix.trim().toLowerCase();
			const items = [
				{ value: "on", label: "on", description: "Enable the session tools (persists across sessions)" },
				{ value: "off", label: "off", description: "Disable the session tools (persists; running sessions keep running)" },
				{ value: "status", label: "status", description: "Show the current state" },
				...BOOLEAN_SETTINGS.filter((setting) => setting.offerCompletions).flatMap((setting) => [
					{ value: `${setting.name} on`, label: `${setting.name} on`, description: setting.onHint },
					{ value: `${setting.name} off`, label: `${setting.name} off`, description: setting.offHint },
				]),
			].filter((item) => item.value.startsWith(needle));
			return items.length ? items : null;
		},
		handler: async (args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			const notify = (message: string, type: "info" | "warning" = "info") => cmdCtx.ui?.notify(message, type);
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const settings = readRunbgSettings();
			const live = runningSessions(ctx).length;
			const before = replaceBuiltinBashRequest(pi, settings);
			// "Bash removal was in force" — the only state from which a user can
			// reasonably expect `bash` back when they turn replacement off.
			const wasReplacing = settings.enabled && before.effective;

			/** Persist one setting, re-apply the tool policy, report honestly. */
			const write = (setting: BooleanSetting, value: boolean): void => {
				const already = settings[setting.key] === value;
				if (!already) {
					const next: RunbgSettings = { ...settings };
					next[setting.key] = value;
					writeRunbgSettings(next);
				}
				// Unconditionally: another pi process may have flipped the file
				// while this session's tools are still in the old state.
				applySessionToolPolicy(ctx, pi);
				const after = readRunbgSettings();
				const replaceAfter = replaceBuiltinBashRequest(pi, after);
				const { message, type } = setting.notice(value, {
					already,
					live,
					enabled: after.enabled,
					flagForced: replaceAfter.fromFlag,
					// Active tools are sampled AFTER the policy ran, so this
					// reflects what the latch actually managed to restore.
					bashRestorePending:
						wasReplacing &&
						!(after.enabled && replaceAfter.effective) &&
						!pi.getActiveTools().includes("bash"),
				});
				notify(message, type);
			};

			const [first, second] = tokens;
			if (tokens.length === 0 || first === "status") {
				// The primary switch is the leading word; every other setting in
				// the table reports itself, so a new one needs no edit here.
				const others = BOOLEAN_SETTINGS.filter((s) => s !== ENABLED_SETTING)
					.map((s) => `${s.name}: ${settingLabel(s, pi, settings)}`)
					.join(", ");
				notify(
					`runbg: ${settings.enabled ? "enabled" : "disabled"}${live ? ` — ${live} live session(s)` : ""}` +
						(others ? ` — ${others}` : "") +
						` — ${USAGE} (settings: ${runbgSettingsPath()})`,
				);
				return;
			}
			// Bare `on|off` is the primary switch's shorthand.
			if (tokens.length === 1 && BOOLEAN_WORDS[first] !== undefined) {
				write(ENABLED_SETTING, BOOLEAN_WORDS[first] === true);
				return;
			}
			const setting = findBooleanSetting(first);
			if (!setting) {
				notify(`runbg: unknown setting "${tokens.join(" ")}" — usage: ${USAGE}`, "warning");
				return;
			}
			if (tokens.length === 1) {
				notify(`runbg: ${setting.name} is ${settingLabel(setting, pi, settings)} — /runbg ${setting.name} on|off to change`);
				return;
			}
			const value = BOOLEAN_WORDS[second];
			if (value === undefined || tokens.length > 2) {
				notify(`runbg: ${setting.name} takes on|off, not "${tokens.slice(1).join(" ")}"`, "warning");
				return;
			}
			write(setting, value);
		},
	});

	// Human-facing escape hatch: inspect and kill live sessions without going
	// through the model.
	pi.registerCommand("runbg-sessions", {
		description: "List live runbg sessions and optionally kill one (or all)",
		handler: async (_args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			// Reap silently-exited sessions first so the picker only shows live ones.
			for (const s of ctx.store.values()) {
				if (s.hasExited) removeSession(ctx, s.id);
			}
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify("runbg: no live sessions", "info");
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => {
				const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
				return `#${s.id} ${formatElapsed(now - s.startedAt)}${wake} ${oneLineCommand(s.displayCommand, 60)}`;
			});
			const KILL_ALL = `Kill all ${sessions.length} ${plural(sessions.length, "session")}`;
			const choice = await cmdCtx.ui.select(
				`runbg: ${sessions.length} live ${plural(sessions.length, "session")} — select to kill (Esc to cancel)`,
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM");
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(
				`runbg: killed ${killed} ${plural(killed, "session")}` +
					(failed ? `; ${failed} did not confirm exit (still listed)` : ""),
				failed ? "warning" : "info",
			);
		},
	});

	// ---------------- Tools ----------------

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description:
			'Run a command in a persistent session. Returns `session_id` if still running (drive with write_stdin) or `exit_code` if it finished within yield_time_ms. on_exit defaults to "none". Pass on_exit: "wake" for a long job that terminates, to have its result delivered on completion instead of blocking a turn; never for processes that do not exit on their own. Use set_on_exit to disarm or re-arm a running session.',
		promptSnippet: "Run a shell command; long-running ones yield a session_id",
		promptGuidelines: [
			"Prefer dedicated file tools when available (read/grep/find/ls). Otherwise use exec_command with fast shell tools: rg for content search, fd if available (or find) for file names, and ls for directories.",
			"When pi\'s built-in `bash` is also available, still route anything that MIGHT run long through exec_command — builds, test suites, installs, migrations, deploys, anything network-bound. Only exec_command yields a session, so only it can hand control back mid-wait when the human types; a bash call of the same length makes them wait it out or press Esc, which kills the command outright. Reach for bash only for commands that are certainly fast.",
			`Choose how you will wait BEFORE starting, from the job's expected duration. Expected to finish within ~5 minutes: ONE exec_command whose yield_time_ms covers it (~500ms for quick one-shots, ${DEFAULT_EXEC_YIELD_MS} ms default, up to ${MAX_YIELD_TIME_MS} ms) — do not split this into a short yield plus a poll, which costs an extra turn for the same wait. Longer than that, or unknown: start it, then set on_exit: "wake" and END THE TURN — the result is delivered to you automatically when it finishes, which beats holding the turn or hoping someone checks back. Interactive processes (REPLs, ssh, sudo) always return a session_id you then drive with write_stdin. Never end a turn with a live session you have not named to the human, and kill_session anything you have stopped caring about — abandoned sessions still count toward the session cap.`,
			"Do not background inside cmd (`&`, `nohup`, `disown`) — the session IS the background: run the long process as cmd itself and poll it with write_stdin. A backgrounded child is not tracked by its session; if it inherits the session's output pipe, the session keeps reporting [still running] long after your cmd finished, and kill_session ends it anyway (SIGTERM goes to the whole process group, which nohup does not survive). Use setsid only when the human explicitly wants a process to outlive pi.",
			"Compose multi-step waits in the shell, not across tool calls — the shell is your scripting layer, so anything needing no model judgment between steps belongs in one command. `until curl -sf URL; do sleep 2; done && npm test 2>&1 | tail -40` is a single call; polling, checking, then running is five or six. Prefer waiting on a CONDITION over sleeping a fixed duration: it returns the instant the condition holds instead of after a guess, and a bare sleep whose only purpose is to pass time gives you a session with nothing to observe.",
			"Filter output at the source (tail, grep, wc, --quiet flags) rather than pulling everything into context. Results are bounded by a head/tail buffer, so an unfiltered 900-line run silently loses its MIDDLE — usually where the failure is. Truncation is a safety net, not a filtering strategy. log_path always holds the complete stream: grep or read that when the bounded result is not enough, instead of re-running the job.",
			`An empty write_stdin poll (no chars) waits for progress and accepts yield_time_ms up to 290 seconds (${DEFAULT_MAX_BACKGROUND_POLL_MS} ms, cache-friendly). Each poll returns only output that is NEW since the last one, never bytes you have already seen, so a poll's cost is the TURN rather than the payload — which is why one long poll beats several short ones. Do NOT use yield_until just to bypass the 290s cap — only when the human explicitly asks for a long attached wait or a wall-clock deadline (finite non-interactive jobs only).`,
			'on_exit defaults to "none". Arm on_exit: "wake" for any long job that TERMINATES and that you would otherwise wait on — it delivers the result to you on completion, so you can end the turn instead of blocking it. NEVER arm it for something that does not exit on its own (dev servers, watchers, tail -f): it would simply never fire, and a wake left armed on abandoned work interrupts later. If you armed it by mistake, call set_on_exit(session_id, on_exit: "none") promptly (does not kill the process). kill_session both kills and suppresses the wake. Combining wake with an observing write_stdin is safe: direct completion consumes the wake.',
		],
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			shell: Type.Optional(
				Type.String({
					description:
						"Shell binary. Defaults to bash (on Windows: bash if on PATH, else powershell). cmd and powershell/pwsh get shell-appropriate flags.",
				}),
			),
			tty: Type.Optional(Type.Boolean({ description: "Allocate a PTY. Default false (plain pipes)." })),
			cols: Type.Optional(
				Type.Number({
					description: `PTY width in columns (tty: true only; ignored for pipes). Default 120, clamped to [${MIN_PTY_COLS}, ${MAX_PTY_COLS}].`,
				}),
			),
			rows: Type.Optional(
				Type.Number({
					description: `PTY height in rows (tty: true only; ignored for pipes). Default 30, clamped to [${MIN_PTY_ROWS}, ${MAX_PTY_ROWS}].`,
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `How long (ms) this call stays attached waiting for output before yielding — an attachment window, not the command's lifetime or completion timeout. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
				}),
			),
			on_exit: Type.Optional(
				StringEnum(
					["none", "wake"] as const,
					'"none" (default): no auto-resume; poll with write_stdin. "wake": ONE follow-up notification on unobserved exit that resumes the agent — only when the human explicitly wants auto-resume. Change later via set_on_exit. A completion observed directly by a tool result consumes the wake.',
				),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runExecCommand(ctx, params as ExecCommandArgs, signal, onUpdate as any, eventCtx.cwd, eventCtx);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
			};
		},
		renderCall: renderExecCommandCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Write bytes to a running session. Omit both chars and chars_b64 to poll without writing. Use `chars` for text with C-style escapes (e.g. \\x1b ESC, \\n newline); use `chars_b64` for raw binary. Interrupt: send chars \\x03 alone — in a tty session the terminal turns it into Ctrl-C, and in a pipes session (tty: false) runbg delivers a real SIGINT to the process group. chars_b64 is always literal bytes and never an interrupt, so use chars for Ctrl-C. For empty polls, wait with yield_time_ms (relative, max 290 s) or yield_until (absolute UTC deadline — only when the human explicitly asks for a long attached wait).",
		promptSnippet: "Send input to or poll a running session",
		promptGuidelines: [
			`Use yield_time_ms for interaction or an empty progress poll of at most 290 seconds (${DEFAULT_MAX_BACKGROUND_POLL_MS} ms, cache-friendly). Larger values are rejected, not clamped. Repeat polls as needed instead of bypassing the cap.`,
			'Use yield_until ONLY when the human explicitly asks for a long attached wait or an explicit UTC deadline. Omit yield_time_ms and pass a future UTC timestamp ending in "Z" (compute it from tool_time_utc in tool results). Finite non-interactive sessions only. Do NOT use yield_until just to bypass the 290s cap. The call returns immediately when the process exits.',
			"NEVER use yield_until for REPLs, sudo, ssh, password prompts, dev servers, file watchers, debuggers, or any indefinite/interactive session — it is only for finite commands that will exit on their own.",
			'on_exit wake is set via exec_command or set_on_exit, not write_stdin. Observing an exit here consumes an armed wake (direct result). To disarm wake without killing, call set_on_exit(session_id, on_exit: "none").',
			"In tty sessions, submit lines with \\r (the Enter key) rather than \\n: POSIX terminals accept both, but Windows console programs only execute input on \\r.",
			"To interrupt a running command, send chars \\x03 on its own (never via chars_b64, which is always literal bytes): in a pipes session that is delivered as a real SIGINT to the process group, and in a tty session the terminal turns it into Ctrl-C.",
			'Poll one session at a time. Concurrent calls against the same session_id are serialized, so a progress poll may return early with wait_status "preempted" (and possibly no new output) when another call wants that session — that is not an error; poll again if you still need output.',
			'wait_status "yielded_for_user_message" means the human has input queued, so the wait was cut short to hand control back. It is NOT a completed wait and NOT evidence the command finished or stalled — the process is still running untouched. Do not report the job as done, do not draw conclusions from the partial output, do not treat it as a failed verification. If their message is delivered to you, answer it first, then poll the same session_id again if you still need the result. If NO message appears, they queued it for delivery once you stop working — so wrap up and end the turn rather than starting another long wait; that is what delivers it.',
			"For very noisy jobs, rely on the log_path and final/truncated output instead of repeatedly polling.",
		],
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			chars: Type.Optional(
				Type.String({
					description:
						"Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_b64.",
				}),
			),
			chars_b64: Type.Optional(
				Type.String({
					description: "Raw bytes (base64) to write. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `How long (ms) this call stays attached before yielding — an attachment/progress window, not the process's lifetime or completion timeout. Default ${DEFAULT_WRITE_STDIN_YIELD_MS}; for empty input clamped to [${MIN_EMPTY_YIELD_TIME_MS}, ${resolveMaxEmptyPollMs()}]; larger empty-poll values are rejected (use yield_until only if the human explicitly asked for a long wait). Mutually exclusive with yield_until.`,
				}),
			),
			yield_until: Type.Optional(
				Type.String({
					description:
						'Absolute UTC deadline to stay attached to an EMPTY poll, as strict RFC 3339 UTC ("2026-07-21T18:30:00Z" or with .mmm; uppercase Z, full date+time with seconds; no offsets). Only when the human explicitly asks for a long attached wait. Returns immediately when the process exits. No default max horizon. Mutually exclusive with yield_time_ms and with input bytes.',
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runWriteStdin(ctx, params as WriteStdinArgs, signal, onUpdate as any, toolCallId, eventCtx);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
			};
		},
		renderCall: renderWriteStdinCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "set_on_exit",
		label: "set_on_exit",
		description:
			'Change on_exit policy for a session without killing it. on_exit: "none" disarms a pending wake (including coordinator tombstones after eviction). on_exit: "wake" arms auto-resume if the process is still running. Cannot recall a follow-up already queued to the agent. kill_session both kills and suppresses.',
		promptSnippet: "Disarm or re-arm on_exit wake for a session",
		promptGuidelines: [
			'Default on_exit is "none". If you set "wake" and no longer need auto-resume (wrong command, user moved on, abandoned approach), call set_on_exit with "none" promptly — do not leave stale wakes armed.',
			"This does not stop the process. Use kill_session to terminate.",
			"Prefer arming wake only when the human explicitly asked for auto-resume.",
			"Disarm cannot recall a completion follow-up that was already delivered to pi.",
		],
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			on_exit: StringEnum(
				["none", "wake"] as const,
				'"none": disarm wake (process keeps running). "wake": arm auto-resume if still running.',
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const { session_id: sid, on_exit: policy } = params as { session_id: number; on_exit: OnExitPolicy };
			const session = ctx.store.get(sid);
			if (policy === "wake" && !session) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
				};
			}
			const status = ctx.coordinator.setOnExit(sid, policy, session);
			// unknown id: no store session and nothing to disarm
			if (!session && status === "already_none") {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
				};
			}
			const running = session ? !session.hasExited : false;
			const armed = ctx.coordinator.isArmed(sid);
			const text =
				`set_on_exit session_id=${sid} on_exit=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no store session; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed");
			return {
				content: [{ type: "text", text }],
				details: {
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
					command: session?.displayCommand,
					log_path: session?.logPath,
					tool_time_utc: nowUtcIso(),
				},
			};
		},
		renderCall: renderSetOnExitCall,
		renderResult: renderSetOnExitResult,
	});

	pi.registerTool({
		name: "kill_session",
		label: "kill_session",
		description:
			"Terminate a session (SIGTERM, escalates to SIGKILL after 2s; on Windows any signal force-kills the process tree). Use when the process won't exit via Ctrl-C. session_id is invalid after. Also suppresses any armed on_exit wake.",
		promptSnippet: "Terminate a session",
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial);
			if (!outcome) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: {
						operation: "kill_session",
						status: "kill_failed",
						running: false,
						session_id: sid,
						found: false,
					} as const,
				};
			}
			const { session, escalated, collected, killed } = outcome;
			updateRunningSessionsUi(ctx);
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							"the session remains registered — retry kill_session or check permissions",
						session.failureMessage,
					]
					.filter((value): value is string => Boolean(value))
					.join("; ");
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: sid,
				pid: session.pid,
				requestedSignal: initial,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: killFailure || null,
				tty: session.tty,
				logPath: session.logPath,
				logStatus: session.logStatus,
				cwd: session.cwd,
				command: session.displayCommand,
				escalated,
				killed,
			});
			return {
				content: [{ type: "text", text: renderKillResultText(details) }],
				details,
			};
		},
		renderCall: renderKillSessionCall,
		renderResult: renderKillSessionResult,
	});

	pi.registerTool({
		name: "list_sessions",
		label: "list_sessions",
		description: "List all live runbg sessions in this pi run.",
		promptSnippet: "List live sessions",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			// Reap any sessions that have exited silently (e.g., completed between
			// tool calls without anyone observing them) — but report each of them
			// one final time with exit info instead of dropping them on the floor.
			// This mirrors codex's `refresh_process_state` filter while preserving
			// our "exit information is never silently lost" guarantee.
			const reaped: ExecSession[] = [];
			for (const s of ctx.store.values()) {
				if (s.hasExited) {
					// Reporting terminal completion here counts as direct observation:
					// suppress a not-yet-queued wake (an already-queued wake stays a
					// single notification — never a second one).
					ctx.coordinator.observeViaListing(s.id);
					removeSession(ctx, s.id);
					reaped.push(s);
				}
			}
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const live = ctx.store.values();
			const sessions = [...live, ...reaped]
				.sort((a, b) => a.id - b.id)
				.map((s) => ({
					session_id: s.id,
					command: s.displayCommand,
					cwd: s.cwd,
					tty: s.tty,
					pid: s.pid,
					started_at_ms: s.startedAt,
					elapsed_ms: now - s.startedAt,
					running: !s.hasExited,
					wake_armed: ctx.coordinator.isArmed(s.id),
					exit_code: s.hasExited ? s.exitCode : undefined,
					signal: s.hasExited ? (s.signal ?? undefined) : undefined,
					failure_message: s.failureMessage ?? undefined,
					output_bytes_total: s.totalBytesSeen,
					log_path: s.logPath,
				}));
			const toolTimeUtc = nowUtcIso();
			const lines = sessions.length
				? sessions.map((s) => {
						const exitedSuffix = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}; removed from store]`;
						const wake = s.wake_armed ? " [wake]" : "";
						return `  ${String(s.session_id).padStart(3)}  pid=${String(s.pid ?? "?").padStart(6)}  ${
							s.tty ? "tty" : "pipe"
						}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}${wake}  ${oneLineCommand(s.command, 60)}${exitedSuffix}\n        log: ${s.log_path}`;
					})
				: ["  (no live sessions)"];
			const header = reaped.length
				? `runbg sessions (${live.length} live, ${reaped.length} just exited):`
				: `runbg sessions (${live.length}):`;
			return {
				// tool_time_utc lets the model compute a yield_until deadline from a
				// trustworthy host clock without an extra probing call.
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}` }],
				details: { sessions, active_count: live.length, just_exited_count: reaped.length, tool_time_utc: toolTimeUtc },
			};
		},
		renderCall: renderListSessionsCall,
		renderResult: renderListSessionsResult,
	});
}
