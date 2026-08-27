# Agents can arrange cards into a roadmap over HTTP, not just star them

## Goal

Give an agent one write path that says *"this column runs in this order"* — so an
agent asked to lay out a roadmap can read the board, decide the sequence, and
persist it, the same way a human expresses the same intent by dragging cards.

The star (`PUT /kanban/plans/priority`) already lets an agent say *"this one
first"*. It cannot express a sequence. This plan adds the sequence.

### Problem Analysis

**The ordering state exists and is complete; only the agent-facing write is
missing.** V63 shipped `plans.priority_starred`, `plans.column_order`, and (from
V60) `plans.queue_position`, resolved by one shared comparator
`compareByPrecedence` (`kanbanOrdering.ts:74`) that the display sort, the queue
pop, and the planner fan-out all read. Nothing new needs to be stored.

**But the only way to write an order is to drag a card.** `kanban.html`'s drop
handler posts `reorderQueue` (STAGING) or `reorderColumn` (everything else) →
`KanbanProvider.ts:12531` / `:12544` → `reorderQueue()` `:8616` /
`reorderColumn()` `:8664` → `db.setQueuePositions` / `db.setColumnOrders`
(`KanbanDatabase.ts:10430`). There is no REST route. An agent can read the order
(`GET /kanban/board` returns `priorityStarred`, `columnOrder`, `queuePosition`,
`columnEnteredAt` — `PLAN_COLUMNS` at `KanbanDatabase.ts:1026`, mapper `:10901`)
and cannot write it.

**The generic verb rail is technically reachable and is not an answer.** Both
verbs are in `KANBAN_VERBS` (`verbAllowlist.ts:7`), so `POST
/kanban/verb/reorderColumn` dispatches. Four reasons that is not the path an
agent should be told to use — and the same four reasons the star got its own
route rather than being left on the rail (`plan-priority-endpoint.test.js:4`):

1. **No payload validation.** `_handleKanbanVerb` strips `type` and forwards the
   body unvalidated; the rail documents this as owed work
   (`LocalApiServer.ts:3847`). A wrong field name returns `{success:true}` having
   written nothing — the exact silent-trap class this repo treats as a bug.
2. **A partial list corrupts the column, by design.** `setColumnOrders` assigns
   1..N to *the ids given* and leaves every other card's `column_order` alone;
   the docstring (`KanbanDatabase.ts:10421`) explicitly accepts the resulting
   duplicate positions, tie-broken by `column_entered_at DESC`. That is sound
   for a drag (the webview always sends the full column) and unsound for an
   agent, which has no such guarantee. So "move card X up one" is not
   expressible: only whole-column rewrites are safe, and nothing enforces
   wholeness.
3. **`reorderColumn` never checks the ids share one non-STAGING column.** Its
   docstring says STAGING is excluded; the code (`KanbanProvider.ts:8664`) only
   resolves ids and writes 1..N. A cross-column list writes meaningless
   per-column numbers and answers 200.
4. **The caller has to know which field applies.** STAGING is `queue_position`,
   everything else is `column_order`. That is internal precedence knowledge
   (`kanbanOrdering.ts:1-50`), not something an agent should carry.

**And read-modify-write over the rail has no concurrency story.** An agent GETs
the board, computes an order, and POSTs the id list. A human drag, a card move,
or an auto-import between the GET and the POST is silently overwritten — and the
loser is the human, whose arrangement the whole V63 feature exists to preserve.

### Root Cause

The ordering write was built for one caller — the drop handler — and inherited
that caller's guarantees as unstated preconditions (full column, single column,
correct field). Exposing it to a second caller that cannot honour those
preconditions requires moving them from *assumed* to *enforced*.

### Non-goals

- **A cross-column roadmap.** `column_order` is per-column and is deliberately
  cleared when a card changes column (`clearColumnOrder`,
  `KanbanDatabase.ts:10412` — "the number is per-column, so it must not
  travel"). A board-wide sequence has nowhere to live and would need its own
  state. Sequencing work *across* stages is what features and
  `/kanban/dependencies` already express.
- **A numeric priority level (Urgent/High/Normal/Low).** That field, its
  migration, and its Linear/ClickUp mapping are already planned in
  `priority-as-a-native-field-and-a-board-wide-order-by.md`. Ordering is a
  separate axis and ships independently. (Note for whoever picks that plan up:
  its Proposed Changes §4 touches `LocalApiServer` only for the queue pop and
  the team queue, so it ships no agent-reachable priority write either. Same
  gap, different field.)
- **Changing precedence.** Stars still outrank manual order outside STAGING
  (`kanbanOrdering.ts:78-84`). This plan reports that interaction rather than
  altering it.
- **A confirm gate.** Per project rule, none — anywhere.

## Metadata

**Complexity:** 5
**Tags:** backend, api, feature, reliability

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — one route, two shapes, one write

Add `PUT /kanban/plans/order`, routed beside its sibling at `:7584` and handled
by `_handleSetPlanOrder`. It joins the **DB-direct** family
(`/kanban/plans/priority`, `/project`, `/complexity`): `_checkAuth(req, true)`,
`_resolveDbForRoot(body.workspaceRoot)`, no provider dependency — so it works
headlessly and identically under both hosts.

**Shape A — the roadmap (authoritative).**

```
PUT /kanban/plans/order
{ "column": "CREATED", "orderedPlanIds": ["a", "b", "c"], "workspaceRoot": "…" }
```

*"This column, in this order."* Every id must resolve (`getPlanByPlanId`, then
`getPlanBySessionId` as an alias, matching `:6538`) and must currently sit in
`column`. The supplied **set** must equal the column's current set — if a card
arrived or left since the agent read the board, answer **409** with the current
order rather than half-applying a stale roadmap. This is the concurrency guard,
and it needs no new state: the set comparison *is* the version check.

`allowPartial: true` opts out of the set check for a deliberate subset rewrite,
and is the only way to reach `setColumnOrders`' duplicate-position behaviour on
purpose.

**Shape B — the nudge (no read required).**

```
{ "planId": "a", "position": "top" | "bottom" | "before" | "after", "relativeTo": "b" }
```

The server reads the card's column, builds the current order with
`compareByPrecedence` (the same comparator the screen uses, so "top" means what
the user sees), applies the single move, and hands the resulting full list to
the same internal writer as Shape A. `before`/`after` require `relativeTo` in
the same column — 400 otherwise. This is the shape an agent should reach for
when the user says "bump this up".

**Both shapes converge on one private method** — resolve → validate → derive
field from column (`STAGING` → `setQueuePositions`, else `setColumnOrders`) →
write. The agent never names the field.

**Response** — enough for the agent to report honestly:

```json
{ "success": true, "column": "CREATED", "field": "column_order",
  "order": [{ "planId": "a", "position": 1, "starred": false }, …],
  "starredPlanIds": ["c"] }
```

`starredPlanIds` is not decoration. A starred card in the column sorts ahead of
position 1 regardless of the roadmap (`kanbanOrdering.ts:78-84`), so an agent
that reports "1, 2, 3" without it is describing an order the board will not
show. Callers should surface it: *"ordered 1–5; C runs first because it's
starred."*

**Workspace scoping.** Key the write to `record.workspaceId`, not the server's
own id — `getPlanByPlanId` is unscoped while the UPDATE is `WHERE plan_id = ?
AND workspace_id = ?` and `_persistedUpdate` reports success on zero rows
changed. This is the reported-but-unwritten trap the star endpoint documents at
`:6544-6551`; ordering has the identical exposure and must copy the fix. Reject
(**409**) if the resolved rows span more than one `workspaceId`.

**Status ladder.** 400 malformed / unknown `position` / missing `relativeTo` /
empty list / unknown column · 404 an id resolves to nothing · 409 stale set,
cross-column ids, or mixed workspaces · 503 no DB · 500 write failed.

### 2. `src/services/KanbanProvider.ts` — close the same-column hole

`reorderColumn` (`:8664`) gains the same-column assertion its docstring already
claims: resolve the ids, read their columns, and refuse a list spanning more
than one column (or containing STAGING) instead of writing per-column numbers
that mean nothing. The drop handler always satisfies this, so the webview is
unaffected; what changes is that the invariant becomes enforced rather than
assumed — which is the precondition for the rail staying reachable at all.

Leave `reorderQueue` alone: STAGING membership is already implied by
`queue_position`.

### 3. `.agents/skills/switchboard-orchestration/SKILL.md` — tell agents it exists

Add rows beside the star at `:104`, with a `curl` example matching the style at
`:119`. An endpoint no agent knows about is not a capability. Document, plainly:

- ordering is **per column**;
- a star jumps the order — check `starredPlanIds`;
- Shape B when moving one card, Shape A when laying out a whole column;
- a 409 means the board moved: re-read and re-send, never retry blind.

### 4. Catalog and allowlist

Run `npm run catalog:generate` (`package.json:942`) so `protocol-catalog.json`
lists the route; `npm run catalog:check` is the gate. No verb is added, so
`verbAllowlist.ts` is unchanged.

### Migration

**None.** No new columns, no new files, no settings. The endpoint writes V63
state that has shipped and is already migrated (`KanbanDatabase.ts:627-628`,
`:8767`). Nothing an older install holds is read differently.

### Host parity (extension + standalone)

The route lives in `LocalApiServer`, which both composition roots construct, so
both answer it — but the seam it depends on is wired differently and the
difference must be stated rather than discovered:

- extension → `TaskViewerProvider.ts:3714`: `getKanbanDatabase(wsRoot)` honours
  the argument (multi-root).
- standalone → `bootstrap.ts:2769`: `getKanbanDatabase: async () => db` ignores
  it and returns the single DB.

So `workspaceRoot` in the body is honoured under the extension and silently
ignored under standalone. Harmless there (one root by construction), but it is
the composition-root asymmetry class this project's rules single out, so: no new
seam is introduced by this plan, and verification runs the endpoint under **both**
roots rather than asserting parity from the shared route.

## Verification Plan

1. **New `src/test/plan-order-endpoint.test.js`**, modelled on
   `plan-priority-endpoint.test.js` — same fake-DB harness, which already
   reproduces the two properties that make this endpoint's honesty non-obvious
   (unscoped lookups, `_persistedUpdate` true on zero rows). Assert:
   - Shape A with the complete set → 1..N written in the given order.
   - Shape A missing one card in the column → **409**, and **zero writes**.
   - Shape A with `allowPartial: true` → writes the subset.
   - Shape B `top`/`bottom`/`before`/`after` → correct resulting full list, with
     no board read by the caller.
   - `before` without `relativeTo`, or `relativeTo` in another column → 400.
   - Ids spanning two columns → 409, zero writes.
   - A STAGING card → `setQueuePositions`, never `setColumnOrders`; a CREATED
     card → the reverse. Assert on which DB method was called.
   - Server workspace id ≠ the resolved row's → the write is keyed to the
     **row's** id (the star endpoint's regression, ported).
   - `starredPlanIds` lists the starred cards in the column.
2. **Extend `card-priority-and-column-order-contract.test.js`** with the
   source-text invariant its `:331` block establishes for the star: the order
   route must be a real arm, not rail-only.
3. **`reorderColumn` regression** — a cross-column id list is refused, and the
   webview's same-column drop still succeeds.
4. **Both hosts** — start the extension host and the standalone host, and run
   the same three requests (Shape A, Shape B, a 409) against each. This is a
   hand-run step, deliberately: `npm run standalone-parity:check` is scoped to
   the browser read-back path and would pass whether or not this works.
5. **`npm run catalog:check`** passes with the route catalogued.

### Goal Invariants

- An agent can set a column's order in **one** request, with no prior read
  (Shape B) or one read (Shape A).
- No request can leave a column with duplicate positions unless the caller
  passed `allowPartial`.
- No request reports success for a write that did not land.
- A concurrent human drag is never silently overwritten — it produces a 409.
- The order the agent sets is the order the board shows and every consumer acts
  on, because the write feeds the same two columns `compareByPrecedence` already
  reads. No second ordering input is created.
