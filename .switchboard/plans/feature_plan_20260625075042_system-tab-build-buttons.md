# Add Build Buttons to the Project "System" Tab (Mirror the Constitution Tab) Instead of the "Click Edit" Empty-State Hint

## Goal

In `project.html`'s **System** tab, replace the awkward empty-state instruction with real **Build** buttons that generate the missing governance file — exactly the way the **Constitution** tab already offers "Build via Planner" / "Copy Build Prompt."

### Problem (root-cause analysis)

The System tab manages the workspace's `CLAUDE.md` (gov key `claude`) and `AGENTS.md` (gov key `agents`) files (`_systemSelectedGovKey` at `project.js:181`; basenames in `constitutionUtils.ts:15` — `GOVERNANCE_BASENAMES` maps `claude`→`CLAUDE.md`, `agents`→`AGENTS.md`). When the selected file does **not** exist, the tab shows this empty state (`project.js:627`):

```javascript
const filename = _systemSelectedGovKey === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
systemPreviewContent.innerHTML = `
    <div class="constitution-onboarding">
        <p class="constitution-onboarding-title">No ${filename} found for this workspace.</p>
        <p>You can create one by clicking <strong>Edit</strong> or writing it from the terminal/editor.</p>
    </div>
`;
```

This is weird and inconsistent:

- It tells the user to "click Edit or write it from the terminal/editor" — there is no affordance to *generate* the file, even though the **Constitution** tab right next to it has dedicated **Build via Planner** and **Copy Build Prompt** buttons (`project.html:1359–1360`) that do exactly that via the provider (`invokeConstitutionBuilder` / `copyConstitutionPrompt`, `PlanningPanelProvider.ts:3203` and `:3120`).
- The System tab's control strip (`project.html:1391–1399`) has only **Edit / Save / Cancel / Delete** — no build affordance.

The fix: add **Build via Planner** and **Copy Build Prompt** buttons to the System tab control strip, shown when the file is missing (and hidden when it exists), mirroring the Constitution tab's button-visibility logic. The build action invokes an agent in a terminal to generate the correct file (`CLAUDE.md` or `AGENTS.md`); the copy action puts a ready-to-run generation prompt on the clipboard **and flashes a "Copied!" confirmation on the button** (parity with the Constitution tab). Update the empty-state copy to point at the new buttons.

## Metadata

- **Tags:** `ui`, `ux`, `feature`
- **Complexity:** 4/10
- **Primary files:** `src/webview/project.html`, `src/webview/project.js`, `src/services/PlanningPanelProvider.ts`

## User Review Required

Yes — before implementation, confirm:
- The inline natural-language generation prompt wording for `CLAUDE.md` vs `AGENTS.md` (see Proposed Changes §4) is acceptable. There is no equivalent skill file for these (unlike Constitution, which points at `.agents/skills/constitution_builder.md`), so the prompt is authored inline.
- Accepted parity-risk: `invokeSystemBuilder` does **not** guard against the file already existing (same gap as `invokeConstitutionBuilder`). The UI only shows the button when the file is missing, but the backend does not re-check. This matches the shipped Constitution behavior.

## Complexity Audit

### Routine
- Adding two `<button>` elements to the System control strip in `project.html`, mirroring the Constitution strip (`project.html:1359–1360`).
- Grabbing the new elements via `getElementById` next to the existing System lookups (`project.js:249–252`).
- Wiring two click handlers that post messages with `workspaceRoot` + `governanceFile`, next to the existing System handlers (`project.js:1764`).
- Toggling `style.display` / `disabled` in the exists/missing branches of `constitutionFileRead` (`project.js:620–638`), copying the Constitution branch pattern (`project.js:573–608`).
- Adding two provider cases (`invokeSystemBuilder`, `copySystemBuildPrompt`) next to the Constitution builder cases (`PlanningPanelProvider.ts:3203–3228`), reusing `sendRobustText` and the `allRoots` validation.

### Complex / Risky
- **Copy-toast feedback wiring.** The existing `constitutionPromptCopied` handler (`project.js:491–503`) is hard-coded to flash the *Constitution* buttons (`btnCopyBuildPrompt`/`btnCopyUpdatePrompt`) and never touches the System button. Reusing that message would leave the System "Copy Build Prompt" button with **no visual feedback**. A dedicated `systemPromptCopied` message + handler (or extending the existing handler to branch on `msg.governanceFile`) is required for true parity.
- **`constitutionFileDeleted` system branch.** After a delete, the System delete branch (`project.js:540–553`) renders the empty state but currently does **not** show the build buttons. The Constitution delete branch (`project.js:520–527`) *does* re-show its Build/Copy buttons. The System branch must be updated to match, or the empty-state copy will promise buttons that aren't visible.

## Edge-Case & Dependency Audit

- **Two file types, one tab.** The System tab toggles between `claude` (`CLAUDE.md`) and `agents` (`AGENTS.md`) via `_systemSelectedGovKey`. Build actions must pass the **current gov key** so the provider generates the right file. The terminal prompt and any copied prompt must be parameterized by gov key.
- **Reuse vs. new handlers.** The Constitution handlers (`invokeConstitutionBuilder`, `copyConstitutionPrompt`) are hard-coded to `CONSTITUTION.md` and the `constitution_builder.md` skill — they are **not** reusable for CLAUDE.md/AGENTS.md. Add **new** provider cases (`invokeSystemBuilder`, `copySystemBuildPrompt`) keyed on `governanceFile`.
- **Button visibility lifecycle.** Mirror the Constitution logic: show Build/Copy-Build when the file is **missing**, hide them when it **exists** (and keep Edit/Delete behavior as-is). The relevant System-tab branch is `project.js:620–638` (exists → `btnEditSystem.disabled=false`, `btnDeleteSystem.style.display=''`; missing → Edit enabled, Delete hidden). Add the new buttons into both branches.
- **Delete-then-rebuild path.** The `constitutionFileDeleted` handler has a System branch (`project.js:540–553`) that re-renders the empty state after a delete. The Constitution equivalent (`project.js:520–527`) re-shows Build/Copy buttons there. The System branch must do the same so a freshly-deleted file can be rebuilt without re-selecting. (Note: `deleteConstitutionFile` in the provider also triggers `loadConstitutionFiles` → `constitutionFilesLoaded` → `renderSystemDocList` → `selectSystemDoc` → `readConstitutionFile` → `constitutionFileRead` missing branch, which will *also* show the buttons; updating both branches avoids a flash of stale text/buttons.)
- **Workspace scoping.** Buttons must post `workspaceRoot: _systemSelectedWorkspace.workspaceRoot` and `governanceFile: _systemSelectedGovKey`, and the provider must validate `allRoots.includes(wsRoot)` exactly like the constitution cases (`PlanningPanelProvider.ts:3204`).
- **Terminal reuse.** `invokeConstitutionBuilder` reuses an existing planner/lead terminal or creates one (`PlanningPanelProvider.ts:3208`). Reuse the same `sendRobustText` helper (`require('./terminalUtils')`) for parity. (Inline `require` matches the existing pattern; extracting a shared helper is out of scope.)
- **Refresh after build.** Building happens asynchronously in a terminal; the file won't exist immediately. The existing `governanceFileChanged` watcher (`PlanningPanelProvider.ts:969`, handled in `project.js:401`/`:409`) already refreshes the preview when the file appears — so no manual refresh wiring is needed. Confirmed the watcher covers CLAUDE.md/AGENTS.md: the System branch at `project.js:409–415` gates on `_systemSelectedGovKey` and posts `readConstitutionFile` with that key.
- **No confirm dialogs** (repo hard rule) — build/copy are single-click, no prompts.
- **VSIX bundling** — pure DOM + message passing + existing `terminalUtils`; no new runtime deps, so webpack bundling is unaffected.
- **`dist/` not edited** — source of truth is `src/`.

## Dependencies

- None. This is a self-contained UI-parity change with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) reusing `constitutionPromptCopied` leaves the System Copy button with no "Copied!" feedback — must add a dedicated `systemPromptCopied` handler; (2) the `constitutionFileDeleted` System branch (`project.js:540–553`) must explicitly re-show Build/Copy buttons after delete or the empty-state copy will reference invisible buttons. Mitigations: dedicated toast message + handler; mirror the Constitution delete-branch button logic (`project.js:520–527`). Accepted parity-risk: no backend existence guard in the builder (matches shipped `invokeConstitutionBuilder`).

## Proposed Changes

### 1. `src/webview/project.html` — add Build buttons to the System control strip (lines 1391–1399)

Insert two buttons after the workspace filter and before the Edit button, mirroring the Constitution strip (`project.html:1359–1360`):

```html
<!-- System tab -->
<div id="system-content" class="shared-tab-content">
    <div class="controls-strip">
        <select id="system-workspace-filter">
            <option value="">All Workspaces</option>
        </select>
        <button id="btn-build-system" class="strip-btn" disabled>Build via Planner</button>
        <button id="btn-copy-system-prompt" class="strip-btn" disabled>Copy Build Prompt</button>
        <button id="btn-edit-system" class="strip-btn" disabled>Edit</button>
        <button id="btn-save-system" class="strip-btn" style="display:none;">Save</button>
        <button id="btn-cancel-system" class="strip-btn" style="display:none;">Cancel</button>
        <button id="btn-delete-system" class="strip-btn" style="display:none; color: #ff6b6b;">Delete</button>
    </div>
    ...
```

> Buttons start `disabled` but **visible** (no `display:none`), matching how `btn-build-via-planner` is declared (`project.html:1359`). They get hidden via `style.display='none'` in the exists branch and shown in the missing branch.

### 2. `src/webview/project.js` — grab the new elements and wire handlers

Near the existing System button lookups (`project.js:249–252`):

```javascript
const btnBuildSystem = document.getElementById('btn-build-system');
const btnCopySystemPrompt = document.getElementById('btn-copy-system-prompt');
```

Wire click handlers near the existing System handlers (`project.js:1764`):

```javascript
if (btnBuildSystem) {
    btnBuildSystem.addEventListener('click', () => {
        if (!_systemSelectedWorkspace) return;
        vscode.postMessage({
            type: 'invokeSystemBuilder',
            workspaceRoot: _systemSelectedWorkspace.workspaceRoot,
            governanceFile: _systemSelectedGovKey,   // 'claude' | 'agents'
        });
    });
}
if (btnCopySystemPrompt) {
    btnCopySystemPrompt.addEventListener('click', () => {
        if (!_systemSelectedWorkspace) return;
        vscode.postMessage({
            type: 'copySystemBuildPrompt',
            workspaceRoot: _systemSelectedWorkspace.workspaceRoot,
            governanceFile: _systemSelectedGovKey,
        });
    });
}
```

### 3. `src/webview/project.js` — toggle Build-button visibility + fix the empty-state copy

In the **exists** branch (`project.js:620–625`):

```javascript
if (msg.exists) {
    systemPreviewContent.innerHTML = msg.renderedHtml || '';
    state.editOriginalContent.system = msg.content || '';
    _systemSelectedFile = msg.filePath;
    if (btnEditSystem) btnEditSystem.disabled = false;
    if (btnDeleteSystem) btnDeleteSystem.style.display = '';
    if (btnBuildSystem) { btnBuildSystem.style.display = 'none'; }        // NEW
    if (btnCopySystemPrompt) { btnCopySystemPrompt.style.display = 'none'; } // NEW
}
```

In the **missing** branch (`project.js:626–638`), surface the buttons and reword the hint:

```javascript
} else {
    const filename = _systemSelectedGovKey === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    systemPreviewContent.innerHTML = `
        <div class="constitution-onboarding">
            <p class="constitution-onboarding-title">No ${filename} found for this workspace.</p>
            <p>Use <strong>Build via Planner</strong> above to generate one for this workspace, or <strong>Copy Build Prompt</strong> to run it yourself.</p>
        </div>
    `;
    state.editOriginalContent.system = '';
    _systemSelectedFile = null;
    if (btnEditSystem) btnEditSystem.disabled = false;
    if (btnDeleteSystem) btnDeleteSystem.style.display = 'none';
    if (btnBuildSystem) { btnBuildSystem.style.display = ''; btnBuildSystem.disabled = false; }        // NEW
    if (btnCopySystemPrompt) { btnCopySystemPrompt.style.display = ''; btnCopySystemPrompt.disabled = false; } // NEW
}
```

### 3b. `src/webview/project.js` — show Build buttons in the `constitutionFileDeleted` System branch (lines 540–553)

> **Correction:** the original plan mislabeled this branch as the "loadConstitutionFiles/list path." It is actually the `constitutionFileDeleted` handler, System branch. After a delete the file is missing, so the Build/Copy buttons must be shown — mirroring the Constitution delete branch (`project.js:520–527`).

```javascript
} else {
    if (systemPreviewContent && _systemSelectedWorkspace && _systemSelectedWorkspace.workspaceRoot === msg.workspaceRoot) {
        const filename = govFile === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
        systemPreviewContent.innerHTML = `
            <div class="constitution-onboarding">
                <p class="constitution-onboarding-title">No ${filename} found for this workspace.</p>
                <p>Use <strong>Build via Planner</strong> above to generate one for this workspace, or <strong>Copy Build Prompt</strong> to run it yourself.</p>
            </div>
        `;
        state.editOriginalContent.system = '';
        _systemSelectedFile = null;
        if (btnEditSystem) btnEditSystem.disabled = false;
        if (btnDeleteSystem) btnDeleteSystem.style.display = 'none';
        if (btnBuildSystem) { btnBuildSystem.style.display = ''; btnBuildSystem.disabled = false; }        // NEW
        if (btnCopySystemPrompt) { btnCopySystemPrompt.style.display = ''; btnCopySystemPrompt.disabled = false; } // NEW
    }
}
```

### 4. `src/services/PlanningPanelProvider.ts` — add `invokeSystemBuilder` and `copySystemBuildPrompt`

Add new cases next to the constitution builder cases (after `PlanningPanelProvider.ts:3228`). Parameterize the prompt by gov key.

```typescript
case 'invokeSystemBuilder': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    const key = msg.governanceFile === 'agents' ? 'agents' : 'claude';
    const filename = key === 'agents' ? 'AGENTS.md' : 'CLAUDE.md';
    const audience = key === 'agents'
        ? 'coding agents working in this repository'
        : 'Claude Code and other AI assistants working in this repository';
    const terminal = vscode.window.terminals.find(t =>
            t.name.toLowerCase().includes('planner') || t.name.toLowerCase().includes('lead'))
        || vscode.window.createTerminal({ name: 'System Builder', cwd: wsRoot });
    terminal.show();
    const promptText =
        `Inspect this codebase, then create a ${filename} file at the project root for ${audience}. ` +
        `Document: a concise architecture overview, the key build/test/lint commands, the directory layout, ` +
        `and any project-specific conventions or gotchas an agent must follow. Keep it tight and high-signal.`;
    const { sendRobustText } = require('./terminalUtils');
    await sendRobustText(terminal, promptText);
    break;
}

case 'copySystemBuildPrompt': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    const key = msg.governanceFile === 'agents' ? 'agents' : 'claude';
    const filename = key === 'agents' ? 'AGENTS.md' : 'CLAUDE.md';
    const audience = key === 'agents'
        ? 'coding agents working in this repository'
        : 'Claude Code and other AI assistants working in this repository';
    const promptText =
        `Inspect the codebase at ${wsRoot}, then create a ${filename} file at its root for ${audience}.\n` +
        `Include:\n` +
        `1. A concise architecture overview (what the project is, main components).\n` +
        `2. Key commands: build, test, lint, run.\n` +
        `3. Directory layout — where the important code lives.\n` +
        `4. Project-specific conventions, invariants, and gotchas an agent must respect.\n` +
        `Keep it tight and high-signal; do not pad.`;
    await vscode.env.clipboard.writeText(promptText);
    this._projectPanel?.webview.postMessage({ type: 'systemPromptCopied' }); // dedicated toast (see §5)
    break;
}
```

> **Accepted parity-risk:** `invokeSystemBuilder` does not guard against the file already existing — same as the shipped `invokeConstitutionBuilder` (`PlanningPanelProvider.ts:3203`). The UI only exposes the button when the file is missing; the backend does not re-check. Documented, not fixed, to match reference behavior.

### 5. `src/webview/project.js` — add a `systemPromptCopied` handler for Copy-button feedback

> **Required for parity** (not optional). The existing `constitutionPromptCopied` handler (`project.js:491–503`) only flashes the Constitution buttons. Add a dedicated handler next to it so the System Copy button shows "Copied!".

```javascript
case 'systemPromptCopied': {
    if (btnCopySystemPrompt) {
        const oldText = btnCopySystemPrompt.textContent;
        btnCopySystemPrompt.textContent = 'Copied!';
        btnCopySystemPrompt.disabled = true;
        setTimeout(() => {
            btnCopySystemPrompt.textContent = oldText;
            btnCopySystemPrompt.disabled = false;
        }, 2000);
    }
    break;
}
```

> Alternative (not preferred): extend the `constitutionPromptCopied` handler to branch on `msg.governanceFile` and flash `btnCopySystemPrompt`. The dedicated message above is cleaner and avoids coupling the two tabs' toast logic.

## Verification Plan

> Compilation (`npm run compile`) and automated tests are run separately by the user and are excluded from this verification pass per session directives. The steps below are manual UI verification via an installed VSIX.

### Automated Tests
- None required for this pass (test suite run separately by the user).

### Manual Verification
1. **Missing-file state:** In a workspace with **no** `CLAUDE.md`, open Project → System tab, select the CLAUDE.md doc. Confirm: the empty state now reads "Use Build via Planner above…", and **Build via Planner** + **Copy Build Prompt** buttons are visible and enabled; Delete is hidden.
2. **Build action (CLAUDE.md):** Click **Build via Planner**. Confirm a terminal opens (reusing planner/lead if present) and receives a generation prompt naming `CLAUDE.md`. Let it run; once the file is created, confirm the preview auto-refreshes (via the `governanceFileChanged` watcher, `project.js:409`) and the Build/Copy buttons hide while Edit/Delete appear.
3. **AGENTS.md parity:** Switch the System tab to AGENTS.md in a workspace lacking it; confirm the same buttons appear and **Build via Planner** sends a prompt naming `AGENTS.md` (not CLAUDE.md).
4. **Copy Build Prompt + feedback:** Click it; confirm the clipboard contains the parameterized prompt for the **currently selected** file type **and** the button flashes "Copied!" for ~2s (via the new `systemPromptCopied` handler).
5. **Existing-file state:** In a workspace that **has** `CLAUDE.md`, confirm Build/Copy buttons are hidden and Edit/Delete behave exactly as before.
6. **Delete-then-rebuild:** Delete `CLAUDE.md` from the System tab. Confirm the empty-state copy updates to "Use Build via Planner above…" **and** the Build/Copy buttons become visible/enabled immediately (via the `constitutionFileDeleted` System branch fix, §3b) — no stale "click Edit" text, no missing buttons.
7. **Workspace scoping:** Confirm build/copy operate on the selected workspace's root and the provider rejects unknown roots (`allRoots.includes(wsRoot)`).
8. **No regressions / no confirm dialogs:** Edit, Save, Cancel, Delete on the System tab still work; no confirmation dialog was introduced anywhere.

---

**Recommendation:** Complexity 4 → **Send to Coder.**
