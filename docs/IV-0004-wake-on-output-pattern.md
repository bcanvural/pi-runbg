# IV-0004 — Wake on output pattern (readiness wake)

**Status:** implemented 2026-08-15. Two independent design reviews and two
independent implementation reviews (see Revision notes) complete; the
feature shipped in the working tree per this document, which remains the
design contract. Prompted by oh-my-pi's hub `wait` (`pattern` regex stops a
wait on the first match) and by the gap that `on_exit: "wake"` can never
fire for processes that do not exit.

Read IV-0001 (wake control), IV-0002 (output lifecycle), and IV-0003 (cursor
reads — the "one wait path" invariant) first; this proposal lives inside all
three.

## Problem

`on_exit: "wake"` fires exactly once, on unobserved background exit. The
processes where readiness matters most — dev servers, watchers, migrations
that stay up — never exit, so the current guidance explicitly forbids wake
for them and leaves three bad options:

1. **Block attached** up to 290 s hoping the signal arrives (burns the turn).
2. **Poll** `write_stdin` until "ready" appears — the tight-loop failure mode
   IV-0001 already diagnosed, and the thing the wake mechanism exists to end.
3. **Shell condition-wait** (`until curl -sf …`) — the repo's own guidance
   ("wait on a CONDITION, not a fixed duration") — which still blocks the
   whole turn and keeps a session and a drain alive for the duration.

The readiness moment is usually *in the output* — `Server started on :3000`,
`ready in 1.2s`, `listening`. That is a matchable signal, and the wake
machinery is already the right delivery vehicle: arm at spawn, end the turn,
get woken when the signal appears.

This is the push half of the omp idea only. omp's hub `wait` blocks an
attached wait on a pattern; we deliberately do **not** import the blocking
form (Non-goals) — what ports is extending the *wake* from "process exited"
to "output matched".

## Non-goals

- **No blocking pattern-wait.** Waiting is `write_stdin`'s job; one wait path
  means one steering integration, one preemption story, one place divergence
  #10 applies (IV-0003 invariant, restated). A second blocking primitive would
  re-open every question that review just closed.
- **No regex in v1 — literal substring only.** Model-supplied regex is a ReDoS
  vector; Node has no built-in RE2; the same reasoning deferred grep in
  IV-0003. Readiness patterns are banners and fixed strings; a literal match
  covers them. (Backlog: `patterns: string[]` alternation, sanitized-stream
  matching if `output-safety.ts` ever gains a streaming carry mode.)
- **No repeated/multi-match wake.** One-shot; a second pattern means calling
  `set_on_exit` again with a new arm.
- **No `on_output` on `write_stdin`.** Arming is spawn-time (or re-arm via
  `set_on_exit` while running); polls stay passive.
- **No change to `on_exit` values or default** (`"none"` stays).
- **No wake TTL.** IV-0001's deferred TTL backlog entry now covers match arms
  too; staleness is handled by the elapsed hint + guidance (§ Semantics),
  not machinery.

## Semantics

`exec_command` gains an optional param:

```
on_output: { pattern: string, case_sensitive?: boolean }   // default false
```

- **Matching runs in the push path, on the stream as received.** The matcher
  lives where every byte passes exactly once — the spawn `onData` handler
  (`src/session.ts`) or `HeadTailBuffer.pushChunk` — *not* in the drain path:
  drains only run inside tool calls, so in the headline scenario (arm,
  end the turn) nothing would ever drain and the wake would never fire; and
  retention trimming happens at push time, so drained bytes have already
  lost the middle. Matcher state exists **only while an arm is armed** — no
  per-chunk allocation on unarmed sessions.
- **Match domain follows the transport.** Pipe mode forwards raw Buffer
  bytes; PTY mode receives strings and reconstructs bytes through
  `TextEncoder` (`src/pty.ts:242-244`), so arbitrary non-UTF-8 PTY bytes are
  already decoded/re-encoded before matching. The matcher therefore operates
  on: **encoded bytes in pipes mode; decoded strings in PTY mode** — the same
  units the data handler emits. Carry and pattern-length bounds are defined
  in **encoded bytes** of the pattern (a JS code-unit count is wrong for
  non-ASCII: `é` is 1 code unit, 2 UTF-8 bytes); malformed surrogate input
  in the pattern is rejected at schema validation. Documented caveat: a PTY
  banner containing invalid/non-UTF-8 bytes can never match — consistent
  with the existing sanitize reality the model sees.
- **Case-insensitive by default, ASCII-only fold.** Fold A–Z/a–z; the fold is
  length-preserving, so match offsets map 1:1 to stream offsets and excerpt
  extraction is trivial. The pattern is folded once at arm time; the carry
  stays `encodedBytes(pattern) − 1`. Non-ASCII patterns are matched
  byte-exact and documented (É≠é; no UTF-8 decode machinery). Rationale: the
  dominant failure is *never fires* — a case mismatch silently reverts the
  model to the three bad options this spec exists to eliminate — while a
  false positive costs one extra turn and is contained by one-shot semantics
  + the disarm story. Cost of that tradeoff: false positives are likelier
  ("ready" ⊂ "already"), which the guidance counteracts by requiring
  distinctive substrings and recommending `case_sensitive: true` when the
  banner is not distinctive.
- **Raw matching, stated honestly.** Everything the model has ever seen from
  this tool is sanitized (IV-0002); a colored banner `read\x1b[32my` matches
  "ready" in the sanitized world but never in the raw stream — a false
  negative the model cannot diagnose. Raw matching is chosen because it is
  simple (no streaming sanitizer with carry exists) and avoids the mirror
  trap (a pattern containing a character the sanitizer strips could never
  match). Documented rules: short ASCII patterns; no ANSI inside the matched
  region; PTY `cols`/`rows` line-wrap can split a banner across lines so a
  substring spanning the wrap never matches; PTY `\n`→`\r\n` translation
  breaks patterns ending in `\n`.
- **Pre-commit bytes match.** The matcher is armed at spawn from session
  opts; a fired event is staged on the session and adopted into the
  coordinator record at the arm-commit point. Bytes arriving between spawn
  and commit are *not* ignored — ignoring them loses the wake with no
  observation when a fast-banner server's match lands during the attach
  window. The containment rule (§ Consumption) decides observed-vs-deliver.
- **Both arms may be armed.** `on_exit: "wake"` + `on_output` compose;
  **first event wins**, the other disarms — one session never produces two
  wakes. "Wake me when ready, and wake me if it dies instead" is the
  highest-value dev-server configuration and the reason the combination is
  allowed rather than schema-rejected.
- **Exit-first, narrowly — and only between two armed arms.** Exit wins
  over match only when **both arms are armed** and the process is `exited`
  when the matcher evaluates or the debounced flush picks a snapshot:
  readiness is moot once the process is dead. A **match-only arm plus exit
  before match yields no wake** — emitting a match-kind wake on exit would
  turn `on_output` into an implicit exit wake, contradict per-arm semantics
  and surprise a caller who chose `on_exit: "none"` (they opted out of
  death coverage). Documented, with the guidance rule: **arm both if
  crash-before-ready matters.** The matcher checks `hasExited` before firing
  a live match; trailing post-exit bytes never wake (the test is
  defensive/synthetic for current transports — pipes deliver data before
  `close`, PTY disposes its data subscription synchronously at exit — but
  must hold for future ones).
- **First match while the session is running** → exactly one follow-up wake
  on the exit-wake path (`pi.sendMessage`, `triggerTurn: true`,
  `deliverAs: "followUp"`), same sanitization and anti-injection framing,
  new `customType: "runbg-matched"`. Verified safe: no runtime consumer
  branches on the `runbg-completed` customType beyond the send wrapper;
  a second customType with the same `{content, display, details}` shape
  needs only docs/tests/UPSTREAM updates.
- **Batching by wake kind.** The coordinator batches all eligible records
  into one `buildWakeMessage` (`src/completion.ts:391-420`) while the send
  wrapper hardcodes `customType: "runbg-completed"`. A mixed debounce window
  (exit wake for session A + match wake for session B) is therefore split:
  **flush groups by wake kind and emits at most one message per kind per
  flush** (max two). Per-session first-event-wins already guarantees no
  single session needs both kinds in one flush.
- **Arm generations.** Every match arm carries a monotonically increasing
  **generation**; reservations, staged containment decisions, `set_on_exit`
  disarm/re-arm, and `recoverFailedSend` retries all carry the generation
  they were taken against. A stale staged commit (match A staged at result
  build, re-arm to B before `tool_execution_end`) never consumes or
  suppresses a newer arm; a stale disarm never kills a fresh arm. The
  existing pending-terminal machinery keyed by toolCallId
  (`src/completion.ts:68-72, 258-288`) is extended with the arm identity.
- **Wake snapshot** (`MatchSnapshot`, sibling of `CompletionSnapshot`): the
  exit-wake metadata (session_id, command, running, `log_path`,
  `tool_time_utc`; exit fields optional), plus:
  - `match_excerpt` — the sanitized, line-bounded excerpt (below).
  - `elapsed` since spawn (`formatElapsedShort`) — "matched after 4h12m"
    makes a late fire self-evidently stale without any TTL machinery.
  - A match-specific close: "readiness signal matched; the match arm is
    consumed, and any exit arm is consumed too — re-arm via `set_on_exit`
    if a later signal matters. Output beyond the excerpt has NOT been
    consumed; poll `write_stdin` (no chars) or read `log_path`. Resume the
    workflow that was waiting on readiness — do not merely acknowledge."
    (IV-0001's stale-resume lesson applies to match wakes too; the exit
    close's "drain its FINAL output" wording is wrong for a running session.)
  - The wake-message invariant comment ("metadata only — never raw
    stdout/stderr", `completion.ts`) is **reworded**, not preserved: a match
    wake carries child output by design.
- **Excerpt pipeline.** The matcher keeps a bounded **current-line ring**
  (raw context since the last newline, cap 400 bytes) while armed, so an
  excerpt can be built even when the match lands mid-line and the enclosing
  newlines arrive later. The excerpt is built **at flush time** from the
  ring: the matched line portion within the cap (±200-byte window extended
  to enclosing newlines, hard cap 400 bytes total), best-effort documented
  when the line outlives the cap. Sanitized with `output-safety.ts`'s
  `sanitizeOutputText` (full CSI/OSC/DCS/C0/C1/CR strip) — **not** the
  metadata-only `sanitizeMeta`. The excerpt is the sanitized stream slice;
  it is **not case-folded** — `details.output` is the sanitized stream with
  the same bytes and case, so the containment check below is exact by
  construction; folding both sides would only loosen the comparison in the
  false-consumption direction (a folded "ready." would match "already
  read…"). Fold is a matcher concern only. Slice-edge sanitizer artifacts
  (an unterminated CSI/OSC/DCS sequence, or an introducer lying before the
  slice) can only make the excerpt differ from a full-stream pass in the
  **false-delivery** direction (safe) — explicit tests required.

### Consumption (what "observed" means for a match wake)

The exit-wake observation machinery (leases, `pendingTerminal`) does **not**
transfer — "attached" ≠ "saw the match": an attach result is a bounded tail,
and the match can sit in the dropped middle or land after the result was
built. The match rule is **containment-based**:

- **A match wake is consumed iff a successfully finalized tool result's
  post-truncation bounded body (`response.details.output`) contains the
  sanitized excerpt string.** This tests model *knowledge*, not byte
  identity: containment fails automatically when the match fell into the
  dropped middle, landed after the result was built, or sanitized into
  invisibility — in which case the wake delivers.
- **Known accepted collision:** with a line-bounded excerpt, false
  consumption requires the identical line to appear twice in one result —
  and then the model demonstrably possesses the signal text, so consuming
  is semantically harmless under the "model knowledge" rule. Documented,
  not designed around. For lines longer than the cap, two different lines
  can share the bounded portion; still model knowledge of the signal text
  in practice — accepted, with the fail-closed rule below as backstop.
- **Fail closed to delivery.** Any ambiguity in the check (empty-after-
  sanitize excerpt, `"".includes("")` hazard, sanitizer slice artifacts)
  delivers rather than consumes. The empty-excerpt guard is explicit: a
  match landing inside a control sequence sanitizes to empty, is treated
  as never-observed, and always delivers.
- Check is staged per-`toolCallId` **with the arm generation** at result
  build time and committed/rolled back at `tool_execution_end` (the
  `pendingTerminal` pattern — the finalize event does not reliably carry
  text). The check runs caller-side after `finalizeResponse` so
  `tool-result.ts` stays pure (IV-0002's split). Partial stream updates
  (`buildStreamUpdate`) never consume.
- **`list_sessions` never consumes a match wake.** Listing shows arm
  booleans, never the excerpt; consuming would destroy a payload-bearing
  wake for zero information. (The exit-wake analog is justified only because
  listing carries the completion facts themselves.)
- **`set_on_exit` gains `on_output`** (`{pattern, case_sensitive?}` re-arms
  / replaces; `on_output: null` disarms the match arm; omitted leaves it
  unchanged). **`on_exit` becomes optional** (a plain optional field —
  omitted = unchanged; no conditional/union requiredness, which would be
  awkward with the existing TypeBox/Google-compat schema workarounds): a
  match-only re-arm must not require passing a field it isn't touching.
  This is a *relaxation* of the verbatim schema, not purely additive —
  UPSTREAM.md divergence row must justify it loudly. Suppression is
  **per-arm**: `on_exit: "none"` suppresses only the exit arm;
  `on_output: null` suppresses only the match arm; full cleanup is the
  combined call `(on_exit: "none", on_output: null)`. Re-arm after fire
  goes through the existing register path (works for live sessions;
  `too_late` for dead ones), always with a fresh generation.
- **Wake policy record becomes per-arm state** — `armed` / `suppressed` /
  `wakeQueued` / `generation` per arm (exit, match) on the coordinator
  record, *not* a single `kind` enum. A single-kind record cannot express
  both-armed, and record-level suppression would kill the wrong arm.
- **Audit surface:** `list_sessions` / widget gain `match_armed: boolean`;
  **`wake_armed` stays a boolean and is explicitly defined as the exit-arm
  boolean** — in-repo consumers use JS truthiness (`index.ts:2724`,
  `render.ts:546`), an enum's `"none"` is truthy, and a match-only arm must
  not light up the `[wake]` label. `set_on_exit` returns `match_armed` plus
  a sanitized, truncated (~32–64 char) `match_pattern` echo so the model can
  audit what it armed; its renderer shows the echo (IV-0002: every tool has
  a renderer).
- **Disarm racing a reserved wake must not still send.** The mid-flight
  flush re-checks per-arm suppression *and generation* before delivery.
  `recoverFailedSend` re-reservation carries the generation.
- **Kill suppresses both arms.** Eviction/reap: live-terminate suppresses;
  exited-tombstone keeps the record for delivery (the existing split,
  extended per arm).
- **Pattern bounds:** 1–256 chars, validated in encoded bytes; malformed
  surrogates rejected.

## Decisions

| Decision | Why |
|---|---|
| Matcher in the push path (`onData` / `pushChunk`), not the drain path | Drains only run inside tool calls; the headline case (arm, end turn) drains nothing. Trimming is at push time — drained bytes have already lost the middle. Only the push path sees every byte exactly once. Delivery follows the exit-wake precedent: `recordMatch` from the data handler → debounced flush → delivery outside any lock. Matcher state allocated only while an arm is armed. |
| Match domain = transport units (pipe bytes / PTY decoded strings); bounds in encoded bytes | The PTY path is already decode→`TextEncoder` reconstructed (`pty.ts:242-244`); claiming original raw bytes is false. Code-unit lengths are wrong for non-ASCII carry math. |
| Literal substring, not regex | ReDoS surface from model-supplied patterns; no RE2 in Node; banners are literals. Regex is an explicit later path with a bounded engine if real demand appears. |
| Case-insensitive default, ASCII-only fold | A miss silently reverts to the three bad options; a false positive costs one turn. Length-preserving fold keeps offsets 1:1 and needs no UTF-8 machinery; non-ASCII is byte-exact and documented. |
| Push-only, no blocking wait | One wait path (IV-0003). The blocking form adds a second steering integration and a second preemption story for a case the shell already covers attached; the *background* case is the one with no answer today. |
| Allow both arms; first event wins; exit-first **only between two armed arms** | "Wake on ready or on death" is the killer configuration; a single-kind record cannot express it, and two wakes for one session are strictly worse than either alone. A match-only arm yields **no wake** on exit-before-match: turning it into one would make `on_output` an implicit exit wake and contradict a caller who chose `on_exit: "none"` — death coverage is the exit arm's job; guidance says arm both if crash-before-ready matters. |
| Containment-based consumption (sanitized excerpt ⊂ finalized, post-truncation result body), fail-closed, generation-tagged | Tests model knowledge, not byte identity; fails safe (delivers) in every "model didn't see it" case; no leases, no segment-offset math; one `includes()` at a single finalize point (`finalizeProcessResult`). Generations make staged decisions unable to touch newer arms. Duplicate-line collision accepted as semantically harmless (the model possesses the signal text). |
| Excerpt built at flush time from a bounded current-line ring, sanitized, capture-capped | A match can land mid-line; enclosing newlines arrive later. The ring gives the excerpt both line-bounding and boundedness; `sanitizeOutputText`, not `sanitizeMeta` — the excerpt is child output. Slice-edge sanitizer artifacts fail toward delivery only. |
| Extend `set_on_exit` rather than add `set_on_output`; `on_exit` becomes a plain optional (omitted = unchanged) | The tool already means "set wake policy"; a seventh tool doubles schema tax for the same capability (IV-0003 cost lesson). Required-`on_exit` would force a match-only re-arm to pass a field it isn't touching. Plain-optional, not conditional/union requiredness — TypeBox/Google-compat safe; the relaxation itself is a loud UPSTREAM divergence. |
| Per-arm record state with generations; `wake_armed` stays boolean (= exit arm) + new `match_armed` | Single-kind record contradicts both-armed semantics; record-level suppression kills the wrong arm. Boolean truthiness is load-bearing in the TUI; a 3-value enum cannot express both-armed anyway. Generations close the staged-commit / re-arm / recover races the toolCallId keying leaves open. |
| Batch by wake kind: at most one message per kind per flush | The coordinator batches all eligible records into one message (`completion.ts:391-420`) and the send wrapper hardcodes one customType (`index.ts:2069-2081`); a mixed batch has no defined shape. Grouping by kind keeps both snapshot types intact; no runtime consumer branches on the customType, so a second one is safe. |
| Pre-commit bytes match; adopt staged event at arm commit | Ignoring spawn-to-commit bytes loses the wake unobservably for fast-banner servers during a long attach. Containment still decides observed-vs-deliver. |

## Implementation map

| Area | Location | Notes |
|---|---|---|
| Wake policy state | `src/completion.ts` | Per-arm `armed`/`suppressed`/`wakeQueued`/`generation` on the record; deliver filter re-checks suppression + generation mid-flush per arm; `MatchSnapshot` type + `customType: "runbg-matched"` + reworded invariant/framing; `recordMatch` from the data handler → debounced flush, delivery outside any lock (exit-wake precedent); `flushPending` groups by wake kind (≤ 1 message per kind per flush). |
| Incremental matcher | `src/session.ts` spawn `onData` (or `HeadTailBuffer.pushChunk`) | Literal `indexOf` on transport units (pipe bytes / PTY strings); ASCII-only fold (pattern folded at arm time, length-preserving); carry = `encodedBytes(pattern) − 1`; checks `hasExited`; stages fired event pre-commit, adopts at arm commit with generation; bounded current-line ring (cap 400) while armed; matcher state only when armed. |
| Tool surface | `src/index.ts` | `on_output` on `exec_command`; `on_output` + optional `on_exit` + `match_armed`/`match_pattern` echo on `set_on_exit`; containment check caller-side after `finalizeResponse` (staged per toolCallId + generation, committed at `tool_execution_end`); renderers per IV-0002. |
| Audit surface | `list_sessions`, widget, `/runbg-sessions` | `match_armed` boolean; `wake_armed` stays boolean, defined as exit-arm only; no fired-state exposure. |
| Guidance | `promptGuidelines` + template carrier + tool description (design §6: three surfaces, two carriers) + README/design tables | Rewrite the existing line that forbids wake for non-exiting processes (`index.ts:2438`) — it becomes wrong; rewrite every disarm instruction — `index.ts:2433` (prescribes `on_exit` wake for long jobs), `write_stdin` guideline at `index.ts:2495`, design §6 template text (§6:173-183 and the replace-mode copy at design.md:394-396), README stale-wake rules (README:146 on_exit table, 205-209 abandoned-wake cleanup, 279 set_on_exit schema, 289+ completion section) — to teach `on_output: null`, the combined `(on_exit: "none", on_output: null)` cleanup, and "arm both if crash-before-ready matters". New text: `on_output` for readiness of non-exiting processes, `on_exit` stays for terminating jobs, distinctive banner substrings only, short ASCII patterns, raw-byte match caveats, verify late fires against elapsed. |
| Docs | README, Changelog, UPSTREAM divergence row (#12), this IV | Loud-divergence rule (design §7). |

### Guidance carriers — concrete inventory

The rewrite above lands differently depending on how each carrier reaches
the model (verified against `~/.pi/agent/sysprompts/` and the
`mode: append | replace` frontmatter pi uses):

- **Append-mode templates keep pi's default prompt branch**, so tool
  `promptGuidelines`/`promptSnippet` still arrive; only the template's own
  bullet copies need editing. Concrete case, `modified-pi.md`
  (`mode: append`): exactly two bullets change —
  1. The wait-mode bullet gains a fourth branch: *non-terminating with a
     readiness signal (dev servers, watchers) → `exec_command` with
     `on_output: {pattern}` armed, then END THE TURN — woken on first match
     (distinctive banner substring, not a common word).*
  2. The "never arm `on_exit` for a process that does not exit on its own"
     bullet is **amended, not deleted** — it stays literally true (`on_exit`
     genuinely never fires there) but becomes misleading once `on_output`
     exists: append *"for readiness of those, use `on_output` instead; arm
     both if crash-before-ready matters."*
  The steer/hygiene bullets ("the full contract lives in the tool
  descriptions", etc.) stay valid unchanged.
- **Replace-mode templates drop the default branch**, so guidelines are
  lost and the discipline text must be duplicated by hand into each
  template that teaches sessions (design §6:173-183, the replace-mode copy
  at design.md:394-396, and any of the other `~/.pi/agent/sysprompts/*.md`
  files carrying the old rules).
- **Tool descriptions + parameter descriptions ship with the schema and
  always arrive** — they remain the universal carrier regardless of
  template mode, which is why the core contract lives there first
  (`index.ts:2419-2423` documents this).


## Test matrix

Unit: matcher (mid-chunk match, match split across chunk boundary, ASCII
fold, non-ASCII byte-exact, encoded-byte carry, malformed-surrogate
rejection, pattern bounds); excerpt ring (mid-line match, line completion
across chunks, hard cap, empty-after-sanitize guard, unterminated
CSI/OSC/DCS crossing the slice edge → false-delivery only); per-arm
suppression (setOnExit none leaves match arm, and vice versa); generation
races (staged commit vs re-arm; disarm vs reserved wake; recoverFailedSend
vs re-arm); deliver-filter per-arm mid-flush checks; PTY-domain matching
(post-`TextEncoder` stream; invalid-byte caveat).

Wake e2e (extending `tests/wake-e2e.test.ts`): match mid-run delivers exactly
one `runbg-matched` wake; both arms → match first (exit suppressed) and exit
first (match suppressed); **match-only arm + exit before match → no wake**
(documented; guidance arms both); match during attached wait consumed when the
finalized result body contains the excerpt; **match in dropped middle during
a poll → not consumed, delivers**; duplicate-line containment → consumed
(documented collision); match after exit signal but before `outputClosed` →
no live-match wake (defensive/synthetic for current transports); match after
result built during attach → not consumed, delivers; pre-commit match (fast
banner) → adopted, containment decides; empty-sanitized-excerpt → always
delivers; **mixed debounce batch (exit A + match B) → one message per kind**;
`list_sessions` does not consume a fired-but-unflushed match; disarm race
(reserved match wake + `set_on_exit` before flush); `kill_session`
suppresses match wake; headless `pi -p` delivery before settle (design §9);
excerpt sanitization (control bytes stripped per IV-0002); high-volume
output (matcher state only when armed; no per-chunk allocation otherwise).

## Cost

- **Schema tax:** ~120–200 tokens per request on `exec_command` +
  `set_on_exit`, forever — gated behind `/runbg on` like everything else.
  This is the real price (IV-0003's lesson) and the strongest argument for
  waiting for a real dev-server workflow to demand it.
- **Implementation:** ~450–550 LOC src — per-arm coordinator redesign with
  generations, push-path matcher + current-line ring, containment staging
  at every finalize path, excerpt pipeline through `output-safety.ts`,
  snapshot type + framing rework + kind-grouped batching, renderers,
  three-surface guidance audit. ~550 LOC tests. The estimate is a
  consequence of the semantics above, not evidence the feature is small.
- **Guidance risk:** a third wake arm is a new overuse vector (IV-0001's
  #3). Mitigations: one-shot semantics, per-arm disarm story taught in
  every carrier, distinctive-substring + elapsed-verification guidance, no
  TTL machinery (backlogged).

## Resolved during review

Two independent reviews: WakeSpecReviewer (3 rounds) and SolSpecReviewer
(3 rounds, including post-review pushback). Consolidated resolutions:


| Question | Resolution |
|---|---|
| `wake_armed` boolean vs enum | Boolean stays, **explicitly the exit-arm boolean** (truthiness is load-bearing in TUI consumers; an enum can't express both-armed); add `match_armed`. |
| Both arms at spawn | Allowed, both at spawn and via `set_on_exit`; first event wins; per-arm flags + generations, not a kind enum. Rejecting would forfeit crash coverage for servers that die before their banner. |
| Case sensitivity default | Default **false** (case-insensitive), ASCII-only fold, non-ASCII byte-exact; carry/bounds in encoded bytes; `case_sensitive: true` recommended for non-distinctive banners. |
| Match + exit in same drain | **Exit-first only between two armed arms.** Match-only + exit-before-match yields **no wake** (documented; guidance: arm both if crash-before-ready matters) — delivering one would make `on_output` an implicit exit wake and contradict a caller who chose `on_exit: "none"`. Matcher checks `hasExited`; debounce race: exit snapshot preferred when `exited` and exit-eligible at flush. |
| Re-arm after fire | `set_on_exit` only, v1, with `on_exit` optional when `on_output` is present; fresh generation per arm; re-arm goes through the existing register path (`too_late` for dead sessions). |
| Mixed wake batching | Group by wake kind; ≤ 1 message per kind per flush. Verified no runtime consumer branches on `customType`. |
| Containment collision (duplicate excerpt) | Accepted and documented: line-bounded excerpt + "model knowledge" rule makes it semantically harmless; fail-closed-to-delivery on every ambiguity. |
| Excerpt capture-time line-bounding | Bounded current-line ring in matcher state; excerpt built at flush time; best-effort for lines exceeding the cap. |
| Raw-byte claims vs PTY transport | Match domain = transport units (pipe bytes / PTY decoded strings); PTY invalid-byte caveat documented. |
| Stale staged decisions vs re-arm | Per-arm monotonically increasing generations on reservations, staged containment, set_on_exit, recoverFailedSend. |

## Recommendation

Scope now, ship when a real dev-server/watch workflow needs it. The fix is
small and composes with everything already shipped, but it is a third wake
arm to teach, and every prior wake feature (IV-0001) shipped under demand
pressure, not on speculation.

## Retirement conditions

Superseded if upstream/codex ship an output-pattern wake op, or if a blocking
condition-wait is ever added to `write_stdin` (which would retire the
attached case but not the background one).

## Revision notes

- **v1 (2026-08-15):** initial scope. Matcher mis-placed in the drain path.
- **v2 (2026-08-15):** review #1 (WakeSpecReviewer, 3 rounds). Blocker
  fixed: matcher moved to the push path. Consumption redefined as
  sanitized-excerpt containment in finalized post-truncation result bodies
  (staged at build, committed at `tool_execution_end`; empty-excerpt guard;
  `list_sessions` never consumes). Wake policy record made per-arm; both
  arms allowed, exit-first. `wake_armed` kept boolean, `match_armed` added.
  Excerpt pipeline specified. Case-insensitive default with ASCII-only fold.
  Pre-commit bytes match via staged adoption. Match snapshot: own type,
  elapsed-since-spawn staleness hint, reworded close and framing invariant.
  Guidance rewrite across both carriers + description.
- **v3 (2026-08-15):** review #2 (SolSpecReviewer, 3 rounds). Closed the
  gaps the first review missed: mixed-kind wake batching (group by kind,
  ≤ 1 message per kind per flush; second customType verified safe); arm
  generations against staged-commit/re-arm/recover races; match domain
  corrected to transport units with encoded-byte carry (PTY is not raw
  bytes); excerpt rebuilt on a bounded current-line ring at flush time;
  exit-first narrowed to exit-eligible arms only (v3.1 further narrowed to
  both-armed only — match-only arms yield no wake on death); containment
  duplicate-line collision documented as semantically harmless with
  fail-closed backstop; `set_on_exit.on_exit` optional when
  `on_output` present; disarm guidance rewritten in every carrier; cost
  corrected to ~450–550 LOC src / ~550 LOC tests.
- **v3.1 (2026-08-15):** SolSpecReviewer follow-up round. Conceded the
  match-only-exit wake: a match arm fires only on a match; exit-before-match
  with no exit arm yields no wake (per-arm semantics preserved; guidance
  teaches "arm both if crash-before-ready matters"). `on_exit` optionality
  restated as a loud plain-optional relaxation (no conditional/union
  requiredness; TypeBox/Google-compat safe; omitted = unchanged). Guidance
  audit extended to every carrier surface (README:146/205-209/279/289+,
  design.md §6 and 394-396, index.ts:2433/2438/2495, wake tests asserting
  the customType).
- **v3.2 (2026-08-15):** added the concrete guidance-carrier inventory
  (verified against `~/.pi/agent/sysprompts/` frontmatter): append-mode
  templates (`modified-pi.md`) keep the default branch so tool guidelines
  arrive — only its two own bullets change (wait-mode fourth branch;
  amended-not-deleted `on_exit` bullet); replace-mode templates still need
  hand-duplicated text; tool descriptions remain the universal carrier.
- **v3.3 (2026-08-15):** implementation reviews (dp-worker + worker-sol).
  Post-implementation fixes recorded: one-lined content copy of the
  excerpt (injection framing; details keep the full sanitized slice, no
  trim); never-fired match arms resolve at exit/eviction (exit listener
  retained while a match arm lives); staged containment staged with the
  ORIGINAL session id on terminal results; position-aware capture window
  around the match (the matcher reports its end offset; naive tail capture
  could scroll the match out of a >400-byte chunk); caseSensitive compared
  in the identical-arm fast path; stopped guard on async send failures;
  kill suppresses both arms in the description; status updated to
  implemented.
