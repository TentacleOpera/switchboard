# Staging is a filter, not a column — retire DISPATCH in favour of a per-plan staged stamp

## Goal

Make the Planned column **always show every plan in `PLAN REVIEWED`**, and turn the current `DISPATCH` view into a **STAGING** filter over a per-plan stamp: press *Staging* and the column narrows to the subset that is ready to code, press it again and you are back to the full list. No card ever changes column to be staged.

Retire `DISPATCH` as a stored column value. Staged-ness becomes `plans.staged_at`.

### Problem & background

**Staging a plan currently moves it out of the column it is displayed in.** `DISPATCH` is a real stored `kanban_column` value registered as a display mode of `PLAN REVIEWED` (`src/services/agentConfig.ts:150-153`), and the webview then spends ~20 sites folding it back into the Planned slot. The consequence a user sees is that staging a card **removes it from the Planned column**: `kanban.html:6407` and `:6496` both filter `card.column !== 'DISPATCH'` out of the default view. Six cards are in that state right now, invisible in Planned unless the toggle is pressed.

That is backwards. Staging is a *property* of a reviewed plan — "this one is ready to code" — not a place it goes. Encoding a property as a location costs a column value, a display-mode registry entry, a per-column mirror file, and a laundering pass at every site that reads a card's column.

### Root cause — a stored column that the UI pretends is not one

Because the stored value diverges from the displayed column, every query written against the *visible* column silently misses staged cards. This has already shipped as a bug once, in the sibling `BACKLOG` instance. From `KanbanProvider.ts:495-507`, documenting why `_visibleColumnCards` exists at all:

> *"...different column (e.g. BACKLOG). That divergence is exactly what made 'Advance All' on CREATED dispatch a BACKLOG feature's subtasks instead of the loose plans the user could actually see in the column."*

`_visibleColumnCards` is scar tissue from that bug. The same divergence is live for `DISPATCH`: `dispatchAnalyze` sources candidates at `:10367` via `_visibleColumnCards(workspaceRoot, 'PLAN REVIEWED')`, so already-staged plans are invisible to the analysis that staged them — it re-analyses a board it believes is empty. `sendDispatchToCoder` (`:10391-10396`) carries a written-out workaround for the same cause: `DISPATCH` is not in `DEFAULT_KANBAN_COLUMNS`, so `_getNextColumnId`'s ordered walk returns null and the target has to be resolved from `PLAN REVIEWED` by hand.

**A flag removes the whole class.** If a staged plan stays in `PLAN REVIEWED`, then every existing query over that column already sees it, the analysis pass needs no new awareness of anything, `_getNextColumnId` resolves normally, and the ~20 remapping sites delete.

### What this is not

* **Not a cross-project change.** Analysis and staging stay scoped to the board the user is looking at, exactly as `feature_plan_20260808120000_dispatch-analyze-candidate-set-scope-and-features.md` established. A plan staged on another project's board is *not* being coded by anyone and holds no claim on any file; it must never constrain the project in front of the user.
* **Not a `BACKLOG` change.** `BACKLOG`/`CREATED` keeps its current display-mode mechanism. Converting it is the same shape of work on 38 live cards and is deliberately out of scope here — do `DISPATCH` first, on the smaller and newer surface.

---

## Metadata
**Complexity:** 6
**Tags:** ui, backend, database, correctness, migration
**Project:** Browser Switchboard

---

## User Review Required

**None.** Five decisions made here:

* **A nullable timestamp, not a boolean.** `plans.staged_at TEXT DEFAULT NULL` matches the house pattern set by V58 (`last_liveness_at`) and V59 (`blocked_at`), and gives staging order for free — useful for "send the oldest staged first" and legible in reports. `NULL` means not staged.
* **`DISPATCH` becomes a legacy alias, not a deleted value.** It moves into `LEGACY_COLUMN_LABELS` with `legacyAliasOf: 'PLAN REVIEWED'`, following the precedent already set by `CODED → LEAD CODED`. It stays in `VALID_KANBAN_COLUMNS` so a row written by an older or cloud-synced machine is accepted and normalised rather than rejected.
* **Normalise on every read, not once at migration.** `kanban.db` is synced across machines (`KanbanDatabase.ts:6580-6590` handles external/cloud modification explicitly) and ~4,000 installs sit on older versions, so a `DISPATCH` row can appear *after* the migration has run. A one-shot `UPDATE` is necessary but not sufficient.
* **Button label is `STAGING`.** It reads `STAGING` in the default view and `PLANNED` when the filter is active, matching the existing toggle convention at `kanban.html:5617`.
* **No confirm gates.** The staging toggle and any clear-staging action fire immediately, per project rule — and `window.confirm()` is a silent no-op in a webview regardless.

---

## Complexity Audit
* **Score:** 6 / 10

### Routine
* One nullable column, one migration in the established V58/V59 shape.
* Two provider verbs change from "move card" to "stamp card".
* A view filter replacing a column filter in the webview.

### Complex / Risky
* **This is a migration against shipped state.** Six cards are in `DISPATCH` in this workspace alone; the value ships in released versions. Cards must land in `PLAN REVIEWED` *with `staged_at` set* — dumping them into an undifferentiated Planned column silently discards a decision the user made about which plans are ready.
* **Read-path normalisation is the load-bearing half.** The one-shot `UPDATE` handles the local DB. The alias handles every other writer — older versions, a second machine, a synced folder. Ship only the `UPDATE` and staged cards start vanishing again the first time a stale writer touches the DB.
* **~20 webview sites, and the risk is in what gets *deleted*.** Each remapping site becomes unnecessary, but a missed one leaves a `card.column === 'DISPATCH'` comparison that is now permanently false — a silently dead branch, not a compile error. Grep-driven, not memory-driven.
* **The drag-and-drop source-column resolution** (`:7402-7414`, `:7444-7447`, `:7519-7522`) currently derives a *DOM* column from a *stored* column. Simplification is real but this is the fiddliest area, and getting it wrong misfiles a dragged card.
* **Migration version collision.** The sibling write-set cache plan also claimed V60. This plan lands first and takes **V60**; that plan becomes **V61**.

---

## Edge-Case & Dependency Audit

### Race Conditions
* **A card is staged while the staging filter is open.** The card appears in the filtered view immediately; no reconciliation needed since nothing moved.
* **A card leaves `PLAN REVIEWED` while staged** (sent to a coder, or dragged back to `CREATED`). `staged_at` must be cleared on any transition out of `PLAN REVIEWED`, or the stamp resurfaces if the card ever returns and presents week-old staging as current.
* **Two hosts staging concurrently.** A single nullable column with last-write-wins is correct; there is no read-modify-write.
* **Migration runs while a `DISPATCH` row is being written by another machine.** Exactly why the alias exists — the row is accepted and normalised on the next read.

### Security
* None. No new privilege, no new external input, no new writer. One nullable column of workspace-local state.

### Side Effects
* **The Planned column gets longer** — it now shows staged cards too. That is the requested behaviour, and the count badge must include them (a badge that excludes staged cards would recreate the invisibility this plan removes).
* `kanban-state-dispatch.md` stops being written. A `kanban-state-staging.md`, derived from the stamp, replaces it so the mirror-reading sibling plan has a surface for staged-ness.
* `kanban-state-plan-reviewed.md` grows to include staged plans.

### Dependencies & Conflicts
* **`src/services/KanbanDatabase.ts`** — `SCHEMA_TABLES_SQL` (`:160`), migration constants (`:457`, `:472`), the runner (`:8309-8328`), `VALID_KANBAN_COLUMNS` (`:894`), the board grouping map (`:9030-9037`) and the per-column mirror writer (`:9066`, `:9116`). Migration head at HEAD is **V59** → this is **V60**. **Never edit a shipped `MIGRATION_Vnn_SQL` body**; add V60 only.
* **`src/services/agentConfig.ts`** — `DISPATCH` moves from `DISPLAY_MODE_COLUMNS` (`:150-153`) to `LEGACY_COLUMN_LABELS` (`:160`). Leave the `BACKLOG` entry alone.
* **`src/webview/kanban.html`** — ~20 sites (full list in change 4). Handlers go in its own inline script; it is a self-contained webview.
* **`src/webview/terminals.js`** — the kanban-pane column picker (`:3040-3075`), the card fetch (`:3448-3472`), `buildColumnList` (`:2457-2468`), `bodySig` (`:2694-2696`) and the empty-state string (`:3183`). **`feature_plan_20260807090200_terminals-kanban-pane-all-coded-aggregate-column.md` (staged for dispatch under feature `12d76fa7`) edits the same picker, the same `bodySig` and the same fetch path** to add `ALL CODED`. The two must serialise per the one-stream-per-file discipline, and whichever lands second adopts the first's synthetic-id and `bodySig` conventions rather than inventing a parallel one. That plan is further along — prefer letting it land first and following its shape.
* **`getBoardCards`** (`KanbanProvider.ts:10667+`) — must include `stagedAt` in the card payload for change 5 to be possible at all.
* **`src/services/KanbanProvider.ts`** — `sendToDispatch` (`:10327-10334`), `sendToPlanned` (`:10336-10343`), `dispatchAnalyze` (`:10350-10389`), `sendDispatchToCoder` (`:10391+`), `toggleDispatchView`, and the `_showingDispatch` field plumbed through `updateBoard` (`:1211`, `:2073`, `:3613`, `:3801`).
* **`src/test/kanban-auto-export.test.ts`** — `:78-81` asserts every `VALID_KANBAN_COLUMNS` entry has a mirror link, and `:416` asserts `resolveColumnLabel('DISPATCH')` returns `labelSource: 'display-mode'`. Both change: the label source becomes `legacy`, and the mirror set swaps `dispatch` for `staging`.
* **`.agents/skills/dispatch-analysis/SKILL.md`** — step 5 stops moving cards to a column and stamps instead. Shared with two siblings (`feature_plan_20260810173147_…board-mirror…` and the write-set cache plan); all three serialise on that file, this one first.
* **`feature_plan_20260811094500_dispatch-analysis-blind-to-already-staged-cards.md` is superseded by this plan** and should be deleted, not implemented. It works around the invisibility this plan removes.

---

## Dependencies
* No blocking plan dependencies; every touched surface exists at HEAD.
* Two siblings serialise **behind** this plan on `.agents/skills/dispatch-analysis/SKILL.md`, and the write-set cache plan must be renumbered to V61.
* Migration V60 is additive plus one scoped `UPDATE` over rows with `kanban_column = 'DISPATCH'`. No other row is touched.

---

## Adversarial Synthesis

Key risks: (1) **migrating the column without the stamp** — the six live `DISPATCH` cards land in Planned as ordinary reviewed plans and the user's staging decisions are silently gone, which is data loss dressed as a cleanup; (2) **shipping the `UPDATE` without the read-path alias** — a cloud-synced or older-version writer reintroduces `DISPATCH` rows and cards start disappearing from Planned again, with the migration already marked complete so it never re-runs; (3) **a missed remapping site** — a leftover `card.column === 'DISPATCH'` comparison is now permanently false and compiles clean, so the failure is a dead branch discovered by a user, not by a build; (4) **the count badge excluding staged cards** — reproduces the exact invisibility the plan exists to remove, on the one surface a user actually scans; (5) **scope creep into `BACKLOG`** — a 38-card migration and the `CREATED` column's whole toggle/Advance-All path riding along on a 6-card change; (6) **`staged_at` outliving the column** — a card sent to a coder and later moved back presents stale staging as current. Mitigations: migrate column and stamp in the same statement; move `DISPATCH` into `LEGACY_COLUMN_LABELS` so normalisation happens on every read rather than once; drive the webview edits from a grep of the ~20 sites with a test asserting no `'DISPATCH'` comparison survives outside the legacy alias; assert the badge counts staged cards; leave `BACKLOG` untouched and say so in the plan; clear `staged_at` on every transition out of `PLAN REVIEWED`.

---

## Proposed Changes

**Build order:** (1) schema + migration → (2) legacy alias and read normalisation → (3) provider verbs → (4) board webview filter and label → (5) terminals kanban-pane picker → (6) mirror + skill. Steps 1-2 must land together; a half-migrated DB is the one state with no correct reading.

### 1. V60 — `plans.staged_at`, and migrate the live `DISPATCH` cards

**Implementation:** add `staged_at TEXT DEFAULT NULL` to the `plans` definition in `SCHEMA_TABLES_SQL` (`:160`) and as `MIGRATION_V60_SQL`:

```sql
ALTER TABLE plans ADD COLUMN staged_at TEXT DEFAULT NULL;
UPDATE plans SET staged_at = COALESCE(staged_at, updated_at, created_at),
                 kanban_column = 'PLAN REVIEWED'
 WHERE kanban_column = 'DISPATCH';
CREATE INDEX IF NOT EXISTS idx_plans_staged ON plans(workspace_id, staged_at);
```

Register in the runner (`:8309-8328`) with the existing idempotent shape (`getMigrationVersion` → guarded `exec` in `try/catch` → `setMigrationVersion(60)` → log line).

**Logic:** stamping from `updated_at` rather than the migration time preserves *when* each card was staged instead of flattening six distinct decisions into one timestamp.

**Edge cases:** re-running the migration is a no-op — the `ALTER` throws and is swallowed, and the `UPDATE` matches nothing once the rows are converted.

### 2. `DISPATCH` becomes a legacy alias, normalised on every read

**Implementation:** move the entry out of `DISPLAY_MODE_COLUMNS` and into `LEGACY_COLUMN_LABELS` (`agentConfig.ts:160`), following the `CODED` precedent:

```ts
'DISPATCH': { label: 'Staging', legacyAliasOf: 'PLAN REVIEWED' },
```

Keep `'DISPATCH'` in `VALID_KANBAN_COLUMNS` (`KanbanDatabase.ts:894`) so such a row is accepted, and normalise it wherever `CODED` is already normalised: a row read with `kanban_column = 'DISPATCH'` is presented as `PLAN REVIEWED` with `staged_at` set if it is null. Drop `columns.set('DISPATCH', [])` from the board grouping map (`:9037`) so no mirror is emitted for it.

**Logic:** the codebase already has a first-class mechanism for a retired column value and already uses it for `CODED`. Reusing it means the cross-machine and older-version cases are handled by construction rather than by a migration that only ran on one machine.

**Edge cases:** a `DISPATCH` row arriving after migration is normalised on read and rewritten on the next update. Do not reject it, and do not re-run the migration to catch it — the alias is the durable mechanism.

### 3. Provider verbs stamp instead of moving

**Implementation:** in `KanbanProvider.ts`:
* `sendToDispatch` → **`setStaged`**: set `staged_at` on the card, leave `kanban_column` alone. Cascade to subtasks for a feature, matching how column moves already cascade — a feature is staged as a unit.
* `sendToPlanned` (when invoked from the staging view) → **`clearStaged`**: null `staged_at`.
* `dispatchAnalyze` (`:10367`): the candidate query is **unchanged** and now correctly includes staged cards, because they never left `PLAN REVIEWED`. The pass stamps instead of moving.
* `sendDispatchToCoder` (`:10391`): select on `staged_at IS NOT NULL` instead of column, and **delete the `_getNextColumnId` workaround** at `:10392-10396` — the source column genuinely is `PLAN REVIEWED` now, so the ordered walk resolves without special-casing.
* Clear `staged_at` in `moveCardToColumn` whenever a card leaves `PLAN REVIEWED`, in the same statement as the column write.
* `toggleDispatchView` → **`toggleStagingView`**; the `_showingDispatch` field and its `updateBoard` payload key become `_showingStaging` / `showingStaging` (`:1211`, `:2073`, `:3613`, `:3801`).

**Logic:** staging stops being a transition and becomes an attribute, which is what removes the entire divergence class.

**Edge cases:** staging a card that is already staged is idempotent — do not re-stamp, or the staging order silently reshuffles on a double-click.

### 4. The webview: a view filter, not a column filter

**Implementation:** in `kanban.html`, keyed off `showingStaging`:
* **Delete the exclusion filters at `:6406-6407` and `:6495-6496`.** This is the "Planned always shows all plans" change — the two lines that currently hide staged cards.
* When `showingStaging` is true, filter the Planned column's cards to `staged_at != null`. When false, show all `PLAN REVIEWED` cards.
* **Label** (`:5617`): `STAGING` in the default view, `PLANNED` when the filter is active; tooltips to match.
* **Delete the column remapping** at `:5220-5223`, `:5401`, `:5406`, `:6415`, `:6500`, `:7347`, `:7404`, `:7414`, `:7447`, `:7522` — no card carries `column === 'DISPATCH'` any more.
* **Delete the `getNextColumn(DISPATCH)` special case** at `:6960-6964` and simplify the complexity-routing resolve at `:6713-6716`, `:6725` to `PLAN REVIEWED` alone.
* Button visibility (`:5709`, `:5718`) and card actions (`:7010`, `:7014`) key off `showingStaging` rather than the card's column.
* The Planned **count badge counts every `PLAN REVIEWED` card**, staged included.

**Logic:** the change is mostly deletion. Roughly twenty sites exist only to undo a column value that no longer occurs.

**Edge cases:** drag-and-drop source resolution (`:7402-7414`, `:7444-7447`, `:7519-7522`) simplifies to `card.column` directly. Verify a drag *out of* the staging view files the card by its real column — this is the fiddliest deletion in the set.

### 5. Terminals kanban-pane — a `PLANNED — STAGED` picker entry

**Implementation:** the kanban-mode pane in the Terminals panel shows one column at a time, chosen from a picker built off `kanbanColumnsCache` (`terminals.js:3047-3050`, populated at `:3425` from `buildColumnList`). Staged-ness is a filter, not a column, so the structure will never contain it — resolve it **client-side in the pane**, the convention `feature_plan_20260807090200_terminals-kanban-pane-all-coded-aggregate-column.md` establishes for `CODED_AUTO`.

* **Synthetic id `PLANNED_STAGED`, label `PLANNED — STAGED`**, offered alongside (not replacing) `PLAN REVIEWED`. Upper-snake to match `CODED_AUTO`.
* **`getBoardCards` must return `stagedAt` on each card.** This is the one thing the aggregate precedent does not already give us: `ALL CODED` can filter client-side because `column` is already on the card payload, whereas `staged_at` is new. Without it the pane has nothing to filter on.
* **Fetch the real column, filter locally.** Unlike `ALL CODED`, this needs no unfiltered board fetch — request `column: 'PLAN REVIEWED'` and drop cards whose `stagedAt` is null. Cheaper than the aggregate, same shape.
* **Keep the guards keyed on the *chosen* id.** `kanbanFetchInFlight` and the post-response `kanbanPaneColumn[index] === col` re-check (`:3456`, `:3467`) must both key on `PLANNED_STAGED` while the request body carries the resolved `PLAN REVIEWED`. Keying either on the resolved column collapses the staged and unstaged panes into one guard slot and lets one pane's response render under the other's heading.
* **Empty-state text** (`:3183`) currently interpolates the raw id — `No plans in PLANNED_STAGED` is not a sentence. Resolve the label.
* **`bodySig` must include `stagedAt`** (`:2694-2696`). It does not include `c.column` today, which is why the aggregate plan has to extend it; the staged view has the identical failure in a different field — staging or unstaging a card changes nothing else on it, so the pane would render a stale set indefinitely while the 5 s poll happily confirms it.

**Logic:** the operator watching a terminal pane is the person deciding what to send to a coder next. Forcing them back to the board to see the staged subset is the same trip this plan removes from the board itself.

**Edge cases:** `kanbanPaneColumn` persists through `loadSetting('terminals.kanbanPaneColumn')` (`:854`), so `PLANNED_STAGED` round-trips as an opaque string with no migration needed. A saved `PLANNED_STAGED` on a build that does not know it must fall back to `PLAN REVIEWED` rather than rendering an empty pane.

### 6. Mirror export and the skill

**Implementation:** emit `.switchboard/kanban-state-staging.md` from `staged_at IS NOT NULL` and stop emitting `kanban-state-dispatch.md` (drop the grouping-map entry per change 2). Update `kanban-auto-export.test.ts:78-81` for the new mirror set and `:416` for `labelSource: 'legacy'`.

In `.agents/skills/dispatch-analysis/SKILL.md`, replace the step-5 `POST /kanban/move` with the staging verb, and delete the surrounding column language. Note in step 1 that staged plans **remain in `PLAN REVIEWED`** and are therefore already in the re-queried candidate set — the pass should skip re-staging a plan that is already staged and say so in the report.

**Logic:** `kanban-state-staging.md` gives the mirror-reading sibling plan a surface for staged-ness without a column to read it from.

**Edge cases:** edit only `.agents/`; `.claude/skills/dispatch-analysis/SKILL.md` is generated and `npm run mirror:check` is a CI gate.

---

## Verification Plan

### Automated Tests
* **Both schema paths:** a fresh DB from `SCHEMA_TABLES_SQL` has `staged_at`; a DB stamped at V59 gains it and reports version 60.
* **Migration preserves staging:** a V59 DB with 3 `DISPATCH` rows ends with 3 `PLAN REVIEWED` rows all having non-null `staged_at`, each stamped from its own `updated_at`. **The regression test for silent data loss.**
* **Migration idempotence:** running V60 twice leaves one column, version 60, no throw.
* **Read normalisation:** a row inserted with `kanban_column = 'DISPATCH'` *after* migration is presented as `PLAN REVIEWED` with `staged_at` set. **The cloud-sync / older-writer test.**
* **`resolveColumnLabel('DISPATCH')`** returns `{ label: 'Staging', labelSource: 'legacy' }`.
* **Staging is not a move:** `setStaged` leaves `kanban_column` unchanged; a staged feature cascades to its subtasks.
* **`staged_at` clears on exit:** moving a staged card out of `PLAN REVIEWED` nulls it; moving it back leaves it unstaged.
* **Idempotent stamp:** staging twice does not change the timestamp.
* **Analysis sees staged cards:** `dispatchAnalyze`'s candidate set includes staged plans — the direct regression test for the invisibility this plan removes.
* **No surviving comparisons:** a grep-style assertion that `'DISPATCH'` appears in `src/` only in `LEGACY_COLUMN_LABELS`, `VALID_KANBAN_COLUMNS` and migration SQL.
* **Badge counts staged cards.**
* **`getBoardCards` returns `stagedAt`** on every card.
* **Terminals pane picker offers `PLANNED_STAGED`** alongside `PLAN REVIEWED`, and selecting it yields only cards with a non-null `stagedAt` while requesting `column: 'PLAN REVIEWED'`.
* **Pane guards stay keyed on the chosen id:** with one pane on `PLAN REVIEWED` and another on `PLANNED_STAGED`, concurrent fetches do not collide in `kanbanFetchInFlight` and neither response renders under the other's heading.
* **`bodySig` includes `stagedAt`:** staging a card while a `PLANNED_STAGED` pane is open re-renders it (regression guard for the stale-set-with-a-happy-poll failure).
* **Unknown saved id degrades:** a persisted `PLANNED_STAGED` on a build without the entry falls back to `PLAN REVIEWED`, not an empty pane.

### Manual Verification (VSIX install)
1. **The headline check.** Open the board. All Planned plans are visible, including the ones previously hidden in Dispatch. The count badge matches what is on screen.
2. **Toggle.** Press **STAGING** → the column narrows to staged plans and the button reads **PLANNED**. Press again → full list. No card moved.
3. **Upgrade path.** Open a workspace whose DB predates V60 with cards in `DISPATCH`. Confirm they appear in Planned, are marked staged, and show under the Staging filter — nothing lost, nothing stranded.
4. **Analyze.** Run it with cards already staged. Confirm the pass sees them (report names them as already staged) and does not re-stage them.
5. **Send to coder.** From the Staging view, send the staged set forward. Cards route by complexity from `PLAN REVIEWED` as normal, and `staged_at` clears.
6. **Move back.** Drag a staged card to `CREATED` and back to Planned. It returns unstaged.
7. **Drag out of the staging view.** Confirm the card files by its real column, not a remapped one.
8. **Terminals pane.** Set a kanban-mode pane to **PLANNED — STAGED**. It shows only staged plans. Set a second pane to **PLAN REVIEWED**; it shows all of them, including the staged ones, and the two panes do not interfere. Stage a card from the board and confirm the staged pane picks it up on the next tick without a reload.
9. **Mirrors.** `kanban-state-staging.md` exists and lists the staged set; `kanban-state-dispatch.md` is no longer written; `kanban-state-plan-reviewed.md` includes staged plans.
10. **No stray Dispatch label** anywhere in the UI.
11. **`BACKLOG` unaffected.** The `CREATED` toggle, its counts and Advance All behave exactly as before.
12. **Mirror gate.** `npm run mirror:check` passes.

---

## Recommendation

Complexity 6 → **Send to Coder.** The net change is a deletion: one nullable column and a view filter replace a stored column value plus roughly twenty sites that exist only to undo it. It also removes the cause of two separate defects rather than working around either — the analysis pass's blindness to its own staged cards, and the `_getNextColumnId` special-casing in `sendDispatchToCoder`.

Two things must not be traded away. **The migration must carry the stamp, not just the column** — six users' staging decisions are the only unrecoverable thing in this change. And **the legacy alias must ship with the `UPDATE`**, because `kanban.db` syncs across machines and ~4,000 installs are on older versions: a migration that has already run cannot catch the `DISPATCH` row that arrives tomorrow, and without the alias staged cards begin silently disappearing from Planned again with no migration left to blame.

Land this before the two sibling skill plans, and renumber the write-set cache plan's migration to **V61**.
