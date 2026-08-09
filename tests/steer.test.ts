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
import extensionFactory, { STEER_YIELDS_PER_EPISODE } from "../src/index.ts";
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
		assert.ok(elapsed < 10_000, `poll should return well before its 20s deadline, took ${elapsed}ms`);
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
		// The marker is emitted AFTER the initial attach has already returned,
		// so it can only reach the model by being drained by the steering poll.
		// (An earlier version echoed immediately and accepted the marker from
		// either result — which passed even with steer wired as a cancellation,
		// the exact bug this test exists to catch.)
		const started = await h.call("exec_command", {
			cmd: "sleep 1; echo STEER-MARKER; sleep 30",
			yield_time_ms: 300,
		});
		const sid = started.details.session_id;
		assert.ok(
			!started.content.map((c: any) => c.text).join("").includes("STEER-MARKER"),
			"precondition: the marker must NOT be in the initial attach's output",
		);
		await new Promise((r) => setTimeout(r, 1400)); // let the echo land in the buffer
		pending = true;
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 20_000 });
		const text = poll.content.map((c: any) => c.text).join("");
		assert.equal(poll.details.wait_status, "yielded_for_user_message");
		assert.ok(text.includes("STEER-MARKER"), `yield must not discard buffered output: ${JSON.stringify(text)}`);
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});

	it("bounds the follow-up case: yields are budgeted per episode, then waits run full length", async () => {
		// hasPendingMessages() counts follow-ups too, and pi does not drain those
		// until the whole turn ends — so the flag can stay true all turn. Without
		// a bound, every later wait would yield instantly and the model could
		// never wait for anything. The bound is a budget rather than a latch or a
		// start-time rule, because both of those deny legitimate batch siblings.
		const h = makeHarness({ pending: () => true });
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const sid = started.details.session_id;
		assert.equal(started.details.wait_status, "yielded_for_user_message", "the attach spends the first yield");
		// Spend exactly the rest of the budget; each of these returns immediately.
		// (Overshooting would make every extra call wait its full deadline.)
		for (let i = 0; i < STEER_YIELDS_PER_EPISODE - 1; i++) {
			await h.call("write_stdin", { session_id: sid, yield_time_ms: 6_000 });
		}
		const t0 = Date.now();
		const exhausted = await h.call("write_stdin", { session_id: sid, yield_time_ms: 6_000 });
		const elapsed = Date.now() - t0;
		assert.notEqual(
			exhausted.details.wait_status,
			"yielded_for_user_message",
			"once the budget is spent, waits must run their full length again",
		);
		assert.ok(elapsed > 3_000, `an exhausted-budget wait must actually wait, took ${elapsed}ms`);
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});

	it("lets a whole parallel batch yield, not just the first (pi runs batches in parallel)", async () => {
		// If only one sibling could yield, the others would sit out full-length
		// waits and the batch could not end — so the steering message that caused
		// the yield would never be delivered. Worse than not yielding at all.
		let pending = false;
		const h = makeHarness({ pending: () => pending });
		await h.emit("session_start");
		const a = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const b = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		pending = true;
		const t0 = Date.now();
		const [pa, pb] = await Promise.all([
			h.call("write_stdin", { session_id: a.details.session_id, yield_time_ms: 20_000 }),
			h.call("write_stdin", { session_id: b.details.session_id, yield_time_ms: 20_000 }),
		]);
		const elapsed = Date.now() - t0;
		assert.equal(pa.details.wait_status, "yielded_for_user_message", "sibling A must yield");
		assert.equal(pb.details.wait_status, "yielded_for_user_message", "sibling B must yield too");
		assert.ok(elapsed < 10_000, `both should return well before their 20s deadline, took ${elapsed}ms`);
		await h.call("kill_session", { session_id: a.details.session_id });
		await h.call("kill_session", { session_id: b.details.session_id });
		await h.shutdown();
	});

	it("watches for a message that arrives mid-wait (the setInterval path)", async () => {
		// Every other test sets the flag before the call and hits the `already`
		// fast path, leaving the poller — the part with the leak and latency
		// risk — unexercised.
		let pending = false;
		const h = makeHarness({ pending: () => pending });
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const sid = started.details.session_id;
		setTimeout(() => { pending = true; }, 600);
		const t0 = Date.now();
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 20_000 });
		const elapsed = Date.now() - t0;
		assert.equal(poll.details.wait_status, "yielded_for_user_message");
		assert.ok(elapsed > 500 && elapsed < 10_000, `should yield after the flip, not at the 20s deadline, took ${elapsed}ms`);
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});

	it("reports the yield on an input write, not just an empty poll", async () => {
		let pending = false;
		const h = makeHarness({ pending: () => pending });
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "cat", yield_time_ms: 300 });
		pending = true; // queued only after the attach, so the write owns the episode
		const sid = started.details.session_id;
		const wrote = await h.call("write_stdin", { session_id: sid, chars: "hello\n", yield_time_ms: 20_000 });
		assert.equal(
			wrote.details.wait_status,
			"yielded_for_user_message",
			"an input write cut short must say so; silence reads as 'nothing happened'",
		);
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});

	it("tolerates a host whose hasPendingMessages throws", async () => {
		const h = makeHarness({ pending: () => { throw new Error("host boom"); } });
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 300 });
		const sid = started.details.session_id;
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 1_200 });
		assert.equal(poll.details.wait_status, "relative_deadline_reached", "a throwing host must degrade, not crash");
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
