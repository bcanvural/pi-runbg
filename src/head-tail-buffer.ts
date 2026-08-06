/**
 * A capped buffer that preserves a stable prefix ("head") and suffix ("tail"),
 * dropping the middle once it exceeds the configured maximum. The buffer is
 * symmetric: 50% of the capacity is allocated to the head and 50% to the tail.
 *
 * Port of codex's HeadTailBuffer (codex-rs/core/src/unified_exec/head_tail_buffer.rs),
 * matching its *representation* as well as its behavior: codex uses flat byte
 * containers (`head: Vec<u8>`, `tail: VecDeque<u8>`), so this holds two
 * preallocated `Uint8Array`s — the head plus a circular tail ring — instead of
 * an array of per-chunk views.
 *
 * That representation is load-bearing, not a style choice (measured):
 *
 * Measurement note for whoever re-checks this: the retained bytes now live in
 * large typed arrays, which V8 keeps OUTSIDE the scavenged heap, so
 * `process.memoryUsage().heapUsed` no longer reflects them at all — a probe
 * built on `heapUsed` will report the buffer as free whether it is or not. Use
 * `rss`/`external`.
 *
 *   - **Memory.** Per-chunk `Uint8Array`s cost ~150-230 B of object overhead
 *     each. A child writing 9-byte lines (an ordinary shell `echo` loop, or
 *     `python -u` progress output) filled a 1 MiB budget with ~116 k views:
 *     26 MiB of heap for 1 MiB of retained data, ~26x amplification. Flat
 *     containers make the footprint exactly the budget.
 *   - **Latency.** Trimming the old tail meant `Array.prototype.shift()` on a
 *     10 k-65 k element array per push: 26-158 µs per chunk. Because ingestion
 *     runs synchronously inside the child's `data` handler, that blocked pi's
 *     event loop — 3.25 MB of small-chunk output produced a single 1260 ms
 *     stall with 49% of wall time blocked, during which the host renders no
 *     frame, accepts no keystroke, and fires no timer (including other
 *     sessions' deadlines). The ring is O(chunk length) with no per-chunk
 *     allocation: ~50-100 ns regardless of chunk size.
 *
 * Ownership: bytes are copied IN on push (so later caller mutations cannot
 * poison retained state, matching codex's by-value semantics) and copied OUT
 * on drain/snapshot (so a returned slice cannot be overwritten by a later
 * push into the ring). Both copies are single `set()` memcpys into or out of
 * preallocated space.
 */

/** Result of `drainSegments()`: retained head/tail plus the dropped-middle count. */
export interface DrainedSegments {
	head: Uint8Array[];
	tail: Uint8Array[];
	omittedBytes: number;
}
export class HeadTailBuffer {
	readonly maxBytes: number;
	readonly headBudget: number;
	readonly tailBudget: number;
	/**
	 * Head region; bytes [0, headLen) are retained. The head slab is allocated
	 * on the first push and the ring on the first byte that reaches the tail,
	 * because `collect()` builds one of these per tool call.
	 *
	 * Be precise about what that buys: a call that drains NOTHING allocates
	 * nothing, but a call that drains even one byte commits the whole head
	 * budget (514 KiB at the production cap, measured ~18-26 µs against a
	 * ≥250 ms tool call). Those large typed arrays land in V8's large-object
	 * space — malloc/free rather than scavenged — so they cost page-zeroing,
	 * not GC pressure. Geometric growth was measured as an alternative and is
	 * a pessimization where it matters: ~0.8 µs for a small drain but ~83 µs
	 * for a budget-filling one, i.e. 14x worse for exactly the chatty sessions
	 * this representation exists to serve.
	 */
	private headBuf: Uint8Array | undefined;
	private headLen = 0;
	/** Circular tail ring holding `tailLen` bytes from `tailStart`. */
	private tailBuf: Uint8Array | undefined;
	private tailStart = 0;
	private tailLen = 0;
	private omittedBytesInternal = 0;

	/**
	 * Create a new buffer that retains at most `maxBytes` of output.
	 *
	 * The retained output is split across a prefix ("head") and suffix ("tail")
	 * budget, dropping bytes from the middle once the limit is exceeded.
	 */
	constructor(maxBytes: number) {
		if (!Number.isFinite(maxBytes) || maxBytes < 0) {
			throw new Error(`maxBytes must be a non-negative finite number (got ${maxBytes})`);
		}
		this.maxBytes = Math.floor(maxBytes);
		this.headBudget = Math.floor(this.maxBytes / 2);
		this.tailBudget = Math.max(0, this.maxBytes - this.headBudget);
	}

	/** Head slab, allocated on first use. */
	private head(): Uint8Array {
		this.headBuf ??= new Uint8Array(this.headBudget);
		return this.headBuf;
	}

	/** Tail ring, allocated on first use. */
	private tail(): Uint8Array {
		this.tailBuf ??= new Uint8Array(this.tailBudget);
		return this.tailBuf;
	}

	/** Total bytes currently retained by the buffer (head + tail). */
	get retainedBytes(): number {
		return this.headLen + this.tailLen;
	}

	/** Total bytes that were dropped from the middle due to the size cap. */
	get omittedBytes(): number {
		return this.omittedBytesInternal;
	}

	/**
	 * Append a chunk of bytes to the buffer.
	 *
	 * Bytes are first added to the head until the head budget is full; any
	 * remaining bytes are added to the tail, with older tail bytes being
	 * dropped to preserve the tail budget.
	 */
	pushChunk(chunk: Uint8Array): void {
		if (this.maxBytes === 0) {
			this.omittedBytesInternal += chunk.length;
			return;
		}
		if (chunk.length === 0) return;

		// Fill the head budget first, then keep a capped tail.
		if (this.headLen < this.headBudget) {
			const remainingHead = this.headBudget - this.headLen;
			if (chunk.length <= remainingHead) {
				this.head().set(chunk, this.headLen);
				this.headLen += chunk.length;
				return;
			}
			// Split the chunk: part goes to head, remainder goes to tail.
			this.head().set(chunk.subarray(0, remainingHead), this.headLen);
			this.headLen += remainingHead;
			this.pushToTail(chunk.subarray(remainingHead));
			return;
		}

		this.pushToTail(chunk);
	}

	/**
	 * Snapshot the retained output as a list of chunks (head then tail).
	 * Omitted bytes are not represented. Non-destructive.
	 */
	snapshotChunks(): Uint8Array[] {
		return [...this.headSegments(), ...this.tailSegments()];
	}

	/** Return the retained output as a single Buffer (head then tail). */
	toBytes(): Uint8Array {
		const out = new Uint8Array(this.retainedBytes);
		let offset = 0;
		for (const c of this.snapshotChunks()) {
			out.set(c, offset);
			offset += c.length;
		}
		return out;
	}

	/**
	 * Drain all retained chunks from the buffer and reset its state.
	 *
	 * The drained chunks are returned in head-then-tail order. Omitted bytes
	 * are discarded along with the retained content.
	 */
	drainChunks(): Uint8Array[] {
		const { head, tail } = this.drainSegments();
		return [...head, ...tail];
	}

	/**
	 * Drain the buffer preserving the head/tail split and the omitted-byte
	 * count, so callers can splice an omission marker at the exact position
	 * where middle bytes were dropped. Resets all state.
	 *
	 * Note: the returned segments are byte ranges, NOT the original write
	 * boundaries — head is at most one segment and tail at most two (a ring
	 * wrap). Callers only concatenate them, and the head/tail split (the one
	 * boundary that carries meaning, because the omission marker is spliced
	 * there) is preserved exactly.
	 */
	drainSegments(): DrainedSegments {
		const out: DrainedSegments = {
			head: this.headSegments(),
			tail: this.tailSegments(),
			omittedBytes: this.omittedBytesInternal,
		};
		this.headLen = 0;
		this.tailStart = 0;
		this.tailLen = 0;
		this.omittedBytesInternal = 0;
		return out;
	}

	/** Retained head as ≤1 owned segment. */
	private headSegments(): Uint8Array[] {
		// Zero-length segments are NEVER returned: callers use
		// `head.length + tail.length === 0` as their emptiness test, so an empty
		// slice here would make a drain look non-empty forever (see collect.ts).
		if (this.headLen === 0 || !this.headBuf) return [];
		return [copyOf(this.headBuf.subarray(0, this.headLen))];
	}

	/** Retained tail as ≤2 owned segments, in order (2 when the ring wraps). */
	private tailSegments(): Uint8Array[] {
		if (this.tailLen === 0 || !this.tailBuf) return [];
		const firstLen = Math.min(this.tailLen, this.tailBudget - this.tailStart);
		const first = copyOf(this.tailBuf.subarray(this.tailStart, this.tailStart + firstLen));
		if (firstLen === this.tailLen) return [first];
		return [first, copyOf(this.tailBuf.subarray(0, this.tailLen - firstLen))];
	}

	private pushToTail(bytes: Uint8Array): void {
		if (this.tailBudget === 0) {
			this.omittedBytesInternal += bytes.length;
			return;
		}

		if (bytes.length >= this.tailBudget) {
			// This single chunk is larger than the whole tail budget. Keep only the last
			// tailBudget bytes and drop everything else.
			const dropped = bytes.length - this.tailBudget;
			this.omittedBytesInternal += this.tailLen + dropped;
			this.tail().set(bytes.subarray(dropped));
			this.tailStart = 0;
			this.tailLen = this.tailBudget;
			return;
		}

		// Evict exactly as many oldest bytes as needed to fit, then append.
		const free = this.tailBudget - this.tailLen;
		if (bytes.length > free) {
			const drop = bytes.length - free;
			this.tailStart = (this.tailStart + drop) % this.tailBudget;
			this.tailLen -= drop;
			this.omittedBytesInternal += drop;
		}
		const ring = this.tail();
		const writeAt = (this.tailStart + this.tailLen) % this.tailBudget;
		const firstLen = Math.min(bytes.length, this.tailBudget - writeAt);
		ring.set(bytes.subarray(0, firstLen), writeAt);
		if (firstLen < bytes.length) {
			ring.set(bytes.subarray(firstLen), 0);
		}
		this.tailLen += bytes.length;
	}
}

function copyOf(view: Uint8Array): Uint8Array {
	// Produce an owned copy so later ring writes cannot mutate handed-out data.
	const out = new Uint8Array(view.length);
	out.set(view);
	return out;
}
