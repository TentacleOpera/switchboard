# Kanban & Features Tab Button UI Overhaul

## Metadata
**Complexity:** 7
**Tags:** frontend, ui, ux, bugfix, refactor, backend, api
**Project:** Browser Switchboard

## Goal

Restore sanity to the button layout in `project.html`'s Kanban Plans and Features tabs. The current UI has redundant buttons (Copy Link/Copy Prompt duplicated between card and meta bar), misplaced controls (Edit next to AutoFetch instead of Complexity; Review in the global strip when it's a per-item action), unaligned control sets between the two tabs, a confusingly-named "Refine" button that copies the wrong workflow, missing complexity indicators on features, and several bugs (duplicate COMPLETED dropdown entry, unstyled dropdown, hardcoded acceptance-test label).

### Problem Analysis & Root Cause

**Root cause:** The button layout grew incrementally without a shared control-placement contract. Each tab's card/meta-bar/global-strip was edited independently, producing drift. Specific root causes:

1. **Copy Link/Copy Prompt duplication** — A comment at `project.js:2058` explicitly says these were "promoted into the top bar so the user does not have to locate the plan in the sidebar." This was an additive change that never removed the card-level buttons, creating permanent duplication.
2. **Edit placement** — Edit was added to both the card (line 1736) and the meta bar's right group (line 2036, next to AutoFetch/Log/Delete) because the meta bar's right group was the "actions" bucket. No one moved it next to Complexity (the left group) because the left group was reserved for metadata display.
3. **Review in global strip** — Review mode was implemented as a global strip toggle (lines 1249, 1320) because it was ported from `planning.html` where it was a page-level control. But in the kanban/features context, review applies to the currently-selected plan/feature, not the page.
4. **Refine vs Improve confusion** — `refine_feature` (`.agents/skills/refine_feature.md`) and `improve-feature` (`.agents/skills/improve-feature/SKILL.md`) are **different skills**: refine is non-destructive initial fleshing-out of thin features; improve is destructive restructuring of existing subtasks. The UI button was wired to `refineFeature` (copies refine_feature.md), but the user expects it to copy the improve-feature workflow. There is no webview handler for improve-plan or improve-feature prompt copying at all — both are extension-dispatched only.
5. **No complexity on features** — Feature cards render subtask plans but never aggregate or display complexity. The features global strip lacks a complexity filter. The subtask meta bar (line 2640) does show complexity for individual subtasks, but the feature card and feature-level view have nothing.
6. **Duplicate COMPLETED** — `project.js:2021` hardcodes `<option value="COMPLETED">COMPLETED</option>` after mapping `_kanbanAvailableColumns`, which already includes COMPLETED (from `agentConfig.ts:139`).
7. **Unstyled dropdown** — `.kanban-meta-dropdown` class has no CSS definition in `project.html`. The generic select styling (line 129) only targets `.kanban-controls-strip select` and `.controls-strip select`, not the preview panel.
8. **Hardcoded acceptance-test label** — `_featureCopyPromptLabel` (line 2389) returns `'Copy Acceptance Test Prompt'` for any subtask in `CODE REVIEWED`, regardless of whether an `ACCEPTANCE TESTED` column or acceptance-tester agent exists.

### Background Context

- `project.html` (1590 lines) holds the static HTML shell: global control strips, preview panel containers, modals.
- `project.js` (195K) holds all render logic: card templates (`renderKanbanPlanList`, `renderFeaturesList`), meta bars (`renderKanbanMetaBar`, `renderFeatureMetaBar`, `renderFeatureSubtaskMetaBar`), and event wiring.
- Backend handlers live in `src/services/KanbanProvider.ts` (kanban messages) and `src/services/PlanningPanelProvider.ts` (feature/refine messages).
- The `refineFeature` handler (`PlanningPanelProvider.ts:6674-6723`) reads `.agents/skills/refine_feature.md`, builds a prompt, copies to clipboard. No equivalent exists for improve-plan or improve-feature.

## Changes

### 1. Kanban Plans Tab — Button Reorganization

#### 1a. Remove Copy Link + Copy Prompt from kanban meta bar
- **File:** `project.js`, `renderKanbanMetaBar()` (lines 2032-2033)
- Remove the two `<button>` elements for `kanban-meta-copy-link-btn` and `kanban-meta-copy-prompt-btn` from the Complexity group.
- Remove their event listeners (lines 2060-2081).
- These buttons remain in the sidebar card (lines 1734-1735).

#### 1b. Remove Edit from kanban plan cards
- **File:** `project.js`, card template (line 1736)
- Remove `${plan.planFile ? \`<button class="kanban-plan-edit">Edit</button>\` : ''}` from the card's `.kanban-plan-actions` div.
- Remove the edit button event listener (lines 1797-1812).
- Edit remains only in the meta bar.

#### 1c. Move Edit in meta bar next to Complexity
- **File:** `project.js`, `renderKanbanMetaBar()` (lines 2035-2036)
- Move the Edit/Save/Cancel buttons from the right `kanban-meta-group` (currently grouped with AutoFetch/Log/Delete) into the Complexity group (after the complexity select, line 2031).
- The right group keeps only: Upload (conditional), AutoFetch, Log, Delete.
- Edit should sit immediately after the complexity dropdown, before `margin-left: auto` pushes the right group.

#### 1d. Move Review from global strip to meta bar
- **File:** `project.html` (line 1249) — remove `<button id="btn-review-kanban">` from the global controls strip.
- **File:** `project.js`, `renderKanbanMetaBar()` — add a Review button to the meta bar (right group, after Delete or before it). Wire it to the same `review-mode-btn` class and toggle logic.
- Move the existing `btn-review-kanban` event listener to reference the new dynamic element (or use event delegation).

#### 1e. Add Improve button to kanban global strip
- **File:** `project.html` (line 1248 area) — add `<button id="btn-improve-kanban" class="strip-btn" title="Copy the improve-plan workflow prompt to clipboard">Improve</button>` to the global strip.
- **File:** `project.js` — wire `btn-improve-kanban` to send `{ type: 'improvePlan', planId, planFile, topic, workspaceRoot }` using the currently selected plan (`_kanbanSelectedPlan`). Disable when no plan is selected.
- **File:** `src/services/KanbanProvider.ts` — add `case 'improvePlan'` handler: read `.agents/skills/improve-plan/SKILL.md` (with embedded fallback), build prompt with plan details, copy to clipboard, show notification "Improve-plan prompt copied to clipboard."

### 2. Features Tab — Button Reorganization + Complexity

#### 2a. Add complexity dot to feature cards
- **File:** `project.js`, `renderFeaturesList()` (around line 2415)
- Compute an aggregate complexity from the feature's subtasks (use **max** subtask complexity — the highest-risk subtask determines the feature's complexity tier).
- Add a `<span class="complexity-dot ${complexityClass}">` to the feature card's action row, mirroring the kanban plan card (line 1737).
- The complexity dot should use `margin-left: auto` to right-align, same as kanban cards.

#### 2b. Add complexity filter to features global strip
- **File:** `project.html` (line 1318 area) — add `<select id="features-complexity-filter">` with the same options as `kanban-complexity-filter` (lines 1239-1245).
- **File:** `project.js` — add `featuresComplexityFilter` element reference, wire change event to filter `_featuresCache` by aggregate complexity, re-render list. Mirror the kanban complexity filter logic (lines 1614-1621).

#### 2c. Rename Refine → Improve (context-aware: improve-feature or refine_feature)
- **File:** `project.js`, `renderFeatureMetaBar()` (line 2561) — change button label from "Refine" to "Improve", change id from `btn-feature-refine` to `btn-feature-improve`, change title to "Copy the improve-feature workflow prompt to clipboard."
- **File:** `project.js` (lines 2576-2589) — change message type from `'refineFeature'` to `'improveFeature'`. Include `subtaskCount` in the message payload (already present at line 2586).
- **File:** `src/services/PlanningPanelProvider.ts` (lines 6674-6723) — repurpose the `refineFeature` case into `improveFeature` with **context-aware skill selection**:
  - If `subtaskCount > 0`: read `.agents/skills/improve-feature/SKILL.md`, build prompt, copy to clipboard, notification "Improve-feature prompt copied to clipboard."
  - If `subtaskCount === 0`: read `.agents/skills/refine_feature.md`, build prompt, copy to clipboard, notification "Improve-feature prompt copied to clipboard." (The button label stays "Improve" — the user doesn't see the skill name; the backend picks the right one silently.)
  - Both branches use the same embedded-fallback pattern as the existing handler.
- **Why context-aware:** improve-feature requires existing subtasks (Step 1 expands the feature into its subtasks; an empty set has nothing to improve or reconcile). refine_feature is for features with zero subtasks — it fleshes out the description and proposes a subtask breakdown. The user sees one "Improve" button; the backend routes to the correct skill based on subtask count.
- **Note:** The `refine_feature.md` skill file stays in `.agents/skills/` for this context-aware path and for backend/extension dispatch. The old `refineFeature` message type is replaced by `improveFeature` (which subsumes both cases).

#### 2d. Move Review from global strip to feature meta bar
- **File:** `project.html` (line 1320) — remove `<button id="btn-review-features">` from the global controls strip.
- **File:** `project.js`, `renderFeatureMetaBar()` — add a Review button to the feature meta bar. Wire to the same review-mode toggle logic.
- Also add Review to `renderFeatureSubtaskMetaBar()` (line 2631) so subtask preview has review access.

#### 2e. Fix `_featureCopyPromptLabel` — gate on next column existence
- **File:** `project.js`, `_featureCopyPromptLabel()` (lines 2378-2399)
- Replace the hardcoded `CODE REVIEWED → 'Copy Acceptance Test Prompt'` branch (line 2389) with logic that:
  1. Finds the next actionable column (using the same logic as `_optimisticNextColumn`, lines 1763-1772).
  2. If no next column exists (plan is at the last column before COMPLETED, or in a terminal lane), return `null` — no copy-prompt button is rendered.
  3. If the next column is `ACCEPTANCE TESTED` (and it exists in `_kanbanAvailableColumns`), return `'Copy Acceptance Test Prompt'`.
  4. Otherwise, derive the label from the next column's kind/role (mirroring kanban.html's logic at lines 6278-6296).
- This also fixes the "Copy Acceptance Test Prompt shows with no acceptance tester" bug — if there's no ACCEPTANCE TESTED column, the next column after CODE REVIEWED would be whatever actually follows, and the label derives from that.

### 3. Dropdown Bug Fixes

#### 3a. Remove duplicate COMPLETED from column dropdown
- **File:** `project.js`, `renderKanbanMetaBar()` (line 2021)
- Remove the hardcoded `<option value="COMPLETED">COMPLETED</option>` line. `_kanbanAvailableColumns` already includes COMPLETED.
- Keep the `<option value="__delete__">— Delete Plan —</option>` line.

#### 3b. Add CSS for `.kanban-meta-dropdown`
- **File:** `project.html` — add a CSS rule for `.kanban-meta-dropdown` matching the generic select styling (line 129):
  ```css
  .kanban-meta-dropdown {
      background: #111;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--font-mono);
  }
  ```
- This applies to both `kanban-meta-column-select` and `kanban-meta-complexity-select` (and the feature subtask equivalents), which all use the `kanban-meta-dropdown` class.

### 4. Control Alignment Between Tabs

After the changes above, both tabs' global strips should have:
- Workspace filter, Project filter, Column filter, Complexity filter
- Tab-specific action buttons (Kanban: Import, Create, Chat Prompt, Improve; Features: + New Feature, Improve)
- **No** Review button (moved to per-item meta bars)

Both tabs' meta bars should have:
- Metadata group (Column + Complexity for plans; Complexity for features/subtasks)
- Edit/Save/Cancel next to Complexity
- Review button
- Right group: tab-specific actions (Kanban: AutoFetch, Log, Delete; Features: + Subtask, Delete Feature / Remove, Delete)

## Verification Plan

1. **Visual check — Kanban Plans tab:**
   - Sidebar cards show: column badge, Copy Link, Copy Prompt, complexity dot. **No Edit button.**
   - Meta bar shows: Column group, Complexity group (with Edit/Save/Cancel next to complexity), Review button, right group (AutoFetch, Log, Delete). **No Copy Link/Copy Prompt in meta bar.**
   - Global strip shows: filters (workspace, project, column, complexity), Import, Create, Chat Prompt, Improve. **No Review in global strip.**
   - Column dropdown in meta bar: no duplicate COMPLETED, properly styled.

2. **Visual check — Features tab:**
   - Feature cards show: column badge, Copy Link, Copy Prompt (dynamic label), Send to Planner (conditional), complexity dot (right-aligned). **No Edit, no Refine.**
   - Feature meta bar shows: Edit/Save/Cancel, **Improve** (not Refine), + Subtask, Review, Delete Feature.
   - Subtask meta bar shows: Complexity, Copy Link, Edit/Save/Cancel, Review, Remove, Delete.
   - Global strip shows: filters (workspace, project, column, **complexity**), + New Feature. **No Review in global strip.**

3. **Functional checks:**
   - Click Improve in kanban global strip → clipboard contains improve-plan workflow prompt with plan details.
   - Click Improve in feature meta bar on a feature WITH subtasks → clipboard contains improve-feature workflow prompt with feature details.
   - Click Improve in feature meta bar on a feature with ZERO subtasks → clipboard contains refine_feature workflow prompt (fleshes out description + proposes subtasks). Button label is "Improve" in both cases.
   - Copy Prompt button on a feature subtask in CODE REVIEWED with no ACCEPTANCE TESTED column → button shows the correct label for the actual next column (or no button if terminal).
   - Copy Prompt button on a plan at the last column before COMPLETED → no copy-prompt button rendered.
   - Column dropdown: only one COMPLETED entry, styled correctly.

4. **Regression:**
   - Existing Copy Link / Copy Prompt on cards still work.
   - Edit in meta bar still enters edit mode.
   - Review toggle still works from meta bar.
   - Complexity filter on features tab filters correctly.
