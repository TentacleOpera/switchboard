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

- **Tags:** `frontend`, `ui`, `ux`, `refactor`, `feature`
- **Complexity:** 7/10
- **Primary files:** `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, `src/services/RemoteControlService.ts` (base-board preservation fix), `src/services/KanbanDatabase.ts` (read-only — no change)

> Tags restricted to the allowed list per workflow. Previous ad-hoc tags (`kanban`, `remote-control`, `linear`, `webview`, `autosave`, `theming`) were not in the allowed set and have been replaced with the closest valid equivalents.

## User Review Required

Yes — this plan now includes a **backend behavior change** to `RemoteControlService` (preserving the empty-string base board in `getConfig`/`setConfig`) that the original plan incorrectly claimed was unnecessary. The user should confirm that preserving `''` in `RemoteConfig.boards` is acceptable before implementation, since it alters what gets persisted under the shipped `remote.config` key (additive only — never drops data previously stored).

## Complexity Audit

### Routine
- Replacing the bare `<select multiple>` with a themed checkbox list (pure DOM/CSS, reuses `--panel-bg2`, `--border-color`, `--text-primary`, `--font-mono`, `--accent-teal` already defined at `kanban.html:16-50`).
- Converting the ping-mode `<select>` to a radio group.
- Theming the number input and silent-sync checkbox with existing variables.
- Removing the `SAVE REMOTE SETTINGS` button (`kanban.html:2585`) and its click handler (`kanban.html:6914`).
- Adding the workspace `<select>` markup and the new CSS classes (`.remote-checkbox-list`, `.remote-checkbox-row`, `.remote-radio-row`, `.remote-number-input`) near `.column-select` (`kanban.html:775`).

### Complex / Risky
- **Base-board `''` does NOT round-trip today (CRITICAL — original plan was wrong).** `RemoteControlService.getConfig` (`RemoteControlService.ts:86`) AND `setConfig` (`RemoteControlService.ts:100`) both call `.filter(Boolean)` on `boards`, which **drops the empty string**. The original plan's Edge-Case audit only inspected the webview save path (`kanban.html:6916`, which has no filter) and concluded `''` survives — it does not. Without fixing both backend methods, the "No Project" checkbox will never persist and `boardSet.has(p.project || '')` (`RemoteControlService.ts:186`) will never match base-board cards. This is a real backend behavior change, not "verify only."
- **Autosave response wipes the board list (CRITICAL — original plan missed this).** `setRemoteConfig` (`KanbanProvider.ts:5008`) replies with `{ type: 'remoteConfig', config, active }` only — **no `projects`, `boardKeys`, or `workspaces`**. The webview handler at `kanban.html:6436` calls `renderRemoteConfig(msg.config, msg.projects)`. With the plan's new signature `renderRemoteConfig(config, payload)`, `payload.boardKeys` is undefined on every autosave round-trip, so the legacy fallback `['', ...((payload.projects) || [])]` reduces the checkbox list to **only "No Project"** — every project checkbox vanishes immediately after the first autosave. Must be fixed in the provider response or the webview render guard.
- **Workspace-enumeration helper name was wrong.** The plan proposed `_getAllWorkspaceRoots()` / `_workspaceLabel()`, which **do not exist**. The correct existing helper is `_getWorkspaceItems()` (`KanbanProvider.ts:786`), which already returns `Array<{ label, workspaceRoot }>` honoring multi-root/mapped workspaces. The provider change must use it.
- **Multi-workspace `boards` collision.** `RemoteConfig.boards` is a flat `string[]` of names; two workspaces each with a project named "Backend" are indistinguishable. Mitigated by per-workspace config (each workspace has its own `RemoteControlService` instance via `_getRemoteControl(workspaceRoot)` and its own `remote.config` DB row), so the dropdown switches the *entire* config context rather than merging. This is the existing architecture and is preserved.

## Uncertain Assumptions

The following were assumptions in the original plan that I have now **verified against the source** and resolved; no web research is needed:
- ~~`_getAllWorkspaceRoots()` / `_workspaceLabel()` exist~~ → verified absent; `_getWorkspaceItems()` is the correct helper.
- ~~`''` round-trips through the save path~~ → verified FALSE; both `getConfig` and `setConfig` filter it out (now a required backend fix).
- ~~`setRemoteConfig` response carries the board list~~ → verified FALSE; it does not (now a required provider/webview fix).

No remaining uncertain assumptions require external web research.

## Edge-Case & Dependency Audit

- **Migration / shipped state.** `RemoteConfig` (`boards`, `silentSync`, `pingMode`, `pingFrequencySeconds`) is persisted under the DB `config` key `remote.config` (`RemoteControlService.ts:41`) and **has shipped**. Per the repo migration rule, the persisted shape (`RemoteConfig` interface) is unchanged — `boards` stays a flat `string[]`. The only persistence-layer behavior change is that `''` is no longer stripped by `.filter(Boolean)`; this is **additive** (it can only cause `''` to be *retained*, never to drop data that was previously stored), so it is migration-safe. Existing installs that never selected the base board are unaffected; installs that tried to select it (and silently failed) will now have it work as intended.
- **Same-named boards across workspaces.** Because `boards` is a flat name list, selecting "Backend" in workspace A and an unrelated "Backend" in workspace B is indistinguishable. **Decision:** the Remote tab is scoped to a **single active workspace** (the existing behavior). The new workspace dropdown selects *which* workspace's boards you are configuring, but `RemoteControlService` is per-workspace already (`this._getRemoteControl(workspaceRoot)`), so each workspace has its **own** `remote.config`. Switching the dropdown re-fetches that workspace's config. This sidesteps the collision entirely and matches how RemoteControl is instantiated per-root.
- **Empty workspace / no projects.** A workspace with zero project boards must still show the "No Project" (base board) checkbox. Render it unconditionally at the top of the checkbox list.
- **`''` round-trip (CORRECTED).** The original plan claimed the webview save path had no truthiness filter and therefore `''` survived. That is true for the webview (`Array.from(selectedOptions).map(o=>o.value)`, `kanban.html:6916`) — but **false for the backend**: both `RemoteControlService.getConfig` (`:86`) and `setConfig` (`:100`) call `.filter(Boolean)`, which drops `''` on both read and write. The fix (see Proposed Changes §2) replaces `.filter(Boolean)` with an explicit "strip only non-string / null, keep `''`" normalization in both methods. After the fix, `''` survives the full round trip.
- **Autosave echo must not wipe the board list (CORRECTED).** `setRemoteConfig` (`KanbanProvider.ts:5008`) replies with `{ type: 'remoteConfig', config, active }` only. The webview handler (`kanban.html:6436`) re-renders on every `remoteConfig` message. If `renderRemoteConfig` rebuilds the checkbox list from `payload.boardKeys` and that field is absent on the autosave echo, the list collapses to the legacy fallback (`['']`). Fix: either (a) have `setRemoteConfig` re-include `boardKeys` + `workspaces` in its response (preferred — symmetric with `getRemoteConfig`), or (b) guard the webview handler so a missing `boardKeys` skips the list rebuild and only updates scalar fields. The plan adopts (a) for symmetry and to keep the webview logic simple.
- **No `confirm()` anywhere.** Per `CLAUDE.md`, do not add any confirmation dialog. Autosave is silent.
- **VSIX bundling.** `kanban.html` is bundled into `dist/extension.js` by webpack; no new runtime imports are introduced (pure DOM + existing message passing), so no bundling risk.
- **Theme classes already exist.** `.workspace-project-select` (`kanban.html:332`), `.column-select` (`kanban.html:775`), `.startup-row input[type="text"]` (`kanban.html:1131`) and the `:root` variables (`kanban.html:16-50`) are all available to reuse.
- **`getRemoteConfig` is also fired on tab open** (`kanban.html:3889`). The new payload must be handled by `renderRemoteConfig` without throwing if `workspaces` is absent (defensive fallback to the legacy `projects` array).
- **Autosave debounce.** The Agents-tab autosave (`kanban.html:3629-3639`) fires synchronously on every `change`. The number-input `input` event fires on every keystroke. To avoid hammering `setRemoteConfig` (which writes the DB `config` row and may restart the ping timer via `setConfig` at `RemoteControlService.ts:107-112`), debounce the `input` handler for the frequency field (e.g. 400ms) while keeping `change` events (checkboxes/radios/select) immediate. The `change`-based controls are low-frequency and safe to fire immediately.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — no change

`getProjects` (`KanbanDatabase.ts:2197`) already returns `string[]` of project names. We do **not** modify it. The provider will prepend the base board (`''`). No DB change required.

> Listed for completeness so a future reader knows the base board is the empty-string project, not a DB row.

### 2. `src/services/RemoteControlService.ts` — preserve the empty-string base board (REQUIRED backend fix)

This is the fix the original plan incorrectly marked "no change." Both `getConfig` (`:86`) and `setConfig` (`:100`) currently do:

```typescript
boards: Array.isArray(parsed.boards) ? parsed.boards.map((b: unknown) => String(b)).filter(Boolean) : [],
```

`.filter(Boolean)` drops `''`, so the base board can never be persisted or read back. Replace the normalization in **both** methods with one that keeps `''` but still rejects `null`/`undefined`/non-strings. Add a small private helper and use it in both places:

```typescript
private _normalizeBoards(input: unknown): string[] {
    if (!Array.isArray(input)) { return []; }
    return input
        .map((b: unknown) => (typeof b === 'string' ? b : String(b ?? '')))
        .filter((b: string) => b !== '' ? true : true); // keep '' explicitly; reject only non-string junk above
    // Simpler equivalent that keeps '': .filter((b): b is string => typeof b === 'string')
}
```

In practice the cleanest replacement is:

```typescript
boards: Array.isArray(parsed.boards)
    ? parsed.boards.filter((b): b is string => typeof b === 'string')
    : [],
```

…and the same in `setConfig` for `config.boards`. This keeps `''`, rejects `null`/`undefined`/numbers, and no longer coerces with `String()` (board names are already strings from the UI; if a non-string sneaks in it is dropped rather than stringified — safer). Apply to **both** `getConfig` (`:86`) and `setConfig` (`:100`).

**Behavior note:** `setConfig` (`:107`) starts the ping loop when `pingMode === 'constant' && boards.length > 0`. After the fix, selecting only "No Project" yields `boards: ['']` (length 1), so constant mode will correctly start. This is the intended behavior (the base board is a real board). No further change needed.

### 3. `src/services/KanbanProvider.ts` — enrich `getRemoteConfig` AND `setRemoteConfig` responses

Current `getRemoteConfig` (`KanbanProvider.ts:4989`):

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

Change to build a `boardKeys` list that **includes the base board** and to return the list of selectable workspaces via the **existing** `_getWorkspaceItems()` helper (`KanbanProvider.ts:786`), which already returns `Array<{ label, workspaceRoot }>` and honors multi-root/mapped workspaces. Keep `projects` for backward compatibility.

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

    // All selectable workspaces via the existing helper (handles multi-root + mappings).
    const workspaces = this._getWorkspaceItems().map(item => ({
        workspaceRoot: item.workspaceRoot,
        label: item.label,
        active: item.workspaceRoot === requested,
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

**`setRemoteConfig` (`KanbanProvider.ts:5001`) MUST also be updated** so its echo re-includes `boardKeys` + `workspaces` — otherwise every autosave wipes the checkbox list in the webview (see Edge-Case audit). After `rc.setConfig(...)` and re-reading `config`, rebuild the same `boardKeys`/`workspaces` and include them in the postMessage:

```typescript
case 'setRemoteConfig': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (workspaceRoot && msg.config) {
        const rc = this._getRemoteControl(workspaceRoot);
        await rc.setConfig(msg.config as RemoteConfig);
        this._remoteControlActive = rc.isActive;
        const config = await rc.getConfig();
        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = (await db.ensureReady()) ? (await db.getWorkspaceId() || '') : '';
        const projects = workspaceId ? await db.getProjects(workspaceId) : [];
        const boardKeys = ['', ...projects];
        const workspaces = this._getWorkspaceItems().map(item => ({
            workspaceRoot: item.workspaceRoot,
            label: item.label,
            active: item.workspaceRoot === workspaceRoot,
        }));
        this._panel?.webview.postMessage({
            type: 'remoteConfig',
            config,
            projects,
            boardKeys,
            workspaceRoot,
            workspaces,
            active: rc.isActive,
        });
    }
    break;
}
```

> To avoid duplicating the `boardKeys`/`workspaces` assembly, extract a private `_buildRemoteConfigPayload(workspaceRoot, config, rc)` helper and call it from both cases. This keeps the two responses symmetric and prevents future drift.

### 4. `src/webview/kanban.html` — rebuild the Remote tab markup (lines 2550–2589)

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

### 5. `src/webview/kanban.html` — rewrite `renderRemoteConfig` (lines 6891–6913)

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

Update the message handler at `kanban.html:6436` to pass the whole payload:

```javascript
case 'remoteConfig':
    if (typeof msg.active === 'boolean') { remoteControlActive = msg.active; applyRemoteControlButtonState(); }
    renderRemoteConfig(msg.config, msg);
    break;
```

> Because `setRemoteConfig` now echoes `boardKeys` + `workspaces` (Proposed Changes §3), the autosave round-trip repopulates the list correctly. The legacy fallback (`['', ...projects]`) only triggers for older extension builds or unexpected payloads.

### 6. `src/webview/kanban.html` — replace the Save button wiring with autosave (lines 6914–6926)

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
// Debounce the frequency text input so rapid keystrokes don't spam setRemoteConfig
// (each call writes the DB config row and may reschedule the ping timer).
let _remoteFreqTimer;
document.getElementById('remote-ping-frequency')?.addEventListener('input', () => {
    clearTimeout(_remoteFreqTimer);
    _remoteFreqTimer = setTimeout(remoteAutosave, 400);
});
```

Remove the `SAVE REMOTE SETTINGS` button (already removed from markup in step 4) and its handler.

## Dependencies

- None. This is a self-contained UI + backend-normalization change. No other plan or session prerequisite blocks it.

## Adversarial Synthesis

Key risks: (1) the base-board `''` is silently stripped by `.filter(Boolean)` in both `getConfig`/`setConfig` — the original plan missed this and the "No Project" feature would have been dead on arrival; (2) the `setRemoteConfig` echo omits the board list, so autosave would wipe all project checkboxes after the first save; (3) the proposed workspace helpers didn't exist. Mitigations: replace `.filter(Boolean)` with a type-guarded filter that keeps `''` in both backend methods; make `setRemoteConfig` echo `boardKeys`/`workspaces` symmetric with `getRemoteConfig`; use the existing `_getWorkspaceItems()` helper. Complexity raised 6→7 due to the required backend behavior change.

## Verification Plan

> Per session directives: **skip compilation** (`npm run compile` is NOT run here — the user runs it separately) and **skip automated tests**. Verification below is manual, via an installed VSIX, performed by the user.

### Automated Tests

Skipped per session directive. The user will run the test suite separately. No new unit/integration/e2e tests are authored as part of this plan.

### Manual Verification (user-run, via installed VSIX)

1. **Theming:** Open Kanban → Remote tab. Confirm the workspace dropdown, board checkbox list, ping-mode radios, and number input all render in the dark theme (no white boxes), matching other tabs.
2. **Base board present:** With a workspace that has ≥1 project board, confirm the list shows **"No Project (base workspace board)"** first, then each project board, each with a checkbox. With a workspace that has **zero** projects, confirm "No Project" still appears alone.
3. **Multi-select + `''` round-trip (the critical backend fix):** Check several boards including "No Project." Reload the panel; confirm selections persist — **including the base board**. Verify `''` survives the round trip by inspecting the DB `config` row `remote.config` and confirming `boards` contains `""`. (This would have failed before the §2 backend fix.)
4. **Autosave does not wipe the list (the critical echo fix):** Toggle a single board checkbox and watch the checkbox list immediately after the "Saved." status appears. Confirm all project checkboxes **remain visible** (the `setRemoteConfig` echo repopulates `boardKeys`). This is the regression test for the original plan's missed echo bug.
5. **Workspace switch:** Open two workspaces. Switch the workspace dropdown; confirm the checkboxes repopulate for that workspace and reflect *its own* saved config (selections are per-workspace, not shared).
6. **Radio ping mode:** Toggle Manual/Constant; reload; confirm the selection persists and `config.pingMode` is correct.
7. **Autosave (no Save button):** Confirm there is no Save button. Toggle a checkbox, the silent-sync box, and a radio — each change shows "Saved." and persists across reload with no extra click.
8. **Frequency debounce + clamp:** Type rapidly in the frequency field; confirm only one `setRemoteConfig` fires ~400ms after typing stops (observe the "Saved." text appears once, not per keystroke). Enter 10 and 999; confirm stored value clamps to 30 and 120 respectively.
9. **Constant mode + base board:** With only "No Project" checked and ping mode = Constant, confirm the ping loop starts (previously `boards.length` was 0 because `''` was filtered, so constant mode would not start). This verifies the `setConfig` (`:107`) `boards.length > 0` gate now passes for the base board.
10. **Behavioral sync:** With "No Project" checked and pinging enabled, move a base-board card and confirm `RemoteControlService` syncs it (the `boardSet.has(p.project || '')` path at `:186` now has `''` in the set).
11. **No confirm dialogs:** Confirm nothing in the new code introduces `confirm()`/`window.confirm()`/modal warnings (repo hard rule).

## Recommendation

Complexity is **7/10** (backend behavior change + multi-file coordination + two critical correctness fixes the original plan missed). **Send to Lead Coder.**
