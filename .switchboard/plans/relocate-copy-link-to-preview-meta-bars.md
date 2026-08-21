# Relocate Copy Link to Preview Meta-Bars Across All Panels

## Goal

### Problem

Copy Link buttons currently live only on sidebar cards across all doc-type preview panels (planning.html, project.html, tickets.html, design.html). Users instinctively look for a link-copy action in the top function bar (meta-bar) of each document preview, not buried in a sidebar card's action row. This discoverability gap is a persistent UX friction point.

### Background

The codebase has a consistent layout pattern: a sidebar list pane (left) + a preview panel (right) with a meta-bar / controls strip above the preview content. The meta-bar carries document-specific actions (Edit, Save, Cancel, Review, Delete, etc.). Copy Link was added to sidebar cards as a per-card convenience but was never promoted to the meta-bar, making it invisible to users who expect it alongside the other document actions.

### Root Cause

Copy Link was implemented as a card-level affordance (`.kanban-plan-copy-link` / `.doc-card-copy-link` CSS classes, rendered in card template strings) rather than as a meta-bar action. Each panel's meta-bar was built independently, and none of them included a Copy Link button. The feature was never promoted to the function bar.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, refactor
**Project:** Browser Switchboard

## User Review Required

This plan touches 6 frontend files across 4 panels. The tickets.html Copy Link (Step 2) requires a backend change to include `filePath` in the `localTicketFileRead` response — the user should review this backend modification before implementation. The Constitution/System/Projects/Archives controls-strip wiring (Step 3) requires accessing module-level selection state variables that are not currently exposed to the controls strip — the user should confirm the chosen lookup paths are correct.

## Complexity Audit

### Routine

- Adding `<button>` elements to static HTML meta-bars / controls strips (planning.html, tickets.html, project.html, design.html)
- Renaming the design.html "Link" button label to "Copy Link" (label-only change, no JS change)
- Removing Copy Link buttons from sidebar card template strings and their event listeners (project.js, planning.js, design.js)
- Wiring click handlers via `navigator.clipboard.writeText(toAgentRef(filePath))` with "Copied" feedback (same pattern as all existing Copy Link buttons)

### Complex / Risky

- **Tickets Copy Link file path gap**: the `localTicketFileRead` backend response does NOT include `filePath` (confirmed: `_readTicketFilePayload` at TicketsPanelProvider.ts:732 returns `{ title, content, rawContent }` only). The selected ticket objects (`selectedClickUpIssue` / `selectedLinearIssue`) do not carry `filePath`. The file path IS available on the sidebar list items (`clickUpProjectIssues` / `linearProjectIssues` have `filePath` from `localTicketFilesListed`), but not in the selection state. A backend change is needed to include `filePath` in the `localTicketFileRead` response, OR the frontend must look up the file path from the sidebar list by ticket id.
- **Constitution/System controls-strip wiring**: the controls strip buttons are static HTML. Their click handlers need to access the currently selected file path, which is stored in module-level variables (`_constitutionSelectedFile`, `_systemSelectedFile`). These are set when a governance file is read (project.js:1014, 1066) and cleared when no file exists (project.js:959, 991). The click handler must read these variables at click time, not at init time.
- **Projects controls-strip wiring**: the PRD file path is stored in `_kanbanAllWorkspaceProjectPaths[normalizeRoot(wsRoot)]?.[projectName]?.filePath` (a nested lookup). The selected project name is in `_selectedProjectName` and the workspace filter is in `projectsWorkspaceFilter.value`. The click handler must compose these three to resolve the file path.
- **Cross-plan coordination**: this plan and the "add-copy-prompt-and-advance" plan both edit the kanban sidebar card template (~line 1715 in project.js). Both remove buttons from the same template string. They must be coordinated.

## Edge-Case & Dependency Audit

### Race Conditions

- The kanban and feature meta-bars are rebuilt via `innerHTML` on every selection. Copy Link click handlers must be registered after each render. The existing pattern (register listeners immediately after `metaBar.innerHTML = ...`) is safe.
- The static controls-strip buttons (Constitution, System, Projects, Archives) are registered once at init. Their click handlers read module-level state at click time, so they always see the current selection. No race.

### Security

- No new attack surface. All Copy Link buttons use `navigator.clipboard.writeText()` with a file path that is already available in the webview state. No backend-to-frontend path disclosure that doesn't already exist via the sidebar card Copy Link buttons being removed.

### Side Effects

- Removing Copy Link from sidebar cards makes the `.kanban-plan-copy-link` and `.doc-card-copy-link` CSS blocks dead. They are harmless and can remain (cross-panel CSS is shared). No CSS removal needed.
- The `wireCopyLinkButton` helper function (project.js:1389) is used by the Projects sidebar card (line 1506) and the Constitution/System sidebar card (line 2880). After removing Copy Link from those cards, `wireCopyLinkButton` becomes dead code. It can be removed or left as a utility — leaving it is safer (no breakage if other call sites exist).

### Dependencies & Conflicts

- **Cross-plan conflict with "add-copy-prompt-and-advance"**: both plans edit the kanban sidebar card template in project.js (~line 1715) and the vestigial planning.js kanban card template (~line 5673). Both remove buttons from the same template strings. If both plans are implemented, coordinate the edits — the template strings must have both Copy Link and Copy Prompt removed in a single pass.
- **Tickets backend dependency**: Step 2 requires adding `filePath` to the `localTicketFileRead` response in `TicketsPanelProvider.ts`. This is a backend change that must be coordinated with the frontend wiring.
- **`toAgentRef()` is a passthrough**: confirmed at sharedUtils.js:7 — returns the path as-is (no `@` prefix). All Copy Link buttons copy the raw absolute path. No change to this function.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the tickets Copy Link has no file path source in the selected ticket state — the `localTicketFileRead` response omits `filePath`, so the button would copy `undefined` without a backend change; (2) the Constitution/System/Projects/Archives controls-strip buttons need to access module-level selection state variables (`_constitutionSelectedFile`, `_systemSelectedFile`, `_kanbanAllWorkspaceProjectPaths`, `_archivesSelectedPlan`) that are not currently referenced from the controls strip; (3) cross-plan coordination with the "add-copy-prompt-and-advance" plan on the shared sidebar card template. Mitigations: backend includes `filePath` in `localTicketFileRead`; controls-strip handlers read module-level state at click time; both plans' template edits are coordinated.

## Proposed Changes

### `src/webview/planning.html` — Add Copy Link to docs meta-bar

**Context:** The docs preview meta-bar (`#docs-preview-meta-bar`, line 3700) is static HTML with Edit, Save, Cancel, Push, and "Draft with agent" buttons. It is shown/hidden when a doc is selected/deselected.

**Logic:** Add a Copy Link button as the first button in the meta-bar:
```html
<button id="btn-copy-doc-link" class="strip-btn" disabled>Copy Link</button>
```

Place it before the existing Edit button (line 3701).

**Edge Cases:** The button starts disabled. It must be enabled when a doc is selected and disabled when no doc is selected. The enable/disable logic lives in planning.js (same code path that toggles Edit/Save/Cancel).

### `src/webview/planning.js` — Wire Copy Link in docs meta-bar

**Context:** The active doc's file path is available from the doc selection state that feeds `loadDocumentPreview`. The existing Copy Link on the vestigial kanban card (line 5700) uses `toAgentRef(planFile)`.

**Logic:**
- Enable/disable `btn-copy-doc-link` when a doc is selected/deselected (in the same code path that toggles Edit/Save/Cancel buttons)
- Wire click handler:
```javascript
const btnCopyDocLink = document.getElementById('btn-copy-doc-link');
if (btnCopyDocLink) {
    btnCopyDocLink.addEventListener('click', () => {
        if (!activeDocFilePath) return;
        navigator.clipboard.writeText(toAgentRef(activeDocFilePath)).then(() => {
            btnCopyDocLink.textContent = 'Copied';
            setTimeout(() => btnCopyDocLink.textContent = 'Copy Link', 2000);
        });
    });
}
```

**Edge Cases:** `activeDocFilePath` must be tracked in the doc selection state. If the variable name differs, use whatever variable holds the selected doc's file path in the selection handler.

### `src/webview/planning.js` — Remove Copy Link from vestigial kanban card

**Context:** The vestigial kanban plan card template (line 5673) has a Copy Link button. Its event listener is at lines 5700-5721.

**Logic:** Remove the Copy Link button from the template string (line 5673). Remove the `copyLinkBtn` event listener block (lines 5700-5721).

**Edge Cases:** This code is dead (kanban tab moved to project.html). The "add-copy-prompt-and-advance" plan also removes Copy Prompt from this same template. Coordinate both edits.

### `src/webview/tickets.html` — Add Copy Link to tickets meta-bar

**Context:** The tickets preview meta-bar (`#tickets-preview-meta-bar`, line 4058) is static HTML with Edit, Save, Cancel, Push buttons. It is shown when a ticket is selected.

**Logic:** Add a Copy Link button as the first button:
```html
<button id="btn-copy-ticket-link" class="strip-btn" disabled>Copy Link</button>
```

Place it before the existing Edit button (line 4059).

### `src/services/TicketsPanelProvider.ts` — Include `filePath` in `localTicketFileRead` response

> **Superseded:** The ticket file path is available from the selected ticket state (the same state that feeds the ticket preview).
> **Reason:** This is FALSE. The `localTicketFileRead` response contains `{ title, content, rawContent }` — NO `filePath` (confirmed: `_readTicketFilePayload` at TicketsPanelProvider.ts:732). The selected ticket objects (`selectedClickUpIssue.task` / `selectedLinearIssue.issue`) are built from detail-cache entries that don't include `filePath`. Without a file path source, the Copy Link button would copy `undefined` to the clipboard.
> **Replaced with:** Add `filePath` to the `localTicketFileRead` response in the backend, and store it on the selected ticket object in the frontend. This covers all cases including drill-down subtasks.

**Context:** The `readLocalTicketFile` handler (TicketsPanelProvider.ts:2431) resolves the file path via `_findTicketFilePath` (line 2443) but only passes it to `_readTicketFilePayload` which returns `{ title, content, rawContent }`. The file path is available in the handler scope but not included in the response.

**Logic:** Modify the `localTicketFileRead` response to include `filePath`:

At line 2455, change:
```typescript
const res = { type: 'localTicketFileRead', provider, id, success: true, ...payload };
```
to:
```typescript
const res = { type: 'localTicketFileRead', provider, id, success: true, filePath, ...payload };
```

Also add `filePath: undefined` (or omit it) to the error responses at lines 2439, 2445, 2451 for consistency — the frontend should handle `filePath` being absent on failure.

**Edge Cases:** The `_emitTicketFileChanged` method (line 750) also calls `_readTicketFilePayload` and posts `ticketFileChanged`. That message should also include `filePath` for consistency. Modify line 752:
```typescript
this.postMessageToWebview({ type: 'ticketFileChanged', provider, id, filePath, ...payload });
```

### `src/webview/tickets.js` — Wire Copy Link in tickets meta-bar

**Context:** After the backend change, the `localTicketFileRead` and `ticketFileChanged` responses will include `filePath`. The frontend must store this on the selected ticket object and use it for the Copy Link button.

**Logic:**
1. In the `localTicketFileRead` handler (~line 7878) and the `ticketFileChanged` handler, store `message.filePath` on the selected ticket object:
```javascript
// After setting selectedClickUpIssue / selectedLinearIssue:
if (message.filePath) {
    if (message.provider === 'clickup' && selectedClickUpIssue) {
        selectedClickUpIssue.filePath = message.filePath;
    } else if (message.provider === 'linear' && selectedLinearIssue) {
        selectedLinearIssue.filePath = message.filePath;
    }
}
// Enable the Copy Link button
const btnCopyTicketLink = document.getElementById('btn-copy-ticket-link');
if (btnCopyTicketLink) {
    btnCopyTicketLink.disabled = !message.filePath;
}
```

2. Wire the click handler (at init time, near other button initializations):
```javascript
const btnCopyTicketLink = document.getElementById('btn-copy-ticket-link');
if (btnCopyTicketLink) {
    btnCopyTicketLink.addEventListener('click', () => {
        const filePath = (selectedClickUpIssue && selectedClickUpIssue.filePath)
            || (selectedLinearIssue && selectedLinearIssue.filePath)
            || '';
        if (!filePath) return;
        navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
            btnCopyTicketLink.textContent = 'Copied';
            setTimeout(() => btnCopyTicketLink.textContent = 'Copy Link', 2000);
        });
    });
}
```

3. Disable the button when no ticket is selected or when the selected ticket has no local file (in the same code path that hides/clears the preview).

**Edge Cases:**
- Remote-only tickets (ClickUp/Linear without local file): `filePath` will be absent from the `localTicketFileRead` response (the `not-imported` reason path at line 2445 doesn't include it). The button stays disabled.
- Drill-down subtasks: the `localTicketFileRead` response covers subtasks too (the handler doesn't distinguish top-level from subtask). The `filePath` will be included for any ticket that has a local file.
- Alternative approach (no backend change): look up `filePath` from `clickUpProjectIssues` / `linearProjectIssues` by ticket id. This works for top-level tickets but NOT for drill-down subtasks (which come from `_drillDownSubtasks`, a different array that may not carry `filePath`). The backend change is cleaner and covers all cases.

### `src/webview/project.js` — Add Copy Link to kanban meta-bar (`renderKanbanMetaBar()`)

**Context:** `renderKanbanMetaBar()` (~line 1968) builds the meta-bar via `innerHTML`. The selected plan's file path is `plan.planFile`.

**Logic:** Add a Copy Link button to the meta-bar innerHTML, in the right group before Review:
```html
${plan.planFile ? `<button class="strip-btn" id="kanban-meta-copy-link-btn">Copy Link</button>` : ''}
```

Wire the click handler after innerHTML render:
```javascript
const copyLinkBtn = document.getElementById('kanban-meta-copy-link-btn');
if (copyLinkBtn) {
    copyLinkBtn.addEventListener('click', () => {
        const path = _kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : null;
        if (!path) return;
        navigator.clipboard.writeText(toAgentRef(path)).then(() => {
            copyLinkBtn.textContent = 'Copied';
            setTimeout(() => copyLinkBtn.textContent = 'Copy Link', 2000);
        });
    });
}
```

**Edge Cases:** The button is only rendered when `plan.planFile` exists. Plans without a file path get no Copy Link button.

### `src/webview/project.js` — Add Copy Link to feature meta-bar (`renderFeatureMetaBar()`)

**Context:** `renderFeatureMetaBar()` (~line 2509) builds the feature meta-bar via `innerHTML`. The selected feature's file path is `_featureSelectedPlan.planFile` or `_featurePreviewFilePath`.

**Logic:** Add a Copy Link button to the meta-bar innerHTML:
```html
${(_featureSelectedPlan && _featureSelectedPlan.planFile) ? `<button class="strip-btn" id="feature-meta-copy-link-btn">Copy Link</button>` : ''}
```

Wire the click handler after innerHTML render:
```javascript
const featureCopyLinkBtn = document.getElementById('feature-meta-copy-link-btn');
if (featureCopyLinkBtn) {
    featureCopyLinkBtn.addEventListener('click', () => {
        const path = _featurePreviewFilePath || (_featureSelectedPlan && _featureSelectedPlan.planFile) || '';
        if (!path) return;
        navigator.clipboard.writeText(toAgentRef(path)).then(() => {
            featureCopyLinkBtn.textContent = 'Copied';
            setTimeout(() => featureCopyLinkBtn.textContent = 'Copy Link', 2000);
        });
    });
}
```

**Edge Cases:** `renderFeatureSubtaskMetaBar()` (~line 2597) ALREADY has a Copy Link button (`feature-subtask-meta-copy-link-btn`). Do NOT duplicate it. Only `renderFeatureMetaBar()` needs the new button.

### `src/webview/project.html` — Add Copy Link to Constitution controls strip

**Context:** The Constitution controls strip (line 1411) has Build, Copy Build Prompt, Update, Copy Update Prompt, Enable, Edit, Save, Cancel, Delete buttons. The selected file path is in `_constitutionSelectedFile` (set at project.js:1014).

**Logic:** Add a Copy Link button to the controls strip:
```html
<button id="btn-copy-constitution-link" class="strip-btn" disabled>Copy Link</button>
```

### `src/webview/project.js` — Wire Constitution Copy Link

**Context:** `_constitutionSelectedFile` is set when a constitution file is read (line 1014) and cleared when no file exists (line 959). It's `null` when no file is selected.

**Logic:** Wire the click handler at init time:
```javascript
const btnCopyConstitutionLink = document.getElementById('btn-copy-constitution-link');
if (btnCopyConstitutionLink) {
    btnCopyConstitutionLink.addEventListener('click', () => {
        if (!_constitutionSelectedFile) return;
        navigator.clipboard.writeText(toAgentRef(_constitutionSelectedFile)).then(() => {
            btnCopyConstitutionLink.textContent = 'Copied';
            setTimeout(() => btnCopyConstitutionLink.textContent = 'Copy Link', 2000);
        });
    });
}
```

Enable/disable the button when `_constitutionSelectedFile` changes — in the same code paths that set/clear it (lines 1014, 959, 1038):
```javascript
if (btnCopyConstitutionLink) btnCopyConstitutionLink.disabled = !_constitutionSelectedFile;
```

**Edge Cases:** When `_constitutionSelectedFile` is `null` (no file exists for the selected workspace), the button stays disabled.

### `src/webview/project.html` — Add Copy Link to System controls strip

**Context:** The System controls strip (line 1450) has Build, Copy Build Prompt, Edit, Save, Cancel, Delete, Architect Prompt, Review buttons. The selected file path is in `_systemSelectedFile` (set at project.js:1066).

**Logic:** Add a Copy Link button to the controls strip:
```html
<button id="btn-copy-system-link" class="strip-btn" disabled>Copy Link</button>
```

### `src/webview/project.js` — Wire System Copy Link

**Context:** `_systemSelectedFile` is set when a system file is read (line 1066) and cleared when no file exists (line 991, 1080).

**Logic:** Wire the click handler at init time (same pattern as Constitution):
```javascript
const btnCopySystemLink = document.getElementById('btn-copy-system-link');
if (btnCopySystemLink) {
    btnCopySystemLink.addEventListener('click', () => {
        if (!_systemSelectedFile) return;
        navigator.clipboard.writeText(toAgentRef(_systemSelectedFile)).then(() => {
            btnCopySystemLink.textContent = 'Copied';
            setTimeout(() => btnCopySystemLink.textContent = 'Copy Link', 2000);
        });
    });
}
```

Enable/disable in the same code paths that set/clear `_systemSelectedFile` (lines 1066, 991, 1080):
```javascript
if (btnCopySystemLink) btnCopySystemLink.disabled = !_systemSelectedFile;
```

### `src/webview/project.html` — Add Copy Link to Projects controls strip

**Context:** The Projects controls strip (line 1325) has Build, Copy Build Prompt, Edit, Save, Cancel, Project Context, Architect Prompt, Review buttons. The PRD file path is in `_kanbanAllWorkspaceProjectPaths[normalizeRoot(wsRoot)]?.[projectName]?.filePath`.

**Logic:** Add a Copy Link button to the controls strip:
```html
<button id="btn-copy-prd-link" class="strip-btn" disabled>Copy Link</button>
```

### `src/webview/project.js` — Wire Projects Copy Link

**Context:** The PRD file path is resolved via `_kanbanAllWorkspaceProjectPaths[normalizeRoot(projectsWorkspaceFilter.value)]?.[_selectedProjectName]?.filePath`. The `_kanbanAllWorkspaceProjectPaths` is a module-level variable (line 212), `_selectedProjectName` is module-level (line 1413), and `projectsWorkspaceFilter` is the workspace dropdown element (line 405).

**Logic:** Wire the click handler at init time:
```javascript
const btnCopyPrdLink = document.getElementById('btn-copy-prd-link');
if (btnCopyPrdLink) {
    btnCopyPrdLink.addEventListener('click', () => {
        const wsRoot = projectsWorkspaceFilter ? projectsWorkspaceFilter.value : '';
        const projectName = _selectedProjectName;
        const prdInfo = projectName ? _kanbanAllWorkspaceProjectPaths[normalizeRoot(wsRoot)]?.[projectName] : null;
        const filePath = prdInfo?.filePath;
        if (!filePath) return;
        navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
            btnCopyPrdLink.textContent = 'Copied';
            setTimeout(() => btnCopyPrdLink.textContent = 'Copy Link', 2000);
        });
    });
}
```

Enable/disable the button when a project is selected and has a PRD file — in the `renderProjectsList` function and the `projectPrdContent` handler:
```javascript
const wsRoot = projectsWorkspaceFilter ? projectsWorkspaceFilter.value : '';
const prdInfo = _selectedProjectName ? _kanbanAllWorkspaceProjectPaths[normalizeRoot(wsRoot)]?.[_selectedProjectName] : null;
if (btnCopyPrdLink) btnCopyPrdLink.disabled = !prdInfo?.filePath;
```

**Edge Cases:** PRDs are DB-backed but may have a local file path (the sidebar card Copy Link at line 1506 uses `prdInfo?.filePath`). When `prdInfo?.exists` is false or `prdInfo?.filePath` is absent, the button stays disabled.

### `src/webview/project.html` — Add Copy Link to Archives controls strip

**Context:** The Archives controls strip (line 1520) has workspace filter, search, Query Archives, Refresh buttons. The selected archived plan's file path is in `_archivesSelectedPlan.plan_file || _archivesSelectedPlan.planFile` (set at project.js:3658).

**Logic:** Add a Copy Link button to the controls strip:
```html
<button id="btn-copy-archive-link" class="strip-btn" disabled>Copy Link</button>
```

### `src/webview/project.js` — Wire Archives Copy Link

**Context:** `_archivesSelectedPlan` is a module-level variable (line 3597) set when an archived plan is clicked (line 3658). It stores the plan object from `_archivedPlansCache`, which has `plan_file` / `planFile` properties.

**Logic:** Wire the click handler at init time:
```javascript
const btnCopyArchiveLink = document.getElementById('btn-copy-archive-link');
if (btnCopyArchiveLink) {
    btnCopyArchiveLink.addEventListener('click', () => {
        if (!_archivesSelectedPlan) return;
        const filePath = _archivesSelectedPlan.plan_file || _archivesSelectedPlan.planFile || '';
        if (!filePath) return;
        navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
            btnCopyArchiveLink.textContent = 'Copied';
            setTimeout(() => btnCopyArchiveLink.textContent = 'Copy Link', 2000);
        });
    });
}
```

Enable/disable when an archived plan is selected — in the click handler at line 3658:
```javascript
if (btnCopyArchiveLink) {
    btnCopyArchiveLink.disabled = !(_archivesSelectedPlan && (_archivesSelectedPlan.plan_file || _archivesSelectedPlan.planFile));
}
```

**Edge Cases:** The Archives tab has no sidebar Copy Link button currently — this is a net-new affordance, not a relocation. The file path comes from the cached plan object, not from a backend read response.

### `src/webview/project.js` — Remove Copy Link from sidebar cards

**Context:** Copy Link buttons exist on four sidebar card templates in project.js:
1. Kanban plan card template (~line 1726): `.kanban-plan-copy-link` button + event listener (~lines 1742-1752)
2. Feature card template (~line 2366): `.kanban-plan-copy-link.feature-card-action` button + event listener (~lines 2418-2428)
3. Projects sidebar card template (~line 1490-1494): `.doc-card-copy-link` button + `wireCopyLinkButton` call (~line 1506)
4. Constitution/System sidebar card template (~line 2869-2873): `.doc-card-copy-link` button + `wireCopyLinkButton` call (~line 2880)

**Logic:** For each card template:
1. **Kanban plan card**: Remove the Copy Link button from the template string (line 1726). Remove the `copyLinkBtn` event listener block (lines 1742-1752).
2. **Feature card**: Remove the Copy Link button from the `actionButtons` template string (line 2366). Remove the `featureCopyLinkBtn` event listener block (lines 2418-2428).
3. **Projects card**: Remove the `copyLinkHtml` block (lines 1490-1494). Remove the `wireCopyLinkButton` call (line 1506).
4. **Constitution/System card**: Remove the `copyLinkHtml` block (lines 2869-2873). Remove the `wireCopyLinkButton` call (line 2880).

**Edge Cases:** The `wireCopyLinkButton` function (line 1389) becomes dead code after removing all call sites. It can be left as a utility or removed. Leaving it is safer (no breakage if other call sites exist that were not discovered).

### `src/webview/design.html` — Rename "Link" to "Copy Link"

**Context:** The design controls strip has a `<button id="btn-link-to-doc-design" class="strip-btn" disabled>Link</button>` at line 3703. The click handler (design.js:1954) already copies the file path via `linkToDocument`.

**Logic:** Rename the button label from `Link` to `Copy Link`:
```html
<button id="btn-link-to-doc-design" class="strip-btn" disabled>Copy Link</button>
```

No JS change needed — the click handler already works.

### `src/webview/design.js` — Remove Copy Link from stitch screen gallery cards

**Context:** The stitch screen gallery card (design.js:3076) creates a `btnLink` button that copies the screen's HTML/PNG path. The preview overlay already has a "Copy Link" button (`#preview-btn-png`, design.html:4111) that covers the selected-screen case.

**Logic:** Remove the `btnLink` button creation and append (lines 3076-3082). The `copyStitchAssetLink` function can remain (it's used by the preview overlay button too).

**Edge Cases:** The gallery card Copy Link and the preview overlay Copy Link serve different contexts — gallery is per-card (before selection), preview is for the selected screen. Removing the gallery button means users must open the preview to copy the link. This is acceptable — the preview overlay is the primary interaction surface.

## Verification Plan

### Automated Tests

No new automated tests are required. The existing test suite covers clipboard operations and message handler routing. The backend change to `localTicketFileRead` (adding `filePath`) should be covered by extending the existing ticket provider tests if any exist.

### Manual Verification

1. **planning.html**: Select a doc in the sidebar → verify Copy Link appears in the docs meta-bar → click it → verify the file path is on the clipboard → verify the sidebar card no longer has a Copy Link button

2. **project.html Kanban tab**: Select a plan → verify Copy Link appears in the kanban meta-bar → click it → verify file path copied → verify sidebar card no longer has Copy Link

3. **project.html Features tab**: Select a feature → verify Copy Link in feature meta-bar → select a subtask → verify Copy Link in subtask meta-bar (already existed) → verify feature sidebar card no longer has Copy Link

4. **project.html Constitution tab**: Select a workspace with a constitution file → verify Copy Link in controls strip is enabled → click → verify path copied → verify sidebar card no longer has Copy Link → select a workspace without a constitution file → verify Copy Link is disabled

5. **project.html System tab**: Same as Constitution — select a workspace with CLAUDE.md/AGENTS.md → verify Copy Link enabled → click → verify path copied → verify sidebar card no longer has Copy Link

6. **project.html Projects tab**: Select a project with a PRD file → verify Copy Link in controls strip is enabled → click → verify path copied → verify sidebar card no longer has Copy Link → select a project without a PRD file → verify Copy Link is disabled

7. **project.html Archives tab**: Select an archived plan → verify Copy Link in controls strip is enabled → click → verify path copied

8. **tickets.html**: Select a local ticket → verify Copy Link in tickets meta-bar is enabled → click → verify file path copied → select a remote-only ticket (no local file) → verify Copy Link is disabled

9. **design.html**: Verify the "Link" button is now labeled "Copy Link" → select a design doc → click Copy Link → verify file path copied → verify stitch gallery cards no longer have Copy Link → open a screen preview → verify the preview overlay's Copy Link button still works
