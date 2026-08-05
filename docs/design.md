# pi-runbg — design doc (v2, aligned with pi-unified-exec)

**Status:** design only — nothing implemented yet.
**Companion repos:** `pi-sysprompt` (template wiring, §11), `pi-webfetch` (sibling web-tool design).

> **v2 change:** this design now builds on the existing community extension
> **pi-unified-exec** (MIT, faithful port of codex's `unified_exec` session
> model) instead of inventing a fresh tool set. The repo's job is to carry
> that design forward: fork it, keep its proven tool surface, and add the
> system-prompt integration that fixes the long-running-loop failure mode.

---

## 1. Problem

Pi's built-in `bash` tool blocks until the process exits. Long-running work
(dev servers, `tail -f`, REPLs, builds, migrations) either burns context
waiting, hits tool timeouts, or dies with the turn. There is no way to start a
process and drive it across turns — which is exactly what codex's prompt
philosophy ("start a job, poll it, react to it") assumes.

**The loop failure mode we hit in practice:** an agent given a long-running
process tends to tight-loop — poll → returns "still running" → poll again —
burning turns and thrashing the prompt cache, or arming `wake` "just in case"
and getting stale resumes. The upstream project already diagnosed this
(docs/IV-0001): agents used `yield_until` to bypass the 290 s empty-poll cap,
and tool guidance over-promoted `on_exit: "wake"`. Root cause is *agent
guidance*, not the tooling — which matches the observation that the loop
problem disappeared once the system prompt was prepared for it.

## 2. What already exists

**pi-unified-exec** ([iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec),
MIT, `pi install npm:pi-unified-exec`):
- Ports codex's `unified_exec` session model verbatim ("faithful port... with
  codex's constants preserved").
- Tool surface: `exec_command`, `write_stdin`, `set_on_exit`, `kill_session`,
  `list_sessions`.
- Long-lived sessions with two-way I/O: every byte mirrored to an on-disk log
  (recoverable via `read(log_path)`), in-memory tail capped at 50 KiB /
  2000 lines.
- Bounded waits so the agent never stalls: 30 s interactive yield, 290 s
  background-poll cap, `yield_until` absolute-UTC attached waits (multi-day,
  safe timer re-arming).
- `on_exit: "wake"` (default `"none"`) — exactly one follow-up model prompt on
  background exit, consumed by direct observation, disarmed via `set_on_exit`
  without killing.
- PTY mode for interactive programs (Python REPL, ssh, sudo, TUIs);
  `write_stdin` decodes C-style escapes (`\x03` Ctrl-C, `\x04` EOF…).
- 250+ tests, real design docs (DC-0001 workspace doctrine, IV-0001
  long-wait/wake control), CI, published to npm.
- **Maintenance notice:** unmaintained; issues disabled; PRs not accepted →
  fork it (MIT).

**Codex itself** confirms the direction: its config exposes
`experimental_use_unified_exec_tool`, `background_terminal_max_timeout`,
`job_max_runtime_seconds`, `max_concurrent_threads_per_session` — the same
session/background concepts.

## 3. Decision

v1 = **fork pi-unified-exec** (MIT) into this repo, keeping its tool surface,
constants, and tests, and add:

1. **System-prompt integration** — the actual fix for the loop problem. Teach
   the model the session discipline (see §6) via the `-pi` templates.
2. **Headless-safety review** — verify every tool behaves in `pi -p` mode.
3. **Hardening/fixes** we find while using it (cache-friendliness of the
   default poll path is already handled upstream — 0.7.2).

## 4. Tool surface (preserved from upstream)

| Tool | Params | Returns |
|---|---|---|
| `exec_command` | `command`, `workdir?`, `interactive?` (pty), `yield_time_ms?` (≤ 290 000), `yield_until?` (RFC 3339 UTC), `on_exit?` (`"none"` \| `"wake"`), `vars?` | `{ session_id, state, exit_code?, tail, output_size, tool_time_utc, … , log_path }` |
| `write_stdin` | `session_id`, `chars` (C-escapes decoded), `chars_b64?`, `yield_time_ms?` | session snapshot + tail |
| `set_on_exit` | `session_id`, `on_exit: "none"\|"wake"` | `{ session_id, on_exit, state, wake_armed }` |
| `kill_session` | `session_id` | final snapshot (tail-capped) |
| `list_sessions` | — | sessions + `wake_armed` / `[wake]` audit |

Constants (preserve): interactive yield 30 s; background poll cap 290 s;
`yield_until` human-explicit only (see §6); output caps 50 KiB / 2000 lines
with full stream at `log_path`; terminal-control sequences stripped from
model/TUI text; `on_exit` default `"none"`.

## 5. Process & state model

- One long-lived session per `exec_command`, keyed by `session_id`, driving
  the same process across turns via `write_stdin` + polls.
- On-disk log mirror (complete history) + bounded in-memory tail.
- Wake delivery: exactly one follow-up model prompt with bounded exit metadata
  when a backgrounded process exits unobserved; consumed if observation saw
  the exit; disarmed via `set_on_exit` (tombstones); `kill_session` suppresses
  wake. A disarmed wake cannot recall an already-queued follow-up
  (`pi.sendMessage`).
- Timers chunked at `MAX_TIMER_ARM_MS` (`2^31-1`) for multi-day `yield_until`.

## 6. Turn-model integration & agent guidance (the loop fix)

Upstream's shipped guidance, adopted verbatim — this is the discipline the
system prompt must teach:

```text
yield_time_ms ≤ 290s     → default progress polls (repeat OK, cache-friendly)
yield_until              → ONLY if human explicitly asks for long attach / UTC deadline
on_exit default          → "none"
on_exit "wake"           → ONLY if human explicitly wants auto-resume
mistaken / abandoned wake → set_on_exit(session_id, on_exit: "none")  # does not kill
kill_session             → kill process AND suppress wake
list_sessions            → includes wake_armed for audit
```

Plus session hygiene for the model:

- **Never tight-loop a poll.** If a session is running and there's nothing
  useful to do until it exits, end the turn and report the `session_id` with
  how to resume ("ask me to check session `<id>`").
- Prefer `on_exit: "wake"` over polling when the human asked to be resumed.
- When resuming, start from `list_sessions` + `read(log_path)` — do not
  restart the process.

## 7. Safety

- **Pi extension constraint (from pi docs):** extension factories must not
  start background resources (processes, sockets, watchers, timers). Defer
  startup to `session_start` or the first tool call; register an idempotent
  `session_shutdown` handler. Upstream complies; preserve this in the fork.
- Upstream already handles: process groups / kill semantics, output caps,
  terminal-control stripping, PTY isolation.
- Fork hygiene: keep upstream's test suite green; no silent behavior changes.

## 8. Why not the alternatives

- **tmux / `nohup ... &` via `bash`:** no state tracking; the model can't
  reliably find or resume its own jobs; leaves orphans by default.
- **Pi built-in:** verified absent (tools: read, bash, edit, edit-diff, find,
  grep, index, ls, write).
- **Greenfield tool set (v1 of this doc):** reimplements ~250 tests of proven
  design for no benefit.
- **pi-unified-exec as-is, unmodified:** unmaintained; loop UX needs the
  prompt-side discipline (§6) we're adding; headless behavior needs review.

## 9. Open questions

1. **Fork mechanics:** fork-and-rename package to `pi-runbg`, or copy the
   source in and keep the name `pi-unified-exec`? (Recommend rename; keeps npm
   installs unambiguous.)
2. **Wake in headless mode:** does `pi.sendMessage`-based wake work in `pi -p`
   (non-interactive) sessions, or is it interactive-only? Must test early.
3. **TUI widgets:** keep upstream's running-session UI? (Likely yes —
   `list_sessions` in the status bar.)
4. **Config surface:** upstream uses env + constants; do we add a config file
   (e.g. `~/.pi/runbg.json`) for yield caps / log retention?
5. **Template scope:** which `-pi` templates get the "Long-running tasks"
   section — all, or just codex-family?
6. **Retention:** log rotation/TTL for on-disk session logs.

## 10. Implementation sketch (fork layout)

```
pi-runbg/
├── extensions/index.ts        ← fork of upstream src (exec_command, write_stdin,
│                                set_on_exit, kill_session, list_sessions)
├── src/…                      ← upstream modules (pty, long-wait, completion,
│                                session-store, head-tail-buffer, render, …)
├── docs/DC-0001…, IV-0001…    ← upstream design docs preserved
├── tests/…                    ← upstream suite (250+) kept green
├── package.json               ← renamed package; MIT
└── README.md                  ← fork notice + our additions
```

Typecheck workflow identical to `pi-sysprompt` (`npm i`, `npx tsc --noEmit`),
symlinked into `~/.pi/agent/extensions/`.

## 11. Template wiring (in `pi-sysprompt`)

Draft "Long-running tasks" section for the `-pi` templates:

> Long-running commands: start them with `exec_command` (session), not a
> blocking `bash` call. Then do other work and poll with `write_stdin` /
> `exec_command(yield_time_ms)`; wait up to 290 s per poll. Never tight-loop:
> if the process is still running and there's nothing else to do, end the
> turn and tell the user the session id and how to resume. Use
> `on_exit: "wake"` only when the user explicitly wants to be resumed; disarm
> with `set_on_exit` if a wake is no longer wanted. Kill + confirm cleanup
> with `kill_session` / `list_sessions` when done.

Reminder: pi injects `promptSnippet` / `promptGuidelines` only in the default
(non-custom) prompt branch — custom templates must carry this guidance
themselves.
