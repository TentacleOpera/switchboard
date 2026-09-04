# The dispatch curtain is armed from intent, not from a clear that actually runs — so it covers dispatches and misses real clears

## Goal

Decide the curtain from the clear that will actually happen, in one place, after every override
that can change it — and take it down the moment the clear reports it did nothing. Today the
curtain is armed from three different proxies for "a clear is probably coming", none of which is
the clear.

### The problem

The curtain — which exists to hide a context reset — appears when a team lead dispatches
instructions to terminals that were already cleared. Nothing is being reset, so it covers
nothing.

### Root cause 1 — the curtain decision is made against a value the next call inverts

This is the defect that produces the reported symptom.

`handlePtyVerb` (`TaskViewerProvider.ts:3780+`, the function every HTTP `POST
/terminals/verb/…` lands in) decides the curtain at `:3800-3801`:

```ts
const isClearing = verb === 'ptySendPrompt' && payload?.clearBeforePrompt === true;
const shouldArmCurtain = isClearing || isBooting;
```

`payload.clearBeforePrompt` is **what the caller asked for**, not what will happen. It then
calls `this._ptyHostVerb(verb, payload, signal)` at `:3822` — and `_ptyHostVerb`
(`:588`) is where the work-context logic **overrides that very field**, in both directions:

- **Same work context** (`lastTeamWorkKey === workContextKey`, `:839-853`) — the destination is
  forced to `clearBeforePrompt: false` (`:852`), because two subtasks of one feature are one
  context and must not reset between them. **The curtain was already armed on the caller's
  `true`. It now covers a clear the system has deliberately suppressed.**
- **New work context** (`:854` onward) — after the roster barrier runs, the destination is
  forced to `clearBeforePrompt: true` (`:988-990`). **The curtain was not armed, because the lead
  sent `false` exactly as the drive prefix instructs it to** (*"clearBeforePrompt stays false on
  every dispatch — the host overrides it to true automatically when the plan changes"*). A real
  clear runs uncurtained.

So the curtain is wrong in both directions, and the two failures share one cause: the decision is
taken upstream of the code that decides the answer.

### Root cause 2 — nothing knows a seat is already clean

`computeRosterClearTargets` partitions the roster into skip / `toClear` / `deferred` from live
status, the destination, the origin, and a `lastDataAt` busy set (`:880-892`). **No input tells
it whether a seat has already been cleared.** So when a new feature enters the team, every roster
seat is cleared and curtained, including seats cleared moments earlier by `queue/done`, by a lead
standing a seat down, or by the previous feature's own barrier.

The evidence to suppress that already exists and is not consulted:
`_lastWorkContextByTerminal` is **deleted on every clear** — by `clearTerminalContext`
(`TaskViewerProvider.ts:11327`) and by `ptyClearTerminal` (`bootstrap.ts:3332`). Its absence is a per-terminal record
of "this seat is clean." The non-team branch already uses exactly that reasoning
(`:1007-1008`: `if (clearEnabled && lastWorkKey && lastWorkKey !== workContextKey)` — a cleared
terminal has no `lastWorkKey`, so it is not re-cleared). The team branch never looks.

### Root cause 3 — the curtain is never reconciled against the result

`clearTerminalContext` can return `{ cleared: false }` — most simply when
`terminal.clearBeforePrompt` is off, which it checks first. The curtain has
already been shown by then, and `terminalDispatchFinished` reports `success` (the call did not
throw), not whether anything was cleared. A curtain that covered nothing looks identical to one
that covered a reset.

### Three arm sites, three different proxies

| Site | Armed on |
|---|---|
| `handlePtyVerb` `:3805-3819` | the caller's requested `clearBeforePrompt`, or `promptCount === 0` |
| Roster barrier `:906-964` | membership of `toClear`, before any clear I/O runs |
| Roster barrier `:966-972` | membership of `deferred` — seats that are **never** cleared |
| `terminals.js:6085` | a webview-side arm with `phase: 'clearing'` |

None of them observes a clear. `promptCount` is at least honest — it latches to 1 on first
delivery (`ptyPromptDelivery.ts:253`) and is never reset, so it does not misfire on a cleared
seat — but it answers "has this seat ever been prompted", not "is output about to be replaced".

### Scope — what this plan does not own

`a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`
owns the `deferred` arm site (`:966`) and excluding the head from the roster clear. Do not
re-diagnose either. This plan owns the intent-versus-evidence defect and the arm/override
ordering; the two are complementary and independently shippable.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

None — the approach is fully specified.

## Complexity Audit

### Routine
- Moving the curtain arm from `handlePtyVerb` to `_ptyHostVerb` (extension) and the equivalent in `handlePtyVerb` (standalone).
- Keeping the `isBooting` arm as-is (`promptCount === 0` is a genuinely different condition).
- Excluding already-clean seats from `toClear` by checking `_lastWorkContextByTerminal`.

### Complex / Risky
- The curtain disarm on `cleared: false` requires propagating the clear result through the verb response — the current `terminalDispatchFinished` reports `success` (did the call throw?), not `cleared`. This is a response-shape change.
- The already-clean exclusion must happen in the caller (the barrier code), not inside the pure `computeRosterClearTargets` helper — the helper has no access to `_lastWorkContextByTerminal`. Either filter `toClear` after the helper returns, or extend the helper's interface with a `cleanSet` parameter.
- Both hosts must be updated in parallel — the standalone host has its own `handlePtyVerb` in `bootstrap.ts`, not a headless early-return in `TaskViewerProvider._ptyHostVerb`.

## Edge-Case & Dependency Audit

**Race Conditions:** The curtain arm and the override happen in the same async call chain (`handlePtyVerb` → `_ptyHostVerb`). Moving the arm below the override means the curtain message is sent later in the chain — but still before `sendPromptToPty` runs, so the pane still gets the curtain before output changes. No new race.

**Security:** No new surface — the curtain is a UI overlay, not a security boundary.

**Side Effects:** Moving the arm site changes when `terminalDispatchPreparing` is emitted. Any consumer that relies on the current timing (before `_ptyHostVerb`) will see it later. The webview's `terminals.js` is the only consumer, and it keys on `operationId`, not timing.

**Dependencies & Conflicts:**
- Sibling plan `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md` finding 1 fixes the deferred-set lifecycle and the re-fire gate. This plan's already-clean exclusion (step 2) reduces what enters `toClear`; the sibling plan's pruning removes from `deferred` when cleared. They touch different output arrays of the same barrier call. Land this plan's exclusion first — it reduces the work the sibling plan's pruning needs to do.
- The external plan `a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md` owns the `deferred` arm site and head exclusion. Do not touch either.

## Dependencies

- `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md` — finding 1 (deferred-set lifecycle) and finding 2 (delivery-path clears the head) both modify the same barrier region. Coordinate the ordering: this plan's already-clean exclusion should land first, then the sibling's deferred-set pruning and head-clearing gate.

## Adversarial Synthesis

Key risks: (1) the curtain disarm on `cleared: false` requires a response-shape change — the current `terminalDispatchFinished` reports `success`, not `cleared`, and the mechanism for carrying the clear result is underspecified; (2) the already-clean exclusion must happen in the caller, not the pure helper, because `computeRosterClearTargets` has no access to `_lastWorkContextByTerminal`; (3) the standalone host has its own `handlePtyVerb` in `bootstrap.ts` — the original plan's claim about `_headlessRuntime.ptyVerb` was factually wrong. Mitigations: specify the clear-result propagation mechanism concretely (add a `cleared` field to the `ptySendPrompt` verb response), filter `toClear` in the caller after the helper returns, and reference `bootstrap.ts`'s `handlePtyVerb` directly for the standalone parallel.

## Proposed Changes

### 1. Move the curtain decision below the override

The curtain must be armed by whoever knows the final `clearBeforePrompt`, not by the caller's
request. Resolve the work-context override **first**, then decide, so a same-context dispatch
never arms and a new-context dispatch always does.

Prefer having `_ptyHostVerb` own the arm entirely and removing it from `handlePtyVerb`: one arm
site per delivery, owned by the code that decides the clear. The invariant is testable and is
the point of this plan — **the curtain's phase must be derived from the same value passed to
`sendPromptToPty`.**

Keep the `isBooting` arm as it is: `promptCount === 0` is a genuinely different condition (a CLI
banner is about to render) and it does not misfire on cleared seats.

### 2. Do not clear — and so do not curtain — a seat that is already clean

In the roster barrier, exclude from `toClear` any seat with no `_lastWorkContextByTerminal`
entry, which is the record a clear deletes. Apply the same reasoning the non-team branch already
applies, rather than inventing a second signal.

This exclusion must happen in the **caller** (the barrier code in `_ptyHostVerb` /
`handlePtyVerb`), not inside the pure `computeRosterClearTargets` helper — the helper has no
access to `_lastWorkContextByTerminal`. Filter `toClear` after the helper returns:
`toClear = toClear.filter(name => this._lastWorkContextByTerminal.has(name))` (extension) or
`toClear.filter(name => lastWorkContextByTerminal.has(name))` (standalone). Do NOT extend the
helper's interface — keeping it pure is load-bearing for the parity tests.

Two cautions:
- A seat that has *never* been dispatched to also has no entry. It is equally not in need of a
  clear, so the same exclusion is correct — but it must land in `skip`, not `deferred`, or it
  will be treated as owed a clear later. Since it was never in `toClear` (the helper only
  includes live, non-destination, non-origin, non-head, non-busy seats), filtering it out of
  `toClear` is a no-op for it — it was never there. Confirm this.
- This narrows what the barrier clears. Confirm against the atomic-lifecycle contract that a
  genuinely dirty seat is still caught: the entry is written on dispatch and deleted on clear, so
  "has an entry" means "has been dispatched to since its last clear", which is exactly dirty.

### 3. Take the curtain down when nothing was cleared

Carry the clear result into `terminalDispatchFinished` — a distinct reason when
`clearTerminalContext` returned `cleared: false` — and have the panel disarm immediately on it
rather than waiting out its quiet/hard timers (`CURTAIN_QUIET_MS`, `CURTAIN_MAX_MS`,
`terminals.js:245-246`). A curtain that covered nothing should vanish, not linger.

**Mechanism:** Add a `cleared: boolean` field to the `ptySendPrompt` verb response. The
`sendPromptToPty` path already knows whether it pasted `/clear` (from `clearBeforePrompt`) and
whether the clear succeeded. Propagate this through the verb response so the `finally` block in
`handlePtyVerb` (or `_ptyHostVerb` if the arm moved there) can emit
`terminalDispatchFinished` with `reason: 'no-clear'` when `cleared === false`. The webview's
`terminals.js` curtain handler must treat `reason: 'no-clear'` as an immediate disarm, distinct
from `reason: 'fallback'` (timer-based) and `reason: 'error'`.

### 4. Both hosts

> **Superseded:** The original plan stated: "`_ptyHostVerb` early-returns to `this._headlessRuntime.ptyVerb(verb, payload)` at `:495`, above the work-context barrier — so standalone never runs this barrier at all and reimplements the lifecycle itself."
> **Reason:** `_headlessRuntime` (TaskViewerProvider.ts:1491) has only `getApiPort` and `isApiListening` — no `ptyVerb` method exists. The standalone host does not use `TaskViewerProvider._ptyHostVerb` at all. It has its own `handlePtyVerb` function in `bootstrap.ts` (starting around `:1680`) with its own roster barrier at `:2272-2341` and its own `deliverPrompt` at `:273`. Two implementations of one policy is how these diverge.
> **Replaced with:** The standalone host has its own `handlePtyVerb` in `bootstrap.ts` with a parallel barrier at `:2272-2341`. Land the same three changes (move arm below override, exclude already-clean, disarm on no-clear) in the standalone arm. The curtain messages are sent via `server.broadcastWs` in standalone, not `this.postMessage` — the message shape must match. Diff the two roots by hand rather than trusting that the verb answers in both.

## Verification Plan

### Automated Tests

1. **The reported case.** Dispatch to a team within one work context, with a payload carrying
   `clearBeforePrompt: true`. Confirm no curtain appears, and that no clear runs — the override
   to `false` at `:852` is the correct behaviour and must be unchanged.
2. **The inverse.** A lead dispatches a new feature with `clearBeforePrompt: false` as the drive
   prefix instructs. Confirm the clear that the host forces to `true` at `:988-990` **is** curtained
   — this is a real reset currently going uncovered.
3. Assert the invariant directly: the phase reported on `terminalDispatchPreparing` matches the
   `clearBeforePrompt` value actually handed to `sendPromptToPty`, for both branches.
4. A new feature entering a team whose seats were cleared moments earlier clears and curtains
   none of them; a team with one genuinely dirty seat clears and curtains only that one.
5. A seat never dispatched to lands in `skip`, not `deferred`, and is not owed a later clear.
6. With `terminal.clearBeforePrompt` disabled, no curtain is shown at all; if one is armed before
   the result is known, it disarms on the result (`reason: 'no-clear'`) rather than timing out.
7. `dispatch-curtain-and-ufo-contract.test.js` passes, extended with the invariant from step 3
   and the `cleared` field on the verb response from step 3's mechanism.
8. Both hosts, run 1-6 under each. `npx tsc --noEmit -p tsconfig.json`.

### Goal Invariants

- `handlePtyVerb` in `TaskViewerProvider.ts` does NOT contain `shouldArmCurtain` or `isClearing` — the arm has moved to `_ptyHostVerb` (or equivalent).
- The `ptySendPrompt` verb response includes a `cleared: boolean` field.
- `terminalDispatchFinished` with `reason: 'no-clear'` causes immediate curtain disarm in `terminals.js` (no timer wait).
- `toClear` in the roster barrier excludes any seat with no `_lastWorkContextByTerminal` entry (extension) / `lastWorkContextByTerminal` entry (standalone).
- `computeRosterClearTargets` in `workContextResolver.ts` is unchanged — the already-clean filter is applied by the caller, not the helper.

**Recommendation:** Complexity 5 → Send to Coder.
