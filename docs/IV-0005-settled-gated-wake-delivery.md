# IV-0005 — Settled-gated wake delivery

**Status:** implemented in source (0.10.0)  
**Review status:** three adversarial review rounds accepted — df-worker, dp-worker, and worker-sol  
**Related:** [IV-0001 — Long-wait UX, wake control, and agent guidance](./IV-0001-long-wait-and-wake-control.md), [IV-0004 — Wake on output pattern](./IV-0004-wake-on-output-pattern.md), [IV-0003 — Log cursor reads](./IV-0003-log-cursor-reads.md)

## Intent

Prevent a run-bg completion/readiness wake from becoming a redundant follow-up turn when the agent observes the same session directly later in the still-active model turn.

The extension currently debounces a fired wake and then calls `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` without knowing whether the agent is still working. Pi accepts that follow-up while the current turn is active. A later `write_stdin` call can then return the authoritative terminal output, but the already-accepted wake still arrives afterward.

This proposal changes only **wake delivery timing**. It does not add another wait primitive and does not change how processes are observed, how output is bounded/sanitized, or how exit and match arms are consumed.

## Problem and observed race

The existing sequence is:

```text
agent continues a long turn
  -> exec_command arms an exit/match wake
process exits or emits the readiness match
  -> coordinator records the event
  -> debounce timer flushes while the agent is still active
  -> pi.sendMessage() accepts a follow-up
later in the same turn
  -> write_stdin observes the session and returns the direct result
agent eventually settles
  -> Pi delivers the already-queued follow-up anyway
```

The direct result and the synthetic wake are both individually valid, but together they spend an unnecessary model turn and can cause a stale second poll. The extension cannot retract a follow-up after `pi.sendMessage()` accepts it; preventing handoff is therefore the safe control point.

There is a second compatibility constraint: Pi's extension `sendMessage` API is fire-and-forget, and in print mode the host can exit as soon as the current `agent_settled` emission finishes. If the coordinator starts a wake turn from inside that settled callback without holding the callback open, the wake turn can be killed before its final response is printed. The design therefore includes a bounded **settled-handler barrier** for wake turns it starts from that callback.

## Goals

1. Do not hand a pending wake to Pi while an agent run is active on a lifecycle-aware supported runtime.
2. Give `write_stdin` (and existing finalized-result containment for match wakes) the opportunity to consume the event before delivery.
3. Deliver an unobserved wake automatically once the current agent run reaches Pi's settled boundary.
4. Keep headless `pi -p` alive until a wake turn initiated by the settled callback completes, including a finite chain of wake turns; preserve multi-message print-mode behavior.
5. Preserve one-shot, per-arm, generation-aware wake semantics from IV-0001/IV-0004.
6. Preserve mixed-kind batching: at most one exit wake message and one match wake message per flush.
7. Close the handoff race between `agent_settled` and the new wake turn's `agent_start`.
8. Release abandoned observation leases at settlement without falsely marking them observed, so aborted polls fail open to wake delivery on lifecycle-aware runtimes.
9. Keep current behavior for an actually idle agent: a fired, eligible wake still starts a follow-up promptly after the debounce.
10. Make the behavior testable through the existing coordinator and headless wake harnesses.

Goals 1–4 and 8 are **lifecycle-aware guarantees**. The explicit fallback contract below intentionally provides the pre-change behavior, not these stronger guarantees.

## Non-goals

- No blocking pattern wait and no second wait path; `write_stdin` remains the only wait/poll/input primitive.
- No targeted cancellation API in Pi and no attempt to clear unrelated queued human or extension messages.
- No wake TTL, wake expiration, or stale-event policy change.
- No change to `on_exit` / `on_output` arm semantics, generation rules, matching, excerpt capture, containment, or output sanitization.
- No interruption/preemption of the current model turn. A wake is deferred, not injected into an active turn.
- No Pi core modification for v1; the extension uses existing lifecycle events and `sendMessage`.
- No forced earlier model yield. Guidance may recommend ending a turn after arming a wake, but correctness must not depend on compliance.
- No general redesign of failed-send retry. The existing limitation that a failed send in an otherwise quiet session waits for a later flush trigger remains out of scope; this design must not worsen it or strand a handoff.
- No guarantee that a model wake run which is handed off but then fails at the model/runtime layer will be replayed. This is pre-existing best-effort behavior; a future retry policy is separate work.

## Contract

A wake is eligible for dispatch only when all of the following hold at flush time:

```text
event fired
+ its arm is still live and generation-valid
+ no observation lease is active
+ no staged match-containment decision is pending
+ lifecycle-aware agent phase is idle
```

A fired event may remain pending while the agent is active. The event is not reserved (`wakeQueued` is not set) until a flush is allowed to dispatch it. Once `sendMessage()` accepts a wake, it is considered handed off and cannot be recalled by run-bg.

The first event still wins within a session according to the existing per-arm rules. Deferral does not make an exit arm consume a match arm or vice versa.

When lifecycle awareness is unavailable, the phase gate is disabled as a whole and the coordinator remains in its idle-compatible fallback. This intentionally preserves pre-change immediate delivery rather than risking a permanently active gate.

## Runtime contract assumptions

The lifecycle-aware guarantee is defined against the supported Pi runtime contract:

1. `agent_start` is emitted once for each actual agent run after the initial validation/entry path.
2. `agent_settled` is emitted from the run's `finally` path, including failed/aborted runs.
3. Normal runs are serialized by Pi: a new triggered run starts synchronously with `sendMessage` before its first await, and its settled event occurs before the enclosing run becomes idle.
4. Extension event handlers are awaited by the extension runner.

The installed Pi 0.84.2 runtime and the repository's pinned 0.83 dependency satisfy these points. Pi does have a narrow preflight window where two prompt submissions can pass separate async checks before either enters `_runAgentPrompt`; this design cannot close that Pi-core race. If it occurs, Pi's existing `followUp` queue semantics provide a degraded result (the wake is queued behind the active run, with no extension-level loss or duplicate), rather than a second extension wait path.

The design deliberately does not add a self-healing “duplicate `agent_start` means a missed settle” detector. `on()` accepts event names without runtime validation, and a detector can misdiagnose the documented prompt-preflight corner. The peer-minimum lifecycle contract is the honest capability boundary.

Lifecycle events carry no run identifier. The handoff token below protects ownership and ordering; it does not prove that an `agent_start` belongs to a particular wake. “Matching start” means the first start after the handoff under the supported serialized-runtime contract. Concurrent preflight is explicitly degraded as described above.

## Lifecycle phases and handoff ownership

The coordinator tracks a small delivery gate separate from per-session wake state:

```text
idle        — no agent run is active; a flush may dispatch
active      — an agent run is executing; wakes remain pending
handoff     — a wake dispatch has started and the next agent run has not yet
              reported `agent_start`; later flushes remain blocked
```

The phase is process/session scoped, not per run-bg session. This assumes one extension coordinator per Pi agent session, as in the current host. A future multiplexed host with multiple independently running agent sessions would need one lifecycle gate/barrier per host session.

Per-session records retain their existing `armed`, `suppressed`, `wakeQueued`, `generation`, `observed`, and `match` state.

Every dispatch batch also has a monotonic coordinator-level **handoff token**:

```ts
type HandoffOwner = {
  token: number;
  source: "timer" | "settled" | "settled-retry";
  awaitingStart: boolean;
  accepted: number;
  outstanding: number;
  terminalNoStart: boolean;
};
```

The token is an ownership marker, not a Pi run id. A sender outcome may release only its own generation-carrying reservations. It may change global phase or barrier state only while its token still owns the current awaiting-start handoff. A late outcome from an old token must never move a newer active/handoff phase or resolve a newer barrier. `reset()` and `shutdown()` invalidate all tokens.

### Lifecycle transitions

```text
agent_start
  idle -> active when lifecycle gating is enabled
  handoff -> active for the current owner under the supported
             first-start-after-handoff contract
  active -> active (defensive/idempotent)

agent_settled while active or idle
  release abandoned observations
  phase -> idle
  flush pending wakes

agent_settled while a handoff owner awaits its start
  do not downgrade handoff or dispatch inline
  record a possible no-start/terminal outcome
  wait for the coordinator-wide sender count and outer settled transition
  to finish; then use the guarded post-event retry below

allowed dispatch
  idle -> handoff before calling send()
  create a new owner token before the first send invocation

successful handoff
  first subsequent agent_start -> active and owner.awaitingStart = false

synchronous or visible asynchronous send failure
  release only that token's reservations
  if it still owns an unstarted handoff and no sibling was accepted,
  retire the owner and return to idle; otherwise do not mutate newer state
```

A successful agent run's `agent_start` occurs before its `agent_settled`, so a normal settle is received in `active`, not in `handoff`. A settle in `handoff` is reserved for an early pre-start failure, a re-entrant test/alternate sender, or the documented concurrent-preflight corner. It must not be treated as permission to dispatch another wake inline.

`agent_settled` is the release point rather than `agent_end`: it represents the point after Pi has dealt with queued continuations, retries, and compaction work. A new wake triggered by the coordinator must not race a second wake before the new turn announces `agent_start`.

`reset()` and `shutdown()` always return the phase to `idle`, clear the lifecycle/barrier/token state, and resolve any held settled barrier. An old handoff must not keep a later session or host shutdown alive.

## Lifecycle capability and fallback

The phase gate is enabled only if both lifecycle handlers can be registered:

```text
register agent_start handler
register agent_settled handler
if and only if both succeed -> lifecycleAware = true
otherwise                    -> lifecycleAware = false
```

Registration is all-or-nothing. A partially registered `agent_start` handler must be a no-op when `lifecycleAware` is false; otherwise the first active run could set `active` while no usable settled event can return it to `idle`, silently losing every future wake. The fallback emits one diagnostic indicating that settled-gated delivery is unavailable.

With `lifecycleAware === false`, `setAgentSettled()` is exactly the old handler:

```text
flushPending()
return Promise.resolve()
```

It performs no phase writes, no orphan-observation release, and no barrier/token creation or resolution. The fallback therefore explicitly forfeits the lifecycle-aware headless hold-open and settled-time orphan cleanup guarantees. It must not deadlock or silently claim the stronger behavior.

The supported Pi runtime provides both events. The registration check protects hosts where registration itself fails; it cannot detect a host that accepts subscriptions but later stops emitting events. That is covered by the peer-minimum runtime contract above.

## Delivery algorithm

The existing debounce timer and flush callers remain. `flushPending()` gains an early gate and reports dispatch progress:

```ts
flushPending(source?: "timer" | "settled" | "settled-retry"): DispatchOutcome {
  if (this.stopped) return { accepted: 0, outstanding: 0 };
  if (this.lifecycleAware && this.agentPhase !== "idle") {
    return { accepted: 0, outstanding: 0 };
  }

  // Existing work follows:
  // - collect eligible records
  // - reserve by arm and generation
  // - group by wake kind
  // - build bounded messages
  // - dispatch at most one message per kind
  // - report accepted/in-flight sender counts
}
```

Before the first `send()` of a flush, the coordinator changes `idle` to `handoff` and creates the owner token. The whole batch is still allowed to dispatch its already-selected kinds; the phase gate blocks only re-entrant/later flushes, not the second kind belonging to the same flush.

The coordinator maintains a **settled-transition dispatch counter** across the whole transition, not a counter local to a nested `setAgentSettled()` call:

```text
before each send invocation: pendingDispatches++
void sender returns:         pendingDispatches--, accepted++
sync throw:                  pendingDispatches--, accepted unchanged
promise sender settles:     pendingDispatches--, accepted or failed
```

The counter is incremented before invoking `send`, so a stub/alternate sender that synchronously emits `agent_settled` cannot cause the re-entrant handler to resolve the outer barrier while the outer send is still in progress. Every decrement and barrier resolution is idempotent and guarded against stopped/reset state.

The existing deliver-time checks remain authoritative. If a disarm, kill, re-arm, observation, reset, or shutdown races a deferred or reserved flush, the generation/suppression checks suppress the invalid reservation. A deferred record that is consumed before settlement is removed/committed exactly as it is today and never becomes a wake merely because it was once fired.

The `sendMessage` options remain:

```ts
{ triggerTurn: true, deliverAs: "followUp" }
```

At an idle flush this starts the desired follow-up. While the agent is active it is never called. The current Pi wrapper is fire-and-forget, but the coordinator retains its existing support for a `void | Promise<void>` sender in tests/alternate hosts. A visible rejected sender releases only the matching generation's reservation; the barrier/token rules below determine whether the settled transition can finish.

A sender that returns `void` without throwing is accepted immediately. A promise-returning sender remains in `pendingDispatches` until it resolves or rejects; the barrier is kept while that count is nonzero. A late rejection with no sibling accepted and no remaining pending dispatch restores `handoff -> idle` only if that token still owns the unstarted handoff, releases the matching reservation, and resolves/clears the barrier it armed. A sibling-accepted outcome leaves the handoff/barrier intact because a wake run is already starting.

The same owner-token restoration applies to ordinary timer/idle dispatches, although those dispatches do not arm a settled barrier. A late timer-send rejection cannot clobber a newer active or handoff phase.

## Settled-handler hold-open barrier

### Why it is needed

At `agent_settled`, Pi has set its active flag false and awaits extension handlers. The extension's `sendMessage` wrapper does not return the internal `sendCustomMessage` promise. In print mode, `session.prompt()` can therefore finish as soon as the settled handler returns, and the host may exit while a newly triggered wake turn is still running.

The `agent_settled` handler must return the coordinator's promise:

```ts
pi.on("agent_settled", () => ctx.coordinator.setAgentSettled());
```

The runner awaits extension handlers, so the settled emission and the enclosing print-mode prompt remain open through the wake turn(s) started by that flush.

### Barrier contract and ordering

The coordinator maintains at most one **settled-chain barrier**. It is not a general idle lock and is not armed for timer dispatches while an interactive/RPC host is already alive.

Shared barrier state is conceptually:

```ts
type SettledBarrier = {
  promise: Promise<void>;
  resolve: () => void;
  ownerToken: number | undefined;
  accepted: number;
  outstanding: number;
  synchronousSettledDepth: number;
  retryScheduled: boolean;
  settled: boolean;
};
```

`setAgentSettled()` performs this sequence on lifecycle-aware runtimes:

1. Arm or reuse the shared settled-chain barrier **before** flushing. This ordering is required for re-entrant synchronous test/alternate senders and future runtimes.
2. Increment the synchronous settled-transition depth and inspect the current handoff owner.
3. If a handoff owner is still awaiting its first start, do not downgrade the phase and do not flush inline. Record the settle as a possible no-start terminal event; the outer transition/owner outcome will decide the retry.
4. Otherwise set phase to `idle` and release orphaned observations and staged containment as specified below.
5. Flush eligible wakes, allowing all messages belonging to that flush to be dispatched. The coordinator-level pending-dispatch counter covers the entire transition, including re-entrant calls.
6. After the outer transition's synchronous flush work and all currently visible sender outcomes:
   - if no dispatch was accepted and `pendingDispatches === 0`, resolve and clear the barrier;
   - if at least one dispatch was accepted, keep the barrier pending;
   - if sender outcomes remain pending, keep the barrier pending and reevaluate when each settles.
7. Decrement the synchronous settled-transition depth before returning. A nested settled handler must never use its local counter to resolve the outer barrier.
8. Return the shared barrier promise when it is pending; otherwise return `Promise.resolve()`.

A re-entrant `setAgentSettled()` invoked while the outer settled flush is still sending may observe the handoff owner, but it cannot resolve the barrier or dispatch another wake while the coordinator-level `pendingDispatches` is nonzero. The outer transition makes the final decision after its send calls return. This is a contract-level hardening case for test/alternate/future senders; the current Pi 0.84.2 wrapper turns core failures into asynchronous rejected promises, so the exact synchronous re-entrant failure is not reachable through the normal wrapper.

### No-start terminal path and post-event retry

An early pre-start failure is possible: `_runAgentPrompt` sets Pi's active flag and executes its `finally` path, while the agent loop can fail before emitting `agent_start`. That produces `agent_settled` while the handoff owner still awaits its start.

The handler must not recursively flush in that event. Instead:

1. retain the shared barrier and handoff owner while any sender for that owner remains outstanding;
2. once the owner has no outstanding sender, retire the owner if no matching start occurred;
3. schedule exactly one guarded post-event/microtask retry, never an inline recursive flush;
4. retain the settled barrier across that retry;
5. run the retry only if the coordinator is not stopped/reset and no newer owner has taken over;
6. if the retry accepts a dispatch, transfer the shared barrier to the new owner chain;
7. if the retry has no accepted dispatch and no outstanding sender — including all synchronous throws — resolve/clear the barrier and return idle.

The retry is one-shot per no-start terminal event. A new record arriving during the nested settlement is included by the guarded retry if still eligible. Reset/shutdown cancels the retry and resolves the barrier. This prevents print mode from exiting before the retry's synchronous outcome is known.

The handoff token does not identify the Pi run. It only prevents an old sender/retry from mutating newer state. Under the supported serialized-runtime contract, the first `agent_start` after handoff is treated as the owner's start. Under concurrent preflight, the documented degraded `followUp` behavior applies.

### Resolution and failure

The shared barrier resolves at the first later settled transition whose own flush accepts no message and whose visible sender count is zero, or at the guarded no-start retry that reaches the same condition. If that transition starts another wake, the same barrier remains pending. This is the end of the finite wake chain. A late promise rejection can also terminate the barrier when it proves that no dispatch in the settled flush succeeded. Resolution and clearing are idempotent and stopped-safe.

A barrier is armed only for an accepted/possibly-pending dispatch from the settled path. A failed send that starts no run does not create a lasting barrier. `reset()`/`shutdown()` resolve and clear the barrier so teardown cannot hang.

The runtime ordering dependency is intentional and documented: starting a triggered wake is synchronous with the `sendMessage` call because Pi sets the new run active before the first await. Therefore, the previous settled handler's final idle-resolution logic cannot observe the host as idle while the wake turn is already active. If Pi changes this ordering, the extension must await the new-run start before resolving the prior settled boundary.

### Print-mode no-idle-window justification

The barrier is needed for a dispatch performed by the `agent_settled` handler. In print mode, a debounce timer that fires during the model/tool turn is blocked by `active`; the settled handler is the release point. Between sequential print prompts, the host advances synchronously/microtask-wise to the next prompt, while the debounce timer is a macrotask and cannot become an independent wake dispatch in the small handoff window. On final prompt completion, process teardown clears pending timers. Thus the lifecycle-aware print guarantee is provided by the settled barrier, while ordinary idle timer dispatch remains the existing interactive/RPC behavior.

This is a host/runtime assumption, not a new general timer guarantee. If a future print host creates a real idle interval while keeping the process alive, it must either use the lifecycle barrier for that interval or explicitly accept the existing best-effort behavior.

### Mixed-kind and nested wake turns

If exit and match messages are eligible in one settled flush:

```text
exit dispatch starts wake run B synchronously
match dispatch observes streaming run B and queues as B's follow-up
B's post-run loop drains the match follow-up
one settled-chain barrier covers the combined sequence
```

There is one message per kind, but the two kinds may consume two model requests. A completion that fires during B's active turn is not part of B's flush; it remains pending until B settles and then extends the same barrier chain if it dispatches.

The chain is nested-but-serial, not concurrent: each run has one settled event, and each settled handler shares the barrier until a flush with no dispatch terminates the chain. The chain cannot extend for unrelated future completions after the first no-dispatch settled boundary.

If the first wake send fails before a run starts, a second-kind message that Pi had already queued in that failed run can surface later on a host-specific path. This is a pre-existing Pi queue failure corner; the extension must release its own reservation and document the wake as best-effort rather than claim that the second kind is guaranteed to run.

### Failure and teardown

The phase/barrier machine is total and token-guarded:

- Normal `agent_settled` from `active` or `idle` releases observations, flushes, and resolves only after the current transition has no accepted/pending dispatch.
- `agent_settled` while an owner awaits start does not downgrade or dispatch inline; it follows the no-start path.
- A sync or visible async send failure releases only matching reservations. If no sibling send succeeded and the transition's pending-dispatch count reaches zero, it also returns `handoff` to `idle` only if that token still owns the unstarted handoff, and resolves/clears the settled barrier. If a sibling succeeded or a newer owner exists, old state is not mutated.
- If the transition throws before a dispatch is accepted, no lasting barrier remains; the host's normal error containment prevents a hang, with behavior degrading to the unbarriered path.
- `reset()` and `shutdown()` force `idle`, invalidate all owner tokens, cancel guarded retries, clear pending lifecycle/barrier state, and resolve any barrier.

A wake handed off to Pi may still be lost if the triggered model turn fails after acceptance. The current fire-and-forget wrapper does not give run-bg a reliable completion/retry callback; this design preserves that pre-existing best-effort boundary.

## Settled-time orphaned observation release

### Rule

At the start of the lifecycle-aware settled transition, before `flushPending()`:

```text
for every completion record:
  clear observers and pendingTerminal without committing observed
clear stagedMatch
```

This is unconditional and fail-open on lifecycle-aware runtimes. It does not mark an exit or match arm observed. It only removes leases and staged decisions that belong to a tool call that never reached normal finalization.

With lifecycle fallback disabled, this cleanup is not performed; fallback is exactly the old behavior.

### Safety argument

Pi's event stream awaits each extension event in order. For a completed tool, `tool_execution_end` reaches the extension before `agent_settled`; the process loop emits tool completion before `agent_end`, and settlement occurs after the post-run loop. Therefore, a lease still held at settlement belongs to an in-flight tool abandoned by an abort/error path. That path can emit message/turn/agent events without a matching `tool_execution_end`; it cannot later legitimately commit the observation for the completed run.

Clearing without `commitObserved` matches the existing error-finalization behavior: the wake remains eligible rather than being falsely consumed. A late-resuming abandoned handler could re-add a lease after release; it is released at the next settlement, producing at most a one-settle delay, not a lost wake. The coordinator cannot identify a run identity for that late call, so this is an explicit pragmatic boundary.

This is the one intentional observation-semantics change owned by this design. The non-goal is not “no observation changes”; it is “no change to normal finalized-result containment semantics.”

## Event and observation sequences

### Exit wake consumed by a poll

```text
agent_start -> phase active
process exits -> exit snapshot pending
optional debounce flush -> gate returns; no reservation/send
write_stdin -> direct terminal result
 tool_execution_end -> observation commits; exit arm consumed
agent_settled -> release has nothing to clear; flush sees no eligible record; zero wake messages
```

### Exit wake not observed

```text
agent_start -> phase active
process exits -> exit snapshot pending
agent_settled -> arm barrier before flush; phase idle
             -> flush reserves and accepts one exit wake
             -> phase handoff; barrier remains pending
agent_start -> phase active
wake turn completes -> next agent_settled flushes nothing and resolves barrier
```

### Early pre-start failure

```text
settled flush creates owner/barrier and dispatches
triggered run fails before agent_start
agent_settled arrives while owner awaits start
             -> no inline second dispatch
             -> wait for sender outcomes
             -> one guarded post-event retry under the same barrier
             -> transfer to a new owner or resolve with no accepted/pending send
```

### Match wake consumed by finalized output

```text
agent_start -> phase active
pattern matches in push path -> match snapshot pending
write_stdin -> finalized bounded body contains sanitized excerpt
 tool_execution_end -> staged containment commits; match arm consumed
agent_settled -> no match wake
```

### Match wake not observed

```text
agent_start -> phase active
pattern matches -> match snapshot pending
agent_settled -> one runbg-matched wake is accepted and held open through its turn
```

### Multiple sessions and wake kinds

Events from several sessions may accumulate while the agent is active. At the next allowed flush, retain IV-0004 batching: group by `exit` and `match`, with no more than one synthetic message per kind in that flush. The second kind may be queued as a follow-up of the first wake's turn by Pi, and the settled-chain barrier covers that finite sequence. A later event arriving during the triggered wake turn waits for the next settled boundary and extends the chain only if that boundary dispatches it.

## Important races

### Completion versus active-turn timer

The timer may fire repeatedly or once while the agent is active. It must not reserve records or mark them delivered. `agent_settled` is the explicit retry point; the pending record itself is sufficient, so no unbounded timer retry loop is needed.

### Poll finalization versus settled flush

Pi normally emits `tool_execution_end` before `agent_settled`. The coordinator commits observation before the settled flush can send. If a tool was aborted and no finalization event arrived, lifecycle-aware settled-time fail-open release removes its lease before the flush. The design never consumes an uncertain match.

### Settled-to-new-turn handoff

At `agent_settled`, a pending wake may be selected. Set `handoff` and create its owner token before calling `send`. If another process exits or a timer fires before `agent_start`, it remains pending. The new turn's first `agent_start` changes the phase to `active`; an old callback cannot cause a second immediate dispatch.

### Disarm/kill/re-arm while deferred

`set_on_exit`, `kill_session`, shutdown/reset, and re-arm operations retain their existing generation and suppression semantics. A deferred wake is easier to suppress than a queued one because no Pi message exists yet. A re-arm must not inherit a prior generation's pending reservation or observation.

### Idle completion during a settled callback

A process may exit after the settled handler begins but before its flush observes the record. The record's normal debounce/timer path sees the now-idle phase and dispatches later. If it exits before the flush's eligibility snapshot, the same flush may include it. Both are valid; exactly-once still comes from reservation and generation checks.

### New record during nested settlement

A record created/fired while a nested settled event is being handled is not dispatched inline. It remains pending and is included by the guarded post-event retry or by the next normal settled/timer flush, subject to the owner token and barrier rules.

### Prompt preflight concurrency

A separate prompt can pass Pi's preflight checks before entering `_runAgentPrompt` while a settled-dispatched wake is starting. The extension cannot see or cancel that pending prompt. If a gate flush occurs in this window, Pi may queue the wake as a follow-up of the active run; this is the existing Pi queue behavior and is not treated as a second extension wait primitive. A Pi-core lifecycle/serialization change would be required to make this corner stronger.

## State-machine requirements

The implementation must preserve these distinctions:

| State | Meaning |
|---|---|
| fired/pending | Event happened, but no Pi message has been handed off. Poll/containment may still consume it. |
| reserved | This flush selected the arm; generation checks still gate delivery. |
| handed off | `sendMessage` accepted the synthetic message. Run-bg cannot recall it. |
| observed/consumed | A finalized direct result or valid observation consumed the arm. |
| suppressed | Explicit disarm, kill, eviction, reset, or shutdown prevents delivery. |

`wakeQueued` must continue to mean a reserved/queued arm, not merely a fired event waiting behind an active agent. A separate coordinator-level phase, owner token, and barrier handle the agent-run gate.

## Implementation map

| Area | Change |
|---|---|
| `src/completion.ts` | Add lifecycle phase/capability state, monotonic handoff ownership, and `setAgentStarted`/`setAgentSettled`/barrier methods; gate `flushPending` before reservation; return dispatch outcome; add coordinator-wide settled-transition pending-dispatch counter and synchronous-depth guard; add guarded no-start retry; add settled-time orphan release; add handoff/barrier token guard; preserve current batching, generation, observation, suppression, and failed-send paths. |
| `src/index.ts` | Register both lifecycle listeners atomically from the coordinator's perspective; return the settled promise from the handler; replace the direct `agent_settled -> flushPending()` callback with the coordinator's settled transition; retain the explicit all-or-nothing fallback and one diagnostic. |
| `tests/completion.test.ts` | Unit-test active gating, settled flush, shared barrier chain, pre-arm/re-entrant settled handling, owner-token isolation, handoff guard, idempotent settled events, orphan release, suppression/re-arm while deferred, mixed send outcomes, async rejection, no-start retry, and fallback behavior. |
| `tests/wake-e2e.test.ts` | Reproduce the active-turn poll race for exit and match wakes; verify deferred unobserved delivery, exact-once behavior, mixed-kind batching, no duplicate turn after handoff, abandoned-observer fail-open behavior, and records arriving during nested settlement. |
| `tests/headless.test.ts` or a focused print-mode harness | Verify that a settled-dispatched wake turn completes before print-mode prompt resolution, that multiple print prompts do not collide with an in-flight wake, and that a settled-flush sync throw/re-entrant settle, early pre-start failure, all-sync-throw retry, and reset/shutdown during retry cannot strand the prompt-equivalent barrier. |
| `docs/IV-0001-long-wait-and-wake-control.md` | Amend the wake contract: pending wakes wait for settlement; direct observation before settlement consumes them; aborted observation leases fail open; lifecycle fallback is weaker; already-handed-off wakes remain irrevocable; early pre-start and model-failure cases are best effort. |
| `docs/IV-0004-wake-on-output-pattern.md` | Add the same delivery gate/barrier, token ownership, no-start retry, and abandoned-containment rules to readiness-wake semantics and the test matrix. |
| `README.md` / guidance carriers | Clarify that ending the turn after arming remains recommended for efficiency, not required for correctness; explain post-settle delivery, lifecycle fallback, best-effort wake failures, and the requirement to distinguish a direct poll result from a synthetic wake. |
| `Changelog.md` | Record the scoped design under the current unreleased documentation section when this document lands; add implementation notes separately if code is later shipped. |

No tool schema or upstream tool name changes are required. This is a fork-local behavioral hardening; if implemented, it should be listed as a loud divergence with the existing wake-control divergence rather than silently changing upstream parity.

## Test matrix

### Coordinator unit tests

- Fired exit wake stays pending while phase is active.
- Fired match wake stays pending while phase is active.
- `setAgentSettled()` releases orphaned leases before eligibility evaluation.
- `setAgentSettled()` flushes exactly once when eligible.
- Repeated `agent_settled` is harmless.
- `handoff` blocks a re-entrant flush but permits the second kind in the same selected batch.
- A shared settled barrier stays pending across a chain of wake turns and resolves at the first no-dispatch settle.
- Barrier is armed before flushing; a re-entrant settled during a send cannot resolve it while the coordinator-wide pending-dispatch counter is nonzero.
- A synchronous send throw during a settled flush leaves no stranded barrier.
- A promise sender that rejects after the settled flush releases its reservation, restores idle only for its still-current token, and resolves the barrier.
- A late old-token rejection after a newer `agent_start` or handoff cannot mutate the newer phase/barrier.
- `agent_start` releases the handoff into active state under first-start matching.
- Successful direct observation before settle removes the pending wake.
- Failed/cancelled observation leaves the wake eligible; abandoned leases are cleared at settle without consumption.
- Disarm, kill, reset, and re-arm suppress or replace deferred generations correctly.
- Mixed exit/match records still produce at most one message per kind and preserve generation checks.
- Sync and visible async send failures restore handoff only when no sibling dispatch was accepted.
- Timer/ordinary idle dispatch arms no settled barrier but still uses owner-token restoration on sender failure.
- Runtime fallback does not strand a wake when either lifecycle registration is unavailable; fallback performs no orphan release/barrier.
- Silent non-emission after successful registration is documented as outside detectable capability fallback.
- `agent_settled` with no prior `agent_start` follows the no-start path without hanging.
- A new record arriving during nested settlement is delivered by the guarded retry or next valid flush, not inline.
- No-start retry with a pending sender retains the barrier until sender outcome.
- No-start retry with all synchronous throws resolves/clears the barrier and returns idle.
- Reset/shutdown during retry resolves the barrier, cancels the retry, invalidates tokens, and leaves the coordinator idle.
- Late async rejection after reset/shutdown is ignored safely.

### Integration tests

- Active agent + process exit + later `write_stdin` poll produces only the direct result.
- Active agent + unobserved process exit produces one `runbg-completed` message at settle.
- Active agent + output match + containment poll produces no `runbg-matched` message.
- Active agent + unobserved match produces one `runbg-matched` message at settle.
- Exit and match from different sessions batch by kind after settlement; the second kind is a follow-up of the first wake turn in a runtime-modeled harness.
- Completion during the triggered wake turn waits for the next settlement and extends the chain only when eligible; it is not lost or duplicated.
- An aborted poll leaves no permanent observer lease and the wake remains deliverable.
- A handed-off wake that fails at the model/runtime layer is documented as best-effort and does not corrupt later arm state.
- Real/headless `pi -p` stays alive through the settled-dispatched wake turn and prints its final response.
- Multiple print-mode prompts do not collide with an in-flight settled-dispatched wake.
- Existing tests that emit only one of `agent_start`/`agent_settled` are audited: they either remain in explicit fallback mode or are updated to emit the complete lifecycle pair.

Existing harnesses whose stub coordinator starts in `idle` remain valid. The wake e2e harness should explicitly emit `agent_start` for lifecycle-aware cases. The synchronous recorder cannot model Pi's streaming follow-up queue; the mixed-kind queueing assertion belongs in a coordinator/runtime-modeled test.

## Alternatives considered

### Cancel an already queued follow-up

Rejected. The extension has no targeted Pi queue-cancellation API. Clearing the whole queue could delete unrelated steering or continuation messages, and a stale/no-op follow-up still costs a model turn.

### Store wake as `nextTurn` and trigger later

Rejected for v1. This avoids immediate delivery but requires a second trigger mechanism and risks losing automatic resume semantics. Settled-gated `sendMessage` provides the same safety with the existing API.

### Interrupt the active model turn on wake

Rejected. It would compete with steering, complicate tool cleanup and subagent behavior, and violate the purpose of the wake contract. Deferral is safer and matches Pi's follow-up semantics.

### Require models to end the turn immediately after arming

Insufficient. It is useful guidance but not an enforceable invariant; models may continue investigating, launch subagents, or poll later. Correctness must hold even when guidance is not followed.

### Hold the settled callback open only for one wake turn

Insufficient. A mixed-kind flush or a completion that becomes eligible during the triggered wake turn can create a finite follow-up chain. Resolving after one turn could let print mode exit while another wake turn is active. The shared barrier terminates at the first settled transition whose flush dispatches nothing.

### Downgrade every settled event to idle

Rejected. A duplicate/re-entrant settled event while a handoff owner is awaiting its start could open the gate and dispatch another wake before the first handoff is resolved. Handoff ownership, a coordinator-wide pending counter, and the guarded no-start retry are required instead.

## Compatibility and failure policy

The design relies on Pi lifecycle events already available to the supported runtime. Event registration is defensive and all-or-nothing. If either registration is unavailable, lifecycle gating is disabled and the pre-change immediate-flush path remains active; a diagnostic explains that the stronger guarantee is unavailable.

The supported-runtime path relies on run-start being synchronous with `sendMessage`, handlers being awaited, and normal runs being serialized. The design is hardened against re-entrant/async test and alternate-host senders with a pre-armed shared barrier, coordinator-wide pending counter, and owner tokens. It should be revisited if Pi changes the ordering or introduces concurrent run semantics as a supported contract.

`reset()`/`shutdown()` invalidate owner tokens and resolve barriers before clearing state so reload/new/resume/process exit cannot inherit a pending promise or late callback.

A failed send follows the existing recovery path: clear only the matching generation's reservation, retain the wake if still eligible, and retry on the next debounce/settled opportunity or guarded no-start retry. If no later trigger exists, the known quiet-session limitation remains. A send failure cannot leave the coordinator in `handoff` unless a still-current sibling dispatch was accepted or remains outstanding.

## Recommendation

Implement this as the next wake-control hardening change. It is extension-local, directly addresses the observed redundant wake, preserves the one-wait-path invariant, and avoids requiring a Pi queue-cancellation API. The critical acceptance conditions are:

1. a direct observation finalized before `agent_settled` prevents the synthetic wake from ever being handed to Pi;
2. an unobserved wake is delivered at settlement on lifecycle-aware runtimes;
3. `pi -p` remains alive until a settled-dispatched wake chain completes;
4. aborted observations fail open rather than permanently blocking the wake;
5. lifecycle capability failure cannot deadlock all future wakes;
6. barrier/re-entrancy, no-start retry, owner-token, and async send-failure paths cannot strand the host or corrupt arm state;
7. fallback and concurrent-preflight limitations are explicit rather than hidden.

## Review record and revision notes

- **Draft 0.1:** Initial design for review. Focused on active-turn gating, settled delivery, and the settled-to-agent-start handoff race.
- **df-worker review:** Accepted the core after requiring a print-mode hold-open barrier, all-or-nothing lifecycle capability fallback, total send/settle handling, settled-time fail-open release of orphaned observation leases/staged containment, mixed-kind ordering, reset/shutdown barrier resolution, and explicit runtime ordering assumptions.
- **Draft 0.2:** Incorporated the df-worker amendments.
- **dp-worker review:** Accepted after requiring the barrier to be armed before flushing, a coordinator-wide pending-dispatch counter for re-entrant settlement, visible async rejection handling, exact fallback semantics with no orphan release/barrier, runtime preflight caveats, best-effort wording for handed-off model failures, print-mode idle-window justification, and explicit lifecycle-pair tests.
- **Draft 0.3:** Incorporated the dp-worker amendments.
- **0.10.0 implementation:** Added lifecycle-aware coordinator gating, settled
  barriers, owner-token dispatch accounting, orphan lease release, guarded
  no-start retry, reset/shutdown invalidation, atomic extension registration,
  and focused coordinator coverage. The fire-and-forget Pi wrapper remains
  documented as unable to expose production async rejection visibility.
- **Final design:** The implementation now follows this contract; no tool or
  upstream API changes were required.

## Retirement conditions

Superseded if Pi gains targeted follow-up cancellation or a first-class wake/continuation delivery primitive; if upstream/codex adopts equivalent active-turn-gated wake delivery; or if the run-bg wake mechanism is removed in favor of a host-level completion scheduler.
