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

- **Complexity:** 2
- **Tags:** teams, completion, clear, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Suppress the clear by ROLE, not by name

In both `completeCardInternal` and `releaseCardInternal`, replace the name comparison with the
check the comment already describes: skip the clear when `from` resolves to a non-coding role
(lead, planner, reviewer), and clear otherwise — including when the poster is the coding seat
itself.

The role is already resolved immediately above, against `CODING_ROLES`, from host evidence rather
than the request body. The fix uses that value instead of throwing it away.

### 2. One helper, both call sites

The four lines are duplicated verbatim. Extract them so the two paths cannot drift — a fix applied
to completion and missed on release would leave exactly half this bug in place, and release is the
path that actually ran in the incident.

### 3. Say which seat was cleared in the response

Both endpoints return a receipt. Name the seat that was cleared, or state that none was and why.
The operator's report of this bug was "clears are not working", which took a session log to
confirm, because a suppressed clear is currently indistinguishable from a clear that happened.

## Verification Plan

### Automated Tests

1. **New** `src/test/self-reported-completion-clears-contract.test.js`, wired as
   `test:contract:self-completion-clear` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Asserts:
   a coder posting `from` = itself **is** cleared; a lead posting about a coder clears the coder
   and not the lead; a planner or reviewer in `from` is never cleared.
2. The same four assertions against the **release** path, not only completion — the duplication is
   the risk, and release is what ran in the incident.
3. Assert the receipt names the cleared seat.

### Goal Invariants

- A seat that runs `done --from "<itself>"` is cleared before it can be handed another subtask.
- A lead posting completion for a coder clears the coder and never itself.
- Two consecutive subtasks on one seat start from the same context size, within the noise of one
  prompt — not the second starting where the first ended.
- A suppressed clear is visible in the response, not only in a session log.
