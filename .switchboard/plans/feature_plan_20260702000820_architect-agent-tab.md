# Architect Agent Tab in project.html

## Goal

Add a new "Architect" tab to `project.html` that provides a guided, terminal-based architect agent to help users write PRDs, constitutions, CLAUDE.md/AGENTS.md governance files, and perform tuning — replacing the scattered individual "Send to Planner" / "Build via Planner" / "Copy Build Prompt" buttons that are peppered throughout the other tabs. The Architect tab is a guided tour of project.html's governance features, launching a terminal with an architect role that walks the user through each document.

### Problem Analysis & Root Cause

**Current state:** `project.html` has six tabs: Kanban Plans, Epics, Projects, Constitution, System, and Tuning. Each governance-related tab (Projects/PRD, Constitution, System, Tuning) has its own "Build via Planner" and "Copy Build Prompt" buttons that independently dispatch prompts to a planner terminal. The user must navigate to each tab individually, click separate buttons, and manage multiple terminal sessions. There is no unified flow that guides the user through setting up all governance documents in sequence.

**The gap:** The user wants a single entry point — an "Architect" tab — that opens a terminal with an architect role. This architect agent acts as a guided tour: it knows about all the governance documents (PRD, constitution, CLAUDE.md, AGENTS.md, tuning insights) and helps the user write/refine them in a coherent, sequenced workflow rather than through isolated button clicks.

**Root cause:** This is a missing feature, not a bug. The governance features exist but are fragmented across tabs with no unifying orchestration layer. The "Build via Planner" pattern (dispatching a prompt to a terminal via `sendRobustText`) exists and works, but there's no "architect" role that orchestrates across all governance documents.

## Metadata
- **Tags:** frontend, feature, ui, architect, governance
- **Complexity:** 7

## Complexity Audit

### Routine
- Adding a tab button and content container to `project.html` (follows existing pattern: `<button class="shared-tab-btn" data-tab="architect">`)
- Tab switching logic in `project.js` (add `architect` to the `tabs.forEach` handler, add `applySidebarState` call)
- State management for sidebar collapse (`architectListCollapsed`)
- CSS styling using existing variables

### Complex / Risky
- **Architect terminal orchestration** — Unlike the existing "Build via Planner" buttons that dispatch a single prompt, the architect needs to guide the user through multiple documents sequentially. The terminal needs to receive an initial architect prompt that explains the full workflow, then the user interacts with the agent in-terminal to navigate between documents.
- **Architect prompt design** — The prompt must reference all governance document paths (PRD, constitution, CLAUDE.md, AGENTS.md, insights) and provide a menu/flow for the user to choose what to work on. It should leverage existing skill files (`constitution_builder.md`, `tuning.md`) as references.
- **Sidebar content for architect tab** — The sidebar should show the available governance documents as a list (PRD, Constitution, System files, Insights) so the user can see what exists and what needs attention. This requires a new render function and IPC handler to fetch the document status.
- **Terminal role dispatch** — Need to use `dispatchCustomPromptToRole` or create a new 'architect' role. The existing pattern dispatches to 'planner'; we need to either add 'architect' as a dispatchable role or use the planner role with a specialized prompt.

## Edge-Case & Dependency Audit

- **No governance documents exist yet:** The architect should detect which documents are missing and prioritize creating them.
- **Some documents already exist:** The architect should read existing content and offer to refine rather than create from scratch.
- **Multiple workspaces:** The architect tab needs a workspace filter (like other tabs) to know which workspace to operate in.
- **Terminal already open:** If an architect terminal is already open, clicking "Open Architect" should focus it rather than create a new one.
- **Dependencies:** `terminalUtils.ts` (terminal text sending), `PlanningPanelProvider.ts` (IPC handlers), `constitutionUtils.ts` (path resolution), `prdUtils.ts` (PRD path resolution), `agentPromptBuilder.ts` (if creating a new architect role).

## Proposed Changes

### 1. Add Architect tab button to project.html

**File:** `src/webview/project.html` (tab bar section, ~line 1420)

Add after the TUNING tab button:
```html
<button class="shared-tab-btn" data-tab="architect">ARCHITECT</button>
```

### 2. Add Architect tab content container to project.html

**File:** `src/webview/project.html` (after the tuning tab content div, ~line 1650)

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

### 3. Add tab switching logic to project.js

**File:** `src/webview/project.js` (tab switching handler, ~line 30)

Add to the `tabs.forEach` click handler:
```javascript
} else if (targetTab === 'architect') {
    applySidebarState('architect', state.architectListCollapsed);
    vscode.postMessage({ type: 'loadArchitectDocStatus' });
}
```

Add to state initialization (~line 65):
```javascript
architectListCollapsed: false,
```

Add to persisted state restoration (~line 76):
```javascript
state.architectListCollapsed = persistedState.architectListCollapsed || false;
```

Add to sidebar toggle handler (~line 119):
```javascript
} else if (activeTab === 'architect') {
    state.architectListCollapsed = !state.architectListCollapsed;
    applySidebarState('architect', state.architectListCollapsed);
}
```

Add to state persistence (~line 135):
```javascript
architectListCollapsed: state.architectListCollapsed
```

### 4. Add element references and render function to project.js

**File:** `src/webview/project.js` (~line 348, alongside other element references)

```javascript
const architectWorkspaceFilter = document.getElementById('architect-workspace-filter');
const btnOpenArchitect = document.getElementById('btn-open-architect');
const btnCopyArchitectPrompt = document.getElementById('btn-copy-architect-prompt');
const architectDocList = document.getElementById('architect-doc-list');
const architectPreviewContent = document.getElementById('architect-preview-content');
```

Add render function (modeled on `renderConstitutionDocList`, ~line 2410):
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
                vscode.postMessage({ type: 'readArchitectDoc', docType: doc.type, path: doc.path, workspaceRoot: currentWorkspaceRoot });
            }
        });
        architectDocList.appendChild(item);
    });
}
```

### 5. Add IPC message handlers to project.js

**File:** `src/webview/project.js` (message handler section, ~line 800-1100)

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
    // Show toast notification
    break;
```

### 6. Add button event listeners to project.js

**File:** `src/webview/project.js` (~line 2540, alongside other button listeners)

```javascript
if (btnOpenArchitect) {
    btnOpenArchitect.addEventListener('click', () => {
        const wsRoot = getCurrentWorkspaceRoot();
        vscode.postMessage({ type: 'openArchitectTerminal', workspaceRoot: wsRoot });
    });
}

if (btnCopyArchitectPrompt) {
    btnCopyArchitectPrompt.addEventListener('click', () => {
        const wsRoot = getCurrentWorkspaceRoot();
        vscode.postMessage({ type: 'copyArchitectPrompt', workspaceRoot: wsRoot });
    });
}
```

### 7. Add IPC handlers to PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts` (near line 3944, alongside `invokeConstitutionBuilder`)

```typescript
case 'openArchitectTerminal': {
    const wsRoot = msg.workspaceRoot;
    const promptText = this.buildArchitectPrompt(wsRoot);
    
    // Try dispatching via the planner role
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
    const promptText = this.buildArchitectPrompt(wsRoot);
    await vscode.env.clipboard.writeText(promptText);
    this._projectWebview?.postMessage({ type: 'architectPromptCopied' });
    break;
}

case 'loadArchitectDocStatus': {
    const wsRoot = msg.workspaceRoot;
    const docs = await this.gatherArchitectDocStatus(wsRoot);
    this._projectWebview?.postMessage({ type: 'architectDocStatus', docs });
    break;
}

case 'readArchitectDoc': {
    const docPath = msg.path;
    const docType = msg.docType;
    try {
        const content = await fs.promises.readFile(docPath, 'utf8');
        const renderedHtml = await this._renderMarkdown(content);
        this._projectWebview?.postMessage({ type: 'architectDocContent', renderedHtml, docType });
    } catch (e) {
        this._projectWebview?.postMessage({ type: 'architectDocContent', renderedHtml: '<p>Unable to read file.</p>', docType });
    }
    break;
}
```

### 8. Add architect prompt builder to PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts` (new private method)

```typescript
private buildArchitectPrompt(wsRoot: string): string {
    return `You are the **Switchboard Architect** — a guided tour for project governance setup.

Your job is to help the user write and refine the following governance documents for this project at ${wsRoot}:

1. **PRD** (Product Requirements Document) — located at \`.switchboard/projects/<slug>/prd.md\`
2. **Constitution** (coding standards) — located at \`CONSTITUTION.md\`
3. **System Files** — \`CLAUDE.md\` and \`AGENTS.md\`
4. **Tuning Insights** — \`.switchboard/insights/*.md\`

## Workflow

1. First, check which documents already exist by reading the files.
2. Present a menu to the user: which document would they like to create or refine?
3. For each document, follow the corresponding skill:
   - PRD: Follow instructions in \`.agents/skills/constitution_builder.md\` (PRD section)
   - Constitution: Follow instructions in \`.agents/skills/constitution_builder.md\`
   - System Files: Follow instructions in \`.agents/skills/constitution_builder.md\` (governance section)
   - Tuning: Follow instructions in \`.agents/skills/tuning.md\`
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
    const docs = [];
    const constitutionPath = path.join(wsRoot, 'CONSTITUTION.md');
    const claudePath = path.join(wsRoot, 'CLAUDE.md');
    const agentsPath = path.join(wsRoot, 'AGENTS.md');
    const insightsDir = path.join(wsRoot, '.switchboard', 'insights');
    
    // PRD (check for any project PRDs)
    const projectsDir = path.join(wsRoot, '.switchboard', 'projects');
    // ... gather PRD paths
    
    docs.push({ type: 'prd', name: 'PRD', exists: await fileExists(/* prd path */), path: '' });
    docs.push({ type: 'constitution', name: 'Constitution', exists: await fileExists(constitutionPath), path: constitutionPath });
    docs.push({ type: 'system', name: 'System (CLAUDE.md)', exists: await fileExists(claudePath), path: claudePath });
    docs.push({ type: 'agents', name: 'System (AGENTS.md)', exists: await fileExists(agentsPath), path: agentsPath });
    docs.push({ type: 'tuning', name: 'Tuning Insights', exists: await fileExists(insightsDir), path: insightsDir });
    
    return docs;
}
```

### 9. Add CSS for architect sidebar (narrower width)

**File:** `src/webview/project.html` (sidebar width section, ~line 203)

The architect sidebar should use the narrower width (see the sidebar width plan). Add `#architect-list-pane` to the narrower sidebar group.

## Verification Plan

1. **Tab appears:** Open project.html → verify "ARCHITECT" tab button appears in the tab bar.
2. **Tab switching:** Click the ARCHITECT tab → verify the architect content panel is shown and other panels are hidden.
3. **Sidebar renders:** When the architect tab opens, verify the sidebar shows a list of governance documents with existence indicators (✓ for exists, ○ for missing).
4. **Open Architect Terminal:** Click "Open Architect Terminal" → verify a terminal opens with the architect prompt that checks for existing documents and presents a menu.
5. **Copy Architect Prompt:** Click "Copy Architect Prompt" → verify the architect prompt is copied to clipboard.
6. **Document preview:** Click a document in the sidebar that exists → verify its rendered content appears in the preview pane with proper theming.
7. **Sidebar collapse:** Click the sidebar toggle → verify the sidebar collapses and expands correctly, and the state persists across tab switches.
8. **Guided workflow:** In the terminal, follow the architect's guided flow → verify it can create/refine PRD, constitution, CLAUDE.md, and tuning insights in sequence.
9. **Existing terminal reuse:** Click "Open Architect Terminal" when an architect terminal is already open → verify it focuses the existing terminal rather than creating a duplicate.
