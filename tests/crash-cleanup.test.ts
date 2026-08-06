/**
 * Divergence #2 (UPSTREAM.md, design §7.2): crash-path child reaping.
 *
 * pi's uncaughtException / dead-terminal exits skip session_shutdown, so the
 * extension installs a synchronous process-"exit" handler that SIGKILLs every
 * live session's process group. These tests pin the wiring (installed at
 * session_start, removed at session_shutdown, never stacked) and fire the
 * captured handler directly against a real child — the one thing a test
 * cannot do is actually exit the test process.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { useIsolatedAgentEnv } from "./helpers/agent-env.ts";
import { trackHarness, useHarnessCleanup } from "./helpers/harness-cleanup.ts";

// Hermetic startup: pin the agent dir and scrub PI_RUNBG_* (see helper).
useIsolatedAgentEnv();
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
			return tools[toolName].execute(`crash-${Math.random()}`, params, undefined, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
	});
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	return cond();
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("crash-path cleanup", () => {
	it("installs the exit reaper at session_start and removes it at session_shutdown", async () => {
		const before = process.listenerCount("exit");
		const h = makeHarness();
		assert.equal(process.listenerCount("exit"), before, "factory must not install process hooks");

		await h.emit("session_start");
		assert.equal(process.listenerCount("exit"), before + 1, "session_start installs the reaper");
		await h.emit("session_start"); // e.g. resume within the same instance
		assert.equal(process.listenerCount("exit"), before + 1, "reaper must not stack");

		await h.emit("session_shutdown");
		assert.equal(process.listenerCount("exit"), before, "session_shutdown removes the reaper");

		await h.emit("session_start"); // reload-style re-arm
		assert.equal(process.listenerCount("exit"), before + 1);
		await h.emit("session_shutdown");
		assert.equal(process.listenerCount("exit"), before);
	});

	it("the reaper synchronously kills a live session's process group", { skip: IS_WINDOWS }, async () => {
		const before = new Set(process.listeners("exit"));
		const h = makeHarness();
		await h.emit("session_start");
		const reaper = process.listeners("exit").find((l) => !before.has(l));
		assert.ok(reaper, "expected the reaper to be captured");

		const r = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const list = await h.call("list_sessions", {});
		const entry = list.details.sessions.find((s: any) => s.session_id === r.details.session_id);
		assert.ok(entry?.pid, "expected a live pid");
		assert.ok(groupAlive(entry.pid), "group should be alive before the reaper runs");

		(reaper as () => void)();

		assert.ok(
			await waitFor(() => !groupAlive(entry.pid)),
			"process group must be dead after the reaper runs",
		);

		// Normal teardown afterwards must not throw on the already-dead child.
		await h.emit("session_shutdown");
	});
});
