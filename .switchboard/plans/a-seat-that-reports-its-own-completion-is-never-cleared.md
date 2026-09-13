# A Seat That Reports Its Own Completion Is Never Cleared

## Goal

A seat is clean before it is handed the next subtask, whoever posted the completion. Reporting
your own finish must not be the thing that stops your context being reset.

### The bug

`completeCardInternal` (`LocalApiServer.ts:4245`) and `releaseCardInternal` (`:4462`) both carry
the same four lines:

```js
// Never clear the lead in `from`, planner, or reviewer
if (acceptedCodingSeat === from) {
    acceptedCodingSeat = undefined;
}
```

The comment states the intent **by role** — do not clear a lead, planner or reviewer that is
posting about somebody else's seat. The code compares **by name**.

So the guard fires whenever the poster happens to be the seat that holds the card. That is not an
edge case: it is the documented worker flow. The member completion instruction tells a seat to run
`done --from "<your terminal name>"`, which makes `from` and `acceptedCodingSeat` the same string
every time. A seat that reports its own finish therefore suppresses its own clear.

A role check would let it through — `intern` and `coder` are in `CODING_ROLES`, which the code
evaluates two lines earlier and then discards.

### Why this reads as "clears are broken"

The clear that separates one subtask from the next is not on the dispatch path — by design, so no
delivery races a context reset. It is a side effect of the completion post: the seat is cleared
*at rest*, when its work is accepted or released. That is the only clear between subtasks.

Suppress it and the seat keeps everything. Measured 2026-09-13 on `Coding-intern`: two `/clear`s
in the entire session, both near the start, thousands of lines before any of the work. Three
different plans were dispatched into it — `one-shell-load-…` and `the-standing-orders-tab-…` among
them — with no clear between any of them. It finished at 139k/200k context (69%) carrying every
previous subtask.

That breaks the rule the head prompt itself states: one subtask per **clean** seat. Sequential is
not the same as same-seat-dirty.

### Why the seat did not get cleared by anything else

- The dispatch path issues no clear, deliberately.
- `completeCardInternal` was never reached: the completion post was refused (see
  `a-finished-seat-is-told-its-own-card-blocks-it-and-re-derives-the-call`).
- `releaseCardInternal` *was* reached — the card came back `released` — and hit this same guard,
  so the release cleared the card and not the seat.

So both at-rest clears were available and both were suppressed by the same four lines.

### Non-goals

- **Clearing on dispatch.** `eight-automatic-clears-and-the-one-that-matters-fires-last-minute`
  (LEAD CODED) settles that the dispatch path issues no clear; this plan does not reopen it.
- **Clearing a lead, planner or reviewer.** The guard's intent is correct and is preserved — only
  its test changes.
- **A new clear trigger.** The two at-rest clears already exist and already run. They simply need
  to stop excluding the seat that reported.

## Metadata

- **Complexity:** 3
- **Tags:** backend, api, bugfix, reliability

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting a four-line guard that is provably redundant (its predicate can only match the
  self-report case the goal wants to clear).
- Two call sites in one file (`src/services/LocalApiServer.ts`), structurally mirrored.
- The receipt already carries the diagnostic fields the operator needs; no new response surface.

### Complex / Risky
- The two clear paths are not fully symmetric: `completeCardInternal` (4277-4289) gates the clear
  behind `_isSeatCurrentDispatchedCard` ("seat already at rest" / "seat moved to another card"),
  while `releaseCardInternal` (4520-4538) clears `acceptedCodingSeat` unconditionally. After the
  fix, a self-report *release* arriving after the seat was re-dispatched to a new card would clear
  the new card's context. This divergence is **pre-existing** (a lead-initiated release has the same
  gap today) and is **out of scope** for this bugfix; recorded here, not fixed here.
- Extracting the shared seat-resolution helper touches both call sites and must preserve the
  "host evidence only, never `from`, never the request body" invariant exactly.

## Edge-Case & Dependency Audit

- **Race Conditions:** A self-report completion that arrives *after* the seat has already been
  re-dispatched to a new card. On the **complete** path, `_isSeatCurrentDispatchedCard` returns
  `shouldClear: false` with `movedTo` set — the new card is protected. On the **release** path,
  there is no such guard; the clear fires on `acceptedCodingSeat` unconditionally. Pre-existing,
  not introduced by this fix; tracked under Complexity Audit, not fixed here.
- **Security:** No new trust boundary. The fix *removes* a name-based comparison and relies on the
  existing host-evidence `CODING_ROLES` gate, which never reads the request body — strictly safer.
- **Side Effects:** Removing the guard lets the self-report clear fire. The clear is idempotent via
  `markSeatAtRest` / `isSeatAtRest` (1215-1216): a second completion post for the same run returns
  `shouldClear: false` ("already cleared for this run"), so a duplicate self-report does not
  double-clear.
- **Dependencies & Conflicts:** Depends on `a-finished-seat-is-told-its-own-card-blocks-it-and-re-derives-the-call`
  only for the incident narrative (why `completeCardInternal` was not reached), not for the fix
  itself. The fix holds on whichever at-rest path runs. No conflict with
  `eight-automatic-clears-and-the-one-that-matters-fires-last-minute` (dispatch-path clear, a
  non-goal here).

## Dependencies

- None (no prior session dependencies).

## Adversarial Synthesis

Key risks: (1) the plan's original prose mechanism ("skip the clear when `from` resolves to a
non-coding role") would, read literally, suppress every lead-initiated clear — the primary flow —
while the endpoint still returns `success: true`, so the bug *appears* fixed; superseded in favor
of deleting the guard. (2) The real verbatim duplication is the 17-line `CODING_ROLES`
seat-resolution block, not the four-line guard — extracting the wrong one leaves the drift seam
intact. (3) The release path lacks the complete path's `_isSeatCurrentDispatchedCard` "seat moved
on" guard; a self-report release after re-dispatch clears the new card — pre-existing, recorded,
not fixed here. Mitigations: delete the guard (the `CODING_ROLES` gate above already enforces the
intent), extract the resolution block into one helper so both paths resolve a coding seat the same
way, and assert both paths × both posters in the contract test.

## Proposed Changes

### `src/services/LocalApiServer.ts` — `completeCardInternal` (≈4224-4247) and `releaseCardInternal` (≈4443-4464)

**Context.** Both functions resolve `acceptedCodingSeat` from host evidence (the card's
`dispatchedTerminal` + its `routedTo` role, falling back to a `ptyListTerminals` role lookup),
gated by `CODING_ROLES = new Set(['coder', 'intern'])`. Only after that gate do they run the
name-comparison guard that this plan removes. The resolution block (≈17 lines) is duplicated
verbatim between the two functions; the four-line guard is duplicated verbatim below it.

> **Superseded:** Replace the name comparison with a role check on `from` — "skip the clear when
> `from` resolves to a non-coding role (lead, planner, reviewer), and clear otherwise — including
> when the poster is the coding seat itself. The role is already resolved immediately above,
> against `CODING_ROLES, from host evidence rather than the request body. The fix uses that value
> instead of throwing it away."
> **Reason:** The role resolved "immediately above" is the **dispatched seat's** role (used to
> decide whether the seat is a coding seat worth clearing), NOT `from`'s role. The plan conflated
> the seat with the poster; there is no resolved `from` role to reuse. Worse, read literally,
> "skip the clear when `from` is non-coding" suppresses every lead-initiated clear — a lead posting
> acceptance for a coder IS a non-coding `from`, and that is the primary flow. The plan's own test
> #1 ("a lead posting about a coder clears the coder") would fail against its own prose. The
> `CODING_ROLES` gate above already guarantees `acceptedCodingSeat` is a coder/intern or
> `undefined`, so a non-coding `from` can never equal it (different person + role mismatch); the
> guard is provably redundant for its stated intent and provably harmful for the self-report case,
> which is the only case it can ever fire on.
> **Replaced with:** **Delete the four-line guard entirely** in both functions. Do not replace it
> with a role check. The `CODING_ROLES` gate in the resolution block above is the entire protection
> the comment describes; the name comparison adds nothing correct and is the bug.

**Logic.**
1. In `completeCardInternal`, remove lines ≈4244-4247 (the `// Never clear the lead in from…`
   comment + the `if (acceptedCodingSeat === from) { acceptedCodingSeat = undefined; }` block).
2. In `releaseCardInternal`, remove the identical block at ≈4462-4464.
3. Leave the `else if (!acceptedCodingSeat)` diagnostic branches (4318-4334, 4539-4546) in place —
   they still correctly explain the *genuine* no-coding-seat case (`clearReason = 'No coding seat
   attributed to plan'`). The self-report branch of that diagnostic (`dispatchedSeat === from`)
   becomes unreachable for a coding seat after the fix, because a self-reporting coder now has
   `acceptedCodingSeat` set and flows into the clear block instead; that is the intended behavior
   and the branch harmlessly handles only the residual no-seat case.

**Implementation — extract the resolution block (corrected Proposed Change #2).**

> **Superseded:** "One helper, both call sites — the four lines are duplicated verbatim. Extract
> them so the two paths cannot drift."
> **Reason:** The four-line guard is the code being *deleted*, not extracted. The actual verbatim
> duplication — and the real drift seam — is the 17-line `CODING_ROLES` seat-resolution block above
> it (4226-4242 in `completeCardInternal`, 4445-4461 in `releaseCardInternal`). Extracting the guard
> would preserve the bug in a shared helper; extracting the resolution block is what actually
> prevents the two paths from resolving a coding seat differently.
> **Replaced with:** Extract the resolution block into a single private helper, e.g.
> `private async _resolveAcceptedCodingSeat(existing, workspaceRoot): Promise<string | undefined>`,
> containing the `CODING_ROLES` set, the `dispatchedSeat`/`rowRole` fast path, and the
> `terminalVerb('ptyListTerminals')` fallback. Both `completeCardInternal` and
> `releaseCardInternal` call it and assign its return to `acceptedCodingSeat`. The helper is the
> one place that enforces "host evidence only, never `from`, never the request body" — which is the
> invariant that makes deleting the name guard safe.

**Edge Cases.**
- A `lead_coder` dispatched seat (role `lead_coder`, not in `CODING_ROLES`) resolves to
  `acceptedCodingSeat = undefined` both before and after the fix — no behavior change; no clear.
- A duplicate self-report completion: `markSeatAtRest`/`isSeatAtRest` (set at 4307/4529, checked at
  1215-1216) returns `shouldClear: false` on the second post — no double-clear. The complete path's
  `_isSeatCurrentDispatchedCard` guard (4277-4289) is the idempotency backstop; the release path
  lacks it (see Complexity Audit), but that is pre-existing and out of scope.
- Name collision (a lead and a coder sharing a terminal friendly name): the clear targets the
  dispatched seat's name, which the `CODING_ROLES` gate already confirmed is a coder. The guard
  never protected against this — it only suppressed the clear. Deleting it does not regress this
  pathological case.

### Receipt already names the cleared seat (Proposed Change #3 — already satisfied)

> **Superseded:** "Say which seat was cleared in the response. Both endpoints return a receipt.
> Name the seat that was cleared, or state that none was and why. The operator's report of this
> bug was 'clears are not working', which took a session log to confirm, because a suppressed clear
> is currently indistinguishable from a clear that happened."
> **Reason:** The receipt already does this. Both endpoints return `cleared` (bool),
> `acceptedCodingSeat` (the seat name, when set), and `clearReason` (the why). The self-report
> diagnostic at 4320-4330 (`completeCardInternal`) and 4543-4545 (`releaseCardInternal`) already
> emits: `Seat '<from>' posted its own completion — a self-report does not clear context…`. A
> suppressed clear is *no longer* indistinguishable from a clear that happened. The fix itself makes
> the self-report visible in the receipt, because `cleared` flips to `true` and `acceptedCodingSeat`
> is populated where before both were suppressed.
> **Replaced with:** No new response work. Keep the existing receipt shape as a *verification
> assertion* (see Verification Plan): the contract test asserts the receipt carries `cleared` and
> either `acceptedCodingSeat` (cleared) or `clearReason` (not cleared), so the operator's
> "clears are not working" report is answerable from the receipt without a session log.

## Verification Plan

### Automated Tests

1. **New** `src/test/self-reported-completion-clears-contract.test.js`, wired as
   `test:contract:self-completion-clear` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Follow the
   `team-release-control-contract.test.js` harness pattern (`makeServer` with a `clears[]`-capturing
   `clearTerminalContext` stub and a `terminalVerb` returning role-tagged terminals). Asserts:
   - a coder posting `from` = itself **is** cleared (`cleared: true`, `acceptedCodingSeat` set,
     `clears` array contains the seat);
   - a lead posting completion for a coder clears the coder and not the lead (`clears` contains the
     coder, not the lead);
   - a planner or reviewer in `from` is never cleared (the coder it posted about is).
2. The same four assertions against the **release** path (`releaseCardInternal`), not only
   completion — the duplication is the risk, and release is what ran in the incident.
3. Assert the receipt names the cleared seat: on a clear, `cleared === true` and `acceptedCodingSeat`
   is the seat name; on a no-seat case, `cleared === false` and `clearReason` is non-empty. (This is
   the corrected Proposed Change #3 — an assertion against the existing receipt shape, not new code.)
4. Assert the four-line guard is **absent** from `LocalApiServer.ts` (a source-text grep for
   `acceptedCodingSeat === from` returns no matches) — a negative invariant pinning the removal,
   so the bug cannot be reintroduced silently.
5. Assert the shared resolution helper is called by both paths (mirror the
   `team-release-control-contract.test.js` §5 pattern: stub the helper, invoke both routes, assert
   two calls) — pins the anti-drift extraction.

### Goal Invariants

- A seat that runs `done --from "<itself>"` is cleared before it can be handed another subtask.
- A lead posting completion for a coder clears the coder and never itself.
- Two consecutive subtasks on one seat start from the same context size, within the noise of one
  prompt — not the second starting where the first ended.
- A suppressed clear is visible in the response, not only in a session log.
- The string `acceptedCodingSeat === from` is absent from `src/services/LocalApiServer.ts` (the
  name guard is gone, paired with the positive: a `_resolveAcceptedCodingSeat` helper is resolvable
  and is called by both `completeCardInternal` and `releaseCardInternal`).

## Outstanding Questions

- **[user]** The release path (`releaseCardInternal`, 4520-4538) clears `acceptedCodingSeat`
  unconditionally and lacks the `_isSeatCurrentDispatchedCard` "seat moved on" guard that the
  complete path (4277-4289) has. After this fix, a self-report *release* arriving after the seat was
  re-dispatched to a new card would clear the new card's context. This is pre-existing (a
  lead-initiated release has the same gap today) and is deliberately left out of scope for this
  bugfix. — proceeding on the assumption that this divergence is acceptable to record-and-defer
  rather than fix here; if you want it closed in the same change, say so and the plan grows a
  sixth step (add the `_isSeatCurrentDispatchedCard` call to the release clear block).

---

**Recommendation:** Complexity 3 → **Send to Coder.**

## Review Findings

The fix landed as specified in `src/services/LocalApiServer.ts`: the four-line `acceptedCodingSeat
=== from` guard is gone from both `completeCardInternal` and `releaseCardInternal`, and the 17-line
`CODING_ROLES` resolution block is extracted into one `_resolveAcceptedCodingSeat` helper that both
paths call — the anti-drift extraction the plan's Adversarial Synthesis named, not the guard. The
verification plan's entire automated half was missing, which is the whole discriminator for this
plan: written as `src/test/self-reported-completion-clears-contract.test.js` (14 checks: both
at-rest paths × self-report / lead / planner / reviewer, receipt shape, clear idempotency, the
negative source invariant, and the shared-helper call count), wired as
`test:contract:self-completion-clear` in `package.json` and invoked from
`.github/workflows/integration-tests.yml:589`. Proven load-bearing — reinstating the guard turns 7
of the 14 red. Field-existence verified down to the writer: `dispatchedTerminal` is absent from
`PLAN_COLUMNS` and arrives via the `plan_runtime_state` overlay in `KanbanDatabase._readRows`, and
`routedTo` maps from the persisted `routed_to` column, so the helper's host-evidence reads are real.
Validation: the new suite 14/14, `task-complete` and `atomic-team-lifecycle` now fully green (both
were entirely red on pre-existing harness rot), `team-release-control` 7 red → 4, `compile-tests`
and eslint clean.

## Deferred Findings

- MAJOR — `src/services/LocalApiServer.ts:4557` The release path still lacks the complete path's `_isSeatCurrentDispatchedCard` "seat moved on" guard, so a self-report release arriving after the seat was re-dispatched clears the new card's context. Pre-existing (a lead-initiated release has the same gap) and explicitly recorded as out of scope by the plan's own Outstanding Questions.
- MAJOR — `src/test/team-release-control-contract.test.js:180` Four assertions in that suite still pin the pre-valve contract (`completed_at` / `completeCardInternal` for `POST /kanban/team/release`), which now routes through `releaseCardInternal` and writes `released_at`. They were masked behind a 403 until this pass; rewriting them belongs to the release-valve plan, not this one.
- NIT — `src/services/LocalApiServer.ts:4380` The `dispatchedSeat === from` diagnostic now only fires for a non-coding self-reporter (e.g. a lead on its own LEAD CODED card), where "a self-report does not clear context" is no longer the real reason — the role gate is. Harmless: the branch is receipt prose, not behaviour.
