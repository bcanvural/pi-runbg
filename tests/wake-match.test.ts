/**
 * Unit tests for the IV-0004 wake-on-output matching core (src/wake-match.ts).
 * Fully deterministic: hand-built transport units, no processes, clocks, or
 * harness — every case pushes bytes and asserts on matcher/ring state.
 *
 * The sanitize-edge cases assert that ring snapshots return RAW bytes
 * (including unterminated CSI sequences at either edge): sanitization is the
 * caller's job at flush time (output-safety.ts `sanitizeOutputText`, per
 * IV-0002), never the ring's — a sanitizing ring could only break the
 * false-delivery-only guarantee (IV-0004 § Semantics "Excerpt pipeline").
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	captureMatchWindow,
	encodedByteLength,
	foldAscii,
	IncrementalMatcher,
	MatchLineRing,
	validateMatchPattern,
} from "../src/wake-match.ts";
import { sanitizeOutputText } from "../src/output-safety.ts";
/** Encode a test string exactly as transport units arrive (UTF-8 bytes). */
function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Decode a snapshot back to a string for readable assertions. */
function str(view: Uint8Array): string {
	return new TextDecoder().decode(view);
}

describe("foldAscii", () => {
	it("folds A-Z to a-z and leaves everything else byte-identical", () => {
		assert.equal(foldAscii("READY"), "ready");
		assert.equal(foldAscii("ready"), "ready");
		assert.equal(foldAscii("Ready2Go"), "ready2go");
		assert.equal(foldAscii("already\nline"), "already\nline");
	});

	it("never changes the string length (offsets stay 1:1)", () => {
		for (const s of ["", "ready", "READY", "Ready", "É", "é", "ß", "münchen", "😀ok"]) {
			assert.equal(foldAscii(s).length, s.length, `length changed for ${JSON.stringify(s)}`);
		}
	});

	it("does not fold non-ASCII case pairs", () => {
		assert.equal(foldAscii("É"), "É");
		assert.equal(foldAscii("é"), "é");
		assert.equal(foldAscii("ÄÖÜ"), "ÄÖÜ");
	});
});

describe("encodedByteLength", () => {
	it("counts UTF-8 bytes, not code units", () => {
		assert.equal(encodedByteLength(""), 0);
		assert.equal(encodedByteLength("abc"), 3);
		assert.equal(encodedByteLength("é"), 2); // 1 code unit, 2 bytes
		assert.equal(encodedByteLength("😀"), 4); // 2 code units, 4 bytes
	});
});

describe("validateMatchPattern", () => {
	it("accepts the 1-byte lower bound", () => {
		assert.deepEqual(validateMatchPattern("x"), { ok: true });
	});

	it("accepts the 256-byte upper bound", () => {
		assert.deepEqual(validateMatchPattern("a".repeat(256)), { ok: true });
	});

	it("accepts a 256-byte multi-byte pattern at the boundary", () => {
		assert.deepEqual(validateMatchPattern("é".repeat(128)), { ok: true }); // 2 × 128 = 256
	});

	it("rejects the empty pattern", () => {
		const r = validateMatchPattern("");
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /empty/);
	});

	it("rejects patterns longer than 256 encoded bytes", () => {
		assert.equal(validateMatchPattern("a".repeat(257)).ok, false);
		assert.equal(validateMatchPattern("é".repeat(129)).ok, false); // 258 bytes
		assert.equal(validateMatchPattern("é".repeat(128) + "a").ok, false); // 257 bytes
	});

	it("rejects a lone high surrogate", () => {
		assert.equal(validateMatchPattern("\uD800").ok, false);
		assert.equal(validateMatchPattern("ab\uD800cd").ok, false);
	});

	it("rejects a high surrogate at the end of the string", () => {
		assert.equal(validateMatchPattern("tail\uD83D").ok, false);
	});

	it("rejects a lone low surrogate", () => {
		assert.equal(validateMatchPattern("\uDFFF").ok, false);
		assert.equal(validateMatchPattern("\uDC00x").ok, false);
	});

	it("rejects two high surrogates in a row", () => {
		assert.equal(validateMatchPattern("\uD800\uD800").ok, false);
	});

	it("accepts a complete surrogate pair", () => {
		assert.deepEqual(validateMatchPattern("\uD83D\uDE00"), { ok: true });
	});
});

describe("IncrementalMatcher", () => {
	it("matches mid-chunk with the case-insensitive default", () => {
		const m = new IncrementalMatcher("READY", false);
		assert.equal(m.matched, false);
		assert.equal(m.push(bytes("server ready on :3000\n")), true);
		assert.equal(m.matched, true);
	});

	it("matches a pattern split across a chunk boundary", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(bytes("serv")), false);
		assert.equal(m.push(bytes("er re")), false);
		assert.equal(m.push(bytes("ady")), true);
		assert.equal(m.matched, true);
	});

	it("matches a boundary match starting at the front of the carry", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(bytes("xxread")), false); // carry: "read"
		assert.equal(m.push(bytes("yx")), true); // match starts at carry[0]
	});

	it("matches a boundary match starting mid-carry", () => {
		const m = new IncrementalMatcher("abcab", false);
		assert.equal(m.push(bytes("qqabc")), false); // carry: "qabc"
		assert.equal(m.push(bytes("ab")), true); // "abcab" starts at carry[1]
	});

	it("does not match across a boundary when the bytes do not line up", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(bytes("brea")), false);
		assert.equal(m.push(bytes("zzz")), false);
		assert.equal(m.matched, false);
	});

	it("folds the stream as well as the pattern (uppercase banner, lowercase pattern)", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(bytes("Server READY on :3000")), true);
	});

	it("folds across a chunk boundary (READY vs ready split)", () => {
		const m = new IncrementalMatcher("READY", false);
		assert.equal(m.push(bytes("rea")), false);
		assert.equal(m.push(bytes("DY")), true);
	});

	it("case_sensitive: true matches only exact case", () => {
		const miss = new IncrementalMatcher("READY", true);
		assert.equal(miss.push(bytes("ready")), false);
		assert.equal(miss.matched, false);
		const hit = new IncrementalMatcher("READY", true);
		assert.equal(hit.push(bytes("READY")), true);
	});

	it("matches non-ASCII patterns byte-exactly with no fold (É ≠ é)", () => {
		const miss = new IncrementalMatcher("É", false);
		assert.equal(miss.push(bytes("é")), false);
		assert.equal(miss.matched, false);
		const hit = new IncrementalMatcher("É", false);
		assert.equal(hit.push(bytes("É")), true);
	});

	it("carries encoded bytes for multi-byte patterns (é is 2 bytes)", () => {
		const m = new IncrementalMatcher("é", false);
		assert.equal(m.push(new Uint8Array([0xc3])), false); // first byte of é
		assert.equal(m.matched, false);
		assert.equal(m.push(new Uint8Array([0xa9])), true); // completes é across the boundary
	});

	it("matches a non-ASCII pattern split mid-chunk and across chunks", () => {
		const m = new IncrementalMatcher("É", false);
		assert.equal(m.push(new Uint8Array([0xc3])), false);
		assert.equal(m.push(new Uint8Array([0x89, 0x20])), true); // "É" + space
	});

	it("matches a one-byte pattern", () => {
		const m = new IncrementalMatcher("R", false);
		assert.equal(m.push(bytes("ready")), true);
	});

	it("matches inside a longer word (documented containment false positive)", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(bytes("already")), true);
	});

	it("finds a match at the end of a large chunk", () => {
		const big = new Uint8Array(65536).fill(0x78); // 'x'
		big.set(bytes("ready"), big.length - 5);
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(big), true);
	});

	it("evicts stale carry bytes across many small pushes", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(bytes("a")), false);
		assert.equal(m.push(bytes("bc")), false);
		assert.equal(m.push(bytes("def")), false);
		assert.equal(m.push(bytes("ghi")), false); // carry is now "ghi"
		assert.equal(m.matched, false);
		assert.equal(m.push(bytes("rea")), false);
		assert.equal(m.push(bytes("dy")), true);
	});

	it("latches after the first match: later pushes are no-ops returning false", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(bytes("ready")), true);
		assert.equal(m.push(bytes("ready again")), false);
		assert.equal(m.push(new Uint8Array(0)), false);
		assert.equal(m.matched, true);
	});

	it("ignores empty pushes without matching or changing state", () => {
		const m = new IncrementalMatcher("ready", false);
		assert.equal(m.push(new Uint8Array(0)), false);
		assert.equal(m.matched, false);
		assert.equal(m.push(bytes("ready")), true);
	});

	it("throws on an invalid pattern in the constructor", () => {
		assert.throws(() => new IncrementalMatcher("", false), /empty/);
		assert.throws(() => new IncrementalMatcher("\uD800", false), /surrogate/);
		assert.throws(() => new IncrementalMatcher("a".repeat(257), false), /256/);
	});

	it("never mutates the pushed chunk while folding for case-insensitive matching", () => {
		const m = new IncrementalMatcher("ready", false);
		const chunk = bytes("Server READY on :3000");
		m.push(chunk);
		assert.equal(str(chunk), "Server READY on :3000"); // fold must copy, never write in place
	});

	it("CRLF translation: a pattern ending in LF never matches a CRLF-terminated PTY banner", () => {
		const m = new IncrementalMatcher("ready\n", false);
		assert.equal(m.push(bytes("Server ready\r\nnext")), false); // documented PTY caveat
		const m2 = new IncrementalMatcher("ready\r", false);
		assert.equal(m2.push(bytes("Server ready\r\nnext")), true); // CR pattern matches
	});
});

describe("captureMatchWindow", () => {
	it("keeps the match when it sits near the start of a >400-byte chunk (start-of-overrun)", () => {
		// The naive current-line tail would scroll the match out — the
		// position-aware window must contain it or containment could consume
		// on unrelated trailing text.
		const chunk = bytes("READY " + "x".repeat(1000));
		const pre = bytes("Server ");
		const window = captureMatchWindow(pre, chunk, 5, 5); // matchEnd = pre + "READY"
		assert.equal(str(window).includes("READY"), true, `window must contain the match: ${str(window)}`);
		assert.ok(window.length <= 400);
	});
	it("extends ±200 around the match to enclosing newlines, keeping whole lines in range", () => {
		const pre = bytes("line one\nServer lis");
		const chunk = bytes("tening on :3000\nline three\n");
		const matchEndInChunk = "tening".length; // "listening" ends there
		const window = captureMatchWindow(pre, chunk, matchEndInChunk, "listening".length);
		// The ±200 window reaches into both neighboring lines; line-bounding
		// keeps them WHOLE. The trailing terminator stays when the chunk fits
		// the window (boundary extension only walks outward to newlines).
		assert.equal(str(window), "line one\nServer listening on :3000\nline three\n");
	});

	it("captures a cross-chunk match whose needle spans the carry", () => {
		const pre = bytes("Server sta");
		const chunk = bytes("rted and up\n");
		const matcher = new IncrementalMatcher("started", false);
		assert.equal(matcher.push(pre), false);
		assert.equal(matcher.push(chunk), true);
		const window = captureMatchWindow(pre, chunk, matcher.matchEndInChunk, matcher.needleByteLength);
		assert.equal(str(window).includes("started"), true);
		assert.ok(window.length <= 400);
	});

	it("never cuts into the match when capping the window", () => {
		const pre = bytes("a".repeat(400));
		const chunk = bytes("READY" + "b".repeat(1000));
		const window = captureMatchWindow(pre, chunk, 5, 5, 400);
		assert.equal(str(window).includes("READY"), true);
		assert.ok(window.length <= 400);
	});
});

describe("excerpt sanitize-edge property (IV-0004 fail-closed guarantee)", () => {
	// Slice-edge sanitizer artifacts may only make an excerpt DIFFER from a
	// full-stream pass in the false-DELIVERY direction: an edge-truncated
	// slice sanitizes to text that is control-free and never a superstring
	// of the full-stream pass. When an artifact survives (e.g. an
	// unterminated CSI introducer whose parameters remain as "[32m"), it
	// ADDS text, which can only loosen the containment check — delivery,
	// never spurious consumption (IV-0004 § Semantics "Excerpt pipeline").
	it("slice-edge artifacts are control-free and never a superstring of the full pass", () => {
		const full = "start \x1b[32mready\x1b[0m\nlistening on :3000 \x1b]8;;https://x\x07done";
		const sanitizedFull = sanitizeOutputText(full);
		const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/; // \n and \t are preserved by design
		for (let cut = 0; cut <= full.length; cut++) {
			for (const slice of [full.slice(0, cut), full.slice(cut)]) {
				if (slice.length === full.length) continue; // degenerate full-string slice
				const sanitized = sanitizeOutputText(slice);
				assert.ok(!control.test(sanitized), `slice at cut ${cut} leaked control bytes: ${JSON.stringify(sanitized)}`);
				assert.ok(
					!sanitized.includes(sanitizedFull),
					`slice at cut ${cut} sanitized to a superstring of the full pass: ${JSON.stringify(sanitized)}`,
				);
			}
		}
	});
});
describe("MatchLineRing", () => {
	it("keeps current-line context so a mid-line match is snapshot-able", () => {
		const ring = new MatchLineRing();
		ring.push(bytes("Server "));
		ring.push(bytes("listening on :3000"));
		assert.equal(str(ring.snapshot()), "Server listening on :3000");
	});

	it("defers the newline reset so a completed line is still snapshot-able", () => {
		const ring = new MatchLineRing();
		ring.push(bytes("line one\n"));
		assert.equal(str(ring.snapshot()), "line one\n"); // retained until the next push
		ring.push(bytes("line ")); // pending reset applies here
		assert.equal(str(ring.snapshot()), "line ");
		ring.push(bytes("two"));
		assert.equal(str(ring.snapshot()), "line two");
		ring.push(bytes("\nline three"));
		assert.equal(str(ring.snapshot()), "line two\nline three"); // whole chunk appended; reset deferred
		ring.push(bytes("!"));
		assert.equal(str(ring.snapshot()), "!"); // pending reset applied; the stale window is gone
	});

	it("keeps only the tail of an over-long line, still containing the match", () => {
		const ring = new MatchLineRing(400);
		ring.push(new Uint8Array(600).fill(0x78)); // 600 'x' bytes, no newline
		ring.push(bytes("MATCH"));
		const snap = ring.snapshot();
		assert.equal(snap.length, 400);
		assert.equal(str(snap.subarray(snap.length - 5)), "MATCH");
	});

	it("caps a single over-sized chunk to its tail", () => {
		const ring = new MatchLineRing(400);
		const chunk = new Uint8Array(500).fill(0x78);
		chunk[499] = 0x5a; // 'Z'
		ring.push(chunk);
		const snap = ring.snapshot();
		assert.equal(snap.length, 400);
		assert.equal(snap[399], 0x5a); // the tail survives
	});

	it("keeps the whole chunk when newlines land mid-chunk (reset deferred)", () => {
		const ring = new MatchLineRing();
		ring.push(bytes("a\nb\nc"));
		assert.equal(str(ring.snapshot()), "a\nb\nc");
		ring.push(bytes("\nd"));
		assert.equal(str(ring.snapshot()), "d"); // pending reset applied, whole chunk appended
	});

	it("retains a completed line for a same-tick freeze", () => {
		const ring = new MatchLineRing();
		ring.push(bytes("Server started\n"));
		assert.equal(str(ring.snapshot()), "Server started\n");
		ring.push(bytes("x"));
		assert.equal(str(ring.snapshot()), "x");
	});

	it("captures a line completed across chunks at the freeze point", () => {
		const ring = new MatchLineRing();
		ring.push(bytes("Server sta"));
		ring.push(bytes("rted\n"));
		assert.equal(str(ring.snapshot()), "Server started\n");
	});

	it("treats only 0x0a as the line separator (a lone CR does not reset)", () => {
		const ring = new MatchLineRing();
		ring.push(bytes("ab\rcd"));
		assert.equal(str(ring.snapshot()), "ab\rcd");
	});

	it("reset() clears the window and pushes after it work", () => {
		const ring = new MatchLineRing(400);
		ring.push(bytes("garbage"));
		ring.reset();
		assert.equal(ring.snapshot().length, 0);
		ring.push(bytes("fresh"));
		assert.equal(str(ring.snapshot()), "fresh");
	});

	it("snapshot returns a copy: later pushes cannot mutate a handed-out snapshot", () => {
		const ring = new MatchLineRing(400);
		ring.push(bytes("abc"));
		const snap = ring.snapshot();
		ring.push(bytes("def"));
		assert.equal(str(snap), "abc");
	});

	it("returns an unterminated CSI sequence raw — sanitization is the caller's job", () => {
		const ring = new MatchLineRing();
		ring.push(new Uint8Array([0x1b, 0x5b, 0x33, 0x32, 0x6d])); // ESC [ 3 2 m
		const snap = ring.snapshot();
		assert.deepEqual(Array.from(snap), [0x1b, 0x5b, 0x33, 0x32, 0x6d]);
		assert.equal(snap[0], 0x1b); // the raw ESC survives
	});

	it("keeps a CSI sequence split across pushes raw in the snapshot", () => {
		const ring = new MatchLineRing();
		ring.push(new Uint8Array([0x1b]));
		ring.push(new Uint8Array([0x5b, 0x33, 0x32, 0x6d]));
		assert.deepEqual(Array.from(ring.snapshot()), [0x1b, 0x5b, 0x33, 0x32, 0x6d]);
	});

	it("a zero-capacity ring always snapshots empty", () => {
		const ring = new MatchLineRing(0);
		ring.push(bytes("abc"));
		assert.equal(ring.snapshot().length, 0);
	});

	it("rejects a non-finite or negative maxBytes", () => {
		assert.throws(() => new MatchLineRing(-1), /maxBytes/);
		assert.throws(() => new MatchLineRing(NaN), /maxBytes/);
	});
});
