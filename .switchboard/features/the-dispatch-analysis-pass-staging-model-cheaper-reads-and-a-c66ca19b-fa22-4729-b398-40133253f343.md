# The Dispatch-Analysis Pass: Staging Model, Cheaper Reads, and a Worktree Escape Hatch

<!-- board-collapse-membership -->
> **BODY CORRECTION 2026-09-04 (Board Collapse audit).** The banner below records that *Staging is a filter, not a column* was retired and deleted and "must not be waited on". **The body still contradicts that**, and also contradicts itself.
> 
> Void: *"All four edit `.agents/skills/dispatch-analysis/SKILL.md`"* (three do), staging as numbered step **1**, step 4 landing "after staging", the claim that line numbers were re-verified across all four, and the instruction *"add V60 and V61 only"* — both numbers are taken and the schema head is **V67**.
> 
> Second contradiction, unrelated to the deletion: item 1 states `.claude/skills/dispatch-analysis/` does not exist so the mirror gate never sees it, while the closing line says the `.claude/` copy is generated and `mirror:check` is a CI gate. Both are now moot — the mirror generator and that gate are being deleted — but do not read the closing line as a live constraint.

<!-- board-collapse-01c -->
> **CORRECTED 2026-09-04 (Board Collapse 01).** Two stale facts in this file. (1) It sequences behind a subtask *Staging is a filter, not a column* (`feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md`) that was **retired and its file deleted**: `DISPATCH` was replaced by a real `STAGING` column in commit `52404992`, so migration V60 and the `plans.staged_at` stamp were never built. That plan is not a subtask of this feature and must not be waited on. (2) The migration numbers here are stale — V60 and V61 are taken and the schema head is **V67**. The write-set cache takes "the next free migration version at implementation time"; the instruction "add V60 and V61 only" is void. The rule it rests on stands: never edit a shipped `MIGRATION_Vnn_SQL` body.

**Complexity:** 6

## Goal

Rework the dispatch-analysis pass end to end: how it models staged-ness, how it reads the board, how it reads plans, and what it can offer when candidates are entangled. Today staging moves a card out of the column it is displayed in, so the analysis is blind to its own staged cards and the Planned column silently hides them; the pass pulls 1.6 MB of whole-board JSON to reach 28 KB of signal; it re-extracts write sets from roughly 50 plan files on every run and then discards them; and its only recommendation for conflicting candidates is resolve-conflicts-and-re-analyze, a dead end when the actual fix is per-feature worktree isolation that the product already supports. All four plans edit the same dispatch-analysis skill file and explicitly reference each other's ordering and migration numbering.

## How the Subtasks Achieve This

- **Staging is a filter, not a column**: replaces the stored `DISPATCH` column value with a `plans.staged_at` stamp (migration V60) plus a legacy alias normalised on every read, so staged plans never leave `PLAN REVIEWED`. This deletes roughly twenty webview remapping sites, removes the `_getNextColumnId` workaround in `sendDispatchToCoder`, and — the point for this feature — makes the analysis pass able to see the cards it staged, because they are still in the column it queries.
- **Dispatch-Analysis Reads the Per-Column Board Mirror**: re-points step 1 at `.switchboard/kanban-state-plan-reviewed.md`, which the extension already writes atomically on every board change, with `/kanban/plans?column=` as the documented fallback for the `boardStateExport: control-plane` case. It also fixes a quote-escaping bug in the `subtask-of:` marker that becomes load-bearing the moment the skill starts parsing it.
- **Cache plan write-sets in kanban.db**: adds a `plan_write_sets` table (migration V61) keyed on plan-file mtime and size, with an `extractor_version` gate for skill-rule drift and a pre-move staleness re-check, so a run reads only the plan files that actually changed. The agent stays the extractor — deciding which files a plan *writes* rather than merely cites is a judgement over prose — and the extension owns storage and invalidation.
- **Dispatch analysis should recommend (and create) per-feature worktrees**: extracts `createWorktreeForFeature` into a single provider method shared by the webview and a new `POST /worktree/feature`, carries `FEATURE_WORKTREE_MODE=` into the prompt from one resolver used by both hosts, and adds the entanglement classification plus the offer to the skill — turning a dead-end verdict into an actionable escape hatch.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Dispatch-Analysis Reads the Per-Column Board Mirror Instead of Pulling the Whole Board as JSON](../plans/feature_plan_20260810173147_dispatch-analysis-reads-the-board-mirror-not-a-full-json-board-dump.md) — **PLAN REVIEWED** — ID: a0fd641d-7b2d-4d7c-a474-f4352afadf81
- [ ] [Cache plan write-sets in kanban.db so dispatch-analysis stops re-reading the whole backlog](../plans/feature_plan_20260811094600_cache-plan-write-sets-for-dispatch-analysis.md) — **PLAN REVIEWED** — ID: c7750989-c3ca-48fc-b42b-0574bd8ff7ba
- [ ] [Dispatch analysis should recommend (and be able to create) per-feature worktrees when candidates are too entangled](../plans/feature_plan_20260811143000_dispatch-analysis-worktree-recommendation.md) — **PLAN REVIEWED** — ID: 19ea4704-27e9-4011-a0a5-e24c39a13bb4
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Strict order, stated in the plans themselves.** All four edit `.agents/skills/dispatch-analysis/SKILL.md` and two of them claim migration numbers.

1. **Staging is a filter, not a column** — first. It takes migration **V60**, rewrites the skill's step 5 from a card move to a stamp, and removes the invisibility that the other read-side work would otherwise have to reason around. Its own plan says explicitly: land this before the two sibling skill plans.
2. **Dispatch-Analysis Reads the Per-Column Board Mirror** — second. It rewrites step 1's read and the Rules section.
3. **Cache plan write-sets in kanban.db** — third of the skill trio, and it says so: it takes migration **V61**, and its step-2 rewrite should be authored once against the other two's final shape rather than rebased through them. **If staging is dropped or reordered, renumber this to V60 — do not leave a gap.**
4. **Per-feature worktree recommendation** — touches a different part of the skill (new steps 4a, 6a, 6b and two new Rules), so it can land in parallel with the read-side plans, but after staging so it is written against the stamp rather than the retired column.

**Never edit a shipped `MIGRATION_Vnn_SQL` body.** V20–V59 are historical; add V60 and V61 only.

**The two things that must not be traded away**, both because they fail silently and both because they defeat the pass's core guarantee:
- Staging's migration must carry **the stamp as well as the column**, and the legacy alias must ship **with** the one-shot UPDATE. `kanban.db` syncs across machines and roughly 4,000 installs are on older versions — a migration that has already run cannot catch the `DISPATCH` row that arrives tomorrow.
- The write-set cache's `extractor_version` gate and its pre-move staleness re-check. Without either, a stale hit can put two coders in the same file while the pass reports success — strictly worse than today's slow-but-honest behaviour.

**Cross-feature contention — resolved at HEAD (re-verified 2026-08-14).** *Staging is a filter* rewrites the terminals kanban-pane picker, `bodySig` and the card fetch path, and previously had to serialise against unshipped `ALL CODED` aggregate work in the same regions. **That work has landed:** `AGGREGATE_CODED_ID = 'CODED_AUTO'` is live in `src/webview/terminals.js:4920` with its picker substitution, snap-back, aggregate fetch and `columnLabelForId` branch, and `bodySig` already carries `c.column`. There is no longer a race to coordinate — the staging plan's change 5 has been rewritten to adopt the shipped conventions verbatim, including the two places it should deliberately *diverge* from them (append rather than substitute, since staged plans are a subset of Planned; and no snap-back, since nothing withdraws the option).

**Superseded work — already done.** The staging plan declared `feature_plan_20260811094500_dispatch-analysis-blind-to-already-staged-cards.md` superseded and to be deleted rather than implemented. That file no longer exists in `.switchboard/plans/`; the disposition is settled and no board action remains. The write-set cache plan's reference to it as "the occupancy fix goes first" has been corrected to name the staging plan instead.

**Contradictions reconciled across the set (2026-08-14 improve-feature pass).** Four, all now single-valued:
1. **The `.claude` mirror.** Staging and cache both claimed `.claude/skills/dispatch-analysis/SKILL.md` is generated and gated by `npm run mirror:check`; the worktree plan claimed the opposite. The worktree plan is right — the directory does not exist and the gate never sees the file. All three now say so. The compensating gate is `src/test/dispatch-analysis-scope-contract.test.js`. Note `switchboard-orchestration/SKILL.md`, which the worktree plan also edits, **is** mirrored and gated — the two skills have opposite mirror status.
2. **Step 5's verb.** The board-mirror and worktree plans described step 5 as a card move to `DISPATCH`. Staging retires that column and lands first, so both are now written against the stamp: "staged in place", "not staged", and a write-endpoint test assertion loose enough to survive the swap.
3. **Prompt-layout ownership.** The board-mirror plan declares "no prompt-body change" and leaves the `API_PORT=…\nPROJECT=…\n\nPLANS TO PROCESS:` byte-layout assertions alone; the worktree plan inserts a `FEATURE_WORKTREE_MODE=` line into exactly that layout. The worktree plan is now the sole owner of updating those assertions, stated in both files.
4. **`sendToDispatch` does not exist.** The staging plan proposed renaming it; there is no such verb at HEAD. `setStaged` / `clearStaged` are net-new (allowlist + schema + return-in-body), and the two paths that *actually* stage cards — `POST /kanban/move` with `targetColumn: 'DISPATCH'`, and the drag-into-Dispatch-view write mapping at `kanban.html:8128-8130` — are now explicitly in scope.

**Line numbers across all four plans were re-verified against HEAD** and corrected. `kanban.html` and `terminals.js` moved by several hundred to ~2,400 lines during panel extraction; `KanbanProvider.ts` by ~250. Treat the numbers as anchors and grep the named symbol first.

**Generated mirrors:** edit `.agents/skills/dispatch-analysis/SKILL.md` only. The `.claude/skills/` copy is generated and `npm run mirror:check` is a CI gate.
