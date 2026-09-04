# The CLI Sends No Caller Identity, So the Origin Guard Is Dead on Every CLI Dispatch

kanbanColumn: CREATED

## Goal

A dispatch issued from a terminal must name that terminal, so the roster barrier can exclude the caller from its own clear. Today the CLI names nobody, and the guard that exists to protect a dispatching lead never fires.

### Problem analysis

`computeRosterClearTargets` excludes the caller from the clear it triggers. Its own contract says why:

> `origin` — the terminal that *requested* the send... When present and on the roster, the origin is excluded: **a lead that dispatches to its own coder must not be cleared by its own dispatch.**

That guard is unreachable from the CLI. `doDispatch` (`cli.ts:1289-1294`) posts exactly three fields:

```js
await apiPost(port, '/kanban/dispatch', workspaceRoot, {
    plan: planId,
    targetColumn,
    workspaceRoot,
});
```

No `from`. `_handleKanbanDispatch` reads `body.from || body.originTerminal` at `LocalApiServer.ts:2045`, gets an empty string, and passes `originTerminal: undefined`. The resolver treats an absent origin as a no-op exclusion, which is correct for an operator's board drag — nobody requested it — but wrong here: an agent did request it, from a seat with a name.

**Observed 2026-09-04.** A team lead ran `switchboard dispatch 830a28a3 "LEAD CODED"` and was cleared mid-session, losing its orchestration state. Two protections should have caught it and neither could: the head exclusion does not apply because `LEAD CODED` makes the head the *destination*, and the destination is deliberately handed to the delivery path; the origin guard does not apply because the CLI sent no origin.

The destination half is card `01e5bcef` change 2. **This card is the other half**, and it is worth fixing on its own account: the origin guard is dead for every CLI dispatch, not just ones aimed at a lead.

**Why it surfaced today.** The `dispatch` verb shipped 2026-09-03 in `c0ea0b26`. Before it existed there was no CLI path into `/kanban/dispatch`, so the omission had nothing to break.

## Metadata

- **Complexity:** 2
- **Tags:** cli, dispatch, teams, both-hosts, bugfix

## User Review Required

None.

## Proposed Changes

### 1. The CLI sends the calling terminal's name

Add `from` to the `doDispatch` body, resolved from the caller's environment — the same seat name the fleet knows it by.

Resolution must be **explicit or absent**, never guessed. A wrong name is worse than no name: it would exclude some *other* seat from a clear it needed. If the caller's identity cannot be established, send nothing and behave exactly as today.

### 2. Say which source answered

Whatever supplies the name — an environment variable, a flag, a fleet lookup — record it alongside the value rather than returning a bare string. When a lead is cleared by its own dispatch again, the first question is whether the name was sent, and the second is where it came from. Neither should require re-deriving this from scratch.

### 3. Cover the other CLI verbs that reach a dispatching path

`dispatch` is the one with a reproduction, but it is not necessarily alone. Audit the CLI's other POSTs into dispatch and prompt-delivery endpoints for the same omission, and fix them in the same pass rather than leaving a second instance to be found the same way.

## Edge-Case & Dependency Audit

1. **A wrong name is the real hazard.** `origin` only ever *removes* a name from the clear set, so a bad value silently spares a seat that needed clearing. Prefer sending nothing over sending a guess.
2. **An operator's own CLI call has no seat.** A human typing `switchboard dispatch` in their own shell is not a fleet seat. Absent origin stays valid and must remain the default, not an error.
3. **Both hosts.** The CLI is shared, but confirm the extension host and the standalone host both read `from` on this route and pass it into the barrier.
4. **Does not supersede `01e5bcef`.** That card gates the destination clear. This one restores the origin guard. A lead dispatching to `LEAD CODED` needs both; either alone leaves a hole.
5. **Do not widen scope from caller data.** The resolver's security note holds: `origin` may only subtract from the target set. Nothing here should let a caller-supplied name add a seat or reach a roster it is not on.

## Verification Plan

1. A dispatch issued from a seat sends that seat's name as `from`, and the handler receives it.
2. A lead that dispatches to its own coder is not cleared by its own dispatch.
3. A dispatch from a plain operator shell sends no origin and behaves exactly as it does today.
4. An unresolvable caller identity sends nothing rather than a placeholder.
5. The recorded source of the name is visible after the fact.
6. A caller-supplied name that is not on the resolved roster changes nothing.
7. Both hosts pass the received origin into `computeRosterClearTargets`.
