# Browser Memo Panel Writes to the Wrong Workspace: Unfreeze Its Workspace Root and Stop Cross-Workspace Project Pins

## Goal

Make the browser cockpit's Memo panel operate on the workspace the user is actually looking at, and make the planner prompt it generates name a project that belongs to that same workspace — so a memo captured against one board can never produce plans destined for another repo.

### Problem

With the Switchboard board open on the `switchboard` workspace, the browser Memo panel captured a memo and generated a planner prompt whose plan destination was **`/Users/patrickvuleta/Documents/Gitlab/.switchboard/plans`** — a different repo — while its `PROJECT PIN` named **`Browser Switchboard`**, a project that exists only in the `switchboard` workspace's board.

That prompt is internally contradictory, and acting on it files plans for one product into another product's board. Downstream, the pinned project cannot resolve in the destination workspace, so the plans land with a non-empty `project` string and a null `project_id` — invisible on both the project view and the Unassigned view.

Evidence: `Gitlab/.switchboard/memo.md` was written at 12:04 today (and emptied by the copy-prompt clear) while `switchboard/.switchboard/memo.md` had not been touched since 20:11 the previous day. The panel was reading and writing the wrong workspace's memo file.

### Root cause

Two independent defects that compound.

**1. The panel's workspace root is frozen at API-server-start time.**

`_startLocalApiServer()` computes it once and captures it in a closure ([TaskViewerProvider.ts:1600-1606](../../src/services/TaskViewerProvider.ts#L1600-L1606)):

```ts
const workspaceRoot = this._getWorkspaceRoot();
const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
```

Every panel render then passes that stale value — `sharedGetPanelHtmlById(id, repoRoot, wsRoot, caps, getTheme())` (TaskViewerProvider.ts:1873) — which `getMemoHtml` bakes into the markup as `data-initial-workspace-root` (headlessPanelHtml.ts:333). `memo.js` reads it once at load (memo.js:3) and sends it as `workspaceRoot` on **every** memo verb; `_resolveStateWorkspaceRoot` honours an explicit valid root, so `memoLoad` / `memoSave` / `memoGeneratePrompt` all target it.

`_getWorkspaceRoot()` → `_resolveWorkspaceRoot()` (TaskViewerProvider.ts:2290-2310) prefers `kanbanProvider.getCurrentWorkspaceRoot()` and otherwise falls back to `roots[0]` — the first folder of a multi-root workspace. So in a multi-root setup the Memo panel binds to whichever root was primary when the server started and never follows the board again.

Compounding it: **`memo.html` has no workspace selector at all** (0 matches for `selectWorkspace`/`workspace-select`, against 6 in `kanban.html`). The board can be switched; the memo panel cannot, and does not even display which workspace it is writing to.

**2. The generated prompt resolves its plans directory and its project from different workspaces.**

In the `memoGeneratePrompt` arm (TaskViewerProvider.ts:12009-12026):

```ts
const workspaceRoot = this._resolveStateWorkspaceRoot(data.workspaceRoot);   // frozen root → Gitlab
const projectName = await this._kanbanProvider?.resolveAuthoringProject(workspaceRoot, data.initiatorProject);
const prompt = this._buildMemoPlannerPrompt(issues, workspaceRoot, projectName);
```

`resolveAuthoringProject` (KanbanProvider.ts:6464-6479) takes `initiatorProject` when defined; `memo.js` never sends it. It then reads `kanban.activeProjectFilter` from **that workspace's** DB — empty in the Gitlab DB (verified) — and finally falls back to `this._projectFilter`, the **in-memory singleton** on the shared `KanbanProvider`, which held the switchboard board's selection.

So `plansDir` came from the frozen root and the project came from a live cross-workspace in-memory value, with no check that the project exists in that workspace.

## Metadata

- **Complexity:** 6
- **Tags:** backend, frontend, bugfix, reliability
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Complex/Risky — the fix touches shared workspace resolution used by every panel.**

- **The frozen root is not memo-specific.** `wsRoot` is passed to *every* `getPanelHtml` call, so Project, Planning, Design and Setup all carry the same baked-in root. Unfreezing it changes what those panels bind to as well. That is the correct direction (they should follow the board), but it is a wider change than the reported symptom, so it needs verification per panel rather than only on memo.
- **`data-initial-workspace-root` is read once, at load.** Serving a fresher value fixes a newly-opened panel but not an already-open tab. A panel that stays mounted across a workspace switch — which is exactly what the shell does (`.panel-frame` iframes stay mounted; shell.html:11-13) — will keep the old root until reloaded. A complete fix needs a live update path, not just a better initial value.
- **The project guard is small but load-bearing.** Refusing to emit a pin that does not resolve in the destination workspace is a handful of lines, and it is the difference between a prompt that lands plans unassigned-but-recoverable and one that strands them.

Both parts are kept in one plan: the guard is five lines inside the same function as the root resolution, and shipping the unfreeze without it leaves the cross-workspace pin reachable through the in-memory `_projectFilter` fallback.

## Edge-Case & Dependency Audit

- **Memo content already written to the wrong workspace stays there.** `Gitlab/.switchboard/memo.md` exists (currently empty). Fixing the binding does not migrate anything; if a memo is sitting in the wrong workspace when this ships, it stays there. Do not add a migration — say so in the release note instead.
- **`_projectFilter` is a cross-workspace singleton.** `setProjectFilter` persists to `this._currentWorkspaceRoot`'s DB config (KanbanProvider.ts:6528-6545) but the in-memory field is global. Any consumer using it as a fallback for a *different* workspace is wrong by construction. Either scope the fallback to `workspaceRoot === _currentWorkspaceRoot`, or drop the fallback for authoring and rely on the DB config alone.
- **A correct pin must still be emitted.** The guard must not become "never pin". When the resolved project **does** exist in the destination workspace, the directive must still be written — the memo→planner flow depends on it.
- **`initiatorProject` is the clean channel.** `resolveAuthoringProject` already honours an explicitly supplied value. Having the panel send the project it is displaying (once it knows its workspace) is a better fix than inferring host-side, and it is how other surfaces avoid this race.
- **Standalone host has one root.** `bootstrap.ts` passes a single `workspaceRoot` and omits `themeClass` entirely (bootstrap.ts:422); the frozen-root bug cannot fire there. Any change must not assume a `KanbanProvider` with a live board selection exists.
- **Capability gating keys off `#memo-send-btn`** (transport.js:343). If the panel grows a workspace indicator or selector, do not disturb that id or the five memo element ids `memo.js` binds to.
- **`memoLoad` on workspace switch.** If the panel becomes workspace-aware, switching must re-issue `memoLoad` for the new root, and must not silently overwrite the new workspace's memo with the previous one's textarea contents — `memoSave` is debounced (memo.js:55-65) and a pending timer could fire after the switch. Cancel it on switch.
- **Multi-root mapping.** `resolveEffectiveWorkspaceRootFromMappings` collapses child roots onto a parent's `.switchboard`. The unfrozen value must go through the same mapping, or a child root will start writing its own `.switchboard/memo.md` where previously it shared the parent's.
- **Build/deploy dependency.** The running extension serves from `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/`; `memo.js` is served `no-cache` so a tab reload picks up webview JS, but the TypeScript side needs a build, a sync to that folder, and a window reload.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — resolve the workspace root per render, not once per server

In the `serveStatic` block, replace the captured constant with a getter so each panel render sees the current selection:

```ts
                // Per-render, NOT captured once: the board's workspace can change
                // after the server starts, and a panel baked with the start-time root
                // silently reads/writes a different workspace's .switchboard (the memo
                // panel wrote Gitlab's memo.md while the board showed switchboard).
                const currentWsRoot = () =>
                    resolveEffectiveWorkspaceRootFromMappings(this._getWorkspaceRoot() || effectiveRoot);
```

and use `currentWsRoot()` at every `getPanelHtml` / `getBoardHtml` / `getProjectHtml` call site in that block (TaskViewerProvider.ts:1855, 1863, 1873).

### 2. `src/webview/memo.js` + `src/webview/memo.html` — show the workspace and follow switches

Display the bound workspace so a mismatch is visible rather than silent, and handle a workspace change without losing the textarea:

```js
    // memo.js — render the workspace the panel is bound to.
    const wsLabel = document.getElementById('memo-workspace');
    if (wsLabel) { wsLabel.textContent = WS_ROOT.split('/').pop() || WS_ROOT; }

    // Follow a host-side workspace switch: cancel any pending save for the OLD
    // root before loading the new one, or the debounce can write the previous
    // workspace's text into the new workspace's memo.
    let _wsRoot = WS_ROOT;
    case 'workspaceChanged': {
        if (msg.workspaceRoot && msg.workspaceRoot !== _wsRoot) {
            if (_memoSaveTimer) { clearTimeout(_memoSaveTimer); _memoSaveTimer = null; }
            _memoDirty = false;
            _wsRoot = msg.workspaceRoot;
            if (wsLabel) { wsLabel.textContent = _wsRoot.split('/').pop() || _wsRoot; }
            const ta = document.getElementById('memo-textarea');
            if (ta) { ta.value = ''; }
            vscode.postMessage({ type: 'memoLoad', workspaceRoot: _wsRoot });
        }
        break;
    }
```

Every existing `postMessage` in `memo.js` must send `_wsRoot` rather than the load-time `WS_ROOT`. Add the label to the panel header in `memo.html`:

```html
    <div class="memo-header">
        <span class="section-label">Memo</span>
        <span id="memo-workspace" class="memo-hint" title="Workspace this memo is saved to"></span>
    </div>
```

### 3. `src/services/TaskViewerProvider.ts` — never emit a pin from another workspace

In the `memoGeneratePrompt` arm, validate the resolved project against the destination workspace before it reaches the prompt builder:

```ts
                        const rawProject = await this._kanbanProvider?.resolveAuthoringProject(workspaceRoot, data.initiatorProject);
                        // The prompt's plansDir comes from `workspaceRoot`; the project
                        // must come from the SAME workspace. resolveAuthoringProject's
                        // last resort is KanbanProvider's in-memory _projectFilter, a
                        // cross-workspace singleton — it once produced a switchboard
                        // project inside a Gitlab-destined prompt, and the plans landed
                        // with a project name that could not resolve there.
                        let projectName: string | undefined = undefined;
                        if (rawProject) {
                            const db = await this._getKanbanDb(workspaceRoot);
                            const wsId = db ? await this._wsId(db) : '';
                            const id = (db && wsId) ? await db.getProjectIdByName(wsId, rawProject) : null;
                            if (id !== null) {
                                projectName = rawProject;
                            } else {
                                console.warn(`[memo] dropping PROJECT PIN '${rawProject}': not a project in ${workspaceRoot}`);
                            }
                        }
                        const prompt = this._buildMemoPlannerPrompt(issues, workspaceRoot, projectName);
```

Omitting the directive is the correct degrade: the plan lands unassigned and recoverable, instead of stranded with an unresolvable name.

### 4. `src/services/KanbanProvider.ts` — scope the in-memory fallback

In `resolveAuthoringProject`, only fall back to the singleton when it belongs to the workspace being asked about:

```ts
        // _projectFilter is a cross-workspace singleton; using it for a DIFFERENT
        // workspace than the board is currently showing is what produced a pin from
        // the wrong board. Scope it.
        return this._currentWorkspaceRoot === workspaceRoot ? norm(this._projectFilter) : undefined;
```

### 5. `src/test/memo-panel-workspace-binding-contract.test.js` — new contract test

```js
'use strict';
/**
 * Contract: the memo panel binds to the CURRENT workspace, and a generated
 * planner prompt's plansDir and PROJECT PIN come from the SAME workspace.
 *
 * The regression this locks down: with the board on `switchboard`, the browser
 * memo panel wrote Gitlab's .switchboard/memo.md and emitted a prompt whose
 * plansDir was Gitlab while its PROJECT PIN named a switchboard-only project.
 */
const assert = require('assert');

// 1. The served panel carries the CURRENT root, not the server-start root.
provider.__setWorkspaceRoot('/tmp/ws-a');
let html = (await apiOptions.serveStatic.getPanelHtml('memo')).html;
assert.match(html, /data-initial-workspace-root="[^"]*ws-a"/);
provider.__setWorkspaceRoot('/tmp/ws-b');          // board switches workspace
html = (await apiOptions.serveStatic.getPanelHtml('memo')).html;
assert.match(html, /data-initial-workspace-root="[^"]*ws-b"/,
    'panel still serves the server-start root — frozen closure regression');

// 2. A project that does not exist in the destination workspace is NOT pinned.
kanbanProvider.__setInMemoryProjectFilter('Browser Switchboard');   // other board's selection
const res = await provider.handleServiceVerb('memoGeneratePrompt',
    { content: 'Bug: one', action: 'copy', workspaceRoot: '/tmp/ws-b' });
assert.ok(res.prompt.includes('/tmp/ws-b/.switchboard/plans'));
assert.ok(!/PROJECT PIN/.test(res.prompt),
    'emitted a PROJECT PIN for a project that does not exist in the destination workspace');

// 3. A project that DOES exist is still pinned (the guard must not become never-pin).
await dbForWsB.addProject(wsIdB, 'Real Project');
kanbanProvider.__setInMemoryProjectFilter('Real Project');
kanbanProvider.__setCurrentWorkspaceRoot('/tmp/ws-b');
const res2 = await provider.handleServiceVerb('memoGeneratePrompt',
    { content: 'Bug: one', action: 'copy', workspaceRoot: '/tmp/ws-b' });
assert.match(res2.prompt, /PROJECT PIN[\s\S]*Real Project/);

// 4. memo.js sends the live root, not the load-time constant.
const memoJs = require('fs').readFileSync('src/webview/memo.js', 'utf8');
assert.match(memoJs, /workspaceChanged/);
assert.ok(!/workspaceRoot:\s*WS_ROOT/.test(memoJs),
    'memo.js still posts the load-time WS_ROOT after a workspace switch');
```

### 6. `package.json` — register the test

```json
    "test:contract:memo-workspace-binding": "node src/test/memo-panel-workspace-binding-contract.test.js",
```

## Verification Plan

**Automated**

1. `npm run compile-tests && npm run compile`.
2. `npm run test:contract:memo-workspace-binding` — passes. Then restore the captured `const wsRoot = effectiveRoot`, rebuild, and confirm assertion 1 **fails** — that is the frozen-closure guard.
3. Re-point the in-memory filter to a foreign project and confirm assertion 2 fails if the guard in change 3 is removed.
4. `npm run test:contract:shim-injection` — green (memo.html markup changed; the shim marker must survive).
5. `npm run verb-returns:check`, `npm run push-routing:check`, `npm run catalog:check` (regenerate on line drift), `npm run lint`.

**Manual — the reported case, multi-root**

6. Build, sync to `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/`, reload the window. Open the cockpit at the port in `.switchboard/api-server-port.txt`.
7. With the board on the **switchboard** workspace, open Memo. The header shows `switchboard`. Type an entry, wait for `Saved`, then confirm `switchboard/.switchboard/memo.md` changed and `Gitlab/.switchboard/memo.md` did **not** (`stat -f "%Sm %z" -t "%H:%M" <both>`).
8. Press **Copy Prompt** and paste. The plans directory in the prompt is `…/GitHub/switchboard/.switchboard/plans`, and any `PROJECT PIN` names a project that exists on that board.
9. Switch the board to the Gitlab workspace. The Memo header follows to `Gitlab`, the textarea reloads that workspace's memo, and a `Copy Prompt` there produces a Gitlab plansDir with either a Gitlab project or **no** PROJECT PIN line.
10. Cross-workspace guard, directly: with the board on Gitlab, confirm the generated prompt never names `Browser Switchboard` (it exists only on the switchboard board). Check the output channel for the `[memo] dropping PROJECT PIN` warning.
11. Debounce safety: type in Memo and switch workspace within the 800 ms save window; confirm the first workspace's text is not written into the second workspace's `memo.md`.
12. Other panels: open Project, Planning, Design and Setup after a workspace switch and confirm each shows the newly-selected workspace's data — the unfreeze applies to all of them.

**Manual — standalone host**

13. Run the standalone bootstrap and open `/memo`: single root, header shows it, memo reads and writes that root's `.switchboard/memo.md`, and `Copy Prompt` produces a plansDir under it.
