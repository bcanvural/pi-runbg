/**
 * Pure matching core for IV-0004 "wake on output pattern" (readiness wake):
 * `IncrementalMatcher` scans the pushed stream for a literal pattern and
 * `MatchLineRing` keeps the bounded current-line context the flush-time
 * excerpt pipeline reads from. No I/O and no session state live here — the
 * session data handler feeds transport units in (wave 2 wiring) and reads
 * the results back out.
 *
 * Why bytes: pipe mode forwards raw `Buffer` bytes, and the PTY path is
 * already decode → `TextEncoder`-reconstructed (`src/pty.ts:242-244`), so
 * the matcher sees the same units the data handler emits (IV-0004
 * § Semantics "Match domain follows the transport"). A JS code-unit count
 * is wrong for non-ASCII carry math (`é` is 1 code unit but 2 UTF-8
 * bytes), so pattern bounds and the carry are defined in encoded bytes
 * throughout.
 *
 * Why an ASCII-only fold: the default is case-insensitive, but `foldAscii`
 * maps A–Z ↔ a–z and nothing else. It is length-preserving, so match
 * offsets map 1:1 to stream offsets and excerpt extraction stays trivial,
 * and it needs no UTF-8 decode machinery. Non-ASCII patterns match
 * byte-exact and the caveat is documented (É ≠ é; IV-0004 § Semantics
 * "Case-insensitive by default, ASCII-only fold").
 *
 * Why literal scans instead of regex: model-supplied regex is a ReDoS
 * vector and Node ships no RE2 (IV-0004 Non-goals "No regex in v1 — literal
 * substring only"). Every scan here is a deterministic byte comparison;
 * worst case per push is O(chunk bytes × pattern bytes) with the pattern
 * capped at 256 bytes.
 *
 * Sanitization is NOT this module's job. Ring snapshots are raw stream
 * bytes and may contain unterminated CSI/OSC/DCS sequences at either edge;
 * per IV-0002 the caller sanitizes excerpt text with output-safety.ts's
 * `sanitizeOutputText` at flush time. Fold is likewise a matcher concern
 * only: the excerpt is the sanitized stream slice, never case-folded
 * (IV-0004 § Semantics "Excerpt pipeline").
 */

/** Shared UTF-8 encoder for pattern bounds and needle encoding. */
const patternEncoder = new TextEncoder();

/**
 * ASCII case fold, length-preserving: A–Z ↔ a–z, everything else
 * byte-identical (code-unit-identical). Never changes string length, so
 * stream offsets stay 1:1 — which is what lets the matcher fold both the
 * pattern and the incoming stream without losing offset correspondence
 * (IV-0004 § Semantics "Case-insensitive by default, ASCII-only fold").
 */
export function foldAscii(text: string): string {
	let hasUpper = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0x41 && code <= 0x5a) {
			hasUpper = true;
			break;
		}
	}
	if (!hasUpper) return text;
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : text[i];
	}
	return out;
}

/** UTF-8 encoded byte length of `text` (TextEncoder), not the code-unit count. */
export function encodedByteLength(text: string): number {
	return patternEncoder.encode(text).length;
}

/**
 * Validate an `on_output.pattern` arm value (IV-0004 § Semantics "Pattern
 * bounds": 1–256 chars in encoded bytes, malformed surrogates rejected).
 * Wave 2 surfaces the error string to the model verbatim, so every message
 * states both the rule and what was received.
 */
export function validateMatchPattern(pattern: string): { ok: true } | { ok: false; error: string } {
	if (pattern.length === 0) {
		return { ok: false, error: "on_output.pattern must not be empty" };
	}
	for (let i = 0; i < pattern.length; i++) {
		const code = pattern.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			// High surrogate: must be immediately followed by a low surrogate.
			const next = i + 1 < pattern.length ? pattern.charCodeAt(i + 1) : 0;
			if (next < 0xdc00 || next > 0xdfff) {
				return {
					ok: false,
					error:
						`on_output.pattern contains an unpaired UTF-16 surrogate at code-unit index ${i} ` +
						`(0x${code.toString(16)}): use a complete surrogate pair or a plain character.`,
				};
			}
			i++; // skip the validated pair
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			// Low surrogate without a preceding high one (pairs were consumed above).
			return {
				ok: false,
				error:
					`on_output.pattern contains an unpaired UTF-16 surrogate at code-unit index ${i} ` +
					`(0x${code.toString(16)}): use a complete surrogate pair or a plain character.`,
			};
		}
	}
	const bytes = encodedByteLength(pattern);
	if (bytes > 256) {
		return {
			ok: false,
			error: `on_output.pattern is ${bytes} bytes when UTF-8 encoded; the limit is 256 bytes.`,
		};
	}
	return { ok: true };
}

/**
 * One-shot literal-substring matcher over transport units. The session data
 * handler pushes `Uint8Array` chunks in both pipes and PTY modes (IV-0004
 * § Semantics "Matching runs in the push path"); the matcher folds, scans,
 * and latches on the first match.
 *
 * ### Carry math
 *
 * A match split across a chunk boundary starts inside the final
 * `needle.length − 1` bytes of previously pushed content and ends with at
 * least one byte of the current chunk (a match fully inside earlier content
 * would have fired on an earlier push). The carry therefore holds exactly
 * the last `encodedBytes(foldedPattern) − 1` stream bytes between pushes,
 * and each push scans (a) match starts inside the carry that end in the new
 * chunk, then (b) the new chunk in full. The carry is a fixed slab
 * allocated once at construction — `push()` never grows it.
 *
 * ### Case folding
 *
 * When `caseSensitive` is false, the pattern is folded once at construction
 * AND each pushed chunk is ASCII-folded before scanning — the fold is
 * length-preserving on both sides, so folded offsets are still 1:1 with
 * stream offsets and excerpt extraction (which reads the raw ring, never
 * the folded stream) is unaffected. Non-ASCII bytes are never folded:
 * É ≠ é (documented caveat, IV-0004 § Semantics).
 *
 * ### One-shot latch
 *
 * The first match sets `matched` permanently; every later `push()` is a
 * no-op returning false (IV-0004 Non-goals "No repeated/multi-match wake").
 */
export class IncrementalMatcher {
	/** Folded pattern bytes — the needle. Immutable after construction. */
	private readonly needle: Uint8Array;
	/** Exact-case scans skip the stream-side fold (the needle is unfolded too). */
	private readonly caseSensitive: boolean;
	/** Last `needle.length - 1` folded stream bytes; `carryLen` of them are live. */
	private readonly carry: Uint8Array;
	private carryLen = 0;
	private matchedInternal = false;
	/** Exclusive end offset of the first match within the firing chunk; -1 before it fires. */
	private matchEndInternal = -1;

	constructor(pattern: string, caseSensitive: boolean) {
		const validation = validateMatchPattern(pattern);
		if (!validation.ok) {
			// Callers that want a friendly tool error validate first; this is
			// the belt-and-braces throw so an invalid arm can never silently
			// no-op its way past schema validation.
			throw new Error(validation.error);
		}
		this.caseSensitive = caseSensitive;
		this.needle = patternEncoder.encode(caseSensitive ? pattern : foldAscii(pattern));
		this.carry = new Uint8Array(this.needle.length - 1);
	}

	/** True after the first match; latched — a later push can never clear it. */
	get matched(): boolean {
		return this.matchedInternal;
	}

	/** Length of the encoded needle in bytes (the match span). */
	get needleByteLength(): number {
		return this.needle.length;
	}

	/**
	 * Exclusive end offset of the first match within the chunk that produced
	 * it (chunk coordinates, not stream coordinates). Valid only after
	 * `push` returned true; used by the session to capture a position-aware
	 * excerpt window around the match.
	 */
	get matchEndInChunk(): number {
		return this.matchEndInternal;
	}

	/**
	 * Append a chunk of transport bytes and scan for the pattern. Returns
	 * true exactly when this push produced the first match; after that every
	 * push is a no-op returning false (one-shot semantics).
	 */
	push(bytes: Uint8Array): boolean {
		if (this.matchedInternal || bytes.length === 0) return false;
		const needle = this.needle;
		const n = needle.length;
		const scan = this.foldChunk(bytes);

		// Cross-boundary candidates: matches starting inside the carry and
		// ending inside this chunk. A candidate needs at most
		// `n - prefixLen` bytes from the new chunk, so skip it only when the
		// chunk is too short to complete it (the carry part may legitimately
		// be longer than the chunk — that is the common case).
		for (let p = 0; p < this.carryLen; p++) {
			const prefixLen = this.carryLen - p;
			if (prefixLen < n - scan.length) continue;
			if (this.matchAcross(p, prefixLen, scan)) {
				this.matchedInternal = true;
				this.matchEndInternal = n - prefixLen;
				return true;
			}
		}

		// Match fully inside this chunk.
		const at = indexOfBytes(scan, needle, 0);
		if (at >= 0) {
			this.matchedInternal = true;
			this.matchEndInternal = at + n;
			return true;
		}

		// No match: roll the carry forward to the last n-1 folded bytes.
		const keep = n - 1;
		if (scan.length >= keep) {
			this.carry.set(scan.subarray(scan.length - keep));
			this.carryLen = keep;
		} else {
			const drop = Math.max(0, this.carryLen + scan.length - keep);
			if (drop > 0) this.carry.copyWithin(0, drop, this.carryLen);
			this.carryLen -= drop;
			this.carry.set(scan, this.carryLen);
			this.carryLen += scan.length;
		}
		return false;
	}

	/** ASCII-folded copy of the chunk when case-insensitive; the chunk itself otherwise. */
	private foldChunk(bytes: Uint8Array): Uint8Array {
		if (this.caseSensitive) return bytes;
		let hasUpper = false;
		for (let i = 0; i < bytes.length; i++) {
			const b = bytes[i];
			if (b >= 0x41 && b <= 0x5a) {
				hasUpper = true;
				break;
			}
		}
		if (!hasUpper) return bytes;
		const folded = new Uint8Array(bytes.length);
		for (let i = 0; i < bytes.length; i++) {
			const b = bytes[i];
			folded[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
		}
		return folded;
	}

	/** True when needle equals carry[p..carryLen) followed by the first needle.length - prefixLen bytes of `bytes`. */
	private matchAcross(p: number, prefixLen: number, bytes: Uint8Array): boolean {
		const needle = this.needle;
		for (let i = 0; i < prefixLen; i++) {
			if (this.carry[p + i] !== needle[i]) return false;
		}
		const rest = needle.length - prefixLen;
		for (let i = 0; i < rest; i++) {
			if (bytes[i] !== needle[prefixLen + i]) return false;
		}
		return true;
	}
}

/**
 * Position-aware excerpt window (IV-0004 § Semantics "Excerpt pipeline":
 * ±200-byte window around the match, extended to enclosing newlines, hard
 * cap 400 bytes total).
 *
 * `preContext` is the bounded context the ring held BEFORE the firing chunk
 * (the current-line tail; the carry bytes are its suffix, so a match that
 * starts in the carry is contiguous in the composed stream). `matchEndInChunk`
 * and `needleByteLength` come from the matcher that just fired. The window
 * always contains the full match — a naive current-line tail can scroll the
 * match out when it sits near the start of a >400-byte chunk, which would
 * let containment consume on unrelated trailing text.
 */
export function captureMatchWindow(
	preContext: Uint8Array,
	chunk: Uint8Array,
	matchEndInChunk: number,
	needleByteLength: number,
	maxBytes = 400,
): Uint8Array {
	const preLen = preContext.length;
	const matchEndAbs = preLen + matchEndInChunk;
	const matchStartAbs = matchEndAbs - needleByteLength;
	const half = Math.floor(maxBytes / 2);
	const at = (i: number): number => (i < preLen ? preContext[i] : chunk[i - preLen]);
	let start = Math.max(0, matchStartAbs - half);
	let end = Math.min(preLen + chunk.length, matchEndAbs + half);
	// Extend to enclosing newlines: start lands just after a `\n`, end just
	// before the next one (line-bounded, terminators excluded).
	while (start > 0 && at(start - 1) !== 0x0a) start--;
	while (end < preLen + chunk.length && at(end) !== 0x0a) end++;
	// Hard cap. Shrink the pre-match side first; never cut into the match.
	if (end - start > maxBytes) {
		start = Math.min(end - maxBytes, matchStartAbs);
		if (end - start > maxBytes) end = Math.max(start + maxBytes, matchEndAbs);
	}
	const out = new Uint8Array(end - start);
	for (let i = start; i < end; i++) out[i - start] = at(i);
	return out;
}


/**
 * Literal byte-subsequence scan (deliberately not regex — IV-0004 bans
 * model-supplied regex on ReDoS grounds). Naive O(m·n): the needle is at
 * most 256 bytes and pushes are transport-unit sized, and the scan only
 * runs while an arm is armed.
 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
	const n = needle.length;
	const first = needle[0];
	outer: for (let i = from; i <= haystack.length - n; i++) {
		if (haystack[i] !== first) continue;
		for (let j = 1; j < n; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

/**
 * Bounded current-line raw context for the flush-time excerpt pipeline
 * (IV-0004 § Semantics "Excerpt pipeline": ±200-byte window extended to
 * enclosing newlines, hard cap 400 bytes).
 *
 * ### Tail-keeping (pre-chunk context only)
 *
 * The ring is PRE-CHUNK CONTEXT for `captureMatchWindow`, not the excerpt
 * itself: the session pushes a chunk to the matcher FIRST and records it
 * here only when no match fired, so at fire time the snapshot is the
 * bounded context that PRECEDED the firing chunk — it may or may not
 * contain the match (a match near the start of a >400-byte chunk scrolls
 * out; the position-aware window rebuilds it from context + chunk). The
 * ring tracks the bytes since the last `\n` (0x0a) and keeps the TAIL
 * `maxBytes` of an over-long line.
 *
 * A newline does NOT clear the window immediately: the completed line is
 * retained until the next push's first byte, so the pre-chunk context at
 * a fire on the completing push still includes the completed line. The
 * reset is deferred to the next push, when new line content proves the
 * old line stale. Context is line-bounded best-effort: the window may
 * briefly include a completed previous line when a chunk ends mid-line
 * after a newline, and lines that outlive the cap keep only their tail —
 * both documented.
 *
 * State is one fixed slab used as a circular ring, allocated on first use:
 * `push()` performs no per-chunk allocation, and `reset()` reuses the slab.
 * `snapshot()` copies the window out, so the caller may freeze the result
 * and later pushes cannot mutate it.
 *
 * ### Raw bytes, by design
 *
 * The window is the raw stream slice — it can contain an unterminated
 * CSI/OSC/DCS sequence at either edge. The ring must not filter:
 * sanitization is the caller's job at flush time (output-safety.ts
 * `sanitizeOutputText`, per IV-0002), and slice-edge sanitizer artifacts
 * can only fail toward delivery (IV-0004 § Semantics "Excerpt pipeline").
 */
export class MatchLineRing {
	readonly maxBytes: number;
	/** Circular ring holding `len` bytes from `start`; allocated on first byte. */
	private buf: Uint8Array | undefined;
	private start = 0;
	private len = 0;
	/** The previous push completed a line; reset on the next push's first byte. */
	private pendingReset = false;

	constructor(maxBytes = 400) {
		if (!Number.isFinite(maxBytes) || maxBytes < 0) {
			throw new Error(`maxBytes must be a non-negative finite number (got ${maxBytes})`);
		}
		this.maxBytes = Math.floor(maxBytes);
	}

	/**
	 * completes the line but the window keeps it (with its terminator)
	 * until the next push — see the class doc: the ring is pre-chunk
	 * context for captureMatchWindow, not the excerpt itself. The next
	 * push then starts a fresh line.
	 */
	push(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		let start = 0;
		if (this.pendingReset) {
			this.clear();
			this.pendingReset = false;
			// The leading newlines are the line boundaries the deferred reset
			// was waiting for — skip them rather than carry empty lines.
			while (start < bytes.length && bytes[start] === 0x0a) start++;
		}
		if (start === bytes.length) return;
		let hasNl = false;
		for (let i = start; i < bytes.length; i++) {
			if (bytes[i] === 0x0a) {
				hasNl = true;
				break;
			}
		}
		this.appendTail(start === 0 ? bytes : bytes.subarray(start));
		this.pendingReset = hasNl;
	}

	/** Copy of the current window (raw bytes; caller may freeze it). */
	snapshot(): Uint8Array {
		const buf = this.buf;
		if (!buf || this.len === 0) return new Uint8Array(0);
		const out = new Uint8Array(this.len);
		const firstLen = Math.min(this.len, this.maxBytes - this.start);
		out.set(buf.subarray(this.start, this.start + firstLen), 0);
		if (firstLen < this.len) out.set(buf.subarray(0, this.len - firstLen), firstLen);
		return out;
	}

	/** Clear the window; the allocated slab is kept for reuse (bounded state). */
	reset(): void {
		this.clear();
		this.pendingReset = false;
	}

	private ring(): Uint8Array {
		this.buf ??= new Uint8Array(this.maxBytes);
		return this.buf;
	}

	private clear(): void {
		this.start = 0;
		this.len = 0;
	}

	/** Append bytes to the ring keeping only the tail `maxBytes` (evict oldest first). */
	private appendTail(bytes: Uint8Array): void {
		if (this.maxBytes === 0) return;
		if (bytes.length >= this.maxBytes) {
			// One chunk exceeds the window: the ring becomes the tail of this chunk.
			this.ring().set(bytes.subarray(bytes.length - this.maxBytes));
			this.start = 0;
			this.len = this.maxBytes;
			return;
		}
		const free = this.maxBytes - this.len;
		if (bytes.length > free) {
			const drop = bytes.length - free;
			this.start = (this.start + drop) % this.maxBytes;
			this.len -= drop;
		}
		const ring = this.ring();
		const writeAt = (this.start + this.len) % this.maxBytes;
		const firstLen = Math.min(bytes.length, this.maxBytes - writeAt);
		ring.set(bytes.subarray(0, firstLen), writeAt);
		if (firstLen < bytes.length) ring.set(bytes.subarray(firstLen), 0);
		this.len += bytes.length;
	}
}
