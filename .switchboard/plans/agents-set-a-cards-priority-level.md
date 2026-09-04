# Agents can set a card's priority level, and can tell whether it changed anything

<!-- board-collapse-09 -->
> **VOCABULARY NOTE 2026-09-04 (Board Collapse 09).** Two other plans define an agent-facing board-write vocabulary containing a `star` action: *The CLI is a peer control surface* and *Board control instructions* (the latter now parked in Backlog). Both express `star` as a **bare boolean**, which cannot carry the 1–4 priority level this plan adds to the same `PUT /kanban/plans/priority` endpoint. Whichever lands second would otherwise ship a command that can only half-address the field.
> 
> Add the level argument to both when they are coded. They also cite the same handler at two different line ranges (`:6505-6528` and `:7077-7143`), so at least one is stale — re-derive rather than trust either.
> 
> Also verify before dispatch: `c0eb26ea`/`4df54319` shipped priority as a native card field with a board-wide order-by, so this plan's parent field may already exist. Its own text flags this.


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
(`LocalApiServer.ts:7118-7143`). Tracker write-back lives provider-side
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

> **Superseded:** Adding a `notifyPriorityChanged?: (planId, priority) => Promise<…>` seam on `LocalApiServerOptions`, wired in both composition roots, to give `_handleSetPlanPriority` tracker write-back without the route calling a provider directly.
> **Reason:** The seam IS the hazard the plan warns about. `LocalApiServer` already calls `this._options.getLinearService()` / `this._options.getClickUpService()` directly inside 15+ existing route handlers (`:1718`, `:7335`, `:7549`, `:7843`, …) — the "DB-direct routes have no provider" property is not a hard constraint, it is the current state of routes that did not need write-back. Both composition roots already wire `getLinearService` / `getClickUpService` into the options object (extension `TaskViewerProvider.ts:3732-3733`; standalone `bootstrap.ts:3001-3002`, services constructed at `:530-531`). A new seam (a) recreates the "never wired = working" failure mode verbatim, (b) forces the composition root to RE-RESOLVE the record to find its `linearIssueId` / `clickupTaskId` because the signature passes only `(planId, priority)` — a second DB lookup for data the handler already holds, and (c) introduces `trackerSync: "unavailable"`, a value that exists only to detect a seam that should not exist. If there is no seam, the failure mode cannot occur.
> **Replaced with:** Call the already-wired service accessors directly inside `_handleSetPlanPriority`. The handler already loads the record (`getPlanByPlanId` / `getPlanBySessionId`, `:7126-7127`), which carries `linearIssueId` and `clickupTaskId`. Pick the tracker from the record, call `getLinearService()?.updateIssuePriority(issueId, priority ?? 0)` or `getClickUpService()?.updateTask(taskId, { priority: priority ?? null })`, and compute `trackerSync` inline. No new option, no new seam, no `"unavailable"` value. The `trackerSync` enum becomes `"linear"` / `"clickup"` (written), `"none"` (card has no tracker link — local card), or `"failed"` (attempted, tracker rejected — the DB write stands, last-write-wins). Both roots are covered by the SAME options they already construct; there is nothing extra to wire, so there is nothing to forget to wire.

**One tracker-code hazard is worth naming even though the decision defuses it.**
`ClickUpSyncService.createTask` guards with `if (priority) body.priority = priority`
(`:1457`) — falsy for `0`, so a `0` would be dropped without error. Since 0 is
never stored in `plans.priority`, no write-back from this endpoint can hit that
guard today. It is recorded because the guard is wrong in general and because the
Linear side proves the pattern is avoidable: `updateIssuePriority` (`:1217`)
validates `0 <= priority <= 4` and passes `0` through cleanly, which is what makes
the NULL → Linear-0 write-back safe.

> **Clarification — `updateTask` has no such guard.** The plan's original §2 said "check `updateTask`'s guard anyway — if it guards with `if (priority)` like `createTask` does, tighten it." `ClickUpSyncService.updateTask` (`:1525-1576`) does NOT guard — it passes the `updates` object verbatim to `httpRequest('PUT', …)`. The `if (priority)` guard exists only in `createTask` (`:1457`), which this endpoint never calls. So that tightening step is a no-op for `updateTask`; the `createTask` guard is wrong-in-general but out of scope for this endpoint. No change to `updateTask` is needed for levels 1–4 (truthy, passed through). The clear path is handled directly — see §2.

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

## User Review Required

None. The parent plan's three design questions are resolved (2026-08-27); this
plan is additive on top of them and introduces no new product decision. ClickUp's
ability to clear priority over the API (`{"priority": null}`) was confirmed by
web research (2026-08-30) and is wired directly — no open items remain.

## Complexity Audit

### Routine

- Extending `_handleSetPlanPriority` (`LocalApiServer.ts:7077`) to accept an
  optional `priority` beside `starred`, with a validation ladder modelled on the
  star's (`:7090-7116`).
- Reusing unchanged: `planId` / `sessionId` resolution (`:7084`, `:7126-7127`),
  the workspace-keyed write (`:7140-7141`), and the 404 / 503 / auth paths.
- Extending the response with `priority`, `priorityLabel`, `orderBy`,
  `trackerSync` — additive; existing callers reading `success` / `starred` are
  unaffected.
- The orchestration SKILL.md row (`:104`) and `curl` example (`:119`) — doc copy.
- `npm run catalog:generate` (`package.json:956`); `catalog:check` is the gate.

### Complex / Risky

- **Tracker write-back honesty.** The response must not claim a tracker write
  that did not happen, and must distinguish "no tracker to write" from "tracker
  refused." This is the whole point of `trackerSync`, and it is the place a
  silent lie is most likely (see the ClickUp-clear gap).
- **ClickUp clear requires an explicit `null`, not omission.** `updateTask`
  (`:1525`) passes `updates` verbatim and throws on an empty updates object
  (`:1550-1552`). Omitting `priority` leaves ClickUp's old value intact while the
  DB goes NULL — a divergence the response would hide. Web research (2026-08-30)
  confirmed ClickUp API v2 accepts `{"priority": null}` to clear priority, so the
  write-back sends `priority: null` explicitly (via `priority ?? null`), not an
  omission. `0` and `""` are rejected by the API — the validation ladder already
  rejects them at 400, so they never reach the write-back.
- **Both-hosts coverage is not automatic.** With the seam removed, both roots
  are covered by the options they already construct — but the verification must
  still exercise write-back under each host, because `npm run
  standalone-parity:check` is scoped to the browser read-back path and would
  pass with the service accessor returning null in either root.
- **`orderBy` depends on the parent plan.** `db.getOrderByMode` does not exist
  yet (parent plan §1 unshipped as of this review). The handler must call
  `db.getOrderByMode?.(wsId) ?? 'manual'` defensively so this plan can land
  before or alongside the parent without a hard dependency on the method's
  presence.

## Edge-Case & Dependency Audit

**Race conditions**
- Priority changed in the tracker and locally between polls: last-write-wins,
  and the response records which side won via `trackerSync` so a surprise is
  diagnosable. The DB write lands first; the tracker write is best-effort and
  its outcome is reported, not gated on the DB write.
- Tracker write in flight when an inbound sync poll runs: the poll may overwrite
  the just-written value. Last-write-wins is the settled policy; the Linear
  round-trip (NULL → 0 → NULL) is stable by construction, so no oscillation.

**Security**
- Anyone who can call this endpoint (auth-gated, `:7078`) can change a card's
  priority and, with a priority sort active, what runs next. Same authority as
  the star, which is already exposed on this route. No new authority surface.

**Side effects**
- Setting a level writes `plans.priority` (parent plan's column) AND the tracker.
  The DB write is the source of truth for the board; the tracker write is the
  reconciliation. A failed tracker write does NOT roll back the DB write
  (last-write-wins) — `trackerSync: "failed"` reports it.
- The response gains fields. Existing callers that destructure `{ success,
  starred }` are unaffected; callers that assert exact-shape equality on the
  response body would break. No in-tree caller does (the test asserts specific
  fields, not whole-body equality).

**Dependencies & Conflicts**
- **Blocked on** `priority-as-a-native-field-and-a-board-wide-order-by.md` §1 —
  the `plans.priority` column, its migration, `PLAN_COLUMNS`, the record mapper,
  and `setCardPriority` / `getOrderByMode`. That plan's decision 1 is resolved
  (2026-08-27): one no-priority state, NULL; 0 is never stored. This endpoint's
  validation ladder encodes that ruling. As of this review the parent plan §1 is
  **unshipped** (`KanbanDatabase.ts` has no `priority` column, no
  `setCardPriority`, no `getOrderByMode`), so this plan cannot land alone.
- **Independent of** `agents-set-a-columns-card-order.md`; they touch different
  fields and can ship in either order.
- The `orderBy` response field reads `db.getOrderByMode`; call it defensively
  (`?.`) so a build against a DB without the method does not throw.

## Dependencies

- `priority-as-a-native-field-and-a-board-wide-order-by.md` §1 — the
  `plans.priority` column, its migration, `PLAN_COLUMNS`, the record mapper, and
  `setCardPriority` / `getOrderByMode`. That plan's **decision 1 is resolved**
  (2026-08-27): there is exactly one no-priority state and it is NULL — a tracker
  is not a special source of "no priority", so Linear's 0 and ClickUp's blank
  both import as NULL and 0 is never stored. This endpoint's validation ladder
  encodes that ruling.
- Independent of `agents-set-a-columns-card-order.md`; they touch different
  fields and can ship in either order.

## Adversarial Synthesis

Key risks: (1) the original seam design recreated the exact "never-wired =
working" hazard the plan exists to close — superseded with a direct service call
using the already-wired `getLinearService` / `getClickUpService` accessors; (2)
ClickUp cannot clear priority by omitting the field (`updateTask` passes updates
verbatim and throws on empty), so a clear would silently diverge while the
response claimed success — resolved by sending `{"priority": null}` explicitly
(confirmed by web research 2026-08-30); (3) `orderBy` depends on the unshipped
parent plan, so the handler must read it defensively. Mitigations: no new seam
(both roots already wire the service accessors); honest `trackerSync` enum
without an `"unavailable"` value that detects nothing; defensive
`getOrderByMode?.()` call; both-hosts write-back verified by hand since
`standalone-parity:check` does not cover it.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — accept `priority` beside `starred`

`_handleSetPlanPriority` (`:7077`) gains an optional `priority`. `starred` stays
optional. **At least one must be present** — a body with neither is 400, which is
the current behaviour for a missing `starred` (`:7093-7096`) and stays honest for
both.

```
PUT /kanban/plans/priority
{ "planId": "…", "priority": "urgent" }        → level only
{ "planId": "…", "starred": true }             → star only (unchanged)
{ "planId": "…", "starred": true, "priority": 1 }  → both, one request
```

**Validation ladder**, modelled on the star's (`:7090-7116`) and for the same
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

Reuse unchanged from the star arm: `planId` / `sessionId` resolution (`:7084`,
`:7126-7127`), and keying the write to `record.workspaceId` rather than the
server's (`:7140-7141`) — the reported-but-unwritten trap. Priority has identical
exposure.

**Response** — extended, with fields that exist to stop the endpoint lying
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
  the screen. Read via `db.getOrderByMode?.(wsId) ?? 'manual'` — defensive
  because the parent plan that adds `getOrderByMode` is unshipped.
- **`trackerSync`** — `"linear"` / `"clickup"` (written), `"none"` (card is
  local, nothing to write), `"failed"` (attempted, tracker rejected — the DB
  write stands, last-write-wins). There is no `"unavailable"` value: with the
  seam removed (see the Superseded callout in Problem Analysis), there is no
  "nobody wired this" failure mode to detect. The service accessor returning null
  (host unconfigured) is reported as `"none"`, not a wiring defect — a host with
  no tracker configured has nothing to write, which is the truth.

### 2. Tracker write-back — direct service call, no new seam

> **Superseded:** A `notifyPriorityChanged?: (planId: string, priority: number | null) => Promise<'linear' | 'clickup' | 'none' | 'failed'>` seam on `LocalApiServerOptions`, wired in both composition roots next to `getKanbanDatabase`.
> **Reason:** The seam recreates the "never-wired = working" hazard the plan's own Problem Analysis names. Both roots already wire `getLinearService` / `getClickUpService` (extension `TaskViewerProvider.ts:3732-3733`; standalone `bootstrap.ts:3001-3002`, services at `:530-531`), and `LocalApiServer` already calls those accessors directly from 15+ route handlers. A seam also forces a second record lookup (the root must re-resolve the card to find its tracker ID, since the signature carries only `planId, priority`) for data the handler already holds.
> **Replaced with:** Inside `_handleSetPlanPriority`, after the DB write, resolve the tracker from the record the handler already loaded (`record.linearIssueId` / `record.clickupTaskId`, present on `KanbanPlanRecord` and used elsewhere at `TaskViewerProvider.ts:5919-5920`):

```ts
// After db.setCardPriority(record.planId, wsId, priority) succeeds:
let trackerSync: 'linear' | 'clickup' | 'none' | 'failed' = 'none';
const linear = this._options.getLinearService();
const clickup = this._options.getClickUpService();
try {
    if (record.linearIssueId && linear) {
        await linear.updateIssuePriority(record.linearIssueId, priority ?? 0); // NULL → 0
        trackerSync = 'linear';
    } else if (record.clickupTaskId && clickup) {
        // ClickUp API v2 accepts {"priority": null} to clear (confirmed
        // 2026-08-30). Omitting the field does NOT clear — updateTask passes
        // updates verbatim and throws on empty, so an explicit null is required.
        await clickup.updateTask(record.clickupTaskId, { priority: priority ?? null });
        trackerSync = 'clickup';
    }
} catch (err) {
    console.error('[LocalApiServer] priority tracker write-back failed:', err);
    trackerSync = 'failed';
}
```

**NULL on write-back.** Linear has no null — write `0`, which
`updateIssuePriority` accepts (`:1228` validates 0–4). This is not lossy under
the resolved decision: 0 is exactly what Linear means by no priority, and the
return trip collapses it back to NULL, so the round-trip is stable.

**ClickUp clear.** `updateTask` (`:1525`) passes `updates` verbatim to
`httpRequest('PUT', …)` and throws on an empty updates object (`:1550-1552`).
Omitting `priority` does NOT clear it — ClickUp keeps its old value while the DB
goes NULL, and the response would claim `trackerSync: "clickup"` for a write that
did not happen. Web research (2026-08-30) confirmed ClickUp API v2 accepts
`{"priority": null}` to clear priority, so the write-back sends
`{ priority: priority ?? null }` — an explicit null, not an omission. `0` and
`""` are rejected by the ClickUp API (the research confirmed `0` returns 400 or
is silently ignored, and `""` is a type mismatch), but the validation ladder
already rejects both at 400 before they reach the write-back, so they never hit
the tracker. The clear path is now a real write, not an `"unsupported"` report.

**No `updateTask` guard to tighten.** The original plan said "check
`updateTask`'s guard anyway — if it guards with `if (priority)` like
`createTask` does (`:1457`), tighten it to `if (priority !== undefined)`."
`updateTask` has no such guard — it passes `updates` verbatim. The `if
(priority)` guard is in `createTask` only, which this endpoint never calls.
Levels 1–4 are truthy and pass through `updateTask` cleanly. No change to
`updateTask` is needed for the set path; the clear path is the only ClickUp
hazard, handled above.

### 3. `.agents/skills/switchboard-orchestration/SKILL.md` — document the level

Extend the star's row at `:104` and its `curl` example at `:119`. State plainly:

- the four labels, and that `null` / `"none"` / `"clear"` / `0` all mean the
  one no-priority state;
- the star and the level are different things — the star directs, the level
  describes; starring is not "priority 1";
- **check `orderBy`** before telling a user the board has been re-prioritised;
- **check `trackerSync`** before telling a user Linear or ClickUp was updated —
  `"none"` means the card has no tracker link (local card), `"failed"` means the
  tracker rejected the write (the DB still changed);
- the standing advisory: do not set priority unless the user asked for it.

### 4. Catalog

`npm run catalog:generate` (`package.json:956`); `catalog:check` (`:957`) is the
gate. The route already exists, so this is a payload change — confirm the catalog
records the new response fields rather than assuming a same-path route needs no
regeneration.

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
   - `trackerSync` is `"none"` when the card has no tracker link, `"failed"` when
     the service call throws, and the DB write still stands;
   - a ClickUp clear (priority null) sends `{ priority: null }` to `updateTask`
     (not an omission), and `trackerSync` is `"clickup"`;
   - `orderBy` reflects the `config` value, including its `'manual'` default when
     `getOrderByMode` is absent (defensive `?.` path).
2. **Tracker write-back unit test** — a fake sync service asserting Urgent → `1`
   for Linear and for ClickUp, and NULL → `0` for Linear / `{ priority: null }`
   for ClickUp. Add the Linear round-trip: NULL → write 0 → read 0 → NULL,
   asserting the card does not oscillate between states across a sync poll.
3. **Both hosts, by hand** — set a level under the extension host and under the
   standalone host, and assert `trackerSync` is `"linear"` or `"clickup"` (not
   `"none"` due to a missing service) in either. `npm run
   standalone-parity:check` is scoped to the browser read-back path and would
   pass with the service accessor returning null in either root, so it cannot be
   the evidence here.
4. **`npm run catalog:check`** passes.

### Automated Tests

Covered by items 1–2 above (extend `plan-priority-endpoint.test.js`; add a
tracker write-back unit test with a fake sync service). The endpoint test loads
compiled output (`out/services/LocalApiServer.js`), so a compile is required to
run it — recorded here, not run in this pass per session directives.

### Goal Invariants

- An agent can set a card's priority in one request, using the label a human
  would use.
- No input is silently coerced: every value either means one thing or is
  rejected.
- There is one no-priority state end to end: an inbound `0`, `"none"`, or
  `null` all land as NULL, and no path writes 0 into `plans.priority`.
- A response never claims a tracker write that did not happen, and never hides
  that this host cannot make one (`"none"` for a local card; `"failed"` for a
  rejected write).
- A response never implies work was re-sequenced when the board's sort mode
  means it was not.
- The star's existing contract is unchanged.
- No new `LocalApiServerOptions` seam is introduced — the write-back uses the
  already-wired `getLinearService` / `getClickUpService` accessors, so there is
  no "never wired" failure mode to detect.
