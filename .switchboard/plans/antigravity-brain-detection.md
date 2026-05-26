# Antigravity Brain Detection

## Goal

Add automatic detection and display of Antigravity session artifacts stored in `~/.gemini/antigravity-cli/brain/` (and fallback paths) as a new collapsible section within the LOCAL DOCS tab, behind an opt-in user toggle.

## Metadata

- **Tags:** frontend, backend, UI, UX, workflow
- **Complexity:** 6

## User Review Required

> [!IMPORTANT]
> **Brain path is not canonical.** The plan originally assumed `~/.gemini/antigravity/brain/` but the actual path on this system is `~/.gemini/antigravity-cli/brain/`. The implementation must probe multiple candidate paths. Confirm whether additional paths (e.g. `~/.gemini/antigravity/brain/`) need to be supported.

> [!IMPORTANT]
> **Sessions are directories, not flat JSON files.** Each session is a UUID-named subdirectory containing `.md` files (`task.md`, `walkthrough.md`) and `.md.metadata.json` sidecar files. The original plan's JSON-parsing model is incorrect. The implementation uses the existing markdown rendering pipeline to display `.md` artifacts.

> [!NOTE]
> **Phase 6 JSON viewer descoped.** Interactive JSON expand/collapse is removed from scope. Session content is displayed as rendered markdown using the existing preview pipeline (plain `.md` files only).

## Complexity Audit

### Routine
- Path detection with `os.homedir()` — existing pattern in `LocalFolderService`
- Scanning a directory for sub-directories — mirrors `_scanFolder` logic
- Adding a new switch case in `_handleMessage()` — established pattern
- Adding a toggle to `controls-strip` using existing CSS classes
- Watcher dispose/re-setup — mirrors `_setupLocalFolderWatchers()`

### Complex / Risky
- Watcher must use `vscode.RelativePattern(vscode.Uri.file(brainPath), '*')` for a path outside the workspace — VS Code watcher does not auto-discover external paths with workspace-relative globs
- Global vs. workspace config scope: the toggle must persist globally (user preference), not per-workspace; incorrect `ConfigurationTarget` will cause the setting to silently disappear when the user switches repos
- Multi-path detection: `antigravity-cli` vs `antigravity` install layouts must both be probed

## Edge-Case & Dependency Audit

### Race Conditions
- Watcher triggers during panel disposal: guarded by `_watcherGeneration` counter (already used in `_setupActiveDocWatcher`)
- `listAntigravitySessions()` called concurrently with a file-system watcher callback — both are async read-only, safe

### Security
- All resolved paths must be validated with `path.resolve(p).startsWith(path.resolve(brainRoot))` before reading
- No user-supplied input reaches the file-system (brain path is always system-derived from `os.homedir()`)

### Side Effects
- Enabling the toggle will create a new watcher (outside workspace root). Disabling must explicitly dispose it
- The new `antigravityBrainEnabled` setting is registered as a VS Code configuration contribution (needs `package.json` addition)

### Dependencies & Conflicts
- `LocalFolderService` is extended but not changed in its public interface — existing callers unaffected
- `_sendLocalDocsReady()` is extended to include antigravity sessions — the `localDocsReady` message shape gains an optional `antigravitySessions` array; webview must handle it being undefined for backward compat

## Dependencies

- None: self-contained feature, no external package dependencies

## Adversarial Synthesis

Key risks: (1) incorrect brain path causes silent empty-list failures if only one path is probed; (2) watcher for an out-of-workspace path silently does nothing if not using `vscode.Uri.file`-based `RelativePattern`; (3) global vs. workspace config target causes the toggle to be reset on each workspace open. Mitigations: multi-path probe with existence check at detection time, explicit `vscode.Uri.file(brainPath)` in watcher creation, and `ConfigurationTarget.Global` for the opt-in flag.

## Proposed Changes

---

### `src/services/LocalFolderService.ts`

**Context:** Add Antigravity brain path detection and session listing. Sessions are UUID-named subdirectories within the brain directory. Each session contains `.md` artifact files (`task.md`, `walkthrough.md`) and `.md.metadata.json` sidecars.

#### Phase 1: Path Detection (lines ~1–25 region, new methods after constructor)

```typescript
// Candidate brain paths in probe order
private static readonly _ANTIGRAVITY_BRAIN_PATHS = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
];

detectAntigravityBrainPath(): string | null {
    for (const candidate of LocalFolderService._ANTIGRAVITY_BRAIN_PATHS) {
        try {
            const stat = fs.statSync(candidate);
            if (stat.isDirectory()) { return candidate; }
        } catch { /* not found */ }
    }
    return null;
}
```

**Edge Cases:**
- Returns `null` if no path exists → caller must hide UI gracefully
- Uses `statSync` (acceptable in detection context; not in a hot path)

#### Phase 2: Session Listing

```typescript
async listAntigravitySessions(): Promise<Array<{
    id: string;         // UUID folder name
    name: string;       // Display: first 8 chars of UUID
    timestamp: string;  // ISO string from folder mtime
    artifacts: Array<{ id: string; name: string; relativePath: string }>;
}>> {
    const brainPath = this.detectAntigravityBrainPath();
    if (!brainPath) { return []; }

    let sessionDirs: fs.Dirent[];
    try {
        sessionDirs = await fs.promises.readdir(brainPath, { withFileTypes: true });
    } catch { return []; }

    const sessions = [];
    for (const entry of sessionDirs) {
        if (!entry.isDirectory()) { continue; }
        // UUID pattern: 8-4-4-4-12 hex chars
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name)) { continue; }

        const sessionDir = path.join(brainPath, entry.name);
        let mtime = new Date();
        try {
            const stat = await fs.promises.stat(sessionDir);
            mtime = stat.mtime;
        } catch { /* use default */ }

        // Enumerate .md artifacts within the session (skip .metadata.json sidecars)
        let artifacts: Array<{ id: string; name: string; relativePath: string }> = [];
        try {
            const files = await fs.promises.readdir(sessionDir);
            artifacts = files
                .filter(f => f.endsWith('.md') && !f.includes('.metadata'))
                .map(f => ({
                    id: path.join(sessionDir, f),    // absolute path used as id for fetchDocContent
                    name: f.replace(/\.md$/, ''),     // e.g. "task", "walkthrough"
                    relativePath: path.join(entry.name, f)
                }));
        } catch { /* skip */ }

        if (artifacts.length === 0) { continue; } // Skip sessions with no displayable artifacts

        sessions.push({
            id: entry.name,
            name: entry.name.slice(0, 8),
            timestamp: mtime.toISOString(),
            artifacts
        });
    }

    // Newest first
    sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return sessions;
}
```

**Edge Cases:**
- Non-UUID directories (`.DS_Store`, `node_modules`, etc.) filtered by regex
- Sessions with zero `.md` files are skipped — they have no previewable content
- `.md.metadata.json` sidecars excluded by the `.includes('.metadata')` filter

#### Phase 3: Artifact Content Fetching

Add `fetchAntigravityArtifact(absolutePath: string)`:

```typescript
async fetchAntigravityArtifact(absolutePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    const brainPath = this.detectAntigravityBrainPath();
    if (!brainPath) { return { success: false, error: 'Antigravity brain not detected' }; }

    // Security: validate path stays within brain directory
    const resolved = path.resolve(absolutePath);
    if (!resolved.startsWith(path.resolve(brainPath))) {
        return { success: false, error: 'Invalid path' };
    }

    try {
        const content = await fs.promises.readFile(resolved, 'utf8');
        return { success: true, content };
    } catch (err: any) {
        return { success: false, error: String(err) };
    }
}
```

---

### `src/services/PlanningPanelProvider.ts`

#### Phase 4: Global config flag + `_setupAntigravityWatcher()` (new private method)

```typescript
// Add private field:
private _antigravityWatcher: vscode.FileSystemWatcher | undefined;

private _setupAntigravityWatcher(): void {
    // Dispose existing
    if (this._antigravityWatcher) {
        this._antigravityWatcher.dispose();
        const idx = this._disposables.indexOf(this._antigravityWatcher);
        if (idx !== -1) { this._disposables.splice(idx, 1); }
        this._antigravityWatcher = undefined;
    }

    const config = vscode.workspace.getConfiguration('switchboard');
    const enabled = config.get<boolean>('research.antigravityBrainEnabled', false);
    if (!enabled) { return; }

    const allRoots = this._getWorkspaceRoots();
    const service = new LocalFolderService(allRoots[0] || '');
    const brainPath = service.detectAntigravityBrainPath();
    if (!brainPath) { return; }

    // CRITICAL: must use vscode.Uri.file for out-of-workspace paths
    const brainUri = vscode.Uri.file(brainPath);
    this._antigravityWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(brainUri, '*')  // Watch for new/deleted session directories
    );

    const refresh = () => this._sendLocalDocsReady();
    this._antigravityWatcher.onDidCreate(refresh);
    this._antigravityWatcher.onDidDelete(refresh);
    this._disposables.push(this._antigravityWatcher);
}
```

Call `this._setupAntigravityWatcher()` in `open()` after `_setupLocalFolderWatchers()` (line ~280).

#### Phase 5: Message handler — `toggleAntigravityBrain`

Add to `_handleMessage()` switch (after `setLocalFolderPath` case, ~line 596):

```typescript
case 'toggleAntigravityBrain': {
    const enabled = Boolean(msg.enabled);
    await vscode.workspace.getConfiguration('switchboard').update(
        'research.antigravityBrainEnabled',
        enabled,
        vscode.ConfigurationTarget.Global  // MUST be Global — user preference, not workspace
    );
    this._setupAntigravityWatcher();        // Re-setup watcher on toggle
    await this._sendLocalDocsReady();       // Refresh tree
    break;
}

case 'fetchAntigravityArtifact': {
    const artifactPath = msg.artifactPath;
    const requestId = msg.requestId || -1;
    const allRoots = this._getWorkspaceRoots();
    const service = new LocalFolderService(allRoots[0] || '');
    const result = await service.fetchAntigravityArtifact(artifactPath);
    if (result.success) {
        this._panel?.webview.postMessage({
            type: 'previewReady',
            sourceId: 'antigravity',
            requestId,
            content: result.content || '',
            docName: path.basename(artifactPath, '.md')
        });
    } else {
        this._panel?.webview.postMessage({
            type: 'previewError',
            sourceId: 'antigravity',
            requestId,
            error: result.error || 'Failed to load artifact'
        });
    }
    break;
}
```

#### Phase 6: Extend `_sendLocalDocsReady()` to include antigravity sessions

After the existing `allFiles` aggregation loop (~line 1170), before the final `postMessage`:

```typescript
// Antigravity sessions
let antigravitySessions: Array<{
    id: string; name: string; timestamp: string;
    artifacts: Array<{ id: string; name: string; relativePath: string }>;
}> = [];

const agConfig = vscode.workspace.getConfiguration('switchboard');
const agEnabled = agConfig.get<boolean>('research.antigravityBrainEnabled', false);
if (agEnabled && allRoots.length > 0) {
    try {
        const agService = new LocalFolderService(allRoots[0]);
        antigravitySessions = await agService.listAntigravitySessions();
    } catch (err) {
        console.debug('[PlanningPanel] Failed to list antigravity sessions:', err);
    }
}

// Then update the postMessage payload:
this._panel.webview.postMessage({
    type: 'localDocsReady',
    sourceId: 'local-folder',
    folderPath: configuredFolderPath || '',
    nodes: this._mapLocalFilesToTreeNodes(allFiles),
    antigravitySessions,           // NEW — undefined-safe in webview
    antigravityEnabled: agEnabled  // NEW — tells webview whether to show toggle as checked
});
```

---

### `src/webview/planning.html`

#### Phase 7: Add toggle to controls strip

In `#controls-strip-local` (lines 1190–1196), add after existing buttons:

```html
<label class="toggle-switch" style="margin-left: auto;" title="Include Antigravity Sessions">
    <input type="checkbox" id="antigravity-toggle">
    <span class="toggle-slider"></span>
</label>
<span class="toggle-label" style="font-size:10px; letter-spacing:0.5px; text-transform:uppercase; color:var(--text-secondary);">Antigravity</span>
```

**Note:** `margin-left: auto` on the label pushes it to the right edge, keeping it visually separated from the action buttons.

#### Phase 8: "ANTIGRAVITY SESSIONS" section in tree pane

The section is injected dynamically by `planning.js` — no static HTML required. However, add this CSS in the `<style>` block:

```css
.antigravity-session-ts {
    font-size: 10px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    margin-left: auto;
    flex-shrink: 0;
}

.antigravity-artifact-node {
    padding-left: 24px; /* Indent under session header */
}
```

---

### `src/webview/planning.js`

#### Phase 9: Handle `localDocsReady` with antigravity sessions

In `handleLocalDocsReady(msg)` (~line 1368), append after existing tree rendering:

```javascript
// Handle antigravity sessions section
renderAntigravitySessions(msg.antigravitySessions || [], msg.antigravityEnabled || false);

// Sync toggle state
const agToggle = document.getElementById('antigravity-toggle');
if (agToggle) { agToggle.checked = msg.antigravityEnabled || false; }
```

#### Phase 10: `renderAntigravitySessions(sessions, enabled)` function

```javascript
function renderAntigravitySessions(sessions, enabled) {
    const treePane = document.getElementById('tree-pane');
    if (!treePane) { return; }

    // Remove existing section
    const existing = document.getElementById('antigravity-section');
    if (existing) { existing.remove(); }

    if (!enabled) { return; }

    const section = document.createElement('div');
    section.id = 'antigravity-section';

    const header = document.createElement('div');
    header.className = 'source-header';
    header.textContent = 'ANTIGRAVITY SESSIONS';
    section.appendChild(header);

    if (sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tree-placeholder';
        empty.textContent = 'No sessions found in brain directory';
        section.appendChild(empty);
    } else {
        for (const session of sessions) {
            // Session row (collapsed header)
            const sessionRow = document.createElement('div');
            sessionRow.className = 'tree-node folder-subheader';
            sessionRow.innerHTML = `<span class="icon">🧠</span><span class="label">${session.name}…</span>
                <span class="antigravity-session-ts">${new Date(session.timestamp).toLocaleDateString()}</span>`;
            section.appendChild(sessionRow);

            // Artifact rows under each session
            for (const artifact of session.artifacts) {
                const artifactRow = document.createElement('div');
                artifactRow.className = 'tree-node antigravity-artifact-node';
                artifactRow.dataset.artifactPath = artifact.id;
                artifactRow.innerHTML = `<span class="icon">📄</span><span class="label">${artifact.name}</span>`;
                artifactRow.addEventListener('click', () => {
                    document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
                    artifactRow.classList.add('selected');
                    vscode.postMessage({
                        type: 'fetchAntigravityArtifact',
                        artifactPath: artifact.id,
                        requestId: ++state.previewRequestId
                    });
                });
                section.appendChild(artifactRow);
            }
        }
    }

    treePane.appendChild(section);
}
```

#### Phase 11: Toggle event listener (in the DOMContentLoaded init block)

```javascript
const agToggle = document.getElementById('antigravity-toggle');
if (agToggle) {
    agToggle.addEventListener('change', () => {
        vscode.postMessage({ type: 'toggleAntigravityBrain', enabled: agToggle.checked });
    });
}
```

---

### `package.json`

#### Phase 12: Register configuration contribution

Add to `contributes.configuration.properties`:

```json
"switchboard.research.antigravityBrainEnabled": {
    "type": "boolean",
    "default": false,
    "description": "Show Antigravity session artifacts in the LOCAL DOCS panel."
}
```

This is required for `vscode.workspace.getConfiguration('switchboard').get('research.antigravityBrainEnabled')` to work with `ConfigurationTarget.Global`.

## Verification Plan

### Manual Verification
1. **No antigravity install**: toggle should remain hidden or show "not detected" — confirm by pointing `_ANTIGRAVITY_BRAIN_PATHS` to a non-existent path in dev and verifying the UI shows nothing
2. **Toggle enable**: flip the toggle ON → tree should show "ANTIGRAVITY SESSIONS" section with session entries
3. **Toggle disable**: flip OFF → section disappears, watcher is disposed (confirm no memory leak via VS Code extension host logs)
4. **Click artifact**: click `task` under a session → preview pane should render the markdown content
5. **Live update**: add a new session directory while panel is open → after debounce, tree should refresh with the new session
6. **Multi-path fallback**: temporarily rename `antigravity-cli` to `antigravity` and verify detection still works
7. **Empty session**: create a UUID directory with no `.md` files → session should be excluded from list

### Automated Tests
*(To be run separately by user — skipped per session directive)*

---

## Implementation Order

1. `package.json` — register config key (prerequisite for global setting reads)
2. `LocalFolderService.ts` — add `detectAntigravityBrainPath()`, `listAntigravitySessions()`, `fetchAntigravityArtifact()`
3. `PlanningPanelProvider.ts` — add `_setupAntigravityWatcher()`, two new switch cases, extend `_sendLocalDocsReady()`
4. `planning.html` — add toggle to controls strip, add CSS
5. `planning.js` — add `renderAntigravitySessions()`, wire toggle event, handle `localDocsReady` extension

**Send to Coder**

## Problem (preserved)
The ARTIFACTS view does not detect or display antigravity session artifacts stored in `~/.gemini/antigravity/brain/`. Users cannot access their antigravity session history and artifacts from the planning panel.

## Solution (preserved)
Add automatic detection and display of antigravity brain folder contents in the LOCAL DOCS tab.

## Files to Modify
- `src/services/LocalFolderService.ts` - Detection and parsing logic
- `src/services/PlanningPanelProvider.ts` - Message handlers and watchers
- `src/webview/planning.html` - Toggle control and tree structure
- `src/webview/planning.js` - Tree rendering and preview logic
- `package.json` - Configuration contribution

## Edge Cases (preserved)
- Antigravity not installed (hide toggle, show "not detected" message)
- Brain directory exists but no JSON files (show empty state)
- Malformed JSON files (skip with error log, don't crash)
- Very large session files (truncate preview or stream)
- Session files with non-UUID names (still display if valid JSON)
- User has both local docs and antigravity enabled (tree should show both sections)
- Rapid file changes in brain directory (debounce watcher)

## Future Enhancements (preserved)
- Allow filtering sessions by date range
- Allow searching session content
- Allow exporting sessions to markdown
- Link sessions to associated plan files if metadata exists
- Show session duration or other metadata if available
