# IV-0006 — Held-open session diagnosis (shell exited, pipe held)

**Status:** implemented and approved — 3 design rounds + guidance follow-up + 3 implementation review rounds (df-worker, dp-worker, worker-sol) all accepted; pending human sign-off  
**Review status:** design: 3 rounds + guidance follow-up accepted; implementation: df-worker approve-with-nits (2 points + 3 nits applied), dp-worker approve-with-nits (2 points + 3 nits applied), worker-sol approve (2 minors corrected in discussion) — all cleared  
**Related:** [UPSTREAM.md](../UPSTREAM.md) (fork contract, divergence list), [IV-0001 — Long-wait UX, wake control, and agent guidance](./IV-0001-long-wait-and-wake-control.md), [IV-0002 — Output lifecycle and rendering](./IV-0002-output-lifecycle-and-rendering.md), [IV-0005 — Settled-gated wake delivery](./IV-0005-settled-gated-wake-delivery.md)

## Intent

Explain a session that reports `[still running]` even though its shell has
already exited — the pipes-mode "held-open" state where a backgrounded
process inherited the output pipe and keeps it open, so the `close`-based
session exit never fires.

Diagnosis only. No lifecycle semantics change: the session stays open,
killable, and pollable. Never a forced pipe close, never a command rewrite,
never an implicit kill of the background jobs.

This is the first upstream feature since the fork: pi-unified-exec 0.9.1
(commit `8493da5`) implemented exactly this. We fork at v0.9.0, so this IV
is a port of that commit through the repo's documented sync contract
(UPSTREAM.md "Syncing from upstream"), adapted to runbg's divergences.

## Problem

### The mystery `[still running]`

runbg's pipes-mode child (src/pty.ts `spawnPipes`) treats the process
`close` event as the session exit signal:

```
// Use `close`, not `exit`: on macOS, very short-lived commands can emit the
// process `exit` event before stdout/stderr have delivered their final data.
// Treating `close` as our completion signal preserves trailing output before
// ExecSession drains and finalizes the response.
child.once("close", (code, signal) => finalize(code, signal));
```

`close` fires only when the process has exited **and** all stdio streams are
closed. A command that backgrounded processes with inherited stdout/stderr —
`cmd >/dev/null &`, `(cd dir && cmd) &`, a `cd … && cmd &` chain whose
subshell keeps waiting — leaves a descendant holding the write end of the
pipe. `close` then never fires, and the session reports `[still running]`
indefinitely:

- the **model** polls the session forever, sees no output, cannot tell
  "command still working" from "shell long gone";
- the **human** sees the session in the running-session widget with no
  indication that the foreground command is done;
- `kill_session` works on POSIX (process-group kill) — but **not reliably
  on Windows** (see below) — so this is mostly a *diagnosis* gap, and on
  Windows partially a *control* gap that the note must be honest about.

The tool description already warns the model not to background inside `cmd`
("A backgrounded child is not tracked by its session; if it inherits the
session's output pipe, the session keeps reporting [still running] long
after your cmd finished"). Guidance before, but no diagnosis after — the
failure mode is documented, the runtime symptom is not.

### The Windows control gap

`killWindowsTree(pid)` (src/pty.ts) runs `taskkill /pid <shell> /T /F`, and
the file itself documents the limitation: `/T` enumerates children of a
**live** root — if the direct child already exited while a backgrounded
grandchild lives on, taskkill finds nothing to kill. A held-open session is
precisely that state. Windows also skips SIGKILL escalation
(src/index.ts, terminate path: "a second taskkill is byte-identical"), so
`kill_session` on a held-open session returns `killed: false` and the
session stays stuck until the background job exits on its own. The note's
remedy must therefore be platform-aware (see Design §3).

### Prior art: upstream 0.9.1

Upstream (iamwrm/pi-unified-exec) shipped the fix as v0.9.1, commit
`8493da5` "diagnose held-open sessions". It:

1. adds `SpawnedChild.processExited` — pipes: set in `child.once("exit")`;
   PTY: set in the node-pty `onExit` handler — independent of the
   close-based `exited` flag;
2. exposes `ExecSession.shellExited` → `child.processExited`;
3. carries a `note` on `[still running]` results (its exec_command,
   write_stdin, and absolute-deadline paths), explaining the cause and
   giving detach recipes (`(cd dir && cmd >log 2>&1 </dev/null) &`,
   `setsid … &`) or `kill_session`;
4. marks such sessions `(shell exited, pipe held)` in the running-session
   widget and the kill picker;
5. ships a 6-case held-open test suite.

The commit is +241/−3 across 8 files and touches no lifecycle semantics.
Verified against the repo: `git show 8493da5` is the only commit after fork
point `7c8c1d8` (v0.9.0); tag v0.9.1 exists.

## Design

### 1. `SpawnedChild.processExited: boolean` (src/pty.ts)

Add to the `SpawnedChild` interface, implemented by **both** transports:

- **pipes** (`spawnPipes`): `child.once("exit", () => { processExited = true; })`
  — the `exit` event fires when the shell itself ends, before its stdio
  streams close. Orthogonal to the existing `close`-based `finalize` and the
  `error`-based spawn-failure path (on spawn failure `exit` may never fire;
  `processExited` stays `false`, and the session exits via `failureMessage`
  anyway — harmless).
- **PTY** (`spawnPty`): set `processExited = true` inside the existing
  node-pty `onExit` handler, alongside `exited = true`.

Keeping the flag on both transports is an **interface contract, not
symmetry**: `SpawnedChild` is a single interface, and omitting the getter on
one transport would make `child.processExited` `undefined` at runtime — a
lie under the `boolean` type. The PTY value is trivially correct
(node-pty's `onExit` is the process exit; PTY sessions exit with their
shell, so the held-open state cannot arise there).

Getter, not a bare field, matching the existing `exited` closure pattern.

### 2. `ExecSession.shellExited` getter (src/session.ts)

```ts
/** The shell process itself has exited. In pipes mode this can be true
 *  while `hasExited` is still false: background jobs that inherited the
 *  output pipe keep it open, so the close-based session exit lags (or
 *  never arrives). */
get shellExited(): boolean { return this.child?.processExited ?? false; }
```

Pure read of existing state — no interaction with the session state
machine, the interaction lock, or the tombstone path. Defensive by
contract: the two `markFailure` paths (log-open failure, spawn throw)
never assign `this.child`, and the getter is public — `?.` returns
`false` for "no shell", which is truthful (the session failed to spawn,
and `hasExited` is true in those paths anyway). The note's guard still
evaluates `!hasExited` **first** (Design §3) so the ordering can never
matter.

### 3. The note (src/index.ts, src/tool-result.ts)

- `HELD_OPEN_NOTE` constant + `heldOpenNote(session)` helper:

  ```ts
  function heldOpenNote(session: ExecSession): string | undefined {
      return !session.hasExited && session.shellExited ? HELD_OPEN_NOTE : undefined;
  }
  ```

  State-driven, never command-text matching — covers any construct that
  leaves a pipe holder behind. Single constant (one cause class: "a
  descendant holds the pipe"; the two surface forms — plain `&` job vs
  `cd … && cmd &` subshell — carry no state-visible causal information, and
  splitting them would force the command-text heuristics the design
  rejects), with one **platform variation** (see below).

- **Platform-aware remedy.** On `IS_WINDOWS`, `kill_session` may not reach
  the pipe-holding descendant once the shell is gone (the taskkill
  live-root limitation above). `heldOpenNote` selects a Windows variant
  whose remedy says so and stays model-actionable: "Windows: kill_session
  cannot reach background jobs once the shell has exited — locate the
  holder with `tasklist` and kill it with `taskkill /pid <pid> /F`, or
  wait: the session closes when the last pipe holder exits." The
  widget/picker marker stays platform-neutral and short (decision: the
  widget and picker labels are one-line hints; the note carries the
  detail).

- **POSIX qualifier.** The POSIX remedy ("or end the session with
  kill_session") is true for ordinary backgrounded jobs — pipes children
  are group leaders (`detached: !IS_WINDOWS`, src/pty.ts) and
  `kill(-pgid)` reaches the shell's group after the leader exits — but a
  `setsid`'d holder creates its own group and escapes the group kill,
  exactly like the Windows live-root limitation. Since `setsid` is one of
  the note's own recipe tokens, the constant gains one clause: "(a
  setsid'd holder is in its own group and escapes the group kill — find
  it with ps/pgrep and kill by pid, or wait for it to exit)".

- **Kill-failed results append the note.** When a kill on a held-open
  session fails (`!killed && !session.hasExited && session.shellExited`),
  the kill-failure message (src/index.ts, the killFailure composition)
  appends the platform-variant `heldOpenNote` text. The generic "retry
  kill_session or check permissions" advice is a guaranteed retry loop in
  that state (Windows taskkill live-root; POSIX setsid escape), and a
  README record alone never reaches the model. Single site, no envelope
  field; kill details stay note-free; the `[kill failed]` header stays
  intact. A killed-but-alive session that is NOT held-open keeps the
  generic text — truthful for the ordinary stubborn-process case.

- **Wake contract.** `shellExited` is diagnostic only. Exit-wake and
  match-wake arms stay tied to session exit/output (close-based), so an
  `on_exit: "wake"` arm on a held-open session stays pending until the
  last pipe holder exits — possibly forever. The note's text gains the
  clause "(an armed on_exit wake stays pending until then)" after "this
  session stays open until they exit", and the model that sees the note
  while a wake is armed should poll, kill, or disarm
  (`set_on_exit on_exit:"none"`) rather than wait for the wake.

- `note?: string` on `OutputResultDetails` (src/tool-result.ts), next to
  `failure_message`. The note renders as a **header line** in
  `renderProcessResultText` (alongside `failure:`, before the `---`
  separator) — outside the 50 KiB body truncation, bounded only by
  `safeMeta`'s cap, so it is always visible to the model on a
  `[still running]` result. (IV-0002 compatibility: header lines are the
  same channel `failure:` already uses.)

- **Wrapper-level derivation (deliberate divergence from upstream's
  per-site copies).** Upstream hand-copies `note:` onto its three result
  sites; hand-copying onto runbg's six is the exact bug class the
  maintainer note in src/index.ts names ("a divergence in the copied
  fields is a bug, not a variation"). Instead, each tool's local
  `finalizeResponse` wrapper derives the note centrally, gated on
  `input.sessionId !== undefined` — the same condition
  `finalizeProcessResult` uses to produce `[still running]`:

  ```ts
  extra: { ...input.extra, note: input.sessionId !== undefined ? heldOpenNote(session) : undefined }
  ```

  Terminal sites need zero edits (the gate short-circuits); any future
  still-running site inside these functions gets the note automatically.

  **Verified surface** (every site that can return `[still running]` for
  a live session; checked against all 14 `finalizeProcessResult` sites in
  src/index.ts):

  1. `runExecCommand` — regular still-running result;
  2. `runWriteStdin` — regular still-running result;
  3. `runWriteStdin` — the `\x03` interrupt path (divergence #8);
  4. `runWriteStdin` — `cancelledWhileQueued`, the single standalone site
     outside the wrappers (divergence #7) — explicit guard `session ?
     heldOpenNote(session) : undefined`, because `session` can be a
     reaped-only miss there and the unguarded call would throw;
  5. `runAbsoluteWait` — cancelled-before-deadline still-running result
     (divergence #7 preemption);
  6. `runAbsoluteWait` — deadline-reached still-running result.

  Terminal sites (exit observed, `hasExited` true) stay note-free — the
  gate and `heldOpenNote`'s own state check guarantee that.

### 4. Human-facing markers (src/index.ts)

- running-session widget line: `(shell exited, pipe held)` after the
  elapsed/wake markers;
- `/runbg-sessions` kill-picker label: same marker.
- **TUI result row** (src/render.ts `buildStatusLine`): render
  `details.note` next to `failure_message`, so a human inspecting the tool
  result row sees the diagnosis even where the widget is dismissed or
  absent. (Deliberate small extension beyond upstream, which leaves the
  row silent.)

### 5. `list_sessions` — deliberate extension beyond upstream

Upstream 0.9.1 did **not** touch `list_sessions`. runbg's `list_sessions`
is model-facing and already carries per-entry audit metadata
(`wake_armed`, `match_armed`, `log_path`). A held-open session never exits
on its own, so it is precisely the entry the model cannot otherwise
distinguish — **add `shell_exited`**:

- semantics: `shell_exited: s.hasExited ? undefined : s.shellExited` —
  present only for running entries, mirroring the `exit_code` / `signal`
  convention (undefined for reaped rows);
- three surfaces, matching the `wake_armed`/`match_armed` pattern: the
  details field, a `[shell exited]` marker in the text listing, and a TUI
  row marker in src/render.ts;
- **UPSTREAM.md divergence row** (new #13) documenting the field, since the
  port deliberately extends upstream here.

### 6. Tests (tests/held-open.test.ts)

Port upstream's suite and close its holes (upstream never tests the
`heldOpenNote` wiring — its note-rendering case hardcodes the string):

**State-level (raw `ExecSession.spawn`, upstream-style):**
1. backgrounded job with inherited stdout → `shellExited` true,
   `hasExited` false;
2. `(cd dir && cmd) &`-style chain → same state;
3. normal long-running foreground command → `shellExited` false;
4. after `kill_session`, `hasExited` becomes true;
5. spawn-failure paths → `shellExited` false **without throwing**,
   `failureMessage` set — both the synchronous-throw path (empty
   command; `child` uninitialized, the getter must not throw) and the
   async-ENOENT path (bad shell binary; `child` assigned, finalize via
   `error`); the log-open failure path is the same getter code (not
   separately tested — would need permission fixtures);

**Wiring-level (through the real extension harness, `makeHarness`):**
6. `exec_command` on a held-open session → result carries the note text
   with the detach recipes;
7. `write_stdin` poll on the same session → same note;
8. exited session → no note on results;
9. `list_sessions` → `shell_exited: true` for the held-open entry,
   `[shell exited]` in the text listing; undefined for reaped entries;
10. widget/picker marker via the harness's `setWidget` stub;
11. **wake contract**: arm `on_exit: "wake"` on a held-open session,
    assert the wake remains armed (`list_sessions` `wake_armed: true`)
    after shell exit and that no wake fires, then disarm;
12. **failed kill on a held-open session** (POSIX only, `{ skip:
    IS_WINDOWS }`): the fixture backgrounds `python3 -c "import
    os,time; os.setsid(); time.sleep(5)" &` — python3 is an assumed
    POSIX test dependency (e2e-pty drives a REPL), and `os.setsid()`
    creates the new session on Linux and macOS alike (the `setsid`
    binary is util-linux, absent on macOS by default). The shell exits,
    its group is gone, `kill(-pgid)` lands on nothing → assert
    `killed: false`, `[kill failed]` header + platform note appended,
    session still listed (`running: true`), and — per the IV-0005
    invariant "a kill that fails to land restores eligibility" —
    `wake_armed: true` when `on_exit: "wake"` was armed before the kill.
    Cases 11–12 together pin the full wake lifecycle: armed → not fired
    on shell exit → survives a failed kill → disarmed or fires on real
    exit.

**Windows policy.** The raw state cases (1, 2, 4) depend on `bash -c` and
POSIX process-group semantics — they keep the repo's per-case `{ skip:
IS_WINDOWS }` convention (crash-cleanup, interaction-lock, log-archive all
skip per-case). The wiring cases run on Windows too: they pass explicit
`shell: "bash"` (resolved by the extended probe — git-bash is present on
GitHub Windows runners via git.exe) and a portable held-open command
(`sleep 5 & echo done` — git-bash ships coreutils sleep), the same command
on both platforms. The cases asserting note **text** branch the expected
string on `IS_WINDOWS`, and the Windows-variant case must assert the
remedy text (tasklist/taskkill or wait) is present, not just that a note
exists. A defensive per-case `{ skip: IS_WINDOWS }` remains only as a
documented fallback — with an explicit note that the branch is then dead
on that runner.

**Fixture note.** The note's `setsid` recipe token is best-effort
(Linux-oriented — macOS lacks util-linux `setsid`); the subshell-redirect
recipe `(cd dir && cmd >log 2>&1 </dev/null) &` is the portable detach
form. The diagnosis does not depend on the recipe.

Raw-spawn cases clean up their log files explicitly (`rmSync` of
`session.logPath` in `cleanup()`) — `cleanupStaleLogs` only runs via
`session_start`, so a raw-spawn suite would otherwise leak one log per
case. Best-effort (try/catch): the log stream closes on a `setImmediate`
after exit, so the unlink can race the stream close — harmless on POSIX.

## Non-goals

- **No forced pipe close** — closing the pipe would kill the background
  jobs' output channel and surprise whoever relies on it.
- **No lifecycle change** — the session stays open, killable, pollable;
  exit detection, wake arms, observation leases, and the interaction lock
  are untouched.
- **No implicit kill** of background processes; **no Windows control
  magic** — the Windows kill limitation is pre-existing and documented; the
  note is honest about it rather than pretending `kill_session` works.
- **No change to pi's built-in `bash` tool** (the other shell). runbg's own
  exec_command guidance IS amended — see the guidance-relationship section
  and Deliverables §7.
- **No PTY-specific handling** — PTY sessions exit with their shell; the
  flag exists as an interface contract (Design §1).
- **No new tool parameters** — `note` is an output field only.

## Compatibility with existing divergences

| Divergence | Interaction |
|---|---|
| #3 log archive | none — note is derived from live session state, log unaffected |
| #7 interaction lock | none — `shellExited` is a read-only getter; tombstone echoes have `hasExited` true, so they never produce a note. The `cancelledWhileQueued` still-running site *does* get the note (Design §3, site 4) |
| #8 pipes-mode interrupt | the interrupt-path still-running result gets the note (site 3) |
| #6 session cap refusal | none — refusal happens at spawn; a held-open session is a *running* session that counts toward the cap, unchanged |
| #10 steering | none — the note rides on results that already exist |
| IV-0005 settled-gated wake | no wake *firing* interaction — wake arms stay pending until close, and a held-open session never closes on its own; the contract is documented and tested (Design §3, wiring cases 11–12) because a held-open session is precisely where a model might wait forever for an exit wake |
| IV-0002 bounded output | `note` renders as a header line in `renderProcessResultText` (same channel as `failure:`), outside the body truncation, bounded by `safeMeta`; plain-text constant, terminal-inert |

## Deliverables (sync contract)

The port must ship, in the same change:

1. the implementation (Design §1–§5);
2. `tests/held-open.test.ts` (Design §6);
3. **Changelog.md entry** under "Unreleased — 0.10.0" naming the upstream
   range reviewed (`v0.9.0..8493da5`) and the port verdict — the
   UPSTREAM.md sync contract requires a record for every sync;
4. **UPSTREAM.md divergence row #13** — compound row for the whole
   IV-0006 diagnosis surface (row #12's precedent: one row per
   divergence initiative), enumerating: (a) `list_sessions.shell_exited`
   + `[shell exited]` markers — upstream has none; (b) platform-specific
   remedy text (Windows tasklist/taskkill-or-wait; POSIX setsid escape
   qualifier) vs upstream's platform-neutral constant; (c) kill-failed
   results append the platform note — upstream does not; (d) TUI
   result-row note slot; (e) the note covers all six still-running sites
   (upstream: three) — a consequence of #7/#8, listed for completeness.
   The wrapper-level derivation is mechanism, not observable behavior —
   IV-internal only, no row. Status: "landed" when implemented.
7. the **scoped exec_command-description amendment** (src/index.ts, the
   never-background text): the kill claim is scoped to ordinary
   same-group children, the POSIX-setsid and Windows dead-root
   limitations are named, and the description points at the held-open
   note as the diagnosis surface. Prevention stance unchanged (see the
   guidance-relationship section).
5. README updates: a Semantic-notes bullet, the TUI section marker, the
   docs-tree line for IV-0006 (the tree lists every IV doc), and the
   fork-notice divergence list unchanged (no new divergence numbers
   beyond #13).
6. a **known-limitation record** in the README Windows section: on
   Windows, killing a held-open session returns `killed: false` (taskkill
   live-root limitation), with one sentence for the POSIX `setsid` escape
   — pointing at the kill-failed note append as the model-facing
   diagnosis surface. The `list_sessions` audit path shows the state
   (`shell_exited` / `[shell exited]`) but not the remedy; that is an
   explicit choice — a poll surfaces the note.

## Alternatives considered

1. **Detect and auto-close held-open sessions** (e.g. close the pipe after
   shell exit + grace). Rejected: changes lifecycle semantics; risks
   cutting off a legitimately long-lived background job the human *wants*
   to keep; upstream rejected it too. Diagnosis keeps the decision with the
   human/model.
2. **Only the model-facing note, no widget/picker markers.** Rejected: the
   human sees the widget every session; without the marker a human stares
   at a "still running" session whose work is done. Marker is one string.
3. **Command-text heuristics** (regex for `&`). Rejected: state-driven
   detection is complete and cannot false-positive; text matching can
   (e.g. `grep '&' file`).
4. **Pure upstream parity for `list_sessions`.** Rejected: runbg's
   list_sessions is already a richer audit surface (IV-0002); a held-open
   session is the one entry the model cannot otherwise distinguish; the
   field costs one boolean. The deviation is loud (UPSTREAM.md #13).
5. **Cause-specific note variants** (plain `&` job vs subshell chain).
   Rejected: the state carries no causal information; splitting forces
   command-text heuristics. The single constant names both causes and both
   recipes. The only split worth having is platform (Windows remedy).

## Relationship to the never-background guidance

runbg's tool guidance already tells the model never to background inside
`cmd` (exec_command description, src/index.ts): "the session IS the
background … if it inherits the session's output pipe, the session keeps
reporting [still running] long after your cmd finished". This IV is the
**diagnosis layer for when it happens anyway** — deliberately not a
permission to background.

- **Prevention vs diagnosis.** The guidance is prevention; the note is
  diagnosis of an already-happened state. The note never reads as a
  fallback license: its text is strictly descriptive, and the guidance's
  prevention stance stays loud.
- **Guidance amendment (Deliverables §7).** The description's kill claim
  currently overpromises: "kill_session ends it anyway" is true for
  ordinary same-group children but not for a POSIX `setsid`'d holder
  (escapes the group kill) or a Windows descendant whose parent shell is
  already gone (taskkill live-root). The amended text scopes the claim,
  names both limitations, and points at the held-open note: "if that
  happens, the [still running] result will say so and give the remedy".
- **`setsid` compatibility.** The guidance's "use setsid only when the
  human explicitly wants a process to outlive pi" is the *when*; the
  note's `setsid cmd >log 2>&1 </dev/null &` recipe is the sanctioned
  *how* for that deliberate case. Compatible — the recipe always carries
  the redirects, so following it never produces the diagnosed state.
- **Carrier matrix.** Tool descriptions are the universal carrier (they
  reach the model in every prompt mode — replace-mode templates drop
  promptGuidelines/toolSnippets but never the tool schema docs; this is
  why the IV-0004 wait contract lives in the descriptions). The amended
  description therefore suffices for prevention. `modified-pi.md`
  (`~/.pi/agent/sysprompts/`, append-mode) was audited: it keeps the
  default prompt branch and carries wait-mode guidance only — **no edit
  required**, recorded here for the IV-0004 carrier audit.
- Stance, verbatim: **diagnosis after prevention, not permission to
  background.**

## Cost

Actual (implementation): src/pty.ts +28, src/session.ts +13, src/tool-result.ts +8, src/index.ts +92, src/render.ts +10, tests/held-open.test.ts 506 lines (16 cases).

`note` is an output-envelope field — zero input-schema tokens. Runtime token cost (measured): the compressed note is ~427 chars POSIX / ~483 chars Windows ≈ 105–120 tokens per occurrence, incurred only on still-running results of held-open sessions (and on kill-failed results that append it); it repeats on every poll of such a session. Recurring cost: the exec_command description amendment adds ~470 chars ≈ 118 tokens to the system prompt every turn (descriptions are the universal carrier; replace-mode templates drop guidelines but never the schema docs) — the accepted price of keeping the prevention contract in the replace-mode-safe carrier. No runtime cost when the state is absent (one boolean read per result).

## Resolved decisions (df-worker round, accepted)

1. **`shell_exited` on `list_sessions`: yes** — with the semantics above
   (absent for reaped rows), all three surfaces (details field, text
   marker, TUI marker), and the UPSTREAM.md #13 row. Without those three
   the field is half a feature and the port violates the fork contract.
2. **Single note constant** — the state carries no causal information;
   splitting forces command-text heuristics. Platform variation only
   (Windows remedy).
3. **PTY flag kept** — interface contract, not symmetry (Design §1).
4. **No `failureMessage` gating** — spawn failures always have
   `hasExited: true` before any result is assembled, so the note is
   already false there; `recordFailure` (log mirroring broke) is orthogonal
   and both lines are truthful. Evaluation order flipped to
   `!hasExited && shellExited` regardless.
5. **TUI result row note slot: included** (Design §4) — cheap, and the
   human should see the diagnosis on the result row, not only in the
   widget.

## Round-2 nits (df-worker discussion round, accepted)

1. **N1 — guard at site 4** (correctness): `cancelledWhileQueued` can see a
   reaped-only store miss; the note call must be `session ?
   heldOpenNote(session) : undefined` (Design §3).
2. **N2 — Windows remedy wording**: must stay model-actionable — `tasklist`
   / `taskkill /pid` to find the holder, or wait for the last pipe holder
   to exit; jargon removed (Design §3).
3. **N3 — Windows test policy**: raw state cases `{ skip: IS_WINDOWS }`
   (repo convention); wiring cases branch expected note text on
   `IS_WINDOWS` (Design §6).
4. **N4 — log cleanup race**: `rmSync` best-effort in try/catch; the log
   stream closes on a `setImmediate` after exit (Design §6).
5. **N5 — kill-failed advice**: recorded as a known limitation (Deliverables
   §6) instead of carrying the note onto kill-failed results — keeps
   scope.
6. **N6 — audit-path remedy**: `list_sessions` shows the state, not the
   remedy; explicit choice recorded (Deliverables §6).

Verdict: **agree-with-nits** — no blockers, no majors; N1 is the only
implementation-correctness item. Six-site enumeration verified complete
against all 14 `finalizeProcessResult` sites in src/index.ts.

## Round-3 amendments (dp-worker discussion round, all accepted)

1. **Wrapper-level note derivation** replaces per-site copies (Design §3):
   three tool-local `finalizeResponse` wrappers gate on
   `input.sessionId !== undefined`; `cancelledWhileQueued` keeps the
   explicit guarded call. Recorded as a deliberate divergence from
   upstream's per-site copies.
2. **POSIX `setsid` qualifier** added to the note constant (Design §3) —
   a setsid'd holder escapes the group kill; the README known-limitation
   record gains a POSIX-setsid sentence.
3. **Windows wiring-test pin** (Design §6): explicit `shell: "bash"` +
   portable command on both platforms, remedy-text assertion, defensive
   skip documented as dead branch.
4. **Kill-failure note append** (Design §3): `!killed &&
   !session.hasExited && session.shellExited` → append the
   platform-variant note at the single killFailure site; N5 upgraded from
   limitation-record to mechanism; new wiring test.
5. **Doc accuracy**: 14 finalize sites (not 13); Cost fixed (zero schema
   tokens; ~40 content tokens on held-open results); Deliverables §5 adds
   the docs-tree line.
6. **Informational**: UPSTREAM.md's divergence table has a pre-existing
   gap at #11 — row #13 is still correct; a doc footnote would stop
   anyone "filling" #11 with this work later (not in scope here).

Verdict: **agree-with-nits** — 9 findings, all resolved by the accepted
amendments; no blockers, no majors. Residual note (wording only):
`heldOpenNote` is evaluated at result-assembly; the session can exit
before the model reads it — the note's phrasing stays staleness-tolerant
("still reporting [still running]"), as upstream's text already is.

## Round-4 amendments (worker-sol discussion round, all accepted)

1. **Wake contract documented and tested** (Design §3): `shellExited` is
   diagnostic only; wake arms stay pending until close; the note gains
   the clause "(an armed on_exit wake stays pending until then)"; wiring
   case 11 pins armed → not-fired → survives → disarm.
2. **Defensive getter** (Design §2): `this.child?.processExited ??
   false`; test case 5 pins both failure paths (sync throw + async
   ENOENT).
3. **Compound UPSTREAM.md row #13** (Deliverables): enumerated scope
   (a)–(e); wrapper mechanism stays IV-internal.
4. **Wiring case 12** (Design §6): forced-failed kill on a held-open
   session (POSIX) asserting `[kill failed]` + platform note + session
   still listed + wake eligibility restored.
5. **Portable fixture** (Design §6): `python3 -c "import os,time;
   os.setsid(); time.sleep(5)" &` instead of the `setsid` binary
   (util-linux, absent on macOS by default); recipe-token caveat
   recorded.

Verdict: **agree-with-nits, conditional on the five accepted
amendments** — all resolved in discussion; no blockers, no majors.

## Round-5 amendments (worker-sol guidance-relationship follow-up, all accepted)

1. **Guidance amendment scoping the kill claim** (exec_command
   description, src/index.ts): kill_session's reach limited to ordinary
   same-group children; POSIX-setsid and Windows dead-root limitations
   named; pointer to the held-open note added (Deliverables §7).
2. **Non-goal narrowed** to "No change to pi's built-in `bash` tool" —
   runbg's own guidance does change.
3. **New section** "Relationship to the never-background guidance":
   prevention vs diagnosis; setsid when/how compatibility; carrier
   matrix (tool description universal, modified-pi.md audited-no-edit);
   stance "diagnosis after prevention, not permission to background".

Verdict: **agree-with-nits, contingent on the accepted amendments** —
all resolved in discussion.

## Resolved questions (df-worker + dp-worker rounds)

1. Windows remedy wording — refined by dp-worker (model-actionable:
   tasklist/taskkill or wait) and now pinned by tests (Design §6).
2. Six-site completeness — verified against all 14 finalize sites by both
   reviewers; no missed site.
3. Widget marker platform-neutral — agreed by both reviewers; the note
   carries the detail.
