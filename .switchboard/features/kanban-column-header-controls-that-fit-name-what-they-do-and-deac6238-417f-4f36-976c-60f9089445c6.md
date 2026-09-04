# Kanban Column Header: Controls That Fit, Name What They Do, and Report Honestly

<!-- board-collapse-membership -->
> **MEMBERSHIP CORRECTED 2026-09-04 (Board Collapse audit). Two subtasks, not three.**
> 
> *Copy Dispatch Prompt must not flash "Copied!" on every card's coder-prompt button* was **merged into `feature_plan_20260820074420_copy-prompt-button-feedback-fires-late-and-flashes-green.md` and deleted**. Both were about what the copy affordance says when it fires, from two different features.
> 
> Dependencies still lists it as item 3 with a scope estimate. **That deliverable is not gone, it moved**: the merge target owns both the press-feedback shape and the batch case, deleting the per-card `copyPlanLinkResult` loop so a batch copy stops flashing every card in the column. Do not schedule it from here.


**Complexity:** 6

## Goal

Repair the board's column header action row on three axes at once. The Planned column renders six fixed 32px icon buttons needing 248px (192px of icons + 30px of gaps + 24px of row padding + the column's own 2px border) while the column floor is 220px, so the sixth wraps to a second line and misaligns every card body across the board. The Created column's only bespoke button creates a subtask-less ghost feature, while the planner fan-out that is already implemented and reviewed has no button at all and runs only as a hidden side effect of Move Selected. And Copy Dispatch Prompt flashes a green Copied label on every card's per-card coder-prompt button for a prompt that was never copied per card, teaching the user that a coder prompt is on the clipboard when a batch planner prompt is. All three edit the same column-button-area template and its surrounding render pass.

## How the Subtasks Achieve This

- **The Kanban Column Floor Is Narrower Than Its Own Icon Row**: publishes the icon geometry as CSS custom properties on `.kanban-board` and derives `min-width` from the icon count the render pass just counted in the HTML it built, so adding a button to a column header can never silently re-introduce the two-line wrap. It also makes the header row shrink-safe (ellipsised label, non-shrinking right group), removing the whole overflow class rather than one instance of it.
- **Replace the Created Column's Blank-Feature Button with "Send N plans to planner team"**: retires the button that creates a subtask-less ghost feature and adds an explicit, count-labelled verb that calls `_distributePlannerDispatch` directly — so a configured single-target dispatch on the Planned column can no longer silently preempt the fan-out. Critically, it resolves the planner pool the way the dispatcher does (`getRoleTerminalSet` with `allowPtyFleet: true`) rather than through either look-alike — `getAliveRoleTerminalNames`, which reports zero while six planners are live, or the existing `getPlannerTerminalCount`, which is a 1..5 config field that never reports zero. It also patches the button's count in place on every refresh, because the column header shell is not rebuilt when the board refreshes.
- **Copy Dispatch Prompt must not flash "Copied!"**: deletes the per-card `copyPlanLinkResult` loop inherited from `promptSelected` into the `copyDispatchPromptSelected` arm, leaving the batch-shaped status message and the clicked column button's own flash — both of which are already wired — as the honest feedback.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Kanban Column Floor Is Narrower Than Its Own Icon Row](../plans/feature_plan_20260812190008_kanban-column-floor-fits-the-six-icon-header-row.md) — **PLAN REVIEWED** — ID: 9cce22bd-79a2-448f-b89b-5d6e6154f53a
- [ ] [Replace the Created Column's Blank-Feature Button with an Explicit "Send N plans to planner team"](../plans/feature_plan_20260812150700_kanban-created-send-plans-to-planner-team.md) — **PLAN REVIEWED** — ID: 46eafd1c-34f0-40e0-866d-01f1f7aef715
<!-- END SUBTASKS -->

## Dependencies & sequencing

**⚠ The first two subtasks collide directly and must be ordered.** Both edit the Created column's entry in the `buttonArea` template literal in `src/webview/kanban.html:6394-6403`: the fan-out plan **deletes** `featureAddBtn` and interpolates a new text button in its place, while the column-floor plan rewrites that same template (dropping its inline style) and adds a pass that counts `class="column-icon-btn"` occurrences in the built HTML to set the floor.

1. **The Kanban Column Floor first.** It is a self-contained presentation change — five CSS declarations plus roughly six lines in `renderColumns()` — and it establishes the counting pass and the token block.
2. **Send N plans to planner team second**, written against the derived floor.

   > **Superseded:** "Its new button is a `width:auto` text control, **not** a 32px `column-icon-btn`, so it must not be counted by the floor's regex."
   > **Reason:** written from the subtask's intent rather than its markup. The button carries `class="column-icon-btn"` (matching the existing `btn-send-dispatch-set` idiom at `kanban.html:6392`), so the floor's regex **does** count it. An implementer following this note would have gone looking for a regex bug that does not exist.
   > **Replaced with:** the button is counted, and that is fine. `class="column-icon-btn"` is already worn by three text-shaped controls (`btn-add-coder-terminal`, `btn-send-dispatch-set`, and now this one), so the count over-states those columns — which inflates the floor and never deflates it, i.e. the safe direction, bounded by the floor plan's `Math.min(8, …)` clamp. Post-change the Created column renders 5 counted controls (4 pipeline + the planner button; `featureAddBtn` gone), below the clamp of 6, so the effective floor stays at **248px**, set by the Planned column. Measure it; do not assume it.
3. **Copy Dispatch Prompt flash** is independent — a four-line deletion in a `KanbanProvider.ts` switch arm plus one new source-reading regression test — and can land at any point. It touches no file the other two touch.

### Reconciled end-state — the `buttonArea` template

Both webview subtasks rewrite the same literal. This is the single agreed result after both land, so neither implementer has to guess at the other's shape:

```js
                    buttonArea = `<div class="column-button-area">
                        ${pipelineButtons}
                        ${analyzeBtn}
                        ${sendDispatchBtn}
                        ${dispatchViewControls}
                        ${julesBtn}
                        ${copyDispatchPromptBtn}
                        ${plannerTeamBtn}
                        ${testingFailBtn}
                    </div>`;
```

`featureAddBtn` is gone; `plannerTeamBtn` occupies its interpolation slot; the inline `style` attribute is gone (its `gap`/`flex-wrap` now live in the `.column-button-area` rule, feeding the floor's `calc()`).

**Resolved — `addBlankFeature` orphans nothing.**

> **Superseded:** "Before deleting `addBlankFeature`: the fan-out plan requires confirming whether another surface offers blank-feature creation. If the Created column was the only entry point, an entry point must be added elsewhere in the same change."
> **Reason:** the question is answerable from the repo and has been answered. It was left open as a gate on work that is not actually blocked.
> **Replaced with:** the Project panel's Features tab already carries `+ New Feature` (`src/webview/project.html:1379`), whose submit handler (`src/webview/project.js:3173-3190`) posts `createFeature` with `subtaskPlanIds: []` and `addToKanbanBoard: true` — a blank feature. The zero-subtask branch of `createFeatureFromPlanIds` also has headless contract coverage (`src/test/headless-feature-management-contract.test.js:259-268`). The Created-column button was a duplicate entry point; delete it outright, and delete the two now-callerless leftovers it leaves behind in `kanban.html` (the `isBlankFeature` early-return in `openFeatureCreateModal` at `:10119-10132`, and the `ICON_CODE_MAP` const at `:5208`). Leave the shared `{{ICON_CODE_MAP}}` placeholder-map entries alone.

**Scoped deletion, not a sweep:** five other `copyPlanLinkResult` emit sites in `promptSelected` / `promptAll` (`KanbanProvider.ts:9901`, `9934`, `9965`, `9972`, `9987`) and the single-card `copyPlanLink` arm (`:10441`) are all legitimate and must survive — those arms genuinely copy the per-card advance prompt and advance the cards. The regression test in that plan asserts both directions.

**Gates (fan-out subtask only):**
- The verb allowlist is **generated**, not hand-maintained: `scripts/generate-protocol-catalog.js` scans the provider switch, `scripts/generate-verb-allowlist.js` emits `src/generated/verbAllowlist.ts`. Add the arm, then run `npm run catalog:generate` and commit both files. A hand-edit fails `npm run catalog:check` in CI.
- Add a `sendCreatedToPlannerTeam` block to `VERB_SCHEMAS.kanban` (PRD contract #5). A missing schema is *silently permissive* (`validateVerbPayload` returns `{ ok: true }` when no schema exists), so nothing will flag the unvalidated boundary.
- Every exit in the new arm must `return`, never `break` — the Kanban ratchet ceiling in `scripts/verb-return-contract-baseline.json` is `1` and `npm run verb-returns:check` is wired into CI.

**Known baseline:** five regression tests are red at HEAD independently of this work. Stash-verify before attributing any red to these changes.
