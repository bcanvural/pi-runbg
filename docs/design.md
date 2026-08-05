# pi-runbg — design doc

**Status:** design only. Implementation intentionally deferred until this document is agreed.
**Companion repo:** `pi-sysprompt` (template wiring section at the end).

---

## 1. Problem

Pi's `bash` tool is synchronous: the agent turn blocks until the command exits
(or pi's tool timeout kills it). Consequences:

- Long-running work (builds, test suites, `npm install`, migrations, dev
  daemons) risks hitting tool timeouts or making the session feel stuck.
- There is no way to start a long process and *continue doing other work* in
  the same turn.
- Nothing survives between turns: no polling, no resumption, no monitoring.
- The codex-prompt "persistence" ethos ("start a job, poll it, react to it")
  has no backend in pi — the `-pi` template adaptations currently degrade those
  rules to "check periodically within the current turn".

The one community attempt (`pi-unified-exec`) is unmaintained and had problems
in practice.

## 2. Goals

- **G1 — Start detached:** `bg_run` spawns a process outside the turn and
  returns a job id immediately (non-blocking).
- **G2 — Query anytime:** `bg_status` reports state (running / exited / failed),
  exit code, elapsed time, and log tail — same turn or a later session.
- **G3 — Bounded wait:** `bg_wait` blocks within a turn up to a cap when the
  agent *chooses* to block (rather than always blocking implicitly).
- **G4 — Safe teardown:** `bg_kill` / `bg_cleanup` stop jobs and reap state
  without leaving orphaned processes.
- **G5 — Headless-safe:** all tools work in `pi -p` mode (no UI dependency;
  unlike `ask_user_question`, these are purely file/process based).
- **G6 — Survive pi:** jobs keep running after pi exits (detached), with
  explicit cleanup semantics, so a later session can resume them.

## 3. Non-goals (v1)

- Cross-turn *autonomous* monitoring or completion notifications. Pi has no
  background scheduler; anything event-driven would require a polling daemon
  running outside pi — a separate project, not this extension.
- Scheduling, retries, cron, resource dashboards.
- Replacing `bash` for normal commands. `bg_*` is for work expected to exceed
  ~60–90s, or that the agent wants to interleave with.

## 4. Tool surface

Snake_case names, consistent with pi conventions (`ask_user_question`, ...).

| Tool | Params | Returns |
|---|---|---|
| `bg_run` | `command: string`, `args?: string[]`, `cwd?: string`, `env?: {…}`, `shell?: boolean`, `timeout?: number`, `persist?: boolean` | `{ jobId, pid, cwd, startedAt }` |
| `bg_status` | `jobId` | `{ state, exitCode?, elapsedMs, logBytes, tail? }` |
| `bg_logs` | `jobId`, `offset?: number`, `limit?: number`, `grep?: string` | `{ lines, nextOffset }` |
| `bg_wait` | `jobId`, `timeoutS` (default 300, max 1800) | final `bg_status` shape |
| `bg_kill` | `jobId` | `{ jobId, state: "killed" }` |
| `bg_list` | `cwd?: string` | `[{ jobId, command, state, pid, startedAt }]` |
| `bg_cleanup` | `olderThanS?: number` | `{ removed: [jobId] }` |

**Design notes:**

- `bg_run` takes an **argv array, not a shell string** by default → no shell
  injection. `shell: true` is an explicit opt-in for `&&` chains / pipes, and
  the job record flags it so `bg_list` shows which jobs ran under a shell.
- `persist: false` marks scratch jobs that should be auto-killed if pi exits;
  default `persist: true` (jobs survive — that's the point). See §9.
- `bg_logs` reads the log file with offsets so the model never re-reads the
  whole file; `grep` filters server-side for cheap diagnostics.

## 5. Process & state model

```
spawn (detached, process-group leader)
   │  stdout/stderr ──► log file (capped, see §7)
   ▼
job record JSON (state: running) ──► helper waits on exit
   │                                     │
   └─────────────────────────────────────┘  finalizes record (exited/failed/killed)
```

- **Spawn:** `child_process.spawn(cmd, args, { detached: true, stdio:
  ['ignore', logFile, logFile], cwd, env })`. `detached: true` makes the child a
  process-group leader on POSIX, so `bg_kill` can target the whole group
  (`process.kill(-pid, …)`) — no half-killed children.
- **State storage:** one JSON file per job under a **global** state dir
  (`~/.pi/agent/runbg/jobs/<jobId>.json`), logs under
  `~/.pi/agent/runbg/logs/<jobId>.log`. Global, not per-project: jobs are
  started from a project cwd (recorded on the job) but must be visible from any
  session/project. (Deliberate departure from sysprompt's global-only stance —
  there it was about *prompt* config; here it's about *process* ownership.)
- **States:** `running → exited(0) | failed(nonzero | timeout | killed)`.
- **Reaper:** the parent extension writes the `running` record, then a tiny
  detached helper (`bin/runbg-helper.mjs <jobId>`) `waitpid`s on the child and
  writes the final record even if pi dies mid-run. This avoids lazy reaping
  hacks (can't distinguish "finished" from "died with pi" via `kill(pid, 0)`).
  The helper is the only external script and ships with the extension.
- **Stale detection:** on extension load, records still marked `running` whose
  pid is dead (`kill(pid, 0)` → ESRCH) are marked `failed (died with host)`.

## 6. Turn-model integration (the honest part)

Pi has no background monitor, so the *in-turn* pattern the templates should
teach the model is:

1. `bg_run` anything expected to exceed ~60–90s (or to interleave with).
2. Keep working in the same turn.
3. `bg_status` / `bg_wait` to collect results.
4. If the turn must end with a job still running: **report the `jobId` and how
   to resume** ("ask me to check job `<id>`") — do not silently abandon it.
5. `bg_kill` + `bg_cleanup` when done.

Cross-turn, a later session can `bg_status` the same job (global state) and
continue it — restoring most of the codex "persistence" ethos without a daemon.

## 7. Safety

- **Process groups everywhere** — `bg_kill` targets the group, never just the
  leader pid.
- **No shell by default**; shell jobs are flagged in `bg_list`.
- **Per-job timeout** (`timeout` param, SIGTERM then SIGKILL escalation);
  `bg_wait` caps at 1800s.
- **Log caps** — default 10 MB per job (truncate-oldest or ring); `bg_logs`
  never returns the whole file.
- **Concurrency cap** — max 8 running jobs by default (configurable), to avoid
  accidental fork-bombs.
- **Orphan policy** — jobs survive pi by design; document it in the README and
  in the tool descriptions. `bg_kill` / `bg_cleanup` are the escape hatches;
  also ship a tiny manual CLI (`node bin/runbg.mjs list|status|kill`) for
  humans outside pi.
- **No secrets in tool output** — tools return paths/jobIds only; the model
  reads log files itself via `read`.

## 8. Why not the alternatives

- **tmux / `nohup ... &` via `bash`:** works manually, but there's no state
  tracking — the model can't reliably find its own job, poll it, or clean it
  up. Error-prone and leaves orphans as a matter of course.
- **pi-unified-exec:** unmaintained; user-reported problems; no design docs to
  learn from.
- **Pi built-in:** verified absent (tool list in README).

## 9. Open questions

1. **`bg_wait` vs `bg_status` split** — keep them separate (status stays
   cheap/instant) or fold wait into status via a `waitFor` param?
2. **Per-project visibility** — should `bg_list` filter by cwd, and should
   `~/.pi/agent/runbg` be sharded per-project instead of global?
3. **`persist: false` semantics** — auto-kill on pi exit for scratch jobs:
   worth the complexity in v1, or ship `persist: true` only?
4. **UI affordance** — `ctx.ui.setStatus("runbg", "2 running")` while jobs are
   active: nice touch, but verify it plays well with headless mode.
5. **Reaper helper vs lazy reaping** — proposal is a detached helper for exact
   exit codes; is the extra script worth it vs. best-effort lazy reaping?
6. **Config surface** — how should caps/log limits/concurrency be configured
   (frontmatter in the extension dir's config, env vars, constants)?

## 10. Implementation sketch (for later)

```
pi-runbg/
├── extensions/runbg.ts        ← registerTool ×7, state dir mgmt, spawn wrapper
├── bin/runbg-helper.mjs       ← detached reaper (waits on child, finalizes record)
├── bin/runbg.mjs              ← manual CLI for humans (list/status/kill)
├── package.json               ← manifest; devDeps @earendil-works/pi-coding-agent, tsc
└── tsconfig.json
```

Typecheck workflow identical to `pi-sysprompt` (`npm i`, `npx tsc --noEmit`),
symlinked into `~/.pi/agent/extensions/`.

## 11. Template wiring (in `pi-sysprompt`)

- Add a **"Long-running tasks"** section to the `-pi` templates teaching the
  §6 pattern (`bg_run` → work → `bg_status`/`bg_wait` → report `jobId` if the
  turn ends).
- Reminder from the ask-tool investigation: pi injects `promptSnippet` /
  `promptGuidelines` **only in the default (non-custom) prompt branch** —
  custom prompts (our templates) must carry this guidance themselves.
- Same applies to naming `ask_user_question` explicitly in templates (currently
  `codex-sol-pi` only says "stop and ask the user" without naming the tool).
