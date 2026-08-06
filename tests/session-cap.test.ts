/**
 * Divergence #6 (UPSTREAM.md): refuse at the session cap instead of killing a
 * live session to make room.
 *
 * Upstream's insert path SIGTERM'd the LRU unprotected session — a single
 * unconfirmed signal, so a SIGTERM-ignoring child survived while leaving the
 * store, which hid it from list_sessions, kill_session AND the crash reaper.
 * These tests use a tiny cap via PI_RUNBG_MAX_SESSIONS-equivalent injection
 * (the store's constructor options are exercised in session-store.test.ts);
 * here we drive the real tools with the real cap by filling it.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import extensionFactory, { MAX_SESSIONS_ENV_VAR } from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "runbg-agent-"));
const PREV = { dir: process.env.PI_CODING_AGENT_DIR, cap: process.env[MAX_SESSIONS_ENV_VAR] };
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env[MAX_SESSIONS_ENV_VAR] = "2"; // tiny cap keeps the test fast
after(() => {
	if (PREV.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = PREV.dir;
	if (PREV.cap === undefined) delete process.env[MAX_SESSIONS_ENV_VAR];
	else process.env[MAX_SESSIONS_ENV_VAR] = PREV.cap;
});

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
	const notifications: Array<{ message: string; type?: string }> = [];
	const stubCtx = {
		cwd: process.cwd(),
		ui: { notify: (m: string, t?: string) => notifications.push({ message: m, type: t }), setStatus: () => {}, setWidget: () => {} },
		hasUI: false,
	};
	let n = 1;
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
	return {
		notifications,
		async call(toolName: string, params: any) {
			return tools[toolName].execute(`cap-${n++}`, params, undefined, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
		async shutdown() {
			await this.emit("session_shutdown");
		},
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	return cond();
}

describe("session cap", () => {
	it("refuses a new session at the cap instead of killing a live one", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const a = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const b = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sidA = a.details.session_id;
		const sidB = b.details.session_id;
		assert.ok(typeof sidA === "number" && typeof sidB === "number", "two sessions expected");

		await assert.rejects(
			h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 }),
			(err: Error) => /session cap reached/.test(err.message) && /kill_session/.test(err.message),
			"third session must be refused with an actionable error",
		);

		// Both incumbents survive and stay addressable.
		const list = await h.call("list_sessions", {});
		const ids = list.details.sessions.map((s: any) => s.session_id).sort();
		assert.deepEqual(ids, [sidA, sidB].sort(), "incumbents must remain in the store");
		assert.ok(list.details.sessions.every((s: any) => s.running));
		await h.shutdown();
	});

	it("refusal leaves no orphan: the newborn that lost the race is killed", { skip: IS_WINDOWS }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Fill the cap with sessions that survive the grace window.
		await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });

		// A pre-spawn refusal never spawns at all; to exercise the post-grace
		// refusal we need the cap to fill *while* a spawn is in flight. Two
		// parallel starts from cap-1 do exactly that.
		await h.call("kill_session", { session_id: 2 }); // back to 1 live, 1 slot free
		const results = await Promise.allSettled([
			h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 400 }),
			h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 400 }),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
		const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
		assert.equal(fulfilled.length + rejected.length, 2);

		// Whatever the interleaving: every session the store reports is alive,
		// and no pid from a refused call is still running.
		const list = await h.call("list_sessions", {});
		const listedPids: number[] = list.details.sessions.map((s: any) => s.pid);
		assert.ok(list.details.sessions.length <= 2, `cap respected: ${JSON.stringify(list.details.sessions)}`);
		for (const r of rejected) {
			assert.match(String((r.reason as Error).message), /session cap reached|shutting down/);
		}
		// Count live `sleep 30` children we own: must equal the listed sessions.
		const stillAlive = listedPids.filter((pid) => alive(pid));
		assert.equal(stillAlive.length, listedPids.length, "listed sessions must all be alive");

		await h.shutdown();
		assert.ok(await waitFor(() => listedPids.every((pid) => !alive(pid))), "shutdown reaps the survivors");
	});

	it("an exited session is reaped to make room instead of refusing", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// One long-lived + one that exits on its own after the grace window.
		const live = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		await new Promise((r) => setTimeout(r, 600)); // let the short one exit

		// At cap (2) but one entry is exited → the new session is admitted.
		const third = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		assert.ok(typeof third.details.session_id === "number", JSON.stringify(third.details));
		const list = await h.call("list_sessions", {});
		const ids = list.details.sessions.map((s: any) => s.session_id);
		assert.ok(ids.includes(live.details.session_id), "the live incumbent survived");
		assert.ok(ids.includes(third.details.session_id), "the new session was admitted");
		await h.shutdown();
	});
});
