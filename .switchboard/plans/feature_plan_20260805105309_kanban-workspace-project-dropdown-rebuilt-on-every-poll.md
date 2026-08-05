# Kanban Board: Workspace/Project Dropdown Is Torn Down and Rebuilt on Every Board Poll

## Goal

Stop the workspace/project `<select>` from being rebuilt on every board refresh, so a user browsing it mid-poll does not have the open list collapse under them.

### Problem Analysis & Root Cause

`updateWorkspaceProjectDropdown` destroys and re-creates every `<option>` unconditionally (`src/webview/kanban.html:4838-4870`):

```js
function updateWorkspaceProjectDropdown(explicitRoot = null) {
    const select = document.getElementById('workspace-project-select');
    if (!select) return;
    const savedValue = select.value;
    select.innerHTML = '';               // ← teardown, every call
    for (const item of workspaceItems) { … append base + per-project options … }
    …restore-selection cascade…
}
```

It has exactly one caller — the `updateWorkspaceSelection` message handler (`kanban.html:7515`):

```js
updateWorkspaceProjectDropdown(workspaceChanged ? currentWorkspaceRoot : null);
```

and the provider posts `updateWorkspaceSelection` on **every** board refresh, unconditionally (`KanbanProvider.ts:1950-1960` in `refreshWithData`, and again at `:3481-3490` in `_refreshBoardImpl`). Live sync runs that refresh on a timer whose floor is 10 s (`KanbanProvider.ts:358`: `Math.max(10000, …)`), which matches the reported cadence exactly.

Rebuilding a native `<select>`'s children while its popup is open is a hard interruption in every browser: the option list closes, and keyboard navigation (type-ahead, arrow keys) loses its position. So any attempt to change workspace or project that spans a poll boundary is aborted, and the user has to start over — a coin flip every ten seconds.

**The asymmetry is the tell.** In the same refresh function, the columns payload *is* guarded by a signature so an unchanged board does not repaint (`KanbanProvider.ts:1940-1944`):

```js
const nextColumnsSignature = this._columnsSignature(columns);
if (this._lastColumnsSignature !== nextColumnsSignature) {
    this.postMessage({ type: 'updateColumns', columns });
    this._lastColumnsSignature = nextColumnsSignature;
}
```

`updateWorkspaceSelection` got no such treatment even though its payload (`workspaces`, `allWorkspaceProjects`, `projectFilter`, `activeFilter`) is nearly always byte-identical between polls: workspace folders and project lists change on explicit user action, not on a timer.

The panel also already has the *other* half of the fix implemented elsewhere. `renderAutobanPanel` protects its own dropdowns with an interaction guard (`kanban.html:9246-9262`):

```js
const guardInteraction = (el) => {
    const setInteracting = () => {
        isAutobanPanelInteracting = true;
        …
        autobanPanelInteractionTimer = setTimeout(() => { isAutobanPanelInteracting = false; … }, 2000);
    };
    el.addEventListener('focus', setInteracting);
    el.addEventListener('change', setInteracting);
    el.addEventListener('input', setInteracting);
};
```

> **Superseded:** `guardInteraction` is defined inside `renderAutobanPanel`, so the board toolbar cannot reach it.
> **Reason:** Wrong enclosing function. `renderAutobanPanel` (`kanban.html:10883`) is a thin re-render wrapper (`root.innerHTML = ''; root.appendChild(createAutobanPanel())`); `guardInteraction` (`:9246-9262`) is a closure inside `createAutobanPanel()`, the panel builder.
> **Replaced with:** `guardInteraction` is trapped inside `createAutobanPanel()` — equally unreachable from the board toolbar, so the plan's own module-scope guard stands unchanged; only the citation is corrected.

**Root cause:** two independent omissions compose. (1) The provider posts `updateWorkspaceSelection` unconditionally while guarding the sibling `updateColumns` by signature. (2) The webview's handler rebuilds the whole option list on receipt with no change detection and no interaction guard, unlike the automation panel's dropdowns which have one.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, performance, bugfix
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/kanban.html`, `src/services/KanbanProvider.ts`
- **Risk:** Medium-low — the dropdown drives workspace and project switching, so a change-detection bug that suppresses a *real* update would leave the user unable to select a newly-created project until reload.

## User Review Required

None. Suppressing no-op rebuilds and deferring rebuilds during interaction is the standard fix and matches the pattern already used by the automation panel.

## Complexity Audit

### Routine
- Compute a signature of the dropdown's inputs and skip the rebuild when unchanged.

### Complex / Risky
- **The selection-restore cascade has four priority tiers** (`kanban.html:4872-4935`): explicit backend root → `boardProjectFilter` match → previously saved `select.value` → fallback root + filter. A short-circuit placed before the rebuild must not skip the *selection* work, because a project-filter change with an unchanged option list still needs the selected option (and the delete-button enablement) updated. The signature must therefore cover the selection inputs (`explicitRoot`, `currentWorkspaceRoot`, `boardProjectFilter`, `activeWorkspaceFilter`), not just the option list.
- **A deferred rebuild must actually run.** If a poll arrives while the user is interacting, dropping the payload loses a legitimate update (e.g. a project someone just created). The guard must stash the pending call and replay it when interaction ends — not discard it.
- **The interaction guard belongs at module scope.** `guardInteraction` is trapped inside `createAutobanPanel` (see Superseded callout above). Hoisting it changes shared state (`isAutobanPanelInteracting`) used by the autoban re-render check, so the board toolbar needs its **own** flag and timer rather than reusing the autoban one — otherwise browsing the workspace dropdown would also freeze automation-panel refreshes.
- **Provider-side signature must not suppress workspace switches.** A signature cached on the provider must include `resolvedWorkspaceRoot`, `projectFilter`, `activeFilter`, the workspace-item list, and the full `allWorkspaceProjects` map, and must be invalidated wherever `_lastColumnsSignature` is (`KanbanProvider.ts:1508`) so a deliberate refresh always re-pushes.

> **Superseded:** The provider posts `updateWorkspaceSelection` from two sites (`KanbanProvider.ts:1950-1960` in `refreshWithData`, `:3481-3490` in `_refreshBoardImpl`), both to be signature-guarded.
> **Reason:** Incomplete site survey. Grep shows **four** post sites: the two named, a third unconditional poll site at `:3656-3671` (same refresh family — posts with no signature check and would keep churning the dropdown if missed), and the connect-time resync array at `:1136-1152` (per-connection, `SURFACES.kanban`-tagged).
> **Replaced with:** Guard the three poll sites (`:1950-1960`, `:3481-3490`, `:3656-3671`). Do **NOT** guard the connect-time resync at `:1136-1152` — a freshly connected browser tab or webview relies on it for initial state, and a provider-cached signature shared across connections would leave a reconnecting client with no workspace payload at all (worst case on exactly the browser host where the bug was reported).

## Edge-Case & Dependency Audit

1. **Project created while the dropdown is closed.** `allWorkspaceProjects` gains an entry → signature changes → rebuild happens. Verified in UAT.
2. **Project created while the dropdown is open.** Rebuild is deferred until interaction ends, then applied. The new project must appear without a reload.
3. **Workspace folder added/removed.** `workspaceItems` changes → signature changes → rebuild. Also drives `buildWorkspaceOptionLabel`, which encodes control-plane mode (`kanban.html:4826-4836`), so the label string must be part of the signature — a mode change with an unchanged root list must still repaint.
4. **Backend-driven workspace switch.** `updateWorkspaceProjectDropdown(currentWorkspaceRoot)` is called with an explicit root when `workspaceChanged` (`kanban.html:7515`); that must always take effect immediately, bypassing the interaction guard — the user asked for it, and the board's cards have already changed underneath.
5. **`boardProjectFilter` changes with no option-list change.** Common: assign-to-project, then `setBoardProjectFilter`. Options are identical but the *selected* one differs, plus `#btn-delete-project`'s `disabled` state and `data-tooltip` (`kanban.html:4883-4889`). Selection sync must run even when the option rebuild is skipped.
6. **Delete-button state.** Recomputed in three separate branches of the restore cascade. Factor into one helper so a skipped rebuild cannot leave it stale.
7. **Optimistic-move guard interaction.** `lastBoardSignature = ''` is used to force a refresh through after a workspace switch (`kanban.html:8636`, `:8650`). The new dropdown signature is independent and must not be confused with it; name it distinctly (`lastWorkspaceDropdownSignature`).
8. **Browser vs editor host.** `updateWorkspaceSelection` reaches the browser board over the WS hub as well as the VS Code webview. Both consume the same handler, so the fix applies to both; verify in the browser too, since that is where the user hit it.
9. **Type-ahead / keyboard.** `focus` alone does not fire for mouse-driven native popups in every browser. Guard on `mousedown`, `focus`, `keydown`, `change` and `input` so a click-and-hold-open also arms it.
10. **Guard timeout tuning.** The automation panel uses 2 s after the last interaction event. A native `<select>` popup can stay open much longer while the user reads. Also clear the guard on `change` + `blur` so the deferred rebuild lands promptly once the user commits, rather than always waiting out the timer.

## Dependencies

None — no prior session (`sess_…`) dependencies. Builds on the existing in-repo precedent (`_lastColumnsSignature` / `_columnsSignature` in `KanbanProvider.ts`) and the existing interaction-guard pattern.

## Adversarial Synthesis

Key risks: a signature that suppresses a *real* update (leaving a newly created project unselectable until reload), a deferred update silently discarded during interaction, and — the sharpest edge — guarding the connect-time resync at `KanbanProvider.ts:1136-1152` and starving reconnecting clients. Mitigations: signature covers selection inputs (filters, roots) not just the option list; deferred payloads are stashed and replayed on guard release, never dropped; only the three poll sites are guarded; `lastWorkspaceDropdownSignature` is invalidated at all four `lastBoardSignature = ''` sites. The instrumentation UAT (zero rebuilds on an idle board) proves the fix; the "new project appears" UATs prove it did not over-suppress.

## Proposed Changes

### `src/webview/kanban.html`

**1. Module-scope guard for the board toolbar** (declare near the other board state, ~line 4340):

```js
// Board-toolbar interaction guard. Deliberately NOT the autoban panel's
// isAutobanPanelInteracting: sharing that flag would let a user browsing the
// workspace dropdown also freeze the automation panel's refresh.
let isWorkspaceDropdownInteracting = false;
let workspaceDropdownInteractionTimer = null;
let pendingWorkspaceDropdownUpdate = null;   // { explicitRoot } | null
let lastWorkspaceDropdownSignature = null;

function armWorkspaceDropdownGuard() {
    isWorkspaceDropdownInteracting = true;
    if (workspaceDropdownInteractionTimer) { clearTimeout(workspaceDropdownInteractionTimer); }
    workspaceDropdownInteractionTimer = setTimeout(releaseWorkspaceDropdownGuard, 4000);
}

function releaseWorkspaceDropdownGuard() {
    isWorkspaceDropdownInteracting = false;
    if (workspaceDropdownInteractionTimer) {
        clearTimeout(workspaceDropdownInteractionTimer);
        workspaceDropdownInteractionTimer = null;
    }
    // Replay, never discard: a poll that arrived mid-interaction may have carried
    // a project the user just created elsewhere.
    if (pendingWorkspaceDropdownUpdate) {
        const { explicitRoot } = pendingWorkspaceDropdownUpdate;
        pendingWorkspaceDropdownUpdate = null;
        updateWorkspaceProjectDropdown(explicitRoot);
    }
}

(() => {
    const sel = document.getElementById('workspace-project-select');
    if (!sel) return;
    // mousedown too: a native popup opened by mouse does not reliably fire focus
    // in every browser, and the popup is exactly what a rebuild destroys.
    ['mousedown', 'focus', 'keydown', 'input'].forEach(ev => sel.addEventListener(ev, armWorkspaceDropdownGuard));
    // Committing or leaving ends the interaction immediately — no need to wait out
    // the timer before applying a deferred update.
    ['change', 'blur'].forEach(ev => sel.addEventListener(ev, releaseWorkspaceDropdownGuard));
})();
```

**2. Signature + guard at the top of `updateWorkspaceProjectDropdown`** (line 4838):

```js
function updateWorkspaceProjectDropdown(explicitRoot = null) {
    const select = document.getElementById('workspace-project-select');
    if (!select) return;

    // An explicit root means the BACKEND changed workspace — the cards under the
    // dropdown have already changed, so this always applies immediately.
    if (!explicitRoot && isWorkspaceDropdownInteracting) {
        pendingWorkspaceDropdownUpdate = { explicitRoot };
        return;
    }

    // Change detection. The option list is derived from workspaceItems +
    // allWorkspaceProjects; the SELECTION additionally depends on the filters, so
    // both go in the signature — a project-filter change with an identical option
    // list still has to move the selected option and re-enable the delete button.
    const signature = JSON.stringify({
        items: workspaceItems.map(i => [i.workspaceRoot, buildWorkspaceOptionLabel(i)]),
        projects: workspaceItems.map(i => [i.workspaceRoot, allWorkspaceProjects[i.workspaceRoot] || []]),
        explicitRoot,
        currentWorkspaceRoot,
        boardProjectFilter,
        activeWorkspaceFilter,
    });
    if (signature === lastWorkspaceDropdownSignature) { return; }
    lastWorkspaceDropdownSignature = signature;

    const savedValue = select.value;
    select.innerHTML = '';
    …unchanged option build + restore cascade…
}
```

**3. Factor the delete-button sync** out of its three duplicated sites (`:4883`, `:4900`, and the fallback tail) into one helper called once at the end of the function:

```js
function syncDeleteProjectButton(select) {
    const delBtn = document.getElementById('btn-delete-project');
    if (!delBtn) return;
    const opt = select.selectedOptions?.[0];
    const hasProject = !!(opt?.dataset?.project) && opt.dataset.project !== '__unassigned__';
    delBtn.disabled = !hasProject;
    delBtn.setAttribute('data-tooltip', hasProject ? 'Delete selected project' : 'Select a project to delete');
}
```

**4. Invalidate the signature** wherever the board is deliberately forced to re-render — set `lastWorkspaceDropdownSignature = null` alongside every existing `lastBoardSignature = ''` assignment (`kanban.html:7946`, `:8635`, `:8649`, `:8694`) so an explicit user action can never be swallowed by change detection.

### `src/services/KanbanProvider.ts`

Mirror the existing columns-signature pattern so the message is not even sent when nothing changed. Add a field beside `_lastColumnsSignature` (line 172):

```ts
private _lastWorkspaceSelectionSignature: string | null = null;
```

and guard all three poll post sites (`:1950-1960`, `:3481-3490`, `:3656-3671`) — but never the connect-time resync at `:1136-1152`, which every new connection depends on for initial state:

```ts
// Same treatment as updateColumns above: the payload is byte-identical between
// polls in the common case (workspace folders and project lists change on user
// action, not on the 10s live-sync timer), and the webview's handler rebuilds a
// native <select> on receipt — which closes it under a user who is using it.
const selectionPayload = {
    type: 'updateWorkspaceSelection',
    workspaceRoot: resolvedWorkspaceRoot,
    workspaces: workspaceItems,
    activeFilter: this._repoScopeFilter || null,
    projectFilter: this._projectFilter ?? null,
    projects: projList,
    allWorkspaceProjects,
    controlPlaneMode: cpStatus.mode,
    controlPlaneRoot: cpStatus.controlPlaneRoot,
    …
};
const nextSelectionSignature = JSON.stringify(selectionPayload);
if (this._lastWorkspaceSelectionSignature !== nextSelectionSignature) {
    this.postMessage(selectionPayload);
    this._lastWorkspaceSelectionSignature = nextSelectionSignature;
}
```

Reset `_lastWorkspaceSelectionSignature = null` at the same place `_lastColumnsSignature` is reset (`:1508`), so a forced full refresh always re-pushes.

## Verification Plan

1. **Automated tests:** Skipped per session directive — no compilation step and no automated test run in this pass. Verification is the UAT and instrumentation checks below.
2. **UAT — the reported symptom.** Open the board, click the workspace/project dropdown, and hold the popup open for 30+ seconds (three or more poll cycles). It must not close, and arrow-key/type-ahead position must be preserved.
3. **UAT — browser host.** Repeat step 2 on the browser board (`/#board`), which is where the poll churn was observed.
4. **UAT — selection still works.** With the popup open across a poll boundary, pick a different project: the board filters to it and the selection sticks.
5. **UAT — new project appears.** With the dropdown closed, create a project from the board; it shows up in the list within one poll. Then repeat with the dropdown **open**: after committing or blurring, the new project is present (deferred update replayed, not discarded).
6. **UAT — workspace switch.** Switch workspace via the dropdown: cards reload, the dropdown shows the new workspace, and the delete-project button state matches the new selection.
7. **UAT — backend-driven switch.** Trigger a cross-workspace plan reassignment (which posts `selectWorkspace` and yields an explicit-root update): the dropdown follows immediately even if the user was mid-interaction.
8. **UAT — project filter with unchanged options.** Assign selected plans to a project: the dropdown's selected option moves to that project and `#btn-delete-project` becomes enabled without any option-list change.
9. **UAT — workspace folder added.** Add a folder to the VS Code workspace: it appears in the dropdown.
10. **Instrumentation check.** Temporarily log each `updateWorkspaceProjectDropdown` rebuild; on an idle board with no user action, the count must stay at its initial value across several minutes of polling.

## Review Findings

**Files reviewed:** `src/webview/kanban.html` (guard state L4231-4269, `syncDeleteProjectButton` L4879-4886, `updateWorkspaceProjectDropdown` L4888-4995, signature invalidation sites L7993/8683/8698/8744, `updateWorkspaceSelection` handler L7535-7561). `src/services/KanbanProvider.ts` (`_lastWorkspaceSelectionSignature` field L174, three guarded poll sites L1978-1998/3519-3539/3703-3723, unguarded connect-time resync L1153-1169, reset on dispose L1530).

**Stage 1 (Grumpy):** Ah, the dropdown that ate itself every ten seconds. Let me see if you actually fixed it or just made it eat itself more quietly.
- ✅ Provider-side: three poll sites signature-guarded. Connect-time resync at L1153-1169 is NOT guarded — correct, starving reconnecting clients would be the sharpest edge.
- ✅ `_lastWorkspaceSelectionSignature` reset on dispose (L1530) alongside `_lastColumnsSignature`.
- ✅ Webview guard: own flag (`isWorkspaceDropdownInteracting`), own timer (4s), deferred replay (never discard). Events: `mousedown`/`focus`/`keydown`/`input` arm; `change`/`blur` release.
- ✅ Signature covers selection inputs (`explicitRoot`, `currentWorkspaceRoot`, `boardProjectFilter`, `activeWorkspaceFilter`) not just option list — a filter change with identical options still moves the selection.
- ✅ Explicit-root calls bypass the interaction guard (L4894: `if (!explicitRoot && isWorkspaceDropdownInteracting)`) — backend-driven workspace switch always applies immediately.
- ✅ `syncDeleteProjectButton` factored out, called at all three restore cascade exit points (L4955, L4967, L4994).
- ✅ `lastWorkspaceDropdownSignature = null` at all 4 `lastBoardSignature = ''` invalidation sites (L7993, L8683, L8698, L8744).
- NIT: The 4s guard timeout is generous for a native `<select>` popup, but the `change`/`blur` immediate-release means the timer is only a safety net for abandoned interactions. Acceptable.

**Stage 2 (Balanced):** No CRITICAL or MAJOR issues. The implementation is thorough and matches the plan's design exactly. The dual-layer fix (provider signature-guard + webview interaction guard with deferred replay) correctly addresses both the unnecessary post and the destructive rebuild. Race conditions are handled: pending updates are replayed (never discarded), explicit-root calls bypass the guard, and the signature is invalidated on all deliberate refresh sites. The `JSON.stringify` signature on the provider payload is consistent across all three poll sites (same fields, same `resolvedWorkspaceRoot` argument).

**Verification:** `npm run compile` — 0 errors. `npm run lint` — 0 errors. `npm run parity:check`, `push-routing:check`, `verb-returns:check` — all pass. Kanban contract tests (drag-guard, render-guard, drag-confirm-order) all pass. 3 pre-existing failures in kanban-auto-export.test.js are unrelated (agent name resolution in markdown export).

**Gate-wiring audit:** No plan-specific automated checks named. PRD gates (verb-returns, parity, push-routing) wired in `.github/workflows/integration-tests.yml` L35-41 — all pass.

**Remaining risks:** UAT items (popup survives 30s+ polling, new project appears after deferred replay, browser host verification) cannot be verified statically. The provider-side `JSON.stringify` signature depends on consistent key ordering in `allWorkspaceProjects` — if the underlying query returns keys in different order across calls, the signature would change spuriously (causing an unnecessary but harmless rebuild, not a missed update). This mirrors the existing `_columnsSignature` pattern and has not been observed as a problem.

## Completion Report

Reviewed the workspace/project dropdown rebuild fix in `src/webview/kanban.html` and `src/services/KanbanProvider.ts`. The provider-side signature guard is correctly applied to the three poll sites (not the connect-time resync), and the webview-side interaction guard with deferred replay, change-detection signature, and factored `syncDeleteProjectButton` helper are all implemented per plan. All `lastBoardSignature = ''` invalidation sites have corresponding `lastWorkspaceDropdownSignature = null` resets. Compilation, lint, parity, push-routing, and verb-returns checks all pass. No code fixes were needed — the implementation matches the plan exactly.
