# Staging is a filter, not a column — retire DISPATCH in favour of a per-plan staged stamp

## Goal

Make the Planned column **always show every plan in `PLAN REVIEWED`**, and turn the current `DISPATCH` view into a **STAGING** filter over a per-plan stamp: press *Staging* and the column narrows to the subset that is ready to code, press it again and you are back to the full list. No card ever changes column to be staged.

Retire `DISPATCH` as a stored column value. Staged-ness becomes `plans.staged_at`.

### Problem & background

**Staging a plan currently moves it out of the column it is displayed in.** `DISPATCH` is a real stored `kanban_column` value registered as a display mode of `PLAN REVIEWED` (`src/services/agentConfig.ts:165-167`), and the webview then spends ~20 sites folding it back into the Planned slot. The consequence a user sees is that staging a card **removes it from the Planned column**: `kanban.html:7091` and `:7221` both filter `card.column !== 'DISPATCH'` out of the default view. Six cards are in that state right now, invisible in Planned unless the toggle is pressed.

> **Line numbers in this plan are anchors, not addresses.** They were re-verified against HEAD on 2026-08-14, but `kanban.html` and `terminals.js` both moved by hundreds of lines during the panel-extraction work. Grep the named symbol/string first (`grep -n "'DISPATCH'" src/webview/kanban.html` returns all 38 sites); use the line number only to confirm you are in the right region.

That is backwards. Staging is a *property* of a reviewed plan — "this one is ready to code" — not a place it goes. Encoding a property as a location costs a column value, a display-mode registry entry, a per-column mirror file, and a laundering pass at every site that reads a card's column.

### Root cause — a stored column that the UI pretends is not one

Because the stored value diverges from the displayed column, every query written against the *visible* column silently misses staged cards. This has already shipped as a bug once, in the sibling `BACKLOG` instance. From the doc comment above `_visibleColumnCards` (`KanbanProvider.ts:538`), documenting why the helper exists at all:

> *"...different column (e.g. BACKLOG). That divergence is exactly what made 'Advance All' on CREATED dispatch a BACKLOG feature's subtasks instead of the loose plans the user could actually see in the column."*

`_visibleColumnCards` is scar tissue from that bug. The same divergence is live for `DISPATCH`: `dispatchAnalyze` sources candidates at `:10581` via `_visibleColumnCards(workspaceRoot, 'PLAN REVIEWED')`, so already-staged plans are invisible to the analysis that staged them — it re-analyses a board it believes is empty. `sendDispatchToCoder` (`:10606-10612`) carries a written-out workaround for the same cause: `DISPATCH` is not in `DEFAULT_KANBAN_COLUMNS`, so `_getNextColumnId`'s ordered walk returns null and the target has to be resolved from `PLAN REVIEWED` by hand.

**There is no `sendToDispatch` verb.** Staging is not performed by a dedicated verb at all — a fact worth stating plainly, because it changes the shape of change 3. Cards reach `DISPATCH` by exactly two writers:

1. **`POST /kanban/move` with `targetColumn: 'DISPATCH'`**, issued by the dispatch-analysis skill's step 5. This is the only *programmatic* stager.
2. **Drag-and-drop while the Dispatch view is open** — `kanban.html:8128-8130` rewrites a drop targeting `PLAN REVIEWED` into `DISPATCH` when `showingDispatch` is true.

Both must be redirected onto the stamp, and the `DISPATCH` target must keep working as a legacy alias for a skill file or an external caller that has not been updated. `grep -rn "sendToDispatch" src/` returns nothing at HEAD.

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

**None.** Eight decisions made here:

* **`kanban-state-dispatch.md` keeps being written, empty.** Following the `CODED` precedent exactly rather than carving a legacy exclusion into the `VALID_KANBAN_COLUMNS` mirror invariant. See change 6.
* **`setStaged` / `clearStaged` are net-new verbs**, not renames — there is no `sendToDispatch` to rename. See change 3.
* **`PLANNED_STAGED` is offered alongside `PLAN REVIEWED`, not substituted for it**, diverging from the `CODED_AUTO` aggregate's substitution because staged plans are a subset rather than a rollup. See change 5.

And the five original decisions:

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
* **38 `DISPATCH` occurrences across ~22 distinct sites in `kanban.html`, and the risk is in what gets *deleted*.** (`grep -c "DISPATCH" src/webview/kanban.html` = 38 at HEAD.) Each remapping site becomes unnecessary, but a missed one leaves a `card.column === 'DISPATCH'` comparison that is now permanently false — a silently dead branch, not a compile error. Grep-driven, not memory-driven. Several of the 38 are *comments* referencing line numbers that are themselves already stale (`:7132` cites "renderBoard's `card.column !== 'DISPATCH'` strip (:6383, :6472)" — those lines moved); delete the comment with the code it describes rather than repairing it.
* **The drag-and-drop source-column resolution** (`:8073`, `:8128-8140`, `:8170-8173`, `:8245-8248`) currently derives a *DOM* column from a *stored* column, and `:8130` is the **write** side of that mapping — it rewrites a drop targeting `PLAN REVIEWED` into `DISPATCH` while the Dispatch view is open. Simplification is real but this is the fiddliest area, and getting it wrong misfiles a dragged card.
* **Two normalisers, one hardcoded pair each.** `_normalizeLegacyKanbanColumn` exists twice — `KanbanProvider.ts:3368` and `TaskViewerProvider.ts:4074` — and each is a literal `column === 'CODED' ? 'LEAD CODED' : column`, not a read of `LEGACY_COLUMN_LABELS`. Editing one and not the other is the drift trap; and because both are pure string maps they cannot back-fill `staged_at`, so read normalisation needs a second piece at card-build time (see change 2).
* **Migration version collision.** The sibling write-set cache plan also claimed V60. This plan lands first and takes **V60**; that plan becomes **V61**. Migration head at HEAD is confirmed **V59** (`MIGRATION_V59_SQL`, `setMigrationVersion(59)` at `KanbanDatabase.ts:8328-8336`).

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
* `kanban-state-dispatch.md` becomes a permanently-empty tombstone (the `CODED` precedent — see change 6), and a new `kanban-state-staging.md`, derived from the stamp, carries staged-ness for the mirror-reading sibling plan.
* `kanban-state-plan-reviewed.md` grows to include staged plans. At HEAD it is 31 KB / 55 cards and `kanban-state-dispatch.md` holds 1; the merged file is not meaningfully larger, so the sibling board-mirror plan's size argument is unaffected.
* Two new verbs (`setStaged`, `clearStaged`) enter `verbAllowlist.ts` and `verbSchemas.ts`. Per the PRD's two-layer completion contract, they must also be reachable under `npx switchboard` — the kanban verb router is already wired in both hosts, so this is inherited rather than new work, but a headless test must assert the returned body carries `stagedAt`.

### Dependencies & Conflicts
* **`src/services/KanbanDatabase.ts`** — `SCHEMA_TABLES_SQL` (`:170`), migration constants (`MIGRATION_V58_SQL` `:467`, `MIGRATION_V59_SQL` `:482`), the runner (`:8318-8337`), `VALID_KANBAN_COLUMNS` (`:904`, `'DISPATCH'` at `:908`), the board grouping map (`:9045`) and the per-column mirror writer (`_writeLocalBoardMirror` `:8975`, per-column path `:9074`, index `:9123`). Migration head at HEAD is **V59** → this is **V60**. **Never edit a shipped `MIGRATION_Vnn_SQL` body**; add V60 only.
* **`src/services/agentConfig.ts`** — `DISPATCH` moves from `DISPLAY_MODE_COLUMNS` (`:165-167`) to `LEGACY_COLUMN_LABELS` (`:175`). Leave the `BACKLOG` entry alone.
* **`src/services/LocalApiServer.ts:2916-2950`** — `GET /kanban/columns` publishes the *relationship* alongside the label, sourced explicitly from `DISPLAY_MODE_COLUMNS` / `LEGACY_COLUMN_LABELS`. Moving the entry flips the advertised field from `displayModeOf: 'PLAN REVIEWED'` to `legacyAliasOf: 'PLAN REVIEWED'` automatically — no edit needed here, but it is the one place the change is externally visible to fleet agents. **This is also the only consumer of `labelSource` in `src/`** (`grep -rn labelSource src/services src/webview src/standalone`), which bounds the blast radius of the `display-mode` → `legacy` flip precisely; see the correction under change 2.
* **`src/webview/kanban.html`** — 38 `DISPATCH` occurrences across ~22 sites (full list in change 4). Handlers go in its own inline script; it is a self-contained webview.
* **`src/webview/terminals.js`** — the kanban-pane column picker (`:5010-5033`), the card fetch (`fetchBoardCardsForPane` `:5567-5612`), `buildColumnList` (`:4797`), `columnLabelForId` (`:4936`), `bodySig` (`:5155-5156`) and the empty-state string (`:5175`). **The `ALL CODED` aggregate work has already landed** — `AGGREGATE_CODED_ID = 'CODED_AUTO'` is live at `:4920` with the full picker-substitution, snap-back and aggregate-fetch machinery. The cross-feature serialisation this plan previously anticipated is therefore resolved in that plan's favour: **adopt the shipped `CODED_AUTO` conventions verbatim** (see change 5, which has been rewritten against them).
* **`getBoardCards`** (`KanbanProvider.ts:11308`) and its shared builder **`_buildBoardCards`** (card literal at `:1918`, second literal for completed rows below it) — must include `stagedAt` in the card payload. Moved into change 3, since it is a provider change and change 5 must stay confined to `terminals.js` per the one-stream-per-provider-file contract.
* **`src/services/KanbanProvider.ts`** — `sendToPlanned` (`:10551-10559`), `toggleDispatchView` (`:10560-10564`), `dispatchAnalyze` (`:10565-10605`), `sendDispatchToCoder` (`:10606+`), `_normalizeLegacyKanbanColumn` (`:3368`), and the `_showingDispatch` field (`:262`) plumbed through `updateBoard` (`:1251`, `:2117`, `:3667`, `:3865`) plus the public getter at `:2206` and the reset in `case 'createPlan'` (`:10508-10511`). There is **no** `sendToDispatch` verb — see the Root cause section.
* **`src/services/TaskViewerProvider.ts:4074`** — the second `_normalizeLegacyKanbanColumn`, with ~10 call sites of its own. Must be edited in lockstep with KanbanProvider's.
* **`src/test/kanban-auto-export.test.ts`** — `:78-88` loops over `VALID_KANBAN_COLUMNS` asserting **every** entry has both a `kanban-state-<slug>.md` link in `kanban-board.md` and a `## <COLUMN>` heading in its per-column file; `:416` asserts `resolveColumnLabel('DISPATCH')` returns `labelSource: 'display-mode'`. The label assertion changes to `legacy`. The mirror-set loop must **not** be relaxed — see the correction under change 6.
* **`.agents/skills/dispatch-analysis/SKILL.md`** — step 5 stops moving cards to a column and stamps instead. Shared with two siblings (`feature_plan_20260810173147_…board-mirror…` and the write-set cache plan); all three serialise on that file, this one first. **There is no `.claude/skills/dispatch-analysis/` mirror** — the directory does not exist; the skill is `.agents`-only, read by the extension by path, and listed in `.agents/.switchboard-bundled.json:37`. `npm run mirror:check` compares `.claude/skills/**` against the generated mirror and never sees this file.

> **Superseded:** "`feature_plan_20260811094500_dispatch-analysis-blind-to-already-staged-cards.md` is superseded by this plan and should be deleted, not implemented."
> **Reason:** The disposition is no longer pending — that plan file does not exist at HEAD (`ls .switchboard/plans/feature_plan_20260811094500_*` → no such file). Leaving the instruction in reads as outstanding work and sends a coder looking for a file to delete.
> **Replaced with:** The occupancy-workaround plan has already been deleted. No action required; this plan removes the invisibility it worked around.

---

## Dependencies
* No blocking plan dependencies; every touched surface exists at HEAD.
* Two siblings serialise **behind** this plan on `.agents/skills/dispatch-analysis/SKILL.md`, and the write-set cache plan must be renumbered to V61.
* Migration V60 is additive plus one scoped `UPDATE` over rows with `kanban_column = 'DISPATCH'`. No other row is touched.

---

## Adversarial Synthesis

Key risks: (0) **normalising the column string without back-filling the stamp** — the `CODED` precedent this plan leans on is a pure `string → string` map duplicated in two providers, so "follow the `CODED` precedent" delivers a legacy row that appears in Planned and is silently *unstaged*: the same data loss as risk 1, arriving from a stale writer rather than from the migration, and after the migration has been marked complete; (1) **migrating the column without the stamp** — the six live `DISPATCH` cards land in Planned as ordinary reviewed plans and the user's staging decisions are silently gone, which is data loss dressed as a cleanup; (2) **shipping the `UPDATE` without the read-path alias** — a cloud-synced or older-version writer reintroduces `DISPATCH` rows and cards start disappearing from Planned again, with the migration already marked complete so it never re-runs; (3) **a missed remapping site** — a leftover `card.column === 'DISPATCH'` comparison is now permanently false and compiles clean, so the failure is a dead branch discovered by a user, not by a build; (4) **the count badge excluding staged cards** — reproduces the exact invisibility the plan exists to remove, on the one surface a user actually scans; (5) **scope creep into `BACKLOG`** — a 38-card migration and the `CREATED` column's whole toggle/Advance-All path riding along on a 6-card change; (6) **`staged_at` outliving the column** — a card sent to a coder and later moved back presents stale staging as current; (7) **deleting the write-side of the drag mapping** (`kanban.html:8128-8130`) instead of replacing it — dragging into the staging view then "succeeds" while changing nothing, because the card is already in `PLAN REVIEWED`; (8) **planning against stale line numbers** — `kanban.html` and `terminals.js` moved by hundreds of lines during panel extraction, and the `ALL CODED` aggregate this plan expected to serialise against has already shipped. Mitigations: migrate column and stamp in the same statement; back-fill the stamp at card-build time, not only in the string normaliser, and edit both copies of it; replace the drag write-mapping with a `setStaged` call and assert it in manual step 9; grep for symbols rather than trusting the line numbers below; adopt the shipped `CODED_AUTO` conventions verbatim; move `DISPATCH` into `LEGACY_COLUMN_LABELS` so normalisation happens on every read rather than once; drive the webview edits from a grep of the ~20 sites with a test asserting no `'DISPATCH'` comparison survives outside the legacy alias; assert the badge counts staged cards; leave `BACKLOG` untouched and say so in the plan; clear `staged_at` on every transition out of `PLAN REVIEWED`.

---

## Proposed Changes

**Build order:** (1) schema + migration → (2) legacy alias and read normalisation → (3) provider verbs → (4) board webview filter and label → (5) terminals kanban-pane picker → (6) mirror + skill. Steps 1-2 must land together; a half-migrated DB is the one state with no correct reading.

### 1. V60 — `plans.staged_at`, and migrate the live `DISPATCH` cards

**Implementation:** add `staged_at TEXT DEFAULT NULL` to the `plans` definition in `SCHEMA_TABLES_SQL` (`:170`) and as `MIGRATION_V60_SQL`:

```sql
ALTER TABLE plans ADD COLUMN staged_at TEXT DEFAULT NULL;
UPDATE plans SET staged_at = COALESCE(staged_at, updated_at, created_at),
                 kanban_column = 'PLAN REVIEWED'
 WHERE kanban_column = 'DISPATCH';
CREATE INDEX IF NOT EXISTS idx_plans_staged ON plans(workspace_id, staged_at);
```

Register in the runner (`:8318-8337`) with the existing idempotent shape, copied from the V58/V59 blocks immediately above it:

```ts
// V60: plans.staged_at (the "ready to code" stamp that replaces the DISPATCH column).
const v60 = await this.getMigrationVersion();
if (v60 < 60) {
    for (const sql of MIGRATION_V60_SQL) {
        try { this._db.exec(sql); } catch { /* column/index already exists */ }
    }
    await this.setMigrationVersion(60);
    console.log('[KanbanDatabase] V60 migration completed: staged_at column added to plans, DISPATCH rows normalised');
}
```

**Logic:** stamping from `updated_at` rather than the migration time preserves *when* each card was staged instead of flattening six distinct decisions into one timestamp.

**Edge cases:**
* Re-running the migration is a no-op — the `ALTER` throws and is swallowed, and the `UPDATE` matches nothing once the rows are converted.
* **Each statement needs its own array element.** The runner's `try/catch` is *per statement*, so putting the `ALTER`, `UPDATE` and `CREATE INDEX` in one string means a re-run's failed `ALTER` swallows the other two with it. V13 (`MIGRATION_V13_SQL`, `:490`) is the precedent: an `ALTER` and a `CREATE INDEX` as two separate elements. Split the three statements accordingly.
* The `UPDATE` must run **after** the `ALTER` in array order — it references the new column.

### 2. `DISPATCH` becomes a legacy alias, normalised on every read

**Implementation:** move the entry out of `DISPLAY_MODE_COLUMNS` (`agentConfig.ts:165-167`) and into `LEGACY_COLUMN_LABELS` (`:175`), following the `CODED` precedent one line below it:

```ts
'DISPATCH': { label: 'Staging', legacyAliasOf: 'PLAN REVIEWED' },
```

Keep `'DISPATCH'` in `VALID_KANBAN_COLUMNS` (`KanbanDatabase.ts:908`) so such a row is accepted rather than rejected on write.

> **Superseded:** "normalise it wherever `CODED` is already normalised: a row read with `kanban_column = 'DISPATCH'` is presented as `PLAN REVIEWED` with `staged_at` set if it is null."
> **Reason:** Half-right, and the half it gets wrong is the load-bearing half. `CODED` normalisation is **not** a read of `LEGACY_COLUMN_LABELS` — it is a hardcoded string map duplicated in two providers (`KanbanProvider._normalizeLegacyKanbanColumn` at `:3368`, `TaskViewerProvider._normalizeLegacyKanbanColumn` at `:4074`), each literally `normalized === 'CODED' ? 'LEAD CODED' : normalized`. Both take a *string* and return a *string*, so neither can set `staged_at` — following the `CODED` precedent alone gives you a card that appears in Planned and is silently **unstaged**, which is exactly the data loss this plan exists to prevent, only now arriving from a stale writer instead of from the migration.
> **Replaced with:** Two pieces, both required.
>
> **(a) The column string.** Extend both `_normalizeLegacyKanbanColumn` implementations to also map `'DISPATCH' → 'PLAN REVIEWED'`. Edit them in lockstep; a one-sided edit is the drift trap, and each has its own call sites (13 in KanbanProvider, ~10 in TaskViewerProvider). Prefer deriving both from `LEGACY_COLUMN_LABELS[column]?.legacyAliasOf ?? column` so the next retired column needs no code edit — but if that refactor is deferred, add the literal to **both**.
>
> **(b) The stamp.** In `_buildBoardCards`, where the card literal already calls `this._normalizeLegacyKanbanColumn(row.kanbanColumn)` (`:1918`), read the **raw** `row.kanbanColumn` as well and derive `stagedAt: row.stagedAt || (row.kanbanColumn === 'DISPATCH' ? (row.updatedAt || row.createdAt) : null)`. This is presentation-level back-fill only; the stored row is repaired on the card's next write, exactly as a `CODED` row is today.

Drop `columns.set('DISPATCH', [])` from the board grouping map (`:9045`)?  **No — see the correction in change 6.** Leave the grouping entry in place.

**Logic:** the codebase already has a first-class mechanism for a retired column value and already uses it for `CODED`. Reusing it means the cross-machine and older-version cases are handled by construction rather than by a migration that only ran on one machine.

**Edge cases:**
* A `DISPATCH` row arriving after migration is normalised on read and rewritten on the next update. Do not reject it, and do not re-run the migration to catch it — the alias is the durable mechanism.
* **The `labelSource` flip is externally visible, and its blast radius is exactly one call site.** `kanban-auto-export.test.ts:414-416` carries a comment warning that `labelSource: 'legacy'` "is consumed by state export, `GET /kanban/columns` and write-path canonicalisation". Verified at HEAD: the only consumer of `labelSource` anywhere in `src/services`, `src/webview` or `src/standalone` is `LocalApiServer.ts:2916` (the `GET /kanban/columns` payload). `_canonicalColumnId` (`LocalApiServer.ts:1145`) canonicalises against `DEFAULT_KANBAN_COLUMNS` plus ids observed on the board — it never reads `labelSource`. The flip changes one advertised field (`displayModeOf` → `legacyAliasOf`) and nothing else, which is the intent. Update the test's comment along with its assertion so the next reader is not warned off a safe change.
* **`POST /kanban/move` with `targetColumn: 'DISPATCH'` must keep working** and must now mean *stamp, do not move*. Route it through the same alias: canonicalise `DISPATCH` → `PLAN REVIEWED`, then set `staged_at`. An un-updated skill file, a fleet agent, or a queued request from another machine will send it.

### 3. Provider verbs stamp instead of moving

> **Superseded:** "`sendToDispatch` → **`setStaged`**".
> **Reason:** There is no `sendToDispatch` verb to rename. `grep -rn "sendToDispatch" src/` returns nothing at HEAD, and it is absent from `src/generated/verbAllowlist.ts`. A coder following this line greps, finds nothing, and improvises — most likely by leaving the two paths that *actually* stage cards untouched.
> **Replaced with:** Add **`setStaged`** as a net-new verb, and redirect the two existing writers (the `POST /kanban/move` → `DISPATCH` path and the drag-into-Dispatch-view path) onto it. Being net-new, it also needs a `verbSchemas.ts` block and a `verbAllowlist` entry — neither of which a rename would have required.

**Implementation:** in `KanbanProvider.ts`:
* **New verb `setStaged`**: set `staged_at` on the card, leave `kanban_column` alone. Cascade to subtasks for a feature, matching how column moves already cascade — a feature is staged as a unit. Add to `src/generated/verbAllowlist.ts` (`KANBAN_VERBS`) and to `src/services/verbSchemas.ts` with `{ workspaceRoot: {type:'string'}, planId: {type:'string'}, sessionId: {type:'string'} }` — permissive, per PRD contract #5: require only what the arm dereferences.
* **New verb `clearStaged`**: null `staged_at`. `sendToPlanned` (`:10551-10559`) keeps its current meaning (move to `PLAN REVIEWED`); when the card is already in `PLAN REVIEWED` and the staging filter is open, the webview calls `clearStaged` instead. Same allowlist/schema treatment.
* **Both verbs must return their result in the body** per PRD contract #4 — `{ success, planId, stagedAt }`, not a bare `{success:true}` — so the standalone host's HTTP caller can see the stamp it just wrote.
* `dispatchAnalyze` (`:10565-10605`): the candidate query is **unchanged** and now correctly includes staged cards, because they never left `PLAN REVIEWED`. The pass stamps instead of moving.
* `sendDispatchToCoder` (`:10606+`): select on `staged_at IS NOT NULL` instead of column — including the `_lastCards` filter at `:10707` (`c.column === 'DISPATCH' && !c.featureId`) — and **delete the `_getNextColumnId` workaround** at `:10606-10612` along with the comment block explaining it. The source column genuinely is `PLAN REVIEWED` now, so the ordered walk resolves without special-casing. The `dispatchFailures` entries at `:10650`, `:10664`, `:10729`, `:10743` hardcode `sourceColumn: 'DISPATCH'` — they become `'PLAN REVIEWED'`.
* Clear `staged_at` in `moveCardToColumn` whenever a card leaves `PLAN REVIEWED`, in the same statement as the column write.
* `toggleDispatchView` (`:10560-10564`) → **`toggleStagingView`**; the `_showingDispatch` field (`:262`), its public getter (`:2206`), the `createPlan` reset (`:10508-10511`) and its `updateBoard` payload key become `_showingStaging` / `showingStaging` (`:1251`, `:2117`, `:3667`, `:3865`). Keep `toggleDispatchView` in the allowlist as an alias for one release — it is a shipped verb name and a stale webview bundle or an external caller will still send it.
* **`_buildBoardCards` emits `stagedAt`** on every card literal (`:1918` for active rows; the completed-rows literal below it can hardcode `stagedAt: null` — a completed plan is not staged). This is what makes `getBoardCards` (`:11308`) carry the field, which change 5 depends on. It lives here, not in change 5, so that change 5 touches only `terminals.js`.

**Logic:** staging stops being a transition and becomes an attribute, which is what removes the entire divergence class.

**Edge cases:**
* Staging a card that is already staged is idempotent — do not re-stamp, or the staging order silently reshuffles on a double-click.
* `getBoardCards` rolls subtasks up (`filtered = filtered.filter(c => !c.featureId)`, `:11345`), so a staged feature must carry `staged_at` on the **feature card itself**, not only on its cascaded subtasks — otherwise the terminals pane's staged view shows nothing for a staged feature.

### 4. The webview: a view filter, not a column filter

**Implementation:** in `kanban.html`, keyed off `showingStaging`. Drive this from `grep -n "DISPATCH" src/webview/kanban.html` (38 hits at HEAD) rather than from the list below — the list is the map, the grep is the territory.

* **Delete the exclusion filters at `:7091` and `:7221`.** This is the "Planned always shows all plans" change — the two lines that currently hide staged cards.
* When `showingStaging` is true, filter the Planned column's cards to `stagedAt != null`. When false, show all `PLAN REVIEWED` cards.
* **Label** (`:6280-6282`): `STAGING` in the default view, `PLANNED` when the filter is active; tooltips to match.
* **The Planned header's staged count** (`:7129-7148`) already computes `currentCards.filter(c => c.column === 'DISPATCH' && !c.featureId).length` from the *unfiltered* `allCards` cache and renders it as `DISPATCH n`. Repoint the predicate to `c.stagedAt && !c.featureId` and the label to `STAGING n`. Delete the stale comment at `:7132` referencing "renderBoard's `card.column !== 'DISPATCH'` strip (:6383, :6472)" — both the strip and those line numbers are gone.
* **The Planned column's own count badge counts every `PLAN REVIEWED` card**, staged included. This is separate from the staged count above and is the surface the invisibility bug is actually visible on.
* **Delete the column remapping** at `:5885-5886`, `:6059-6071`, `:6407`, `:7099`, `:7225`, `:8073`, `:8128-8140`, `:8170-8173`, `:8245-8248` — no card carries `column === 'DISPATCH'` any more.
* **Delete the `getNextColumn(DISPATCH)` special case** at `:7682-7686` and simplify the complexity-routing resolve at `:7441-7453` to `PLAN REVIEWED` alone.
* Card-action visibility (`:7726-7738` — the `→ Planned` exit arm that is currently gated on `showingDispatch && card.column === 'DISPATCH'`) keys off `showingStaging` and `card.stagedAt` rather than the card's column, and calls the new `clearStaged` verb instead of `sendToPlanned`.

**Logic:** the change is mostly deletion. The great majority of the 38 sites exist only to undo a column value that no longer occurs.

**Edge cases:**
* Drag-and-drop source resolution (`:8073`, `:8136-8140`, `:8170-8173`, `:8245-8248`) simplifies to `card.column` directly. Verify a drag *out of* the staging view files the card by its real column — this is the fiddliest deletion in the set.
* **`:8128-8130` is the write side and must not be merely deleted.** It currently rewrites a drop targeting `PLAN REVIEWED` into `DISPATCH` while the Dispatch view is open — i.e. dragging a card into the open Dispatch view is how a user stages by hand. Replace it with a `setStaged` call, or dragging into the staging view becomes a silent no-op (the card is already in `PLAN REVIEWED`, so the move succeeds and changes nothing).

### 5. Terminals kanban-pane — a `PLANNED — STAGED` picker entry

> **Superseded:** the previous version of this change, which described the `ALL CODED` aggregate as unshipped work to serialise against ("that plan is further along — prefer letting it land first"), claimed `bodySig` does not include `c.column`, claimed the empty state interpolates the raw id, and claimed `kanbanFetchInFlight` could collide between two panes.
> **Reason:** All four are stale as of HEAD. The aggregate landed: `AGGREGATE_CODED_ID = 'CODED_AUTO'` (`terminals.js:4920`) with picker substitution (`:5022-5033`), snap-back (`:4987-5000`), aggregate fetch (`:5580-5602`) and `columnLabelForId` (`:4936`). `bodySig` (`:5156`) **already ends in `${c.column || ''}`**. The empty state (`:5175`) **already calls `columnLabelForId(...)`**. And `kanbanFetchInFlight` is a `Set` of **pane indices** (`:80`, `kanbanFetchInFlight.has(index)` at `:5574`), not columns, so two panes can never share a guard slot regardless of what they display.
> **Replaced with:** the conventions below, read off the shipped `CODED_AUTO` implementation rather than anticipated.

**Implementation:** the kanban-mode pane shows one column at a time, chosen from a picker built off `kanbanColumnsCache` (`terminals.js:5012`, populated at `:5541` from `buildColumnList` at `:4797`). Staged-ness is a filter, not a column, so the structure will never contain it — resolve it **client-side in the pane**, exactly as `CODED_AUTO` does.

* **Synthetic id `PLANNED_STAGED`, label `Planned — Staged`.** Upper-snake id to match `AGGREGATE_CODED_ID`; **title-case label** to match `AGGREGATE_CODED_LABEL = 'Autocode'`. The label comment at `:4922-4926` is explicit about why: this picker is a plain `<select>` with no `text-transform`, so an ALL-CAPS entry is the one option shouting among title-case neighbours. (`PLANNED — STAGED` as originally written would be exactly that.)
* **Offered *alongside* `PLAN REVIEWED`, not substituted for it.** This is the one place the aggregate is a bad model: `CODED_AUTO` **replaces** the coder columns it covers (`.filter(c => c.kind !== 'coded').concat([...])`), because showing both the bucket and its members would duplicate cards. Staged plans are a *subset* of Planned, and the operator needs both views, so append rather than filter. Carry `PLAN REVIEWED`'s `order` so it sorts adjacent — use the same `.sort((a,b) => (a.order||0)-(b.order||0))` the aggregate path already runs, and give the synthetic entry `order = planReviewedOrder + 0.5` so a stable sort is not relied on for adjacency.
* **No `collapseCoders`-style gate.** `aggregateOffered` exists because the board's collapse toggle can withdraw the aggregate underneath a pane, requiring the snap-back dance at `:4987-5000`. `PLANNED_STAGED` is unconditional — nothing withdraws it — so it needs **neither** the offered-gate **nor** the snap-back. Do not copy that machinery; it has no failure mode to prevent here. It does still need the `structureLanded` guard for its pre-structure label fallback (`:5010-5015`).
* **`columnLabelForId` needs a second branch** (`:4936`): it resolves `AGGREGATE_CODED_ID` by an explicit `if` and otherwise looks the id up in `kanbanColumnsCache`, falling back to the raw id. `PLANNED_STAGED` is not in the cache, so without a branch the empty state reads `No plans in PLANNED_STAGED`. One line beside the aggregate's.
* **Fetch the real column, filter locally.** Unlike the aggregate — which omits `column` entirely because sending `CODED_AUTO` to `getBoardCards`' literal `c.column === column` compare returns an empty list (`:5581-5587`) — request `column: 'PLAN REVIEWED'` and drop cards whose `stagedAt` is null. Cheaper than the aggregate, same shape: `const isStaged = col === STAGED_PLANNED_ID; const body = { workspaceRoot, project }; body.column = isStaged ? 'PLAN REVIEWED' : col;` then `kanbanPaneCards[index] = isStaged ? all.filter(c => c.stagedAt) : all;`.
* **Keep `col` as the chosen id.** The post-response re-check `kanbanPaneColumn[index] === col` (`:5596`) must compare the **synthetic** id — resolve only into `body.column`, exactly as the aggregate does. Resolving `col` itself makes the re-check pass for a pane that has since switched to plain `PLAN REVIEWED` and renders the staged subset under the full column's heading.
* **`bodySig` must include `stagedAt`** (`:5156`). It already carries `${c.column || ''}` — that was the aggregate's fix and it does not help here, because staging a card changes *nothing else on it*: same column, same topic, same complexity. Without `stagedAt` in the signature the pane renders a stale set indefinitely while the 5 s poll happily confirms it.
* **Leave `codedColumnIds()` and the sidebar role-order map alone** (`:4821-4832`, `:4932`). Both derive from `kanbanColumnsCache`, which is the *structure* — the synthetic entry is built downstream in `renderKanbanPane`'s local `columns` array and must never be written back into the cache, or it leaks into the role map as a phantom role.

**Logic:** the operator watching a terminal pane is the person deciding what to send to a coder next. Forcing them back to the board to see the staged subset is the same trip this plan removes from the board itself.

**Edge cases:**
* `kanbanPaneColumn` persists through `loadSetting('terminals.kanbanPaneColumn')` (`:1412`), so `PLANNED_STAGED` round-trips as an opaque string with no migration needed.
* A saved `PLANNED_STAGED` on a build that does not know it falls through `columnLabelForId` to the raw id and fetches with `column: 'PLANNED_STAGED'`, which the literal `===` compare answers with an empty list — a pane reading `No plans in PLANNED_STAGED`. That is the same class of bug the aggregate's `structureLanded` guard was added for (`:4973-4979`, where a persisted `CODED_AUTO` was rewritten to `CREATED` **and persisted**). Accept the degraded label on a downgrade — but do **not** add a snap-back that rewrites and saves the setting, or a downgrade permanently destroys the operator's pane selection.
* `getBoardCards` rolls subtasks up under their feature (`KanbanProvider.ts:11345`), so this pane shows staged **features** and staged loose plans, never individual staged subtasks. That matches the board and is the intended reading.

### 6. Mirror export and the skill

**Implementation:** emit `.switchboard/kanban-state-staging.md` from `staged_at IS NOT NULL`, as an **additional** derived mirror.

> **Superseded:** "stop emitting `kanban-state-dispatch.md` (drop the grouping-map entry per change 2). Update `kanban-auto-export.test.ts:78-81` for the new mirror set."
> **Reason:** Dropping `columns.set('DISPATCH', [])` (`KanbanDatabase.ts:9045`) breaks a live invariant, and "update the test for the new mirror set" understates what that costs. `kanban-auto-export.test.ts:78-88` is a **loop over `VALID_KANBAN_COLUMNS`** asserting each entry has both a `kanban-state-<slug>.md` link in `kanban-board.md` and a `## <COLUMN>` heading in its own file. Since change 2 deliberately keeps `'DISPATCH'` in `VALID_KANBAN_COLUMNS`, dropping the grouping entry makes that loop fail — and "fixing" it means adding a legacy-exclusion carve-out to a general invariant, weakening it for every future retired column. The `CODED` precedent this plan invokes throughout does the opposite: `CODED` is a legacy alias, is still in `VALID_KANBAN_COLUMNS`, and **still gets a mirror** — `.switchboard/kanban-state-coded.md` exists at HEAD and is 40 bytes (`## CODED` + `_No plans_`). An always-empty file is the shipped, tested behaviour for a retired column.
> **Replaced with:** Leave `columns.set('DISPATCH', [])` in place. After V60 it is permanently empty and `kanban-state-dispatch.md` becomes a 40-byte tombstone, exactly like `kanban-state-coded.md`. The `VALID_KANBAN_COLUMNS` loop stays untouched and keeps its full strength. Only `:416`'s label assertion changes, to `labelSource: 'legacy'`.

`kanban-state-staging.md` is written outside the per-column loop, from the stamp rather than from a column, and therefore does **not** appear in `kanban-board.md`'s column table — it is not a column. Say so in a one-line header inside the file (`**Derived:** plans in PLAN REVIEWED with staged_at set`) so a reader does not mistake it for one.

In `.agents/skills/dispatch-analysis/SKILL.md`, replace the step-5 `POST /kanban/move` with the staging verb, and delete the surrounding column language — including the summary block at the top of the file ("moves that subset to the **DISPATCH** column") and the step-6 report line ("Plans moved to Dispatch (parallel-safe)"). Note in step 1 that staged plans **remain in `PLAN REVIEWED`** and are therefore already in the re-queried candidate set — the pass should skip re-staging a plan that is already staged and say so in the report.

**Logic:** `kanban-state-staging.md` gives the mirror-reading sibling plan a surface for staged-ness without a column to read it from.

> **Superseded:** "edit only `.agents/`; `.claude/skills/dispatch-analysis/SKILL.md` is generated and `npm run mirror:check` is a CI gate."
> **Reason:** Factually wrong at HEAD — `.claude/skills/dispatch-analysis/` does not exist. `scripts/check-claude-mirror.js` walks `.claude/skills/**` and compares it against `generateClaudeMirror`'s output; a file that is in neither is invisible to it. The instruction is harmless but it teaches a coder that a gate is watching this file when none is, and it contradicts the sibling worktree plan, which states the position correctly.
> **Replaced with:** `.agents/skills/dispatch-analysis/SKILL.md` is the only copy. It is read by the extension **by path** and is listed in `.agents/.switchboard-bundled.json:37` for packaging. There is no `.claude` mirror and `npm run mirror:check` does not gate it — so there is also no mirror edit to forget, and no CI signal if the file drifts. The compensating gate is `src/test/dispatch-analysis-scope-contract.test.js`, which already reads source files to enforce cross-file contracts; the sibling board-mirror plan extends it to assert the skill's step-1 spelling, and this plan should add the same for step 5.

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
* **No surviving comparisons:** a grep-style assertion that `'DISPATCH'` appears in `src/` only in `LEGACY_COLUMN_LABELS`, `VALID_KANBAN_COLUMNS`, `_normalizeLegacyKanbanColumn` (both copies), the board grouping map and migration SQL.
* **`_normalizeLegacyKanbanColumn` agrees across providers:** both copies map `DISPATCH → PLAN REVIEWED` and `CODED → LEAD CODED`. The direct guard against a one-sided edit.
* **Legacy row back-fills the stamp:** a row read with `kanban_column = 'DISPATCH'` and `staged_at IS NULL` produces a card with `column: 'PLAN REVIEWED'` **and a non-null `stagedAt`**. Column-only normalisation passing this test is the failure it exists to catch — assert both fields.
* **`POST /kanban/move` with `targetColumn: 'DISPATCH'` stamps and does not move:** the row's `kanban_column` is unchanged and `staged_at` is set. The un-updated-caller test.
* **Badge counts staged cards**, and the Planned header's staged count reads from `stagedAt`, not from a column.
* **`getBoardCards` returns `stagedAt`** on every card, and a completed-plan card returns `stagedAt: null`.
* **Both new verbs return their stamp in the body** (`{ success, planId, stagedAt }`), asserted over the HTTP path, not only the postMessage path — PRD contract #4.
* **The `VALID_KANBAN_COLUMNS` mirror loop still passes unmodified**, with `kanban-state-dispatch.md` present and empty. The regression guard for change 6's correction.
* **`kanban-state-staging.md` lists exactly the stamped set** and is absent from `kanban-board.md`'s column table.
* **Terminals pane picker offers `PLANNED_STAGED`** alongside — not instead of — `PLAN REVIEWED`, adjacent in sort order, and selecting it yields only cards with a non-null `stagedAt` while requesting `column: 'PLAN REVIEWED'`.
* **`columnLabelForId('PLANNED_STAGED')`** returns the title-case label, not the raw id.
* **Pane fetch keeps `col` synthetic:** the post-response `kanbanPaneColumn[index] === col` re-check compares `PLANNED_STAGED`, so a pane switched to plain `PLAN REVIEWED` mid-flight discards the staged response instead of rendering it under the full column's heading.
* **`bodySig` includes `stagedAt`:** staging a card while a `PLANNED_STAGED` pane is open re-renders it (regression guard for the stale-set-with-a-happy-poll failure).
* **Unknown saved id does not self-destruct:** a persisted `PLANNED_STAGED` on a build without the entry renders an empty pane with a raw-id label and **does not rewrite or persist** `terminals.kanbanPaneColumn`.

### Manual Verification (VSIX install)
1. **The headline check.** Open the board. All Planned plans are visible, including the ones previously hidden in Dispatch. The count badge matches what is on screen.
2. **Toggle.** Press **STAGING** → the column narrows to staged plans and the button reads **PLANNED**. Press again → full list. No card moved.
3. **Upgrade path.** Open a workspace whose DB predates V60 with cards in `DISPATCH`. Confirm they appear in Planned, are marked staged, and show under the Staging filter — nothing lost, nothing stranded.
4. **Analyze.** Run it with cards already staged. Confirm the pass sees them (report names them as already staged) and does not re-stage them.
5. **Send to coder.** From the Staging view, send the staged set forward. Cards route by complexity from `PLAN REVIEWED` as normal, and `staged_at` clears.
6. **Move back.** Drag a staged card to `CREATED` and back to Planned. It returns unstaged.
7. **Drag out of the staging view.** Confirm the card files by its real column, not a remapped one.
8. **Terminals pane.** Set a kanban-mode pane to **Planned — Staged**. It shows only staged plans. Set a second pane to **PLAN REVIEWED**; it shows all of them, including the staged ones, and the two panes do not interfere. Stage a card from the board and confirm the staged pane picks it up on the next tick without a reload. Confirm the option sits next to Planned in the dropdown and that an **Autocode** pane still behaves exactly as before.
9. **Drag to stage.** With the Staging filter open, drag a card from `CREATED` into the Planned column. It must arrive **staged**, not merely moved — the write-side mapping at `kanban.html:8128-8130` is the thing being replaced, and a silent no-op here looks identical to success.
10. **Mirrors.** `kanban-state-staging.md` exists and lists the staged set; `kanban-state-dispatch.md` still exists and is empty (matching `kanban-state-coded.md`); `kanban-state-plan-reviewed.md` includes staged plans.
11. **No stray Dispatch label** anywhere in the UI. `GET /kanban/columns` reports `DISPATCH` with `legacyAliasOf: 'PLAN REVIEWED'` rather than `displayModeOf`.
12. **`BACKLOG` unaffected.** The `CREATED` toggle, its counts and Advance All behave exactly as before.

---

## Recommendation

Complexity 6 → **Send to Coder.** The net change is a deletion: one nullable column and a view filter replace a stored column value plus roughly twenty sites that exist only to undo it. It also removes the cause of two separate defects rather than working around either — the analysis pass's blindness to its own staged cards, and the `_getNextColumnId` special-casing in `sendDispatchToCoder`.

Two things must not be traded away. **The migration must carry the stamp, not just the column** — six users' staging decisions are the only unrecoverable thing in this change. And **the legacy alias must ship with the `UPDATE`**, because `kanban.db` syncs across machines and ~4,000 installs are on older versions: a migration that has already run cannot catch the `DISPATCH` row that arrives tomorrow, and without the alias staged cards begin silently disappearing from Planned again with no migration left to blame.

Land this before the two sibling skill plans, and renumber the write-set cache plan's migration to **V61**.
