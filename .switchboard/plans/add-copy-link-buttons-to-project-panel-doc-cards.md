# Add Copy Link Buttons to Project Panel Doc Sidebar Cards

## Goal

Add a per-card **Copy Link** button to the sidebar cards in the **Projects**, **Constitution**, and **System** tabs of `project.html` so a user can copy the underlying file path to the clipboard in one click and paste it into an agent chat.

### Problem / Background

The Kanban and Features tabs already expose a `Copy Link` button on each plan card. That button copies the plan file path via `navigator.clipboard.writeText(toAgentRef(path))`, swaps its label to `Copied` for two seconds, and uses `stopPropagation` so it does not also select the card. The Projects tab (per-project PRDs), Constitution tab (project constitution), and System tab (`CLAUDE.md` / `AGENTS.md`) render sidebar cards with the same visual styling but do not expose the file path, so there is no equivalent one-click way to ask an agent to work on those documents. The user confirmed the scope: behave **exactly** like the Kanban plan Copy Link buttons, no more and no less.

## Metadata

- **Tags:** frontend, backend, ui, ux
- **Complexity:** 4

## User Review Required

None. Requester confirmed: "exactly like the buttons in the kanban plans tab, no more, no less."

## Complexity Audit

### Routine

- Extending two existing backend payloads with absolute file paths.
- Adding a conditional button to existing `buildGovDocRow()` and `renderProjectsList()` renderers in `project.js`.
- Reusing the existing `.kanban-plan-copy-link` CSS class and `toAgentRef()` helper.
- Adding a click handler that writes to the clipboard, flips the label to `Copied`, and calls `e.stopPropagation()`.

### Complex / Risky

- **Path resolution must stay consistent with existing helpers:** PRDs use `sanitizeProjectSlug()` (`prdUtils.ts`) and constitutions support a custom active path (`constitutionUtils.ts`). The plan must reuse those helpers rather than reimplement them in the webview.
- **Workspace mapping:** `allWorkspaceProjects` is keyed and merged into effective (mapped) roots. The new per-project path lookup must follow the same merge semantics or the Projects tab will copy a path from the wrong workspace.
- **Backward compatibility:** `kanbanPlansReady` is also consumed by `kanban.html` and `planning.js`. The existing `allWorkspaceProjects` shape must remain unchanged; the new data should be delivered in an additional payload key.

## Edge-Case & Dependency Audit

- **Race Conditions:** None for the copy action itself. Path payloads are computed on the existing request/response paths (`fetchKanbanPlans`, `loadConstitutionFiles`).
- **Security:** Only absolute paths under known workspace roots are exposed. No new file reads beyond existing `fs.existsSync` checks; no writes.
- **Side Effects:** Writes to the system clipboard. Click must `stopPropagation()` so it does not trigger card selection (which could also prompt to discard unsaved edits).
- **Dependencies & Conflicts:** Reuses existing `getProjectPrdPath` and `getGovernanceFilePath` / `_getGovernanceFilePath`. No new runtime dependencies.

## Dependencies

- None external.
- Internal helpers: `src/services/prdUtils.ts::getProjectPrdPath`, `src/services/constitutionUtils.ts::getGovernanceFilePath`, and `src/webview/sharedUtils.js::toAgentRef`.

## Adversarial Synthesis

Key risks: (1) Path mismatch — custom constitution paths or PRD slug sanitization diverge between backend and the copied link, producing a dead file reference. (2) Workspace mapping collision — two mapped roots containing a project with the same name could copy the wrong path. (3) The button might be hidden for a newly-created doc until the next `kanbanPlansReady`/`loadConstitutionFiles` refresh. Mitigations: derive paths from the same helpers used for read/save, merge project paths with the same first-wins `Set` semantics as `allWorkspaceProjects`, and verify `fs.existsSync` before advertising the button.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

#### 1. Constitution / System list payload (`loadConstitutionFiles`)

The `governance` array already returns `{ key, exists }`. Extend each entry to also include `filePath` (absolute) by calling `_getGovernanceFilePath(ws.workspaceRoot, key)`.

```ts
const governance = (['constitution', 'claude', 'agents'] as const).map(key => ({
    key,
    exists: fs.existsSync(this._getGovernanceFilePath(ws.workspaceRoot, key)),
    filePath: this._getGovernanceFilePath(ws.workspaceRoot, key),
}));
```

Only the `constitutionFilesLoaded` response shape changes; the additional field is ignored by any other consumers.

#### 2. Projects list payload (`fetchKanbanPlans`)

Alongside the existing `allWorkspaceProjects: Record<string, string[]>`, build a new `allWorkspaceProjectPaths: Record<string, Record<string, { filePath: string; exists: boolean }>>`.

For each workspace root and project name:

1. Compute `filePath = getProjectPrdPath(root, projectName)`.
2. Compute `exists = fs.existsSync(filePath)`.
3. Store under the resolved root.
4. When an effective (mapped) root differs from the resolved root, merge into the effective root using the same `Set` / first-wins semantics as `allWorkspaceProjects` so the path lookup matches the displayed project list.

Add `allWorkspaceProjectPaths` to the `kanbanPlansReady` postMessage payload. Existing webviews that do not read it will ignore it.

### `src/webview/project.html`

No new CSS is strictly required; reuse the existing `.kanban-plan-copy-link` and `.kanban-plan-actions` rules already used by Kanban plan cards. If the button needs to be right-aligned inside doc cards that lack a right-side complexity dot, apply `style="margin-left: auto;"` to the button or introduce a tiny new class `.doc-copy-link { margin-left: auto; }` that does not alter the Kanban card layout.

### `src/webview/project.js`

#### 1. State for project PRD paths

Add near the other workspace caches:

```js
let _kanbanAllWorkspaceProjectPaths = {};
```

In the `kanbanPlansReady` message handler, store the new payload when present:

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

Add a helper that matches the Kanban card behavior exactly:

```js
function wireCopyLinkButton(button, filePath) {
    if (!button || !filePath) return;
    button.addEventListener('click', e => {
        e.stopPropagation();
        navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
            const oldText = button.textContent;
            button.textContent = 'Copied';
            setTimeout(() => button.textContent = oldText, 2000);
        }).catch(() => {
            const oldText = button.textContent;
            button.textContent = 'Failed';
            setTimeout(() => button.textContent = oldText, 2000);
        });
    });
}
```

#### 3. Constitution and System cards

Update `buildGovDocRow(className, title, ws, exists, selected, onClick)` to accept a `filePath` argument. In the rendered HTML, add a `.kanban-plan-actions` row containing a `Copy Link` button only when `exists && filePath`:

```js
const copyLinkHtml = exists && filePath
    ? `<div class="kanban-plan-actions">
           <button class="kanban-plan-copy-link doc-copy-link" data-file-path="${escapeHtml(filePath)}" style="margin-left: auto;">Copy Link</button>
       </div>`
    : '';
```

Wire it after the click listener with `wireCopyLinkButton(row.querySelector('.kanban-plan-copy-link'), filePath)`.

Update `renderConstitutionDocList` and `renderSystemDocList` to pass the `filePath` from the `ws.governance` entry into `buildGovDocRow`.

#### 4. Projects cards

In `renderProjectsList`, after creating each `item` div, set its inner HTML so the project name is wrapped with a Copy Link button when a path exists:

```js
const prdInfo = _kanbanAllWorkspaceProjectPaths[normalizeRoot(wsRoot)]?.[proj];
const copyLinkHtml = prdInfo?.exists
    ? `<div class="kanban-plan-actions">
           <button class="kanban-plan-copy-link doc-copy-link" data-file-path="${escapeHtml(prdInfo.filePath)}" style="margin-left: auto;">Copy Link</button>
       </div>`
    : '';
item.innerHTML = `
    <div style="font-weight: 500;">${escapeHtml(proj)}</div>
    ${copyLinkHtml}
`;
wireCopyLinkButton(item.querySelector('.kanban-plan-copy-link'), prdInfo?.filePath);
```

Keep the existing card click listener for selection; the button's `stopPropagation` will prevent it from firing.

## Verification Plan

### Automated

- Run `npm run lint` after changes.
- Run any existing project-panel regression tests:
  - `src/test/project-panel-opening-lock.test.js`
  - `src/test/project-panel-restore-guard.test.js`
  - `src/test/native-project-api-commands-regression.test.js`
- If the project panel has a webview UI test harness, add an assertion that the Copy Link button exists on Constitution/System/Projects cards when the underlying file exists and that `navigator.clipboard.writeText` is called with the expected absolute path.

### Manual

1. Install the built VSIX and open the Switchboard Project panel.
2. **Constitution tab:** Select a workspace with a `CONSTITUTION.md` (or custom active constitution). Verify the sidebar card shows `Copy Link`. Click it; confirm the absolute file path is on the clipboard, the button briefly reads `Copied`, and the card is not selected.
3. **System tab:** Repeat for `CLAUDE.md` and `AGENTS.md` cards.
4. **Projects tab:** Select a workspace and a project that has a PRD at `.switchboard/projects/<slug>/prd.md`. Verify the project card shows `Copy Link` and copies the correct PRD path. Then select a project with no PRD and confirm the button is absent.
5. Test multi-root and mapped workspaces: ensure the copied path corresponds to the workspace root shown by the filter, not a mapped parent/child.
6. Confirm that existing Kanban and Features Copy Link buttons still behave identically (no regression).

## Recommendation

Complexity 4 → **Send to Coder**.
