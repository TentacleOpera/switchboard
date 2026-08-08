# Parallel Planner Lane in the Oversight Pass

## Goal

Let the existing `OversightPassService` run more than one planner-lane card in flight at a time, so a queue of N plans is improved in parallel across N terminals instead of one at a time behind a two-minute cooldown. The completion signal, the scoping, the deregistration, the multi-root isolation, the stuck detection and the autoban interlock all already exist and are reused unchanged — this plan changes a WIP limit and the cooldown semantics that assume it.

### The problem

`OversightPassService` (`src/services/OversightPassService.ts`) already is the unattended batch plan-improvement engine. `_pump()` (line ~412) dispatches at most one planner-lane card:

```ts
if (!s.inFlight.some(c => c.lane === 'planner')) {
    const idx = s.queue.findIndex(q => q.lane === 'planner');
    …
}
```

and gates the next one on a cooldown measured from the *previous planner card's completion* (`DEFAULT_COOLDOWN_MS = 120000`). Twenty plans therefore take twenty sequential improve cycles plus nineteen two-minute waits — hours of wall-clock for work that has no shared state between cards and no reason to serialise.

The lane limit and the cooldown both exist for the same historical reason: a single planner terminal. Two overlapping dispatches into one terminal interleave prompts, and the cooldown is the crude guard against it. With a pool of planner terminals — visible (`role-grid-fill-terminals.md`) or hidden (`hidden-terminal-create-and-provider-mix.md`) — the guard is protecting against a condition that no longer holds.

### Root cause

`inFlight` is a list, and the coding lane genuinely needs WIP-1 (sequential merges into one working tree). The planner lane was given the same shape by symmetry rather than by requirement. Nothing in `_handlePlanEvent`, `_completeStage`, `_armStuckTimer` or `resumeFromDisk` assumes one-per-lane — they are all already keyed per card, per `planId`. The parallel case is a one-line change plus the cooldown rethink; everything downstream already handles it.

---

> **Superseded — the entire original design: "Subscribe to `GlobalPlanWatcherService.onPlanDiscovered` … On a change to a plan that belongs to an active batch, send a linkup message to that batch's planner terminal," with the planner then reading the plan and advancing the work.**
>
> **Reason (two independent grounds, either sufficient).**
>
> *First, it is already built.* `OversightPassService.attachWatcher()` (line 147) subscribes to exactly this event, and `_handlePlanEvent` (line ~381) implements every scoping rule the original plan specified, point for point:
> - *"Register a batch as `{plannerTerminal, planIds[]}` and notify only on changes to plans in that set"* → `runtime.state.inFlight`, matched by resolved absolute path.
> - *"Ignore changes to plans not in any active batch — the pre-existing behaviour must stay unchanged"* → `if (!runtime …) return;` and the per-card path equality test.
> - *"Deregister a plan once notified so a later hand-edit does not re-wake the planner"* → `s.inFlight = s.inFlight.filter(c => c.planId !== card.planId)` in `_completeStage`.
> - *"Notify only the planner registered for that workspace — a multi-root user with two batches must not have one workspace's completions wake the other's"* → `this._passes.get(path.resolve(workspaceRoot))`, one runtime per root.
> - *"Deliver at most once per plan per batch"* → the baseline-mtime comparison plus removal from `inFlight`.
> - *"Delivery is best-effort; never throw into the watcher"* → the subscription is `void this._handlePlanEvent(...)` with per-card `try/catch` around every `stat`.
> - *"A worker that never writes never notifies"* → true by construction; the stuck timer then halts the pass rather than synthesising a message.
> Building a second subscriber to the same event, with an overlapping in-flight set, would mean two engines acting on the same plan-file change.
>
> *Second, and more damning: it costs more than what it replaces.* The stated motivation was that polling "costs a model turn per check, on the planner's subscription… for a feature whose entire motivation is spending less, a babysitting loop is the wrong shape." Waking a planner agent on every completion costs **one planner turn per plan** — the planner must read the plan, decide, and issue a kill. The oversight engine costs **zero** agent turns: the extension host advances the queue itself. The original design is a cheaper babysitting loop, not the absence of one.
>
> **Replaced with:** reuse the engine; change only what actually blocks parallelism. The one genuinely-new requirement the original design carried — a human-readable account of which plans came back with open questions — is served by the pass's existing `oversight-log.md` / `oversight-state.md` writers plus `GET /oversight/status`, extended per Proposed Changes.

> **Superseded — "That path is what the unpushed **linkup** work provides … no trace of it is in this branch. Verify all three [contract assumptions] before building."**
> **Reason:** Linkup has landed (see `hidden-terminal-create-and-provider-mix.md` for the evidence trail). Its contract is now known rather than assumed: the transport is `ptySendPrompt`, terminals are addressed by `friendlyName`, and extension code sends via `this._ptyHostVerb('ptySendPrompt', { name, data })` (`TaskViewerProvider.ts:19124`). All three assumptions hold.
> **Replaced with:** The verified contract is recorded here, but this plan no longer *needs* it — the engine advances the queue without messaging any terminal. It is retained as the mechanism for the optional digest hand-off in Proposed Changes.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, api, feature
**Project:** Browser Switchboard

## User Review Required

None. The two decisions that could have gone either way are made here: the planner lane gets a configurable `plannerConcurrency` (default 1, so existing behaviour is byte-identical unless asked for), and the cooldown becomes a *dispatch-spacing* delay rather than a completion-gated barrier, because a completion-gated cooldown is meaningless once several cards complete independently.

## Complexity Audit

### Routine

- `_handlePlanEvent` already iterates `[...runtime.state.inFlight]` and matches per card. It is correct for N in flight today, with no change.
- `_completeStage` already removes one card by `planId` and re-pumps. Correct for N.
- `_armStuckTimer` / `_clearStuckTimer` are keyed `planId → timer` in a `Map`. Correct for N.
- `resumeFromDisk` already loops `for (const card of [...parsed.inFlight])`. Correct for N.
- `oversight-state.md` serialises `inFlight` as an array. Correct for N, no schema change.
- The autoban double-dispatch 409 in `start()` is untouched and keeps working.

### Complex / Risky

- **The cooldown's meaning breaks under parallelism, silently.** `plannerLane.lastCompletionAtMs` is stamped in `_completeStage` and consumed in `_pump` as `(last + cooldownMs) - Date.now()`. With N in flight, "the previous planner card's completion" is not a well-defined instant — the value becomes "whichever card finished most recently", so a burst of completions serialises the *next* dispatches behind a rolling two-minute window. Left as-is, raising the WIP limit produces a pass that is parallel for the first N cards and sequential forever after. This is the one part of the change that will look like it works and not.
- **Terminal-pool exhaustion is invisible to the engine.** `_dispatchEntry` calls `this._deps.dispatch(...)` and halts the whole pass on any failure (`_halt`). With `plannerConcurrency: 10` and three planner terminals, dispatches 4-10 fail to find a target — and halt-on-failure means **the entire pass stops**, including the coding lane. The engine must not dispatch more planner cards than there are eligible planner terminals.
- **Halt-on-failure is a much bigger blast radius at N.** One bad plan file halting 10 in-flight improvers wastes 10 sessions. The rule is deliberate and documented ("any dispatch failure/timeout halts the WHOLE pass; never re-dispatch, never skip silently") and must **not** be softened as a side effect of this change — but the interaction has to be stated so the user chooses it knowingly.
- **Stuck timers now fire in bursts.** `stuckThresholdMs` defaults to the activity-light timeout (10 min). Ten cards dispatched within seconds of each other will time out within seconds of each other, and the first one to fire halts the pass. That is correct behaviour and needs no change; it does mean the halt reason should name the card, which it already does.
- **PRD contract #7 (two-layer completion) is unmet for oversight and stays unmet.** `OversightPassService` is constructed only in `TaskViewerProvider.ts:863`; `bootstrap.ts` has no oversight wiring at all, so `POST /oversight/start` returns `503 Oversight pass engine not available` under `npx switchboard` (`LocalApiServer.ts:2305-2311`). That is *honest* capability gating (contract #6) and not a regression, but it means this feature is extension-host-only. Standalone wiring is deliberately **out of scope** here — it is Layer-2 work for the whole oversight surface, not for this WIP change. State it in the report rather than quietly shipping a half-host feature.

## Edge-Case & Dependency Audit

**Race Conditions**
- `_dispatchEntry` splices the queue entry and pushes to `inFlight` **synchronously before any `await`**, explicitly so a concurrent pump cannot double-dispatch. That guard is what makes N-parallel safe; do not refactor the splice/push behind an await.
- `_pump` is re-entered from `_completeStage`, from the cooldown timer, and from `start()`. With N slots it must dispatch *up to* the free-slot count in one pass — a loop, not a single `findIndex` — or N completions arriving together will each dispatch one card and the pump will lag the pool.
- Several plans completing in the same watcher tick each call `_completeStage` → `_writeState`. `_writeState` rewrites `oversight-state.md` wholesale; concurrent rewrites must be serialised (the same `Promise` chaining `PtyFleetService._registryWrite` uses) or the file can be interleaved.

**Security**
- No new HTTP surface, no new auth path. `POST /oversight/start` keeps its existing `_checkAuth` gate and its 409 automation interlock.

**Side Effects**
- Raising planner concurrency multiplies concurrent agent sessions, and therefore spend, by the same factor. The setting must default to 1 so nobody gets a 10× bill from an upgrade.
- N improvers writing N plan files in one directory is the concurrency this design accepts; the single-file scope directive that keeps them from colliding lives in `improver-prompt-and-planner-lifecycle.md`. This plan is unsafe to run at N>1 without it — that is a hard sequencing dependency, not a preference.
- `_completeStage` re-reads the plan's landing column from the DB per card; N cards mean N reads per burst. Cheap, but note it is already best-effort and swallowed.

**Dependencies & Conflicts**
- `src/services/OversightPassService.ts` (primary), `src/services/LocalApiServer.ts` (the `/oversight/start` body doc comment at 2293-2299 gains the new field).
- No DB change, no schema change, no new verb, no catalog regeneration.
- `oversight-state.md` gains a `params.plannerConcurrency` field. A state file written by an older build lacks it — `resumeFromDisk` must default it to 1 rather than `undefined`, or a resumed pass computes `inFlight.length < undefined` and never pumps.

## Dependencies

- **Improver Prompt Contract** (`improver-prompt-and-planner-lifecycle.md`) — the single-file scope directive that makes N concurrent improvers in one plans directory safe. Must land **before** this is used at N>1.
- **A pool of planner terminals** — supplied by either `hidden-terminal-create-and-provider-mix.md` (hidden, mixed-provider) or `role-grid-fill-terminals.md` (visible grid). This plan is agnostic between them; it needs *a pool*, not a particular one.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is a change that appears to work and silently doesn't: raising the planner WIP limit without rewriting the completion-gated cooldown yields a pass that runs N cards in parallel once and then serialises behind a rolling two-minute window forever. Second is halt-on-failure at scale — dispatching more planner cards than there are planner terminals turns "no eligible terminal" into a pass-wide halt that also kills the coding lane, so the engine must clamp concurrency to the live pool rather than to the configured number. Third is resume compatibility: a state file written before this change has no `plannerConcurrency`, and an undefined comparison makes a resumed pass never pump at all. Mitigations: convert the cooldown to dispatch-spacing, clamp to the eligible pool size at pump time, and default the field on read.

## Proposed Changes

### `src/services/OversightPassService.ts`

**1. New param.** `OversightPassParams` gains `plannerConcurrency: number`. Parsed in `start()` alongside the others:

```ts
plannerConcurrency: Number.isFinite(body?.plannerConcurrency) && body.plannerConcurrency >= 1
    ? Math.floor(body.plannerConcurrency)
    : 1,
```

Default 1 — existing callers get byte-identical behaviour.

**2. `_pump` — fill the planner lane up to the limit.** Replace the single-slot `if` with a loop that dispatches while there is a free slot *and* a queued planner card:

```ts
const plannerInFlight = s.inFlight.filter(c => c.lane === 'planner').length;
const slots = Math.max(0, this._effectivePlannerSlots(s) - plannerInFlight);
for (let i = 0; i < slots; i++) {
    const idx = s.queue.findIndex(q => q.lane === 'planner');
    if (idx < 0) break;
    void this._dispatchEntry(runtime, idx);
}
```

The coding lane's WIP-1 block is untouched.

**3. `_effectivePlannerSlots` — clamp to the live pool.** `min(params.plannerConcurrency, eligiblePlannerTerminalCount)`, where the count comes from a new optional dep:

```ts
/** Live terminals eligible for this role, used to clamp lane concurrency to the
 *  real pool. Absent ⇒ no clamp (tests, headless). */
countEligibleTerminals?: (workspaceRoot: string, role: string) => Promise<number>;
```

wired in `TaskViewerProvider.ts:863` to the same resolver the dispatch path uses. Dispatching more cards than terminals is what turns a missing worker into a pass-wide halt; clamping is the fix, and it is strictly safer than relaxing halt-on-failure.

**4. Cooldown becomes dispatch spacing.**

> **Superseded — "the planner lane overlaps [the coding lane] with a ≥2-minute cooldown measured from the previous planner dispatch's COMPLETION signal."**
> **Reason:** A completion-gated cooldown presumes one planner card at a time. With N in flight, "the previous completion" is whichever card happened to finish last, so every burst of completions re-arms a rolling barrier and the lane degrades to sequential after the first N.
> **Replaced with:** `cooldownMs` is the minimum interval between planner **dispatches**. Track `plannerLane.lastDispatchAtMs`; `_pump` dispatches at most one planner card per `cooldownMs` window, re-arming `cooldownTimer` for the remainder. `lastCompletionAtMs` is retained in state (it is written to `oversight-state.md` and read by resume) but no longer gates dispatch. When `plannerConcurrency === 1` and `cooldownMs` is the default, behaviour is materially unchanged for the existing single-lane user; a stagger between spawns is also what the sibling terminal plans want, since `injectStartupCommand` types its command after a readiness delay.

**5. `resumeFromDisk` — default the new field.** `parsed.params.plannerConcurrency ??= 1` immediately after parse, before any pump. A state file from an older build otherwise yields `NaN`/`undefined` slot arithmetic and a pass that never advances.

**6. `_writeState` serialisation.** Chain state writes through a per-runtime promise so N simultaneous `_completeStage` calls cannot interleave a rewrite of `oversight-state.md`.

**7. Digest of open questions.** `_endPass`'s summary line, `_snapshot`, and therefore `GET /oversight/status` gain a per-completed-card `hasOpenQuestions: boolean`, read by scanning the finished plan file for the `## Outstanding Questions` heading defined in `improver-prompt-and-planner-lifecycle.md`. This is the one capability the superseded notification design carried that the engine does not already have, and it belongs here — where the pass already knows which plan finished and already writes the human-readable log — rather than in a separate messaging path.

Optionally, on `_endPass`, deliver that digest into a named terminal via `ptySendPrompt` when the caller passed `digestTerminal` in the start body. One message per pass, not one per plan — that is the shape that does not scale with batch size.

### `src/services/LocalApiServer.ts`

Doc-comment only: the `POST /oversight/start` body list at 2293-2299 gains `plannerConcurrency?` and `digestTerminal?`. No routing change, no schema entry (the oversight routes are hand-rolled REST, not verb-rail).

## Verification Plan

### Automated Tests

1. **Default is unchanged.** A pass started with no `plannerConcurrency` runs exactly one planner card in flight; assert the existing oversight tests pass unmodified.
2. **Parallel dispatch.** `plannerConcurrency: 4` with 10 queued planner cards → 4 in flight after the first pump, and a 5th dispatched only as one completes.
3. **Pool clamp.** `plannerConcurrency: 10` with `countEligibleTerminals` returning 3 → at most 3 in flight, and **no halt**.
4. **Cooldown is dispatch spacing.** With `cooldownMs: 1000` and 4 slots, assert dispatches are spaced ≥1 s apart and that a burst of 4 simultaneous completions does **not** delay the next dispatches by a completion-gated window.
5. **Independent completion.** Four in-flight cards; a watcher event for card 2 completes card 2 only — cards 1, 3, 4 stay in flight, their stuck timers intact, and no message fires for plans outside `inFlight`.
6. **Scoping unchanged.** A plan-file change for a plan in **no** active pass produces no state change and no log line (the pre-existing behaviour this must not regress).
7. **Multi-root isolation.** Two workspaces each with a running pass; assert each engine reacts only to its own root's events.
8. **Resume compatibility.** An `oversight-state.md` written without `plannerConcurrency` resumes, defaults to 1, and pumps.
9. **State-file serialisation.** Four `_completeStage` calls in the same tick produce one well-formed `oversight-state.md`, not an interleaved one.
10. **Halt still halts.** A dispatch failure with 4 in flight halts the whole pass, leaves the other 3 on the board untouched, and never re-dispatches.
11. **Open-questions digest.** A completed plan containing `## Outstanding Questions` is reported `hasOpenQuestions:true` in `GET /oversight/status` and named in the `_endPass` summary; one without it is `false`.
12. **Autoban interlock unchanged.** `start()` still returns 409 while automation is armed, at any concurrency.

### Manual (VSIX)

13. With 4 planner terminals live, start a pass over 8 `CREATED` plans at `plannerConcurrency: 4`. Confirm: 4 improve sessions run at once, cards land in `PLAN REVIEWED` as each finishes, `oversight-log.md` records 8 completions, the end-of-pass summary names any plan with open questions, and hand-editing an unrelated plan mid-pass changes nothing.

## Uncertain Assumptions

None. Every claim in this plan is verified against the code at HEAD and cited by file and line.

## Recommendation

Complexity 5 → **Send to Coder.**
