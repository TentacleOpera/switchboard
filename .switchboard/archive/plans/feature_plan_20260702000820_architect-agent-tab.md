# Architect Agent Tab in project.html

**Plan ID:** a7c1f2e0-3b4d-4e5a-9f6c-7d8e9f0a1b2c

## Goal

Add a new "Architect" tab to `project.html` that provides a guided, terminal-based architect agent to help users write PRDs, constitutions, CLAUDE.md/AGENTS.md governance files, and perform tuning — replacing the scattered individual "Send to Planner" / "Build via Planner" / "Copy Build Prompt" buttons that are peppered throughout the other tabs. The Architect tab is a guided tour of project.html's governance features, launching a terminal with an architect role that walks the user through each document.

### Problem Analysis & Root Cause

**Current state:** `project.html` has six tabs: Kanban Plans, Epics, Projects, Constitution, System, and Tuning. Each governance-related tab (Projects/PRD, Constitution, System, Tuning) has its own "Build via Planner" and "Copy Build Prompt" buttons that independently dispatch prompts to a planner terminal. The user must navigate to each tab individually, click separate buttons, and manage multiple terminal sessions. There is no unified flow that guides the user through setting up all governance documents in sequence.

**The gap:** The user wants a single entry point — an "Architect" tab — that opens a terminal with an architect role. This architect agent acts as a guided tour: it knows about all the governance documents (PRD, constitution, CLAUDE.md, AGENTS.md, tuning insights) and helps the user write/refine them in a coherent, sequenced workflow rather than through isolated button clicks.

**Root cause:** This is a missing feature, not a bug. The governance features exist but are fragmented across tabs with no unifying orchestration layer. The "Build via Planner" pattern (dispatching a prompt to a terminal via `sendRobustText`) exists and works, but there's no "architect" role that orchestrates across all governance documents.

## Metadata
- **Tags:** frontend, feature, ui
- **Complexity:** 7

## User Review Required

Yes — the architect prompt content (which documents to cover, the guided flow menu, and whether to dispatch to the 'planner' role or create a new 'architect' role) should be reviewed by the user before implementation. The terminal dispatch strategy (reuse planner role with a specialized prompt vs. register a new 'architect' role) is a design decision that affects agent rotation behavior.

## Complexity Audit

### Routine
- Adding a tab button and content container to `project.html` (follows existing pattern: `<button class="shared-tab-btn" data-tab="architect">`)
- Tab switching logic in `project.js` (add `architect` to the `tabs.forEach` handler, add `applySidebarState` call)
- State management for sidebar collapse (`architectListCollapsed`)
- CSS styling using existing variables

### Complex / Risky
- **Architect terminal orchestration** — Unlike the existing "Build via Planner" buttons that dispatch a single prompt, the architect needs to guide the user through multiple documents sequentially. The terminal needs to receive an initial architect prompt that explains the full workflow, then the user interacts with the agent in-terminal to navigate between documents.
- **Architect prompt design** — The prompt must reference all governance document paths (PRD, constitution, CLAUDE.md, AGENTS.md, insights) and provide a menu/flow for the user to choose what to work on. It should leverage existing skill files (`constitution_builder.md`, `tuning.md`) as references. NOTE: `constitution_builder.md` covers constitutions only — it has no PRD section. The PRD format must be inlined in the architect prompt (matching the format from `invokePrdBuilder` at PlanningPanelProvider.ts:3834).
- **Sidebar content for architect tab** — The sidebar should show the available governance documents as a list (PRD, Constitution, System files, Insights) so the user can see what exists and what needs attention. This requires a new render function and IPC handler to fetch the document status.
- **Terminal role dispatch** — Need to use `dispatchCustomPromptToRole` with the 'planner' role (the existing pattern). There is no 'architect' role registered in the system; the architect prompt is dispatched to the planner terminal. The `dispatchCustomPromptToRole` method (TaskViewerProvider.ts:2866) accepts `(role: string, prompt: string, workspaceRoot: string)` and returns `Promise<boolean>`.
- **PRD enumeration in `gatherArchitectDocStatus`** — The backend needs to enumerate all project PRDs. The `getProjectPrdPath(wsRoot, projectName)` function (from `./prdUtils`, imported at PlanningPanelProvider.ts:34) resolves a single project's PRD path. To enumerate all projects, read `.switchboard/projects/` directory entries via `fs.readdirSync` and check each for a `prd.md` file.

## Edge-Case & Dependency Audit

- **No governance documents exist yet:** The architect should detect which documents are missing and prioritize creating them.
- **Some documents already exist:** The architect should read existing content and offer to refine rather than create from scratch.
- **Multiple workspaces:** The architect tab needs a workspace filter (like other tabs) to know which workspace to operate in. Use `architectWorkspaceFilter.value` (the tab's own filter dropdown).
- **Terminal already open:** If an architect terminal is already open, clicking "Open Architect" should focus it rather than create a new one. The fallback terminal creation checks `vscode.window.terminals.find(t => t.name.toLowerCase().includes('architect') || t.name.toLowerCase().includes('planner'))`.
- **Security — `allRoots` guard:** Every new IPC handler MUST guard with `if (!allRoots.includes(wsRoot)) { break; }` to prevent file reads outside workspace roots. This matches the pattern in all existing handlers (e.g. `invokeConstitutionBuilder` at line 3986, `readConstitutionFile` at line 3641).
- **Dependencies:** `terminalUtils.ts` (`sendRobustText` at line 118, signature: `(terminal, text, paced?, log?, options?) => Promise<void>`), `PlanningPanelProvider.ts` (IPC handlers, `_projectPanel` field at line 72), `prdUtils.ts` (`getProjectPrdPath`), `TaskViewerProvider.ts` (`dispatchCustomPromptToRole` at line 2866).

## Dependencies

- None — this is a self-contained feature with no cross-plan dependencies.

## Adversarial Synthesis

Key risks: (1) four non-existent API references in the original draft (`_projectWebview`, `_renderMarkdown`, `fileExists`, `getCurrentWorkspaceRoot`) that would fail to compile or throw at runtime — all replaced with verified equivalents (`_projectPanel?.webview.postMessage()`, `vscode.commands.executeCommand<string>('markdown.api.render', content)`, `fs.existsSync()`, `architectWorkspaceFilter.value`); (2) incorrect line reference (3944 vs actual 3986 for `invokeConstitutionBuilder`) — corrected; (3) missing `allRoots` security guard — added to all new handlers; (4) architect prompt referenced a non-existent PRD section in `constitution_builder.md` — PRD format now inlined. Mitigations: all API references verified against source code, line numbers corrected, security guards added, PRD format inlined from the proven `invokePrdBuilder` prompt.

## Proposed Changes

### 1. Add Architect tab button to project.html

**File:** `src/webview/project.html` (tab bar section, line 1473 — after the TUNING tab button)

Add after the TUNING tab button:
```html
<button class="shared-tab-btn" data-tab="architect">ARCHITECT</button>
```

### 2. Add Architect tab content container to project.html

**File:** `src/webview/project.html` (after the tuning tab content div, ~line 1695 — after `</div>` closing `#tuning-content`)

```html
<div id="architect-content" class="shared-tab-content">
    <div class="controls-strip">
        <select id="architect-workspace-filter">
            <option value="">All Workspaces</option>
        </select>
        <button id="btn-open-architect" class="strip-btn">Open Architect Terminal</button>
        <button id="btn-copy-architect-prompt" class="strip-btn">Copy Architect Prompt</button>
    </div>
    <div class="content-row">
        <div id="architect-list-pane">
            <div class="sidebar-toggle-row">
                <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
            </div>
            <div id="architect-doc-list">
                <div class="empty-state">Loading governance documents...</div>
            </div>
        </div>
        <div class="preview-panel-wrapper">
            <div class="cyber-scanlines"></div>
            <div id="architect-preview-pane" class="constitution-preview-pane">
                <div id="architect-preview-content">
                    <div class="empty-state">
                        <h2>Architect Mode</h2>
                        <p>The Architect agent guides you through writing and refining your project's governance documents:</p>
                        <ul>
                            <li><strong>PRD</strong> — Product Requirements Document</li>
                            <li><strong>Constitution</strong> — Coding standards and conventions</li>
                            <li><strong>System Files</strong> — CLAUDE.md and AGENTS.md</li>
                            <li><strong>Tuning</strong> — Extracted insights and governance updates</li>
                        </ul>
                        <p>Click "Open Architect Terminal" to start a guided session, or select a document from the sidebar to preview it.</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>
```

### 3. Add CSS for architect sidebar (narrower width)

**File:** `src/webview/project.html` (line 212 — the narrower sidebar selector group)

Add `#architect-list-pane` to the existing narrower-width selector group:
```css
/* BEFORE (line 212) */
#constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane {

/* AFTER */
#constitution-list-pane, #system-list-pane, #tuning-list-pane, #projects-list-pane, #architect-list-pane {
```

### 4. Add tab switching logic to project.js

**File:** `src/webview/project.js` (tab switching handler, ~line 31 — after the `projects` branch in the `tabs.forEach` click handler)

Add to the `tabs.forEach` click handler:
```javascript
} else if (targetTab === 'architect') {
    applySidebarState('architect', state.architectListCollapsed);
    vscode.postMessage({ type: 'loadArchitectDocStatus', workspaceRoot: architectWorkspaceFilter ? architectWorkspaceFilter.value : '' });
}
```

Add to state initialization (~line 66, after `projectsListCollapsed: false,`):
```javascript
architectListCollapsed: false,
```

Add to persisted state restoration (~line 77, after `state.projectsListCollapsed = ...`):
```javascript
state.architectListCollapsed = persistedState.architectListCollapsed || false;
```

Add to sidebar toggle handler (~line 122, after the `projects` branch):
```javascript
} else if (activeTab === 'architect') {
    state.architectListCollapsed = !state.architectListCollapsed;
    applySidebarState('architect', state.architectListCollapsed);
}
```

Add to state persistence (~line 136, after `projectsListCollapsed: state.projectsListCollapsed`):
```javascript
architectListCollapsed: state.architectListCollapsed
```

### 5. Add element references and render function to project.js

**File:** `src/webview/project.js` (~line 357, after the tuning tab element references)

```javascript
// Architect tab elements
const architectWorkspaceFilter = document.getElementById('architect-workspace-filter');
const btnOpenArchitect = document.getElementById('btn-open-architect');
const btnCopyArchitectPrompt = document.getElementById('btn-copy-architect-prompt');
const architectDocList = document.getElementById('architect-doc-list');
const architectPreviewContent = document.getElementById('architect-preview-content');
```

Add render function (modeled on `renderConstitutionDocList`):
```javascript
function renderArchitectDocList(docs) {
    // docs: [{ type: 'prd', name: 'PRD', exists: true, path: '...' }, ...]
    if (!architectDocList) return;
    architectDocList.innerHTML = '';
    docs.forEach(doc => {
        const item = document.createElement('div');
        item.className = 'doc-list-item' + (doc.exists ? '' : ' missing');
        item.dataset.docType = doc.type;
        item.dataset.docPath = doc.path;
        item.innerHTML = `
            <span class="doc-status">${doc.exists ? '✓' : '○'}</span>
            <span class="doc-name">${doc.name}</span>
            <span class="doc-hint">${doc.exists ? 'Click to preview' : 'Not created'}</span>
        `;
        item.addEventListener('click', () => {
            if (doc.exists) {
                vscode.postMessage({ type: 'readArchitectDoc', docType: doc.type, path: doc.path, workspaceRoot: architectWorkspaceFilter ? architectWorkspaceFilter.value : '' });
            }
        });
        architectDocList.appendChild(item);
    });
}
```

### 6. Add IPC message handlers to project.js

**File:** `src/webview/project.js` (message handler section, alongside other `case` blocks)

```javascript
case 'architectDocStatus':
    renderArchitectDocList(msg.docs);
    break;

case 'architectDocContent':
    if (architectPreviewContent) {
        architectPreviewContent.innerHTML = msg.renderedHtml || '';
    }
    break;

case 'architectPromptCopied':
    showToast('Architect prompt copied to clipboard', 'success');
    break;
```

### 7. Add button event listeners to project.js

**File:** `src/webview/project.js` (alongside other button listeners, ~line 1849 after the autofetch listeners)

```javascript
if (btnOpenArchitect) {
    btnOpenArchitect.addEventListener('click', () => {
        const wsRoot = architectWorkspaceFilter ? architectWorkspaceFilter.value : '';
        vscode.postMessage({ type: 'openArchitectTerminal', workspaceRoot: wsRoot });
    });
}

if (btnCopyArchitectPrompt) {
    btnCopyArchitectPrompt.addEventListener('click', () => {
        const wsRoot = architectWorkspaceFilter ? architectWorkspaceFilter.value : '';
        vscode.postMessage({ type: 'copyArchitectPrompt', workspaceRoot: wsRoot });
    });
}
```

### 8. Add IPC handlers to PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts` (near line 3986, alongside `invokeConstitutionBuilder`)

**CRITICAL:** Use `this._projectPanel?.webview.postMessage(...)` — NOT `this._projectWebview?.postMessage(...)` (the `_projectWebview` field does not exist; the field is `_projectPanel` at line 72). Use `vscode.commands.executeCommand<string>('markdown.api.render', content)` for rendering — NOT `this._renderMarkdown()` (no such method exists). Use `fs.existsSync()` — NOT `fileExists()` (no such helper exists).

```typescript
case 'openArchitectTerminal': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) {
        break;
    }
    const promptText = this.buildArchitectPrompt(wsRoot);
    
    // Try dispatching via the planner role (gets rotation for free).
    // Fall back to ad-hoc terminal creation if no planner agent is registered.
    if (this._taskViewerProvider) {
        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', promptText, wsRoot);
        if (dispatched) { break; }
    }
    
    // Fall back to ad-hoc terminal creation
    const terminal = vscode.window.terminals.find(t => 
            t.name.toLowerCase().includes('architect') || t.name.toLowerCase().includes('planner'))
        || vscode.window.createTerminal({ name: 'Switchboard Architect', cwd: wsRoot });
    terminal.show();
    const { sendRobustText } = require('./terminalUtils');
    await sendRobustText(terminal, promptText);
    break;
}

case 'copyArchitectPrompt': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) {
        break;
    }
    const promptText = this.buildArchitectPrompt(wsRoot);
    await vscode.env.clipboard.writeText(promptText);
    this._projectPanel?.webview.postMessage({ type: 'architectPromptCopied' });
    break;
}

case 'loadArchitectDocStatus': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) {
        break;
    }
    const docs = await this.gatherArchitectDocStatus(wsRoot);
    this._projectPanel?.webview.postMessage({ type: 'architectDocStatus', docs });
    break;
}

case 'readArchitectDoc': {
    const wsRoot = msg.workspaceRoot;
    const docPath = msg.path;
    const docType = msg.docType;
    if (!allRoots.includes(wsRoot)) {
        break;
    }
    try {
        const content = fs.readFileSync(docPath, 'utf8');
        const renderedHtml = await vscode.commands.executeCommand<string>('markdown.api.render', content);
        this._projectPanel?.webview.postMessage({ type: 'architectDocContent', renderedHtml, docType });
    } catch (e) {
        this._projectPanel?.webview.postMessage({ type: 'architectDocContent', renderedHtml: '<p>Unable to read file.</p>', docType });
    }
    break;
}
```

### 9. Add architect prompt builder to PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts` (new private method)

**NOTE:** `constitution_builder.md` covers constitutions only — it has NO PRD section. The PRD format is inlined below, matching the format from `invokePrdBuilder` (line 3834). The `tuning.md` skill file exists at `.agents/skills/tuning.md` and covers tuning.

```typescript
private buildArchitectPrompt(wsRoot: string): string {
    return `You are the **Switchboard Architect** — a guided tour for project governance setup.

Your job is to help the user write and refine the following governance documents for this project at ${wsRoot}:

1. **PRD** (Product Requirements Document) — located at \`.switchboard/projects/<slug>/prd.md\`
   Format:
   # [Project Name] — PRD
   > **Vision:** [one sentence]
   ## Target Users
   [Who they are and their main pain point]
   ## Key Features
   - **[Name]:** [one sentence]
   ## Success Criteria
   - [measurable outcome]
   ## Non-Goals
   - [explicit exclusion]
   ## Open Questions
   - [unresolved decision or risk]

2. **Constitution** (coding standards) — located at \`CONSTITUTION.md\`
   Follow instructions in \`.agents/skills/constitution_builder.md\`.

3. **System Files** — \`CLAUDE.md\` and \`AGENTS.md\`
   These are agent governance files. Help the user write rules that agents should follow when working in this repo.

4. **Tuning Insights** — \`.switchboard/insights/*.md\`
   Follow instructions in \`.agents/skills/tuning.md\`.

## Workflow

1. First, check which documents already exist by reading the files.
2. Present a menu to the user: which document would they like to create or refine?
3. For each document, follow the corresponding skill or format above.
4. After completing one document, offer to move to the next.
5. Ensure consistency across all documents (e.g. constitution rules should align with CLAUDE.md).

## Rules
- Do NOT make git commits. Focus on writing/refining file content.
- Always show the user what you're about to write before writing it.
- Ask clarifying questions when requirements are ambiguous.
- Keep documents concise and actionable.

Start by checking which documents exist, then present the menu.`;
}

private async gatherArchitectDocStatus(wsRoot: string): Promise<Array<{type: string, name: string, exists: boolean, path: string}>> {
    const docs: Array<{type: string, name: string, exists: boolean, path: string}> = [];
    const constitutionPath = path.join(wsRoot, 'CONSTITUTION.md');
    const claudePath = path.join(wsRoot, 'CLAUDE.md');
    const agentsPath = path.join(wsRoot, 'AGENTS.md');
    const insightsDir = path.join(wsRoot, '.switchboard', 'insights');
    
    // PRD — enumerate all project PRDs in .switchboard/projects/
    const projectsDir = path.join(wsRoot, '.switchboard', 'projects');
    let prdExists = false;
    let prdPath = '';
    try {
        if (fs.existsSync(projectsDir)) {
            const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const candidatePrd = path.join(projectsDir, entry.name, 'prd.md');
                    if (fs.existsSync(candidatePrd)) {
                        prdExists = true;
                        prdPath = candidatePrd;
                        break; // show first found; architect will enumerate all in-terminal
                    }
                }
            }
        }
    } catch { /* directory read failed — treat as no PRD */ }
    docs.push({ type: 'prd', name: 'PRD', exists: prdExists, path: prdPath });
    
    docs.push({ type: 'constitution', name: 'Constitution', exists: fs.existsSync(constitutionPath), path: constitutionPath });
    docs.push({ type: 'system', name: 'System (CLAUDE.md)', exists: fs.existsSync(claudePath), path: claudePath });
    docs.push({ type: 'agents', name: 'System (AGENTS.md)', exists: fs.existsSync(agentsPath), path: agentsPath });
    docs.push({ type: 'tuning', name: 'Tuning Insights', exists: fs.existsSync(insightsDir), path: insightsDir });
    
    return docs;
}
```

## Verification Plan

### Automated Tests
- No automated tests required (per session directives — test suite run separately by user).

### Manual Verification
1. **Tab appears:** Open project.html → verify "ARCHITECT" tab button appears in the tab bar after "TUNING".
2. **Tab switching:** Click the ARCHITECT tab → verify the architect content panel is shown and other panels are hidden.
3. **Sidebar renders:** When the architect tab opens, verify the sidebar shows a list of governance documents with existence indicators (✓ for exists, ○ for missing).
4. **Sidebar width:** Verify the architect sidebar uses the narrower width (240px) matching Constitution/System/Tuning/Projects panes, not the wider Kanban/Epics width (320px).
5. **Open Architect Terminal:** Click "Open Architect Terminal" → verify a terminal opens with the architect prompt that checks for existing documents and presents a menu.
6. **Copy Architect Prompt:** Click "Copy Architect Prompt" → verify the architect prompt is copied to clipboard and a toast notification appears.
7. **Document preview:** Click a document in the sidebar that exists → verify its rendered content appears in the preview pane with proper theming.
8. **Sidebar collapse:** Click the sidebar toggle → verify the sidebar collapses and expands correctly, and the state persists across tab switches.
9. **Guided workflow:** In the terminal, follow the architect's guided flow → verify it can create/refine PRD, constitution, CLAUDE.md, and tuning insights in sequence.
10. **Existing terminal reuse:** Click "Open Architect Terminal" when an architect terminal is already open → verify it focuses the existing terminal rather than creating a duplicate.
11. **Security guard:** Verify that IPC handlers reject messages with `workspaceRoot` values not in `allRoots` (no file reads outside workspace roots).

## Recommendation

Complexity 7 → **Send to Lead Coder**. Multi-file coordination (project.html, project.js, PlanningPanelProvider.ts), new IPC handlers, terminal orchestration, and security-sensitive file read paths require experienced implementation.

## Review Findings

Reviewed implementation against plan requirements across `src/webview/project.html`, `src/webview/project.js`, and `src/services/PlanningPanelProvider.ts`. All plan requirements (tab button, content container, CSS, tab switching, state, sidebar toggle, element refs, message handlers, workspace filter population, button listeners, renderArchitectDocList, buildArchitectPrompt, gatherArchitectDocStatus, 4 IPC handlers) were correctly implemented. Two CRITICAL bugs found and fixed: (1) the architect workspace filter `<select>` had no `change` event listener, so switching workspaces never reloaded the doc list — added listener at `project.js:2173`; (2) all 4 IPC handlers used `msg.workspaceRoot` directly with an `allRoots.includes()` guard, which silently rejected the empty-string "All Workspaces" value — switched to `this._resolveWorkspaceRoot(msg.workspaceRoot)` (matching the `copyChatPrompt` pattern at line 3307) so empty string falls back to the active/first workspace root. Typecheck passes (no new errors in modified files; pre-existing TS2835 import-extension errors are unrelated). Remaining risk: `readArchitectDoc` reads `docPath` from the message without verifying it falls within `wsRoot` — the `allRoots` guard validates the workspace but not the file path; a crafted message could read arbitrary files. This matches the existing `readConstitutionFile` pattern (which also trusts `docPath`), so it is a pre-existing pattern, not a new regression.
