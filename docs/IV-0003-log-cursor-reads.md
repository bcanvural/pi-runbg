# IV-0003 — Cursor reads of the session log (scope, not yet implemented)

**Status:** scoped 2026-08-09; awaiting a go/no-go. Nothing in this document
is built. Prompted by oh-my-pi's `logs` op (`follow: true` waits for output
after `cursor`; reuse the returned cursor on the next call) and by asking what
runbg's equivalent is.

Read IV-0002 first; this proposal lives entirely inside its rules (bounded
results, sanitize-before-model, `log_path` owns complete-stream recovery).

## Problem

Live polling is already delta-based: `write_stdin` drains the session buffer,
so a poll never re-pays for bytes the model has seen. The buffer *is* the
cursor. That covers the common case and is why nothing here touches waiting.

What has no delta story is **historical** output — bytes that have left the
buffer:

1. **Beyond retention.** In-memory retention is 1 MiB head+tail per session; a
   chatty child drops the middle, and the omission marker points the model at
   `log_path`. But the only reader we offer for `log_path` is "the whole
   file". The marker sends the model somewhere it cannot affordably go.
2. **Across turns / after a wake.** A wake delivers bounded metadata, no
   output. By the next turn the buffer may have rolled; the model either
   re-reads the entire log through pi's `read` (line-oriented, unsanitized) or
   accepts the hole.
3. **Post-mortem after reap.** Sessions leave a 32-entry tombstone ring;
   logs persist for `PI_RUNBG_LOG_TTL_DAYS` (7 d). The log outlives every
   in-memory handle we have.

The cursor *value* already exists: `output_bytes_total` is cumulative stream
bytes since spawn, and while `log_status: "complete"` it equals the log file
length exactly (the mirror writes every byte the buffer sees). What is missing
is anything that *accepts* it.

## Options

### v0 — guidance only (~50 tokens, no code)

Document `output_bytes_total` as a resumable file offset and teach the ranged
read through the shell: `tail -c +N "$log_path" | head -c 50000`. Rejected as
the *only* answer for three reasons, kept as an interim line regardless:

- **Sanitization bypass.** The log is deliberately raw (IV-0002: "forensic
  bytes remain recoverable by path"). A PTY log contains live terminal
  control — clipboard writes, alternate-screen, cursor moves. Every in-memory
  path scrubs these through `output-safety.ts` before model text; a shell
  read pipes them straight into the transcript. The omission marker would be
  directing the model to re-open the one hole IV-0002 closed.
- Spawns a session per read (150 ms grace, cap pressure, lock traffic) to do
  what is semantically a 50 KiB `pread`.
- Requires unix tools and byte arithmetic done by the model.

### v1 — a sixth tool: `read_session_log` (recommended shape)

```
read_session_log({ log_path, offset_bytes?, limit_bytes? })
→ { output, next_offset, eof, file_bytes, truncated_log }
```

Pure, instant, idempotent slice of the on-disk log: `pread`-style read of
`[offset, offset+limit)`, UTF-8 boundary-adjusted, sanitized through
`output-safety.ts`, returned inside the standard bounded envelope with an
explicit renderer (IV-0002 requires all tools have one). `next_offset` is the
**raw file offset actually consumed** — never derived from sanitized-text
length, which differs. Repeat until `eof`.

### Deferred (explicitly out of v1)

- **`follow`/waiting — never.** Waiting is `write_stdin`'s job. One wait path
  means one steering integration, one preemption story, one place divergence
  #10 applies. A second blocking read would re-open every question rounds 1–2
  of the steering review just closed. This is an invariant, not a deferral.
- **`grep`.** Real token win on huge logs, but model-supplied regex is a ReDoS
  vector without RE2, and match accounting complicates the cursor. The shell
  covers it today (`grep -n pattern "$log_path"` emits no control bytes worth
  worrying about for *matching lines*… still unsanitized — revisit).
- **Tail mode** (`offset: -N`). Cheap, but every result envelope already
  carries the tail; the tool exists precisely for non-tail access. Default
  `offset_bytes: 0` for the same reason.

## Decisions forced during scoping

| Decision | Why |
|---|---|
| **Key by validated `log_path`, not `session_id`** | Session ids reset every pi session; logs persist 7 days. A stale id from a previous conversation would address a *different* process's log — silently wrong. `log_path` is in every result envelope and every tombstone, and is stable for the file's whole life. |
| **Path validation is a security boundary** | A tool that reads an arbitrary path is a general file reader that bypasses pi's read-permission surface. Accept only: resolved parent == canonical tmpdir, basename matches `^pi-runbg-\d+-[0-9a-f]+\.log$`, `lstat` says regular file (never follow a symlink — same reasoning as the `futimes`/`lutimes` heartbeat rule). |
| **Sanitize the slice, always** | IV-0002's core invariant: model/details/TUI text is terminal-inert; raw bytes live only in the file. |
| **Cursor arithmetic in raw bytes; UTF-8 boundaries adjusted at both edges** | Leading continuation bytes are skipped forward, a trailing partial code point is excluded and `next_offset` set to its start, so the next read re-includes it. Contiguity stays exact, no replacement chars, no double-read. |
| **Byte cap only (`limit_bytes` clamped to pi's `DEFAULT_MAX_BYTES`), no line cap** | A line cap would make `next_offset` depend on sanitized content — the classic cursor drift bug. The renderer's five-line collapse already bounds the visual cost; context cost is byte-bounded by construction. Divergence from the envelope's usual line cap, so say it loudly in code. |
| **Report `truncated_log`, and document the drift** | Past the `PI_RUNBG_MAX_LOG_BYTES` cap the mirror appends a truncation note *into the file* and stops; file offsets stop equaling stream offsets, and `output_bytes_total` keeps counting bytes the file never got. Status comes from the session/tombstone when one exists; a log from a previous pi run reports `unknown` and the in-file note carries the news. |
| **No interaction lock** | The read is idempotent and the mirror is append-only; concurrent append at worst shortens the slice, which the cursor absorbs. Locking would put a pure read in contention with live drains for no benefit. |

## Cost

- **Schema tax: ~150–220 tokens on every request, forever** (gated behind
  `/runbg on` like the other five). This is the real price and the main
  argument for v0-only; weigh it against the benchmark-style workload (long,
  chatty, multi-turn) where the middle of a log is routinely the part that
  matters.
- Implementation: ~200 lines src (tool + validation + boundary math +
  renderer), ~300 lines tests (symlink/path rejection, UTF-8 edges, offset ≥
  EOF, concurrent append, post-sweep ENOENT, ANSI stripping, contiguity fuzz
  against a reference read). Hermetic-env and anti-hang nets as per the
  existing suites.
- Docs: README tool table + section, UPSTREAM divergence row (#11,
  precedent oh-my-pi `logs` — minus `follow`, minus `grep`), Changelog.

## Recommendation

Ship v0's guidance line now (it is nearly free and true regardless), and build
v1 the first time the benchmark workload actually hits the retention wall —
with the note that the omission marker currently *promises* recoverability the
tool surface doesn't safely deliver, which is the strongest argument for not
waiting long.

## Retirement conditions

Superseded if pi grows a byte-ranged, sanitized file-read primitive, or if
upstream/codex ship a log-cursor op whose shape we should mirror instead.
