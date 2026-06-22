# Show the Switchboard SVG Icon on the Planning and Project Panel VS Code Tabs

## Goal

`planning.html` (the ARTIFACTS panel) and `project.html` (the PROJECT panel) show a blank/generic document icon in their VS Code editor tabs instead of the Switchboard SVG icon. They must display the same `icon.svg` that `kanban.html` and `design.html` already show.

### Problem Analysis

VS Code editor-tab icons for webview panels come from `panel.iconPath`. Working panels set it:
- DesignPanelProvider: [111](src/services/DesignPanelProvider.ts#L111) and [199](src/services/DesignPanelProvider.ts#L199).
- KanbanProvider: [891](src/services/KanbanProvider.ts#L891) and [933](src/services/KanbanProvider.ts#L933).
- SetupPanelProvider: [68](src/services/SetupPanelProvider.ts#L68).

In `PlanningPanelProvider`, the main planning panel is created at [PlanningPanelProvider.ts:429-440](src/services/PlanningPanelProvider.ts#L429) and the project panel at [287-295](src/services/PlanningPanelProvider.ts#L287) — **neither creation path sets `iconPath`**. The only `iconPath` assignment in the file is at [558](src/services/PlanningPanelProvider.ts#L558), inside a separate revive/deserialize helper that operates on a passed-in `panel`; the normal `openPlanningPanel` / `openProjectPanel` flows never reach it. So freshly opened Planning and Project panels fall back to the generic document icon.

### Root Cause

The `createWebviewPanel` calls for `_panel` (planning) and `_projectPanel` (project) omit `panel.iconPath`, unlike every other Switchboard panel provider.

## Metadata

**Complexity:** 2
**Tags:** ui, bugfix

## User Review Required

No — this is a pure cosmetic fix copying an established one-liner pattern from three sibling providers. No user-facing behavior, data, or workflow changes beyond the tab icon appearance.

## Complexity Audit

### Routine
- Setting `iconPath` immediately after each `createWebviewPanel`, copying the exact pattern from Kanban/Design/Setup.
- Two insertion points in a single file (`PlanningPanelProvider.ts`), each a one-line addition.
- `icon.svg` exists at the extension root (`/icon.svg`, confirmed via file lookup).
- `this._extensionUri` is the correct field name (declared at [PlanningPanelProvider.ts:123](src/services/PlanningPanelProvider.ts#L123), used at line 558 and throughout).

### Complex / Risky
- None. `icon.svg` exists at the extension root and `this._extensionUri` is already used at line 558. The same icon is successfully shipped by Kanban, Design, and Setup providers, confirming it is packaged in the VSIX.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `iconPath` is set synchronously immediately after panel creation, before any async work (`_updateWebviewRoots`, HTML assignment, message handler registration).
- **Security:** None — `iconPath` is a panel-level display property, not a webview resource. It does not require `localResourceRoots` inclusion.
- **Side Effects:** None beyond the corrected tab icon.
- **Dependencies & Conflicts:** `this._extensionUri` is the field name used elsewhere in this provider (declared line 123, used at line 558 and throughout `_getProjectHtml`). The icon file `icon.svg` at the extension root is included in packaging — confirmed by the fact that Kanban, Design, and Setup providers ship the same `icon.svg` path successfully to ~4,000 published installs. No `.vscodeignore` exclusion applies (sibling providers prove the file reaches the VSIX).

## Dependencies

None — this plan is self-contained and has no prerequisite sessions or plans.

## Adversarial Synthesis

Key risks: (1) imprecise insertion point could cause a syntax error if the one-liner is accidentally wedged into the `createWebviewPanel` options object rather than placed after the closing `);`, (2) the packaging assumption for `icon.svg` was originally unstated. Mitigations: the Proposed Changes section now specifies exact insertion lines (after the closing `);` of `createWebviewPanel`, before `_updateWebviewRoots()`), and the packaging claim is backed by evidence — three sibling providers ship the same icon path successfully.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — planning panel (ARTIFACTS)

**Context:** The `openPlanningPanel` method creates `this._panel` at lines [429-440](src/services/PlanningPanelProvider.ts#L429) via `vscode.window.createWebviewPanel(...)`. The closing `);` of that call is line 440. Line 441 is `this._updateWebviewRoots();`.

**Implementation:** Insert the `iconPath` assignment on a new line between line 440 (the closing `);` of `createWebviewPanel`) and line 441 (`this._updateWebviewRoots();`):

```ts
this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
```

**Logic:** This mirrors the exact pattern at [DesignPanelProvider.ts:111](src/services/DesignPanelProvider.ts#L111), [KanbanProvider.ts:891](src/services/KanbanProvider.ts#L891), and [SetupPanelProvider.ts:68](src/services/SetupPanelProvider.ts#L68) — set `iconPath` right after panel creation, before HTML assignment.

**Edge Cases:** The reveal path at [lines 424-426](src/services/PlanningPanelProvider.ts#L424) calls `this._panel.reveal()` and returns early, reusing the already-created panel. Since the create path now sets `iconPath`, the reveal path inherits it — no redundant assignment needed. The revive/deserialize path at [line 558](src/services/PlanningPanelProvider.ts#L558) already sets `iconPath` independently; this change does not conflict with it.

### 2. `src/services/PlanningPanelProvider.ts` — project panel (PROJECT)

**Context:** The `openProject` method creates `this._projectPanel` at lines [287-295](src/services/PlanningPanelProvider.ts#L287) via `vscode.window.createWebviewPanel(...)`. The closing `);` of that call is line 295. Line 296 is `this._updateWebviewRoots();`.

**Implementation:** Insert the `iconPath` assignment on a new line between line 295 (the closing `);` of `createWebviewPanel`) and line 296 (`this._updateWebviewRoots();`):

```ts
this._projectPanel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
```

**Logic:** Same pattern as change #1, applied to the project panel's create path.

**Edge Cases:** The reveal path at [lines 282-284](src/services/PlanningPanelProvider.ts#L282) calls `this._projectPanel.reveal()` and returns early, reusing the already-created panel. Since the create path now sets `iconPath`, the reveal path inherits it. The revive/deserialize path at [line 558](src/services/PlanningPanelProvider.ts#L558) handles the project panel via the `isProject` branch and already sets `iconPath`; no conflict.

## Verification Plan

### Automated Tests

No automated tests required — this is a cosmetic `iconPath` property assignment with no testable logic. The test suite (unit, integration, e2e) will be run separately by the user. No compilation step is needed for this session.

### Manual Verification

1. Build/run the extension.
2. Open the Artifacts (Planning) panel → confirm the editor tab shows the Switchboard SVG icon, identical to the Kanban/Design tabs.
3. Open the Project panel → confirm the same icon appears.
4. Close and reopen each panel → confirm the icon persists (covers both create and reveal paths; reveal reuses the already-created panel that now has the icon).
5. Reload the VS Code window (to trigger the deserialize/revive path) → confirm the icon still appears on both restored panels (this path was already fixed at line 558; verifies no regression).

## Recommendation

**Complexity: 2 → Send to Intern.** This is a trivial two-line fix copying an established pattern from three sibling providers. No architectural decisions, no data risks, no edge cases beyond standard VS Code panel lifecycle.
