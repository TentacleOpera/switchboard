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

`handlePtyVerb` (`TaskViewerProvider.ts:3394`, the function every HTTP `POST
/terminals/verb/…` lands in) decides the curtain at `:3593-3598`:

```ts
const isClearing = verb === 'ptySendPrompt' && payload?.clearBeforePrompt === true;
const shouldArmCurtain = isClearing || isBooting;
```

`payload.clearBeforePrompt` is **what the caller asked for**, not what will happen. It then
calls `this._ptyHostVerb(verb, payload, signal)` at `:3616` — and `_ptyHostVerb`
(`:490`) is where the work-context logic **overrides that very field**, in both directions:

- **Same work context** (`lastTeamWorkKey === workContextKey`, `:738-771`) — the destination is
  forced to `clearBeforePrompt: false` (`:770`), because two subtasks of one feature are one
  context and must not reset between them. **The curtain was already armed on the caller's
  `true`. It now covers a clear the system has deliberately suppressed.**
- **New work context** (`:772` onward) — after the roster barrier runs, the destination is
  forced to `clearBeforePrompt: true` (`:907`). **The curtain was not armed, because the lead
  sent `false` exactly as the drive prefix instructs it to** (*"clearBeforePrompt stays false on
  every dispatch — the host overrides it to true automatically when the plan changes"*). A real
  clear runs uncurtained.

So the curtain is wrong in both directions, and the two failures share one cause: the decision is
taken upstream of the code that decides the answer.

### Root cause 2 — nothing knows a seat is already clean

`computeRosterClearTargets` partitions the roster into skip / `toClear` / `deferred` from live
status, the destination, the origin, and a `lastDataAt` busy set (`:764-793`). **No input tells
it whether a seat has already been cleared.** So when a new feature enters the team, every roster
seat is cleared and curtained, including seats cleared moments earlier by `queue/done`, by a lead
standing a seat down, or by the previous feature's own barrier.

The evidence to suppress that already exists and is not consulted:
`_lastWorkContextByTerminal` is **deleted on every clear** — by `clearTerminalContext`
(`:10897`) and by `ptyClearTerminal` (`bootstrap.ts:1854`). Its absence is a per-terminal record
of "this seat is clean." The non-team branch already uses exactly that reasoning
(`:920-928`: `if (clearEnabled && lastWorkKey && lastWorkKey !== workContextKey)` — a cleared
terminal has no `lastWorkKey`, so it is not re-cleared). The team branch never looks.

### Root cause 3 — the curtain is never reconciled against the result

`clearTerminalContext` can return `{ cleared: false }` — most simply when
`terminal.clearBeforePrompt` is off, which it checks first (`:10890-10892`). The curtain has
already been shown by then, and `terminalDispatchFinished` reports `success` (the call did not
throw), not whether anything was cleared. A curtain that covered nothing looks identical to one
that covered a reset.

### Three arm sites, three different proxies

| Site | Armed on |
|---|---|
| `handlePtyVerb` `:3599-3612` | the caller's requested `clearBeforePrompt`, or `promptCount === 0` |
| Roster barrier `:801-823` | membership of `toClear`, before any clear I/O runs |
| Roster barrier `:871-880` | membership of `deferred` — seats that are **never** cleared |
| `terminals.js:6085` | a webview-side arm with `phase: 'clearing'` |

None of them observes a clear. `promptCount` is at least honest — it latches to 1 on first
delivery (`ptyPromptDelivery.ts:253`) and is never reset, so it does not misfire on a cleared
seat — but it answers "has this seat ever been prompted", not "is output about to be replaced".

### Scope — what this plan does not own

`a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`
owns the `deferred` arm site (`:871`) and excluding the head from the roster clear. Do not
re-diagnose either. This plan owns the intent-versus-evidence defect and the arm/override
ordering; the two are complementary and independently shippable.

## Implementation

### 1. Move the curtain decision below the override

The curtain must be armed by whoever knows the final `clearBeforePrompt`, not by the caller's
request. Resolve the work-context override **first**, then decide, so a same-context dispatch
never arms and a new-context dispatch always does.

The mechanical options are to hoist the override resolution above the arm site in
`handlePtyVerb`, or to have `_ptyHostVerb` own the arm entirely and remove it from
`handlePtyVerb`. Prefer the second: one arm site per delivery, owned by the code that decides
the clear. Whichever is chosen, the invariant is testable and is the point of this plan — **the
curtain's phase must be derived from the same value passed to `sendPromptToPty`.**

Keep the `isBooting` arm as it is: `promptCount === 0` is a genuinely different condition (a CLI
banner is about to render) and it does not misfire on cleared seats.

### 2. Do not clear — and so do not curtain — a seat that is already clean

In the roster barrier, exclude from `toClear` any seat with no `_lastWorkContextByTerminal`
entry, which is the record a clear deletes. Apply the same reasoning the non-team branch already
applies, rather than inventing a second signal.

Two cautions:
- A seat that has *never* been dispatched to also has no entry. It is equally not in need of a
  clear, so the same exclusion is correct — but it must land in `skip`, not `deferred`, or it
  will be treated as owed a clear later.
- This narrows what the barrier clears. Confirm against the atomic-lifecycle contract that a
  genuinely dirty seat is still caught: the entry is written on dispatch and deleted on clear, so
  "has an entry" means "has been dispatched to since its last clear", which is exactly dirty.

### 3. Take the curtain down when nothing was cleared

Carry the clear result into `terminalDispatchFinished` — a distinct reason when
`clearTerminalContext` returned `cleared: false` — and have the panel disarm immediately on it
rather than waiting out its quiet/hard timers (`CURTAIN_QUIET_MS`, `CURTAIN_MAX_MS`,
`terminals.js:245-246`). A curtain that covered nothing should vanish, not linger.

### 4. Both hosts

`_ptyHostVerb` early-returns to `this._headlessRuntime.ptyVerb(verb, payload)` at `:495`, **above**
the work-context barrier — so standalone never runs this barrier at all and reimplements the
lifecycle itself (`bootstrap.ts`: `lastWorkContextByTerminal`, `deferredClearsByTeam`,
`dropDeferredClear`). Two implementations of one policy is how these diverge. Land the same three
changes in the standalone arm, and diff the two by hand rather than trusting that the verb
answers in both.

## Verification Plan

1. **The reported case.** Dispatch to a team within one work context, with a payload carrying
   `clearBeforePrompt: true`. Confirm no curtain appears, and that no clear runs — the override
   to `false` at `:770` is the correct behaviour and must be unchanged.
2. **The inverse.** A lead dispatches a new feature with `clearBeforePrompt: false` as the drive
   prefix instructs. Confirm the clear that the host forces to `true` at `:907` **is** curtained
   — this is a real reset currently going uncovered.
3. Assert the invariant directly: the phase reported on `terminalDispatchPreparing` matches the
   `clearBeforePrompt` value actually handed to `sendPromptToPty`, for both branches.
4. A new feature entering a team whose seats were cleared moments earlier clears and curtains
   none of them; a team with one genuinely dirty seat clears and curtains only that one.
5. A seat never dispatched to lands in `skip`, not `deferred`, and is not owed a later clear.
6. With `terminal.clearBeforePrompt` disabled, no curtain is shown at all; if one is armed before
   the result is known, it disarms on the result rather than timing out.
7. `dispatch-curtain-and-ufo-contract.test.js` passes, extended with the invariant from step 3.
8. Both hosts, run 1-6 under each. `npx tsc --noEmit -p tsconfig.json`.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, bugfix, reliability
