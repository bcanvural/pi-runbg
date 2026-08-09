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

	it("offers on/off/status plus every completable setting", () => {
		const h = makeHarness(["bash"]);
		const complete = h.commands.runbg.getArgumentCompletions!;
		assert.deepEqual(
			complete("").map((i: any) => i.value),
			["on", "off", "status", "replace-bash on", "replace-bash off", "steer on", "steer off"],
		);
		assert.deepEqual(
			complete("o").map((i: any) => i.value),
			["on", "off"],
		);
		assert.equal(complete("x"), null);
	});

	it("completion values are whole arguments (pi replaces the entire prefix)", () => {
		// CombinedAutocompleteProvider.applyCompletion substitutes the argument
		// text it passed in, so a bare "on" here would rewrite the user's
		// "/runbg replace-bash " to "/runbg on" — the wrong setting.
		const h = makeHarness(["bash"]);
		const complete = h.commands.runbg.getArgumentCompletions!;
		for (const prefix of ["replace", "replace-bash", "replace-bash "]) {
			assert.deepEqual(
				complete(prefix).map((i: any) => i.value),
				["replace-bash on", "replace-bash off"],
				`prefix ${JSON.stringify(prefix)}`,
			);
		}
		assert.deepEqual(
			complete("replace-bash o").map((i: any) => i.value),
			["replace-bash on", "replace-bash off"],
		);
	});
});

describe("/runbg replace-bash setting (divergence #1 without the startup flag)", () => {
	it("off by default: enabling runbg alone keeps pi's bash", async () => {
		const h = makeHarness(["bash", "read", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		await h.invokeCommand("runbg", "on");
		assert.ok(h.activeTools().includes("bash"), "bash must survive a plain /runbg on");
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).replaceBuiltinBash, false);
		await h.shutdown();
	});

	it("toggles bash removal mid-session and persists both directions", async () => {
		const h = makeHarness(["bash", "read", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		await h.invokeCommand("runbg", "on");

		await h.invokeCommand("runbg", "replace-bash on");
		assert.ok(!h.activeTools().includes("bash"), "replace-bash on must remove bash");
		assert.ok(h.activeTools().includes("exec_command"), "the session shell must stay");
		assert.ok(h.activeTools().includes("read"), "unrelated tools are untouched");
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).replaceBuiltinBash, true);
		assert.ok(h.notifications.at(-1)?.message.includes("replace-bash on"), JSON.stringify(h.notifications.at(-1)));

		await h.invokeCommand("runbg", "replace-bash off");
		assert.ok(h.activeTools().includes("bash"), "replace-bash off must restore the bash we removed");
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).replaceBuiltinBash, false);
		assert.ok(h.notifications.at(-1)?.message.includes("replace-bash off"));
		await h.shutdown();
	});

	it("applies a persisted replace-bash at session_start, with no flag involved", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true, replaceBuiltinBash: true }));
		const h = makeHarness(["bash", "read"]);
		await h.emit("session_start");
		assert.ok(!h.activeTools().includes("bash"));
		assert.ok(h.activeTools().includes("exec_command"));
		await h.shutdown();
	});

	it("is inert while runbg is disabled, and takes effect on the later /runbg on", async () => {
		const h = makeHarness(["bash", "read", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		await h.invokeCommand("runbg", "replace-bash on");
		assert.ok(h.activeTools().includes("bash"), "a dormant runbg must never leave pi shell-less");
		assert.ok(h.notifications.at(-1)?.message.includes("inert until /runbg on"), JSON.stringify(h.notifications.at(-1)));

		await h.invokeCommand("runbg", "on");
		assert.ok(!h.activeTools().includes("bash"), "enabling now applies the stored setting");
		// ...and disabling runbg gives the shell back even though the setting stays on.
		await h.invokeCommand("runbg", "off");
		assert.ok(h.activeTools().includes("bash"));
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).replaceBuiltinBash, true);
		await h.shutdown();
	});

	it("warns that --replace-builtin-bash overrules a saved off", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true, replaceBuiltinBash: true }));
		const h = makeHarness(["bash", "read", ...RUNBG_TOOLS], { flags: { "replace-builtin-bash": true } });
		await h.emit("session_start");
		assert.ok(!h.activeTools().includes("bash"));

		await h.invokeCommand("runbg", "replace-bash off");
		const last = h.notifications.at(-1)!;
		assert.equal(last.type, "warning", JSON.stringify(last));
		assert.ok(last.message.includes("--replace-builtin-bash"), last.message);
		assert.ok(!h.activeTools().includes("bash"), "the flag still forces removal");
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).replaceBuiltinBash, false, "the setting is still saved");
		await h.shutdown();
	});

	it("accepts the long alias, reports a bare setting name, and rejects a bad value", async () => {
		const h = makeHarness(["bash", ...RUNBG_TOOLS]);
		await h.emit("session_start");

		await h.invokeCommand("runbg", "replace-builtin-bash on");
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).replaceBuiltinBash, true, "alias must write the same key");

		await h.invokeCommand("runbg", "replace-bash");
		assert.ok(h.notifications.at(-1)?.message.includes("replace-bash is on"), JSON.stringify(h.notifications.at(-1)));

		await h.invokeCommand("runbg", "replace-bash yes");
		const bad = h.notifications.at(-1)!;
		assert.equal(bad.type, "warning");
		assert.ok(bad.message.includes("takes on|off"), bad.message);
		assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).replaceBuiltinBash, true, "a bad value must not write");
		await h.shutdown();
	});

	it("status reports the setting, and names the flag when it is the reason", async () => {
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true, replaceBuiltinBash: true }));
		const plain = makeHarness(["bash", ...RUNBG_TOOLS]);
		await plain.emit("session_start");
		await plain.invokeCommand("runbg", "status");
		assert.ok(plain.notifications.at(-1)?.message.includes("replace-bash: on"), JSON.stringify(plain.notifications.at(-1)));
		assert.ok(!plain.notifications.at(-1)!.message.includes("--replace-builtin-bash"));
		await plain.shutdown();

		writeFileSync(SETTINGS, JSON.stringify({ enabled: false, replaceBuiltinBash: false }));
		const flagged = makeHarness(["bash", ...RUNBG_TOOLS], { flags: { "replace-builtin-bash": true } });
		await flagged.emit("session_start");
		await flagged.invokeCommand("runbg", "status");
		const message = flagged.notifications.at(-1)!.message;
		assert.ok(message.includes("replace-bash: on (--replace-builtin-bash)"), message);
		assert.ok(message.includes("inert while disabled"), message);

		// The single-setting report must tell the same truth as `status`: the
		// stored value alone would claim "off" while bash is actually gone.
		await flagged.invokeCommand("runbg", "replace-bash");
		const single = flagged.notifications.at(-1)!.message;
		assert.ok(single.includes("replace-bash is on (--replace-builtin-bash)"), single);
		await flagged.shutdown();
	});

	it("keeps bash when the session shell it would trade for is not active", async () => {
		// exec_command is owned by another package's registration and inactive,
		// so gating leaves it alone — removing bash too would leave no shell.
		const foreign = { path: "/home/u/.pi/agent/node_modules/pi-unified-exec/src/index.ts" };
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true, replaceBuiltinBash: true }));
		const h = makeHarness(["bash", "read"], { allTools: [{ name: "exec_command", sourceInfo: foreign }] });
		await h.emit("session_start");
		assert.ok(!h.activeTools().includes("exec_command"), "foreign-won name must not be activated by us");
		assert.ok(h.activeTools().includes("bash"), "never leave pi shell-less");
		await h.shutdown();
	});

	it("says so when it cannot restore a bash it has no record of removing", async () => {
		// Mirrors a /reload: the setting is on and bash is already absent, so
		// the latch never fires and `off` cannot honestly restore anything.
		writeFileSync(SETTINGS, JSON.stringify({ enabled: true, replaceBuiltinBash: true }));
		const h = makeHarness(["read", ...RUNBG_TOOLS]);
		await h.emit("session_start");
		await h.invokeCommand("runbg", "replace-bash off");
		assert.ok(!h.activeTools().includes("bash"), "still never resurrects a bash it did not remove");
		assert.ok(h.notifications.at(-1)?.message.includes("no record of removing it"), JSON.stringify(h.notifications.at(-1)));
		await h.shutdown();
	});
});
