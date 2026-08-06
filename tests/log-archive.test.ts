/**
 * Divergence #3 (UPSTREAM.md, design §7.3): log archive safety.
 *
 * Covers exclusive 0600 creation (collision retry, symlink/pre-plant
 * refusal), the per-session mirror size cap with truthful log_status
 * reporting ("Full output" is only ever claimed for a complete log), and
 * age-based cleanup of stale runbg logs.
 */

import { strict as assert } from "node:assert";
import {
	closeSync,
	lutimesSync,
	mkdtempSync,
	openSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import {
	cleanupStaleLogs,
	createExclusiveLog,
	DEFAULT_LOG_TTL_DAYS,
	DEFAULT_MAX_LOG_BYTES,
	LOG_HEARTBEAT_INTERVAL_MS,
	LOG_TTL_ENV_VAR,
	MAX_LOG_BYTES_ENV_VAR,
	MIN_LOG_TTL_DAYS,
	resolveLogTtlDays,
	resolveMaxLogBytes,
	touchLiveLog,
} from "../src/log-archive.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { truncationMarker } from "../src/tool-result.ts";
import { useIsolatedAgentEnv } from "./helpers/agent-env.ts";
import { trackHarness, useHarnessCleanup } from "./helpers/harness-cleanup.ts";

// Hermetic startup: pin the agent dir and scrub PI_RUNBG_* so the developer's
// own cap/TTL settings cannot change these assertions (see helper).
const env = useIsolatedAgentEnv();
// Anti-hang net: shut every spawned harness down after each test (see helper).
useHarnessCleanup();

interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

function makeHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const stubCtx = { cwd: process.cwd(), ui: undefined, hasUI: false };
	const pi = {
		registerTool: (def: ToolDef) => {
			tools[def.name] = def;
		},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
		sendMessage: () => {},
	};
	(extensionFactory as any)(pi);
	return trackHarness({
		async call(toolName: string, params: any) {
			return tools[toolName].execute(`log-${Math.random()}`, params, undefined, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
	});
}

describe("log archive safety", () => {
	it("resolveMaxLogBytes: default, explicit, unlimited opt-in, garbage", () => {
		assert.equal(resolveMaxLogBytes({}), DEFAULT_MAX_LOG_BYTES);
		assert.equal(resolveMaxLogBytes({ [MAX_LOG_BYTES_ENV_VAR]: "1024" }), 1024);
		assert.equal(resolveMaxLogBytes({ [MAX_LOG_BYTES_ENV_VAR]: "0" }), Number.POSITIVE_INFINITY);
		assert.equal(resolveMaxLogBytes({ [MAX_LOG_BYTES_ENV_VAR]: "-5" }), Number.POSITIVE_INFINITY);
		assert.equal(resolveMaxLogBytes({ [MAX_LOG_BYTES_ENV_VAR]: "nope" }), DEFAULT_MAX_LOG_BYTES);
	});

	it("resolveLogTtlDays: default, explicit, disable, and floor", () => {
		assert.equal(resolveLogTtlDays({}), DEFAULT_LOG_TTL_DAYS);
		assert.equal(resolveLogTtlDays({ [LOG_TTL_ENV_VAR]: "3" }), 3);
		assert.equal(resolveLogTtlDays({ [LOG_TTL_ENV_VAR]: "0" }), 0, "0 disables cleanup");
		assert.equal(resolveLogTtlDays({ [LOG_TTL_ENV_VAR]: "junk" }), DEFAULT_LOG_TTL_DAYS);
		// A TTL below the heartbeat interval would delete live sessions' logs
		// in other pi processes, so positive values are floored.
		assert.equal(resolveLogTtlDays({ [LOG_TTL_ENV_VAR]: "0.02" }), MIN_LOG_TTL_DAYS);
		assert.equal(resolveLogTtlDays({ [LOG_TTL_ENV_VAR]: "-3" }), 0, "negative still disables");
		assert.ok(LOG_HEARTBEAT_INTERVAL_MS < MIN_LOG_TTL_DAYS * 24 * 60 * 60 * 1000, "heartbeat must beat the floor");
	});

	it("touchLiveLog refreshes mtime by fd and by path, and never follows a symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "runbg-touch-"));
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

		// by path (lutimes)
		const byPath = join(dir, "pi-runbg-9-aaaabbbb.log");
		writeFileSync(byPath, "x");
		utimesSync(byPath, old, old);
		touchLiveLog({ path: byPath });
		assert.ok(statSync(byPath).mtimeMs > old.getTime() + 1000, "path touch must refresh mtime");

		// by fd (futimes) — the preferred route while the stream is open
		const byFd = join(dir, "pi-runbg-10-aaaabbbb.log");
		writeFileSync(byFd, "x");
		utimesSync(byFd, old, old);
		const fd = openSync(byFd, "r+");
		try {
			touchLiveLog({ fd });
		} finally {
			closeSync(fd);
		}
		assert.ok(statSync(byFd).mtimeMs > old.getTime() + 1000, "fd touch must refresh mtime");

		if (!IS_WINDOWS) {
			// A symlink planted at a freed log name must not get its TARGET
			// stamped — that would reopen the path-trust hole 0600+O_EXCL closes.
			const victim = join(dir, "victim.txt");
			writeFileSync(victim, "precious");
			utimesSync(victim, old, old);
			const link = join(dir, "pi-runbg-11-aaaabbbb.log");
			symlinkSync(victim, link);
			touchLiveLog({ path: link });
			assert.ok(
				Math.abs(statSync(victim).mtimeMs - old.getTime()) < 2000,
				"symlink target mtime must be untouched",
			);
		}
	});

	it("heartbeat keeps a quiet live session's log out of a sweep", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runbg-hb-"));
		const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const logPath = join(dir, "pi-runbg-12-ccccdddd.log");
		writeFileSync(logPath, "quiet dev server");
		utimesSync(logPath, stale, stale); // looks abandoned…

		touchLiveLog({ path: logPath }); // …but its session is alive

		assert.equal(await cleanupStaleLogs({ dir }), 0, "a heartbeat'd log must survive the sweep");
		assert.equal(readFileSync(logPath, "utf8"), "quiet dev server");
	});

	it("createExclusiveLog retries past a colliding path and never reuses it", () => {
		const dir = mkdtempSync(join(tmpdir(), "runbg-excl-"));
		const taken = join(dir, "pi-runbg-1-aaaaaaaa.log");
		writeFileSync(taken, "pre-planted");
		const fresh = join(dir, "pi-runbg-1-bbbbbbbb.log");
		const candidates = [taken, fresh];
		const created = createExclusiveLog(() => candidates.shift()!);
		assert.equal(created, fresh);
		assert.equal(readFileSync(taken, "utf8"), "pre-planted", "colliding file must be untouched");
		if (!IS_WINDOWS) {
			assert.equal(statSync(created).mode & 0o777, 0o600, "log must be 0600");
		}
	});

	it("createExclusiveLog gives up after exhausting colliding candidates", () => {
		const dir = mkdtempSync(join(tmpdir(), "runbg-excl-"));
		const taken = join(dir, "pi-runbg-2-cccccccc.log");
		writeFileSync(taken, "x");
		assert.throws(() => createExclusiveLog(() => taken, 3));
	});

	it("session logs are created 0600 and complete logs carry no log_status", { skip: IS_WINDOWS }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "printf log-perms-ok", yield_time_ms: 20000 });
		assert.equal(r.details.exit_code, 0, JSON.stringify(r.details));
		assert.equal(statSync(r.details.log_path).mode & 0o777, 0o600);
		assert.equal(r.details.log_status, undefined, "complete log must not surface log_status");
		assert.equal(readFileSync(r.details.log_path, "utf8"), "log-perms-ok");
		await h.emit("session_shutdown");
	});

	it("size cap ends mirroring, marks the log partial, and results say so", async () => {
		const prev = process.env[MAX_LOG_BYTES_ENV_VAR];
		process.env[MAX_LOG_BYTES_ENV_VAR] = "8";
		try {
			const h = makeHarness();
			await h.emit("session_start");
			const r = await h.call("exec_command", { cmd: "printf 0123456789ABCDEF", yield_time_ms: 20000 });
			assert.equal(r.details.exit_code, 0, JSON.stringify(r.details));
			// Model output is unaffected — only the on-disk mirror is capped.
			assert.ok(r.details.output.includes("0123456789ABCDEF"));
			assert.equal(r.details.log_status, "partial");
			assert.ok(r.content[0].text.includes("log_status: partial"), r.content[0].text);
			const logged = readFileSync(r.details.log_path, "utf8");
			assert.ok(logged.startsWith("01234567"), `first 8 bytes mirrored: ${logged}`);
			assert.ok(!logged.includes("9ABCDEF"), `bytes past the cap must not be mirrored: ${logged}`);
			assert.ok(logged.includes("log truncated here"), `explicit note in the log: ${logged}`);
			await h.emit("session_shutdown");
		} finally {
			if (prev === undefined) delete process.env[MAX_LOG_BYTES_ENV_VAR];
			else process.env[MAX_LOG_BYTES_ENV_VAR] = prev;
		}
	});

	it("truncation marker never claims Full output for a degraded log", () => {
		const t = {
			truncated: true,
			content: "x",
			outputBytes: 1,
			outputLines: 1,
			totalLines: 10,
			truncatedBy: "lines" as const,
			lastLinePartial: false,
		};
		assert.ok(truncationMarker(t as any, "/tmp/x.log")!.includes("Full output"));
		assert.ok(truncationMarker(t as any, "/tmp/x.log", "complete")!.includes("Full output"));
		const partial = truncationMarker(t as any, "/tmp/x.log", "partial")!;
		assert.ok(!partial.includes("Full output"), partial);
		assert.ok(partial.includes("Partial log"), partial);
		const unavailable = truncationMarker(t as any, "/tmp/x.log", "unavailable")!;
		assert.ok(!unavailable.includes("/tmp/x.log"), unavailable);
	});

	it("cleanupStaleLogs removes only old runbg-named regular files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runbg-clean-"));
		const dayMs = 24 * 60 * 60 * 1000;
		const old = (path: string) => {
			const t = new Date(Date.now() - 30 * dayMs);
			utimesSync(path, t, t);
		};

		const staleLog = join(dir, "pi-runbg-3-deadbeef.log");
		writeFileSync(staleLog, "stale");
		old(staleLog);
		const freshLog = join(dir, "pi-runbg-4-deadbeef.log");
		writeFileSync(freshLog, "fresh");
		const unrelated = join(dir, "pi-runbg-notes.log");
		writeFileSync(unrelated, "not a session log");
		old(unrelated);
		let victim: string | undefined;
		if (!IS_WINDOWS) {
			victim = join(dir, "victim.txt");
			writeFileSync(victim, "precious");
			const link = join(dir, "pi-runbg-5-deadbeef.log");
			symlinkSync(victim, link);
			const t = new Date(Date.now() - 30 * dayMs);
			lutimesSync(link, t, t); // age the link ITSELF so only the isFile() guard protects the victim
		}

		const removed = await cleanupStaleLogs({ dir });
		assert.equal(removed, 1, "only the stale session log is removed");
		assert.equal(readFileSync(freshLog, "utf8"), "fresh");
		assert.equal(readFileSync(unrelated, "utf8"), "not a session log");
		if (victim) assert.equal(readFileSync(victim, "utf8"), "precious");

		assert.equal(await cleanupStaleLogs({ dir, env: { [LOG_TTL_ENV_VAR]: "0" } }), 0, "TTL 0 disables cleanup");
	});
});
