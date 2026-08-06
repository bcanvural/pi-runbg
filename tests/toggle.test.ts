/**
 * Divergence #5 (UPSTREAM.md, design §14): the session tools ship dormant and
 * `/runbg` is the extension's settings command — `on`/`off` (persisted in
 * <agentDir>/runbg.json) is the first setting; the file is a namespace, so
 * unknown keys must survive round-trips.
 *
 * The whole file pins PI_CODING_AGENT_DIR to a temp dir: settings reads must
 * never depend on the developer's real ~/.pi/agent/runbg.json.
 */

import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import { useIsolatedAgentEnv } from "./helpers/agent-env.ts";
import { trackHarness, useHarnessCleanup } from "./helpers/harness-cleanup.ts";

const { settingsPath: SETTINGS } = useIsolatedAgentEnv();
// Anti-hang net: shut every spawned harness down after each test (see helper).
useHarnessCleanup();
beforeEach(() => {
	rmSync(SETTINGS, { force: true });
});

const RUNBG_TOOLS = ["exec_command", "write_stdin", "set_on_exit", "kill_session", "list_sessions"];

function makeHarness(
	initialActive: string[],
	opts: { flags?: Record<string, unknown>; allTools?: Array<{ name: string; sourceInfo?: { path?: string } }> } = {},
) {
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { description?: string; getArgumentCompletions?: (p: string) => any; handler: (args: string, ctx: any) => Promise<void> }> = {};
	const notifications: Array<{ message: string; type?: string }> = [];
	const setActiveToolsCalls: string[][] = [];
	let active = [...initialActive];
	const stubCtx = {
		cwd: process.cwd(),
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }), setStatus: () => {}, setWidget: () => {} },
		hasUI: false,
	};
	const pi: any = {
		registerTool: () => {},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: (name: string) => opts.flags?.[name],
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			setActiveToolsCalls.push([...names]);
			active = [...names];
		},
		sendMessage: () => {},
	};
	if (opts.allTools) {
		pi.getAllTools = () => opts.allTools;
	}
	(extensionFactory as any)(pi);
	return trackHarness({
		commands,
		notifications,
		setActiveToolsCalls,
		activeTools: () => [...active],
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
		async invokeCommand(name: string, args = "") {
			return commands[name].handler(args, stubCtx);
		},
		async shutdown() {
			await this.emit("session_shutdown");
		},
	});
}

describe("/runbg settings command", () => {
	it("ships dormant: session_start deactivates the session tools when no settings exist", async () => {
		const h = makeHarness(["bash", "read", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		for (const name of RUNBG_TOOLS) assert.ok(!h.activeTools().includes(name), `${name} must be inactive`);
		assert.ok(h.activeTools().includes("bash"), "bash stays");
		await h.shutdown();
	});

	it("stays active at session_start when settings say enabled", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true }));
		const h = makeHarness(["bash", "read"]);
		await h.emit("session_start");
		for (const name of RUNBG_TOOLS) assert.ok(h.activeTools().includes(name), `${name} must be active`);
		await h.shutdown();
	});

	it("treats a corrupt settings file as disabled", async () => {
		writeFileSync(SETTINGS, "{not json");
		const h = makeHarness(["bash", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		assert.ok(!h.activeTools().includes("exec_command"));
		await h.shutdown();
	});

	it("/runbg on activates the tools and persists; /runbg off reverses both", async () => {
		const h = makeHarness(["bash", "read", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		assert.ok(!h.activeTools().includes("exec_command"));

		await h.invokeCommand("runbg", "on");
		assert.ok(h.activeTools().includes("exec_command"), "on must activate");
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).enabled, true);
		assert.ok(h.notifications.at(-1)?.message.includes("enabled"), JSON.stringify(h.notifications));

		await h.invokeCommand("runbg", "off");
		assert.ok(!h.activeTools().includes("exec_command"), "off must deactivate");
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).enabled, false);
		assert.ok(h.notifications.at(-1)?.message.includes("disabled"));

		await h.invokeCommand("runbg", "on"); // idempotence messages
		await h.invokeCommand("runbg", "on");
		assert.ok(h.notifications.at(-1)?.message.includes("already enabled"));
		await h.shutdown();
	});

	it("preserves unknown settings keys across writes (settings file is a namespace)", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: false, future_setting: 42 }));
		const h = makeHarness(["bash", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		await h.invokeCommand("runbg", "on");
		const parsed = JSON.parse(readFileSync(SETTINGS, "utf8"));
		assert.equal(parsed.enabled, true);
		assert.equal(parsed.future_setting, 42, "unknown keys must survive round-trips");
		await h.shutdown();
	});

	it("status and no-arg report state without changing it; unknown args warn", async () => {
		const h = makeHarness(["bash", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		await h.invokeCommand("runbg", "status");
		assert.ok(h.notifications.at(-1)?.message.includes("disabled"));
		await h.invokeCommand("runbg", "");
		assert.ok(h.notifications.at(-1)?.message.includes("disabled"));
		assert.ok(!h.activeTools().includes("exec_command"), "status must not enable");

		await h.invokeCommand("runbg", "bogus");
		const last = h.notifications.at(-1)!;
		assert.equal(last.type, "warning");
		assert.ok(last.message.includes("unknown setting"));
		await h.shutdown();
	});

	it("mid-session /runbg off restores the bash WE removed (--replace-builtin-bash)", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true }));
		const h = makeHarness(["bash", "read", ...RUNBG_TOOLS], { flags: { "replace-builtin-bash": true } });
		await h.emit("session_start");
		assert.ok(!h.activeTools().includes("bash"), "enabled+flag removes bash at start");
		assert.ok(h.activeTools().includes("exec_command"));

		await h.invokeCommand("runbg", "off");
		assert.ok(h.activeTools().includes("bash"), "off must restore the bash we removed");
		assert.ok(!h.activeTools().includes("exec_command"), "off must deactivate session tools");

		await h.invokeCommand("runbg", "on");
		assert.ok(!h.activeTools().includes("bash"), "on re-removes bash while the flag is set");
		assert.ok(h.activeTools().includes("exec_command"));
		await h.shutdown();
	});

	it("never resurrects a bash it did not remove (latch negative)", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true }));
		// bash absent from the start — someone else disabled it.
		const h = makeHarness(["read", ...RUNBG_TOOLS], { flags: { "replace-builtin-bash": true } });
		await h.emit("session_start");
		assert.ok(!h.activeTools().includes("bash"));
		await h.invokeCommand("runbg", "off");
		assert.ok(!h.activeTools().includes("bash"), "off must not add a bash we never removed");
		await h.shutdown();
	});

	it("/runbg on re-applies gating even when another process already enabled the setting", async () => {
		const h = makeHarness(["bash", ...RUNBG_TOOLS]);
		await h.emit("session_start"); // no settings file → dormant
		assert.ok(!h.activeTools().includes("exec_command"));

		writeFileSync(SETTINGS, JSON.stringify({ enabled: true })); // flipped by "another window"
		await h.invokeCommand("runbg", "on");
		assert.ok(h.activeTools().includes("exec_command"), "on must activate tools in THIS session too");
		assert.ok(h.notifications.at(-1)?.message.includes("already enabled"), JSON.stringify(h.notifications.at(-1)));
		await h.shutdown();
	});

	it("leaves tool names alone when another package's registration won them", async () => {
		const foreign = { path: "/home/u/.pi/agent/node_modules/pi-unified-exec/src/index.ts" };
		const allTools = [
			{ name: "exec_command", sourceInfo: foreign },
			...RUNBG_TOOLS.filter((n) => n !== "exec_command").map((name) => ({
				name,
				sourceInfo: { path: "/nonexistent/pi-runbg/src/index.ts" },
			})),
		];
		// Note: our four use a non-self path too — but ownsToolName treats only
		// *listed* names as gated-by-ownership; exec_command must be skipped.
		writeFileSync(SETTINGS, JSON.stringify({ enabled: false }));
		const h = makeHarness(["bash", ...RUNBG_TOOLS], { allTools });
		await h.emit("session_start");
		assert.ok(h.activeTools().includes("exec_command"), "foreign-won name must not be deactivated");
		await h.shutdown();
	});

	it("offers on/off/status argument completions", () => {
		const h = makeHarness(["bash"]);
		const complete = h.commands.runbg.getArgumentCompletions!;
		assert.deepEqual(
			complete("").map((i: any) => i.value),
			["on", "off", "status"],
		);
		assert.deepEqual(
			complete("o").map((i: any) => i.value),
			["on", "off"],
		);
		assert.equal(complete("x"), null);
	});
});
