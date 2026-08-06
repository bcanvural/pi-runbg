/**
 * Unit tests for HeadTailBuffer.
 *
 * Mirrors codex's head_tail_buffer_tests.rs. Run with:
 *   node --import tsx --test tests/head-tail-buffer.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HeadTailBuffer } from "../src/head-tail-buffer.ts";
import { RollingTail } from "../src/session.ts";

function s(str: string): Uint8Array {
	return new TextEncoder().encode(str);
}

function render(buf: HeadTailBuffer): string {
	return new TextDecoder("utf-8").decode(buf.toBytes());
}

describe("HeadTailBuffer", () => {
	it("keeps prefix and suffix when over budget", () => {
		const buf = new HeadTailBuffer(10);

		buf.pushChunk(s("0123456789"));
		assert.equal(buf.omittedBytes, 0);

		// Exceeds max by 2; we should keep head+tail and omit the middle.
		buf.pushChunk(s("ab"));
		assert.ok(buf.omittedBytes > 0, `expected omitted > 0, got ${buf.omittedBytes}`);

		const rendered = render(buf);
		assert.ok(rendered.startsWith("01234"), `rendered=${rendered}`);
		assert.ok(rendered.endsWith("89ab"), `rendered=${rendered}`);
	});

	it("max_bytes zero drops everything", () => {
		const buf = new HeadTailBuffer(0);
		buf.pushChunk(s("abc"));

		assert.equal(buf.retainedBytes, 0);
		assert.equal(buf.omittedBytes, 3);
		assert.equal(render(buf), "");
		assert.deepEqual(buf.snapshotChunks(), []);
	});

	it("head budget zero keeps only last byte in tail", () => {
		const buf = new HeadTailBuffer(1);
		buf.pushChunk(s("abc"));

		assert.equal(buf.retainedBytes, 1);
		assert.equal(buf.omittedBytes, 2);
		assert.equal(render(buf), "c");
	});

	it("draining resets state", () => {
		const buf = new HeadTailBuffer(10);
		buf.pushChunk(s("0123456789"));
		buf.pushChunk(s("ab"));

		const drained = buf.drainChunks();
		assert.ok(drained.length > 0);

		assert.equal(buf.retainedBytes, 0);
		assert.equal(buf.omittedBytes, 0);
		assert.equal(render(buf), "");
	});

	it("chunk larger than tail budget keeps only tail end", () => {
		const buf = new HeadTailBuffer(10);
		buf.pushChunk(s("0123456789"));

		// Tail budget is 5 bytes. This chunk should replace the tail and keep only its last 5 bytes.
		buf.pushChunk(s("ABCDEFGHIJK"));

		const out = render(buf);
		assert.ok(out.startsWith("01234"), `out=${out}`);
		assert.ok(out.endsWith("GHIJK"), `out=${out}`);
		assert.ok(buf.omittedBytes > 0);
	});

	it("fills head then tail across multiple chunks", () => {
		const buf = new HeadTailBuffer(10);

		// Fill the 5-byte head budget across multiple chunks.
		buf.pushChunk(s("01"));
		buf.pushChunk(s("234"));
		assert.equal(render(buf), "01234");

		// Then fill the 5-byte tail budget.
		buf.pushChunk(s("567"));
		buf.pushChunk(s("89"));
		assert.equal(render(buf), "0123456789");
		assert.equal(buf.omittedBytes, 0);

		// One more byte causes the tail to drop its oldest byte.
		buf.pushChunk(s("a"));
		assert.equal(render(buf), "012346789a");
		assert.equal(buf.omittedBytes, 1);
	});

	it("ignores empty chunks", () => {
		const buf = new HeadTailBuffer(10);
		buf.pushChunk(new Uint8Array(0));
		assert.equal(buf.retainedBytes, 0);
		assert.equal(buf.omittedBytes, 0);
	});

	it("snapshot is non-destructive", () => {
		const buf = new HeadTailBuffer(20);
		buf.pushChunk(s("hello"));
		const snap1 = buf.snapshotChunks();
		const snap2 = buf.snapshotChunks();
		assert.equal(snap1.length, snap2.length);
		assert.equal(render(buf), "hello");
	});

	it("handles chunk that exactly fills head budget", () => {
		const buf = new HeadTailBuffer(10);
		buf.pushChunk(s("01234"));
		assert.equal(render(buf), "01234");
		assert.equal(buf.omittedBytes, 0);
		buf.pushChunk(s("56789"));
		assert.equal(render(buf), "0123456789");
		assert.equal(buf.omittedBytes, 0);
	});

	it("chunk spans head/tail boundary", () => {
		const buf = new HeadTailBuffer(10);
		// Head budget is 5; send a 7-byte chunk which should put 5 in head, 2 in tail.
		buf.pushChunk(s("0123456"));
		assert.equal(render(buf), "0123456");
		assert.equal(buf.omittedBytes, 0);
	});

	it("rejects negative max bytes", () => {
		assert.throws(() => new HeadTailBuffer(-1));
	});

	it("rejects NaN max bytes", () => {
		assert.throws(() => new HeadTailBuffer(NaN));
	});

	it("drainSegments preserves the head/tail split and omitted count, then resets", () => {
		const buf = new HeadTailBuffer(10); // 5 head + 5 tail
		buf.pushChunk(s("01234")); // head
		buf.pushChunk(s("XXXXXXXXXX")); // overflows tail: middle dropped
		buf.pushChunk(s("abcde")); // final tail
		const seg = buf.drainSegments();
		const headText = new TextDecoder().decode(Uint8Array.from(seg.head.flatMap((c) => [...c])));
		const tailText = new TextDecoder().decode(Uint8Array.from(seg.tail.flatMap((c) => [...c])));
		assert.equal(headText, "01234");
		assert.equal(tailText, "abcde");
		assert.ok(seg.omittedBytes > 0);
		// Drain resets everything.
		assert.equal(buf.retainedBytes, 0);
		assert.equal(buf.omittedBytes, 0);
		assert.deepEqual(buf.drainChunks(), []);
	});

	it("copies input so caller mutations do not affect state", () => {
		const buf = new HeadTailBuffer(10);
		const chunk = s("01234");
		buf.pushChunk(chunk);
		chunk[0] = 0x58; // 'X'
		// Our retained state should still see '0', not 'X'.
		assert.equal(render(buf), "01234");
	});
	// Representation regressions (the buffer is a byte ring, not a chunk array).

	// Load-bearing for collect.ts: it tests emptiness via segment count, so a
	// zero-length segment would make an empty drain look non-empty forever and
	// spin the drain loop synchronously until its deadline.
	it("never returns zero-length segments", () => {
		const buf = new HeadTailBuffer(64);
		assert.deepEqual(buf.drainSegments().head, []);
		assert.deepEqual(buf.drainSegments().tail, []);
		buf.pushChunk(s("abc"));
		const first = buf.drainSegments();
		assert.equal([...first.head, ...first.tail].every((c) => c.length > 0), true);
		// Drained state must be empty again, with no leftover empty slices.
		const second = buf.drainSegments();
		assert.equal(second.head.length + second.tail.length, 0);
		// Same after the tail ring has wrapped.
		const wrap = new HeadTailBuffer(8);
		for (let i = 0; i < 20; i++) wrap.pushChunk(s("xy"));
		wrap.drainSegments();
		const after = wrap.drainSegments();
		assert.equal(after.head.length + after.tail.length, 0);
	});

	it("keeps byte order across many ring wraps", () => {
		// tailBudget = 8; feed 3-byte chunks so writes straddle the wrap point.
		const buf = new HeadTailBuffer(16);
		let all = "";
		for (let i = 0; i < 40; i++) {
			const chunk = `${i % 10}${(i + 1) % 10}${(i + 2) % 10}`;
			all += chunk;
			buf.pushChunk(s(chunk));
		}
		const text = render(buf);
		// Head holds the first 8 bytes; the tail holds the last 8, in order.
		assert.equal(text.slice(0, 8), all.slice(0, 8), `head: ${text}`);
		assert.equal(text.slice(-8), all.slice(-8), `tail: ${text}`);
		assert.equal(buf.retainedBytes, 16);
		assert.equal(buf.omittedBytes, all.length - 16);
	});

	it("snapshots are stable across later pushes (no aliasing into the ring)", () => {
		const buf = new HeadTailBuffer(8);
		buf.pushChunk(s("AAAA"));
		buf.pushChunk(s("BBBB"));
		const snap = buf.snapshotChunks();
		const before = snap.map((c) => new TextDecoder().decode(c)).join("");
		// Overwrite the ring several times over.
		for (let i = 0; i < 10; i++) buf.pushChunk(s("ZZZZ"));
		assert.equal(snap.map((c) => new TextDecoder().decode(c)).join(""), before, "snapshot must not alias the ring");
	});

	it("does not allocate its budget until first use", () => {
		// 64 MiB budget: if allocation were eager this would be visible in heap.
		const before = process.memoryUsage().heapUsed;
		const bufs = Array.from({ length: 8 }, () => new HeadTailBuffer(64 * 1024 * 1024));
		const afterCreate = process.memoryUsage().heapUsed;
		assert.ok(
			afterCreate - before < 8 * 1024 * 1024,
			`8x64MiB budgets must not allocate on construction (grew ${afterCreate - before} bytes)`,
		);
		// Touching one allocates only that one's head slab.
		bufs[0]!.pushChunk(s("x"));
		assert.equal(bufs[0]!.retainedBytes, 1);
	});
	// Property test against a reference model. The ring is hand-written
	// arithmetic (wrap, eviction, clamp), so fuzz the invariants rather than
	// trusting hand-picked cases: for any push sequence,
	//   head    = first min(total, headBudget) bytes
	//   tail    = last min(rest, tailBudget) bytes of what follows the head
	//   omitted = total - retained
	it("matches a reference model across randomized push sequences", () => {
		// Deterministic PRNG so a failure is reproducible from the seed.
		let seed = 0x2f6e2b1;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const caps = [0, 1, 2, 3, 7, 8, 16, 31, 64];
		for (const cap of caps) {
			for (let trial = 0; trial < 40; trial++) {
				const buf = new HeadTailBuffer(cap);
				let all = "";
				const pushes = 1 + rand(12);
				for (let i = 0; i < pushes; i++) {
					// Chunk sizes deliberately straddle the budgets (0..2*cap+3).
					const len = rand(2 * cap + 4);
					let chunk = "";
					for (let j = 0; j < len; j++) chunk += String.fromCharCode(97 + rand(26));
					all += chunk;
					buf.pushChunk(s(chunk));
				}
				const headBudget = Math.floor(cap / 2);
				const tailBudget = Math.max(0, cap - headBudget);
				const expectedHead = all.slice(0, Math.min(all.length, headBudget));
				const rest = all.slice(expectedHead.length);
				const expectedTail = rest.length > tailBudget ? rest.slice(rest.length - tailBudget) : rest;
				const expected = expectedHead + expectedTail;
				const label = `cap=${cap} trial=${trial} total=${all.length}`;

				assert.equal(render(buf), expected, `content mismatch (${label})`);
				assert.equal(buf.retainedBytes, expected.length, `retained mismatch (${label})`);
				// The conservation invariant: nothing is invented or lost.
				assert.equal(
					buf.retainedBytes + buf.omittedBytes,
					all.length,
					`retained+omitted must equal pushed (${label})`,
				);
				// The head/tail split must land where the omission marker goes.
				const seg = buf.drainSegments();
				const headText = seg.head.map((c) => new TextDecoder().decode(c)).join("");
				const tailText = seg.tail.map((c) => new TextDecoder().decode(c)).join("");
				assert.equal(headText, expectedHead, `head segment mismatch (${label})`);
				assert.equal(tailText, expectedTail, `tail segment mismatch (${label})`);
				assert.equal(buf.retainedBytes, 0, `drain must reset (${label})`);
			}
		}
	});
});

describe("RollingTail", () => {
	// The TUI streaming window: keeps exactly the last `cap` bytes.
	it("matches a reference model across randomized append sequences", () => {
		let seed = 0x51ed270b;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		for (const cap of [0, 1, 2, 5, 8, 17, 64]) {
			for (let trial = 0; trial < 40; trial++) {
				const tail = new RollingTail(cap);
				let all = "";
				const appends = 1 + rand(12);
				for (let i = 0; i < appends; i++) {
					const len = rand(2 * cap + 4);
					let chunk = "";
					for (let j = 0; j < len; j++) chunk += String.fromCharCode(97 + rand(26));
					all += chunk;
					tail.append(s(chunk));
				}
				const expected = all.length > cap ? all.slice(all.length - cap) : all;
				assert.equal(
					new TextDecoder().decode(tail.snapshot()),
					expected,
					`cap=${cap} trial=${trial} total=${all.length}`,
				);
			}
		}
	});

	it("snapshot is stable across later appends and empty before any write", () => {
		const tail = new RollingTail(4);
		assert.equal(tail.snapshot().length, 0);
		tail.append(s("abcd"));
		const snap = tail.snapshot();
		tail.append(s("efgh"));
		assert.equal(new TextDecoder().decode(snap), "abcd", "snapshot must not alias the ring");
		assert.equal(new TextDecoder().decode(tail.snapshot()), "efgh");
	});
});
