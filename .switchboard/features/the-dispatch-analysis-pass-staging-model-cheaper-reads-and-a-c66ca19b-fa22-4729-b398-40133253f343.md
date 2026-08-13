# The Dispatch-Analysis Pass: Staging Model, Cheaper Reads, and a Worktree Escape Hatch

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
- [ ] [Dispatch-Analysis Reads the Per-Column Board Mirror Instead of Pulling the Whole Board as JSON](../plans/feature_plan_20260810173147_dispatch-analysis-reads-the-board-mirror-not-a-full-json-board-dump.md) — **PLAN REVIEWED**
- [ ] [Cache plan write-sets in kanban.db so dispatch-analysis stops re-reading the whole backlog](../plans/feature_plan_20260811094600_cache-plan-write-sets-for-dispatch-analysis.md) — **PLAN REVIEWED**
- [ ] [Staging is a filter, not a column — retire DISPATCH in favour of a per-plan staged stamp](../plans/feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md) — **PLAN REVIEWED**
- [ ] [Dispatch analysis should recommend (and be able to create) per-feature worktrees when candidates are too entangled](../plans/feature_plan_20260811143000_dispatch-analysis-worktree-recommendation.md) — **PLAN REVIEWED**
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

**⚠ Cross-feature contention.** *Staging is a filter* also rewrites the terminals kanban-pane picker, `buildColumnList`, `bodySig` and the card fetch path — the same regions that the **Terminals Panel: Pane Seating and Shared Column Derivation** feature's extraction plan rewrites. The two must serialise on `src/webview/terminals.js`, and whichever lands second adopts the first's synthetic-id and `bodySig` conventions rather than inventing a parallel one. Coordinate across the two features before either starts.

**Superseded work:** the staging plan declares `feature_plan_20260811094500_dispatch-analysis-blind-to-already-staged-cards.md` superseded and to be **deleted, not implemented** — it works around the invisibility staging removes. That plan is not part of this feature; confirm its disposition on the board.

**Generated mirrors:** edit `.agents/skills/dispatch-analysis/SKILL.md` only. The `.claude/skills/` copy is generated and `npm run mirror:check` is a CI gate.
