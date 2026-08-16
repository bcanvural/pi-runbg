# pi-runbg — design doc (v3, verified against upstream v0.9.0 and pi 0.83)

**Status:** implemented (2026-08-06) — fork landed with P0–P3 complete:
rename from upstream v0.9.0, bash-default flip (§7.1), crash reaper (§7.2),
log archive safety (§7.3), bounded poll accumulation (§7.4), headless
acceptance suite (§9), and the codex-pi template wiring (§14, applied to
`~/.pi/agent/sysprompts/codex-pi.md`). Divergence log: `../UPSTREAM.md`.
**Companion repos:** `pi-sysprompt` (template wiring, §14), `pi-webfetch` (sibling web-tool design).

> **v3 change:** full design review against the actual upstream source
> (pi-unified-exec v0.9.0, 2026-08-04), the pi 0.83.0 extension API
> (`@earendil-works/pi-coding-agent` typings + runtime), and the live
> template/extension setup. Corrects v2's tool table (wrong param names and
> caps), adds the **built-in-bash removal decision v2 missed entirely**,
> session-lifetime semantics, an upstream-sync strategy, a hardening plan
> drawn from upstream's own backlog, and headless acceptance criteria.
> Decisions that changed are marked **[v3 decision]**.

---

## 1. Problem

Pi's built-in `bash` tool blocks until the process exits. Long-running work
(dev servers, `tail -f`, REPLs, builds, migrations) either burns context
waiting, hits tool timeouts, or dies with the turn. There is no way to start a
process and drive it across turns — which is exactly what codex's prompt
philosophy ("start a job, poll it, react to it") assumes. Pi core is explicit
that this is extension territory: *"pi intentionally does not include …
background bash"* (pi docs/usage.md).

**The loop failure mode we hit in practice:** an agent given a long-running
process tends to tight-loop — poll → "still running" → poll again — burning
turns and thrashing the prompt cache, or arming `wake` "just in case" and
getting stale resumes. Upstream already diagnosed this (docs/IV-0001): agents
used `yield_until` to bypass the 290 s empty-poll cap, and tool guidance
over-promoted `on_exit: "wake"`. Root cause is *agent guidance*, not the
tooling — the fix is prompt-side discipline (§6) plus the disarm tool upstream
added (`set_on_exit`).

## 2. Upstream: pi-unified-exec (verified at v0.9.0)

[iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec), MIT,
`pi install npm:pi-unified-exec`.

**Maintenance reality (v2 called it "unmaintained" — wrong):** it is actively
developed (0.9.0 shipped 2026-08-04) but **closed to external contributions**
— issues disabled, PRs not accepted, forks explicitly invited. Consequence:
it's a *moving target* that will keep shipping fixes we want; the fork needs a
sync strategy (§10), not a one-time copy.

Verified facts (source review + local test run, 2026-08-06):

- Faithful port of codex's `unified_exec` session model: long-lived sessions,
  two-way I/O, every byte mirrored to an on-disk log (`log_path`), bounded
  in-memory retention (1 MiB head+tail per session), model-visible output
  tail-capped per call at 50 KiB / 2000 lines (pi's `DEFAULT_MAX_BYTES/LINES`).
- Bounded waits: `exec_command` / `write_stdin`-with-input attach ≤ 290 s
  (divergence #9; defaults unchanged at 10 s / 250 ms); empty polls clamp to
  [5 s, 290 s] — above-cap
  values are *rejected*, not clamped; `yield_until` absolute-UTC waits
  (multi-day, timers chunked at 2^31−1 ms). 290 s cap exists for Anthropic
  prompt-cache friendliness.
- `on_exit: "wake"` (default `"none"`): exactly one follow-up model prompt on
  unobserved background exit, delivered via core
  `pi.sendMessage(…, { triggerTurn: true, deliverAs: "followUp" })`; consumed
  by direct observation; disarmed via `set_on_exit` (tombstones survive store
  eviction). Wake content is bounded metadata, sanitized, with anti-injection
  framing.
- PTY mode (`tty: true`, optional `@homebridge/node-pty-prebuilt-multiarch`,
  exact-pinned) for REPLs/ssh/TUIs; `write_stdin` decodes C-style escapes;
  `chars_b64` for raw bytes.
- **Removes pi's built-in `bash` tool at `session_start` unless
  `--keep-builtin-bash` is set** — full codex parity where `exec_command` *is*
  the shell. v2 missed this; it drives §7.1.
- Output safety (0.9.0, IV-0002): all five tools have explicit renderers;
  model/details/TUI text is terminal-inert (CSI/OSC/DCS/C0/C1 stripped); raw
  bytes only in the log file.
- Quality: 274 tests (271 pass, 3 platform-skips) in ~32 s locally on
  macOS/Node 26; self-contained `ExtensionAPI` stub harness (no live pi
  needed); CI matrix ubuntu/macos/windows × Node 22/24; credible security-fix
  history (cwd-hijackable taskkill, shutdown-vs-spawn races, EPIPE host
  crash…). ~5.0 k LOC src, ~4.5 k LOC tests. No required runtime deps.
- **Known gaps upstream itself documents** (IV-0001/IV-0002 backlogs): session
  logs are unbounded, never cleaned, default perms, non-exclusive create;
  renderer ticker has no disposal contract; wake TTL unshipped. These seed our
  hardening plan (§7).

## 3. Decision

v1 = **fork pi-unified-exec at the v0.9.0 tag, preserving git history** (not a
source copy — keeps upstream cherry-picks cheap, §10), rename the package to
`pi-runbg`, and keep the **tool names, schemas, and constants verbatim**
(prompt text stays portable; codex-trained models recognize the surface).

Rename inventory (~37 string sites, nothing structural): package/repo
metadata; env vars `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` → `PI_RUNBG_MAX_EMPTY_POLL_MS`,
`PI_UNIFIED_EXEC_BASH` → `PI_RUNBG_BASH`; log prefix `pi-unified-exec-` →
`pi-runbg-`; wake `customType: "unified-exec-completed"` → `"runbg-completed"`;
`/unified-exec-sessions` → `/runbg-sessions`; UI key; user-facing strings;
docs/tests. Drop upstream-specific CI (`interaction-limit-reminder.yml`,
npm Trusted Publisher config — publishing is deferred, §12).

Our additions on top of the fork:

1. **System-prompt integration** (§6, §14) — the actual loop fix.
2. **Documented behavior divergences** (§7) — starting with the
   built-in-bash default.
3. **Headless verification** (§9) and **hardening** (§7.2–7.5).

## 4. Tool surface (corrected from source — v2's table was wrong)

Source of truth once forked: the fork's README. Summary:

| Tool | Params | Returns (`details`) |
|---|---|---|
| `exec_command` | `cmd` (required), `workdir?`, `shell?`, `tty?` (PTY), `cols?`/`rows?` (PTY), `yield_time_ms?` (clamp **[250, 290 000]** — divergence #9, upstream 30 000; default 10 000), `on_exit?` (`"none"`\|`"wake"`) | `operation`, `status: "running"\|"exited"`, `running`, `session_id?` XOR `exit_code?`, `signal?`, bounded `output`, `output_bytes_total`, `truncation?`/`omitted_bytes?`, `wall_time_seconds`, `tty`, `cwd`, `command`, `log_path`, `tool_time_utc`, wake/wait metadata |
| `write_stdin` | `session_id`, `chars?` (**optional — omit for a pure poll**; C-escapes decoded), `chars_b64?`, `yield_time_ms?` (with input [250, 290 000] def. 250; empty poll [5 000, 290 000], above cap **rejected**), `yield_until?` (RFC 3339 UTC, **empty polls only**, no max horizon) | session snapshot + bounded `output` |
| `set_on_exit` | `session_id`, `on_exit` | `{ session_id, found, on_exit, status, running, wake_armed, … }` |
| `kill_session` | `session_id`, `signal?` (default SIGTERM; SIGKILL escalation after 2 s) | bounded output envelope + `killed`, `escalated`, `status` |
| `list_sessions` | — | per-session `{ session_id, command, pid, running, wake_armed, elapsed_ms, exit info, output_bytes_total, log_path }` + counts. **Side effect: reporting an exit consumes a pending wake** |

v2 errors, recorded so they don't resurface in prompts or code: params are
`cmd`/`tty`, not `command`/`interactive`; **there is no `vars` param**
(children inherit pi's full `process.env`); `yield_until` is `write_stdin`-only;
`exec_command`'s yield ceiling was 30 s upstream and is now 290 s here
(divergence #9); result fields are
`status`/`output`/`output_bytes_total`, not `state`/`tail`/`output_size`;
commands finishing < 150 ms never enter the session store (return
`exit_code`, no `session_id`).

Constants preserved verbatim: yield clamps above; 50 KiB / 2000-line
model caps; 1 MiB in-memory retention; `MAX_SESSIONS` 64 (LRU, 8 MRU
protected); `on_exit` default `"none"`; control-sequence stripping; the
`StringEnum`/`Type.Unsafe` schema workaround (Google-model compat — keep).

## 5. Session lifetime & process model

Facts the design must be honest about (v2 was silent on all of these):

- **Sessions are in-memory and conversation-scoped.** Nothing persists across
  pi restarts; ids are monotonic per pi process.
- **Graceful shutdown kills everything.** `session_shutdown` (reasons `quit`,
  `reload`, `new`, `resume`, `fork` — i.e. also `/new` and `/fork`) SIGTERMs
  all sessions, SIGKILLs after 1 s, and cancels pending wakes. A dev server
  does **not** survive `/new`. This matches codex; survival across restarts is
  an explicit **non-goal for v1** (v2 candidate: on-disk session manifest +
  startup adoption/reaper, only if a real workflow demands it — §13.5).
- **Restart is invisible to extensions.** A fresh `pi -c`/`pi --session …`
  fires `session_start` with reason `"startup"`, *not* `"resume"` (that's only
  for in-process `/resume`). The transcript may reference dead session ids;
  stale-id calls fail gracefully ("unknown session"). The template therefore
  teaches: **after any restart, `list_sessions` is ground truth** (§6).
- **Crash paths orphan children.** `uncaughtException`/dead-terminal exits skip
  `session_shutdown` (pi only kills *its own* tracked bash children), and
  SIGKILL kills nothing. POSIX children live in detached process groups →
  silent orphans (lingering dev-server ports). Mitigation in §7.2.
- **LRU eviction can kill live processes** — at 64 sessions the oldest
  unprotected *live* session is terminated (wake suppressed, UI warning only).
  Candidate divergence §7.5.
- **Logs**: `${tmpdir()}/pi-runbg-<id>-<hex>.log`, complete raw stream,
  unbounded, never deleted, default permissions, non-exclusive create; on
  log-write failure upstream silently stops mirroring while results still
  claim full recoverability. Hardening §7.3.

## 6. Turn-model integration & agent guidance (the loop fix)

Upstream's shipped discipline, adopted with one correction — **polling an
existing session goes through `write_stdin`** (v2's draft implied
`exec_command` can poll; it always *starts a new session* — teaching that
would spawn duplicate processes, the exact failure class this section exists
to fix):

```text
exec_command                → start a session (attach ≤ 290 s)
write_stdin, chars omitted  → poll it (yield_time_ms ≤ 290 s; repeat OK, cache-friendly)
write_stdin, chars set      → drive it (input / \x03 Ctrl-C / …)
yield_until                 → ONLY if human explicitly asks for a long attach / UTC deadline
on_exit default             → "none"
on_exit "wake"              → ONLY if human explicitly wants auto-resume (exiting jobs only)
on_output {pattern}         → readiness wake for non-terminating jobs (dev servers, watchers,
                              migrations that stay up): arm at spawn, END THE TURN, woken on the
                              first match — a distinctive banner substring, not a common word
                              ("ready" ⊂ "already"); one-shot, re-arm via set_on_exit; compose
                              with on_exit: "wake" for crash-before-ready coverage (first wins)
mistaken / abandoned wake   → per-arm: set_on_exit(session_id, on_exit: "none") disarms the exit
                              arm, on_output: null disarms the match arm, the combined call is
                              full cleanup — none of them kill the process
kill_session                → kill process AND suppress both wake arms
list_sessions               → audit (wake_armed = exit arm, match_armed = match arm); consumes
                              pending exit wakes for exited sessions, never match wakes
wake delivery (lifecycle-aware host) → hold an unobserved wake during an active
                              agent run; flush at `agent_settled`; a finalized
                              direct observation wins and consumes it first
```

Session hygiene the template must teach:

- **Never tight-loop a poll.** If a session is running and there's nothing
  useful to do until it exits, end the turn and report the `session_id` with
  how to resume ("ask me to check session `<id>`").
- Prefer `on_exit: "wake"` over polling when the human asked to be resumed.
- When resuming work, start from `list_sessions` + `read(log_path)` — do not
  restart the process blindly.
- **Sessions die with the pi process** (`/new`, `/resume`, restart): a
  session id from earlier transcript is dead after restart; `list_sessions`
  is ground truth.
- Boundary vs `bash`: quick one-shot commands → `bash`; anything long-lived,
  interactive, or worth backgrounding → `exec_command`.

**Guidance carriers — two, not one** (verified in pi's `system-prompt.js`):
tool `promptSnippet`/`promptGuidelines` are injected **only in pi's default
prompt branch** and dropped by every replace-mode template. So: (a) upstream's
shipped tool guidance already covers default-prompt users automatically —
keep it; (b) replace-mode templates (`codex-pi`) must carry the discipline
text themselves (§14). Audit/extend the tool *descriptions* during the fork —
they are the only carrier that reaches the model in **every** configuration.

## 7. Divergences from upstream **[v3 decision]**

Fork hygiene rule: divergences are fine but **loud** — each gets a Changelog
entry, a README note, and a line in `UPSTREAM.md` (§10). Never silent.

1. **Remove pi's built-in `bash` by default — gated on `enabled`, reversibly
   opt-out.** Upstream removes it unconditionally (codex-parity:
   `exec_command` becomes the shell). The fork keeps the removal default but
   adds guardrails: it only acts while runbg is enabled (a dormant runbg
   never leaves a prompt shell-less), `/runbg replace-bash off` (persisted)
   restores bash, and a latch ensures runbg only restores a `bash` it
   removed itself. `--replace-builtin-bash` remains a one-invocation
   force-on. This is the compromise for the §14 gating model: templates that
   never mention session tools pair runbg with a saved `replace-bash off`,
   and the user-side `bash-guard` extension is bypassed only when the human
   opts in. The fork's contribution is the guardrails; the removal default
   itself matches upstream.
2. **Best-effort crash cleanup.** Register a `process.on("exit")` handler (at
   `session_start`, per the factory constraint) that synchronously
   group-kills live sessions. Covers `uncaughtException`/EIO exits that skip
   `session_shutdown`; SIGKILL remains unrecoverable (documented).
3. **Log archive safety** (adopts upstream's own IV-0002 backlog): create
   logs `0600` + `O_EXCL`; per-session size cap with explicit unlimited
   opt-in; `log_status: complete|partial|unavailable` in results — stop
   claiming "Full output" after a degraded archive; prefix-scoped age/size
   cleanup of old `pi-runbg-*` logs at `session_start`.
4. **Bound relative-poll memory.** `collectOutputUntilDeadline` accumulates
   every drained chunk in an array for the whole call — a chatty child during
   a 290 s empty poll can accumulate GBs in-process before truncation to
   50 KiB (absolute waits already avoid this; relative polls don't). Drain
   into a head/tail buffer instead. Top robustness fix for a
   background-exec tool.
5. *(candidate, later)* **Refuse new sessions at the 64-cap** with a clear
   error instead of LRU-killing a live one (keep prefer-exited eviction).

## 8. Safety

- **Pi extension constraint (verified in pi docs):** factories must not start
  background resources; defer to `session_start` / first tool call; register
  an idempotent `session_shutdown` handler. Upstream complies; preserve.
- **Env inheritance:** children get pi's full environment (incl. any secrets
  in it) — same trust model as built-in `bash`, so acceptable for v1; a
  `vars`/env-scrubbing param is a candidate addition (§13.4), not a port
  requirement (v2's table invented it).
- **bash-guard coverage (user-setup task, not this repo):** the existing
  `~/.pi/agent/extensions/bash-guard.ts` matches only the `bash` tool;
  once runbg ships, dangerous-command patterns should also be checked for
  `exec_command` via the custom-tool-call event (`event.input.cmd`).
- **Mutual exclusion with upstream:** both packages registering
  `exec_command` is a conflict. README warns to uninstall
  `pi-unified-exec`; cheap runtime guard: at `session_start`, scan
  `pi.getAllTools()` and warn on duplicates.
- Inherited and kept: process-group kill semantics (POSIX pipes),
  absolute-path `taskkill`/PowerShell, fail-closed Windows shell resolution,
  output caps, terminal-control stripping, wake-message sanitization +
  anti-injection framing. Known inherited limitation: PTY-mode kill signals
  the shell pid only (grandchildren rely on SIGHUP on master close).

## 9. Headless (`pi -p`) — verified behavior + acceptance criteria

Resolves v2 open question 2 from source: the wake path uses core
`pi.sendMessage` (not a UI API); every `ctx.ui` use is optional-chained or
`hasUI`-guarded, and pi supplies a no-op UI context in print/json modes.
Print mode **drains queued steer/followUp/triggerTurn messages before
settling**, so a wake that fires while the run is live does start a follow-up
turn; after the last prompt resolves, dispose → `session_shutdown` kills all
sessions. Cross-invocation background work is impossible by design (§5).

Acceptance tests to add in the fork (upstream's stub harness makes these
cheap):

1. `pi -p` one-shot `exec_command` completes; after exit, no orphaned
   children (probe process group).
2. Background job exits mid-run with wake armed → follow-up turn delivered
   before settle.
3. Sessions still running at settle → killed; the pi process exits promptly
   (audit that long-wait timers/tickers are cleared or `unref`'d — upstream
   IV-0002 flags ticker ownership as unresolved).
4. All five tools behave with `hasUI: false` (headless harness run of the
   e2e suite).

## 10. Upstream sync strategy **[v3 addition]**

- Fork on GitHub from the `v0.9.0` tag with full history; keep an `upstream`
  remote.
- `UPSTREAM.md` records: fork point, the §7 divergence list, and the sync
  procedure (`git fetch upstream && git log upstream/main --oneline`,
  cherry-pick wanted commits, full test suite green before merge).
- Review upstream releases opportunistically — it is active and ships fixes
  we want (0.9.0 landed two days before this doc).
- Keep diffs outside §7 minimal so cherry-picks stay clean.

## 11. Why not the alternatives

- **tmux / `nohup … &` via `bash`:** no state tracking; the model can't
  reliably find or resume its own jobs; leaves orphans by default.
- **Pi built-in:** confirmed absent by design — *"pi intentionally does not
  include … background bash"* (usage.md); core has no process registry,
  scheduler, or wake API to reuse.
- **Pin upstream unmodified via npm:** rejected — the built-in-bash default
  (§7.1) alone requires a code change upstream won't take (no PRs), and the
  headless tests + hardening need to live somewhere.
- **Greenfield tool set (v1 of this doc):** reimplements ~9.5 k LOC of proven
  design and tests for no benefit.

## 12. Implementation plan (phased)

- **P0 — fork:** fork at `v0.9.0` w/ history; rename (inventory in §3); tests
  green locally (baseline: 271 pass / ~32 s, Node ≥ 22.19); CI ubuntu+macos ×
  Node 22/24 (keep the Windows lane as long as it stays green — the support
  is real and tested; drop only if it starts costing); remove
  upstream-specific workflows. Install via symlink like the sibling repos
  (`npm i && npx tsc --noEmit`; entry stays `src/index.ts` — moving it to
  `extensions/` buys nothing and complicates cherry-picks). npm publish
  deferred (§13.1).
- **P1 — behavior:** §7.1 bash-default flip (+ flag rename), §8 duplicate-tool
  guard, §9 acceptance tests.
- **P2 — prompt integration (in `pi-sysprompt`):** §14 template work,
  including the two `codex-pi.md` conflicts.
- **P3 — hardening:** §7.2 crash hook → §7.4 poll memory → §7.3 log safety
  (order: cheap/high-value first). Then use it in anger and revisit §13.

## 13. Open questions (remaining)

1. **npm publish** under `pi-runbg`, or stay symlink/git-install only?
   (Defer past P3; publishing means npm provenance setup and a support
   surface.)
2. **Windows** long-term: keep the lane or declare best-effort?
3. **Wake TTL** (upstream's open item): adopt only if stale resumes still
   appear despite §6 discipline.
4. **`vars` / env scrubbing** on `exec_command`: add if a need appears.
5. **Restart-surviving sessions** (on-disk manifest + adoption/reaper): v2
   feature, only with a demonstrated workflow need.

## 14. Template wiring (in `pi-sysprompt`)

**The prompt text is the gate — no extension-to-extension mechanism.**
Verified against the sysprompt implementation: templates re-read from disk
every prompt; frontmatter YAML-parsed with only `description`/`mode`
consumed, so **`bg: true` is genuinely inert** — the marker was removed from
`codex-pi.md` on 2026-08-06 (its `(bg: true)` parenthetical in the unquoted
description broke frontmatter parsing entirely, hiding the template from
`/sysprompt`); it returns only if the deferred auto-gating below ships.
(`{"active": <name>|null}`), written atomically at `/sysprompt` time.

- **codex-pi** carries the session guidance (draft below); opencode templates
  never mention the tools. **Caveat v3 adds:** with the *default* prompt
  active (`active: null` — the current state of this machine), pi injects the
  tools' own `promptSnippet`/`promptGuidelines` automatically, so the model
  is *not* oblivious there. That's accepted — the gate applies to
  replace-mode templates, and default-prompt users get upstream's shipped
  guidance, which encodes the same discipline.
- **Shipping tasks in `codex-pi.md`** (both found in review): add the
  "Long-running tasks" section; **rewrite the "Monitor or wait" bullet**
  ("pi has no background monitor, so continuous watching that outlives a turn
  is not possible") — with runbg it is wrong and actively fights the tools;
  update the frontmatter description ("bash instead of exec_command" is
  stale once runbg ships).
- **Availability gating shipped as a *manual* toggle** (divergence #5,
  implemented 2026-08-06): the tools are dormant by default; `/runbg on|off`
  flips them via `pi.setActiveTools()`, persisted in `<agentDir>/runbg.json`
  (a settings namespace for future runbg options — unknown keys preserved).
  The human pairs `/runbg on` with `/sysprompt codex-pi` by hand — no
  extension reads another's state. `/runbg` grew into the general settings
  command that namespace anticipated: a declarative table of boolean settings
  drives its grammar (`/runbg <setting> on|off`, plus bare `/runbg on|off`
  for the primary switch), its argument completions, and its status line, so
  divergence #1's bash replacement is a peer setting (`replace-bash`, on by
  default) rather than a startup-only flag. Adding a setting is one table
  entry. *Automatic* template-frontmatter gating
  (`before_agent_start` reads `sysprompt.json` → a re-added `bg:` marker)
  remains designed-but-deferred; verified feasible (precedents: `zz-read-only-mode`
  setActiveTools save/restore; `advisor` reads others' config files;
  `parseFrontmatter` exported by pi), with recorded caveats: setActiveTools
  is session-wide, not per-turn; a dangling active-template name must read
  as `bg: false`; toggling snippet-bearing tools rebuilds the system prompt
  and invalidates the provider cache prefix — fine for a manual command,
  costly if automated per-turn.

Draft "Long-running tasks" section for codex-pi (param names corrected):

> Long-running or interactive commands (dev servers, `tail -f`, REPLs,
> builds, migrations): start a session with `exec_command` (`cmd`; `tty: true`
> for REPLs/ssh/TUIs) instead of blocking `bash`. Keep the returned
> `session_id`. Drive or poll it with `write_stdin`: send input via `chars`
> (C-escapes decoded, e.g. `\x03` = Ctrl-C), or omit `chars` for a pure poll
> with `yield_time_ms` up to 290000. Repeat polls are fine, but never
> tight-loop: if it's still running and nothing else needs doing, end the
> turn and tell the user the `session_id` and how to resume. Full history is
> recoverable with `read` on the session's `log_path`. For a process that
> does not exit (dev server, watcher), arm a readiness wake instead:
> `exec_command` with `on_output: {pattern}` — a distinctive banner
> substring, not a common word — then end the turn; you are woken on the
> first match. Use `yield_until` (absolute UTC) or `on_exit: "wake"` only
> when the user explicitly asks to stay attached or be auto-resumed;
> disarm an unwanted wake per arm with `set_on_exit(session_id, on_exit:
> "none")` (exit arm) or `set_on_exit(session_id, on_output: null)` (match
> arm) — does not kill. Clean up with `kill_session`; audit with
> `list_sessions`. Sessions die with the pi process (`/new`, restart):
> after a restart, `list_sessions` is ground truth — ids from earlier
> transcript are dead. Quick one-shot commands still go through `bash`.

Reminder (verified in pi source): pi injects `promptSnippet` /
`promptGuidelines` only in the default (non-custom) prompt branch — custom
templates must carry this guidance themselves. `appendSystemPrompt` survives
both branches, but the template-carried text is the chosen mechanism.
