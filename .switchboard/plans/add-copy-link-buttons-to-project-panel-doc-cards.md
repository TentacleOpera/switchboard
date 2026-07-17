# Add Copy Link Buttons to Project Panel Doc Sidebar Cards

## Goal

Add a per-card **Copy Link** button to the sidebar cards in the **Projects**, **Constitution**, and **System** tabs of `project.html` so a user can copy the underlying file path to the clipboard in one click and paste it into an agent chat.

### Problem / Background

The Kanban and Features tabs already expose a `Copy Link` button on each plan card. That button copies the plan file path via `navigator.clipboard.writeText(toAgentRef(path))`, swaps its label to `Copied` for two seconds, and uses `stopPropagation` so it does not also select the card. The Projects tab (per-project PRDs), Constitution tab (project constitution), and System tab (`CLAUDE.md` / `AGENTS.md`) render sidebar cards with the same visual styling but do not expose the file path, so there is no equivalent one-click way to ask an agent to work on those documents. The user confirmed the scope: behave **exactly** like the Kanban plan Copy Link buttons, no more and no less.

## Metadata

- **Tags:** frontend, backend, ui, ux

> **Superseded:** Complexity: 4
> **Reason:** The change spans backend payload construction (`PlanningPanelProvider.ts`), webview state/normalization (`project.js`), and rendering/cards (`project.js`/`project.html`), with workspace-mapping merge semantics that must stay consistent. That fits the 5–6 "multi-file, moderate logic" band, not a single-file/low-risk change.
> **Replaced with:** Complexity: 5

## User Review Required

None. Requester confirmed: "exactly like the buttons in the kanban plans tab, no more, no less."

## Complexity Audit

### Routine

- Extending two existing backend payloads with absolute file paths.
- Adding a conditional button to existing `buildGovDocRow()` and `renderProjectsList()` renderers in `project.js`.
- Reusing the existing `.kanban-plan-copy-link` CSS class and `toAgentRef()` helper.
- Adding a click handler that writes to the clipboard, flips the label to `Copied`, and calls `e.stopPropagation()`.

### Complex / Risky

- Path resolution must stay consistent with existing helpers and with the effective (mapped) workspace root: PRDs use `sanitizeProjectSlug()` (`prdUtils.ts`) and constitutions support a custom active path (`constitutionUtils.ts`). `getProjectPrdPath` must be called with the effective root that `getProjectPrd` / `saveProjectPrd` resolve to; using the raw child root in a mapped workspace would copy a path the editor never reads.
- Workspace mapping: `allWorkspaceProjects` is keyed and merged into effective (mapped) roots. The new per-project path lookup must follow the same merge semantics or the Projects tab will copy a path from the wrong workspace.
- Backward compatibility: `kanbanPlansReady` is also consumed by `kanban.html` and `planning.js`. The existing `allWorkspaceProjects` shape must remain unchanged; the new data should be delivered in an additional payload key.
- Multi-consumer payloads: `constitutionFilesLoaded` is consumed only by `project.js`, but adding fields still requires consumers to ignore unknown keys safely (they do, via destructuring/field access). Renaming existing fields would break consumers.

## Edge-Case & Dependency Audit

- **Race Conditions:** None for the copy action itself. Path payloads are computed on the existing request/response paths (`fetchKanbanPlans`, `loadConstitutionFiles`).
- **Security:** Only absolute paths under known workspace roots are exposed. No new file reads beyond existing `fs.existsSync` checks; no writes. Custom constitution paths are constrained to the workspace root or an explicit absolute path stored in global state.
- **Side Effects:** Writes to the system clipboard. Click must `stopPropagation()` so it does not trigger card selection (which could also prompt to discard unsaved edits).
- **Dependencies & Conflicts:** Reuses existing `getProjectPrdPath` and `getGovernanceFilePath` / `_getGovernanceFilePath`. No new runtime dependencies.

## Dependencies

- None external.
- Internal helpers: `src/services/prdUtils.ts::getProjectPrdPath`, `src/services/constitutionUtils.ts::getGovernanceFilePath` (called via `src/services/PlanningPanelProvider.ts::_getGovernanceFilePath`), and `src/webview/sharedUtils.js::toAgentRef`.

## Adversarial Synthesis

Key risks: (1) Path mismatch — custom constitution paths or PRD slug sanitization diverge between backend and the copied link, producing a dead file reference. (2) Workspace mapping collision — two mapped roots containing a project with the same name could copy the wrong path unless the merge follows `allWorkspaceProjects` first-wins semantics **and** PRD paths are computed against the effective (mapped parent) root that `getProjectPrd` / `saveProjectPrd` use. (3) The button might be hidden for a newly-created doc until the next `kanbanPlansReady`/`loadConstitutionFiles` refresh. (4) The helper originally proposed a `.catch` branch with a `Failed` label, which diverges from the Kanban reference implementation. Mitigations: derive paths from the same helpers and the same effective root used for read/save, merge project paths with the same first-wins semantics, verify `fs.existsSync` before advertising the button, and mirror the Kanban copy-link wiring exactly (no catch branch).

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

#### 1. Constitution / System list payload (`loadConstitutionFiles`, lines ~4191–4210)

The `governance` array already returns `{ key, exists }`. Extend each entry to also include `filePath` (absolute) by calling `this._getGovernanceFilePath(ws.workspaceRoot, key)` once and reusing it for `exists`:

```ts
const governance = (['constitution', 'claude', 'agents'] as const).map(key => {
    const filePath = this._getGovernanceFilePath(ws.workspaceRoot, key);
    return {
        key,
        exists: fs.existsSync(filePath),
        filePath,
    };
});
```

Only the `constitutionFilesLoaded` response shape changes; the additional field is ignored by any other consumers.

#### 2. Projects list payload (`fetchKanbanPlans`, lines ~3701–3788)

Alongside the existing `allWorkspaceProjects: Record<string, string[]>`, build a new `allWorkspaceProjectPaths: Record<string, Record<string, { filePath: string; exists: boolean }>>`.

Inside the per-root loop, after `const projects = await db.getProjects(workspaceId);` (around line 3730), add:

```ts
const resolvedRoot = path.resolve(root);
const effectiveRoot = this._resolveEffectiveWorkspaceRoot(root);

const projectPaths: Record<string, { filePath: string; exists: boolean }> = {};
for (const projectName of projects) {
    // Use the same effective root that getProjectPrd / saveProjectPrd resolve to.
    const filePath = getProjectPrdPath(effectiveRoot, projectName);
    projectPaths[projectName] = { filePath, exists: fs.existsSync(filePath) };
}

allWorkspaceProjectPaths[resolvedRoot] = projectPaths;
if (effectiveRoot !== resolvedRoot) {
    const existing = allWorkspaceProjectPaths[effectiveRoot] || {};
    allWorkspaceProjectPaths[effectiveRoot] = {
        ...projectPaths,
        ...existing, // first-wins: keep existing project paths, add child-only projects
    };
}
```

Add `allWorkspaceProjectPaths` to both `kanbanPlansReady` `postMessage` payloads (around lines 3758 and 3773):

```ts
this._postToBothPanels({
    type: 'kanbanPlansReady',
    plans: allPlans,
    workspaceItems,
    allWorkspaceProjects,
    allWorkspaceProjectPaths,
    columns: mergedColumns,
    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
    requestId
});
```

> **Superseded:** The original plan left the per-project path-merge logic underspecified ("Store under the resolved root... using the same Set / first-wins semantics") and did not show the exact object shape or the two `kanbanPlansReady` emission sites.
> **Reason:** Without concrete code, an implementer can accidentally use `allWorkspaceProjectPaths[effectiveRoot] = { ...existing, ...projectPaths }` (last-wins), which would let a later child overwrite a parent project's path and produce a dead link.
> **Replaced with:** Compute `resolvedRoot` and `effectiveRoot` first; build `projectPaths` using `getProjectPrdPath(effectiveRoot, projectName)` so the copied path matches the root `getProjectPrd` / `saveProjectPrd` resolve to; set `allWorkspaceProjectPaths[resolvedRoot] = projectPaths`; and merge into `effectiveRoot` with `{ ...projectPaths, ...existing }` so existing (parent/earlier) entries win, exactly matching `allWorkspaceProjects` semantics. Include the new key in both `kanbanPlansReady` payloads.

### `src/webview/project.html`

No new CSS is strictly required; reuse the existing `.kanban-plan-copy-link` and `.kanban-plan-actions` rules already used by Kanban plan cards (lines ~385–410). Right-align the button inside doc cards by adding `style="margin-left: auto;"` to the Copy Link button element; this avoids adding a new class and keeps the Kanban card layout unchanged.

### `src/webview/project.js`

#### 1. State for project PRD paths

Add near the other workspace caches (around line 175, after `_kanbanAllWorkspaceProjects = {};`):

```js
let _kanbanAllWorkspaceProjectPaths = {};
```

In the `kanbanPlansReady` message handler (around lines 488–493), store the new payload when present:

```js
if (msg.allWorkspaceProjectPaths) {
    const normalized = {};
    for (const [k, v] of Object.entries(msg.allWorkspaceProjectPaths)) {
        normalized[normalizeRoot(k)] = v;
    }
    _kanbanAllWorkspaceProjectPaths = normalized;
}
```

#### 2. Shared Copy Link wiring helper

Add a helper that matches the Kanban card behavior exactly. Place it near `normalizeRoot` or before `renderProjectsList`.

> **Superseded:** The original `wireCopyLinkButton` helper included a `.catch` branch that changed the button text to `Failed` and captured `oldText` to restore it.
> **Reason:** The requester explicitly asked for "exactly like the buttons in the kanban plans tab, no more and no less." The existing Kanban copy link (`project.js` lines 1618–1625) has no `.catch` and resets the label to the literal `Copy Link`. Adding `Failed` feedback and `oldText` capture is extra behavior and can leave the button stuck on `Copied` if clicked twice within the timeout.
> **Replaced with:** Use a helper that mirrors the Kanban implementation:

```js
function wireCopyLinkButton(button, filePath) {
    if (!button || !filePath) return;
    button.addEventListener('click', e => {
        e.stopPropagation();
        navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
            button.textContent = 'Copied';
            setTimeout(() => button.textContent = 'Copy Link', 2000);
        });
    });
}
```

#### 3. Constitution and System cards

Update `buildGovDocRow(className, title, ws, exists, selected, onClick)` (lines ~2700–2714) to accept a `filePath` argument:

```js
function buildGovDocRow(className, title, ws, exists, filePath, selected, onClick) {
    const itemDiv = document.createElement('div');
    itemDiv.className = className;
    itemDiv.dataset.ws = ws.workspaceRoot;
    if (selected) itemDiv.classList.add('selected');
    const marker = exists
        ? '<span style="color: var(--accent-teal); font-weight: bold;">✓</span>'
        : '<span style="color: var(--text-secondary); opacity: 0.5;">•</span>';
    const copyLinkHtml = exists && filePath
        ? `<div class="kanban-plan-actions">
               <button class="kanban-plan-copy-link" data-file-path="${escapeHtml(filePath)}" style="margin-left: auto;">Copy Link</button>
           </div>`
        : '';
    itemDiv.innerHTML = `
        <div style="font-weight: 500;">${escapeHtml(title)}</div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">${escapeHtml(ws.label)} &nbsp;${marker}</div>
        ${copyLinkHtml}
    `;
    itemDiv.addEventListener('click', onClick);
    wireCopyLinkButton(itemDiv.querySelector('.kanban-plan-copy-link'), filePath);
    return itemDiv;
}
```

Update `renderConstitutionDocList` (lines ~2745–2781) to pass the `constitution` entry's `filePath` into `buildGovDocRow`:

```js
wss.forEach(ws => {
    const govEntry = ws.governance?.find(g => g.key === 'constitution');
    const selected = _constitutionSelectedWorkspace
        && _constitutionSelectedWorkspace.workspaceRoot === ws.workspaceRoot;
    const row = buildGovDocRow('constitution-file-item', 'Constitution', ws,
        govEntry?.exists, govEntry?.filePath, selected, () => {
            if (state.dirtyFlags.constitution) exitEditMode('constitution');
            constitutionListPane.querySelectorAll('.constitution-file-item')
                .forEach(el => el.classList.remove('selected'));
            row.classList.add('selected');
            selectConstitutionDoc(ws);
        });
    constitutionListPane.appendChild(row);
});
```

Update `renderSystemDocList` (lines ~2813–2855) to pass each doc's `filePath`:

```js
wss.forEach(ws => {
    SYSTEM_DOCS.forEach(doc => {
        const govEntry = ws.governance?.find(g => g.key === doc.key);
        const selected = _systemSelectedWorkspace
            && _systemSelectedWorkspace.workspaceRoot === ws.workspaceRoot
            && _systemSelectedGovKey === doc.key;
        const row = buildGovDocRow('system-file-item', doc.title, ws,
            govEntry?.exists, govEntry?.filePath, selected, () => {
                if (state.dirtyFlags.system) exitEditMode('system');
                systemListPane.querySelectorAll('.system-file-item')
                    .forEach(el => el.classList.remove('selected'));
                row.classList.add('selected');
                selectSystemDoc(ws, doc.key);
            });
        row.dataset.gov = doc.key;
        systemListPane.appendChild(row);
    });
});
```

> **Superseded:** The original plan proposed updating `renderConstitutionDocList` and `renderSystemDocList` to pass `filePath` but did not show how to extract the correct `governance` entry, nor did it update `buildGovDocRow`'s signature.
> **Reason:** Without the exact call-site changes an implementer could pass `ws.filePath` or `ws.governance.filePath` (which do not exist), or forget to thread the argument through `buildGovDocRow`.
> **Replaced with:** Use `ws.governance?.find(g => g.key === ...)` to extract the entry, pass `govEntry?.exists` and `govEntry?.filePath` into `buildGovDocRow`, and update `buildGovDocRow` to accept `filePath` before `selected`.

#### 4. Projects cards

In `renderProjectsList` (lines ~1415–1427), replace the per-project rendering block:

```js
projects.forEach(proj => {
    const item = document.createElement('div');
    item.className = 'kanban-plan-item'; // reuse shared item styling
    item.dataset.project = proj;
    const prdInfo = _kanbanAllWorkspaceProjectPaths[normalizeRoot(wsRoot)]?.[proj];
    const copyLinkHtml = prdInfo?.exists
        ? `<div class="kanban-plan-actions">
               <button class="kanban-plan-copy-link" data-file-path="${escapeHtml(prdInfo.filePath)}" style="margin-left: auto;">Copy Link</button>
           </div>`
        : '';
    item.innerHTML = `
        <div style="font-weight: 500;">${escapeHtml(proj)}</div>
        ${copyLinkHtml}
    `;
    item.addEventListener('click', () => {
        _selectedProjectName = proj;
        document.querySelectorAll('#projects-items-container .kanban-plan-item')
            .forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        requestProjectPrd();
    });
    wireCopyLinkButton(item.querySelector('.kanban-plan-copy-link'), prdInfo?.filePath);
    container.appendChild(item);
});
```

Keep the existing auto-select and PRD-load logic unchanged; the button's `stopPropagation()` will prevent it from firing the card selection handler.

> **Superseded:** The original plan set `item.textContent = proj` before replacing `innerHTML` and did not clarify whether the click listener should be attached before or after `innerHTML` insertion.
> **Reason:** Setting `textContent` before `innerHTML` is redundant and can confuse an implementer about listener lifetime. The listener lives on the `item` element and survives `innerHTML` replacement, but `wireCopyLinkButton` must run after the button exists in the DOM.
> **Replaced with:** Build `item`, set `innerHTML` with the project name and optional button, attach the card click listener, call `wireCopyLinkButton` on the new button, then append.

## Verification Plan

### Lint
- Run `npm run lint` after changes (no compilation or test execution required for this plan).

### Manual
1. Open the extension in a running VS Code instance (Extension Development Host or an already-installed VSIX).
2. **Constitution tab:** Select a workspace with a `CONSTITUTION.md` (or custom active constitution). Verify the sidebar card shows `Copy Link`. Click it; confirm the absolute file path is on the clipboard, the button briefly reads `Copied`, and the card is not selected.
3. **System tab:** Repeat for `CLAUDE.md` and `AGENTS.md` cards.
4. **Projects tab:** Select a workspace and a project that has a PRD at `.switchboard/projects/<slug>/prd.md`. Verify the project card shows `Copy Link` and copies the correct PRD path. Then select a project with no PRD and confirm the button is absent.
5. Test multi-root and mapped workspaces: ensure the copied path corresponds to the workspace root shown by the filter, not a mapped parent/child. Specifically verify that a project with the same name in two mapped roots copies the path from the root selected in the dropdown.
6. Confirm that existing Kanban and Features Copy Link buttons still behave identically (no regression): label flips to `Copied` for two seconds and resets to `Copy Link`; card selection not triggered.
7. Confirm that the System and Constitution cards still open and edit correctly and that clicking the title/workspace-label area (not the button) still selects the card.

### Automated Tests
- Automated test execution is skipped in this verification plan per the user's directive.

## Recommendation

Complexity 5 → **Send to Coder**.

## Completion Report

Implemented Copy Link buttons on Project, Constitution, and System sidebar cards in `project.js`, with backend support in `PlanningPanelProvider.ts`. No `project.html` edits were needed because existing `.kanban-plan-copy-link` / `.kanban-plan-actions` styles were reused. `loadConstitutionFiles` now sends each governance entry's absolute `filePath`; `fetchKanbanPlans` adds `allWorkspaceProjectPaths` keyed by resolved and effective workspace roots with first-wins merge semantics. `project.js` stores the new payload, wires buttons via `wireCopyLinkButton` mirroring the existing Kanban copy-link behavior (clipboard write, `Copied` for 2 s, `stopPropagation`), and renders the button conditionally for existing docs/PRDs. `npm run lint` passed with 0 errors (existing warnings remain). No compilation or tests were run per the plan.
