# Constitution Tab Should Also Cover CLAUDE.md and AGENTS.md

## Goal (Problem analysis + Root Cause with cited file:line)

The project panel's **Constitution** tab lets a user view/edit exactly one governance file per workspace — by default `CONSTITUTION.md`, or a custom relative path stored per-workspace-root in `switchboard.constitutionPaths`. The path is resolved by `getConstitutionPath()` in `src/services/constitutionUtils.ts`, which falls back to `path.join(workspaceRoot, 'CONSTITUTION.md')`.

But `CLAUDE.md` and `AGENTS.md` are equally important for directing the project — they are the files agents actually read at runtime to govern their behavior. Today there is **no way to view or edit them from the panel**; the user must open them manually in the editor. The Constitution tab already implements every primitive needed to manage them (workspace list, markdown preview, edit/save/delete, external file watcher, per-tab edit-mode state) — it is simply hard-wired to a single file per workspace.

### Root cause

The Constitution feature is single-file by construction:

- `src/services/constitutionUtils.ts` — `getConstitutionPath()` resolves to one path (custom or `CONSTITUTION.md`).
- `src/services/PlanningPanelProvider.ts`:
  - `loadConstitutionFiles` (≈2962-2976) checks existence of that one path per workspace.
  - `readConstitutionFile` (≈2998-3038) reads that one path.
  - `saveConstitutionFile` (≈3039-3069), `deleteConstitutionFile` (≈3188-3197) write/unlink that one path.
  - `_setupConstitutionWatcher()` (≈925-960) watches only that one basename per root.
- `src/webview/project.html` — the Constitution tab (≈1271-1308) has a single preview/editor pair and no file-type selector.
- `src/webview/project.js` — `selectConstitutionWorkspace()` (≈1280-1284) sends `readConstitutionFile` with no file identity beyond `workspaceRoot`.

The fix is to **parameterize the existing Constitution machinery by a governance-file key** (`constitution` | `claude` | `agents`) and add a small file-type selector to the tab, reusing all existing read/save/delete/watch/edit-mode plumbing. `CONSTITUTION.md` keeps its configurable custom path and its "Enable as Planning Reference" toggle; `CLAUDE.md` and `AGENTS.md` resolve to fixed root-relative filenames and are view/edit only (agents auto-load them, so a "planning reference" toggle is unnecessary — see Edge-Case Audit).

## Metadata

**Complexity:** 6/10
**Tags:** feature, ui, ux

## User Review Required

None. The scope is well-defined: extend an existing tab to view/edit two additional, well-known governance files. CLAUDE.md and AGENTS.md are fixed filenames at the workspace root (the agent-ecosystem convention), so there is no product ambiguity. The "Enable as Planning Reference" toggle stays constitution-only because the planner prompt's constitution injection (`agentPromptBuilder.ts:558-560`) is constitution-specific and CLAUDE.md/AGENTS.md are already consumed natively by agents.

## Complexity Audit

### Routine
- Adding a segmented file-type selector (3 buttons) to the Constitution tab in `project.html`.
- Threading a `governanceFile` field through the existing webview ↔ extension messages.
- Mapping the key to a filename in one resolver helper.

### Complex / Risky
- **Back-compat with the shipped Constitution feature.** `switchboard.constitutionPaths` and the entire Constitution tab shipped in released versions (~4,000 installs). The existing custom-path behavior, the "Enable as Planning Reference" wiring, and the planner-prompt constitution injection must all continue to work unchanged when `governanceFile === 'constitution'`. This is an **additive** change — the default message shape (no `governanceFile`) must still resolve to the constitution path.
- **File watcher fan-out.** The watcher currently registers one basename per root. It must now register up to three (constitution path + `CLAUDE.md` + `AGENTS.md`) per root and route change events back to the correct file-type so the live preview updates only when the currently-viewed file changes.
- **Path-safety for new files.** `CLAUDE.md`/`AGENTS.md` are fixed root-relative names; they must be validated the same way the custom constitution path is (no `..`, not absolute, inside the root).
- **Variable naming collision.** `_constitutionSelectedFile` already exists in `project.js:137` and stores the **file path** (set at line 456: `_constitutionSelectedFile = msg.filePath`). It is used as a null-check at lines 342, 400, 424, 480 to determine whether a file exists. The new file-type key variable MUST use a different name (e.g. `_constitutionSelectedGovKey`) to avoid overwriting path-tracking semantics and breaking every `!== null` existence check.

## Edge-Case & Dependency Audit

1. **Back-compat — omitted `governanceFile`.** Any code path or in-flight message that sends `readConstitutionFile`/`saveConstitutionFile`/`deleteConstitutionFile` **without** a `governanceFile` field must default to `'constitution'`. The resolver below defaults accordingly so no shipped behavior changes.
2. **Custom constitution path preserved.** `switchboard.constitutionPaths[wsRoot]` continues to drive ONLY the `'constitution'` key. `'claude'`/`'agents'` ignore it and always resolve to `CLAUDE.md`/`AGENTS.md` at the root. The settings (⚙) button stays enabled only for the constitution file-type.
3. **File does not exist.** CLAUDE.md/AGENTS.md frequently won't exist. The existing `exists: false` empty-state path already handles this for constitution; the parameterized handler reuses it. Saving a non-existent CLAUDE.md creates it (same as constitution today).
4. **Delete executes immediately, no confirm.** Per repo rule — the delete button unlinks the resolved file with no `confirm()`/modal. (`deleteConstitutionFile` already does this; we only parameterize the path.)
5. **"Enable as Planning Reference" is constitution-only.** When `'claude'`/`'agents'` is selected, hide/disable `#btn-enable-constitution`, `#btn-build-via-planner`, `#btn-update-via-planner`, and the copy-prompt buttons — those are constitution-specific. View/Edit/Save/Cancel/Delete remain available for all three.
6. **Watcher routing.** A change to `CLAUDE.md` must only refresh the preview if the user is currently viewing `claude` for that workspace; otherwise it just updates the list-pane existence indicator. Mis-routing would clobber an open editor for a different file-type.
7. **Edit-mode state isolation.** `state.editMode`/`state.dirtyFlags`/`state.editOriginalContent` are keyed by tab string `'constitution'`. Switching file-type while dirty must exit edit mode first (the list-item click handler already calls `exitEditMode('constitution')` when dirty — reuse that on file-type switch).
8. **Multi-repo workspaces.** Each workspace root is handled independently in the list; the file-type selector applies to the currently-selected workspace. No cross-root path bleed.
9. **Path traversal.** `CLAUDE.md`/`AGENTS.md` are constant basenames joined to the validated `workspaceRoot`; the existing `allRoots.includes(wsRoot)` guard still gates every handler.
10. **`getConstitutionStatus` must be gated.** The `constitutionFileRead` handler at `project.js:452` calls `vscode.postMessage({ type: 'getConstitutionStatus', ... })` on every successful read. This queries constitution-specific planner config and must only fire when `_constitutionSelectedGovKey === 'constitution'`. For `'claude'`/`'agents'`, skip this call entirely — the status banner and Enable button are hidden anyway.
11. **`constitutionFileDeleted` handler must be parameterized.** The delete-result handler at `project.js:413-445` shows a constitution-specific onboarding message. When deleting CLAUDE.md or AGENTS.md, show a generic empty-state message instead (e.g. "No CLAUDE.md found for this workspace."). The handler must check `msg.governanceFile` (echoed back from the extension) to select the appropriate message.
12. **`fileSaved` handler re-read path.** At `project.js:520-522`, after a successful constitution save, the handler calls `selectConstitutionWorkspace(_constitutionSelectedWorkspace)`. Since `selectConstitutionWorkspace` will be updated to include `governanceFile: _constitutionSelectedGovKey`, this re-read will correctly carry the file-type key. No additional change needed here — but verify during implementation.
13. **`constitutionAddonState` message.** The `toggleConstitutionAddon` handler at `PlanningPanelProvider.ts:3070` posts `constitutionAddonState`. This is constitution-specific and the webview only acts on it for the constitution banner. When viewing claude/agents, the banner is hidden, so this message is harmlessly ignored. No change needed.

### Race Conditions
- Switching file-type sends a fresh `readConstitutionFile`; a late-arriving read for the previously-selected file-type could overwrite the preview. Mitigate by tagging the read response with `governanceFile` and ignoring responses whose `governanceFile` !== the current selection (the webview already tracks `_constitutionSelectedWorkspace`; add `_constitutionSelectedGovKey`).

### Security
- None. All files are inside the validated workspace root; no secrets, no network. Reuses existing path guards.

### Side Effects
- The constitution file watcher now registers up to 3 watchers per root instead of 1 (disposed/recreated together in `_setupConstitutionWatcher()`). Bounded and disposed on the existing lifecycle.

### Dependencies & Conflicts
- No migration required: this is purely additive and the default (no `governanceFile`) preserves shipped behavior. `switchboard.constitutionPaths` format is untouched.
- No conflict with the planner-prompt constitution injection (`agentPromptBuilder.ts:558-560`) — that path is unchanged and still keyed to the constitution file only.

## Dependencies

- None — this is a self-contained feature extension.

## Adversarial Synthesis

Key risks: (1) variable naming collision between the new file-type key and the existing `_constitutionSelectedFile` path-tracking variable would break all existence checks; (2) unguarded `getConstitutionStatus` call would show misleading constitution-planner-state for CLAUDE.md/AGENTS.md reads; (3) unparameterized `constitutionFileDeleted` handler would show constitution-specific onboarding text after deleting CLAUDE.md. Mitigations: use `_constitutionSelectedGovKey` for the file-type key, gate `getConstitutionStatus` to constitution-only, and parameterize the delete-result handler with file-type-appropriate messaging.

## Proposed Changes

### 1. `src/services/constitutionUtils.ts` — add a governance-file resolver

Add a resolver that maps a file-type key to an absolute path, delegating to the existing constitution resolver for the `'constitution'` key so custom paths keep working.

```ts
export type GovernanceFileKey = 'constitution' | 'claude' | 'agents';

const GOVERNANCE_BASENAMES: Record<Exclude<GovernanceFileKey, 'constitution'>, string> = {
    claude: 'CLAUDE.md',
    agents: 'AGENTS.md',
};

export function getGovernanceFilePath(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    key: GovernanceFileKey = 'constitution'
): string {
    if (key === 'constitution') {
        return getConstitutionPath(context, workspaceRoot); // preserves custom paths
    }
    return path.join(workspaceRoot, GOVERNANCE_BASENAMES[key]);
}
```

### 2. `src/services/PlanningPanelProvider.ts` — parameterize the handlers

Add a private helper and thread `governanceFile` (defaulting to `'constitution'`) through `loadConstitutionFiles`, `readConstitutionFile`, `saveConstitutionFile`, `deleteConstitutionFile`, and `openSetConstitutionPath`.

```ts
private _getGovernanceFilePath(workspaceRoot: string, key: GovernanceFileKey = 'constitution'): string {
    const { getGovernanceFilePath } = require('./constitutionUtils');
    return getGovernanceFilePath(this._context, workspaceRoot, key);
}
```

- **`loadConstitutionFiles`** (lines 2962-2976): for each workspace, report existence of all three files so the list pane can show per-file status:
  ```ts
  const governance = (['constitution','claude','agents'] as const).map(key => ({
      key,
      exists: fs.existsSync(this._getGovernanceFilePath(ws.workspaceRoot, key)),
  }));
  return { label: ws.label, workspaceRoot: ws.workspaceRoot, governance,
           hasConstitution: governance[0].exists /* keep legacy field */ };
  ```
- **`readConstitutionFile`** (lines 2998-3038): read `const key = msg.governanceFile ?? 'constitution';` via `this._getGovernanceFilePath(wsRoot, key)`, and echo `governanceFile: key` back in **every** `constitutionFileRead` message (for race-safe routing). This includes the error/invalid-root and not-exists branches.
- **`saveConstitutionFile`** (lines 3039-3069) and **`deleteConstitutionFile`** (lines 3188-3197): same `key` resolution; echo `governanceFile` in their result messages (`fileSaved` and `constitutionFileDeleted`). Delete stays immediate (no confirm).
- **`openSetConstitutionPath`/`setConstitutionPath`** (lines 3201-3240): leave keyed to constitution only — the ⚙ path override applies to `CONSTITUTION.md` exclusively. The webview disables ⚙ for claude/agents.

### 3. `src/services/PlanningPanelProvider.ts` — `_setupConstitutionWatcher()` (lines 925-979)

Register a watcher per governance file per root (constitution custom path + `CLAUDE.md` + `AGENTS.md`). On change/create/delete, post a refresh that includes the `governanceFile` key so the webview routes it correctly. Follow the existing `RelativePattern` idiom (`vscode.Uri.file(root)` + `path.relative(root, targetPath)`):

```ts
allRoots.forEach(root => {
    const watchedPaths = new Set<string>(); // dedup by resolved path
    (['constitution','claude','agents'] as const).forEach(key => {
        const targetPath = this._getGovernanceFilePath(root, key);
        const resolved = path.resolve(targetPath);
        if (watchedPaths.has(resolved)) { return; } // avoid double-registration if custom path === CLAUDE.md/AGENTS.md
        watchedPaths.add(resolved);

        const relativePattern = path.relative(root, targetPath);
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(root), relativePattern));
        const refresh = () => {
            if (!this._projectPanel) { return; }
            if (this._constitutionWatchDebounce) { clearTimeout(this._constitutionWatchDebounce); }
            this._constitutionWatchDebounce = setTimeout(() => {
                this._constitutionWatchDebounce = undefined;
                if (!this._projectPanel) { return; }
                this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true)
                    .catch(err => console.error('[PlanningPanel] Error auto-refreshing constitution files:', err));
                this._projectPanel?.webview.postMessage({
                    type: 'governanceFileChanged',
                    workspaceRoot: root,
                    governanceFile: key
                });
            }, 400);
        };
        watcher.onDidChange(refresh); watcher.onDidCreate(refresh); watcher.onDidDelete(refresh);
        this._constitutionWatchers.push(watcher); this._disposables.push(watcher);
    });
});
```
(Note: the existing `watchedPaths` Set at line 940 tracks roots; the new inner Set tracks resolved file paths within each root to avoid double-registration when a custom constitution path equals `CLAUDE.md`/`AGENTS.md`.)

### 4. `src/webview/project.html` — add file-type selector to the Constitution tab

Inside `#constitution-content` (line 1271), above the `.controls-strip` (line 1279), add a segmented control:

```html
<div class="governance-file-tabs" id="governance-file-tabs">
    <button class="gov-file-btn active" data-gov="constitution">CONSTITUTION.md</button>
    <button class="gov-file-btn" data-gov="claude">CLAUDE.md</button>
    <button class="gov-file-btn" data-gov="agents">AGENTS.md</button>
</div>
```
Style to match the existing `.shared-tab-btn` look. No new preview/editor elements are needed — the single `#constitution-preview-pane` / `#constitution-editor` pair is reused for whichever file-type is active.

### 5. `src/webview/project.js` — track selected file-type and route messages

**CRITICAL: Use `_constitutionSelectedGovKey`, NOT `_constitutionSelectedFile`.** The latter already exists at line 137 and stores the file **path** (set at line 456: `_constitutionSelectedFile = msg.filePath`). It is used as a null-check at lines 342, 400, 424, 480. Reusing that name would break all existence checks.

- Add state (near line 137): `let _constitutionSelectedGovKey = 'constitution';`
- Wire the `.gov-file-btn` buttons: on click, if `state.dirtyFlags.constitution` call `exitEditMode('constitution')`, set `_constitutionSelectedGovKey`, toggle `.active`, toggle visibility of constitution-only buttons (`#btn-enable-constitution`, `#btn-build-via-planner`, `#btn-update-via-planner`, copy-prompt buttons, `#btn-set-constitution-path`, `#active-constitution-banner`), then re-issue the read:
  ```js
  vscode.postMessage({ type: 'readConstitutionFile',
      workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot,
      governanceFile: _constitutionSelectedGovKey });
  ```
- `selectConstitutionWorkspace()` (lines 1280-1284): include `governanceFile: _constitutionSelectedGovKey` in the read message.
- `constitutionFileRead` handler (lines 447-497):
  - **Race guard:** ignore the response if `msg.governanceFile && msg.governanceFile !== _constitutionSelectedGovKey`.
  - **Gate `getConstitutionStatus`:** only call `vscode.postMessage({ type: 'getConstitutionStatus', ... })` (line 452) when `_constitutionSelectedGovKey === 'constitution'`. For `'claude'`/`'agents'`, skip this call — the status banner and Enable button are hidden.
  - Otherwise render as today.
- `constitutionFileDeleted` handler (lines 413-445):
  - **Parameterize the empty-state message.** Check `msg.governanceFile` (echoed from the extension). If `'claude'` or `'agents'`, show a generic message (e.g. "No CLAUDE.md found for this workspace.") instead of the constitution-specific onboarding text. If `'constitution'` or undefined (back-compat), show the existing onboarding message.
- Save handler (lines 1458-1470): include `governanceFile: _constitutionSelectedGovKey` in the posted message.
- Delete handler (lines 1343-1351): include `governanceFile: _constitutionSelectedGovKey` in the posted message.
- Add a `governanceFileChanged` handler: refresh list; if `msg.workspaceRoot === selected && msg.governanceFile === _constitutionSelectedGovKey && !state.editMode.constitution`, re-issue the read to live-update the preview.
- `renderConstitutionWorkspaceList()` (lines 1233-1278): use the new per-file `governance[]` existence array to render a richer status (e.g. `C·Cl·A` badges) without changing the click behavior.

## Verification Plan

### Automated Tests
No automated tests required for this session — the suite is run separately by the user. (Per session directive: skip compilation and automated tests.) `src/` is the source of truth; do not build/inspect `dist/`.

### Manual Verification
1. **Constitution back-compat:** Open the Constitution tab, select a workspace with an existing custom-path constitution (set via ⚙). Confirm it still loads, edits, saves, and that "Enable as Planning Reference" still works exactly as before.
2. **CLAUDE.md view/edit:** Select the `CLAUDE.md` file-type for a workspace that has one. Confirm it renders, Edit→Save round-trips to the on-disk `CLAUDE.md`, and the constitution-only buttons (Enable/Build/Update/⚙) and the constitution status banner are hidden/disabled.
3. **AGENTS.md create:** Select `AGENTS.md` for a workspace that lacks one. Confirm empty state, then Edit→Save creates `AGENTS.md` at the root.
4. **Delete is immediate:** Delete a CLAUDE.md — confirm the file is unlinked with no confirmation dialog, the list status updates, and the empty-state message says "No CLAUDE.md found" (not the constitution onboarding text).
5. **External watcher routing:** With `CLAUDE.md` open in the panel (not in edit mode), edit `CLAUDE.md` on disk in the editor and save — confirm the panel preview live-updates. Then switch to `AGENTS.md`, edit `CLAUDE.md` on disk again — confirm the open AGENTS.md preview is NOT clobbered (only the list badge updates).
6. **Race guard:** Rapidly click between the three file-type buttons; confirm the preview always ends on the last-clicked file (no stale read wins).
7. **No confirm dialogs** were introduced anywhere.
8. **No `getConstitutionStatus` leak:** While viewing CLAUDE.md, confirm no constitution status banner appears and the Enable button remains hidden.

---

**Recommendation:** Complexity 6/10 → **Send to Coder** (multi-file webview + extension change with back-compat constraints).
