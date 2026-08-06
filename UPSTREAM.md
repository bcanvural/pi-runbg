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
| 1 | Keep pi's built-in `bash` by default; `--replace-builtin-bash` opts into upstream's removal (upstream default removes `bash`, flag `--keep-builtin-bash` to keep). Startup warning when the upstream package is installed alongside (same tool names). | Templates that don't know the session tools must keep a shell; user-side `bash` guards must not be silently bypassed (§7.1) | landed |
| 2 | Best-effort crash cleanup: `process.on("exit")` synchronously group-kills live sessions (installed at `session_start`, removed at `session_shutdown`; SIGKILL'd hosts still orphan) | pi's crash paths (`uncaughtException`, dead terminal) skip `session_shutdown`; upstream orphans children (§7.2) | landed |
| 3 | Log archive safety: `0600` + exclusive create, per-session size cap, `log_status`, startup cleanup of stale logs | Adopts upstream's own IV-0002 follow-up backlog (§7.3) | planned |
| 4 | Bounded relative-poll accumulation (head/tail buffer instead of an unbounded chunk array in `collectOutputUntilDeadline`) | A chatty child during a 290 s empty poll can accumulate GBs in-process (§7.4) | planned |

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
