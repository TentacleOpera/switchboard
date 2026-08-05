# Memo Surfaces Need a Visible Workspace Indicator and an Independent Workspace Picker

## Goal

Show which workspace the memo is being written to on both memo surfaces (the standalone `memo.html` panel and the Memo sub-tab in `implementation.html`), and add a workspace dropdown that overrides the target for the memo only — defaulting to the Kanban board's workspace and never changing what the board displays.

### Problem Analysis & Root Cause

The memo is a per-workspace file (`.switchboard/memo.md`), written by verbs that all take a `workspaceRoot` argument — `memoLoad`, `memoSave`, `memoClear`, `memoGeneratePrompt` (allowlisted on `TaskViewerProvider`, routed at `PlanningPanelProvider.ts:114-119`, served at `POST /memo/verb/<verb>`). Which workspace a keystroke lands in is therefore always decided, but the user is barely told and cannot choose.

**`memo.html` — indicator exists but is weak, and there is no picker.** The header has one element (`memo.html:185-188`):

```html
<div class="memo-header">
    <span class="section-label">Memo</span>
    <span id="memo-workspace" class="memo-hint" title="Workspace this memo is saved to"></span>
</div>
```

`memo.js` fills it with a bare folder basename (`memo.js:15-18`) seeded from `data-initial-workspace-root` (stamped by `getMemoHtml`, `headlessPanelHtml.ts:379`), and updates it on the `workspaceChanged` message (`memo.js:56-67`). So the workspace *is* displayed — as dim hint-styled text with no label, sharing the `.memo-hint` class with the two paragraphs of instructional copy below it, which is why it reads as decoration rather than as state. There is no way to target a different workspace.

**`implementation.html` — no indicator at all.** The Memo sub-tab (`implementation.html:1584-1601`) has instructional copy, a textarea, a status span and three buttons. Nothing displays the workspace. Every verb call uses the sidebar's ambient `currentWorkspaceRoot` (`implementation.html:2637`, `:2687`, `:2699`, `:2707`, `:2713`), which is set from `initialState` / `workspaceChanged` (`:2170`, `:2319`) and is shared with the entire sidebar. A user with several roots open has no way to know which one a note went into and no way to redirect it.

**Why "does not affect the board" is the load-bearing constraint.** The board's workspace is a *singleton* on the provider side: switching it posts `selectWorkspace`, which re-resolves the active root, re-queries the DB and re-pushes `updateWorkspaceSelection` plus a full card set to every surface. Reusing that machinery for the memo would make picking a memo target silently reload the user's board. So the memo's override has to be local webview state that is only ever passed as the `workspaceRoot` argument to the four memo verbs — it must not post `selectWorkspace`, `setProjectFilter`, or any other board message.

**Root cause:** the memo was built with an implicit "current workspace" that it reads from whatever ambient signal its host provides (`data-initial-workspace-root` in the browser panel, `currentWorkspaceRoot` in the sidebar), and the verbs' `workspaceRoot` parameter — already fully plumbed — was never exposed to the user. The `memo.html` indicator was added but styled as a hint, and the sidebar copy of the same UI never got one.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, ui, ux
- **Project:** Browser Switchboard
- **Files touched:** `src/services/PlanningPanelProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/services/verbSchemas.ts`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts` (regenerated), `src/webview/memo.html`, `src/webview/memo.js`, `src/webview/implementation.html`
- **Risk:** Medium — the memo file is user-authored content. A picker that changes the target without flushing the pending debounced save writes the note into the wrong workspace, or loses it.

## User Review Required

None. The three requirements (show the workspace, add a picker, default to the Kanban workspace without affecting the board) fully specify the behaviour.

## Complexity Audit

### Routine
- Add a labelled workspace row to both memo surfaces.
- Populate a `<select>` and store the selection in local webview state.

### Complex / Risky
- **No verb returns the workspace list to the memo surface.** The memo panel's verb set is exactly the four memo verbs; `buildWorkspaceItems(this._getWorkspaceRoots())` exists (`workspaceUtils.ts:6`) and is used by the Design/Tickets/Planning providers, but nothing exposes it on the memo route. A new verb is required, which means editing `protocol-catalog.json` and running `npm run catalog:generate` — the allowlist in `src/generated/verbAllowlist.ts` is auto-generated and must not be hand-edited.
- **The debounced save is the data-loss hazard.** `memo.js` and `implementation.html` both debounce `memoSave` (`memo.js:_memoSaveTimer`, `implementation.html:2681-2688`, both ~keystroke-debounced). Switching workspace with a timer pending would fire the save against the **new** root, writing workspace A's text into workspace B's memo. The switch must flush the pending save against the **old** root first, then clear the textarea, then load the new root.
- **`memoContent` races the switch.** The content handler ignores incoming content while the textarea is focused or dirty (`memo.js:69-78`, `implementation.html:2184-2193`) — a guard that exists to stop a poll clobbering typing. After a deliberate switch the local text is *not* the new workspace's content, so the dirty flag must be cleared as part of the switch or the newly-loaded memo is discarded. `memo.js`'s existing `workspaceChanged` arm already does exactly this (`memo.js:57-66`) and is the model to follow.
- **Two independent notions of "current workspace" in the sidebar.** `implementation.html`'s `currentWorkspaceRoot` drives more than the memo. The memo override must be a *separate* variable, defaulting to `currentWorkspaceRoot`, so nothing else in the sidebar is affected.
- **`workspaceChanged` must not stomp an explicit override.** The board pushing a new workspace currently rewrites the memo target unconditionally (`memo.js:57`). Once the user has explicitly chosen a memo workspace, a board switch must leave it alone — otherwise the override is undone by the next board action, which is the same class of bug as the poll churn elsewhere in this panel family.

## Edge-Case & Dependency Audit

1. **Single-root workspace.** The picker has one entry. Render it (disabled or not) rather than hiding it, so the indicator is always present — the whole point is that the user knows where the note goes.
2. **Root list changes while the memo is open** (folder added/removed). Repopulating must preserve the current selection when the root is still present, and fall back to the Kanban/default root when it is not. A removed root must not leave the memo writing to a stale path.
3. **Default resolution order.** (a) an explicit in-session override; (b) the Kanban/host-provided workspace (`data-initial-workspace-root` in the browser panel, `currentWorkspaceRoot` in the sidebar). No persistence of the override — the issue says opening the memo should still default to the Kanban workspace, so persisting it would violate that.
4. **Verb payload validation.** `memoSave`'s schema exists (`verbSchemas.ts:1519`) and takes `workspaceRoot`; the new list verb needs its own schema entry or it passes through unvalidated per the generic-dispatch contract. Add one.
5. **Server-side root validation.** The new verb must return only roots the server actually knows (`buildWorkspaceItems(this._getWorkspaceRoots())`) — never echo a caller-supplied path. The existing memo verbs already resolve/validate `workspaceRoot` server-side; confirm an unknown root is rejected rather than creating `.switchboard/memo.md` in an arbitrary directory. This matters because the picker now lets a caller name a root explicitly.
6. **`.switchboard/` must not be scaffolded speculatively.** Selecting a workspace only changes the label until the user types; `memoLoad` on a root with no memo file must return empty, not create the directory.
7. **Clear / Copy Prompt / Send to Planner** all take `workspaceRoot` (`memo.js:179`, `:197`, `:210`; `implementation.html:2699`, `:2707`, `:2713`). All four must read the override, or Clear wipes the wrong memo.
8. **Theme/host parity.** `memo.html` is served both as a browser panel and (via the same file) inside the editor; the new row must use existing classes (`.section-label`, `.workspace-filter-select` equivalent) so it inherits both themes. `implementation.html` has its own compact sidebar styling — match the neighbouring `.startup-row` / sub-tab idiom rather than inventing a control.
9. **WS surface.** Memo messages are tagged `SURFACES.memo` (`wsHub.ts:49`). Any new push (e.g. a workspace-items update) must be tagged for the memo surface or the browser panel never receives it.
10. **No confirmation dialogs.** Switching workspace with unsaved text flushes and switches; it does not ask.

## Dependencies

- `protocol-catalog.json` (defines service verb catalog)
- `src/generated/verbAllowlist.ts` (generated allowlist via `npm run catalog:generate`)
- `src/services/PlanningPanelProvider.ts` (memo verb delegation)
- `src/services/TaskViewerProvider.ts` (memo verb handlers)
- `src/services/verbSchemas.ts` (verb payload schemas)
- `src/webview/memo.html` and `src/webview/memo.js` (standalone memo webview)
- `src/webview/implementation.html` (sidebar memo sub-tab)

## Adversarial Synthesis

### Grumpy Architect Critique

> "Ah, fantastic! Another 'simple dropdown' feature where you write a debounced save directly across a workspace boundary! Let me guess: the user types 'Critical Production Hotfix Steps', decides 'Oh wait, let me check workspace B', flips the dropdown, and your 800ms debounce timer happily fires `memoSave` against workspace B — clobbering B's memo with A's uncommitted hotfix text. Outstanding!
>
> And what happens when the incoming `memoContent` message arrives from workspace B? Your local `_memoDirty` flag is still `true` because the user was typing 100ms ago. So your content handler politely drops the incoming message from B to 'prevent clobbering typing'! Now the UI displays A's text while pretending it loaded B, and the user's next keystroke overwrites B's file forever.
>
> Oh, and let's not forget the PlanningPanelProvider gate! You added `memoListWorkspaces` to `TaskViewerProvider.ts` and `protocol-catalog.json`, but forgot `PlanningPanelProvider.ts:114` where `handleServiceVerb` delegates memo verbs! So the webview sends `memoListWorkspaces` to `PlanningPanelProvider`, which rejects it with an unknown verb error because it's not in the delegation guard!
>
> Fix the race conditions, flush synchronously before retargeting, clear the dirty flag, and route the verb delegation properly before you touch a single line of UI code!"

### Architectural Synthesis

The Grumpy Architect correctly identifies three critical state and delegation hazards:
1. **Debounced Save Cross-Contamination:** A pending save timer MUST be cancelled and flushed against the *old* `_wsRoot` BEFORE updating `_wsRoot` to the new target.
2. **Dirty Guard Lockout:** `_memoDirty` must be explicitly reset to `false` prior to issuing `memoLoad` for the new workspace root, so the incoming content for the new workspace is not ignored by the webview message handler.
3. **Delegation Guard Gap:** `PlanningPanelProvider.ts:114` explicitly checks memo verbs before delegating to `TaskViewerProvider`. `memoListWorkspaces` MUST be added to this check alongside `memoLoad`, `memoSave`, `memoClear`, and `memoGeneratePrompt`.

## Proposed Changes

### `protocol-catalog.json` + regenerate

Add a `memoListWorkspaces` verb to the TaskViewer provider's verb list in `protocol-catalog.json`, then run `npm run catalog:generate` to regenerate `src/generated/verbAllowlist.ts` (never hand-edit the generated file). 

Route it alongside the other memo verbs in `PlanningPanelProvider.handleServiceVerb` (`src/services/PlanningPanelProvider.ts:114`):

```ts
if (verb === 'memoLoad' || verb === 'memoSave' || verb === 'memoClear'
    || verb === 'memoGeneratePrompt' || verb === 'memoListWorkspaces') {
```

### `src/services/TaskViewerProvider.ts`

Add the handler beside `memoLoad` (~line 12515):

```ts
case 'memoListWorkspaces': {
    // The memo surfaces let the user retarget the memo file independently of the
    // board. They need the root list to do that, and it must come from the
    // server's own known roots — a caller-supplied path is never echoed back,
    // so the picker cannot be used to point memo writes at an arbitrary folder.
    const items = buildWorkspaceItems(this._getWorkspaceRoots());
    this.postMessage({
        type: 'memoWorkspaceItems',
        items,
        activeWorkspaceRoot: this._resolveWorkspaceRoot(undefined),
    });
    return { success: true, items };
}
```

Add a matching schema entry in `src/services/verbSchemas.ts` (no required fields).

### `src/webview/memo.html`

Replace the header (`memo.html:185-188`) with a labelled, selectable row:

```html
<div class="memo-header">
    <span class="section-label">Memo</span>
    <!-- Was a bare basename in .memo-hint, i.e. styled identically to the two
         paragraphs of instructional copy below — it read as decoration, not state.
         Label + control makes the target explicit and changeable. The selection is
         LOCAL to the memo: it is passed as the workspaceRoot argument to the memo
         verbs and never posts a board message. -->
    <label class="memo-workspace-row" for="memo-workspace-select">
        <span class="memo-workspace-label">Saving to</span>
        <select id="memo-workspace-select" class="memo-workspace-select"
                title="Which workspace this memo is saved to. Does not change the board."></select>
    </label>
</div>
```

Add CSS for `.memo-workspace-row` / `.memo-workspace-label` / `.memo-workspace-select` that reuses the file's existing token variables so both themes are covered. Keep `#memo-workspace` as a fallback text node only if the select fails to populate.

### `src/webview/memo.js`

```js
// Target root for the memo verbs. Starts at the host-provided (Kanban) workspace
// and is overridden ONLY by the picker. Deliberately not persisted: opening the
// memo should default to the board's workspace every time.
let _wsRoot = WS_ROOT;
let _wsRootExplicit = false;

function switchMemoWorkspace(nextRoot) {
    if (!nextRoot || nextRoot === _wsRoot) { return; }
    // Flush against the OLD root before switching. A pending debounced save
    // would otherwise write this workspace's text into the next one.
    if (_memoSaveTimer) {
        clearTimeout(_memoSaveTimer);
        _memoSaveTimer = null;
        const content = document.getElementById('memo-textarea')?.value || '';
        vscode.postMessage({ type: 'memoSave', content, workspaceRoot: _wsRoot });
    }
    _memoDirty = false;              // else memoContent's dirty-guard drops the load
    _submittedContent = null;
    _wsRoot = nextRoot;
    _wsRootExplicit = true;
    const ta = document.getElementById('memo-textarea');
    if (ta) { ta.value = ''; }
    vscode.postMessage({ type: 'memoLoad', workspaceRoot: _wsRoot });
}
```

- Populate the select from a new `memoWorkspaceItems` message arm; preserve the current selection when the root is still listed, otherwise fall back to `activeWorkspaceRoot`.
- Request the list once at boot: `vscode.postMessage({ type: 'memoListWorkspaces' })`.
- In the existing `workspaceChanged` arm (line 56), **respect an explicit override**:

```js
case 'workspaceChanged': {
    // A board workspace switch must not undo an explicit memo target.
    if (_wsRootExplicit) { break; }
    if (msg.workspaceRoot && msg.workspaceRoot !== _wsRoot) { …existing reset+load… }
    break;
}
```

- Wire the select's `change` to `switchMemoWorkspace(e.target.value)`.

### `src/webview/implementation.html`

**1. Markup** — add a workspace row at the top of the Memo sub-tab (before the instructional copy at line 1586):

```html
<label class="startup-row" style="display:block; margin-bottom:6px;">
    <span style="display:block; margin-bottom:4px; font-size:11px; color:var(--text-secondary);">
        Saving to workspace
    </span>
    <!-- Local to the memo: feeds the workspaceRoot argument of the memo verbs
         only. It must never post selectWorkspace — that would reload the board. -->
    <select id="memo-workspace-select" style="width:100%; font-size:11px;"></select>
</label>
```

**2. State** — a memo-specific root that defaults to the sidebar's:

```js
// Separate from currentWorkspaceRoot, which drives the rest of the sidebar.
let memoWorkspaceRoot = '';
let memoWorkspaceExplicit = false;
function getMemoWorkspaceRoot() { return memoWorkspaceRoot || currentWorkspaceRoot; }
```

**3. Route all five memo calls** through `getMemoWorkspaceRoot()` instead of `currentWorkspaceRoot` (`:2637`, `:2687`, `:2699`, `:2707`, `:2713`).

**4. Switch handler** — same flush-then-switch shape as `memo.js`, clearing `memoDirty` before the load.

**5. Populate** on `memoWorkspaceItems`, and request the list when the Memo sub-tab is first shown (`switchAgentTab('memo')`, `:2636-2638`) so the sidebar does not pay for it on every open.

**6. `workspaceChanged`** (`:2318-2321`) — update `currentWorkspaceRoot` as today, and reset the memo target **only** when `memoWorkspaceExplicit` is false.

## Verification Plan

*(Note: Per task constraints, automated test suite execution and project compilation steps are skipped).*

1. **UAT — indicator, browser panel.** Open `/#memo` in a multi-root workspace: the header reads `Saving to  <workspace>` with the Kanban board's workspace preselected.
2. **UAT — indicator, sidebar.** Open the Switchboard sidebar → Memo sub-tab: the workspace row is present and preselected to the sidebar's workspace.
3. **UAT — override targets the right file.** Pick workspace B in the memo picker, type `hello-B`, wait for autosave, and confirm `B/.switchboard/memo.md` contains it and `A/.switchboard/memo.md` does not.
4. **UAT — no board side effect.** With the board showing workspace A, switch the memo picker to B. The board's cards, its workspace/project dropdown, and its project filter must all be unchanged.
5. **UAT — pending-save flush.** Type into workspace A's memo and, within the autosave debounce window, switch the picker to B. `A/.switchboard/memo.md` must contain the typed text; B's memo must not.
6. **UAT — content loads after switch.** With different text already in A and B, switch between them repeatedly: the textarea shows the correct file's content each time (i.e. the dirty-guard does not swallow the load).
7. **UAT — Clear / Copy Prompt / Send to Planner** each act on the selected memo workspace, not the board's.
8. **UAT — board switch does not stomp the override.** Set the memo picker to B, then switch the *board* to workspace C. The memo picker stays on B. Then reload the memo panel: it defaults back to the board's workspace (no persistence).
9. **UAT — root list changes.** Remove workspace B from the VS Code workspace while the memo panel is open: the picker drops it and falls back to a valid root; no memo write targets the removed path.
10. **UAT — single root.** In a single-root workspace, the picker shows the one entry and the memo works normally.
11. **UAT — no scaffolding.** Select a workspace that has no `.switchboard/` directory and do not type: confirm no directory or memo file is created until the first save.

Send to Coder

## Completion Summary

Implemented the memo workspace indicator and independent workspace picker across both memo surfaces. Added a `memoListWorkspaces` verb to `TaskViewerProvider`, routed it through `PlanningPanelProvider`, and added its schema; regenerated the protocol catalog and verb allowlist. Updated `memo.html`/`memo.js` and `implementation.html` to show a labelled `Saving to` picker, debounced-save flushing on switch, explicit-override state that survives board workspace changes, and correct routing of all memo verbs through the selected workspace. `npm run catalog:generate`, `npm run parity:check`, and `npm run catalog:check` all pass.
