# Agents can set a column's card order over HTTP, not just star cards

## Goal

Give an agent one write path that says *"this column runs in this order"* — so an
agent can read the board, decide the sequence, and persist it, the same way a
human expresses the same intent by dragging cards.

> **Scope correction (2026-08-27).** This plan was first written as *"agents
> arrange cards into a roadmap"*. That title overclaimed. A roadmap is not a sort
> order — it is a set of long-term targets that work is arranged to meet, the way
> Linear does project milestones. Cross-column, dated, and spanning months. That
> feature is `milestones-long-term-targets-on-the-board.md`, and it needs its own
> state; no ordering of a column produces it.
>
> What is left here is still worth building on its own merit: an agent can only
> express order by dragging today, and cannot drag. This is a **within-column
> ordering endpoint**, nothing more, and the two plans are independent.

The star (`PUT /kanban/plans/priority`) already lets an agent say *"this one
first"*. It cannot express a sequence. This plan adds the sequence.

### Problem Analysis

**The ordering state exists and is complete; only the agent-facing write is
missing.** V63 shipped `plans.priority_starred`, `plans.column_order`, and (from
V60) `plans.queue_position`, resolved by one shared comparator
`compareByPrecedence` (`kanbanOrdering.ts:69`) that the display sort, the queue
pop, and the planner fan-out all read. Nothing new needs to be stored.

**But the only way to write an order is to drag a card.** `kanban.html`'s drop
handler posts `reorderQueue` (STAGING, `:9930`) or `reorderColumn` (everything
else, `:10005`) → `KanbanProvider.ts:12529` / `:12537` → `reorderQueue()`
`:8528` / `reorderColumn()` `:8576` → `db.setQueuePositions` /
`db.setColumnOrders` (`KanbanDatabase.ts:10431`). There is no REST route. An
agent can read the order (`GET /kanban/board` returns `priorityStarred`,
`columnOrder`, `queuePosition`, `columnEnteredAt` — `PLAN_COLUMNS` at
`KanbanDatabase.ts:1020`, mapper `:10945`) and cannot write it.

**The generic verb rail is technically reachable and is not an answer.** Both
verbs are in `KANBAN_VERBS` (`src/generated/verbAllowlist.ts:7`), so `POST
/kanban/verb/reorderColumn` dispatches. Four reasons that is not the path an
agent should be told to use — and the same four reasons the star got its own
route rather than being left on the rail (`plan-priority-endpoint.test.js:6`):

1. **No payload validation.** `_handleKanbanVerb` strips `type` and forwards the
   body unvalidated; the rail documents this as owed work
   (`LocalApiServer.ts:4320`). A wrong field name returns `{success:true}` having
   written nothing — the exact silent-trap class this repo treats as a bug.
2. **A partial list corrupts the column, by design.** `setColumnOrders` assigns
   1..N to *the ids given* and leaves every other card's `column_order` alone;
   the docstring (`KanbanDatabase.ts:10420`) explicitly accepts the resulting
   duplicate positions, tie-broken by `column_entered_at DESC`. That is sound
   for a drag (the webview always sends the full column) and unsound for an
   agent, which has no such guarantee. So "move card X up one" is not
   expressible: only whole-column rewrites are safe, and nothing enforces
   wholeness.
3. **`reorderColumn` never checks the ids share one non-STAGING column.** Its
   docstring says STAGING is excluded; the code (`KanbanProvider.ts:8576`) only
   resolves ids and writes 1..N. A cross-column list writes meaningless
   per-column numbers and answers 200.
4. **The caller has to know which field applies.** STAGING is `queue_position`,
   everything else is `column_order`. That is internal precedence knowledge
   (`kanbanOrdering.ts:1-67`), not something an agent should carry.

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

- **Anything cross-column, including a roadmap.** `column_order` is per-column
  and is deliberately cleared when a card changes column (`clearColumnOrder`,
  `KanbanDatabase.ts:10412` — "the number is per-column, so it must not
  travel"). A board-wide sequence has nowhere to live and would need its own
  state, which is exactly what
  `milestones-long-term-targets-on-the-board.md` adds. Sequencing work *across*
  stages is what features, `/kanban/dependencies`, and milestones express.
- **A numeric priority level (Urgent/High/Normal/Low).** That field, its
  migration, and its Linear/ClickUp mapping are already planned in
  `priority-as-a-native-field-and-a-board-wide-order-by.md`. Ordering is a
  separate axis and ships independently. (Note for whoever picks that plan up:
  its Proposed Changes §4 touches `LocalApiServer` only for the queue pop and
  the team queue, so it ships no agent-reachable priority write either. Same
  gap, different field.)
- **Changing precedence.** Stars still outrank manual order outside STAGING
  (`kanbanOrdering.ts:77-81`). This plan reports that interaction rather than
  altering it.
- **A confirm gate.** Per project rule, none — anywhere.

## Metadata

**Complexity:** 5
**Tags:** backend, api, feature, reliability

## User Review Required

Yes — three design decisions benefit from a human eye before implementation:

1. **The two-shape API** (Shape A whole-column authoritative + Shape B single-card
   nudge). Both shapes converge on one writer. If the user wants only one shape
   (simpler surface, or only Shape A for strict whole-column semantics), say so
   before coding.
2. **The 409-on-stale-set concurrency posture.** A stale set is rejected with the
   current order rather than half-applied. This is deliberate — it forces the
   agent to re-read and re-send. If the user prefers last-writer-wins (no 409,
   just overwrite), that is a different contract and should be chosen
   explicitly.
3. **The `reorderColumn` invariant enforcement** (§2). This changes behaviour for
   any non-webview caller of `reorderColumn`: a cross-column list is now refused
   where it was silently accepted. The webview is unaffected (it always sends
   same-column). If any other caller relies on the old silent-accept behaviour,
   surface it now.

## Complexity Audit

### Routine

- Adding one HTTP route to `LocalApiServer.ts`, modelled on the existing
  `PUT /kanban/plans/priority` handler (`:7076`/`:8199`). Same auth, same
  `_resolveDbForRoot`, same response pattern.
- Catalog regeneration (`npm run catalog:generate`) — mechanical, existing
  script.
- Documentation rows in `switchboard-orchestration/SKILL.md` — prose beside the
  existing star row (`:104`).
- No migration (V63 state already shipped and migrated).

### Complex / Risky

- **Set-equality concurrency guard** — the supplied set must equal the column's
  current set, or 409. This is the core safety mechanism; getting it wrong means
  either silent overwrites (too loose) or spurious 409s (too tight). The
  comparison must account for ids that resolve via `getPlanBySessionId` alias.
- **Workspace-scoping on a shared/cloud board** — `getPlanByPlanId` and
  `getPlanBySessionId` are unscoped; the UPDATE is `WHERE plan_id = ? AND
  workspace_id = ?`; `_persistedUpdate` (`KanbanDatabase.ts:9784`) reports
  success on zero rows changed. The endpoint must key the write to the resolved
  row's `workspaceId`, not the server's own — the exact trap the star endpoint
  documents at `:7133-7139`.
- **`reorderColumn` invariant enforcement** — adding a same-column + same-workspace
  assertion to an existing method that the webview's drop handler calls. Must
  not break the webview path.
- **Shape B server-side read** — building the current column order with
  `compareByPrecedence` requires a full-column read (all cards' `priorityStarred`,
  `columnOrder`/`queuePosition`, `columnEnteredAt`) for every nudge. O(column
  size) per request; negligible for typical columns but worth documenting.
- **Response honesty** — `starredPlanIds` must be included because a starred card
  sorts ahead of position 1 regardless of manual order. NULL-positioned cards
  (just arrived, not part of any arrangement) sort at the top per
  `kanbanOrdering.ts:104` and must be included in the response with `position:
  null` so the agent reports an order the board actually shows.

## Edge-Case & Dependency Audit

### Race Conditions

- **Human drag between agent GET and POST (Shape A).** A card arrives or leaves
  the column between the agent's read and write. The set-equality check catches
  this: the supplied set no longer equals the current set → 409 with the current
  order. The agent re-reads and re-sends. **This guards against membership
  drift, not concurrent reorder** — if two agents POST different orders of the
  same membership set, the second agent's set still matches and overwrites the
  first. This is last-writer-wins for concurrent reorder, by design (a column
  version counter would require new state + migration, which this plan
  avoids). Document this scope explicitly.
- **Human drag during Shape B.** The server reads the column, applies the move,
  and writes — all within one request handler. A human drag between the
  server's read and the server's write is last-writer-wins (the server's write
  overwrites the drag). This is the same exposure the webview's drop handler
  has (no locking), and the 5-second poll means the human sees the result
  within one cycle. Acceptable for the threat model (agent nudges are
  low-frequency).
- **Auto-import between GET and POST.** A plan file watcher imports a new plan
  into the column. Shape A's set-equality check catches it (set changed) → 409.
  Shape B is unaffected (the new card is NULL-positioned, sorts at top, the
  nudge writes the full list including it).

### Security

- **Auth.** `_checkAuth(req, true)` — same as the star endpoint. No new auth
  surface.
- **Workspace scoping.** On a shared/cloud board holding multiple workspaces,
  unscoped lookups (`getPlanByPlanId`) can resolve a row from a different
  workspace. The write must be keyed to the resolved row's `workspaceId`, and
  the endpoint must reject (409) if resolved rows span more than one
  `workspaceId`. This is the star endpoint's regression ported — see
  `LocalApiServer.ts:7133-7139`.
- **No injection surface.** Column name is validated against the known column
  set (not interpolated into SQL). Plan ids are parameterised.

### Side Effects

- **Board refresh.** The DB-direct endpoint writes via `setColumnOrders` /
  `setQueuePositions`, which call `_persist()` but do NOT call
  `_refreshBoard`. The webview polls every 5 seconds
  (`kanbanPollTimer = setInterval(pollKanbanPanes, 5000)` in `kanban.html`),
  so the order change reflects within one poll cycle — the same mechanism the
  shipped star endpoint relies on. No new refresh mechanism is needed.
- **`reorderColumn` behaviour change.** §2 adds a same-column + same-workspace
  assertion. The webview's drop handler always satisfies this (same-column
  drops only). Any non-webview caller (e.g. the verb rail) that previously sent
  a cross-column list and got 200 will now get a refusal. This is the intended
  fix, not a regression.

### Dependencies & Conflicts

- **`milestones-long-term-targets-on-the-board.md`** — independent. This plan
  is within-column ordering; milestones are cross-column long-term targets. No
  shared state.
- **`priority-as-a-native-field-and-a-board-wide-order-by.md`** — independent
  axis. That plan adds a numeric priority field; this plan adds ordering. Both
  write `LocalApiServer` but to different routes/state. No conflict unless both
  touch `compareByPrecedence` simultaneously (they don't — that plan changes
  the field set the comparator reads, this plan adds a write path to fields the
  comparator already reads).
- **`reorderColumn` / `reorderQueue`** — §2 modifies `reorderColumn`. No other
  plan in flight is known to touch it.

## Dependencies

None — no session dependencies. The two related plans
(`milestones-long-term-targets-on-the-board.md`,
`priority-as-a-native-field-and-a-board-wide-order-by.md`) are independent and
listed under Dependencies & Conflicts above.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the set-equality guard catches membership drift
but not concurrent reorder — last-writer-wins for two agents arranging the same
column; (2) the §2 `reorderColumn` fix must check workspace as well as column, or
it closes one hole and opens a cross-workspace one; (3) the response must include
NULL-positioned cards (not just positioned ones) or the agent reports an order
the board does not show. Mitigations: qualify the concurrency claim in docs, add
workspace-scoping to §2's assertion, include NULL cards in the response with
`position: null`, and document that `allowPartial` is for deliberate subset
rewrites (not single-card moves — Shape B handles those).

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — one route, two shapes, one write

Add `PUT /kanban/plans/order`, routed beside its sibling at `:8199` and handled
by `_handleSetPlanOrder`. It joins the **DB-direct** family
(`/kanban/plans/priority`, `/project`, `/complexity`): `_checkAuth(req, true)`,
`_resolveDbForRoot(body.workspaceRoot)`, no provider dependency — so it works
headlessly and identically under both hosts.

**Shape A — the whole column (authoritative).**

```
PUT /kanban/plans/order
{ "column": "CREATED", "orderedPlanIds": ["a", "b", "c"], "workspaceRoot": "..." }
```

*"This column, in this order."* Every id must resolve (`getPlanByPlanId`, then
`getPlanBySessionId` as an alias, matching `:7126-7127`) and must currently sit in
`column`. The supplied **set** must equal the column's current set — if a card
arrived or left since the agent read the board, answer **409** with the current
order rather than half-applying a stale ordering. This is the membership-drift
guard, and it needs no new state: the set comparison *is* the version check.

> **Superseded:** "This is the concurrency guard, and it needs no new state: the
> set comparison *is* the version check."
> **Reason:** The set-equality check guards against membership drift (a card
> arriving or leaving), not against concurrent reorder (two agents writing
> different orders of the same membership set). Calling it "the concurrency
> guard" without qualification overclaims — a second agent's set still matches
> after the first writes, so the second overwrites silently.
> **Replaced with:** This is the **membership-drift guard**. It catches a card
> arriving or leaving between the agent's read and write. Concurrent reorders
> (two agents, same membership, different orders) are last-writer-wins — a
> column version counter would close that but requires new state + migration,
> which this plan deliberately avoids. Document this scope in the route's
> docstring and the agent-facing SKILL.md.

`allowPartial: true` opts out of the set check for a deliberate subset rewrite,
and is the only way to reach `setColumnOrders`' duplicate-position behaviour on
purpose. **`allowPartial` is for deliberate subset rewrites, not single-card
moves** — for "move card X up one", use Shape B, which writes a clean full list
with no duplicates.

**Shape B — the nudge (no caller-side read required).**

```
{ "planId": "a", "position": "top" | "bottom" | "before" | "after", "relativeTo": "b" }
```

The server reads the card's column, builds the current order with
`compareByPrecedence` (the same comparator the screen uses, so "top" means what
the user sees), applies the single move, and hands the resulting full list to
the same internal writer as Shape A. `before`/`after` require `relativeTo` in
the same column — 400 otherwise. This is the shape an agent should reach for
when the user says "bump this up".

**Cost note:** Shape B performs a full-column read server-side (every card's
`priorityStarred`, `columnOrder`/`queuePosition`, `columnEnteredAt`) to compute
the current order before applying the move. O(column size) per request —
negligible for typical columns (~20 cards), but an agent nudging 5 cards in a
row does 5 full-column reads. This is the same cost as the webview's drop
handler and is acceptable for the agent's low-frequency write pattern.

**Both shapes converge on one private method** — resolve → validate → derive
field from column (`STAGING` → `setQueuePositions`, else `setColumnOrders`) →
write. The agent never names the field.

**Response** — enough for the agent to report honestly:

```json
{ "success": true, "column": "CREATED", "field": "column_order",
  "order": [{ "planId": "a", "position": 1, "starred": false }, ...,
            { "planId": "z", "position": null, "starred": false }],
  "starredPlanIds": ["c"] }
```

`starredPlanIds` is not decoration. A starred card in the column sorts ahead of
position 1 regardless of the manual order (`kanbanOrdering.ts:77-81`), so an agent
that reports "1, 2, 3" without it is describing an order the board will not
show. Callers should surface it: *"ordered 1–5; C runs first because it's
starred."*

**NULL-positioned cards must appear in the response.** A card that just arrived
in the column (no `column_order` yet) sorts at the TOP per
`kanbanOrdering.ts:104` (`return oaNull ? -1 : 1` for non-STAGING). The `order`
array must include these cards with `"position": null` so the agent reports the
complete order the board shows — not just the cards it positioned. An agent that
omits them reports "ordered 1–5" while the board shows a NULL card above
position 1.

**Workspace scoping.** Key the write to `record.workspaceId`, not the server's
own id — `getPlanByPlanId` is unscoped while the UPDATE is `WHERE plan_id = ?
AND workspace_id = ?` and `_persistedUpdate` (`KanbanDatabase.ts:9784`) reports
success on zero rows changed. This is the reported-but-unwritten trap the star
endpoint documents at `:7133-7139`; ordering has the identical exposure and
must copy the fix. Reject (**409**) if the resolved rows span more than one
`workspaceId`.

**Status ladder.** 400 malformed / unknown `position` / missing `relativeTo` /
empty list / unknown column · 404 an id resolves to nothing · 409 stale set,
cross-column ids, or mixed workspaces · 503 no DB · 500 write failed.

### 2. `src/services/KanbanProvider.ts` — close the same-column AND same-workspace hole

`reorderColumn` (`:8576`) gains the same-column assertion its docstring already
claims: resolve the ids, read their columns, and refuse a list spanning more
than one column (or containing STAGING) instead of writing per-column numbers
that mean nothing. The drop handler always satisfies this, so the webview is
unaffected; what changes is that the invariant becomes enforced rather than
assumed — which is the precondition for the rail staying reachable at all.

> **Superseded:** §2 as originally written only added a same-column assertion to
> `reorderColumn`.
> **Reason:** `reorderColumn` resolves ids via `getPlanByPlanId` then
> `getPlanBySessionId` — both unscoped. On a shared/cloud board with multiple
> workspaces, ids from workspace B resolve to B's records, the same-column check
> passes (all in B's column), but the write keys to workspace A's
> `workspaceId` (from `db.getWorkspaceId()`). Closing the column hole without
> closing the workspace hole opens a cross-workspace write path.
> **Replaced with:** §2's assertion must check **both** column and workspace:
> resolve the ids, read their columns AND their `workspaceId`, and refuse if the
> list spans more than one column, contains STAGING, OR spans more than one
> `workspaceId`. This mirrors the §1 endpoint's workspace-scoping (reject 409 on
> mixed workspaces) and closes both holes in one assertion.

Leave `reorderQueue` alone: STAGING membership is already implied by
`queue_position`.

### 3. `.agents/skills/switchboard-orchestration/SKILL.md` — tell agents it exists

Add rows beside the star at `:104`, with a `curl` example matching the style at
`:119`. An endpoint no agent knows about is not a capability. Document, plainly:

- ordering is **per column**;
- a star jumps the order — check `starredPlanIds`;
- NULL-positioned cards (just arrived) sort at the top — check `position: null`
  entries in the response;
- Shape B when moving one card, Shape A when laying out a whole column;
- `allowPartial: true` is for deliberate subset rewrites, not single-card moves
  (use Shape B for those);
- a 409 means the board moved: re-read and re-send, never retry blind;
- the set-equality guard catches membership drift (a card arrived/left), not
  concurrent reorder — two agents writing the same column are
  last-writer-wins.

### 4. Catalog and allowlist

Run `npm run catalog:generate` (`package.json:956`) so `protocol-catalog.json`
lists the route; `npm run catalog:check` (`package.json:957`) is the gate. No
verb is added, so `src/generated/verbAllowlist.ts` is unchanged. **Verify the
only catalog diff is the new route entry** — if `verb-allowlist` changed,
investigate before committing (the generator is deterministic, but a surprise
diff means something else drifted).

### Migration

**None.** No new columns, no new files, no settings. The endpoint writes V63
state that has shipped and is already migrated (`KanbanDatabase.ts:627-628`,
`:8767`). Nothing an older install holds is read differently.

### Host parity (extension + standalone)

The route lives in `LocalApiServer`, which both composition roots construct, so
both answer it — but the seam it depends on is wired differently and the
difference must be stated rather than discovered:

- extension → `TaskViewerProvider.ts:3735`: `getKanbanDatabase: async (wsRoot?)
  => this._getKanbanDb(wsRoot || effectiveRoot)` honours the argument
  (multi-root).
- standalone → `bootstrap.ts:3009`: `getKanbanDatabase: async () => db` ignores
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
   - **NULL-positioned cards** (just arrived, no `column_order`) appear in the
     response with `position: null`.
2. **Extend `card-priority-and-column-order-contract.test.js`** with the
   source-text invariant its `:332` block establishes for the star: the order
   route must be a real arm, not rail-only.
3. **`reorderColumn` regression** — a cross-column id list is refused, a
   cross-workspace id list is refused, and the webview's same-column
   same-workspace drop still succeeds.
4. **Both hosts** — start the extension host and the standalone host, and run
   the same three requests (Shape A, Shape B, a 409) against each. This is a
   hand-run step, deliberately: `npm run standalone-parity:check` is scoped to
   the browser read-back path and would pass whether or not this works.
5. **`npm run catalog:check`** passes with the route catalogued, and the only
   diff from `catalog:generate` is the new route entry.

### Goal Invariants

- An agent can set a column's order in **one** request, with no prior read
  (Shape B) or one read (Shape A).
- No request can leave a column with duplicate positions unless the caller
  passed `allowPartial`.
- No request reports success for a write that did not land.
- A concurrent human drag that changes the column's membership produces a 409
  (not a silent overwrite).
- The order the agent sets is the order the board shows and every consumer acts
  on, because the write feeds the same two columns `compareByPrecedence` already
  reads. No second ordering input is created.
- The response includes every card in the column — positioned and
  NULL-positioned — so the agent reports the complete order the board displays.

## Outstanding Questions

- **[user]** Is last-writer-wins acceptable for concurrent agent reorders of the
  same column, or should a column version counter (new state + migration) be
  added to reject stale orders? — proceeding on the assumption that
  last-writer-wins is acceptable (the threat model is human-vs-agent, not
  agent-vs-agent, and a version counter would require migration that this plan
  deliberately avoids).

---

**Recommendation:** Complexity 5 → **Send to Coder**.
