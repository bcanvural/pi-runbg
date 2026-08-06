/**
 * Headless (`pi -p` / `--mode json`) acceptance — design doc §9.
 *
 * In pi's print/json modes `ctx.hasUI` is false and every ui call is a no-op;
 * these tests go one step further and run with `ctx.ui` entirely undefined so
 * any unguarded ui access crashes loudly. Covers: the full tool surface with
 * no UI, process-group reaping at session_shutdown, and wake delivery being a
 * core `sendMessage` (never a UI call). The suite finishing at all also pins
 * that no stray timer keeps the event loop alive after shutdown.
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

function makeHeadlessHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const sentMessages: Array<{ message: any; options: any }> = [];

	// The point of this harness: no UI object at all.
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
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
	};

	(extensionFactory as any)(pi);

	let nextCallId = 1;
	let shutDown = false;
	return trackHarness({
		async call(toolName: string, params: any) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			const toolCallId = `headless-${nextCallId++}`;
			const result = await def.execute(toolCallId, params, undefined, undefined, stubCtx);
			return { ...result, toolCallId };
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
		async shutdown() {
			if (shutDown) return;
			shutDown = true;
			await this.emit("session_shutdown");
		},
		sentMessages,
	});
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	return cond();
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("headless acceptance", () => {
	it("runs the whole tool surface with ctx.ui undefined", async () => {
		const h = makeHeadlessHarness();
		await h.emit("session_start");

		// Fast command: settles within the attach window.
		const quick = await h.call("exec_command", { cmd: "printf headless-ok", yield_time_ms: 20000 });
		assert.equal(quick.details.exit_code, 0, JSON.stringify(quick.details));
		assert.ok(quick.details.output.includes("headless-ok"));

		// Long-lived session: poll, wake-arm/disarm, list, kill — all UI-less.
		const long = await h.call("exec_command", { cmd: "sleep 20", yield_time_ms: 300 });
		const sid = long.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(long.details));

		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.equal(poll.details.status, "running");

		const armed = await h.call("set_on_exit", { session_id: sid, on_exit: "wake" });
		assert.equal(armed.details.wake_armed, true);
		const disarmed = await h.call("set_on_exit", { session_id: sid, on_exit: "none" });
		assert.equal(disarmed.details.wake_armed, false);

		const list = await h.call("list_sessions", {});
		assert.ok(list.details.sessions.some((s: any) => s.session_id === sid && s.running));

		const killed = await h.call("kill_session", { session_id: sid });
		assert.equal(killed.details.killed, true, JSON.stringify(killed.details));

		await h.shutdown();
	});

	it("session_shutdown reaps the whole process group (POSIX)", { skip: IS_WINDOWS }, async () => {
		const h = makeHeadlessHarness();
		await h.emit("session_start");

		const r = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		const list = await h.call("list_sessions", {});
		const entry = list.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry?.pid, "expected a pid in list_sessions");
		const pid: number = entry.pid;
		// Pipes-mode children are spawned detached, so pgid === pid.
		assert.ok(processAlive(pid), "child should be alive before shutdown");
		assert.ok(groupAlive(pid), "process group should be alive before shutdown");

		await h.shutdown();

		assert.ok(
			await waitFor(() => !processAlive(pid) && !groupAlive(pid)),
			"child process group must be dead after session_shutdown",
		);
	});

	it("wake delivery is a core sendMessage with followUp+triggerTurn, no UI involved", async () => {
		const h = makeHeadlessHarness();
		await h.emit("session_start");

		// Outlives the attach window (and the 150 ms early-exit grace), then
		// exits unobserved — the coordinator must wake via pi.sendMessage.
		const r = await h.call("exec_command", { cmd: "sleep 0.5; exit 7", yield_time_ms: 300, on_exit: "wake" });
		assert.ok(typeof r.details.session_id === "number", JSON.stringify(r.details));

		assert.ok(await waitFor(() => h.sentMessages.length > 0), "expected a wake sendMessage");
		assert.equal(h.sentMessages.length, 1);
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "runbg-completed");
		assert.equal(options.triggerTurn, true);
		assert.equal(options.deliverAs, "followUp");
		const body = String(message.content);
		assert.ok(body.includes("exit"), `wake body should carry exit metadata: ${body}`);

		await h.shutdown();
		assert.equal(h.sentMessages.length, 1, "shutdown must not emit further wakes");
	});
});
