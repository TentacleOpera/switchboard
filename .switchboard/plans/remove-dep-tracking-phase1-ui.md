# Remove Dependency Tracking — Phase 1: UI Layer

## Goal

Remove all user-facing dependency tracking surfaces from the kanban webview and configuration: the DEPENDENCIES tab, dependency warning badges on cards, Dependency Check and Include Dependency Instructions UI toggles, and the VS Code configuration entry. After this phase, no dependency controls are visible to the user, but backend handlers still exist (harmless dead code until later phases remove them).

## Problem Analysis

The dependency tracking feature was unreliable and unused. This phase removes the UI layer first so users see no broken controls. Dead message handlers in the backend are harmless — they simply won't be triggered.

## Metadata

- **Complexity:** 4
- **Tags:** refactor, frontend

## User Review Required

None — removal only, no new behaviour.

## Complexity Audit

### Routine
- Remove DEPENDENCIES tab button and content div from HTML
- Remove `.dependency-warning` CSS rule
- Remove dependency badge injection from card HTML generation
- Remove Dependency Check checkboxes from planner and custom agent add-ons
- Remove `dependencyCheck` and `includeDependencyInstructions` from sharedDefaults.js
- Remove `dependencyCheckEnabled` from package.json configuration

### Complex / Risky
- **kanban.html JS** — `sortColumnByDependencies()` call at line 4885 must be replaced with standard alphabetical sort, not just deleted. Planning columns (CREATED, PLAN REVIEWED) currently get topological sort; they must fall back to the same sort as other columns.
- **kanban.html JS** — `resolveCardDependencies()` and `depWarningHtml` are interleaved with card HTML generation. Must remove the function, its call, and the badge HTML variable without breaking the card template.
- **sharedDefaults.js** — `includeDependencyInstructions` appears in 3 role configs and 3 ROLE_ADDONS entries. All must be removed consistently.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — UI-only changes, no backend state mutations.
- **Security:** None.
- **Side Effects:**
  - Removing `sortColumnByDependencies()` call changes sort order for CREATED and PLAN REVIEWED columns from topological to alphabetical. This is acceptable — the topological sort was based on unreliable dependency data.
  - Dead message handlers in backend (`getDependencyMapData`, `rebuildDependencyMap`, `dependencyMapData`) will remain but never fire. Removed in Phase 3.
- **Dependencies & Conflicts:** None. This phase can be executed independently.

## Dependencies

None — this is the first phase.

## Adversarial Synthesis

Key risks: (1) Card HTML generation has interleaved dependency badge code — removing `resolveCardDependencies()` call and `depWarningHtml` variable must not leave dangling references in the template string. (2) Column sort fallback must be explicit — deleting the ternary without replacing it will break the sort logic. Mitigations: card template is a string concatenation; removing the badge variable and its insertion point is straightforward. Sort fallback is a simple replacement with the existing alphabetical sort branch.

## Proposed Changes

### `src/webview/kanban.html` — HTML
- Remove DEPENDENCIES tab button (line 2317)
- Remove `#dependencies-tab-content` HTML block (lines 2391–2419)
- Remove Dependency Check checkbox from custom agent add-ons (line 2572: `ca-addon-dependency-check`)
- Remove Dependency Check checkbox from planner add-ons (lines 2702–2704: `plannerAddonDependencyCheck`)

### `src/webview/kanban.html` — CSS
- Remove `.dependency-warning` CSS rule (lines 794–809)
- Remove `#dependencies-tab-content` from shared selector with `#uat-tab-content` (line 1862), leaving only `#uat-tab-content`

### `src/webview/kanban.html` — JavaScript
- Remove `resolveCardDependencies()` function (lines 5114–5137) and its call in card HTML generation (line 5220)
- Remove `hasBlockingDependencies` badge injection: `redTitle` variable (lines 5224–5229), `depWarningHtml` variable (lines 5230–5232), and where `depWarningHtml` is inserted into the card template
- Remove `sortColumnByDependencies()` function (lines 5375–5444)
- Replace its call site (line 4885): change `isPlanningColumn ? sortColumnByDependencies(items) : [...items].sort(...)` to just `[...items].sort(...)` — remove the `isPlanningColumn` check entirely
- Remove `dependencyMapData` message handler case (lines 6083–6107)
- Remove `renderDependencyTree()` function (lines 8355–8463)
- Remove `detectCyclesForDeps()` function (lines 8465–8500)
- Remove `dependencies` tab switch handler (lines 3694–3696)
- Remove `btn-copy-deps-prompt`, `btn-rebuild-deps`, `btn-refresh-deps` button element references and event listeners (lines 8848–8858, 8876–8880)
- Remove `ca-addon-dependency-check` checkbox state sync (line 3297) and config capture (line 3357)
- Remove `plannerAddonDependencyCheck` from planner addon listener array (line 3807) and its state read (line 3035)

### `src/webview/sharedDefaults.js`
- Remove `dependencyCheck` from `DEFAULT_ROLE_CONFIG` planner defaults (line 22)
- Remove `dependencyCheck` entry from `ROLE_ADDONS.planner` array (line 65)
- Remove `includeDependencyInstructions` from `DEFAULT_ROLE_CONFIG` lead, coder, intern defaults (lines 24, 25, 28)
- Remove `includeDependencyInstructions` entries from `ROLE_ADDONS.lead`, `ROLE_ADDONS.coder`, `ROLE_ADDONS.intern` arrays (lines 89, 108, 158)

### `package.json`
- Remove `switchboard.planner.dependencyCheckEnabled` configuration entry (lines 271–275)

## Verification Plan

### Automated Tests
- Skip (per session directive). Tests cleaned in Phase 6.

### Manual Verification
- Open Kanban view — DEPENDENCIES tab button gone
- No red `!` dependency warning badges on any card
- Dependency Check checkbox absent from planner and custom agent add-ons
- Include Dependency Instructions checkbox absent from lead/coder/intern add-ons
- CREATED and PLAN REVIEWED columns sort alphabetically (not topologically)

**Recommendation: Send to Coder** (Complexity 4 — multi-site UI removal with one sort fallback replacement)
