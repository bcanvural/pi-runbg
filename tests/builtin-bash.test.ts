/**
 * Fork divergence #1 (UPSTREAM.md): pi's built-in `bash` tool stays active by
 * default; --replace-builtin-bash opts into upstream's codex-parity removal.
 * Also covers the startup warning when the upstream package
 * (pi-unified-exec) is installed alongside and registers the same tool names.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import extensionFactory from "../src/index.ts";

function makeHarness(
	opts: {
		flags?: Record<string, unknown>;
		activeTools?: string[];
		allTools?: Array<{ name: string; sourceInfo?: { path?: string } }>;
	} = {},
) {
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const registeredFlags: Record<string, { description?: string; default?: unknown }> = {};
	const setActiveToolsCalls: string[][] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const eventCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: () => {},
			setWidget: () => {},
		},
		hasUI: false,
	};
	const pi: any = {
		registerTool: () => {},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: (name: string, def: any) => {
			registeredFlags[name] = def;
		},
		registerMessageRenderer: () => {},
		getFlag: (name: string) => opts.flags?.[name],
		getActiveTools: () => opts.activeTools ?? ["bash", "read", "edit"],
		setActiveTools: (names: string[]) => setActiveToolsCalls.push(names),
	};
	if (opts.allTools) {
		pi.getAllTools = () => opts.allTools;
	}
	(extensionFactory as any)(pi);
	return {
		registeredFlags,
		setActiveToolsCalls,
		notifications,
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, eventCtx);
		},
		async shutdown() {
			await this.emit("session_shutdown");
		},
	};
}

describe("builtin bash divergence", () => {
	it("keeps pi's built-in bash by default (no setActiveTools call)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		assert.deepEqual(h.setActiveToolsCalls, []);
		await h.shutdown();
	});

	it("registers --replace-builtin-bash (and not upstream's --keep-builtin-bash)", () => {
		const h = makeHarness();
		assert.ok(h.registeredFlags["replace-builtin-bash"], "replace-builtin-bash flag missing");
		assert.equal(h.registeredFlags["replace-builtin-bash"].default, false);
		assert.equal(h.registeredFlags["keep-builtin-bash"], undefined, "upstream flag name must not be registered");
	});

	it("--replace-builtin-bash removes bash from the active tools", async () => {
		const h = makeHarness({ flags: { "replace-builtin-bash": true }, activeTools: ["bash", "read", "edit"] });
		await h.emit("session_start");
		assert.deepEqual(h.setActiveToolsCalls, [["read", "edit"]]);
		await h.shutdown();
	});

	it("--replace-builtin-bash is a no-op when bash is already absent", async () => {
		const h = makeHarness({ flags: { "replace-builtin-bash": true }, activeTools: ["read", "edit"] });
		await h.emit("session_start");
		assert.deepEqual(h.setActiveToolsCalls, []);
		await h.shutdown();
	});

	it("warns exactly once when pi-unified-exec registers the same tool names", async () => {
		const h = makeHarness({
			allTools: [
				{ name: "bash", sourceInfo: { path: "builtin" } },
				{
					name: "exec_command",
					sourceInfo: { path: "/home/u/.pi/agent/node_modules/pi-unified-exec/src/index.ts" },
				},
				{
					name: "write_stdin",
					sourceInfo: { path: "/home/u/.pi/agent/node_modules/pi-unified-exec/src/index.ts" },
				},
			],
		});
		await h.emit("session_start");
		await h.emit("session_start"); // reload — must not warn again
		const warnings = h.notifications.filter((n) => n.message.includes("pi-unified-exec"));
		assert.equal(warnings.length, 1, JSON.stringify(h.notifications));
		assert.equal(warnings[0].type, "warning");
		await h.shutdown();
	});

	it("does not warn for its own registrations or when getAllTools is unavailable", async () => {
		const own = makeHarness({
			allTools: [
				{ name: "exec_command", sourceInfo: { path: "/home/u/dev/pi-runbg/src/index.ts" } },
				{ name: "list_sessions", sourceInfo: { path: "/home/u/dev/pi-runbg/src/index.ts" } },
			],
		});
		await own.emit("session_start");
		assert.deepEqual(own.notifications, []);
		await own.shutdown();

		const noApi = makeHarness(); // harness without getAllTools at all
		await noApi.emit("session_start");
		assert.deepEqual(noApi.notifications, []);
		await noApi.shutdown();
	});
});
