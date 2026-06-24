# Redesign the Kanban Remote (Linear) Tab: Workspace Dropdown + Board Checkboxes, Themed UI, Radio Ping Mode, Autosave

## Goal

Make the Kanban **Remote** tab (`#remote-tab-content` in `kanban.html`) consistent with the rest of the Switchboard UI and far more usable.

### Problems (root-cause analysis)

The Remote tab was shipped as a quick "config-only" panel (the comment at `src/webview/kanban.html:2550` literally reads `Remote Tab Content (§10 — config only, Linear)`). It uses bare, unstyled native form controls and a manual Save button, which is out of step with every other panel. Concretely:

1. **Only project boards appear in "Boards to sync."** The board list is populated from `db.getProjects(workspaceId)` (`KanbanProvider`/`KanbanDatabase.getProjects` at `KanbanDatabase.ts:2197`), which queries the `projects` table only. The **base workspace board** (cards whose `project` column is the empty string `''`) is never listed, so it cannot be synced. There is also no notion of choosing *which* workspace — the tab implicitly uses the active panel workspace.
   - Confirmed by `RemoteControlService.ts:186`: the sync filter is `boardSet.has(p.project || '')`, i.e. an empty-string project key is a valid board key but is never offered in the UI.

2. **"Boards to sync" is an ugly white box.** `src/webview/kanban.html:2564` is `<select id="remote-boards" multiple size="5" style="width:100%;">` — a raw multi-select with only an inline width. Native multi-selects don't inherit the dark theme, so it renders as a white box. The user wants: a **workspace dropdown**, then **checkboxes** for that workspace's project boards, plus a **"No Project"** checkbox for the base board, with **multi-select**.

3. **All controls are unstyled "ugly white."** The `<select>`, `<input type="checkbox">`, and `<input type="number">` on this tab carry no class and no theme variables, unlike the rest of `kanban.html` which uses `--panel-bg2`, `--border-color`, `--text-primary`, `--font-mono`, etc. (`:root` at `kanban.html:16`).

4. **Ping mode is a dropdown.** `kanban.html:2574` is a 2-option `<select>` — a radio list is clearer for a binary mode choice.

5. **There is a Save button while every other panel autosaves.** `kanban.html:2585` is `SAVE REMOTE SETTINGS`, wired at `kanban.html:6914`. Other panels (Agents tab `kanban.html:3629`, MCP monitor `kanban.html:7491`) autosave on `change`/`blur`/`input` with no Save button. The Remote tab should match.

The fix: rebuild the Remote tab markup to use a themed workspace dropdown + a themed board-checkbox list (including a "No Project" entry), convert ping mode to a radio group, style every control with existing theme classes/variables, and switch to autosave — removing the Save button. Backend changes: have `getRemoteConfig` return the full workspace→boards map (including the base board) so the UI can render checkboxes per workspace.

## Metadata

- **Tags:** `kanban`, `remote-control`, `linear`, `webview`, `ui`, `autosave`, `theming`
- **Complexity:** 6/10
- **Primary files:** `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/KanbanDatabase.ts` (read-only helper add), `src/services/RemoteControlService.ts` (no behavior change — already keys on `project || ''`)

## Complexity Audit

**Complex/Risky** (not routine), for three reasons:

1. **Backend data-shape change.** `getRemoteConfig` currently returns `projects: string[]` for a single workspace. To render a workspace dropdown + per-workspace board checkboxes we need a richer payload (`workspaces: [{ workspaceRoot, label, boards: string[] }]`, where each `boards` list is prefixed with the base board). This must remain backward compatible with the existing `remoteConfig` message consumer.
2. **Config semantics for the base board.** `RemoteConfig.boards: string[]` already stores board *names*; the base board is the empty string `''`. The UI must round-trip `''` correctly (a "No Project" checkbox whose value is `''`). Must verify `''` is not dropped by any `.filter(Boolean)`-style cleanup on save.
3. **Autosave + multi-workspace selection.** Switching the workspace dropdown must not wipe selections for other workspaces — `config.boards` is a flat list of names, so two workspaces with same-named projects would collide. Scope decision below.

Everything else (radio group, theming, removing the Save button) is routine.

## Edge-Case & Dependency Audit

- **Migration / shipped state.** `RemoteConfig` (`boards`, `silentSync`, `pingMode`, `pingFrequencySeconds`) is persisted under the DB `config` key `remote.config` (`RemoteControlService.ts:41`) and **has shipped**. Per the repo migration rule, the new code MUST keep reading/writing the same shape. We are **not** changing `RemoteConfig`; `boards` stays a flat `string[]` of board names. No migration needed because the persisted shape is unchanged — only the UI rendering and the `getRemoteConfig` *response* payload change.
- **Same-named boards across workspaces.** Because `boards` is a flat name list, selecting "Backend" in workspace A and an unrelated "Backend" in workspace B is indistinguishable. **Decision:** the Remote tab is scoped to a **single active workspace** (the existing behavior). The new workspace dropdown selects *which* workspace's boards you are configuring, but `RemoteControlService` is per-workspace already (`this._getRemoteControl(workspaceRoot)`), so each workspace has its **own** `remote.config`. Switching the dropdown re-fetches that workspace's config. This sidesteps the collision entirely and matches how RemoteControl is instantiated per-root.
- **Empty workspace / no projects.** A workspace with zero project boards must still show the "No Project" (base board) checkbox. Render it unconditionally at the top of the checkbox list.
- **`''` round-trip.** `Array.from(checkboxes).filter(c=>c.checked).map(c=>c.value)` must keep `''`. Do **not** use truthiness filters anywhere in the save path. Verified current save (`kanban.html:6916`) does `Array.from(selectedOptions).map(o=>o.value)` with no filter — preserve that property.
- **No `confirm()` anywhere.** Per `CLAUDE.md`, do not add any confirmation dialog. Autosave is silent.
- **VSIX bundling.** `kanban.html` is bundled into `dist/extension.js` by webpack; no new runtime imports are introduced (pure DOM + existing message passing), so no bundling risk.
- **Theme classes already exist.** `.workspace-project-select` (`kanban.html:332`), `.column-select` (`kanban.html:775`), `.startup-row input[type="text"]` (`kanban.html:1131`) and the `:root` variables (`kanban.html:16`) are all available to reuse.
- **`getRemoteConfig` is also fired on tab open** (`kanban.html:3889`). The new payload must be handled by `renderRemoteConfig` without throwing if `workspaces` is absent (defensive fallback to the legacy `projects` array).

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — add a base-board-aware board list (optional helper)

`getProjects` already returns project names. We do **not** modify it. Instead the provider will prepend the base board. No DB change strictly required, but document that the base board key is `''`.

> No code change needed in `KanbanDatabase.ts` beyond what exists. (Listed for completeness so a future reader knows the base board is the empty-string project, not a DB row.)

### 2. `src/services/KanbanProvider.ts` — enrich the `getRemoteConfig` response

Current (`KanbanProvider.ts:4972`):

```typescript
case 'getRemoteConfig': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (workspaceRoot) {
        const rc = this._getRemoteControl(workspaceRoot);
        const config = await rc.getConfig();
        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = (await db.ensureReady()) ? (await db.getWorkspaceId() || '') : '';
        const projects = workspaceId ? await db.getProjects(workspaceId) : [];
        this._panel?.webview.postMessage({ type: 'remoteConfig', config, projects, active: rc.isActive });
    }
    break;
}
```

Change to build a `boards` list that **includes the base board** and to also return the list of selectable workspaces (so the UI can offer the dropdown). Keep `projects` for backward compatibility.

```typescript
case 'getRemoteConfig': {
    const requested = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!requested) { break; }
    const rc = this._getRemoteControl(requested);
    const config = await rc.getConfig();
    const db = this._getKanbanDb(requested);
    const workspaceId = (await db.ensureReady()) ? (await db.getWorkspaceId() || '') : '';
    const projects = workspaceId ? await db.getProjects(workspaceId) : [];

    // Board keys: the base workspace board is the empty-string project key ('').
    // Surface it explicitly so the UI can offer a "No Project" checkbox.
    const boardKeys = ['', ...projects];

    // All open workspaces, so the UI can render a workspace dropdown.
    const workspaces = this._getAllWorkspaceRoots().map(root => ({
        workspaceRoot: root,
        label: this._workspaceLabel(root),       // reuse existing label helper if present; else path.basename(root)
        active: root === requested,
    }));

    this._panel?.webview.postMessage({
        type: 'remoteConfig',
        config,
        projects,                 // legacy field, kept
        boardKeys,                // NEW: ['', ...projectNames]
        workspaceRoot: requested, // NEW: echo which workspace this config is for
        workspaces,               // NEW: dropdown options
        active: rc.isActive,
    });
    break;
}
```

> If `_getAllWorkspaceRoots()` / `_workspaceLabel()` do not exist under those exact names, use the existing workspace-enumeration the panel already uses to populate other workspace dropdowns (the same source the Kanban board filter uses). Confirm the helper name during implementation; fall back to `path.basename(root)` for the label.

`setRemoteConfig` (`KanbanProvider.ts:4984`) needs **no change** — it already persists the full `msg.config` per workspace. (When the UI switches workspace it will send `workspaceRoot` with the message; ensure `setRemoteConfig` resolves `msg.workspaceRoot` the same way — it already does via `_resolveWorkspaceRoot(msg.workspaceRoot)`.)

### 3. `src/webview/kanban.html` — rebuild the Remote tab markup (lines 2550–2589)

Replace the body of `#remote-tab-content` with themed controls. Add a workspace dropdown, a board-checkbox container, a radio group for ping mode, and **remove** the Save button.

```html
<!-- Remote Tab Content (§10 — config only, Linear) -->
<div id="remote-tab-content" class="shared-tab-content">
    <div style="padding:12px; overflow-y:auto; height:100%; max-width:640px;">
        <div class="db-subsection">
            <div class="subsection-header"><span>Remote Control (Linear)</span></div>
            <div style="font-size:11px; color:var(--text-secondary); line-height:1.5; margin-bottom:12px;">
                Drive your boards from the Linear app on your phone. Moving a card between Linear
                states moves it here and dispatches that column's agent; comments are routed to the
                current column's agent, which replies back as a Linear comment. Polling only — no
                webhooks, nothing to expose.
            </div>

            <!-- Workspace selector -->
            <label style="display:block; margin-bottom:10px;">
                <span style="display:block; margin-bottom:4px; font-size:11px; color:var(--text-secondary);">Workspace</span>
                <select id="remote-workspace" class="workspace-project-select"></select>
            </label>

            <!-- Boards to sync: themed checkbox list, includes "No Project" base board -->
            <div style="margin-bottom:10px;">
                <span style="display:block; margin-bottom:4px; font-size:11px; color:var(--text-secondary);">Boards to sync</span>
                <div id="remote-boards-list" class="remote-checkbox-list"></div>
            </div>

            <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                <input type="checkbox" id="remote-silent-sync">
                <span>Silent syncing — keep selected boards mirrored with Linear even while pinging is off</span>
            </label>

            <!-- Ping mode: radio group -->
            <div style="margin-bottom:10px;">
                <span style="display:block; margin-bottom:4px; font-size:11px; color:var(--text-secondary);">Ping mode</span>
                <label class="remote-radio-row">
                    <input type="radio" name="remote-ping-mode" value="manual" checked>
                    <span>Manual — ping only while the toolbar toggle is on</span>
                </label>
                <label class="remote-radio-row">
                    <input type="radio" name="remote-ping-mode" value="constant">
                    <span>Constant — always pinging when configured</span>
                </label>
            </div>

            <label style="display:block; margin-bottom:12px;">
                <span style="display:block; margin-bottom:4px; font-size:11px; color:var(--text-secondary);">Ping frequency (seconds, 30–120)</span>
                <input type="number" id="remote-ping-frequency" class="remote-number-input" min="30" max="120" step="5" value="60">
            </label>

            <span id="remote-config-status" style="font-size:10px; color:var(--text-secondary);"></span>
        </div>
    </div>
</div>
```

Add CSS near the other component styles (e.g. after `.column-select` at `kanban.html:792`), reusing the existing variable palette:

```css
.remote-checkbox-list {
    border: 1px solid var(--border-color);
    border-radius: 3px;
    background: var(--panel-bg2);
    padding: 6px 8px;
    max-height: 160px;
    overflow-y: auto;
}
.remote-checkbox-row,
.remote-radio-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    padding: 3px 0;
}
.remote-checkbox-row input,
.remote-radio-row input { accent-color: var(--accent-teal); }
.remote-number-input {
    background: var(--panel-bg2);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 6px;
    width: 120px;
}
.remote-number-input:focus { outline: none; border-color: var(--accent-teal-dim); }
```

### 4. `src/webview/kanban.html` — rewrite `renderRemoteConfig` (lines 6891–6913)

Render the workspace dropdown and the board checkbox list (with "No Project" first). Defensive fallback to the legacy `projects` array.

```javascript
let _remoteWorkspaces = [];
function renderRemoteConfig(config, payload) {
    payload = payload || {};
    // Workspace dropdown
    const wsSel = document.getElementById('remote-workspace');
    if (wsSel && Array.isArray(payload.workspaces)) {
        _remoteWorkspaces = payload.workspaces;
        wsSel.innerHTML = '';
        payload.workspaces.forEach(w => {
            const opt = document.createElement('option');
            opt.value = w.workspaceRoot;
            opt.textContent = w.label;
            if (w.active) opt.selected = true;
            wsSel.appendChild(opt);
        });
    }

    // Board checkboxes (base board '' rendered as "No Project")
    const list = document.getElementById('remote-boards-list');
    const boardKeys = Array.isArray(payload.boardKeys)
        ? payload.boardKeys
        : ['', ...((payload.projects) || [])];   // legacy fallback
    if (list) {
        const chosen = new Set((config && config.boards) || []);
        list.innerHTML = '';
        boardKeys.forEach(key => {
            const row = document.createElement('label');
            row.className = 'remote-checkbox-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = key;                       // '' for the base board
            cb.checked = chosen.has(key);
            cb.dataset.role = 'remote-board';
            const span = document.createElement('span');
            span.textContent = key === '' ? 'No Project (base workspace board)' : key;
            row.appendChild(cb);
            row.appendChild(span);
            list.appendChild(row);
        });
    }

    if (config) {
        const silent = document.getElementById('remote-silent-sync');
        if (silent) silent.checked = config.silentSync === true;
        const mode = config.pingMode === 'constant' ? 'constant' : 'manual';
        const radio = document.querySelector(`input[name="remote-ping-mode"][value="${mode}"]`);
        if (radio) radio.checked = true;
        const freq = document.getElementById('remote-ping-frequency');
        if (freq) freq.value = config.pingFrequencySeconds || 60;
    }
}
```

Update the message handler that calls `renderRemoteConfig` to pass the whole payload (search for where `type === 'remoteConfig'` is handled and pass `msg` as the second arg, e.g. `renderRemoteConfig(msg.config, msg)`).

### 5. `src/webview/kanban.html` — replace the Save button wiring with autosave (lines 6914–6926)

Delete the `btn-save-remote-config` click handler entirely and add autosave on every control + a workspace-switch re-fetch. Mirror the Agents-tab autosave style (`kanban.html:3629`).

```javascript
function remoteCollectConfig() {
    const boards = Array.from(
        document.querySelectorAll('#remote-boards-list input[data-role="remote-board"]:checked')
    ).map(cb => cb.value);   // keeps '' — do NOT filter by truthiness
    const modeEl = document.querySelector('input[name="remote-ping-mode"]:checked');
    return {
        boards,
        silentSync: document.getElementById('remote-silent-sync')?.checked === true,
        pingMode: modeEl && modeEl.value === 'constant' ? 'constant' : 'manual',
        pingFrequencySeconds: Math.min(120, Math.max(30,
            parseInt(document.getElementById('remote-ping-frequency')?.value, 10) || 60)),
    };
}

function remoteAutosave() {
    const wsSel = document.getElementById('remote-workspace');
    const workspaceRoot = wsSel ? wsSel.value : undefined;
    const config = remoteCollectConfig();
    const statusEl = document.getElementById('remote-config-status');
    if (statusEl) statusEl.textContent = 'Saved.';
    postKanbanMessage({ type: 'setRemoteConfig', config, workspaceRoot });
}

// Autosave on any control change (delegated, so it covers dynamically-added checkboxes)
document.getElementById('remote-tab-content')?.addEventListener('change', (e) => {
    if (e.target.id === 'remote-workspace') {
        // Switching workspace: load THAT workspace's own config (no save).
        postKanbanMessage({ type: 'getRemoteConfig', workspaceRoot: e.target.value });
        return;
    }
    remoteAutosave();
});
document.getElementById('remote-ping-frequency')?.addEventListener('input', remoteAutosave);
```

Remove the `SAVE REMOTE SETTINGS` button (already removed from markup in step 3) and its handler.

### 6. `src/services/RemoteControlService.ts` — no change

`boards` already keys on `project || ''` (`RemoteControlService.ts:186`), so a stored `''` board key correctly matches base-workspace cards. Verify only; no edit.

## Verification Plan

1. **Build:** `npm run compile` succeeds (webpack bundles `kanban.html`); produce a VSIX and install it (per repo rule, testing is via installed VSIX, not `dist/`).
2. **Theming:** Open Kanban → Remote tab. Confirm the workspace dropdown, board checkbox list, ping-mode radios, and number input all render in the dark theme (no white boxes), matching other tabs.
3. **Base board present:** With a workspace that has ≥1 project board, confirm the list shows **"No Project (base workspace board)"** first, then each project board, each with a checkbox. With a workspace that has **zero** projects, confirm "No Project" still appears alone.
4. **Multi-select:** Check several boards including "No Project." Reload the panel; confirm selections persist (including the base board — verify `''` survives the round trip by checking the DB `config` row `remote.config` contains `""` in `boards`).
5. **Workspace switch:** Open two workspaces. Switch the workspace dropdown; confirm the checkboxes repopulate for that workspace and reflect *its own* saved config (selections are per-workspace, not shared).
6. **Radio ping mode:** Toggle Manual/Constant; reload; confirm the selection persists and `config.pingMode` is correct.
7. **Autosave (no Save button):** Confirm there is no Save button. Toggle a checkbox, the silent-sync box, a radio, and edit the frequency — each change shows "Saved." and persists across reload with no extra click.
8. **Frequency clamp:** Enter 10 and 999; confirm stored value clamps to 30 and 120 respectively.
9. **Behavioral sync:** With "No Project" checked and pinging enabled, move a base-board card and confirm `RemoteControlService` still syncs it (the `boardSet.has(p.project || '')` path now has `''` in the set).
10. **No confirm dialogs:** Confirm nothing in the new code introduces `confirm()`/`window.confirm()`/modal warnings (repo hard rule).
