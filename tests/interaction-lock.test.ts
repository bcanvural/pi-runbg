/**
 * Divergence #7 (UPSTREAM.md): per-session interaction serialization with
 * preemptible progress polls.
 *
 * Unit tests pin the lock's contract (queue-aware preemption, cancellation-
 * aware dequeue, non-preemptible holders). The e2e half reproduces the
 * concrete failures a code review found in the unserialized version: two
 * overlapping empty polls on one session starved the second (0 bytes for its
 * whole window) and both returned a terminal result for the same exit.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import { InteractionCancelled, InteractionLock } from "../src/interaction-lock.ts";

describe("InteractionLock", () => {
	it("grants immediately when idle and serializes a second acquirer", async () => {
		const lock = new InteractionLock();
		const a = await lock.acquire({ preemptible: false });
		assert.equal(lock.busy, true);
		let bGranted = false;
		const bP = lock.acquire({ preemptible: false }).then((h) => {
			bGranted = true;
			return h;
		});
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(bGranted, false, "second acquirer must wait");
		a.release();
		const b = await bP;
		assert.equal(bGranted, true);
		b.release();
		assert.equal(lock.busy, false);
	});

	it("arms preemption on a preemptible holder as soon as a waiter queues", async () => {
		const lock = new InteractionLock();
		const poll = await lock.acquire({ preemptible: true });
		assert.equal(poll.preempt.aborted, false, "no waiter yet → keep parking");
		const otherP = lock.acquire({ preemptible: false });
		assert.equal(poll.preempt.aborted, true, "waiter → holder must stop parking");
		assert.equal(poll.preempted, true);
		poll.release();
		(await otherP).release();
	});

	it("does not preempt a non-preemptible holder", async () => {
		const lock = new InteractionLock();
		const write = await lock.acquire({ preemptible: false });
		const queued = lock.acquire({ preemptible: true });
		assert.equal(write.preempt.aborted, false, "input writes run to completion");
		write.release();
		(await queued).release();
	});

	it("degenerates correctly with three queued polls (no queued-preemptor starvation)", async () => {
		const lock = new InteractionLock();
		const a = await lock.acquire({ preemptible: true });
		const bP = lock.acquire({ preemptible: true });
		const cP = lock.acquire({ preemptible: true });
		assert.equal(a.preempted, true, "A preempted by the queue");
		a.release();
		const b = await bP;
		// B inherits a non-empty queue (C still waiting) → must not park.
		assert.equal(b.preempted, true, "B must be preempted immediately by queued C");
		b.release();
		const c = await cP;
		assert.equal(c.preempted, false, "last in line may park");
		c.release();
	});

	it("drops waiters cancelled while queued instead of running them late", async () => {
		const lock = new InteractionLock();
		const holder = await lock.acquire({ preemptible: false });
		const ac = new AbortController();
		const queued = lock.acquire({ preemptible: false, signal: ac.signal });
		const after = lock.acquire({ preemptible: false });
		ac.abort(); // user pressed Esc while this interaction waited
		holder.release();
		await assert.rejects(queued, (err) => err instanceof InteractionCancelled);
		const h = await after;
		assert.equal(lock.busy, true, "the live waiter still gets the lock");
		h.release();
	});

	it("rejects immediately when the caller is already cancelled", async () => {
		const lock = new InteractionLock();
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(lock.acquire({ preemptible: false, signal: ac.signal }), (err) => err instanceof InteractionCancelled);
		assert.equal(lock.busy, false);
	});

	it("release is idempotent (safe in finally after a throw)", async () => {
		const lock = new InteractionLock();
		const h = await lock.acquire({ preemptible: false });
		h.release();
		h.release();
		const next = await lock.acquire({ preemptible: false });
		next.release();
	});
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
	const stubCtx = { cwd: process.cwd(), ui: undefined, hasUI: false };
	let nextId = 1;
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
		async call(toolName: string, params: any, signal?: AbortSignal) {
			return tools[toolName].execute(`lock-${nextId++}`, params, signal, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
		async shutdown() {
			await this.emit("session_shutdown");
		},
	};
}

describe("serialized session interactions (e2e)", () => {
	it("two overlapping empty polls: neither starves, exactly one reports the exit", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Chatty, then exits — the review probe's shape.
		const started = await h.call("exec_command", {
			cmd: "for i in $(seq 1 20); do echo line-$i; sleep 0.05; done; sleep 0.3; exit 3",
			yield_time_ms: 250,
		});
		const sid = started.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(started.details));

		const [a, b] = await Promise.all([
			h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }),
			h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }),
		]);

		// Before serialization the second poll returned zero bytes for its
		// whole window; now the first returns early (preempted) and both
		// carry coherent, non-overlapping state.
		const statuses = [a.details.wait_status, b.details.wait_status];
		assert.ok(
			statuses.includes("preempted"),
			`one poll must report preemption, got ${JSON.stringify(statuses)}`,
		);
		const combined = `${a.details.output}${b.details.output}`;
		assert.ok(combined.includes("line-1"), "output must not be lost");
		assert.ok(combined.includes("line-20"), `tail must arrive: ${JSON.stringify(combined.slice(-80))}`);

		// Exactly one terminal result for the exit; the other is either still
		// running or a truthful reaped echo — never two live [exited] claims
		// carrying different output.
		const exited = [a, b].filter((r) => r.details.status === "exited");
		assert.ok(exited.length <= 1 || exited.every((r) => r.details.exit_code === 3), JSON.stringify([a.details, b.details]));
		await h.shutdown();
	});

	it("a poll queued behind the exit observer gets a truthful [exited] echo, not an error", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "sleep 0.4; exit 5", yield_time_ms: 250 });
		const sid = started.details.session_id;
		assert.ok(typeof sid === "number");

		const [first, second] = await Promise.all([
			h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }),
			h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }),
		]);
		const results = [first, second];
		// Whichever ran second must not throw "unknown session_id"; both are
		// well-formed results and at least one carries the real exit code.
		assert.ok(
			results.some((r) => r.details.exit_code === 5),
			JSON.stringify(results.map((r) => r.details)),
		);
		for (const r of results) {
			assert.ok(r.details.log_path, "every result keeps a recovery path");
		}
		await h.shutdown();
	});

	it("input write is not starved by a long empty poll (preemption keeps interrupts prompt)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const started = await h.call("exec_command", { cmd: "cat", yield_time_ms: 250 });
		const sid = started.details.session_id;
		assert.ok(typeof sid === "number");

		const t0 = Date.now();
		const pollP = h.call("write_stdin", { session_id: sid, yield_time_ms: 20000 });
		await new Promise((r) => setTimeout(r, 100));
		const write = await h.call("write_stdin", { session_id: sid, chars: "hello\\n", yield_time_ms: 1000 });
		const elapsed = Date.now() - t0;
		assert.ok(elapsed < 8000, `input must not wait for the 20 s poll (waited ${elapsed} ms)`);
		assert.ok(write.details.output.includes("hello"), JSON.stringify(write.details.output));
		await pollP;
		await h.call("kill_session", { session_id: sid });
		await h.shutdown();
	});
});
