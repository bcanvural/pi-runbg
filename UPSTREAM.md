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
| 1 | Keep pi's built-in `bash` by default; `--replace-builtin-bash` opts into upstream's removal (upstream default removes `bash`, flag `--keep-builtin-bash` to keep). Removal/restore applied at session start and on `/runbg on\|off`, with a latch so runbg only restores a `bash` it removed itself. Startup warning when the upstream package is installed alongside — best-effort and load-order-dependent (if runbg's registration won, the upstream package is invisible to the registry and no warning fires). | Templates that don't know the session tools must keep a shell; user-side `bash` guards must not be silently bypassed (§7.1) | landed |
| 2 | Best-effort crash cleanup: `process.on("exit")` synchronously group-kills live sessions (installed at `session_start`, removed at `session_shutdown`; SIGKILL'd hosts still orphan) | pi's crash paths (`uncaughtException`, dead terminal) skip `session_shutdown`; upstream orphans children (§7.2) | landed |
| 3 | Log archive safety: `0600` + `O_EXCL` create (collision-retried, symlinks never followed), per-session mirror cap `PI_RUNBG_MAX_LOG_BYTES` (default 256 MiB, `0` unlimited), `log_status: partial\|unavailable` in results with "Full output" withheld when degraded, age-based startup cleanup `PI_RUNBG_LOG_TTL_DAYS` (default 7, `0` disables) | Adopts upstream's own IV-0002 follow-up backlog (§7.3) | landed |
| 4 | Bounded relative-poll accumulation: `collectOutputUntilDeadline` retains drained bytes in a second head/tail buffer (session retention + 4 KiB marker headroom) instead of an unbounded chunk array; call-level drops get their own spliced marker and count into `omitted_bytes` | A chatty child during a 290 s empty poll can accumulate GBs in-process (§7.4) | landed |
| 5 | Session tools ship dormant; `/runbg on\|off\|status` toggles them via `setActiveTools`, persisted in `<agentDir>/runbg.json` (a settings namespace — unknown keys preserved). `--replace-builtin-bash` only acts while enabled. Upstream has no gating: tools are always active | Install globally without exposing the tools to every prompt; enable by hand alongside a template that teaches them (design §14) | landed |
| 6 | **Refuse at the session cap** instead of LRU-killing a live session: exited entries are reaped first (protected-set or not), and a cap hit returns an actionable error naming `kill_session` / `/runbg-sessions`. Checked pre-spawn *and* re-checked after the early-exit grace, where refusal kills the newborn with full escalation so nothing leaks. Cap configurable via `PI_RUNBG_MAX_SESSIONS` (default 64, codex's constant). Upstream SIGTERM'd the LRU unprotected session — one unconfirmed signal, after which a surviving child was out of the store and thus invisible to `list_sessions`, `kill_session` and the crash reaper | Silently killing a live process to make room breaks whatever depended on it and manufactures untracked orphans; codex additionally refuses to evict a process under an active interaction | landed |
| 8 | **Pipes-mode interrupt**: `chars` consisting of exactly `\x03` sends SIGINT to the process group instead of writing the byte. Embedded `0x03` in longer input still writes, and `chars_b64` is never reinterpreted (raw-bytes escape hatch for children that consume `0x03` as protocol data). Upstream wrote the byte in both modes | Port-fidelity fix: a PTY's line discipline turns `0x03` into SIGINT, but on pipes there is no line discipline, so the byte is inert for nearly every child — the model's "Ctrl-C" silently did nothing. Codex maps interrupt input to a real signal for non-tty processes (and rejects all other non-tty input; we stay more permissive) | landed |
| 7 | **Per-session interaction serialization** (`src/interaction-lock.ts`): reads/writes/kill-drains against one session never overlap. Empty progress polls hold the lock *preemptibly* (queue-aware: a preemptible holder stops parking whenever anyone is queued) and report `wait_status: "preempted"`; queued interactions cancelled while waiting are dropped rather than executed late; `yield_until` parks lock-free and locks only its drains. A call queued behind the exit observer gets a truthful `[exited]` echo from a bounded tombstone ring instead of "unknown session_id". Upstream had no lock while pi runs a turn's tool batch in parallel | Port-fidelity fix: codex has a per-process `interaction_lock` ("reads and writes against one terminal must not overlap because they share a draining output buffer"). Without it, overlapping polls starved each other (one returning zero bytes for its whole window) and both delivered a terminal result for the same exit. Preemption is ours: our waits reach 290 s, so a plain FIFO lock would make interrupts wait behind a parked poll | landed |

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
