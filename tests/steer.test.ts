/**
 * Divergence #10: an attached wait ends as soon as the human has a message
 * queued, so a long yield never makes them wait to be heard.
 *
 * The property that matters is that this is a PREEMPTION, not a cancellation:
 * buffered output must still be drained into the result, and the process must
 * be left running. Getting that backwards is the N1 bug (a finished job's
 * output vanishing) in a new disguise.
 */

import { strict as assert } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import { useIsolatedAgentEnv } from "./helpers/agent-env.ts";
import { trackHarness, useHarnessCleanup } from "./helpers/harness-cleanup.ts";

const { settingsPath: SETTINGS } = useIsolatedAgentEnv();
useHarnessCleanup();
beforeEach(() => rmSync(SETTINGS, { force: true }));

function makeHarness(opts: { pending?: () => boolean } = {}) {
	const tools: Record<string, any> = {};
	const handlers: Record<string, Array<(e: any, c: any) => any>> = {};
	const stubCtx: any = {
		cwd: process.cwd(),
		ui: { notify() {}, setStatus() {}, setWidget() {} },
		hasUI: false,
	};
	if (opts.pending) stubCtx.hasPendingMessages = opts.pending;
	const pi: any = {
		registerTool: (d: any) => (tools[d.name] = d),
		on: (e: string, h: any) => ((handlers[e] ??= []).push(h)),
		registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
		getFlag: () => false, getActiveTools: () => [], setActiveTools() {}, sendMessage() {},
	};
	(extensionFactory as any)(pi);
	let n = 0;
	return trackHarness({
		async call(name: string, params: any) {
			return tools[name].execute(`steer-${++n}`, params, undefined, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
		async shutdown() { await this.emit("session_shutdown"); },
	});
}

describe("steer-aware waits (divergence #10)", () => {
	it("ends a long poll early when a message is queued, and keeps the process alive", async () => {
		let pending = false;
		const h = makeHarness({ pending: () => pending });
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const sid = started.details.session_id;
		assert.ok(typeof sid === "number", "expected a live session");

		pending = true; // the human types
		const t0 = Date.now();
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 20_000 });
		const elapsed = Date.now() - t0;

		assert.equal(poll.details.wait_status, "yielded_for_user_message");
		assert.ok(elapsed < 5_000, `poll should return promptly, took ${elapsed}ms`);
		// The whole point: the wait stopped, the work did not.
		assert.equal(poll.details.running, true, "process must still be running");
		const list = await h.call("list_sessions", {});
		assert.ok(list.details.sessions.some((s: any) => s.session_id === sid && s.running));
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});

	it("still drains buffered output when it yields (preempt semantics, not cancel)", async () => {
		let pending = false;
		const h = makeHarness({ pending: () => pending });
		await h.emit("session_start");
		const started = await h.call("exec_command", {
			cmd: "echo STEER-MARKER; sleep 30",
			yield_time_ms: 250,
		});
		const sid = started.details.session_id;
		// Give the child a moment to emit, then "type" before polling.
		await new Promise((r) => setTimeout(r, 400));
		pending = true;
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 20_000 });
		const text = poll.content.map((c: any) => c.text).join("");
		assert.equal(poll.details.wait_status, "yielded_for_user_message");
		assert.ok(
			text.includes("STEER-MARKER") || started.content.map((c: any) => c.text).join("").includes("STEER-MARKER"),
			`output must not be discarded by the yield: ${JSON.stringify(text)}`,
		);
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});

	it("waits out the deadline when the setting is off", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true, steerYield: false }));
		const h = makeHarness({ pending: () => true });
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const sid = started.details.session_id;
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 1_200 });
		assert.equal(poll.details.wait_status, "relative_deadline_reached", "must not yield when disabled");
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});

	it("degrades silently on a host without hasPendingMessages", async () => {
		const h = makeHarness(); // no capability on the context at all
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const sid = started.details.session_id;
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 1_200 });
		assert.equal(poll.details.wait_status, "relative_deadline_reached");
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});
});
