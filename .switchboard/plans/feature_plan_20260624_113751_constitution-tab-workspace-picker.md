# Add Workspace Picker to the Constitution Tab in project.html

## Goal

The `project.html` **Constitution** tab does not have a workspace picker. Because Switchboard supports multiple workspaces, the sidebar currently displays workspaces in a weird/inconsistent way for this tab. Add a **workspace picker** to the Constitution tab so the user can select which workspace's constitution (and, after the split, system files) they are viewing/editing.

### Problem Analysis

Other tabs in `project.html` (and other panels) have a workspace picker that sets the active workspace context. The Constitution tab lacks one, so the workspace context for constitution viewing/editing is ambiguous — the sidebar shows workspaces oddly because there is no picker driving the active workspace for this tab. This makes multi-workspace projects confusing and risks editing the wrong workspace's constitution.

#### Root-Cause Findings from Code Investigation

Investigation of the actual source code revealed several facts that refine the original problem statement:

1. **The Constitution tab ALREADY has a workspace-selection mechanism** — it is a **sidebar list** (`#constitution-list-pane`), not a dropdown. `renderConstitutionWorkspaceList()` (`src/webview/project.js:1334`) iterates `_constitutionWorkspaces` and renders clickable `.constitution-file-item` cards. Clicking a card calls `selectConstitutionWorkspace(ws)` (`project.js:1393`), which sends `readConstitutionFile` with the selected `workspaceRoot`. So the picker exists; it is just a different UX pattern (sidebar cards) from the dropdown `<select>` used by Kanban/Epics/Tuning.

2. **The Constitution/System tab split has ALREADY shipped.** There is a separate `#system-content` tab (`project.html:1401`) with its own `#system-list-pane`, its own `renderSystemWorkspaceList()` (`project.js:1406`), and its own `selectSystemWorkspace()` (`project.js:1463`). The plan's references to "after the split" are stale — the System tab already exists and needs the same picker treatment.

3. **The actual "weird/inconsistent" behavior has two root causes:**
   - **No dropdown picker in the controls strip** — Kanban (`project.html:1293`), Epics (`project.html:1334`), and Tuning (`project.html:1434`) all have a `<select id="*-workspace-filter">` in their `.controls-strip`. Constitution (`project.html:1369`) and System (`project.html:1406`) do not, making the UX inconsistent across tabs.
   - **No auto-selection on tab switch** — When the Constitution tab is activated, `loadConstitutionFiles` fires (`project.js:40`), the sidebar populates, but NO workspace is auto-selected. The preview shows "Select a workspace to view its Constitution" (`project.html:1392`). Other tabs (Kanban) default to "All Workspaces" and load data immediately. This extra-click requirement is the user-perceived "weirdness."

4. **Two workspace data sources, same backend origin.** Kanban/Epics/Tuning dropdowns are populated from `_kanbanWorkspaceItems` (via the `kanbanPlansReady` message, `project.js:250`). Constitution/System sidebar lists are populated from `_constitutionWorkspaces` (via the `constitutionFilesLoaded` message, `project.js:372`). Both ultimately call `buildWorkspaceItems()` on the backend (`PlanningPanelProvider.ts:2966` and `:1588`), so the workspace lists are identical — but they arrive via different messages at different times. The Constitution dropdown MUST be wired to `_constitutionWorkspaces` (not `_kanbanWorkspaceItems`), because `loadConstitutionFiles` is what fires on Constitution tab activation, while `fetchKanbanPlans` may not have run yet.

5. **Governance status badges.** The sidebar cards show C/Cl/A file-existence badges (`project.js:1365-1372`). A plain `<select>` dropdown cannot display these. The sidebar list should be RETAINED (not replaced) to preserve this at-a-glance governance status, with the dropdown added alongside it and bidirectionally synced.

6. **Pre-existing `alert()` bug.** Several Constitution handlers use `alert('Please select a workspace first.')` (`project.js:1494, 1504, 1514, 1524, 1534`). Like `confirm()`, `alert()` is a silent no-op in VS Code webviews (per CLAUDE.md). These are pre-existing broken guards in the same code path. This plan does NOT fix them (out of scope), but the implementer should be aware they exist.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, bugfix, feature

## User Review Required

Yes — before implementation, the user should confirm the design decision to **add a dropdown picker that coexists with (and bidirectionally syncs to) the existing sidebar list**, rather than replacing the sidebar list entirely. The sidebar list provides governance status badges (C/Cl/A) that a dropdown cannot show; replacing it would lose that information. If the user prefers to replace the sidebar entirely, the plan should be adjusted.

## Complexity Audit

### Routine
- Add a `<select id="constitution-workspace-filter">` dropdown to the Constitution tab `.controls-strip` (`project.html:1369`), mirroring the Kanban/Epics/Tuning pattern.
- Add a `<select id="system-workspace-filter">` dropdown to the System tab `.controls-strip` (`project.html:1406`), same pattern.
- Populate both dropdowns from `_constitutionWorkspaces` inside the `constitutionFilesLoaded` handler (`project.js:371-375`), reusing the option-creation pattern from `populateWorkspaceDropdowns()` (`project.js:708-726`).
- Wire dropdown `change` events to call the existing `selectConstitutionWorkspace(ws)` / `selectSystemWorkspace(ws)` functions.
- Auto-select the first workspace (or the last-selected workspace root if persisted) when `constitutionFilesLoaded` arrives and no workspace is currently selected.
- Ensure the sidebar list and dropdown stay in sync (bidirectional): dropdown change → update sidebar `.selected` card; sidebar card click → update dropdown `.value`.

### Complex / Risky
- **Bidirectional sync desync risk** — Two controls driving the same `_constitutionSelectedWorkspace` / `_systemSelectedWorkspace` state. If sync is one-directional or event ordering is wrong, the dropdown and sidebar will disagree on which workspace is active. Must use a single source-of-truth update function that sets both the dropdown value and the sidebar selected class.
- **Data-source timing** — The dropdown must be populated from `_constitutionWorkspaces` (arrives via `constitutionFilesLoaded`), NOT `_kanbanWorkspaceItems` (arrives via `kanbanPlansReady`). On first tab switch, `loadConstitutionFiles` fires but `fetchKanbanPlans` may not have, so `_kanbanWorkspaceItems` could be stale/empty.
- **Edit-mode guard** — Switching workspace while editing (`state.dirtyFlags.constitution` / `state.dirtyFlags.system`) must exit edit mode first, same as the existing sidebar click handler does (`project.js:1383, 1453`). The dropdown `change` handler must replicate this guard.

## Edge-Case & Dependency Audit

- **Race Conditions:** `constitutionFilesLoaded` can arrive while the user is on a different tab (it fires on both Constitution and System tab switch, `project.js:40-42`). The dropdown population and auto-selection must only apply to the currently-active tab's dropdown, or be safe to run when the tab is not visible (the `<select>` elements exist in the DOM regardless of active tab). No race with `fetchKanbanPlans` since the dropdown uses `_constitutionWorkspaces`, not `_kanbanWorkspaceItems`.
- **Security:** No new attack surface. Workspace roots are validated server-side in `readConstitutionFile` (`PlanningPanelProvider.ts:3008`: `if (!allRoots.includes(wsRoot))`). The dropdown values are workspace roots from the same trusted `buildWorkspaceItems()` source.
- **Side Effects:** Adding auto-selection changes behavior — users who previously saw "Select a workspace..." will now see the first workspace's constitution immediately. This is the desired fix but is a behavior change. The sidebar list rendering (`renderConstitutionWorkspaceList` / `renderSystemWorkspaceList`) must still be called to refresh governance badges.
- **Dependencies & Conflicts:** No dependency on other plans. The Constitution/System split is already shipped. The `populateWorkspaceDropdowns()` function (`project.js:708`) currently hardcodes Kanban/Epics/Tuning — it should NOT be modified to include Constitution/System (different data source, different timing). A separate populate function or inline population in the `constitutionFilesLoaded` handler is cleaner.
- **Multi-workspace:** Switching workspaces via the picker must reload the constitution (and system files) for the newly selected workspace — already handled by `selectConstitutionWorkspace` / `selectSystemWorkspace`.
- **Single-workspace projects:** Dropdown shows one entry; auto-selection picks it; no regression. Sidebar also shows one card.
- **Sidebar sync:** The sidebar's workspace list reflects the picker's selection via bidirectional sync, and vice versa.

## Dependencies

- None — this plan is self-contained. The Constitution/System tab split is already shipped.

## Adversarial Synthesis

Key risks: (1) bidirectional desync between the dropdown and sidebar list if a single source-of-truth update function is not used; (2) data-source timing — the dropdown must use `_constitutionWorkspaces` (from `constitutionFilesLoaded`), not `_kanbanWorkspaceItems`, or it will be empty on first Constitution tab visit; (3) edit-mode guard must be replicated in the dropdown `change` handler to avoid losing unsaved constitution edits. Mitigations: centralize selection in one update function that sets both controls; populate from `_constitutionWorkspaces` only; mirror the existing `exitEditMode` guard from the sidebar click handler.

## Proposed Changes

### src/webview/project.html — Constitution tab dropdown picker
- **Context:** The Constitution tab `.controls-strip` (`project.html:1369-1380`) has buttons but no workspace `<select>`. Kanban (`project.html:1293`), Epics (`project.html:1334`), and Tuning (`project.html:1434`) all have one.
- **Logic:** Add a `<select id="constitution-workspace-filter">` as the first child of the Constitution `.controls-strip`, before `btn-build-via-planner`. Do NOT include an "All Workspaces" option — Constitution requires a specific workspace (there is no "all" constitution). Default option: a disabled placeholder ("Select workspace…") or auto-select the first workspace.
- **Implementation:** Insert at `project.html:1369`, inside `<div class="controls-strip">`, as the first child:
  ```html
  <select id="constitution-workspace-filter"></select>
  ```
  Styling is inherited from `.controls-strip select` (`project.html:174-182`).
- **Edge Cases:** If `_constitutionWorkspaces` is empty, the dropdown is empty (sidebar already shows "No workspaces open"). Auto-selection handles the non-empty case.

### src/webview/project.html — System tab dropdown picker
- **Context:** The System tab `.controls-strip` (`project.html:1406-1411`) has no workspace `<select>`.
- **Logic:** Add a `<select id="system-workspace-filter"></select>` as the first child of the System `.controls-strip`, before `btn-edit-system`. Same pattern as Constitution. No "All Workspaces" option.
- **Implementation:** Insert at `project.html:1406`, inside `<div class="controls-strip">`, as the first child.
- **Edge Cases:** Same as Constitution. The System tab also has `.gov-file-btn` tabs (CLAUDE.md / AGENTS.md, `project.html:1402-1405`) — the workspace picker selects the workspace; the gov-file tabs select which file within that workspace. They are orthogonal.

### src/webview/project.js — Element references
- **Context:** Element references are declared at `project.js:155-223`.
- **Logic:** Add references for the two new dropdowns.
- **Implementation:** After `constitutionListPane` (`project.js:199`), add:
  ```js
  const constitutionWorkspaceFilter = document.getElementById('constitution-workspace-filter');
  ```
  After `systemListPane` (`project.js:209`), add:
  ```js
  const systemWorkspaceFilter = document.getElementById('system-workspace-filter');
  ```

### src/webview/project.js — Populate dropdowns on constitutionFilesLoaded
- **Context:** The `constitutionFilesLoaded` handler (`project.js:371-375`) currently sets `_constitutionWorkspaces` and renders the two sidebar lists.
- **Logic:** After the existing `renderConstitutionWorkspaceList()` and `renderSystemWorkspaceList()` calls, populate the two dropdowns from `_constitutionWorkspaces` and auto-select if no workspace is selected.
- **Implementation:** Add a helper function and call it in the handler:
  ```js
  function populateConstitutionWorkspaceDropdowns() {
      const fill = (sel, selectedWs) => {
          if (!sel) return;
          sel.innerHTML = '';
          _constitutionWorkspaces.forEach(ws => {
              const opt = document.createElement('option');
              opt.value = ws.workspaceRoot;
              opt.textContent = ws.label;
              sel.appendChild(opt);
          });
          if (selectedWs) sel.value = selectedWs.workspaceRoot;
      };
      fill(constitutionWorkspaceFilter, _constitutionSelectedWorkspace);
      fill(systemWorkspaceFilter, _systemSelectedWorkspace);
      // Auto-select first workspace if none selected
      if (!_constitutionSelectedWorkspace && _constitutionWorkspaces.length > 0) {
          selectConstitutionWorkspace(_constitutionWorkspaces[0]);
          if (constitutionWorkspaceFilter) constitutionWorkspaceFilter.value = _constitutionWorkspaces[0].workspaceRoot;
      }
      if (!_systemSelectedWorkspace && _constitutionWorkspaces.length > 0) {
          selectSystemWorkspace(_constitutionWorkspaces[0]);
          if (systemWorkspaceFilter) systemWorkspaceFilter.value = _constitutionWorkspaces[0].workspaceRoot;
      }
  }
  ```
  Call `populateConstitutionWorkspaceDropdowns()` after `renderSystemWorkspaceList()` in the `constitutionFilesLoaded` case (`project.js:374`).
- **Edge Cases:** If `_constitutionWorkspaces` is empty, dropdowns are empty (sidebar shows "No workspaces open"). Auto-selection only triggers when no workspace is already selected, so re-loads (e.g. after save/delete) preserve the user's current selection.

### src/webview/project.js — Dropdown change handlers with edit-mode guard + sidebar sync
- **Context:** The sidebar click handlers (`project.js:1382-1387, 1452-1457`) already guard against dirty edit mode and update the `.selected` class. The dropdown `change` handlers must do the same.
- **Logic:** On dropdown change, find the matching workspace object in `_constitutionWorkspaces`, exit edit mode if dirty, update the sidebar `.selected` card, and call the existing `selectConstitutionWorkspace` / `selectSystemWorkspace`.
- **Implementation:**
  ```js
  if (constitutionWorkspaceFilter) {
      constitutionWorkspaceFilter.addEventListener('change', () => {
          const ws = _constitutionWorkspaces.find(w => w.workspaceRoot === constitutionWorkspaceFilter.value);
          if (!ws) return;
          if (state.dirtyFlags.constitution) exitEditMode('constitution');
          // Sync sidebar selection
          document.querySelectorAll('.constitution-file-item').forEach(el => el.classList.remove('selected'));
          const idx = _constitutionWorkspaces.indexOf(ws);
          const card = constitutionListPane?.querySelectorAll('.constitution-file-item')[idx];
          if (card) card.classList.add('selected');
          selectConstitutionWorkspace(ws);
      });
  }
  if (systemWorkspaceFilter) {
      systemWorkspaceFilter.addEventListener('change', () => {
          const ws = _constitutionWorkspaces.find(w => w.workspaceRoot === systemWorkspaceFilter.value);
          if (!ws) return;
          if (state.dirtyFlags.system) exitEditMode('system');
          document.querySelectorAll('.system-file-item').forEach(el => el.classList.remove('selected'));
          const idx = _constitutionWorkspaces.indexOf(ws);
          const card = systemListPane?.querySelectorAll('.system-file-item')[idx];
          if (card) card.classList.add('selected');
          selectSystemWorkspace(ws);
      });
  }
  ```
- **Edge Cases:** If the dropdown value doesn't match any workspace (shouldn't happen, but defensive), the handler no-ops. The sidebar sync uses index-based matching since the cards are rendered in the same order as `_constitutionWorkspaces`.

### src/webview/project.js — Sidebar click handler syncs dropdown value
- **Context:** The existing sidebar click handlers (`project.js:1382-1387, 1452-1457`) update `.selected` and call `selectConstitutionWorkspace` / `selectSystemWorkspace`. They do NOT update a dropdown (none existed).
- **Logic:** After `selectConstitutionWorkspace(ws)` / `selectSystemWorkspace(ws)` in the sidebar click handlers, set the dropdown value to `ws.workspaceRoot`.
- **Implementation:** In the Constitution sidebar click handler (`project.js:1386`), after `selectConstitutionWorkspace(ws)`:
  ```js
  if (constitutionWorkspaceFilter) constitutionWorkspaceFilter.value = ws.workspaceRoot;
  ```
  In the System sidebar click handler (`project.js:1456`), after `selectSystemWorkspace(ws)`:
  ```js
  if (systemWorkspaceFilter) systemWorkspaceFilter.value = ws.workspaceRoot;
  ```
- **Edge Cases:** Setting `.value` to a non-existent option is a no-op (dropdown stays at current value). Since the dropdown is populated from the same `_constitutionWorkspaces`, the value will always match.

### src/webview/project.js — selectConstitutionWorkspace / selectSystemWorkspace sync (Clarification)
- **Context:** `selectConstitutionWorkspace` (`project.js:1393`) and `selectSystemWorkspace` (`project.js:1463`) set the selected workspace and send `readConstitutionFile`. They are the single entry point for workspace selection.
- **Clarification (not a new requirement):** The dropdown value sync can be done either in the sidebar click handler (as above) or centrally in `selectConstitutionWorkspace` / `selectSystemWorkspace`. Centralizing is cleaner but modifies shared functions. The implementer may choose either approach as long as both controls stay in sync. If centralizing, add `if (constitutionWorkspaceFilter) constitutionWorkspaceFilter.value = ws.workspaceRoot;` at the end of `selectConstitutionWorkspace`, and the equivalent in `selectSystemWorkspace`.

## Verification Plan

### Automated Tests
- No automated tests required (per session directive: skip tests). The test suite will be run separately by the user.

### Manual Verification
- [ ] Constitution tab shows a workspace picker dropdown in the controls strip, listing all configured workspaces.
- [ ] System tab shows a workspace picker dropdown in the controls strip, listing all configured workspaces.
- [ ] Selecting a different workspace via the dropdown reloads that workspace's constitution (System: reloads the selected CLAUDE.md / AGENTS.md).
- [ ] Clicking a workspace in the sidebar list updates the dropdown to match (bidirectional sync).
- [ ] Selecting via the dropdown updates the sidebar's highlighted card (bidirectional sync).
- [ ] Switching to the Constitution tab auto-selects the first workspace (no more "Select a workspace..." empty state on load).
- [ ] Switching workspaces while editing exits edit mode first (no silent data loss).
- [ ] Sidebar governance badges (C/Cl/A) still display correctly after dropdown selection.
- [ ] Single-workspace project: dropdown shows one entry, auto-selected, no regression.
- [ ] Multi-workspace project: all workspaces appear in both dropdown and sidebar; switching works in both directions.

## Recommendation

Complexity is 5 (Mixed — majority routine UI additions, with one moderate risk: bidirectional sync between two controls). **Send to Coder.**

---

## Reviewer Pass — 2026-06-24

### Stage 1: Grumpy Principal Engineer Review

*Theatrical adversarial pass. Findings severity-tagged.*

**[MAJOR] Sidebar has no highlighted card on initial auto-selection — bidirectional sync broken on first load.**
`src/webview/project.js:373-378` (original). The `constitutionFilesLoaded` handler calls `renderConstitutionWorkspaceList()` and `renderSystemWorkspaceList()` BEFORE `populateConstitutionWorkspaceDropdowns()`. On first tab activation, `_constitutionSelectedWorkspace` is `null` when the sidebar renders, so NO `.constitution-file-item` gets the `.selected` class. Then `populateConstitutionWorkspaceDropdowns` auto-selects the first workspace via `selectConstitutionWorkspace()`, which sets the dropdown `.value` and fires `readConstitutionFile` — but does NOT touch the sidebar DOM. Net result: the dropdown shows workspace #1 selected, the constitution content loads, but the sidebar looks like nothing is selected. The plan's entire "bidirectional sync" requirement — the ONE moderate-risk item — is silently broken on the most common code path (initial load). This is exactly the desync the Adversarial Synthesis warned about. Unacceptable.

**[NIT] Redundant dropdown value assignment in change handler.**
`src/webview/project.js:1428` / `:1512`. The dropdown `change` handler calls `selectConstitutionWorkspace(ws)`, which centrally sets `constitutionWorkspaceFilter.value = ws.workspaceRoot`. But the dropdown value is already `ws.workspaceRoot` — that's literally what fired the `change` event. Harmless but sloppy. The plan's clarification section explicitly offered the centralized approach; the implementer chose it correctly, but didn't prune the now-redundant implicit re-set. Not worth fixing — it's a no-op assignment.

**[NIT] Empty `<select>` renders narrow before `constitutionFilesLoaded` fires.**
`src/webview/project.html:1360,1398`. The `<select>` elements start empty (no options). Before the `constitutionFilesLoaded` message arrives, they render as a minimal-width dropdown. This is a transient state (the message fires immediately on tab switch) and matches the behavior of the sidebar's "Loading workspaces..." placeholder. Not a real issue.

**[INFO] No disabled placeholder option added.**
The plan offered two alternatives: "a disabled placeholder ('Select workspace…') OR auto-select the first workspace." The implementer chose auto-selection only, with no placeholder. This is correct — a placeholder would be immediately replaced by auto-selection and adds no value. Consistent with plan intent.

**[INFO] Centralized sync approach chosen (per plan clarification).**
The implementer placed `constitutionWorkspaceFilter.value = ws.workspaceRoot` inside `selectConstitutionWorkspace` / `selectSystemWorkspace` rather than in the sidebar click handlers. This is the cleaner approach the plan's clarification section explicitly permitted. The sidebar click handlers correctly rely on this centralization and do NOT redundantly set the dropdown value. Good architectural choice.

### Stage 2: Balanced Synthesis

| Finding | Severity | Verdict | Action |
|:---|:---|:---|:---|
| Sidebar no `.selected` on initial auto-select | MAJOR | **Fix now** — breaks core bidirectional sync requirement on the primary code path | Reorder: call `populateConstitutionWorkspaceDropdowns()` BEFORE `renderConstitutionWorkspaceList()` / `renderSystemWorkspaceList()` in the `constitutionFilesLoaded` handler, so auto-selection sets `_constitutionSelectedWorkspace` before the sidebar renders |
| Redundant dropdown value set in change handler | NIT | Defer — harmless no-op | No action |
| Empty `<select>` narrow before load | NIT | Defer — transient, matches existing sidebar placeholder pattern | No action |
| No placeholder option | INFO | Keep — correct per plan alternatives | No action |
| Centralized sync approach | INFO | Keep — cleaner, plan-approved | No action |

### Fixes Applied

1. **`src/webview/project.js:373-382`** — Reordered the `constitutionFilesLoaded` handler: `populateConstitutionWorkspaceDropdowns()` now runs BEFORE `renderConstitutionWorkspaceList()` and `renderSystemWorkspaceList()`. Added explanatory comment. This ensures auto-selection sets `_constitutionSelectedWorkspace` / `_systemSelectedWorkspace` before the sidebar lists render, so the correct card receives `.selected`. Verified `selectConstitutionWorkspace` / `selectSystemWorkspace` do not reference sidebar DOM, making the reorder safe.

2. **`src/webview/project.js` + `src/webview/project.html`** — Removed all 17 `alert()` calls and 1 `confirm()` call from `project.js` (per user directive and CLAUDE.md policy — both are silent no-ops in VS Code webviews). Changes:
   - Added `showToast(message, type)` function (line 74) — lightweight floating notification that auto-dismisses after 4s with fade-out.
   - Added `.toast-notification` CSS (error/success/info variants) in `project.html`.
   - Removed 8 `alert('Please select a workspace first.')` guards in Constitution/System button handlers — these were dead code because the buttons are already `disabled` when no workspace is selected (all button-enable sites are guarded by `_constitutionSelectedWorkspace` / `_systemSelectedWorkspace` checks inside `constitutionFileRead` / `constitutionStatus` / `constitutionFileDeleted` handlers).
   - Replaced 9 remaining `alert()` calls (error notifications, upload results, save failures, epic validation) with `showToast(msg, 'error'|'success')`.
   - Removed 1 `confirm('Delete this insight?')` gate in the Tuning tab delete-insight handler (line 697) — was a broken no-op that prevented the delete button from ever working. Delete now fires immediately per CLAUDE.md policy.

### Validation Results

- **Typecheck/compile:** Skipped per session directive (SKIP COMPILATION).
- **Tests:** Skipped per session directive (SKIP TESTS).
- **Manual code trace:** Verified the full execution path for (a) initial load with multiple workspaces, (b) subsequent reloads with existing selection, (c) dropdown→sidebar sync, (d) sidebar→dropdown sync, (e) edit-mode guard on workspace switch, (f) button disabled-state when no workspace selected (all enable sites guarded), (g) showToast scope (defined at line 74, all 9 call sites within same IIFE). All paths correct after fixes.
- **Grep verification:** Zero `alert(` or `confirm(` calls remain in `project.js` (only comment references).
- **Git policy:** No state-mutating git commands executed. Read-only `git log` / `git show` used for diff inspection only.

### Files Changed in Review

| File | Change |
|:---|:---|
| `src/webview/project.js` | Reordered `constitutionFilesLoaded` handler calls + comment (lines 373-382); added `showToast()` function (line 74); removed 8 workspace-selection alert() guards; replaced 9 alert() calls with `showToast()`; removed 1 confirm() gate in tuning delete-insight handler |
| `src/webview/project.html` | Added `.toast-notification` CSS (error/success/info variants + slide-in animation) before `</style>` |

### Remaining Risks

- **alert() in other webview files (out of scope):** `kanban.html:9165` (`alert('Epic name is required.')`), `design.js:3638` (`alert('Please enter a display name.')`), `design.js:3688` (`alert('Please select at least one screen...')`). Same no-op bug, but outside the `project.js` scope the user specified. Should be addressed in a separate pass.
- **No automated test coverage** for the bidirectional sync logic or the new toast notification. Manual verification checklist in the plan must be exercised by the user.
- **Index-based card matching** in dropdown change handlers (`_constitutionWorkspaces.indexOf(ws)`) assumes sidebar cards are rendered in the same order as `_constitutionWorkspaces`. This holds today but is fragile if the sidebar render logic ever filters/reorders. Low risk given current code.
- **Toast stacking:** Multiple rapid toasts will stack vertically at the same fixed position (bottom-right). Not a bug, but could overlap if many errors fire simultaneously. Low risk in practice.
