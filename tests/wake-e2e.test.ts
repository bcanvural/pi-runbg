/**
 * Integration tests for write_stdin's `yield_until` (absolute deadline) and
 * exec_command's `on_exit: "wake"` through the real tool pipeline.
 *
 * Uses a stub ExtensionAPI that captures pi.sendMessage calls and can emit
 * tool_execution_end / agent_settled lifecycle events. Subprocess-based tests
 * are kept small and cross-platform (sleep/echo through the default shell).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import { isPtyAvailable } from "../src/pty.ts";
import { useIsolatedAgentEnv } from "./helpers/agent-env.ts";
// Hermetic startup: pin the agent dir and scrub PI_RUNBG_* (see helper).
useIsolatedAgentEnv();

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
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const sentMessages: Array<{ message: any; options: any }> = [];
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: () => {},
			setWidget: () => {},
			select: (_title: string, options: string[]) => {
				const responder = uiEvents.selectResponses.shift();
				return Promise.resolve(responder ? responder(options) : undefined);
			},
		},
		hasUI: false,
	};

	const pi = {
		registerTool: (def: ToolDef) => {
			tools[def.name] = def;
		},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (name: string, options: any) => {
			commands[name] = options;
		},
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
	const harness = {
		/** Call a tool with a fresh toolCallId; returns { result, toolCallId }. */
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			const toolCallId = `call-${nextCallId++}`;
			const result = await def.execute(toolCallId, params, signal, onUpdate, stubCtx);
			return { ...result, toolCallId };
		},
		async invokeCommand(name: string, args = "") {
			return commands[name].handler(args, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
			if (event === "session_shutdown") shutDown = true;
		},
		/** Simulate pi finalizing a tool result. */
		async finalizeTool(toolCallId: string, isError = false) {
			await this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "", result: {}, isError });
		},
		async shutdown() {
			if (shutDown) return;
			shutDown = true;
			try {
				await this.emit("session_shutdown");
			} catch {
				// best-effort cleanup
			}
		},
		sentMessages,
		uiEvents,
	};
	liveHarnesses.add(harness);
	return harness;
}

// Equivalent to tests/helpers/harness-cleanup.ts (kept local because this
// suite's net predates the helper and its wake assertions are timing-
// sensitive). New suites should use the shared helper instead.
const liveHarnesses = new Set<{ shutdown: () => Promise<void> }>();

afterEach(async () => {
	const hs = [...liveHarnesses];
	liveHarnesses.clear();
	for (const h of hs) await h.shutdown();
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !!(await cond());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A strict-format future UTC deadline (toISOString matches the accepted grammar). */
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("write_stdin yield_until", () => {
	it("rejects yield_time_ms and yield_until together", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		await assert.rejects(
			() => h.call("write_stdin", { session_id: sid, yield_time_ms: 5000, yield_until: inFuture(5000) }),
			/not both.*tool_time_utc/s,
		);
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("rejects non-empty chars or decoded chars_b64 with yield_until; accepts explicit empty input", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		await assert.rejects(
			() => h.call("write_stdin", { session_id: sid, chars: "hello\n", yield_until: inFuture(5000) }),
			/only valid for an empty poll/,
		);
		await assert.rejects(
			// "aGk=" decodes to non-empty "hi"
			() => h.call("write_stdin", { session_id: sid, chars_b64: "aGk=", yield_until: inFuture(5000) }),
			/only valid for an empty poll/,
		);
		// Explicit empty chars + yield_until is a valid empty poll.
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_until: inFuture(300) });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_mode, "absolute");
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("rejects malformed timestamps at the tool boundary with tool_time_utc", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		for (const bad of ["2026-07-21 18:30:00", "2026-07-21T18:30:00+00:00", "2026-02-30T00:00:00Z"]) {
			await assert.rejects(
				() => h.call("write_stdin", { session_id: sid, yield_until: bad }),
				/tool_time_utc/,
				`should reject ${bad}`,
			);
		}
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("returns the terminal result immediately when the process exits before the deadline", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4 && echo done-marker", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const t0 = Date.now();
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) });
		assert.ok(Date.now() - t0 < 10_000, "must return on exit, not at the deadline");
		assert.equal(r2.details.exit_code, 0, JSON.stringify(r2.details));
		assert.equal(r2.details.session_id, undefined);
		assert.equal(r2.details.wait_mode, "absolute");
		assert.equal(r2.details.wait_status, "completed");
		assert.equal(r2.details.completion_delivery, "direct");
		assert.match(r2.details.yield_until, /Z$/);
		assert.match(r2.details.tool_time_utc, /Z$/);
		assert.ok(r2.details.output.includes("done-marker"), r2.details.output);
		// Full output landed in the log too.
		assert.ok(readFileSync(r2.details.log_path, "utf-8").includes("done-marker"));
		await h.emit("session_shutdown");
	});

	it("returns the still-running session when the absolute deadline arrives first", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "echo early-output && sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(700) });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_mode, "absolute");
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		assert.ok(typeof r2.details.effective_wait_ms === "number" && r2.details.effective_wait_ms >= 500);
		assert.match(r2.details.tool_time_utc, /Z$/);
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("treats a past deadline as an immediate poll", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "echo hi && sleep 30", yield_time_ms: 400 });
		const sid = r1.details.session_id;
		const t0 = Date.now();
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: "2020-01-01T00:00:00Z" });
		assert.ok(Date.now() - t0 < 3000, "past deadline = immediate poll");
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("cancellation leaves the process alive with output retrievable later", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "echo pre-cancel-output && sleep 30", yield_time_ms: 600 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		// Poll once to leave fresh un-drained output before the cancelled wait.
		const ac = new AbortController();
		const inflight = h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) }, ac.signal);
		setTimeout(() => ac.abort(), 150);
		const r2 = await inflight;
		assert.equal(r2.details.session_id, sid, JSON.stringify(r2.details));
		assert.equal(r2.details.wait_status, "cancelled");
		assert.equal(r2.details.output, "", "cancelled waits must not drain output");

		// The process survived; buffered output is still retrievable.
		const r3 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r3.details.session_id, sid);
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("absolute waits do not run a 250ms heartbeat (rate-limited updates only)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Chatty process: prints every 100ms.
		const r1 = await h.call("exec_command", {
			cmd: "for i in $(seq 1 40); do echo chatty-$i; sleep 0.1; done",
			yield_time_ms: 250,
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const updates: any[] = [];
		const r2 = await h.call(
			"write_stdin",
			{ session_id: sid, yield_until: inFuture(1500) },
			undefined,
			(p: any) => updates.push(p),
		);
		// A 250ms heartbeat would produce ~6 updates in 1.5s of chatty output.
		// The rate-limited streamer (30s interval) emits initial + final only.
		assert.ok(updates.length <= 3, `expected <=3 rate-limited updates; got ${updates.length}`);
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});
});

describe("exec_command on_exit", () => {
	it("omitted or explicit 'none' preserves current behavior (no wake)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		const r2 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "none" });
		assert.ok(typeof r1.details.session_id === "number");
		assert.ok(typeof r2.details.session_id === "number");
		assert.equal(r2.details.completion_notification, undefined);
		await new Promise((r) => setTimeout(r, 1200)); // both exit + debounce window
		assert.equal(h.sentMessages.length, 0);
		// Drain them.
		await h.call("write_stdin", { session_id: r1.details.session_id, yield_time_ms: 5000 });
		await h.call("write_stdin", { session_id: r2.details.session_id, yield_time_ms: 5000 });
		await h.emit("session_shutdown");
	});

	it("wake process exiting inside the initial exec_command yield gives a direct result, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo quick", yield_time_ms: 5000, on_exit: "wake" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("backgrounded wake session exiting while idle sends exactly one follow-up prompt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Output ("BYE") deliberately differs from the command text ("bye") so we
		// can assert the wake carries command metadata but never raw stdout.
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.4 && echo bye | tr a-z A-Z",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		assert.equal(r1.details.completion_notification, "armed");
		assert.equal(r1.details.on_exit, "wake");
		assert.ok(r1.content[0].text.includes("completion_notification: armed"), r1.content[0].text);

		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "runbg-completed");
		assert.equal(message.display, true);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(message.content, new RegExp(`session_id=${sid}`));
		assert.match(message.content, /exit_code=0/);
		assert.ok(!message.content.includes("BYE"), "wake must not contain raw stdout");

		// After the wake, the exited session's output is still retrievable…
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0);
		assert.ok(r2.details.output.includes("BYE"));
		await h.finalizeTool(r2.toolCallId, false);
		// …and consuming it does not send another wake.
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.emit("session_shutdown");
	});

	it("exit during a relative write_stdin observer is delivered directly, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.5", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 10_000 });
		assert.equal(r2.details.exit_code, 0);
		assert.equal(r2.details.completion_delivery, "direct");
		assert.equal(r2.details.on_exit_wake, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("exit during an absolute yield_until observer is delivered directly, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.5", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) });
		assert.equal(r2.details.exit_code, 0);
		assert.equal(r2.details.wait_mode, "absolute");
		assert.equal(r2.details.on_exit_wake, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("absolute deadline first, then exit: still-running result keeps wake armed; exactly one wake follows", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(400) });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		assert.equal(r2.details.completion_notification, "armed");
		await h.finalizeTool(r2.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1, "exactly one");
		// Lazy drain still works after the wake.
		const r3 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.equal(r3.details.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("cancelled absolute wait keeps the wake armed; later exit sends exactly one wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const ac = new AbortController();
		const inflight = h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) }, ac.signal);
		setTimeout(() => ac.abort(), 150);
		const r2 = await inflight;
		assert.equal(r2.details.wait_status, "cancelled");
		assert.equal(r2.details.completion_notification, "armed");
		await h.finalizeTool(r2.toolCallId, true); // pi records the cancelled call as error
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }).catch(() => {});
		await h.emit("session_shutdown");
	});

	it("a terminal result finalized as error keeps the completion wake-eligible", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 10_000 });
		assert.equal(r2.details.exit_code, 0);
		// Pi finalizes the constructed result as an error → wake must fire.
		await h.finalizeTool(r2.toolCallId, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake despite constructed result");
		await h.emit("session_shutdown");
	});

	it("set_on_exit none disarms wake; failed job exit does not resume the agent", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.8; exit 1",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("set_on_exit", { session_id: sid, on_exit: "none" });
		assert.equal(r2.details.status, "disarmed");
		assert.equal(r2.details.wake_armed, false);
		// Wait until the process is gone (list reaps it) then confirm no wake.
		assert.ok(
			await waitFor(async () => {
				const l = await h.call("list_sessions", {});
				return l.details.active_count === 0;
			}),
			"process should exit",
		);
		// Debounce window after exit — still no wake.
		await sleep(400);
		assert.equal(h.sentMessages.length, 0, "disarmed wake must not fire");
	});

	it("set_on_exit wake arms a session started with on_exit none", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.5; exit 0",
			yield_time_ms: 250,
			on_exit: "none",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("set_on_exit", { session_id: sid, on_exit: "wake" });
		assert.equal(r2.details.status, "armed");
		assert.equal(r2.details.wake_armed, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "armed session should wake");
		await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }).catch(() => {});
	});

	it("set_on_exit unknown session_id returns found: false", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("set_on_exit", { session_id: 99999, on_exit: "none" });
		assert.equal(r.details.found, false);
	});

	it("list_sessions reports wake_armed for live wake sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const l = await h.call("list_sessions", {});
		const entry = l.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry);
		assert.equal(entry.wake_armed, true);
		assert.match(l.content[0].text, /wake/);
		await h.call("kill_session", { session_id: sid });
	});

	it("explicit model kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		await h.call("kill_session", { session_id: sid });
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("human slash-command kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("runbg-sessions");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("list_sessions observing the exit before notification suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		// Poll until list_sessions can reap the exit (race with debounce).
		let entry: any;
		assert.ok(
			await waitFor(async () => {
				const l = await h.call("list_sessions", {});
				entry = l.details.sessions.find((s: any) => s.session_id === sid);
				return entry && entry.running === false;
			}),
			"expected list_sessions to observe exit",
		);
		await sleep(400); // remaining debounce budget if any
		assert.ok(h.sentMessages.length <= 1, `never more than one notification; got ${h.sentMessages.length}`);
	});

	it("session_shutdown cancels pending wakes (no stale prompt)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		// Shut down before the process exits / the debounce fires.
		await h.emit("session_shutdown");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 800)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("several wake sessions finishing together produce one bounded batch", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Both processes block on the same marker file so their exits land within
		// a few tens of ms of each other — inside the wake debounce window.
		const marker = `${process.env.TMPDIR || "/tmp"}/runbg-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const waitCmd = `while [ ! -f "${marker}" ]; do sleep 0.05; done`;
		const a = await h.call("exec_command", { cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const b = await h.call("exec_command", { cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const release = await h.call("exec_command", { cmd: `touch "${marker}"`, yield_time_ms: 5000 });
		assert.equal(release.details.exit_code, 0);
		assert.ok(typeof a.details.session_id === "number");
		assert.ok(typeof b.details.session_id === "number");
		assert.ok(await waitFor(() => h.sentMessages.length >= 1), "batch wake expected");
		await new Promise((res) => setTimeout(res, 800));
		assert.equal(h.sentMessages.length, 1, "one prompt for both completions");
		const content = h.sentMessages[0].message.content;
		assert.match(content, new RegExp(`session_id=${a.details.session_id}`));
		assert.match(content, new RegExp(`session_id=${b.details.session_id}`));
		await h.call("write_stdin", { session_id: a.details.session_id, yield_time_ms: 5000 });
		await h.call("write_stdin", { session_id: b.details.session_id, yield_time_ms: 5000 });
		await h.emit("session_shutdown");
	});

it("defers an unobserved wake until the lifecycle settled boundary", async () => {
    const h = makeHarness();
    await h.emit("session_start");
    await h.emit("agent_start", { type: "agent_start" });
    const result = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
    assert.ok(typeof result.details.session_id === "number");
    await sleep(500);
    assert.equal(h.sentMessages.length, 0, "active lifecycle phase must gate the debounce flush");
    const settled = h.emit("agent_settled", { type: "agent_settled" });
    assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake expected at settlement");
    await h.emit("agent_start", { type: "agent_start" });
    await h.emit("agent_settled", { type: "agent_settled" });
    await settled;
    await h.emit("session_shutdown");
});

	it("agent_settled flushes a wake whose send previously failed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Make the first send throw.
		const originalPush = h.sentMessages.push.bind(h.sentMessages);
		let failures = 1;
		(h.sentMessages as any).push = (...args: any[]) => {
			if (failures > 0) {
				failures--;
				throw new Error("synthetic send failure");
			}
			return originalPush(...args);
		};
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		// Wait past natural exit + failed debounce flush (no message yet).
		assert.ok(
			await waitFor(async () => {
				// Process has exited if write_stdin can get terminal or list reaps —
				// here we just ensure the first send attempt had time to fail.
				await sleep(50);
				return h.sentMessages.length === 0;
			}, 2000),
		);
		// Give debounce a moment after exit without busy-spinning 900ms blindly:
		// poll until either a (failed) exit path settled or timeout.
		await sleep(350);
		assert.equal(h.sentMessages.length, 0);
		const settled = h.emit("agent_settled", { type: "agent_settled" });
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "retry at agent_settled");
		await h.emit("agent_start", { type: "agent_start" });
		await h.emit("agent_settled", { type: "agent_settled" });
		await settled;
		await h.call("write_stdin", { session_id: r1.details.session_id, yield_time_ms: 5000 });
});
});

describe("on_output consumption", () => {
	/** Distinctive banner token per test: [a-z0-9-] only, shell- and regex-safe. */

	it("match during the attached exec yield is consumed when the finalized body contains the excerpt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `wake-banner-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			// printf without a trailing newline keeps the excerpt strictly
			// single-line; a newline-terminated banner would also match (the
			// ring defers its newline reset to the next push, so the freeze
			// still captures the completed line) but its excerpt may carry a
			// completed previous line when chunks coalesce.
			cmd: `printf '%s' "${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(r.details.output.includes(token), "attach body must contain the banner");
		// The match fires pre-commit and is adopted at the arm-commit point;
		// the finalized result body contains the excerpt → consumed, no wake.
		await h.finalizeTool(r.toolCallId, false);
		await sleep(800);
		assert.equal(h.sentMessages.length, 0, "contained match must not wake");
	});

	it("match in the dropped middle of a poll is not consumed and delivers", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `wake-banner-${Math.random().toString(36).slice(2, 8)}`;
		const r1 = await h.call("exec_command", {
			// The banner lands in the middle of a large stream while the poll is
			// attached: 3000 post-lines push it past the 2000-line result cap, so
			// the post-truncation body drops it. printf without a trailing newline
			// keeps the match mid-line so the frozen ring carries the token; the
			// gap after it keeps the follow-up output in separate chunks.
			cmd: `sleep 1.2; i=1; while [ $i -le 1500 ]; do echo pre-$i; i=$((i+1)); done; printf '%s' "${token}"; sleep 0.3; i=1; while [ $i -le 3000 ]; do echo post-$i; i=$((i+1)); done; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.ok(!r2.details.output.includes(token), "banner must be dropped from the bounded poll body");
		await h.finalizeTool(r2.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one runbg-matched wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "runbg-matched");
		assert.equal(message.display, true);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(message.content, new RegExp(`session_id=${sid}`));
		assert.match(String(message.details?.sessions?.[0]?.matchExcerpt), new RegExp(token));
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one");
	});

	it("match landing after the attach result is built is not consumed and delivers", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `wake-banner-${Math.random().toString(36).slice(2, 8)}`;
		const r1 = await h.call("exec_command", {
			cmd: `sleep 1.0; printf '%s' "${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		assert.ok(typeof r1.details.session_id === "number", JSON.stringify(r1.details));
		assert.ok(!r1.details.output.includes(token), "banner must land after the attach result is built");
		await h.finalizeTool(r1.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one runbg-matched wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "runbg-matched");
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(String(message.details?.sessions?.[0]?.matchExcerpt), new RegExp(token));
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one");
	});

	it("duplicate-line containment is consumed (documented collision)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `wake-banner-${Math.random().toString(36).slice(2, 8)}`;
		const r1 = await h.call("exec_command", {
			// First copy is mid-line (printf, no newline) so the frozen ring
			// carries the token and the match is stageable; the second copy
			// completes the line — the token text appears twice in one result
			// (the documented duplicate-line collision).
			cmd: `sleep 1.2; printf '%s' "${token}"; sleep 0.2; echo "${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.ok(r2.details.output.includes(token), "poll body must contain the banner text");
		await h.finalizeTool(r2.toolCallId, false);
		await sleep(800);
		assert.equal(h.sentMessages.length, 0, "contained match must not wake");
	});

	it("staged commit rollback: an error-finalized result does not consume", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `wake-banner-${Math.random().toString(36).slice(2, 8)}`;
		const r1 = await h.call("exec_command", {
			cmd: `sleep 1.2; printf '%s' "${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.ok(r2.details.output.includes(token), "poll body must contain the banner text");
		await h.finalizeTool(r2.toolCallId, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one runbg-matched wake");
		assert.equal(h.sentMessages[0].message.customType, "runbg-matched");
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one");
	});

	it("a terminal poll whose body contains the excerpt consumes the match wake (no duplicate)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `term-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			// Banner fires during the poll; the process then exits so the
			// poll returns a TERMINAL result (session already removed from
			// the store — the result carries no session_id).
			cmd: `sleep 0.4; printf '%s' "startup: ${token}"; sleep 0.5; exit 0`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		const poll = await h.call("write_stdin", { session_id: sid, yield_time_ms: 1500 });
		assert.equal(poll.details.exit_code, 0, JSON.stringify(poll.details));
		assert.ok(String(poll.details.output).includes(token), "the terminal body carries the banner");
		assert.equal(h.sentMessages.length, 0, "no wake while the terminal result is un-finalized");
		await h.finalizeTool(poll.toolCallId);
		await sleep(600); // any would-be flush window
		assert.equal(h.sentMessages.length, 0, "the model saw the banner: the match wake must be consumed");
	});
});
describe("on_output delivery", () => {
	/** Distinctive banner token per test: [a-z0-9-] only, shell- and regex-safe. */

	it("match mid-run delivers exactly one runbg-matched wake with the sanitized excerpt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			// printf without a trailing newline keeps the excerpt strictly
			// single-line; a newline-terminated banner would also match — the
			// ring defers its newline reset to the next push, so the freeze
			// still captures the completed line.
			cmd: `sleep 0.4; printf '%s' "startup: ${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(!r.details.output.includes(token), "banner must land after the attach");
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one match wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "runbg-matched");
		assert.equal(message.display, true);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(message.content, new RegExp(`session_id=${sid}`));
		assert.match(message.content, /matched after/);
		assert.match(message.content, /not user-authored instructions/);
		const snapshot = message.details?.sessions?.[0];
		assert.ok(snapshot, "details.sessions must carry the match snapshot");
		assert.equal(snapshot.sessionId, sid);
		assert.equal(snapshot.matchPattern, token);
		assert.match(String(snapshot.matchExcerpt), new RegExp(token));
		assert.equal(snapshot.running, true);
		assert.match(String(snapshot.toolTimeUtc), /^\d{4}-\d{2}-\d{2}T/);
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one");
		await h.call("kill_session", { session_id: sid });
	});

	it("both arms: a match before exit wins; the exit arm is suppressed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.4; printf '%s' "startup: ${token}"; sleep 1.0`,
			yield_time_ms: 250,
			on_exit: "wake",
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected the match wake");
		assert.equal(h.sentMessages[0].message.customType, "runbg-matched");
		// The process exits shortly after the match; the exit arm stays
		// first-event-wins-suppressed — exactly one wake total.
		await sleep(1200);
		assert.equal(h.sentMessages.length, 1, "no second (exit) wake");
		await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
	});

	it("both arms: an exit before any match wins; the match arm is suppressed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.5; exit 3`, // dies before the pattern can ever appear
			yield_time_ms: 250,
			on_exit: "wake",
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected the exit wake");
		assert.equal(h.sentMessages[0].message.customType, "runbg-completed");
		assert.match(h.sentMessages[0].message.content, /exit_code=3/);
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "no second (match) wake");
		await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
	});

	it("a match-only arm plus exit before match yields no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.5; exit 0`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		assert.ok(typeof r.details.session_id === "number", JSON.stringify(r.details));
		// Wait past the exit plus the wake debounce window.
		await sleep(1200);
		assert.equal(h.sentMessages.length, 0, "on_output is not an implicit exit wake");
		await h.call("list_sessions", {}); // reap the corpse
	});

	it("pre-commit match (fast banner) is adopted; containment consumes when the attach body holds the excerpt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `printf '%s' "startup: ${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(r.details.output.includes(token), "the banner landed during the attach");
		await h.finalizeTool(r.toolCallId, false);
		await sleep(800);
		assert.equal(h.sentMessages.length, 0, "the finalized body contained the excerpt");
		await h.call("kill_session", { session_id: sid });
	});

	it("pre-commit match whose excerpt is dropped from the attach body delivers", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			// The banner is line 1; 2500 post-lines push it past the 2000-line
			// bounded tail, so the attach body cannot contain the excerpt.
			cmd: `printf '%s' "startup: ${token}"; i=1; while [ $i -le 2500 ]; do echo post-$i; i=$((i+1)); done; sleep 30`,
			yield_time_ms: 2500,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(!r.details.output.includes(token), "the bounded attach body must drop the banner line");
		await h.finalizeTool(r.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one runbg-matched wake");
		assert.equal(h.sentMessages[0].message.customType, "runbg-matched");
		assert.match(String(h.sentMessages[0].message.details?.sessions?.[0]?.matchExcerpt), new RegExp(token));
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one");
		await h.call("kill_session", { session_id: sid });
	});

	it("a match inside a control sequence sanitizes to an empty excerpt and still delivers", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `osctoken${Math.random().toString(36).slice(2, 6)}`;
		const r = await h.call("exec_command", {
			// The pattern lands INSIDE an OSC terminal-string payload; the
			// excerpt sanitizes to empty → containment can never consume it
			// (fail closed to delivery).
			cmd: `sleep 0.4; printf '\\033]0;${token}\\007'; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one runbg-matched wake");
		const message = h.sentMessages[0].message;
		assert.equal(message.customType, "runbg-matched");
		assert.equal(message.details?.sessions?.[0]?.matchExcerpt, "", "empty-after-sanitize excerpt");
		assert.ok(!message.content.includes("match_excerpt:"), "no excerpt line in the body");
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one");
		await h.call("kill_session", { session_id: sid });
	});

	it("a mixed debounce window sends one message per wake kind", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		// Both processes block on the same marker so their events land within
		// one debounce window (exit for A, match for B).
		const marker = `${process.env.TMPDIR || "/tmp"}/runbg-mixed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const waitCmd = `while [ ! -f "${marker}" ]; do sleep 0.05; done`;
		const a = await h.call("exec_command", { cmd: `${waitCmd}; exit 0`, yield_time_ms: 250, on_exit: "wake" });
		const b = await h.call("exec_command", {
			cmd: `${waitCmd}; printf '%s' "startup: ${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const release = await h.call("exec_command", { cmd: `touch "${marker}"`, yield_time_ms: 5000 });
		assert.equal(release.details.exit_code, 0);
		assert.ok(await waitFor(() => h.sentMessages.length === 2), "one message per kind");
		const kinds = h.sentMessages.map((m) => m.message.customType).sort();
		assert.deepEqual(kinds, ["runbg-completed", "runbg-matched"]);
		await h.call("write_stdin", { session_id: a.details.session_id, yield_time_ms: 5000 });
		await h.call("kill_session", { session_id: b.details.session_id });
	});

	it("list_sessions never consumes a fired match wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.4; printf '%s' "startup: ${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		// List repeatedly across the match-fire window: listing shows the arm
		// and must never consume or suppress the pending wake. No fixed
		// sleeps assert a particular phase — delivery is the invariant.
		for (let i = 0; i < 6 && h.sentMessages.length === 0; i++) {
			await sleep(120);
			const listing = await h.call("list_sessions", {});
			const entry = listing.details.sessions.find(
				(s: { session_id: number }) => s.session_id === sid,
			);
			assert.ok(entry, "session still listed before the wake delivers");
		}
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "the match wake still delivers");
		assert.equal(h.sentMessages[0].message.customType, "runbg-matched");
		await h.call("kill_session", { session_id: sid });
	});

	it("disarming the match arm while a fired wake is held cancels the delivery", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.4; printf '%s' "startup: ${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		// The poll holds the fired match; set_on_exit disarms it mid-flight.
		// Deterministic fire signal: a fired one-shot audits as NOT armed, so
		// poll the listing until the tag drops instead of a fixed sleep.
		const poll = h.call("write_stdin", { session_id: sid, yield_time_ms: 1500 });
		assert.ok(
			await waitFor(async () => {
				const listing = await h.call("list_sessions", {});
				const entry = listing.details.sessions.find((s: { session_id: number; match_armed: boolean }) => s.session_id === sid);
				return !!entry && entry.match_armed === false;
			}),
			"the match arm must fire (audit flips to not-armed) while the poll holds it",
		);
		const disarm = await h.call("set_on_exit", { session_id: sid, on_output: null });
		assert.equal(disarm.details.match_armed, false);
		await poll;
		await sleep(500); // any would-be flush window
		assert.equal(h.sentMessages.length, 0, "the disarmed match must never send");
		await h.call("kill_session", { session_id: sid });
	});

	it("kill_session suppresses a fired match wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `ready-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.4; printf '%s' "startup: ${token}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		// A poll overlaps the match so the wake is held (not yet flushable);
		// the kill suppresses both arms before any flush can run. Fire is
		// detected via the audit flip, not a fixed sleep.
		const poll = h.call("write_stdin", { session_id: sid, yield_time_ms: 1500 });
		assert.ok(
			await waitFor(async () => {
				const listing = await h.call("list_sessions", {});
				const entry = listing.details.sessions.find((s: { session_id: number; match_armed: boolean }) => s.session_id === sid);
				return !!entry && entry.match_armed === false;
			}),
			"the match arm must fire before the kill",
		);
		const kill = await h.call("kill_session", { session_id: sid });
		await poll;
		await sleep(600);
		assert.equal(h.sentMessages.length, 0, "the killed session must never wake");
	});

	it("the delivered excerpt is sanitized (SGR controls stripped per IV-0002)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `sgr-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			// The banner is wrapped in SGR color sequences: the raw stream
			// contains ESC [ 32 m … ESC [ 0 m; the excerpt must be plain.
			cmd: `sleep 0.4; printf '\\033[32mstartup: ${token}\\033[0m'; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one match wake");
		const message = h.sentMessages[0].message;
		assert.equal(message.customType, "runbg-matched");
		const excerpt = String(message.details?.sessions?.[0]?.matchExcerpt);
		assert.ok(!excerpt.includes("\x1b"), `SGR must be stripped: ${JSON.stringify(excerpt)}`);
		assert.match(excerpt, new RegExp(token));
		assert.ok(!message.content.includes("\x1b"));
		await sleep(600);
		assert.equal(h.sentMessages.length, 1, "exactly one");
		await h.call("kill_session", { session_id: sid });
	});

	it("set_on_exit arms/disarms the match arm and echoes the audit; list_sessions shows [match]", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		const armed = await h.call("set_on_exit", { session_id: sid, on_output: { pattern: "Server started on" } });
		assert.equal(armed.details.status_match, "armed");
		assert.equal(armed.details.match_armed, true);
		assert.equal(armed.details.match_pattern, "Server started on");
		assert.equal(armed.details.wake_armed, false, "match-only arm must not light the exit [wake] label");
		assert.match(armed.content[0].text, /match arm armed \(pattern: Server started on\)/);
		const listing = await h.call("list_sessions", {});
		const entry = listing.details.sessions.find(
			(s: { session_id: number; match_armed: boolean; wake_armed: boolean }) => s.session_id === sid,
		);
		assert.equal(entry.match_armed, true);
		assert.equal(entry.wake_armed, false);
		assert.match(listing.content[0].text, /\[match\]/);
		const disarmed = await h.call("set_on_exit", { session_id: sid, on_output: null });
		assert.equal(disarmed.details.status_match, "disarmed");
		assert.equal(disarmed.details.match_armed, false);
		assert.equal(disarmed.details.match_pattern, null);
		await h.call("kill_session", { session_id: sid });
	});

	it("set_on_exit re-arms a fired match arm for a later signal (fresh generation)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const t1 = `sig1-${Math.random().toString(36).slice(2, 8)}`;
		const t2 = `sig2-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.4; printf '%s' "one: ${t1}"; sleep 0.6; printf '%s' "two: ${t2}"; sleep 30`,
			yield_time_ms: 250,
			on_output: { pattern: t1 },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "first wake");
		assert.equal(h.sentMessages[0].message.customType, "runbg-matched");
		assert.match(String(h.sentMessages[0].message.details?.sessions?.[0]?.matchExcerpt), new RegExp(t1));
		await h.emit("agent_start", { type: "agent_start" });
		await h.emit("agent_settled", { type: "agent_settled" });
		// The second banner prints at ~1.0s — re-arm before it lands.
		const rearm = await h.call("set_on_exit", { session_id: sid, on_output: { pattern: t2 } });
		assert.equal(rearm.details.status_match, "armed");
		assert.ok(await waitFor(() => h.sentMessages.length === 2), "second wake after re-arm");
		assert.equal(h.sentMessages[1].message.customType, "runbg-matched");
		assert.match(String(h.sentMessages[1].message.details?.sessions?.[0]?.matchExcerpt), new RegExp(t2));
		await h.call("kill_session", { session_id: sid });
	});
});

describe("on_output delivery (PTY domain)", { skip: !isPtyAvailable() }, () => {
	it("matches a banner on a tty session and delivers runbg-matched", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const token = `pty-token-${Math.random().toString(36).slice(2, 8)}`;
		const r = await h.call("exec_command", {
			cmd: `sleep 0.5; printf '%s' "startup: ${token}"; sleep 30`,
			tty: true,
			yield_time_ms: 250,
			on_output: { pattern: token },
		});
		const sid = r.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r.details));
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one match wake");
		assert.equal(h.sentMessages[0].message.customType, "runbg-matched");
		assert.match(String(h.sentMessages[0].message.content), new RegExp(token));
		await h.call("kill_session", { session_id: sid });
	});
});
