# The Researcher Is a Team Seat, Not a Board Column

## Goal

Remove `RESEARCHER` from the board's column catalogue. The researcher **role**
stays exactly as it is — it is a team seat. What goes is the claim that research
is a delivery stage a card passes through.

## Problem analysis

### A column asserts a delivery stage, and research is not one

`src/services/agentConfig.ts` previously carried:

```ts
{ id: 'RESEARCHER', label: 'Researcher', role: 'researcher', order: 110,
  kind: 'review', source: 'built-in', dragDropMode: 'prompt' },
```

`kind: 'review'` and `dragDropMode: 'prompt'` declare a place a card **lands**:
you drag a card in, an agent takes delivery of it, the card waits there. Every
other role column means exactly that — `LEAD CODED`, `CODER CODED`,
`CODE REVIEWED` are custody handoffs.

Research is not custody. A research need is a **question raised about a card
that somebody else is still holding**, and the card does not move while the
question is answered — the planner keeps planning. Modelling it as a column
forces a card to leave the planner's hands to get an answer, which is backwards.

The companion feature `cf5537c5` (*A Research Request Is Queued Inside the Team,
and Answered Back to the Planner That Asked*) puts the research request against
the plan and returns the answer to the seat that asked, with the card never
moving. This plan removes the surface that contradicts it.

### The live host published it as enabled — corrected account

Asked directly (`GET /kanban/columns`, 2026-09-20):

```json
{"id":"RESEARCHER", ..., "enabled":true, "enabledSource":"config"}
```

while the board DB's `agents.visibleAgents` said `"researcher": false`.

**An earlier draft of this plan called that a lie. It was not, and the real
cause is worse.** `enabledSource: "config"` was truthful — it named the
machine-global file `~/.switchboard/integration-config.json`, which says
`researcher: true` and is the *correct, documented* home for this key
(`AGENT_GLOBAL_FILE_KEYS` in `stateConfigBridge.ts`). The DB row is a leftover:
`STATE_KEY_TO_CONFIG` maps `visibleAgents → agents.visibleAgents`, so the
state.json migration wrote the key to the DB while the integration-config
migration wrote it to the file. Two migrations, one key, two homes.

> **Superseded:** "The tag's genuine weakness is narrower than 'it lies': two
> different stores can both truthfully answer `'config'`, so it cannot identify
> which one won."
> **Reason:** False against the shipped code. `_resolveVisibleAgents`
> (`LocalApiServer.ts:11682`, landed 2026-09-03 in `505e6e92`) tags the source
> distinctly — `'config'` is the machine-global file, `'legacy-db-config'` is
> the pre-fold DB key, `'default'` is no config ever written, `'unknown'` is no
> store reachable. The two stores could never both answer `'config'`. Verified
> live on 2026-09-20: every role column reports `enabledSource: 'config'` and
> `enabled` matches the file's value.
> **Replaced with:** The `enabledSource` contract is already honest — no change
> needed. The residual risk it guards against (a read that cannot say which
> store answered) is covered by keeping those four tags distinct and asserting
> it in verification.

**What actually stalled the board** is the simplest available explanation, and
it is the one the operator gave before any of this was investigated: *a
researcher is a team seat, not a delivery stage.*

The machine-global file — the authoritative store — said `researcher: true`, so
the role was genuinely in play. `RESEARCHER` therefore sat in the pipeline at
order 110, between `PLAN REVIEWED` (100) and the coded lane, and advancing a card
out of a 359-card `PLAN REVIEWED` routed it there. The host's `_getNextColumnId`
skips role columns whose `visibleAgents[role] === false`, but the webview's
`getNextColumn` (`kanban.html:3822`) skips only **role-less** columns — and
`RESEARCHER` had a role and was visible. Nothing takes delivery in a researcher
column, so the cards stopped.

Both the host and the browser agreed on that route: `_getVisibleAgents`
delegates to `TaskViewerProvider.getVisibleAgents` (standalone sets the provider
at `bootstrap.ts:1825`), which reads the same file. **No resolver divergence was
involved** — two earlier drafts of this section claimed one, and both were wrong.
Removing the column (commit `5f519e9c`) was the entire fix.

### That endpoint does not filter at all — and that is deliberate

The `/kanban/columns` payload carries `builtIn` (10 entries — every member of
`DEFAULT_KANBAN_COLUMNS` post-removal), `custom` and `displayOnly`, and **no**
`visibleAgents` anywhere. `KanbanProvider._filterDynamicColumns` is applied on
the provider's own refresh paths (`KanbanProvider.ts:1682, 2767, 4625, 4871`)
and not on this endpoint — by design, per the comment at
`LocalApiServer.ts:12580`: "Tagged, not filtered: a disabled column can still
hold historical cards, and callers use this endpoint to translate storage ids
to labels." Filtering the catalogue would make a card in a hidden-but-occupied
column unlabelled — a regression, not a fix.

> **Superseded:** "`bootstrap.ts` already predicts this in its own words, as the
> reason `boardStructure` is declared false: *pushFullState publishes
> `updateColumns` from the CONSTANT DEFAULT_KANBAN_COLUMNS … so a saved custom
> column is written to the DB and never rendered.* Same divergence, opposite
> direction: the constant also publishes columns the config had switched off."
> **Reason:** The quoted comment at `bootstrap.ts:1385` is stale. `pushFullState`
> has delegated to `kanbanProvider.getFullStateMessages` since 2026-08-10
> (`fd6da162`), and that path applies `_filterDynamicColumns` at
> `KanbanProvider.ts:1682` before pushing `updateColumns`. The comment's `:334,
> :363` line references describe a hand-built literal that no longer exists.
> **Replaced with:** The standalone push path is already filtered; the stale
> `bootstrap.ts:1385` comment is itself a cleanup item (below), and the endpoint
> stays tagged-not-filtered.

### Hiding it by flag cannot work anyway

```ts
if (visibleAgents[col.role] !== false) return true;
return occupiedColumns.has(col.id);
```

A role-hidden column **reappears the moment one card sits in it**. That is
correct behaviour for a column that still exists — stranding cards in an
invisible column would be worse — but it means `researcher: false` is not a way
to remove the column. Only removing it is.

### It existed in more than one catalogue

- `src/webview/terminals.js` — `KANBAN_ROLE_ORDER_FALLBACK` carried
  `researcher: 110`, a static mirror used for the sidebar's **first paint**, with
  a contract test enforcing lockstep against `agentConfig.ts`.
- `src/webview/project.js` — `if (plan.column === 'RESEARCHER') return 'Copy Researcher Prompt';`

Both removed in `5f519e9c`; verified absent by grep on 2026-09-20.

## Metadata

**Tags:** refactor, bugfix, ui, api, test
**Complexity:** 3
**Project:** Orchestration
**Scope:** `src/services/agentConfig.ts`, `src/services/KanbanProvider.ts`,
`src/services/LocalApiServer.ts`, `src/standalone/bootstrap.ts`,
`src/webview/terminals.js`, `src/webview/agent-control.html`,
`src/test/batch-move-team-prompt-contract.test.js`,
`src/test/scheduled-jobs-and-connections.test.js`, and the column-lockstep
contract test. **Standalone only** for new wiring; the extension host already
carries its half of the migration (`extension.ts:732`).

## User Review Required

- **Decision made for you, veto if wrong:** `visibleAgents.researcher` is kept,
  with its meaning narrowed to "offer/spawn a Researcher seat" (role picker,
  terminals grid, researcher-role custom columns). Retiring it would remove
  Researcher from the ad-hoc spawn picker entirely — an absent key filters the
  role out, it does not default it in.
- **Scope boundary drawn, expand if wanted:** the webview's `getNextColumn`
  still walks into any rendered role column while the host skips hidden ones —
  the same stall shape survives for a hidden-but-occupied `TICKET UPDATER`.
  Deferred to a follow-up, not folded in here.
- **Change 4's approach was superseded** (see Proposed Changes): the endpoint
  intentionally tags rather than filters; the improve pass corrected the plan,
  not the code.

## Complexity Audit

### Routine
- Column deletion, migration entry, and webview-mirror removal: **already
  landed** in `5f519e9c` — verification only.
- Documenting the surviving meaning of `visibleAgents.researcher` (one comment,
  one webview description string).
- Correcting three stale comments and one stale test fixture.

### Complex / Risky
- The `getNextColumn` hidden-role-column divergence is a real latent bug, but
  fixing it is a behaviour change to the advance path and is deferred to a
  follow-up — deciding the boundary is the risky part, not the typing.
- Migration correctness depends on `migrateDeprecatedColumns` running at boot
  on **both** composition roots — verified wired in `bootstrap.ts:845` and
  `extension.ts:732`, but the wiring is the thing to keep honest.

## Edge-Case & Dependency Audit

**Race Conditions**
- `migrateDeprecatedColumns` runs once at boot on each host. A card written into
  `RESEARCHER` by an older host version between boot and restart is invisible
  (no catalogue column renders it) until the next boot's migration sweeps it.
  Bounded by restart; no timer-based re-run is warranted for a version-skew edge.
- The migration counts-then-updates in two statements; a concurrent write
  between them could move a card that changed column in between. Boot-time,
  single-host, single-writer — negligible.

**Security**
- None. No new input surface; the endpoint already existed and its auth/read
  path is unchanged.

**Side Effects**
- `/kanban/columns` consumers (`command.js:510`, `dock.js:402`) get a 10-entry
  catalogue with per-column `enabled`/`enabledSource` — unchanged contract.
- `RESEARCHER` remains in `columnToPromptRole` (`agentPromptBuilder.ts:2951`),
  `TaskViewerProvider._columnToRole` (:6446) and `_roleForKanbanColumn` (:6498)
  **deliberately** — a stranded or historical card must still resolve its
  prompt role. Not residue; do not "clean" it.
- `visibleAgents.researcher === false` hides the Researcher option from the
  terminals role picker and grid (`getPtyVisibleRoles` → `fetchVisibleRoles`;
  `GRID_BUILTIN_ROLES` includes `'researcher'`). This is the flag's surviving,
  intended meaning.
- `KanbanDatabase._resolveAgentForColumn` (:13915) still lists `'researcher'`
  in its default-hidden set — correct for a hypothetical custom
  `role: 'researcher'` column.

**Dependencies & Conflicts**
- Companion feature `cf5537c5` (queued research requests) is the reason this
  removal is safe — a research need has a home that is not a column.
- `terminal-sidebar-role-ordering-contract.test.js` enforces lockstep between
  `KANBAN_ROLE_ORDER_FALLBACK` and `DEFAULT_KANBAN_COLUMNS` — it already matches
  the reduced set; keep it un-weakened.
- `batch-move-team-prompt-contract.test.js:535-548` fixture carries the retired
  `RESEARCHER` column — functionally harmless (self-contained list) but it
  teaches the next reader a dead column is real; swap it for a live one.
- `standalone-kanban-fork-detector.test.js:49` keeps `RESEARCHER` in its
  column-id regex — correct: the detector should still catch a literal map that
  routes to the retired id.

## Constraints

**The ROLE stays.** `researcher` remains in `BuiltInAgentRole`, in `VALID_ROLES`,
in the Planning team's seat list, and in `agentPromptBuilder`'s researcher branch.
Nothing about spawning, prompting or pairing a researcher seat changes. This plan
removes a **stage**, not a seat — and a diff that touches the role is out of scope.

**`RESEARCHER` shipped, so migrate.** Cards may be sitting in it on installs that
are not this one (this board has zero). Import before deleting: move them,
stamped with a reason naming the retired column, and surface the count. Never
unlink a card from a column that is disappearing.

**A reported source must be the thing that decided.** `enabledSource` must name
what actually answered. Already satisfied by `_resolveVisibleAgents`'s four
distinct tags — the constraint stands as the verification bar, not new work.

**No confirmation dialogs.**

## Dependencies

- None (no `sess_` dependencies). Related, not blocking: feature `cf5537c5`
  (*A Research Request Is Queued Inside the Team, and Answered Back to the
  Planner That Asked*) provides the non-column home for research needs.

## Adversarial Synthesis

Key risks: implementing already-landed work as a no-op diff; "fixing" the
endpoint's deliberate tagged-not-filtered contract and breaking label
translation for hidden-but-occupied columns; and retiring `visibleAgents.researcher`,
which would silently remove the Researcher seat from the spawn picker.
Mitigations: this pass verified each change against source and the live host;
the endpoint's design comment and the flag's surviving consumers are now named
in the plan so the implementer cannot rediscover them wrong.

## Proposed Changes

### Landed in `5f519e9c` (2026-09-20) — verify, do not redo

#### `src/services/agentConfig.ts`
- **Context:** `DEFAULT_KANBAN_COLUMNS` carried `RESEARCHER` at order 110.
- **Landed:** entry removed; catalogue is 10 columns. `DEFAULT_VISIBLE_AGENTS.researcher`
  (:208) intentionally remains — see the flag decision below.

#### `src/services/KanbanDatabase.ts` + both composition roots
- **Context:** stranded cards must migrate, not unlink.
- **Landed:** `migrateDeprecatedColumns` (:3486-3528) now includes `RESEARCHER`
  in `deprecatedColumns`, moving cards to `PLAN REVIEWED` with a logged count —
  PLAN REVIEWED, not CREATED, because a card parked at a review-kind order-110
  column was already planned and CREATED would discard that. Wired in
  `bootstrap.ts:845-854` **and** `extension.ts:732` — the commit message records
  that it had previously been wired in the extension only (the composition-root
  trap again).
- **Edge cases:** idempotent; no-op boards log nothing; guards on workspace-id
  resolution with a loud warn.

#### `src/webview/terminals.js` + `src/webview/project.js`
- **Landed:** `researcher: 110` removed from `KANBAN_ROLE_ORDER_FALLBACK`
  (:10932-10940); `'Copy Researcher Prompt'` branch removed from `project.js`.
  Lockstep contract test matches the reduced set.

### `src/services/LocalApiServer.ts` — `/kanban/columns`

- **Context:** the plan's change 4 prescribed applying `_filterDynamicColumns`
  here so "one rule decides the column list".

> **Superseded:** Apply the same `_filterDynamicColumns` to the HTTP catalogue
> that the provider's refresh paths apply.
> **Reason:** The endpoint is deliberately tagged-not-filtered
> (`LocalApiServer.ts:12580`) — it is the label-translation catalogue, and a
> filtered list would leave cards in hidden-but-occupied columns unlabelled.
> The honesty the plan wanted (`enabledSource` naming the deciding store) is
> already implemented via `_resolveVisibleAgents`'s four distinct tags
> ('config' | 'legacy-db-config' | 'default' | 'unknown'), verified live
> 2026-09-20.
> **Replaced with:** No structural change. One stale comment: :3326-3330 says
> "RESEARCHER and TICKET UPDATER are never reached … (visibleAgents[role] ===
> false)" — RESEARCHER is now unreachable because the column does not exist,
> not because its flag is false. Update the comment so it names the real reason
> (catalogue absence) and keeps TICKET UPDATER's flag-driven skip accurate.

### `src/services/agentConfig.ts` + `src/webview/agent-control.html` — the flag's meaning

- **Context:** `visibleAgents.researcher` no longer gates a column. Its
  surviving consumers: the terminals-grid role picker and grid slots
  (`getPtyVisibleRoles`, `fetchVisibleRoles`, `GRID_BUILTIN_ROLES`), and
  `_canAssignRole` / `_resolveAgentForColumn` for a hypothetical custom
  researcher-role column.
- **Logic:** keep the flag; state the narrowed meaning where a reader will look
  — a comment on `DEFAULT_VISIBLE_AGENTS.researcher` and a description-string
  update on the Researcher row (`agent-control.html:3148-3149`) so "visible"
  reads as "offered as a seat", not "shown as a stage".
- **Edge cases:** do not remove the key from `DEFAULT_VISIBLE_AGENTS` — an
  absent key filters the role out of the picker entirely. Do not touch
  `sharedDefaults.js`'s `researcher` entries — the webview mirror tracks the
  flag's (kept) meaning.

### Stale-comment and fixture cleanup

- `src/test/scheduled-jobs-and-connections.test.js:202` — comment lists
  `RESEARCHER` among built-ins; drop it.
- `src/test/batch-move-team-prompt-contract.test.js:535-548` — fixture column
  list carries `RESEARCHER` at order 110; swap for a live role column (e.g.
  `CODE REVIEWED` ordering already present) or a generic `custom_agent_` column
  so the fixture stops teaching a dead stage.
- `src/standalone/bootstrap.ts:1385-1388` — comment claims `pushFullState`
  publishes `updateColumns` from the constant; it delegates to
  `getFullStateMessages` (filtered) since 2026-08-10. Correct the comment — it
  is the `boardStructure` capability's stated rationale, so the rewrite must
  re-derive (not delete) the reason `boardStructure` stays false: custom columns
  are written to the DB but the current render path must be re-measured before
  flipping the flag.
- `src/services/KanbanProvider.test.ts:218-232` — `_getNextColumnId('RESEARCHER')`
  tests are legitimate stranded-card coverage; keep.

## Verification Plan

*(Compilation and automated tests are written down but not executed in this
pass per session directive; they remain the implementer's gate.)*

### Automated Tests

- `RESEARCHER` appears in no column catalogue in `src/` — not `agentConfig.ts`,
  not the `terminals.js` mirror, not `project.js`. **Verified by grep
  2026-09-20.**
- **Asked of a running host**, `GET /kanban/columns` returns 10 built-ins and no
  `RESEARCHER`. **Verified live 2026-09-20** — this is the assertion that would
  have failed while every source-level check passed.
- Every column the endpoint reports as `enabled` names a source that, when read,
  agrees — and `enabledSource` values are confined to the four distinct tags.
  **Verified live:** role columns report `config`; `ACCEPTANCE TESTED` and
  `TICKET UPDATER` report `enabled: false, enabledSource: 'config'`, matching
  the file's `tester`/`ticket_updater: false`.
- A card seeded in `RESEARCHER` lands in `PLAN REVIEWED` after migration;
  running the migration twice changes nothing; no migrated card lands in
  `CREATED` (asserted directly — that outcome silently discards planning work).
- **The role survives:** a Planning team spawns its researcher seat, the seat
  receives the researcher prompt, `researcher` is a valid role, and the role
  picker offers Researcher iff `visibleAgents.researcher !== false`.
- The column-lockstep contract test still runs and matches the reduced set.

### Goal Invariants

- `DEFAULT_KANBAN_COLUMNS` contains no entry with `id === 'RESEARCHER'`
  (negative invariant — paired with the positive below).
- `columnToPromptRole('RESEARCHER')` still resolves to `'researcher'`, so a
  stranded card is never unrouteable.
- One rule decides the *rendered* column list (`_filterDynamicColumns`), and
  the one catalogue that publishes unfiltered does so deliberately, tagged, and
  says why in a comment.
- `visibleAgents.researcher` still gates the seat picker — assert by checking
  `getPtyVisibleRoles` honours the flag.
- No card is stranded in a column that no longer exists: migration coverage in
  both composition roots (`bootstrap.ts` and `extension.ts` both call
  `migrateDeprecatedColumns`).

### Manual

Open the board and confirm the Researcher column is gone from the kanban, the
column picker and the sidebar's first paint — including on a hard reload, which
is when the static mirror is what renders. Confirm the Researcher seat still
appears in the terminals role picker when `visibleAgents.researcher` is true.

## Resolved Assumptions

- Changes 1–3 (column deletion, migration, webview mirrors) landed in commit
  `5f519e9c` on 2026-09-20 and are verified in source.
- `GET /kanban/columns` on the live host returns 10 built-ins, no `RESEARCHER`,
  with per-store `enabledSource` tags — verified 2026-09-20.
- `enabledSource` has distinguished the machine-global file (`'config'`) from
  the legacy DB key (`'legacy-db-config'`) since `505e6e92` (2026-09-03).
- `visibleAgents.researcher`'s surviving consumers are enumerated in the
  Edge-Case audit — the flag is kept with narrowed meaning.
- `pushFullState` delegates to `getFullStateMessages` (filtered) — the
  `bootstrap.ts:1385` comment quoting constant publication is stale.

## Outstanding Questions

- **[user]** Fold the `getNextColumn` hidden-role-column divergence into this
  plan or defer it? The webview advance path (`kanban.html:3822`) skips only
  role-less columns; a hidden-but-occupied role column (`TICKET UPDATER` is the
  live candidate — default-hidden, order 9000, `dragDropMode: 'prompt'`) can
  still receive an advance the host's `_getNextColumnId` would skip — the same
  stall shape this plan just removed. — proceeding on the assumption that it is
  **deferred to a follow-up plan**: this plan's goal is the `RESEARCHER`
  catalogue entry, and the divergence deserves its own root-cause pass rather
  than a rider.

## Recommendation

**Send to Intern** (complexity 3 — verification, comment/doc corrections, one
fixture swap; the design decisions are already recorded above).

---

*Improve pass 2026-09-20: verified all claims against source and the live host.
Found changes 1–3 already landed in `5f519e9c` and the endpoint's honest-source
machinery already shipped (`505e6e92`); superseded change 4's "apply the filter"
approach because the endpoint is deliberately tagged-not-filtered. Answered the
flag question by grep: `visibleAgents.researcher` still gates the role picker
and researcher-role custom columns, so it is kept with its meaning narrowed and
documented. Remaining work is stale-comment/fixture cleanup plus verification;
the `getNextColumn` hidden-column divergence is flagged as a deferred follow-up.*
