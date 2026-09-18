# Remove All Plan Dependency Tracking Features

## Goal

Remove the entire plan dependency tracking system from Switchboard: the Dependencies tab in the kanban view, dependency warning badges on kanban cards, the Dependency Check prompt add-on, the Include Dependency Instructions add-on, topological column sorting, all parsing/storage infrastructure, and every related test. Users can communicate ordering through plan naming conventions (Phase 1 / 2 / 3) or worktrees, which the extension already supports.

## Problem Analysis

### Why remove it
The dependency tab showed a flat list of plans with declared `## Dependencies` sections, attempting to visualise blocking relationships. In practice:
- Plans frequently listed themselves as their own dependency (no self-reference guard existed anywhere in the pipeline)
- The AI-authored dependency sections were unreliable — agents would invent or omit entries
- The visual output was a flat list, not a true tree; no actionable insight was provided
- The feature was never used in daily workflow
- Ordering is already communicated through naming conventions (Phase 1/2/3) or via worktrees

### Scope
The removal touches nine source files, two webview files, one config file, and five test files. The database column (`dependencies TEXT`) is left in the SQLite schema to avoid a destructive migration; it will simply no longer be written to or read.

## Metadata

- **Complexity:** 7
- **Tags:** refactor, frontend, backend

## User Review Required

None — this is a removal of an unused feature with no new behaviour introduced.

## Complexity Audit

### Routine
- Delete `src/services/planDependencyParser.ts` and its two test files
- Remove Dependencies tab HTML block and its CSS from `kanban.html`
- Remove `dependency-warning` CSS and the badge render call from card HTML generation
- Remove Dependency Check checkbox from both the standard and custom-agent add-ons UI in `kanban.html`
- Remove `DEPENDENCY_CHECK_DIRECTIVE` constant and its injection sites from `agentPromptBuilder.ts`
- Remove `dependencyCheckEnabled` from `agentConfig.ts` and `sharedDefaults.js`
- Remove `dependencyCheckEnabled` from `package.json` contributes.configuration
- Remove dependency extraction block from `planMetadataUtils.ts`
- Remove `dependencies` field from `PlanMetadata` interface
- Remove `includeDependencyInstructions` addon from `sharedDefaults.js` and `KanbanProvider.ts`
- Remove `includeDependencyInstructions` option from `agentPromptBuilder.ts`

### Complex / Risky
- **`TaskViewerProvider.ts`** — the largest cleanup; ~20+ scattered call sites including `_checkDependenciesBeforeDispatch()` (a dispatch gate), `_parsePlanDependencies()`, `_isDependencyCheckEnabled()`, `handleRebuildDependencyMap()`, mirror-sync writes, plan extraction, ClickUp subtask linking, review UI HTML generation, and `setDependencies` handler. Each must be removed without breaking adjacent logic.
- **`KanbanProvider.ts`** — dependency parsing on card load, `hasBlockingDependencies` flag, `_calculateBlockingDependencies()` method, `_sendDependencyMapData()` method, `getDependenciesFromPlan()` method, `dependencyMapData` push to webview, auto-refresh of dep tab alongside board refresh, sheet-data parsing, and `includeDependencyInstructionsByRole` config resolution. Must leave board refresh intact.
- **`KanbanDatabase.ts`** — remove `dependencies` field from `KanbanPlanRecord` interface and all UPSERT/SELECT column references; remove `updateDependenciesByPlanFile()`, `updateDependencies()`, `getDependencyStatus()`, and `getPlansWithDependencies()` methods. The physical DB column is left in place (SQLite DROP COLUMN requires table recreation; the orphaned column is harmless).
- **`GlobalPlanWatcherService.ts`** — three write sites for `dependencies` metadata plus ClickUp sync field; remove without disrupting the surrounding metadata upsert calls and ClickUp sync contract.
- **`kanban.html` JS** — `resolveCardDependencies()`, `sortColumnByDependencies()`, `dependencyMapData` message handler, `renderDependencyTree()` / `detectCyclesForDeps()` are each standalone functions but call sites are scattered across board render and column sort paths. Column sort fallback must be replaced with standard alphabetical sort.
- **`agentPromptBuilder.ts`** — `includeDependencyInstructions` parameter and DEPENDENCY_ORDER block (lines 418-428) must be removed alongside `DEPENDENCY_CHECK_DIRECTIVE`. The `depSection` variable and its concatenation into the prompt must be removed.
- Test cleanup spans 5 files; some (e.g. `prompts-tab-move-regression.test.js`) only have a small dependency-related assertion block that must be surgically removed without breaking the rest of the test.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is a removal-only operation with no concurrent state changes.
- **Security:** No security implications. Removing dependency tracking removes no auth or access control.
- **Side Effects:**
  - ClickUp subtask auto-linking (TaskViewerProvider lines 4440, 4607) currently sets `dependencies` to the parent plan file. After removal, subtasks will not have a `dependencies` field linking them to parents. The parent-child relationship is already captured in ClickUp's own task hierarchy, so this is acceptable.
  - ClickUp `debouncedSync()` call at GlobalPlanWatcherService line 493 passes `plan.dependencies`. After removal, this field will be absent from the sync payload. The ClickUp service should handle this gracefully (generic object), but the field should be removed from the call for cleanliness.
  - Column sort fallback: `sortColumnByDependencies()` at kanban.html line 4885 is called for CREATED and PLAN REVIEWED columns. After removal, these columns must fall back to the same alphabetical sort used for other columns.
  - `_checkDependenciesBeforeDispatch()` at TaskViewerProvider line 15244 is a dispatch gate. Removing it means plans with declared dependencies will no longer be blocked from dispatch. Since the dependency data was unreliable, this is the correct behaviour.
- **Dependencies & Conflicts:** No other features depend on the dependency tracking system. The `includeDependencyInstructions` addon is a parallel config path that feeds the same feature and must be removed alongside `dependencyCheckEnabled`.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) Missing removal sites in KanbanProvider (`_calculateBlockingDependencies`, `_sendDependencyMapData`, `getDependenciesFromPlan`) and TaskViewerProvider (`_parsePlanDependencies`, `_isDependencyCheckEnabled`, `handleRebuildDependencyMap`, `setDependencies` handler) could leave dead code that references deleted interfaces. (2) The `includeDependencyInstructions` addon is a parallel config path completely missed in the original plan — it controls the DEPENDENCY ORDER section in dispatch prompts and must be removed alongside `dependencyCheckEnabled`. (3) SQL column handling: removing `dependencies` from INSERT columns but leaving `dependencies = excluded.dependencies` in ON CONFLICT UPDATE will cause a runtime error — both must be removed together while keeping the CREATE TABLE column definition (with DEFAULT ''). Mitigations: verified all sites against actual source; added `includeDependencyInstructions` removal steps; clarified SQL handling approach.

## Implementation Plan

### Step 1 — Delete standalone files
- Delete `src/services/planDependencyParser.ts`
- Delete `src/test/plan-dependency-parser.test.js`
- Delete `src/test/kanban-dependency-ordering.test.js`

### Step 2 — `agentPromptBuilder.ts`
- Remove `DEPENDENCY_CHECK_DIRECTIVE` export constant (line 289)
- Remove `dependencyCheckEnabled` option from `PromptBuilderOptions` interface (line 92)
- Remove `includeDependencyInstructions` option from `PromptBuilderOptions` interface (line 131)
- Remove the `depSection` / DEPENDENCY_ORDER block that injects dep ordering into dispatch prompts (lines 417–428: `plansWithDeps` filter, `depSection` ternary, and its concatenation into the prompt)
- Remove the `includeDependencyInstructions` read from options (line 381)
- Remove the two conditional appends of `DEPENDENCY_CHECK_DIRECTIVE` to planner and custom workflow prompts (lines 468–470, 1258)

### Step 3 — `agentConfig.ts`
- Remove `dependencyCheckEnabled?: boolean` from `CustomAgentAddons` interface (line 17)
- Remove the config mapping entry for `dependencyCheckEnabled` (line 164)

### Step 4 — `sharedDefaults.js`
- Remove the `dependencyCheck` addon from `DEFAULT_ROLE_CONFIG` planner defaults (line 22)
- Remove the `dependencyCheck` entry from `ROLE_ADDONS.planner` array (line 65)
- Remove the `includeDependencyInstructions` addon from `DEFAULT_ROLE_CONFIG` lead, coder, intern defaults (lines 24, 25, 28)
- Remove the `includeDependencyInstructions` entries from `ROLE_ADDONS.lead`, `ROLE_ADDONS.coder`, `ROLE_ADDONS.intern` arrays (lines 89, 108, 158)

### Step 5 — `planMetadataUtils.ts`
- Remove `dependencies: string` from `PlanMetadata` interface (line 29)
- Remove the dependency extraction block (lines 94–110)
- Remove `dependencies` from the returned object literal (line 123)

### Step 6 — `KanbanDatabase.ts`
- Remove `dependencies: string` from `KanbanPlanRecord` interface (line 28)
- Remove `dependencies` from INSERT column list (line 456) and corresponding VALUES placeholder (one fewer `?`)
- Remove `dependencies = excluded.dependencies` from ON CONFLICT UPDATE clause (line 470)
- Remove `dependencies` from `PLAN_COLUMNS` SELECT list (lines 490–493)
- Remove `dependencies: String(row.dependencies || "")` from `_readRows()` row mapping (line 4697)
- Remove `updateDependenciesByPlanFile()` method (lines 1391–1397)
- Remove `updateDependencies()` method (lines 1399–1404)
- Remove `getDependencyStatus()` method (lines 1532–1563)
- Remove `getPlansWithDependencies()` method (lines 2289–2311)
- Leave the `dependencies TEXT DEFAULT ''` column in the CREATE TABLE (line 100) and ALTER TABLE migration (line 189) — removing them would require coordinated schema version bumps and table recreation for no gain. New rows get DEFAULT '' automatically.

### Step 7 — `GlobalPlanWatcherService.ts`
- Remove the three `dependencies: metadata.dependencies` lines in upsert calls (lines 442, 469)
- Remove `dependencies: plan.dependencies` from ClickUp `debouncedSync()` call (line 493)

### Step 8 — `KanbanProvider.ts`
- Remove `dependencies: string[]` and `hasBlockingDependencies: boolean` from `KanbanCard` interface (lines 92–93)
- Remove the CSV-to-array parsing of dependencies on card load (lines 1116–1118, 1886–1888, 2050–2052)
- Remove `dependencies` and `hasBlockingDependencies` from card object literals in all three refresh paths (lines 1130–1131, 1146–1147, 1900–1901, 2064–2065)
- Remove `_calculateBlockingDependencies()` calls (lines 1150, 1925, 2084) and the entire method definition (lines 1746–1768)
- Remove `_sendDependencyMapData()` calls (lines 2144, 4507, 4511) and the entire method definition (lines 2163–2173)
- Remove `getDependenciesFromPlan()` method definition (line 3709)
- Remove `dependencies: card.dependencies?.join(', ')` from promptPlans construction (line 2253)
- Remove the `getDependencyMapData` message handler case (lines 4481–4514)
- Remove the `rebuildDependencyMap` message handler case (lines 4516–4524)
- Remove `dependencyCheckEnabled` read from config (line 2500), default resolution (line 2608), and save with persistence verification (lines 2951–2957)
- Remove `includeDependencyInstructions` from resolved options (line 2488) and `includeDependencyInstructionsByRole` config resolution (lines 2746–2749)
- Remove sheet-data dependency parsing in `_sheetToCard()` (lines 3555–3570)
- Remove dependency rebuild prompt generation (lines 4491–4504)

### Step 9 — `ReviewProvider.ts`
- Remove `dependencies: string[]` from `ReviewTicketData` type (line 55)
- Remove `'setDependencies'` from `ReviewTicketUpdateRequest` type union (line 65)
- Remove `dependencies?: string[]` field from `ReviewTicketUpdateRequest` interface (line 69)
- Remove `case 'setDependencies'` from message handler (line 236)
- Remove `dependencies: []` default initialization (line 416)
- Remove `dependencies` from the ticket update pass-through in `_applyTicketUpdate` (lines 510–516)

### Step 10 — `TaskViewerProvider.ts`
- Remove all `dependencies` field reads/writes in plan record creation and parsing:
  - `dependencies: ''` in baseRecord (line 2049)
  - `dependencies: existing.dependencies || baseRecord.dependencies` (line 2078)
  - `let dependencies: string | undefined` variable declaration (line 2500)
  - `dependencies = plan.dependencies` read (line 2536)
  - `dependencies: dependencies || ''` in dispatch data (line 2553)
- Remove mirror-sync `updateDependenciesByPlanFile()` calls (lines 9428, 9487)
- Remove ClickUp subtask `updateDependenciesByPlanFile()` calls (lines 4440, 4607)
- Remove `dependencies` from brain plan record update (line 12335)
- Remove `dependencies` from plan registry sync (lines 10131, 10179, 10243–10246, 10266)
- Remove `dependencies` from `getReviewTicketData` return type (line 12909), parsing call (line 12939), and return object (line 12959)
- Remove `_parsePlanDependencies()` method entirely (line 12759)
- Remove `setDependencies` case in review ticket update handler (lines 13184–13192)
- Remove `_isDependencyCheckEnabled()` method entirely (lines 14932–14936)
- Remove `_checkDependenciesBeforeDispatch()` method entirely (lines 15127–15159) and its call site in the dispatch flow (line 15244), including the `depResult` handling block (lines 15244–15254)
- Remove `handleRebuildDependencyMap()` method entirely (lines 15471–15494)
- Remove `dependencies: metadata.dependencies` from ClickUp subtask linking (line 10246 area — `getDependenciesFromPlan` call)

### Step 11 — `PlanFileImporter.ts`
- Remove `dependencies: ''` initialisation (line 116)

### Step 12 — `kanban.html` — JavaScript
- Remove `resolveCardDependencies()` function (lines 5114–5137) and its call in card HTML generation (line 5220)
- Remove `sortColumnByDependencies()` function (lines 5375–5444) and replace its call site (line 4885) with the same alphabetical sort used for non-planning columns: change `isPlanningColumn ? sortColumnByDependencies(items) : [...items].sort(...)` to just `[...items].sort(...)`
- Remove `dependencyMapData` message handler case (lines 6083–6107)
- Remove `renderDependencyTree()` function (lines 8355–8463)
- Remove `detectCyclesForDeps()` function (lines 8465–8500)
- Remove the `dependencies` tab switch handler (lines 3694–3696)
- Remove `btn-copy-deps-prompt`, `btn-rebuild-deps`, and `btn-refresh-deps` button element references and event listeners (lines 8848–8858, 8876–8880)
- Remove the `hasBlockingDependencies` badge injection in card HTML generation (lines 5224–5232: `redTitle`, `depWarningHtml`, and their usage)
- Remove `depWarningHtml` from the card HTML template where it's inserted

### Step 13 — `kanban.html` — HTML & CSS
- Remove the `.dependency-warning` CSS rule (lines 794–809)
- Remove `#dependencies-tab-content` from the shared CSS selector with `#uat-tab-content` (line 1862), leaving only `#uat-tab-content`
- Remove the DEPENDENCIES tab button (line 2317)
- Remove the `#dependencies-tab-content` HTML block entirely (lines 2391–2419)
- Remove the Dependency Check checkbox from the custom agent add-ons section (line 2572: `ca-addon-dependency-check`)
- Remove the Dependency Check label from the planner add-ons section (lines 2702–2704: `plannerAddonDependencyCheck`)
- Remove `ca-addon-dependency-check` checkbox state sync (line 3297) and config capture (line 3357)
- Remove `plannerAddonDependencyCheck` from the planner addon listener array (line 3807) and its state read (line 3035)

### Step 14 — `package.json`
- Remove the `switchboard.planner.dependencyCheckEnabled` configuration entry (lines 271–275)

### Step 15 — Test cleanup
- In `src/test/prompts-tab-move-regression.test.js`: remove the assertions that check for the Dependencies tab button and its HTML structure (lines 460–488)
- In `src/test/kanban-default-prompt-previews.test.js`: remove test cases asserting `DEPENDENCY CHECK ENABLED` string presence/absence (lines 136, 157)
- In `src/test/minimal-prompt.test.js`: remove dependency check directive inclusion tests (lines 24, 35, 49)
- In `src/test/agent-prompt-builder-subagents.test.js`: remove custom workflow dependency check append-on tests (lines 204–216)

### Step 16 — Dist sync
- Copy updated webview files to `dist/webview/` to keep the packaged extension in sync

## Verification Plan

### Automated Tests
- Run the existing test suite after all changes. The following test files have dependency-related assertions that must be removed (Step 15):
  - `src/test/prompts-tab-move-regression.test.js`
  - `src/test/kanban-default-prompt-previews.test.js`
  - `src/test/minimal-prompt.test.js`
  - `src/test/agent-prompt-builder-subagents.test.js`
- The following test files are deleted entirely (Step 1):
  - `src/test/plan-dependency-parser.test.js`
  - `src/test/kanban-dependency-ordering.test.js`
- All remaining tests must pass with no dependency-related references

### Manual Verification
- Open the Kanban view and confirm the DEPENDENCIES tab button is gone
- Confirm no red `!` dependency warning badges appear on any kanban cards
- Confirm the Dependency Check checkbox is absent from both planner and custom agent add-ons
- Confirm the Include Dependency Instructions checkbox is absent from lead/coder/intern add-ons
- Confirm dispatching a plan no longer triggers a dependency check dialog
- Confirm the review panel no longer shows a dependencies section
- Confirm ClickUp sync still works (no crash on missing `dependencies` field)

**Recommendation: Send to Lead Coder** (Complexity 7 — multi-file coordination with scattered call sites, SQL schema considerations, and ClickUp sync contract implications)
