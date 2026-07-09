# Review Plan opens a duplicate Project panel instead of targeting the one moved to a new window

## Goal

When the user has moved the **Project panel** (`project.html`) out of the main editor into a separate window (VS Code's *"Move Editor into New Window"* / auxiliary window), clicking **Review Plan** on a card in the Kanban board should route the selection to that existing panel wherever it lives. Instead, the panel is yanked back into the main IDE window (or a fresh one appears there), so the panel the user deliberately floated is disturbed and the new window is left behind.

**Concrete user workflow this breaks:** the user floats the Project panel into its own window *specifically so they can minimise the main VS Code window entirely* and work only in that floating window's tabs. Today, clicking **Review Plan** forces the main VS Code window to **un-minimise** and shows a Project panel there — defeating the whole point of the floated window. The desired behavior is: the plan loads in the floating window and the main VS Code window stays minimised and untouched.

This plan makes Review-Plan (and every other "reveal the Project panel" path) **reveal the panel in its current location** rather than forcibly relocating it to column one of the main window — so the main window is never raised or un-minimised.

### Problem analysis & background

Two panels are involved and they are **separate webviews**:

- The **Kanban board** — `KanbanProvider` creates the `switchboard-kanban` webview panel from `kanban.html` (`src/services/KanbanProvider.ts:1252`). This is where the user clicks *Review Plan*.
- The **Project panel** — `PlanningPanelProvider` creates the `switchboard-project` webview panel from `project.html` (`src/services/PlanningPanelProvider.ts:602`). This is the panel that hosts the plan review UI (a "Kanban tab" plus the plan editor). The user has dragged this one into a new window.

The click flow:

1. `kanban.html` posts `{ type: 'reviewPlan', ... }` (`src/webview/kanban.html:5772`).
2. `KanbanProvider`'s `reviewPlan` handler (`src/services/KanbanProvider.ts:8704`) resolves the session and then decides how to surface the Project panel:
   ```ts
   if (!this._planningPanelProvider.hasProjectPanel()) {
       await this._planningPanelProvider.openProject();
   } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
       this._planningPanelProvider.revealProject();
   }
   // …then always:
   this._planningPanelProvider.postMessageToProjectWebview({ type: 'activateKanbanTabAndSelectPlan', … });
   ```
   The shared helper `KanbanProvider.activatePlanInProjectPanel` (`src/services/KanbanProvider.ts:248`) uses the identical open/reveal/post pattern, and `TaskViewerProvider`'s `reviewPlan` (`src/services/TaskViewerProvider.ts:10897`) delegates to it.
3. The Project webview receives `activateKanbanTabAndSelectPlan` and selects the plan (`src/webview/project.js:638`). This message reaches the panel **wherever it is docked**, because an auxiliary window shares the same extension host and the same `WebviewPanel` object — so the routing of the *data* is already correct.

### Root cause

The **reveal** step is wrong. Every "panel already exists" reveal for the Project panel hardcodes an explicit column:

```ts
this._projectPanel.reveal(vscode.ViewColumn.One);
```

Per the VS Code API, `WebviewPanel.reveal(viewColumn)` **moves** the panel into `viewColumn` **of the main window**. When the panel currently lives in an auxiliary window, `reveal(ViewColumn.One)` relocates that live panel back into the main IDE's first column — i.e. it "steals" the floated panel back. From the user's point of view the Project panel suddenly appears in the IDE where there was none, which reads as *"it opens a new project.html in the ide, not in the window."*

The guard `isProjectInCurrentWindow()` (`src/services/PlanningPanelProvider.ts:1123`) was added to suppress this steal-back:

```ts
public isProjectInCurrentWindow(): boolean {
    return !!this._projectPanel && this._projectPanel.viewColumn !== undefined;
}
```

It leans on the heuristic that an auxiliary-window webview reports `viewColumn === undefined`. That heuristic is **fragile** — `viewColumn` is an unreliable proxy for window residency (its value across auxiliary windows and hidden tabs is version-dependent), and it is the *only* thing standing between the current code and a destructive reveal. The real defect is that the reveal **target** is wrong: revealing the Project panel should never force it into the main window's column one. It should reveal it **in place**.

Fixing the reveal target makes the behavior correct regardless of whether the `viewColumn` heuristic is accurate:

- If the guard correctly returns `false` for an aux window → we skip reveal and just post the message → the floated panel updates in place. ✔
- If the guard incorrectly returns `true` for an aux window → we call `revealProject()`, but it now reveals **in place** (no relocation) and posts the message. ✔

Either way: no steal-back, no duplicate panel, plan selected in the floated panel.

### Fix summary

Replace `reveal(vscode.ViewColumn.One)` with an **in-place, focus-preserving** reveal — `reveal(undefined, true)` — at the four Project-panel reveal sites where a panel already exists. Passing `undefined` for the column reveals the panel in its current location (does not move it); `preserveFocus: true` keeps the user on the Kanban board they clicked from. The **brand-new** panel creation (`createWebviewPanel(..., vscode.ViewColumn.One, ...)`, line 602) is left unchanged — a first-ever open should still dock in the main window's column one.

## Metadata

- **Tags:** bugfix, ui, reliability
- **Complexity:** 3
- **Area:** `PlanningPanelProvider` (project panel window management)
- **Type:** Bug fix (behavioral)
- **Feature:** Project panel fixes (`6f30b8c5-74d4-4246-9c03-53469640eb8d`)

> Tags normalized to the allowed improve-plan tag set (was `bug, project-panel, webview, multi-window, kanban, review-plan`; the descriptive labels are captured in **Area**/**Type** above).

## User Review Required

- **None.** This is a self-contained behavioral bug fix with a clear correct end-state (reveal in place, never relocate). The only open item is a factual VS Code API question (see **Uncertain Assumptions**), not a product decision.

## Complexity Audit

### Routine
- Four one-line edits swapping the argument to an existing VS Code API call (`reveal(vscode.ViewColumn.One)` → `reveal(undefined, true)`), plus explanatory comments.
- No new state, no new API surface, no migration, no data-model change.
- Does not touch persistence, the DB, message schemas, or the webview↔host contract (`activateKanbanTabAndSelectPlan` is untouched and already routes correctly).

### Complex / Risky
- The only subtlety is VS Code's `reveal(viewColumn, preserveFocus)` column/window semantics for a panel living in an **auxiliary window** — whether `undefined` truly reveals in place there, or re-docks to the main window. This is the one unverified assumption (see **Uncertain Assumptions**). It is *not* safety-critical because the dominant fix path routes data via `postMessage` and never calls `reveal()` for the aux-window case (see below).

## Edge-Case & Dependency Audit

- **Aux window via "Move Editor into New Window" (the reported case).** Same extension host, same `WebviewPanel` object → `hasProjectPanel()` is `true` and `postMessageToProjectWebview` reaches the floated panel. After the fix, reveal no longer relocates it. **Fixed.**
- **Panel hidden behind another tab in the main window.** In-place `reveal(undefined, true)` brings the Project panel's tab forward in its current group without moving it or stealing focus. Correct and less disruptive than the old forced `ViewColumn.One`.
- **First-ever open (no panel yet).** `hasProjectPanel()` is `false` → `openProject()` → `_doOpenProject()` creates the panel with `createWebviewPanel(..., vscode.ViewColumn.One, ...)`. **Unchanged** — new panels still dock in the main window as before.
- **Genuinely separate top-level VS Code window (separate extension host / separate process).** If the user opened the Project panel in a fully separate VS Code window (not an auxiliary window), that window runs its own `PlanningPanelProvider` with its own `_projectPanel`; the Kanban board's host sees `_projectPanel === undefined`, so `openProject()` correctly opens a panel **in the board's own window**. Cross-process routing of the selection is not possible without an IPC/WebSocket bridge and is **out of scope** for this bug. This is a pre-existing limitation, not a regression, and is distinct from the auxiliary-window case this plan fixes. No behavior change here.
- **`revealProject()` fallback when no panel exists** (`else { void this.openProject(); }`) is preserved.
- **`preserveFocus: true` interaction with the Kanban click.** The user clicked from the Kanban board; keeping focus there (rather than stealing it to the Project panel) is the desired behavior and matches the existing intent comment ("do NOT forcibly reveal (which steals it back)").
- **Dependencies:** none new. `reveal(viewColumn?, preserveFocus?)` has existed since early VS Code; the `preserveFocus` overload is long-stable and well within the declared engine `^1.93.0`.
- **Main Planning panel (`_panel`, `switchboard-planning`) reveal sites** at lines 807 and 1074 share the same `reveal(vscode.ViewColumn.One)` pattern and the same latent steal-back bug. They are **out of scope** for this memo issue (which is specifically about Review Plan → Project panel), but are called out here so a follow-up can apply the identical one-line fix for consistency. Not changed in this plan to keep the blast radius minimal.

## Dependencies

- No external/session dependencies. `reveal(viewColumn?, preserveFocus?)` has existed since early VS Code; the `preserveFocus` overload is long-stable and well within the declared engine `^1.93.0`.
- **Sibling subtask coordination (feature `Project panel fixes`):** this plan **shares the `openProject()` / `_doOpenProject()` surface** with its sibling *"Fix: Project panel duplicate on window restore (serializer ghost)"*. This plan is the **owner of the reveal-target decision**: all Project-panel reveal calls must be `reveal(undefined, true)`, never `reveal(vscode.ViewColumn.One)`. The sibling plan adds a restore-guard *around* those same reveal calls and defers to this decision. **Recommended coding order: land this plan first** (it stabilises the four reveal sites to their final form), then the restore-guard plan builds its guard around the already-correct reveal target. See the feature file's *Dependencies & sequencing* for the reconciled end-state.

## Adversarial Synthesis

Key risks: (1) the aux-window `reveal(undefined, true)` in-place semantics are unverified — if VS Code re-docks on any `reveal()`, the *fallback* path (guard wrongly returns `true`) still steals the panel back; (2) `viewColumn === undefined` is an acknowledged-fragile aux-window signal. Mitigations: the **primary** path never calls `reveal()` for the aux-window case — the guard returns `false`, we skip reveal, and `postMessage` routes the selection to the panel wherever it lives (same extension host, same `WebviewPanel` object), which is robust regardless of reveal semantics. The change is strictly no worse than today's guaranteed steal-back, and the two API uncertainties are flagged for confirmation before treating the fallback as bulletproof.

## Uncertain Assumptions

The following VS Code API behaviors are **not 100% certain** and were flagged; the user was advised to run web research to confirm them before implementation:

1. **`WebviewPanel.reveal(undefined, true)` on a panel currently in an auxiliary window** ("Move Editor into New Window") reveals it **in place** (keeps it in the aux window) rather than re-docking it into the main window's last-used column. `ViewColumn` is main-window-relative and there is no public API to target a specific auxiliary window, so it is unconfirmed whether "reveal in the last-shown column" preserves aux-window residency.
2. **`WebviewPanel.viewColumn === undefined` reliably indicates auxiliary-window residency** (vs. a hidden/background tab, or version-dependent values) across VS Code `1.93+`. The plan already treats this as fragile; the fix is designed so its accuracy is not safety-critical, but the actual reported values across aux-window / hidden-tab / minimised states are worth confirming.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

All edits are within the Project-panel reveal paths. Introduce an in-place, focus-preserving reveal in place of the forced `ViewColumn.One`.

**1. `openProject()` — the `_projectPanelOpening` await branch (currently line 573–575):**

```ts
        if (this._projectPanelOpening) {
            await this._projectPanelOpening;
            if (this._projectPanel) {
                // Reveal the panel where it currently lives. Passing an explicit
                // ViewColumn.One would relocate it into the main window's first
                // column, yanking it out of an auxiliary ("Move Editor into New
                // Window") window. Omit the column to reveal in place; preserve
                // focus so we don't steal the user off the board they clicked.
                this._projectPanel.reveal(undefined, true);
            }
            return;
        }
```

**2. `openProject()` — the existing-panel fast path (currently line 579–585):**

```ts
        if (this._projectPanel) {
            this._projectPanel.reveal(undefined, true);
            if (this._projectPanelReady) {
                this.postMessageToProjectWebview({ type: 'refreshKanbanPlans' });
            }
            return;
        }
```

**3. `_doOpenProject()` — the redundant existing-panel guard (currently line 597–600):**

```ts
    private async _doOpenProject(): Promise<void> {
        this._lastWebviewRootsSignature = '';
        if (this._projectPanel) {
            this._projectPanel.reveal(undefined, true);
            return;
        }

        this._projectPanel = vscode.window.createWebviewPanel(
            'switchboard-project',
            'PROJECT',
            vscode.ViewColumn.One,   // ← UNCHANGED: a brand-new panel docks in the main window
            { … }
        );
```

**4. `revealProject()` (currently line 1111–1117):**

```ts
    public revealProject(): void {
        if (this._projectPanel) {
            // Reveal in the panel's CURRENT location. An explicit ViewColumn.One
            // relocates the panel into the main window, stealing it back out of an
            // auxiliary window. Omitting the column reveals it in place;
            // preserveFocus keeps the user on the board they clicked from.
            this._projectPanel.reveal(undefined, true);
        } else {
            void this.openProject();
        }
    }
```

No changes to `hasProjectPanel()`, `isProjectInCurrentWindow()`, `postMessageToProjectWebview()`, the `reviewPlan` handlers, or the webview contract. The `isProjectInCurrentWindow()` gate in the callers (`KanbanProvider.ts:8713`, `:257`) is retained — it preserves the "don't raise the floated window on every click" intent — but its accuracy is no longer safety-critical, because the reveal it gates is now non-destructive.

## Verification Plan

> **Session directives:** **skip compilation** and **skip automated tests**. The `npm run compile` step below is retained for the eventual VSIX build but is out of scope for this session.

Manual verification in an installed VSIX (the project tests against the VSIX, not `dist/`):

1. **Reproduce the bug (pre-fix baseline).** Open the Project panel, drag its editor tab out via **Move Editor into New Window** so it floats in a separate window. Open the standalone Kanban board in the main IDE window. Click **Review Plan** on a card. Confirm the current behavior: the Project panel is pulled back into the main IDE window (or a second one appears there).
2. **After the fix — auxiliary window, main VS Code minimised (the primary user scenario).** Float the Project panel into its own window, then **minimise the main VS Code window entirely**. From the floating window (or wherever the Kanban board is), click **Review Plan**. Expected: the plan loads in the **floating window** (Kanban tab activated, plan selected) and the **main VS Code window stays minimised** — it is never raised or un-minimised, and no panel appears in it. This is the key success criterion.
3. **First open (no panel).** With no Project panel open anywhere, click **Review Plan**. Expected: a Project panel opens docked in the main window's column one (unchanged behavior) and selects the plan.
4. **Hidden-tab case.** Dock the Project panel in the main window but switch to a different editor tab. Click **Review Plan**. Expected: the Project panel tab comes forward in place and selects the plan, without relocating or stealing focus.
5. **Both Review-Plan entry points.** Confirm the same correct behavior when Review Plan is triggered from the sidebar Task Viewer (`TaskViewerProvider` → `activatePlanInProjectPanel`) as from the standalone Kanban board — both share the patched reveal helpers.
6. **`npm run compile`** to confirm the TypeScript change builds cleanly (only needed when producing a VSIX).

Success criteria: Review Plan never relocates a floated Project panel and never spawns a duplicate for the auxiliary-window case; the plan is selected in the panel wherever it currently lives; first-open and hidden-tab behavior are unchanged.
