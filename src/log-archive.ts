/**
 * Session log archive policy — divergence #3 (UPSTREAM.md, design §7.3),
 * adopting upstream's own IV-0002 follow-up backlog.
 *
 * Upstream created session logs with default permissions, no exclusive
 * create, no size bound, and no cleanup, and results claimed "Full output"
 * even after mirroring silently stopped. This module owns:
 *
 *   - exclusive `0600` log creation (collision-retried, never reusing or
 *     following a pre-existing path in the shared tmpdir);
 *   - the per-session mirror size cap (`PI_RUNBG_MAX_LOG_BYTES`, `0` opts
 *     into unlimited);
 *   - the `log_status` vocabulary results use to stay truthful about
 *     recoverability; and
 *   - age-based cleanup of stale `pi-runbg-*.log` files
 *     (`PI_RUNBG_LOG_TTL_DAYS`, `0` disables).
 */

import { closeSync, futimesSync, lutimesSync, openSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Recoverability of a session's on-disk log:
 *   - "complete": every child byte so far is mirrored;
 *   - "partial": mirroring stopped early (size cap or stream error) — the
 *     log exists but is not the full stream;
 *   - "unavailable": the log file could not be created at all.
 * Results omit the field entirely while the log is complete.
 */
export type LogStatus = "complete" | "partial" | "unavailable";

export const MAX_LOG_BYTES_ENV_VAR = "PI_RUNBG_MAX_LOG_BYTES";
export const LOG_TTL_ENV_VAR = "PI_RUNBG_LOG_TTL_DAYS";

/** Generous default: logs are the recovery surface, but a runaway child must not fill the disk. */
export const DEFAULT_MAX_LOG_BYTES = 256 * 1024 * 1024;
export const DEFAULT_LOG_TTL_DAYS = 7;

/** Names this extension creates: pi-runbg-<session id>-<8 hex>.log */
const LOG_FILE_PATTERN = /^pi-runbg-\d+-[0-9a-f]{8}\.log$/;

/** Mirror cap for one session's log. `<= 0` opts into unlimited (Infinity). */
export function resolveMaxLogBytes(env: Record<string, string | undefined> = process.env): number {
	const raw = env[MAX_LOG_BYTES_ENV_VAR];
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_LOG_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_MAX_LOG_BYTES;
	if (parsed <= 0) return Number.POSITIVE_INFINITY;
	return Math.floor(parsed);
}

/**
 * Age (days) after which stale logs are deleted at session_start. `<= 0`
 * disables cleanup. Positive values are floored at `MIN_LOG_TTL_DAYS`: the
 * sweep is mtime-based and live logs are kept fresh by an hourly heartbeat
 * (`touchLiveLog`), so a TTL shorter than that heartbeat would delete logs
 * belonging to running sessions in other pi processes.
 */
export function resolveLogTtlDays(env: Record<string, string | undefined> = process.env): number {
	const raw = env[LOG_TTL_ENV_VAR];
	if (raw === undefined || raw.trim() === "") return DEFAULT_LOG_TTL_DAYS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_LOG_TTL_DAYS;
	if (parsed <= 0) return 0;
	return Math.max(MIN_LOG_TTL_DAYS, parsed);
}

/** Interval between liveness touches of open session logs. */
export const LOG_HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
/** Floor for a positive TTL — comfortably above the heartbeat interval. */
export const MIN_LOG_TTL_DAYS = 1;

/**
 * Mark a live session's log as recently used so the age-based sweep in other
 * pi processes never deletes it while its session is merely quiet (a
 * long-running dev server can be output-silent for days).
 *
 * Never uses path-based `utimes`: that follows symlinks, so if our log were
 * unlinked and an attacker claimed the freed name with a symlink, the
 * heartbeat would keep stamping an arbitrary file. Prefers the open fd
 * (`futimes`, immune to path games entirely) and falls back to `lutimes`,
 * which touches a symlink itself rather than its target.
 */
export function touchLiveLog(target: { fd?: number; path?: string }): void {
	const now = new Date();
	try {
		if (typeof target.fd === "number") {
			futimesSync(target.fd, now, now);
			return;
		}
		if (target.path) lutimesSync(target.path, now, now);
	} catch {
		// unlinked, read-only fs, permissions — nothing to do
	}
}

/**
 * Create a log file exclusively (`O_EXCL`) with `0600` permissions, retrying
 * with fresh candidate paths on collision. Refusing to open an existing path
 * means a pre-planted file or symlink in the shared tmpdir can never be
 * followed or overwritten. Throws when candidates keep colliding or on any
 * non-collision error (callers treat that as log "unavailable").
 */
export function createExclusiveLog(nextCandidatePath: () => string, attempts = 4): string {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		const candidate = nextCandidatePath();
		try {
			closeSync(openSync(candidate, "wx", 0o600));
			return candidate;
		} catch (err: any) {
			lastError = err;
			if (err?.code === "EEXIST") continue;
			throw err;
		}
	}
	throw lastError ?? new Error("could not create a unique log file");
}

/**
 * Delete stale runbg logs in `dir` (default: the tmpdir logs are created in).
 * Age-based only — a concurrent pi process may own a fresh log, so recency is
 * the only safe liveness signal. Symlinks are never followed (`lstat` +
 * regular-file check). Best-effort: every failure skips the entry. Returns
 * the number of files removed.
 */
export async function cleanupStaleLogs(
	options: { dir?: string; env?: Record<string, string | undefined>; nowMs?: number } = {},
): Promise<number> {
	const dir = options.dir ?? tmpdir();
	const ttlDays = resolveLogTtlDays(options.env ?? process.env);
	if (ttlDays <= 0) return 0;
	const cutoffMs = (options.nowMs ?? Date.now()) - ttlDays * 24 * 60 * 60 * 1000;

	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (!LOG_FILE_PATTERN.test(name)) continue;
		const path = join(dir, name);
		try {
			const stats = await lstat(path);
			if (!stats.isFile() || stats.mtimeMs > cutoffMs) continue;
			await unlink(path);
			removed++;
		} catch {
			// raced with another process / permissions — leave it
		}
	}
	return removed;
}
