# Agents can set a card's priority level, and can tell whether it changed anything

## Goal

Let an agent mark a card Urgent / High / Normal / Low over HTTP, and have that
reach the tracker the card came from — so "triage the board" is something an
agent can actually do, not just describe.

Extends the existing `PUT /kanban/plans/priority` rather than adding a second
route: the star and the level are two halves of one idea (*the star directs,
the priority describes* — `priority-as-a-native-field-and-a-board-wide-order-by.md`),
and an agent should not have to know they are two columns.

### Problem Analysis

**The field is planned but has no agent-facing write.**
`priority-as-a-native-field-and-a-board-wide-order-by.md` adds a nullable
`plans.priority` (1 Urgent · 2 High · 3 Normal · 4 Low · NULL no priority),
extends `compareByPrecedence` with an order-by mode, and
maps both trackers. Its Proposed Changes §4 touches `LocalApiServer` only for the
queue pop and the team queue. So when it ships, an agent will be able to **read**
a card's priority and **star** a card, and will have no way to set the level —
the same gap `PUT /kanban/plans/priority` was created to close for the star, and
`agents-set-a-columns-card-order.md` closes for order.

**Setting the level is not the same kind of write as starring, in one way that
matters: it has to leave the machine.** The star is local board state. Priority
is a field Linear and ClickUp also hold, and the parent plan settled the policy
as bidirectional last-write-wins (§7, §8) — the tickets panel already lets a
developer change remote priority directly, so guarding the API path while the
panel path is open protects nothing. An agent-set priority that stays in
`kanban.db` diverges from the tracker until the next inbound sync overwrites it,
which is the worst of the three possible behaviours: the agent reports success,
the board shows the change, and the tracker silently disagrees until it wins.

**But the DB-direct route family deliberately has no provider.**
`PUT /kanban/plans/priority` resolves a `KanbanDatabase` and writes
(`LocalApiServer.ts:6531-6555`). Tracker write-back lives provider-side
(`LinearSyncService.updateIssuePriority` at `:1217`, `ClickUpSyncService.updateTask`
at `:1525`), reachable only through a seam on `LocalApiServerOptions`. Adding one
is unavoidable, and it is precisely the hazard this project has a rule about:

> service seams (`engine.setX(...)`), options objects handed to shared services,
> and `Promise<void>` callbacks where "never wired" and "working" are the same
> value.

A `notifyPriorityChanged?: (…) => Promise<void>` wired in one composition root
and not the other would make every gate pass while half the hosts silently
stopped syncing — the `PlanIngestionEngine` queue-seam precedent verbatim. So
the seam must be **wired in both roots and observable in the response**, not
trusted.

**One tracker-code hazard is worth naming even though the decision defuses it.**
`ClickUpSyncService.createTask` guards with `if (priority) body.priority = priority`
(`:1457`) — falsy for `0`, so a `0` would be dropped without error. Since 0 is
never stored in `plans.priority`, no write-back from this endpoint can hit that
guard today. It is recorded because the guard is wrong in general and because the
Linear side proves the pattern is avoidable: `updateIssuePriority` (`:1217`)
validates `0 <= priority <= 4` and passes `0` through cleanly, which is what makes
the NULL → Linear-0 write-back safe.

### Root Cause

Two write paths for one field, established at different times for different
callers: the panel writes the tracker, the board writes the DB, and no route
does both. An agent needs the field, so the endpoint that gives it to them is
the first caller that has to reconcile them.

### Non-goals

- **Changing the star, its strict-boolean ladder, or its response shape.**
  `starred` keeps working exactly as it does; this is additive.
- **Changing precedence, or which sort mode the board is in.** Priority only
  re-sequences work when `kanban.orderBy` is `priority`; this plan reports that
  fact (below) rather than overriding the user's choice.
- **Custom levels, or ranked stars.** Both trackers fix their scale at four; the
  parent plan's non-goals stand.
- **Relaxing the advisory that agents do not set priority unless instructed to**
  (parent plan §9). That is a prompt-level rule and stays one. This plan supplies
  the capability the rule governs; a capability that only exists when misused is
  not a safer design.
- **A confirm gate.** Per project rule, none.

## Metadata

**Complexity:** 5
**Tags:** backend, api, feature, reliability

## Dependencies

Blocked on `priority-as-a-native-field-and-a-board-wide-order-by.md` §1 — the
`plans.priority` column, its migration, `PLAN_COLUMNS`, and the record mapper.
That plan's **decision 1 is resolved** (2026-08-27): there is exactly one
no-priority state and it is NULL — a tracker is not a special source of "no
priority", so Linear's 0 and ClickUp's blank both import as NULL and 0 is never
stored. This endpoint's validation ladder encodes that ruling.

Independent of `agents-set-a-columns-card-order.md`; they touch different
fields and can ship in either order.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — accept `priority` beside `starred`

`_handleSetPlanPriority` (`:6490`) gains an optional `priority`. `starred` stays
optional. **At least one must be present** — a body with neither is 400, which is
the current behaviour for a missing `starred` and stays honest for both.

```
PUT /kanban/plans/priority
{ "planId": "…", "priority": "urgent" }        → level only
{ "planId": "…", "starred": true }             → star only (unchanged)
{ "planId": "…", "starred": true, "priority": 1 }  → both, one request
```

**Validation ladder**, modelled on the star's (`:6505-6528`) and for the same
reason — a permissive coercion here writes the wrong urgency and reports success:

| Input | Result |
|---|---|
| `1`–`4`, or `"1"`–`"4"` | that level |
| `"urgent"`, `"high"`, `"normal"`, `"low"` (case/space-insensitive) | 1–4 |
| `null`, `"none"`, `"clear"` | NULL — *no priority* |
| `0` or `"0"` | NULL — Linear's wire value for no priority, accepted and collapsed |
| `true`/`false`, `5`, `-1`, `3.5`, `""`, anything else | 400 |

There is one no-priority state, so `"none"` is unambiguous and accepted — as is a
bare `0`, which is what a caller reading Linear's API would naturally send. Both
collapse to NULL rather than being rejected: refusing a value with exactly one
possible meaning is friction, not safety. `""` stays a 400, because an empty
string is far more often a missing variable than an intent to clear.

Label strings are accepted because agents write labels, and the mapping is not
invented here: it is Linear's own, at `LinearSyncService.ts:2753`
(`['', 'urgent', 'high', 'normal', 'low']`). Import that array rather than
retyping it — but note index 0 is `''` there, so the label lookup must treat
NULL separately rather than reading slot 0.

Reuse unchanged from the star arm: `planId` / `sessionId` resolution (`:6538`),
and keying the write to `record.workspaceId` rather than the server's
(`:6544-6551`) — the reported-but-unwritten trap. Priority has identical
exposure.

**Response** — extended, with two fields that exist to stop the endpoint lying
by omission:

```json
{ "success": true, "planId": "…", "starred": false,
  "priority": 1, "priorityLabel": "urgent",
  "orderBy": "manual",
  "trackerSync": "linear" }
```

- **`orderBy`** — the board's current sort mode (`kanban.orderBy` in `config`).
  Setting a card Urgent on a board ordering by *manual* changes a badge and
  nothing about what runs next. The agent needs to be able to say so: *"marked
  Urgent; this board orders manually, so nothing re-sequenced."* Without this the
  agent confidently reports a re-prioritisation that did not happen — the parent
  plan's own thesis (*"the board shows one order and the system acts on
  another, and nothing reports the discrepancy"*) applied to the reply instead of
  the screen.
- **`trackerSync`** — `"linear"` / `"clickup"` (written), `"none"` (card is
  local, nothing to write), `"failed"` (attempted, tracker rejected — the DB
  write stands, last-write-wins), or **`"unavailable"`** (this host wired no
  callback). `"unavailable"` is the whole point: it converts the never-wired
  composition-root failure from invisible into a value in every response.

### 2. `LocalApiServerOptions` — one seam, wired in both roots

```ts
notifyPriorityChanged?: (planId: string, priority: number | null)
    => Promise<'linear' | 'clickup' | 'none' | 'failed'>;
```

It **returns** its outcome rather than being `Promise<void>`. That is deliberate:
a void callback is the shape the project's rule names, where "never wired" and
"working" are the same observable value. A returned outcome, surfaced as
`trackerSync`, cannot be silently absent.

Wire it in **both** composition roots, next to where each already wires
`getKanbanDatabase`:

- **extension** — `TaskViewerProvider.ts:3714`. Resolve the card, pick the
  tracker from `linearIssueId` / `clickupTaskId`, call
  `updateIssuePriority(issueId, priority ?? 0)` or
  `updateTask(taskId, { priority })`.
- **standalone** — `bootstrap.ts:2769`. Same, using whichever sync services the
  standalone host holds; where it holds none, wire a callback that returns
  `'none'` explicitly rather than leaving the option undefined, so the response
  distinguishes "this host does not sync" from "nobody wired this".

Diff the two roots by hand. The seams each host *wires* are the audit, not the
verbs each host answers.

**NULL on write-back.** Linear has no null — write `0`, which
`updateIssuePriority` accepts (`:1217` validates 0–4). This is not lossy under the
resolved decision: 0 is exactly what Linear means by no priority, and the return
trip collapses it back to NULL, so the round-trip is stable. ClickUp has no
"clear" — omit the field.

**Check `updateTask`'s guard anyway.** Levels 1–4 are truthy so nothing breaks
today, but if it guards with `if (priority)` like `createTask` does (`:1457`),
tighten it to `if (priority !== undefined)` while here — the next caller with a
falsy-but-meaningful value should not have to rediscover this.

### 3. `.agents/skills/switchboard-orchestration/SKILL.md` — document the level

Extend the star's row at `:104` and its `curl` example at `:119`. State plainly:

- the four labels, and that `null` / `"none"` / `"clear"` / `0` all mean the
  one no-priority state;
- the star and the level are different things — the star directs, the level
  describes; starring is not "priority 1";
- **check `orderBy`** before telling a user the board has been re-prioritised;
- **check `trackerSync`** before telling a user Linear or ClickUp was updated;
- the standing advisory: do not set priority unless the user asked for it.

### 4. Catalog

`npm run catalog:generate` (`package.json:942`); `catalog:check` is the gate. The
route already exists, so this is a payload change — confirm the catalog records
the new field rather than assuming a same-path route needs no regeneration.

### Migration

**None of its own.** The column and its migration belong to the parent plan. This
plan adds no state. The response gains fields, which is additive for existing
callers reading `success` / `starred`.

## Verification Plan

1. **Extend `src/test/plan-priority-endpoint.test.js`** — it already builds a
   fake DB reproducing the unscoped-lookup and true-on-zero-rows properties.
   Add:
   - every accepted input from the ladder writes the expected integer or NULL —
     including `0`, `"0"`, `"none"`, and `"clear"` all landing as NULL;
   - `""`, `true`, `false`, `5`, `-1`, `3.5` → 400, **zero writes**;
   - neither field present → 400;
   - both fields present → both columns written in one request;
   - `starred`-only requests behave **exactly** as before, byte-for-byte on the
     existing assertions — this is the regression that matters most;
   - server workspace id ≠ resolved row's → the write is keyed to the row's id;
   - `trackerSync` is `"unavailable"` when no callback is wired, `"failed"` when
     the callback throws or returns `'failed'`, and the DB write still stands;
   - `orderBy` reflects the `config` value, including its default when unset.
2. **Tracker write-back unit test** — a fake sync service asserting Urgent → `1`
   for Linear and for ClickUp, and NULL → `0` for Linear / field omitted for
   ClickUp. Add the Linear round-trip: NULL → write 0 → read 0 → NULL, asserting
   the card does not oscillate between states across a sync poll.
3. **Both hosts, by hand** — set a level under the extension host and under the
   standalone host, and assert `trackerSync` is not `"unavailable"` in either.
   `npm run standalone-parity:check` is scoped to the browser read-back path and
   would pass with the seam wired in neither root, so it cannot be the evidence
   here.
4. **`npm run catalog:check`** passes.

### Goal Invariants

- An agent can set a card's priority in one request, using the label a human
  would use.
- No input is silently coerced: every value either means one thing or is
  rejected.
- There is one no-priority state end to end: an inbound `0`, `"none"`, or
  `null` all land as NULL, and no path writes 0 into `plans.priority`.
- A response never claims a tracker write that did not happen, and never hides
  that this host cannot make one.
- A response never implies work was re-sequenced when the board's sort mode
  means it was not.
- The star's existing contract is unchanged.
