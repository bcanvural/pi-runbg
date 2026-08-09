# Upstream relationship

This package is a fork of
[iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec)
(MIT, by Ren Wang). Upstream is actively developed but closed to external
contributions (issues disabled, PRs not accepted, forks invited) — so fixes
flow one way: from upstream to us, by cherry-pick.

- **Fork point:** tag `v0.9.0` = `7c8c1d809ef80d25fb60b5129248b2077b2422e9`
  (2026-08-04), merged into this repo with full history on 2026-08-06.
- **Contract:** tool names (`exec_command`, `write_stdin`, `set_on_exit`,
  `kill_session`, `list_sessions`), schemas, and constants stay verbatim so
  prompt text remains portable and upstream diffs stay cherry-pickable.
  Divergences are deliberate, loud, and listed here — never silent.

## Identity renames (no behavior change)

| Upstream | Fork |
|---|---|
| npm package `pi-unified-exec` | `pi-runbg` (unpublished; local install) |
| `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` | `PI_RUNBG_MAX_EMPTY_POLL_MS` |
| `PI_UNIFIED_EXEC_BASH` | `PI_RUNBG_BASH` |
| log prefix `pi-unified-exec-<sid>-` | `pi-runbg-<sid>-` |
| wake `customType: "unified-exec-completed"` | `"runbg-completed"` |
| wake message prefix `[unified-exec]` | `[runbg]` |
| slash command `/unified-exec-sessions` | `/runbg-sessions` |
| UI widget/status key `unified-exec.sessions` | `runbg.sessions` |
| user-facing `unified-exec:` strings | `runbg:` |

Also removed: `publish.yml` (npm Trusted Publisher bound to the upstream
repo; publishing is deferred — design doc §13.1) and
`interaction-limit-reminder.yml` (upstream-repo housekeeping).

Kept as historical record with upstream names intact: `docs/IV-*.md`,
`docs/DC-0001-*.md`, `to_improve.md`, pre-fork `Changelog.md` entries.

## Behavior divergences

Each entry names the design-doc section that motivates it and the commit
that landed it. See `docs/design.md` §7.

| # | Divergence | Rationale | Status |
|---|---|---|---|
| 1 | Keep pi's built-in `bash` by default; removal is opt-in via the persisted `/runbg replace-bash on` setting, or `--replace-builtin-bash` for one invocation (upstream default removes `bash`, flag `--keep-builtin-bash` to keep). The flag can only force removal *on* — pi cannot distinguish an explicit `=false` from an absent boolean flag — so the setting is the only way to turn it back off. Removal/restore applied at session start and on every `/runbg` write, with a latch so runbg only restores a `bash` it removed itself (and says so when a `/reload` cleared that record); `bash` is never traded away unless an `exec_command` is actually active. Startup warning when the upstream package is installed alongside — best-effort and load-order-dependent (if runbg's registration won, the upstream package is invisible to the registry and no warning fires). | Templates that don't know the session tools must keep a shell; user-side `bash` guards must not be silently bypassed (§7.1) | landed |
| 2 | Best-effort crash cleanup: `process.on("exit")` synchronously group-kills live sessions (installed at `session_start`, removed at `session_shutdown`; SIGKILL'd hosts still orphan) | pi's crash paths (`uncaughtException`, dead terminal) skip `session_shutdown`; upstream orphans children (§7.2) | landed |
| 3 | Log archive safety: `0600` + `O_EXCL` create (collision-retried, symlinks never followed), per-session mirror cap `PI_RUNBG_MAX_LOG_BYTES` (default 256 MiB, `0` unlimited), `log_status: partial\|unavailable` in results with "Full output" withheld when degraded, age-based startup cleanup `PI_RUNBG_LOG_TTL_DAYS` (default 7, `0` disables) | Adopts upstream's own IV-0002 follow-up backlog (§7.3) | landed |
| 4 | Bounded relative-poll accumulation: `collectOutputUntilDeadline` retains drained bytes in a second head/tail buffer (session retention + 4 KiB marker headroom) instead of an unbounded chunk array; call-level drops get their own spliced marker and count into `omitted_bytes` | A chatty child during a 290 s empty poll can accumulate GBs in-process (§7.4) | landed |
| 5 | Session tools ship dormant; `/runbg on\|off\|status` toggles them via `setActiveTools`, persisted in `<agentDir>/runbg.json` (a settings namespace — unknown keys preserved, known keys normalized with a strict `=== true`). `/runbg` is a general settings command: one table drives its grammar, completions and status line, so `replace-bash` (divergence #1) is a peer setting rather than a special case. Bash replacement only acts while enabled. Upstream has no gating: tools are always active | Install globally without exposing the tools to every prompt; enable by hand alongside a template that teaches them (design §14) | landed |
| 6 | **Refuse at the session cap** instead of LRU-killing a live session: exited entries are reaped first (protected-set or not), and a cap hit returns an actionable error naming `kill_session` / `/runbg-sessions`. Checked pre-spawn *and* re-checked after the early-exit grace, where refusal kills the newborn with full escalation so nothing leaks. Cap configurable via `PI_RUNBG_MAX_SESSIONS` (default 64, codex's constant). Upstream SIGTERM'd the LRU unprotected session — one unconfirmed signal, after which a surviving child was out of the store and thus invisible to `list_sessions`, `kill_session` and the crash reaper | Silently killing a live process to make room breaks whatever depended on it and manufactures untracked orphans; codex additionally refuses to evict a process under an active interaction | landed |
| 10 | **Queued human input ends an attached wait** (`exec_command`'s attach, `write_stdin` polls AND input writes), reported as `wait_status: "yielded_for_user_message"`. Merged into the *preempt* signal, so the wait drains buffered output first and only then stops; the process is untouched. Disabled by `/runbg steer off`. Two constraints are worth knowing. (a) `hasPendingMessages()` counts steering AND follow-up messages together with no way to tell them apart, and pi drains them at different times — steering between tool batches, follow-ups only after the turn ends — so a follow-up would otherwise make every wait yield for the rest of the turn. Each episode therefore carries a small yield BUDGET (8). A once-per-episode latch and a start-time rule were both tried and rejected: pi runs a tool batch in PARALLEL, so a latch left siblings in full-length waits and the batch could never end — worse than not yielding at all — while the start-time rule assumed siblings begin within milliseconds and was observed under load to deny a late sibling, reproducing that same stall. A counter carries no timing assumption. (b) `yield_until` absolute waits are deliberately NOT steer-aware: they are explicitly heartbeat-free, and the human has already opted into a long attached wait. Not in upstream or codex | pi delivers steering only after every tool call in a batch finishes, so a long attached wait holds the human's message hostage — and with plain `bash` the only escape is Esc, which kills the command. Ending the wait is safe here precisely because the session owns the process. Modelled on oh-my-pi, which skips a pending tool call outright when a message is queued (*"Do not count this skipped result as completed work… retry the skipped tool if it is still needed"*). This is a workaround for a host-level gap: the complete fix belongs in pi, which could defer pending tool calls batch-wide for every tool, not just these five | landed |
| 9 | **Attached waits reach 290 s**, the same cache-friendly ceiling as empty polls, instead of upstream's 30 s (`exec_command`, and `write_stdin` WITH input; defaults unchanged at 10 s / 250 ms). `PI_RUNBG_MAX_EMPTY_POLL_MS` names the empty-poll path and deliberately does not lower this | Upstream's 30 s arrived under a "mirror codex" banner with no recorded rationale, while the constant beside it carries an argued one. Its effect: every job in the 30 s–5 min band (test suites, builds, installs, migrations) cost two calls — a short yield for a `session_id`, then an empty poll of the same length. Both block the same turn for the same time, so the asymmetry bought only a wasted round trip. Compare oh-my-pi, which blocks 300 s by default and up to 3600 s on one call | landed |
| 8 | **Pipes-mode interrupt**: `chars` consisting of exactly `\x03` sends SIGINT to the process group instead of writing the byte. Embedded `0x03` in longer input still writes, and `chars_b64` is never reinterpreted (raw-bytes escape hatch for children that consume `0x03` as protocol data). Upstream wrote the byte in both modes | Port-fidelity fix: a PTY's line discipline turns `0x03` into SIGINT, but on pipes there is no line discipline, so the byte is inert for nearly every child — the model's "Ctrl-C" silently did nothing. Codex maps interrupt input to a real signal for non-tty processes (and rejects all other non-tty input; we stay more permissive) | landed |
| 7 | **Per-session interaction serialization** (`src/interaction-lock.ts`): reads/writes/kill-drains against one session never overlap. Empty progress polls hold the lock *preemptibly* (queue-aware: a preemptible holder stops parking whenever anyone is queued) and report `wait_status: "preempted"`; queued interactions cancelled while waiting are dropped rather than executed late; `yield_until` parks lock-free and locks only its drains. A call queued behind the exit observer gets a truthful `[exited]` echo from a bounded tombstone ring instead of "unknown session_id". Upstream had no lock while pi runs a turn's tool batch in parallel | Port-fidelity fix: codex has a per-process `interaction_lock` ("reads and writes against one terminal must not overlap because they share a draining output buffer"). Without it, overlapping polls starved each other (one returning zero bytes for its whole window) and both ran a live terminal drain for the same exit (now at most one drains; the other gets a labeled echo). Preemption is ours: our waits reach 290 s, so a plain FIFO lock would make interrupts wait behind a parked poll | landed |

## Syncing from upstream

```bash
git remote add upstream https://github.com/iamwrm/pi-unified-exec.git  # once
git fetch upstream --tags
git log --oneline v0.9.0..upstream/main        # what's new upstream
git cherry-pick <sha>                          # take wanted commits
npm test                                       # full suite must stay green
```

After each sync: record the range reviewed and the verdict in
`Changelog.md` (see `docs/DEV.md` "Checking upstream compatibility"), and
reconcile anything that touches a divergence above.
