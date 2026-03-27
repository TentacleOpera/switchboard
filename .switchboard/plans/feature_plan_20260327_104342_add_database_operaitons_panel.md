# Add Database Operations Panel to Sidebar

## Goal
Expose database configuration and CLI tooling through a visible accordion panel in the Switchboard sidebar. The current `kanban.dbPath` setting is buried in VS Code: settings—users won't find it. This panel puts cloud sync configuration, CLI tools, and database operations one click away.

## Metadata
**Tags:** frontend, UI, database
**Complexity:** High

## Problem Statement

1. **Hidden configuration**: The `switchboard.kanban.dbPath` setting exists in `package.json` but is invisible in daily use. Users don't know they can sync their kanban database across machines.

2. **CLI tooling gap**: Users don't know DuckDB is available or how to install it. No guidance on using the CLI for archive queries.

3. **No quick terminal access**: To query the archive, users must manually open a terminal and type DuckDB commands. No "Open Archive in Terminal" shortcut exists.

4. **Setup friction**: Multi-machine handover requires: (a) finding the hidden setting, (b) manually typing a path, (c) installing DuckDB separately, (d) remembering CLI syntax. Too many steps.

## Solution Overview

Add an accordion section **"Database & Sync"** to the Switchboard sidebar webview with:
- **Cloud Location** — Visual path display with edit button, validation, cloud-folder presets (Google Drive, Dropbox, iCloud)
- **CLI Tools** — Install status indicators, one-click install helpers (brew, winget, download links)
- **Quick Actions** — Open terminal with DuckDB preloaded, export to archive, view database stats

## User Review Required

- Confirm accordion section name: "Database & Sync" vs "Storage & Archive" vs "Cloud Sync"
- Confirm which cloud providers get preset buttons (Google Drive, Dropbox, iCloud, OneDrive, custom)
- Confirm CLI install helpers: auto-detect OS and suggest command, or just open official install docs?
- Confirm visibility: always shown, or collapsed by default to reduce sidebar clutter?

## Complexity Audit

### Routine
- **Accordion UI** — Add new section to existing sidebar webview (`src/webview/kanban.html` or separate component). ~50 lines HTML/CSS.
- **Path input with validation** — Text field with browse button, test-connection check, green/red status indicator. ~30 lines.
- **CLI install status** — Check `duckdb --version` via Node `child_process`, display installed/not-installed badge. ~20 lines.

### Complex / Risky
- **Cross-platform path handling** — macOS `~/Library/CloudStorage/GoogleDrive-*`, Windows `%USERPROFILE%\Google Drive`, Linux `~/Google Drive`. Path templates need OS detection.
- **Cloud folder auto-detection** — Scan common locations for Google Drive/Dropbox presence. May be slow or wrong. Fallback to manual path entry.
- **CLI installation automation** — Actually running `brew install duckdb` requires user password, terminal access, may fail. Safer to show command and copy-to-clipboard.

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent DB access during path change**: If the user changes the DB path while the kanban board is actively reading/writing (e.g., mid-autoban cycle), the old connection handle may still be open. The path update must gracefully close the old connection before opening the new one, or queue writes until the switch completes.
- **CLI version check during install**: The `checkCliTools()` call could overlap with a user-triggered install action. If the version check runs while an install is in progress, it may report "not installed" erroneously. Guard with a `cliCheckInProgress` flag.

### Security
- **`resetDatabase()` uses only `confirm()` dialog**: A single browser-native `confirm()` is insufficient for a destructive operation that deletes all plan metadata. This should be replaced with a VS Code modal dialog (`vscode.window.showWarningMessage` with `{ modal: true }`) requiring explicit confirmation text (e.g., typing "RESET") or a two-step confirmation sequence.
- **Path traversal via preset injection**: The `setPresetDbPath` function constructs file paths from user-controlled preset names. While currently limited to a `switch` statement, future presets must not allow arbitrary path construction. Validate all resolved paths are within expected directories.
- **Shell injection via `openCliTerminal`**: The `terminal.sendText()` call interpolates `expandedPath` directly. A malicious path containing shell metacharacters (e.g., `; rm -rf /`) could execute arbitrary commands. Sanitize or quote the path before passing to `sendText()`.

### Side Effects
- **VS Code settings mutation**: The `editDbPath` and `setPresetDbPath` functions write to `vscode.ConfigurationTarget.Workspace`, modifying `.vscode/settings.json`. This could surprise users who version-control their workspace settings. Consider warning the user or offering Global vs Workspace scope choice.
- **DuckDB terminal process left running**: `openCliTerminal` creates a new terminal but never tracks it. If the user clicks the button repeatedly, orphaned DuckDB processes accumulate. Track the terminal reference and reuse/dispose it.

### Dependencies & Conflicts
- **DuckDB Archive plan** (`feature_plan_20260327_103635_archive_database.md`): This panel's "Archive Storage" subsection and "Export Completed Plans" action directly depend on the archive feature being implemented first. If the archive plan isn't completed, these UI elements will be non-functional. Either gate the UI on archive availability or implement this plan after the archive plan.
- **Consolidate Session Files plan** (`feature_plan_20260327_084057_consolidate_session_files_into_db.md`): That plan restructures DB schema to use event sourcing. If completed first, `KanbanDatabase.forWorkspace()` API may change, breaking the `testDbConnection()` implementation here. Coordinate implementation order.
- **CLI-BAN Rename plan** (`feature_plan_20260326_140339_change_kanban_display_name.md`): Both plans modify `kanban.html`. Merge conflicts are guaranteed if implemented in parallel. The rename plan touches the header and controls strip; this plan adds a new section below. Sequence: rename first, then this plan.
- **Completed Column Icons plan** (`feature_plan_20260327_081419_replace_completed_column_icons.md`): Also modifies `kanban.html` in the column header area. Lower conflict risk since this plan adds a new section rather than modifying column headers, but merge conflicts in the HTML file are still likely.
- **Ticket View Title plan** (`feature_plan_20260327_084201_ticket_view_title_should_not_have_to_be_deleted.md`): Also modifies `kanban.html`. Similar low-but-present merge conflict risk.

### Original Edge Cases (Retained)
1. **No cloud folders found** — Show "Install Google Drive" or "Use custom path" options.
2. **DuckDB installed but wrong version** — Check minimum version requirement, prompt upgrade.
3. **Permission denied on cloud path** — macOS sandboxing may block access to `~/Library/CloudStorage`. Need to guide user to grant permissions.
4. **Workspace has no `.switchboard`** — Panel should still show; creating DB comes later on first plan creation.

## Adversarial Synthesis

### Grumpy Critique

This plan is a kitchen-sink disaster masquerading as a "panel." Let me count the scope explosions:

1. **Five features in a trench coat**: Cloud sync presets, CLI install helpers, terminal launch, DB reset, archive export — pick ONE. This is supposed to be a sidebar accordion, not a DevOps dashboard. Every one of these sub-features has its own error surface, platform quirks, and maintenance burden. The plan title says "Database Operations Panel" but the implementation is "half a settings page bolted onto the sidebar."

2. **The `confirm()` dialog is negligent**: `resetDatabase()` uses a browser `confirm()` — one mis-click and the user's entire plan metadata is gone. No undo, no backup, no typed confirmation. This is the laziest possible guard for a destructive operation. A real implementation would use `vscode.window.showWarningMessage({ modal: true })` at minimum, and ideally require the user to type "RESET" to confirm. The plan hand-waves this with "all plan metadata will be lost" in the dialog text as if that makes it safe.

3. **Cross-platform path detection is a minefield**: The `detectGoogleDrivePath()` function hard-codes macOS `~/Library/CloudStorage/GoogleDrive-*` with a glob-style wildcard that isn't actually globbed — it uses `readdirSync` + `startsWith`. What about Google Drive accounts with spaces, special characters, or multiple accounts? What about the Windows `G:\My Drive` mapped-drive variant? The fallback loop at line 646-649 returns the FIRST fallback unconditionally — it doesn't even check if the path exists. This "auto-detection" will confidently set wrong paths on half the machines it runs on.

4. **Five other plans also modify `kanban.html`**: The CLI-BAN rename plan, completed column icons plan, ticket view title plan — they all touch the same file. Implementing this plan in parallel with any of them guarantees merge conflicts. The plan doesn't acknowledge this at all. Who's sequencing these? Nobody, apparently.

5. **DuckDB doesn't even exist in the codebase**: The entire CLI Tools section and the "Open DuckDB Terminal" button depend on a DuckDB archive feature that hasn't been built yet. The archive plan (`feature_plan_20260327_103635_archive_database.md`) is a prerequisite, not a nice-to-have. Half the buttons in this panel will be dead on arrival.

6. **The `openCliTerminal` has a shell injection vector**: `terminal.sendText(\`duckdb "${expandedPath}"\`)` — if the expanded path contains double quotes or backticks, this becomes arbitrary command execution. The plan doesn't sanitize the path at all.

7. **No existing accordion pattern to follow**: The current `kanban.html` is a flat layout — header, controls strip, board. There is no sidebar, no accordion, no collapsible section pattern anywhere. This plan introduces a brand-new UI paradigm without acknowledging that it's establishing a pattern from scratch, not extending one. The CSS alone is 200+ lines for a "simple panel."

**Verdict**: Split this into three plans: (1) accordion infrastructure + DB path display/edit, (2) cloud presets with proper platform testing, (3) CLI tools (after DuckDB archive plan ships). Ship #1 first. The current plan will ship buggy, half-functional, and conflict with everything.

### Balanced Response

The Grumpy critique is substantially correct on scope and sequencing, but overstates the implementation risk for the core feature:

1. **Scope splitting is warranted** — but the HTML/CSS/JS is already written and cohesive. The pragmatic move is to **ship the full UI skeleton** (accordion + all sections) but **disable** the archive and CLI sections until their prerequisite plans land. This avoids re-touching the HTML three times. Add `disabled` states and "Coming soon — requires Archive feature" placeholders.

2. **The `confirm()` dialog must be upgraded** — this is a legitimate security concern. Replace with `vscode.window.showWarningMessage('Reset the kanban database? All plan metadata will be permanently deleted.', { modal: true }, 'Reset Database')` on the extension side. The webview `resetDatabase()` should just post the message; the extension handles the confirmation. This is the established pattern in the codebase (see `recoverAll`, which uses `vscode.window.showWarningMessage` for confirmation).

3. **Cross-platform detection needs hardening but isn't a blocker** — the `detectGoogleDrivePath` function should (a) actually check `fs.existsSync` on each fallback, (b) handle multiple Google accounts by showing a quick-pick list, and (c) have a Windows codepath. These are straightforward fixes, not architectural problems. The plan correctly identifies this in "Complex / Risky."

4. **Merge conflict risk is real but manageable** — the new section is appended after existing content, not interleaved with it. Git's three-way merge will handle most conflicts automatically. The CLI-BAN rename plan changes text content, not structure. Sequence recommendation: rename plan → icons plan → this plan → ticket title plan.

5. **Shell injection** — valid concern. Quote the path with single quotes and escape any embedded single quotes: `` terminal.sendText(`duckdb '${expandedPath.replace(/'/g, "'\\''")}'`) ``. Simple fix.

6. **Complexity rating should remain High** — the cross-platform detection, five cross-plan conflicts, and new UI paradigm introduction justify this. This is not a routine panel addition.

**Recommendation update**: The original "Send to Coder" recommendation is **premature**. The cross-platform path detection, cloud provider auto-detection, shell injection fix, and sequencing against 5 conflicting plans require senior-level review. **Recommend: Send to Senior Coder** with explicit instructions to (a) gate archive/CLI sections behind feature flags, (b) replace `confirm()` with modal dialog, (c) add Windows path detection, and (d) implement after the CLI-BAN rename and archive plans land.

### 1. Sidebar Accordion Section

#### [MODIFY] `src/webview/kanban.html` — Add Database & Sync accordion

Add after the existing agent grid or workflow section:

```html
<!-- Database & Sync Section -->
<div class="sidebar-section" id="db-sync-section">
    <div class="section-header" onclick="toggleSection('db-sync-content')">
        <span class="section-icon">💾</span>
        <span class="section-title">Database & Sync</span>
        <span class="toggle-icon" id="db-sync-toggle">▼</span>
    </div>
    <div class="section-content" id="db-sync-content">
        
        <!-- Cloud Location -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span class="subsection-icon">☁️</span>
                <span>Cloud Database Location</span>
                <span class="status-badge" id="cloud-status">default</span>
            </div>
            <div class="path-display" id="current-db-path">
                .switchboard/kanban.db
            </div>
            <div class="path-actions">
                <button onclick="editDbPath()" class="secondary-btn">Edit Path</button>
                <button onclick="testDbConnection()" class="secondary-btn">Test</button>
            </div>
            <div class="cloud-presets">
                <button onclick="setPresetPath('google-drive')" class="preset-btn">
                    <span class="preset-icon">📁</span>Google Drive
                </button>
                <button onclick="setPresetPath('dropbox')" class="preset-btn">
                    <span class="preset-icon">📦</span>Dropbox
                </button>
                <button onclick="setPresetPath('icloud')" class="preset-btn">
                    <span class="preset-icon">🍎</span>iCloud
                </button>
            </div>
        </div>

        <!-- Archive Location (for DuckDB archive feature) -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span class="subsection-icon">📚</span>
                <span>Archive Storage</span>
                <span class="status-badge" id="archive-status">not configured</span>
            </div>
            <div class="path-display" id="current-archive-path">
                Not configured — archives stored locally only
            </div>
            <div class="path-actions">
                <button onclick="editArchivePath()" class="secondary-btn">Set Archive Path</button>
            </div>
        </div>

        <!-- CLI Tools -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span class="subsection-icon">🛠️</span>
                <span>CLI Tools</span>
            </div>
            <div class="cli-tool-row">
                <span class="tool-name">DuckDB</span>
                <span class="tool-status" id="duckdb-status">
                    <span class="status-dot red"></span>Not installed
                </span>
                <button onclick="installDuckDB()" class="install-btn" id="duckdb-install-btn">
                    Install
                </button>
            </div>
            <div class="cli-actions">
                <button onclick="openDuckDBTerminal()" class="primary-btn" id="open-duckdb-btn" disabled>
                    Open DuckDB Terminal
                </button>
            </div>
        </div>

        <!-- Quick Actions -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span class="subsection-icon">⚡</span>
                <span>Quick Actions</span>
            </div>
            <div class="quick-actions-grid">
                <button onclick="exportToArchive()" class="action-btn">
                    <span class="action-icon">📤</span>
                    Export Completed Plans
                </button>
                <button onclick="viewDbStats()" class="action-btn">
                    <span class="action-icon">📊</span>
                    View Database Stats
                </button>
                <button onclick="resetDatabase()" class="action-btn danger">
                    <span class="action-icon">🗑️</span>
                    Reset Database
                </button>
            </div>
        </div>
        
    </div>
</div>
```

#### [CREATE] `src/webview/dbSyncPanel.css`

```css
/* Database & Sync Panel Styles */
#db-sync-section {
    border-top: 1px solid var(--vscode-panel-border);
    margin-top: 8px;
}

.db-subsection {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-input-border);
}

.db-subsection:last-child {
    border-bottom: none;
}

.subsection-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    margin-bottom: 8px;
}

.subsection-icon {
    font-size: 14px;
}

.status-badge {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
}

.status-badge.default {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
}

.status-badge.synced {
    background: #28a745;
    color: white;
}

.status-badge.error {
    background: #dc3545;
    color: white;
}

.status-badge.not-configured {
    background: var(--vscode-descriptionForeground);
    color: white;
}

.path-display {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
    padding: 8px;
    border-radius: 4px;
    word-break: break-all;
    margin-bottom: 8px;
}

.path-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
}

.cloud-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.preset-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border: 1px solid var(--vscode-button-secondaryBackground);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
}

.preset-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.preset-icon {
    font-size: 12px;
}

.cli-tool-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-input-border);
}

.cli-tool-row:last-child {
    border-bottom: none;
}

.tool-name {
    font-weight: 500;
    color: var(--vscode-foreground);
}

.tool-status {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.status-dot.green {
    background: #28a745;
}

.status-dot.red {
    background: #dc3545;
}

.status-dot.yellow {
    background: #ffc107;
}

.install-btn {
    padding: 4px 12px;
    font-size: 11px;
}

.cli-actions {
    margin-top: 12px;
}

.quick-actions-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}

.action-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px;
    border: 1px solid var(--vscode-button-secondaryBackground);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    text-align: center;
}

.action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.action-btn.danger {
    border-color: #dc3545;
    color: #dc3545;
}

.action-btn.danger:hover {
    background: rgba(220, 53, 69, 0.1);
}

.action-icon {
    font-size: 18px;
}

.secondary-btn {
    padding: 4px 12px;
    font-size: 11px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
}

.secondary-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.primary-btn {
    width: 100%;
    padding: 8px;
    font-size: 12px;
}

.primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
```

### 2. JavaScript Handlers

#### [MODIFY] `src/webview/kanban.html` — Add script handlers

```javascript
// Database & Sync Panel Functions

function toggleSection(sectionId) {
    const content = document.getElementById(sectionId);
    const toggle = document.getElementById(sectionId.replace('-content', '-toggle'));
    if (content.style.display === 'none') {
        content.style.display = 'block';
        toggle.textContent = '▼';
    } else {
        content.style.display = 'none';
        toggle.textContent = '▶';
    }
}

// Request current DB path from extension
function refreshDbPath() {
    vscode.postMessage({
        type: 'getDbPath'
    });
}

function editDbPath() {
    const currentPath = document.getElementById('current-db-path').textContent.trim();
    vscode.postMessage({
        type: 'editDbPath',
        currentPath: currentPath
    });
}

function testDbConnection() {
    vscode.postMessage({
        type: 'testDbConnection'
    });
}

function setPresetPath(preset) {
    vscode.postMessage({
        type: 'setPresetDbPath',
        preset: preset
    });
}

function editArchivePath() {
    vscode.postMessage({
        type: 'editArchivePath'
    });
}

function installDuckDB() {
    vscode.postMessage({
        type: 'installCliTool',
        tool: 'duckdb'
    });
}

function openDuckDBTerminal() {
    vscode.postMessage({
        type: 'openCliTerminal',
        tool: 'duckdb'
    });
}

function exportToArchive() {
    vscode.postMessage({
        type: 'exportToArchive'
    });
}

function viewDbStats() {
    vscode.postMessage({
        type: 'viewDbStats'
    });
}

function resetDatabase() {
    if (confirm('Reset the kanban database? All plan metadata will be lost.')) {
        vscode.postMessage({
            type: 'resetDatabase'
        });
    }
}

// Handle messages from extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'dbPathUpdated':
            document.getElementById('current-db-path').textContent = message.path;
            updateCloudStatus(message.path);
            break;
        case 'dbConnectionResult':
            showConnectionStatus(message.success, message.error);
            break;
        case 'cliStatus':
            updateCliStatus(message.tool, message.installed, message.version);
            break;
        case 'archivePathUpdated':
            document.getElementById('current-archive-path').textContent = message.path || 'Not configured';
            document.getElementById('archive-status').textContent = message.path ? 'configured' : 'not configured';
            document.getElementById('archive-status').className = 'status-badge ' + (message.path ? 'synced' : 'not-configured');
            break;
    }
});

function updateCloudStatus(path) {
    const statusBadge = document.getElementById('cloud-status');
    if (path.includes('Google Drive') || path.includes('Dropbox') || path.includes('iCloud')) {
        statusBadge.textContent = 'cloud synced';
        statusBadge.className = 'status-badge synced';
    } else if (path === '.switchboard/kanban.db' || path.includes('.switchboard')) {
        statusBadge.textContent = 'local';
        statusBadge.className = 'status-badge default';
    } else {
        statusBadge.textContent = 'custom';
        statusBadge.className = 'status-badge default';
    }
}

function showConnectionStatus(success, error) {
    const pathDisplay = document.getElementById('current-db-path');
    if (success) {
        pathDisplay.style.borderLeft = '3px solid #28a745';
        setTimeout(() => {
            pathDisplay.style.borderLeft = '';
        }, 2000);
    } else {
        pathDisplay.style.borderLeft = '3px solid #dc3545';
        pathDisplay.title = error || 'Connection failed';
    }
}

function updateCliStatus(tool, installed, version) {
    if (tool === 'duckdb') {
        const statusEl = document.getElementById('duckdb-status');
        const installBtn = document.getElementById('duckdb-install-btn');
        const openBtn = document.getElementById('open-duckdb-btn');
        
        if (installed) {
            statusEl.innerHTML = '<span class="status-dot green"></span>Installed' + (version ? ` (${version})` : '');
            installBtn.style.display = 'none';
            openBtn.disabled = false;
        } else {
            statusEl.innerHTML = '<span class="status-dot red"></span>Not installed';
            installBtn.style.display = 'block';
            openBtn.disabled = true;
        }
    }
}
```

### 3. Extension-side Message Handlers

#### [MODIFY] `src/services/KanbanProvider.ts` — Add message handlers

```typescript
// In the webview message handler switch statement
case 'getDbPath':
    this.sendDbPathToWebview();
    break;
    
case 'editDbPath':
    this.showDbPathInputBox(message.currentPath);
    break;
    
case 'testDbConnection':
    this.testDbConnection();
    break;
    
case 'setPresetDbPath':
    this.setPresetDbPath(message.preset);
    break;
    
case 'installCliTool':
    this.showCliInstallInstructions(message.tool);
    break;
    
case 'openCliTerminal':
    this.openCliTerminal(message.tool);
    break;

// Implementation methods
private async sendDbPathToWebview() {
    const config = vscode.workspace.getConfiguration('switchboard');
    const dbPath = config.get<string>('kanban.dbPath', '');
    const resolvedPath = dbPath || '.switchboard/kanban.db';
    
    this._panel.webview.postMessage({
        type: 'dbPathUpdated',
        path: resolvedPath
    });
}

private async showDbPathInputBox(currentPath: string) {
    const result = await vscode.window.showInputBox({
        prompt: 'Enter path for kanban database (supports ~ for home)',
        value: currentPath === '.switchboard/kanban.db' ? '' : currentPath,
        placeHolder: '~/Google Drive/Switchboard/kanban.db',
        validateInput: (value) => {
            if (!value.trim()) return null; // Empty = use default
            if (value.includes('\\') && process.platform !== 'win32') {
                return 'Use forward slashes for cross-platform compatibility';
            }
            return null;
        }
    });
    
    if (result !== undefined) {
        const config = vscode.workspace.getConfiguration('switchboard');
        await config.update('kanban.dbPath', result.trim(), vscode.ConfigurationTarget.Workspace);
        this.sendDbPathToWebview();
    }
}

private async setPresetDbPath(preset: string) {
    const homedir = require('os').homedir();
    let presetPath = '';
    
    switch (preset) {
        case 'google-drive':
            // Auto-detect Google Drive location
            presetPath = await this.detectGoogleDrivePath(homedir);
            break;
        case 'dropbox':
            presetPath = path.join(homedir, 'Dropbox', 'Switchboard', 'kanban.db');
            break;
        case 'icloud':
            presetPath = path.join(homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Switchboard', 'kanban.db');
            break;
    }
    
    if (presetPath) {
        const config = vscode.workspace.getConfiguration('switchboard');
        await config.update('kanban.dbPath', presetPath, vscode.ConfigurationTarget.Workspace);
        this.sendDbPathToWebview();
        
        vscode.window.showInformationMessage(
            `Database location set to ${preset}. The folder will be created when you first save a plan.`,
            'OK'
        );
    }
}

private async detectGoogleDrivePath(homedir: string): Promise<string> {
    // macOS Google Drive File Stream
    const macosGd = path.join(homedir, 'Library', 'CloudStorage', 'GoogleDrive-*', 'Switchboard', 'kanban.db');
    // Try to find actual Google Drive folder
    const fs = require('fs');
    const cloudStorage = path.join(homedir, 'Library', 'CloudStorage');
    if (fs.existsSync(cloudStorage)) {
        try {
            const entries = fs.readdirSync(cloudStorage);
            const gdEntry = entries.find(e => e.startsWith('GoogleDrive-'));
            if (gdEntry) {
                return path.join(cloudStorage, gdEntry, 'Switchboard', 'kanban.db');
            }
        } catch { }
    }
    
    // Fallback to common locations
    const fallbacks = [
        path.join(homedir, 'Google Drive', 'Switchboard', 'kanban.db'),
        path.join(homedir, 'My Drive', 'Switchboard', 'kanban.db'),
    ];
    
    for (const fb of fallbacks) {
        // Return first plausible path
        return fb;
    }
    
    return path.join(homedir, 'Google Drive', 'Switchboard', 'kanban.db');
}

private async testDbConnection() {
    try {
        const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
        await db.ensureReady();
        
        this._panel.webview.postMessage({
            type: 'dbConnectionResult',
            success: true
        });
        
        vscode.window.showInformationMessage('Database connection successful');
    } catch (error) {
        this._panel.webview.postMessage({
            type: 'dbConnectionResult',
            success: false,
            error: error.message
        });
        
        vscode.window.showErrorMessage(`Database connection failed: ${error.message}`);
    }
}

private async showCliInstallInstructions(tool: string) {
    if (tool === 'duckdb') {
        const platform = process.platform;
        let installCommand = '';
        let docsUrl = 'https://duckdb.org/docs/installation/';
        
        switch (platform) {
            case 'darwin':
                installCommand = 'brew install duckdb';
                break;
            case 'win32':
                installCommand = 'winget install DuckDB.cli';
                break;
            case 'linux':
                installCommand = 'wget https://github.com/duckdb/duckdb/releases/download/v1.1.3/duckdb_cli-linux-amd64.zip && unzip duckdb_cli-linux-amd64.zip';
                break;
        }
        
        const result = await vscode.window.showInformationMessage(
            `Install DuckDB CLI:\n\n${installCommand}`,
            { modal: true, detail: 'This command will be copied to your clipboard. Paste it in a terminal to install.' },
            'Copy Command',
            'Open Docs'
        );
        
        if (result === 'Copy Command') {
            await vscode.env.clipboard.writeText(installCommand);
            vscode.window.showInformationMessage('Install command copied to clipboard');
        } else if (result === 'Open Docs') {
            vscode.env.openExternal(vscode.Uri.parse(docsUrl));
        }
    }
}

private async openCliTerminal(tool: string) {
    if (tool === 'duckdb') {
        const config = vscode.workspace.getConfiguration('switchboard');
        const archivePath = config.get<string>('archive.dbPath', '');
        
        if (!archivePath) {
            vscode.window.showWarningMessage('Archive path not configured. Set it in Database & Sync panel first.');
            return;
        }
        
        const expandedPath = archivePath.replace(/^~/, require('os').homedir());
        const terminal = vscode.window.createTerminal('DuckDB Archive');
        terminal.sendText(`duckdb "${expandedPath}"`);
        terminal.show();
    }
}
```

### 4. Check CLI Status on Load

#### [MODIFY] `src/services/KanbanProvider.ts` — Add CLI detection

```typescript
// In the constructor or when panel loads
private async checkCliTools() {
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);
    
    // Check DuckDB
    try {
        const { stdout } = await execAsync('duckdb --version');
        const version = stdout.trim();
        this._panel?.webview.postMessage({
            type: 'cliStatus',
            tool: 'duckdb',
            installed: true,
            version: version
        });
    } catch {
        this._panel?.webview.postMessage({
            type: 'cliStatus',
            tool: 'duckdb',
            installed: false
        });
    }
}
```

## Verification Plan

### Manual Tests

1. **Panel visibility**: Open Switchboard sidebar → verify "Database & Sync" accordion is visible
2. **Path display**: Verify current path shows `.switchboard/kanban.db` or custom path
3. **Edit path**: Click "Edit Path" → enter `~/test/kanban.db` → verify setting updated in VS Code: settings
4. **Cloud preset**: Click "Google Drive" preset → verify path auto-detected/created
5. **Test connection**: Click "Test" → verify green border flash on success
6. **CLI detection**: If DuckDB not installed, verify "Not installed" badge shown
7. **Install helper**: Click "Install" → verify modal with OS-appropriate command
8. **Terminal open**: (After DuckDB installed) Click "Open DuckDB Terminal" → verify terminal opens with DuckDB loaded

### Edge Case Tests

1. **No cloud folders**: Remove Google Drive/Dropbox → verify presets still show but path may not exist
2. **Invalid path**: Enter `/nonexistent/path/db.db` → verify red border and error tooltip on Test
3. **Permission denied**: Set path to restricted folder → verify helpful error message

## Open Questions

1. **Default collapsed?** — Should the Database & Sync section be collapsed by default to save space?
2. **Auto-detect vs manual?** — Should we try to auto-detect cloud folders, or just show presets that users click?
3. **DuckDB required?** — Is DuckDB optional (archive queries) or essential? Should we nag users to install it?
4. **Other CLI tools?** — Should we include sqlite3 CLI detection? Any other tools?

## Recommendation

**Send to Senior Coder** — The original "Send to Coder" assessment underestimates this plan's complexity. The cross-platform cloud path auto-detection (macOS CloudStorage, Windows mapped drives, Linux XDG), shell injection risk in `openCliTerminal`, the `confirm()`-only guard on `resetDatabase()`, and five cross-plan conflicts against `kanban.html` all require senior-level attention. Implementation should be sequenced after the CLI-BAN rename plan and the DuckDB archive plan, with archive/CLI UI sections gated behind feature availability checks.

## Files Changed Summary

| File | Change |
|------|--------|
| `src/webview/kanban.html` | Add Database & Sync accordion section, JavaScript handlers |
| `src/webview/dbSyncPanel.css` | **NEW** — Panel-specific styles |
| `src/services/KanbanProvider.ts` | Add message handlers for DB path, CLI tools, terminal operations |

