/**
 * Held-open session diagnostics (IV-0006) — regression tests for the
 * "shell exited but the output pipe is still held by background processes"
 * state: `shellExited` state, the platform note on still-running results,
 * the widget/picker/list markers, the wake contract (an armed on_exit wake
 * stays pending while the pipe is held), and the kill-failure note append.
 *
 * State-level cases spawn raw `ExecSession`s (POSIX-only for the
 * group-semantics fixtures, per the repo's per-case `{ skip: IS_WINDOWS }`
 * convention); wiring cases go through the real extension harness with a
 * capturing `setWidget` stub.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import { ExecSession } from "../src/session.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { useIsolatedAgentEnv } from "./helpers/agent-env.ts";
import { trackHarness, useHarnessCleanup } from "./helpers/harness-cleanup.ts";

useIsolatedAgentEnv();
useHarnessCleanup();

// The POSIX note carries the setsid qualifier; the Windows variant names
// tasklist/taskkill instead. Both share the diagnosis head (softened to stay
// truthful in the exit→close drain window: "typically" a background holder).
const NOTE_HEAD = "shell has exited, but the output pipe is still open";
const NOTE_REMEDY_MARKER = IS_WINDOWS ? "tasklist" : "escapes the group kill";
const HELD_MARKER = "shell exited, pipe held";

let nextId = 1000;

function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const poll = () => {
			if (cond() || Date.now() >= deadline) return resolve(cond());
			setTimeout(poll, 25);
		};
		poll();
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnShell(cmd: string, workdir: string): ExecSession {
	const session = ExecSession.spawn(nextId++, {
		command: ["bash", "-c", cmd],
		cwd: workdir,
		env: process.env,
		tty: false,
	});
	assert.equal(session.failureMessage, null, "spawn must succeed");
	return session;
}

/** Raw-spawn sessions create logs in the shared tmpdir; remove them. */
function cleanupSession(session: ExecSession | undefined): void {
	if (!session) return;
	try {
		session.terminate();
	} catch {
		// best-effort
	}
	if (session.logPath) {
		try {
			rmSync(session.logPath, { force: true });
		} catch {
			// best-effort: the log stream closes on a setImmediate after exit,
			// so the unlink can race the stream close (harmless on POSIX).
		}
	}
}

// ---------------- harness (capturing setWidget) ----------------

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
		selectCalls: [] as string[][],
		widgets: [] as Array<{ key: string; content: string[] | undefined }>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: () => {},
			setWidget: (key: string, content: string[] | undefined) => {
				uiEvents.widgets.push({ key, content });
			},
			select: (_title: string, options: string[]) => {
				uiEvents.selectCalls.push(options);
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
		async finalizeTool(toolCallId: string, isError = false) {
			await this.emit("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId,
				toolName: "",
				result: {},
				isError,
			});
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
	return trackHarness(harness);
}

// ---------------- state-level (raw ExecSession) ----------------

describe("held-open state (raw spawn, POSIX)", { skip: IS_WINDOWS }, () => {
	const workdir = mkdtempSync(join(tmpdir(), "runbg-held-"));

	it("backgrounded job with inherited stdout: shellExited true, hasExited false", async () => {
		const session = spawnShell("sleep 3 & echo done", workdir);
		try {
			assert.equal(session.shellExited, false, "shell still alive right after spawn");
			assert.ok(await waitFor(() => session.shellExited), "shell must exit once echo completes");
			assert.equal(session.hasExited, false, "pipe held by sleep keeps the session open");
		} finally {
			cleanupSession(session);
		}
	});

	it("backgrounded `(cd … && cmd) &` chain: same state", async () => {
		const session = spawnShell("(cd / && sleep 3) & echo done", workdir);
		try {
			assert.ok(await waitFor(() => session.shellExited), "subshell chain exits its shell");
			assert.equal(session.hasExited, false, "the backgrounded subshell holds the pipe");
		} finally {
			cleanupSession(session);
		}
	});

	it("normal long-running foreground command: shellExited false", async () => {
		const session = spawnShell("sleep 3", workdir);
		try {
			await sleep(300);
			assert.equal(session.shellExited, false, "foreground sleep keeps the shell alive");
			assert.equal(session.hasExited, false);
		} finally {
			cleanupSession(session);
		}
	});

	it("after kill_session, hasExited becomes true", async () => {
		const session = spawnShell("sleep 3 & echo done", workdir);
		try {
			assert.ok(await waitFor(() => session.shellExited));
			session.terminate();
			assert.ok(await waitFor(() => session.hasExited), "kill closes the pipe → session exits");
		} finally {
			cleanupSession(session);
		}
	});
});

describe("held-open spawn failures", () => {
	it("synchronous spawn failure: shellExited false without throwing", () => {
		const session = ExecSession.spawn(nextId++, {
			command: [],
			cwd: process.cwd(),
			env: process.env,
			tty: false,
		});
		try {
			assert.ok(session.failureMessage, "failure is recorded");
			assert.equal(session.shellExited, false, "defensive getter must not throw on unset child");
			assert.equal(session.hasExited, true);
		} finally {
			cleanupSession(session);
		}
	});

	it("async ENOENT spawn failure: shellExited false, failureMessage set", async () => {
		const session = ExecSession.spawn(nextId++, {
			command: ["definitely-not-a-real-binary-xyz", "-c", "echo hi"],
			cwd: process.cwd(),
			env: process.env,
			tty: false,
		});
		try {
			assert.ok(await waitFor(() => session.failureMessage !== null), "async spawn error lands");
			assert.equal(session.shellExited, false);
		} finally {
			cleanupSession(session);
		}
	});
});

// ---------------- wiring-level (real tools) ----------------

describe("held-open note wiring through the tools", () => {
	it("exec_command on a held-open session carries the platform note", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// The shell exits within ms (echo done); sleep holds the pipe, so the
		// attached result is still running WITH the note. The yield window
		// must cover spawn plus the exit-event delivery: on a loaded CI runner
		// the spawn itself can eat most of a 500ms window and the result
		// finalizes before bash's exit event lands (seen on Node 24 Windows).
		// 1.5s window, 15s holder — the session is safely held throughout.
		const r = await h.call("exec_command", { cmd: "sleep 15 & echo done", yield_time_ms: 1500, shell: "bash" });
		assert.equal(r.details.status, "running");
		assert.ok(r.details.note, "held-open note present on the still-running result");
		assert.ok(r.details.note.includes(NOTE_HEAD), `note names the state: ${r.details.note}`);
		assert.ok(r.details.note.includes(NOTE_REMEDY_MARKER), `note carries the platform remedy: ${r.details.note}`);
		assert.ok(r.content[0].text.includes("note: "), "note renders as a header line for the model");
		await h.call("kill_session", { session_id: r.details.session_id });
	});

	it("a short input poll on the held-open session also carries the note", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "sleep 5 & echo done", yield_time_ms: 400, shell: "bash" });
		assert.ok(r.details.note, "precondition: held open");
		// Non-empty chars poll: clamped to 250ms (empty polls clamp to 5s,
		// which would outlive the 5s holder and observe the exit instead).
		const p = await h.call("write_stdin", {
			session_id: r.details.session_id,
			chars: "\n",
			yield_time_ms: 250,
		});
		assert.equal(p.details.status, "running");
		assert.ok(p.details.note, "poll result carries the note too");
		await h.call("kill_session", { session_id: r.details.session_id });
	});

	it("cancelledWhileQueued on a held-open session carries the note (site 4)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "sleep 5 & echo done", yield_time_ms: 400, shell: "bash" });
		assert.ok(r.details.note, "precondition: held open");
		const sid = r.details.session_id;
		// Hold the interaction lock with a non-preemptible input poll, then
		// queue a second call whose signal aborts while queued: the result is
		// cancelledWhileQueued with the session still listed — and the note.
		const holder = h.call("write_stdin", { session_id: sid, chars: "\n", yield_time_ms: 1200 });
		await sleep(100); // let the holder acquire the lock
		const queued = await h.call(
			"write_stdin",
			{ session_id: sid },
			AbortSignal.timeout(150),
		);
		assert.equal(queued.details.wait_status, "cancelled");
		assert.equal(queued.details.status, "running");
		assert.equal(queued.details.session_id, sid);
		assert.ok(queued.details.note, "cancelledWhileQueued result carries the note");
		assert.ok(queued.details.note.includes(NOTE_HEAD));
		await holder;
		await h.call("kill_session", { session_id: sid });
	});

	it("exited sessions never carry the note", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hi", yield_time_ms: 2000 });
		assert.equal(r.details.status, "exited");
		assert.equal(r.details.note, undefined);
		assert.ok(!r.content[0].text.includes("note: "));
	});

	it("list_sessions reports shell_exited + [shell exited] marker; reaped entries stay clean", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// First session: held open while we inspect the listing.
		const r = await h.call("exec_command", { cmd: "sleep 5 & echo done", yield_time_ms: 400, shell: "bash" });
		assert.ok(r.details.note, "precondition: held open");
		const sid = r.details.session_id;
		const ls = await h.call("list_sessions", {});
		const entry = ls.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry, "session listed");
		assert.equal(entry.running, true);
		assert.equal(entry.shell_exited, true);
		assert.ok(ls.content[0].text.includes("[shell exited]"), "text listing marks the state");
		// Cleanup: on POSIX the group kill (kill -pgid) lands instantly and the
		// session is removed. On Windows, taskkill /T /F can only enumerate the
		// children of a LIVE root — the shell has already exited here, so the
		// background holder is unreachable (the documented IV-0006 live-root
		// limitation; the kill-failure result carries the platform note) and the
		// session stays registered until the holder exits on its own. Assert that
		// documented behavior, then wait for the natural cleanup so the phase
		// below starts from a clean store.
		const killRes = await h.call("kill_session", { session_id: sid });
		if (IS_WINDOWS) {
			assert.equal(
				killRes.details.status,
				"kill_failed",
				"Windows live-root kill cannot reach the holder of an exited shell",
			);
			assert.ok(
				killRes.details.failure_message?.includes("shell has exited"),
				"kill-failure result carries the held-open note",
			);
			const cleanupDeadline = Date.now() + 6000;
			while (Date.now() < cleanupDeadline) {
				const lsClean = await h.call("list_sessions", {});
				if (!lsClean.details.sessions.some((s: any) => s.session_id === sid)) break;
				await sleep(150);
			}
		}

		// Second session: let the holder exit NATURALLY so the exit is silent
		// — the next list_sessions reaps it and reports it one final time with
		// exit info and shell_exited undefined (mirroring the exit_code/signal
		// convention). A kill_session would instead remove it outright (the
		// kill observed the exit), so it never appears as a reaped entry.
		const r2 = await h.call("exec_command", { cmd: "sleep 1 & echo done", yield_time_ms: 300, shell: "bash" });
		assert.ok(r2.details.note, "precondition: second session held open");
		const sid2 = r2.details.session_id;
		// Poll list_sessions until the holder exits naturally and the exit is
		// observed (reaped) — no fixed sleep, so a loaded runner cannot flake.
		let reaped: any;
		let reapedText = "";
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const lsNow = await h.call("list_sessions", {});
			reapedText = lsNow.content[0].text;
			reaped = lsNow.details.sessions.find((s: any) => s.session_id === sid2);
			if (reaped && !reaped.running) break;
			await sleep(150);
		}
		assert.ok(reaped, "exited session reported one final time");
		assert.equal(reaped.running, false);
		assert.equal(reaped.shell_exited, undefined, "reaped entries carry no shell_exited");
		assert.ok(!reapedText.includes("[shell exited]"), "no [shell exited] marker on reaped entries");
	});

	it("widget and picker mark held-open sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "sleep 5 & echo done", yield_time_ms: 400, shell: "bash" });
		assert.ok(r.details.note, "precondition: held open");
		const sid = r.details.session_id;
		// session_tree renders the widget above the editor.
		await h.emit("session_tree");
		const widget = h.uiEvents.widgets.find((w) => w.key === "runbg.sessions");
		assert.ok(widget, "widget rendered");
		assert.ok(widget.content?.some((l) => l.includes(HELD_MARKER)), "widget line marks the held-open state");
		// The /runbg-sessions picker shows the same marker.
		h.uiEvents.selectResponses.push(() => undefined); // cancel the picker
		await h.invokeCommand("runbg-sessions");
		const pickerOptions = h.uiEvents.selectCalls.at(-1);
		assert.ok(pickerOptions, "picker was opened");
		assert.ok(
			pickerOptions.some((label) => label.includes(HELD_MARKER)),
			"picker label marks the held-open session",
		);
		await h.call("kill_session", { session_id: sid });
	});

	it("runAbsoluteWait deadline-reached result carries the note (site 6)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "sleep 5 & echo done", yield_time_ms: 400, shell: "bash" });
		assert.ok(r.details.note, "precondition: held open");
		const p = await h.call("write_stdin", {
			session_id: r.details.session_id,
			yield_until: new Date(Date.now() + 600).toISOString(),
		});
		assert.equal(p.details.status, "running");
		assert.equal(p.details.wait_status, "absolute_deadline_reached");
		assert.ok(p.details.note, "deadline-reached result carries the note");
		await h.call("kill_session", { session_id: r.details.session_id });
	});

	it("runAbsoluteWait cancelled-before-deadline result carries the note (site 5)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "sleep 5 & echo done", yield_time_ms: 400, shell: "bash" });
		assert.ok(r.details.note, "precondition: held open");
		const p = await h.call(
			"write_stdin",
			{
				session_id: r.details.session_id,
				yield_until: new Date(Date.now() + 5000).toISOString(),
			},
			AbortSignal.timeout(250),
		);
		assert.equal(p.details.status, "running");
		assert.equal(p.details.wait_status, "cancelled");
		assert.ok(p.details.note, "cancelled absolute wait carries the note");
		await h.call("kill_session", { session_id: r.details.session_id });
	});
});

describe("wake contract on held-open sessions", { skip: IS_WINDOWS }, () => {
	it("an armed on_exit wake stays pending while the pipe is held, and disarm works", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", {
			cmd: "sleep 5 & echo done",
			yield_time_ms: 400,
			on_exit: "wake",
			shell: "bash",
		});
		const sid = r.details.session_id;
		assert.equal(r.details.completion_notification, "armed");
		assert.ok(r.details.note, "precondition: held open");
		// The wake is close-based: while the pipe is held the session has not
		// exited, so no completion can fire. Give any (wrong) wake a window.
		await sleep(400);
		assert.equal(
			h.sentMessages.filter((m) => m.options?.triggerTurn === true).length,
			0,
			"no wake fired while the pipe is held",
		);
		const ls = await h.call("list_sessions", {});
		const entry = ls.details.sessions.find((s: any) => s.session_id === sid);
		assert.equal(entry.wake_armed, true, "exit arm still armed");
		assert.equal(entry.shell_exited, true);
		// Disarm, then kill: the session exits, and no wake is delivered.
		const soe = await h.call("set_on_exit", { session_id: sid, on_exit: "none" });
		assert.ok(soe.details.status === "disarmed" || soe.details.status === "already_none");
		await h.call("kill_session", { session_id: sid });
		await sleep(200);
		assert.equal(
			h.sentMessages.filter((m) => m.options?.triggerTurn === true).length,
			0,
			"disarmed wake never fires",
		);
	});
});

describe("kill failure on a held-open session (POSIX)", { skip: IS_WINDOWS }, () => {
	it("kill_session fails against a setsid'd holder; the note is appended; wake eligibility restored", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// python3 os.setsid() creates a new session — the holder escapes the
		// shell's group, so kill(-pgid) lands on nothing once the shell exits.
		// The holder must outlive the kill grace (2s SIGTERM + 500ms SIGKILL)
		// plus any load stall between spawn and the kill call (a loaded CI
		// runner delayed the kill past a 6s holder on Node 24 macOS), hence
		// time.sleep(15). python3 is an assumed POSIX test dependency
		// (e2e-pty drives a REPL).
		const r = await h.call("exec_command", {
			cmd: 'python3 -c "import os,time; os.setsid(); time.sleep(15)" & echo done',
			yield_time_ms: 400,
			on_exit: "wake",
			shell: "bash",
		});
		const sid = r.details.session_id;
		assert.equal(r.details.completion_notification, "armed");
		assert.ok(r.details.note, "precondition: held open");
		// The kill cannot reach the holder: shell gone, group empty.
		const k = await h.call("kill_session", { session_id: sid });
		assert.equal(k.details.killed, false, "kill must fail against the escaped holder");
		assert.equal(k.details.running, true, "session stays registered");
		assert.ok(
			k.details.failure_message.includes(NOTE_HEAD),
			`kill failure carries the held-open note: ${k.details.failure_message}`,
		);
		assert.ok(k.content[0].text.includes("[kill failed]"), "kill-failed header intact");
		// Wake eligibility restored per the IV-0005 invariant.
		const ls = await h.call("list_sessions", {});
		const entry = ls.details.sessions.find((s: any) => s.session_id === sid);
		assert.equal(entry.wake_armed, true, "failed kill restores wake eligibility");
		// Disarm so the harness stays quiet when the holder exits on its own.
		await h.call("set_on_exit", { session_id: sid, on_exit: "none" });
	});
});
