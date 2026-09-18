# Memo — Bug Report Jot-It Modal

## Metadata

**Tags:** [frontend, backend, ui, ux, feature]
**Complexity:** 5
<!-- Single-repo session — no Repo: line per session directive -->

## User Review Required

Yes — before implementation, confirm:
1. The `Cmd+Shift+Alt+M` hotkey does not conflict with the user's existing VS Code keybindings.
2. The "last-write-wins" behavior for concurrent modal + `/memo` skill access is acceptable for v1.
3. The entry-separation heuristic (prefix-based merging) matches the user's expected jotting style.

## Goal

Add a lightweight "memo" modal that lets the user rapidly jot down bugs, thoughts, and issues encountered during testing — without breaking flow to write formal plans. The memo persists entries to a markdown file (`.switchboard/memo.md`) and provides three actions: **Send to Planner**, **Copy Prompt**, and **Clear**. The "Send to Planner" and "Copy Prompt" buttons generate a prompt (reusing the existing kanban prompt-generation pipeline) that instructs an agent to refine each memo issue into a **separate plan file** (one per issue). The memo is accessible from (1) a button in the kanban board, (2) the switchboard status bar hub menu, and (3) a multi-key hotkey (default: `Ctrl+Shift+Alt+M` / mac: `Cmd+Shift+Alt+M`) redefinable in setup.html. A `/memo` skill is also created so an agent can progressively append entries as the user types them without performing analysis until the user says "investigate memo" or similar.

### Problem & Background

During active development/testing, many small issues surface in rapid succession. The current workflow forces a context switch: stop testing, open a chat, formulate a formal plan, repeat. This kills testing momentum and means many issues get forgotten or noted in ad-hoc places (sticky notes, random text files, memory). There is no fast capture mechanism that integrates with the existing plan-creation pipeline.

### Root Cause

No lightweight capture UI exists. The kanban board's "Copy Prompt" / "Send to Planner" flow is plan-card-centric — it requires a plan to already exist as a card. The memo bridges the gap between "unstructured thought" and "formal plan" by providing a buffer zone with one-click conversion to the planner pipeline.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Trigger Sources                                    │
│  1. Kanban board button (kanban.html)               │
│  2. Status bar hub menu (extension.ts tooltip)      │
│  3. Hotkey: Cmd+Shift+Alt+M (package.json keybindings)│
│  4. /memo skill (agent chat)                        │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│  Memo Modal (kanban.html)                           │
│  ┌───────────────────────────────────────────────┐  │
│  │  Textarea (auto-saves to .switchboard/        │  │
│  │  memo.md on every change, debounced)          │  │
│  └───────────────────────────────────────────────┘  │
│  [Send to Planner]  [Copy Prompt]  [Clear]          │
└──────────────┬──────────────────────────────────────┘
               │ postKanbanMessage({ type: 'memoAction', ... })
               ▼
┌─────────────────────────────────────────────────────┐
│  KanbanProvider.ts backend                          │
│  - Loads/saves .switchboard/memo.md                 │
│  - Generates planner prompt (one plan per issue)    │
│  - Send to Planner: clipboard + dispatch            │
│  - Copy Prompt: clipboard only                      │
│  - Clear: truncate file (no confirm dialog!)        │
└─────────────────────────────────────────────────────┘
```

---

## Proposed Changes

### 1. `src/webview/kanban.html` — Memo Modal HTML + CSS + JS

**Location**: Insert modal HTML after the existing modals (after line ~2895, near the Epic Create Modal).

#### 1a. Modal HTML

```html
<div id="memo-modal" class="modal-overlay hidden">
    <div class="modal-content" style="width: 640px; max-width: 90vw;">
        <div class="modal-header">
            <h3 class="modal-title">Memo</h3>
            <button class="modal-close-btn" id="memo-close-btn">&times;</button>
        </div>
        <div class="modal-body">
            <p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
                Jot down bugs, thoughts, or issues. Each line/paragraph is treated as a separate issue when sent to the planner.
            </p>
            <textarea id="memo-textarea"
                      class="modal-textarea"
                      placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload..."
                      style="width: 100%; min-height: 300px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
        </div>
        <div class="modal-footer">
            <span id="memo-status" style="font-size: 11px; color: var(--text-secondary); margin-right: auto;"></span>
            <button class="modal-btn modal-btn-secondary" id="memo-clear-btn">Clear</button>
            <button class="modal-btn modal-btn-secondary" id="memo-copy-btn">Copy Prompt</button>
            <button class="modal-btn modal-btn-primary" id="memo-send-btn">Send to Planner</button>
        </div>
    </div>
</div>
```

#### 1b. Kanban Board Button

Add a button to the kanban controls strip (near the existing control buttons, around line ~2300+ where the header controls are):

```html
<button id="btn-open-memo" class="control-btn" data-tooltip="Open Memo (Cmd+Shift+Alt+M)">
    <span class="btn-icon">$(comment-discussion)</span> Memo
</button>
```

> ⚠️ **CORRECTION (CSS class)**: The class `control-btn` does **not exist** in `kanban.html`. The actual control strip (lines 2322-2342) uses `strip-btn` and `strip-icon-btn`. Use `strip-icon-btn` to match the existing icon-button pattern:
> ```html
> <button class="strip-icon-btn" id="btn-open-memo" data-tooltip="Open Memo (Cmd+Shift+Alt+M)">
>     <span class="btn-icon">$(comment-discussion)</span>
> </button>
> ```
> Insert this near line 2342 (after `btn-collapse-coders`), within the existing control strip `<div>`.

*Note*: Use the same icon pattern as other control buttons. `$(comment-discussion)` is a good fit for a memo/jot feature and doesn't conflict with existing icons.

#### 1c. JavaScript (in kanban.html `<script>` block)

```javascript
// === Memo ===
let memoSaveTimer = null;

function openMemoModal() {
    const modal = document.getElementById('memo-modal');
    const textarea = document.getElementById('memo-textarea');
    postKanbanMessage({ type: 'memoLoad' });
    modal.classList.remove('hidden');
    textarea.focus();
}

function closeMemoModal() {
    document.getElementById('memo-modal').classList.add('hidden');
}

function debouncedMemoSave() {
    if (memoSaveTimer) clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(() => {
        const content = document.getElementById('memo-textarea').value;
        postKanbanMessage({ type: 'memoSave', content });
        document.getElementById('memo-status').textContent = 'Saved ' + new Date().toLocaleTimeString();
    }, 800);
}

// Event listeners
document.getElementById('btn-open-memo')?.addEventListener('click', openMemoModal);
document.getElementById('memo-close-btn').addEventListener('click', closeMemoModal);
document.getElementById('memo-textarea').addEventListener('input', debouncedMemoSave);

document.getElementById('memo-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMemoModal();
});

document.getElementById('memo-clear-btn').addEventListener('click', () => {
    // NO confirm dialog — per CLAUDE.md rules. Clear immediately.
    document.getElementById('memo-textarea').value = '';
    postKanbanMessage({ type: 'memoClear' });
    document.getElementById('memo-status').textContent = 'Cleared';
});

document.getElementById('memo-copy-btn').addEventListener('click', () => {
    const content = document.getElementById('memo-textarea').value;
    postKanbanMessage({ type: 'memoGeneratePrompt', content, action: 'copy' });
});

document.getElementById('memo-send-btn').addEventListener('click', () => {
    const content = document.getElementById('memo-textarea').value;
    postKanbanMessage({ type: 'memoGeneratePrompt', content, action: 'send' });
});

// Receive memo content from backend
window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'memoContent') {
        document.getElementById('memo-textarea').value = msg.content || '';
    }
    if (msg.type === 'memoPromptResult') {
        document.getElementById('memo-status').textContent = msg.message;
    }
    if (msg.type === 'openMemoModal') {
        openMemoModal();
    }
});

// Reload-on-focus: mitigates concurrent /memo skill appends clobbering.
// When the modal regains focus, reload from disk to pick up any skill-appended entries.
document.getElementById('memo-modal').addEventListener('focusin', () => {
    postKanbanMessage({ type: 'memoLoad' });
});

// Escape key to close
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('memo-modal').classList.contains('hidden')) {
        closeMemoModal();
    }
});
```

---

### 2. `src/services/KanbanProvider.ts` — Backend Handlers

**Location**: Add new message cases in the `switch (msg.type)` statement at **line 4248** (the main webview message handler). The plan's original reference to "line ~5356" was incorrect — that line is inside a different case block, not the switch declaration.

> ⚠️ **CORRECTION (line reference)**: The `switch (msg.type)` is at line 4248, with `case 'ready':` at line 4249. Add the new `case 'memoLoad':`, `case 'memoSave':`, `case 'memoClear':`, `case 'memoGeneratePrompt':`, and `case 'openMemoModal':` blocks within this switch, before the `default:` case.

#### 2a. Memo file path helper

```typescript
private _getMemoPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.switchboard', 'memo.md');
}
```

#### 2b. Message handlers

```typescript
case 'memoLoad': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const memoPath = this._getMemoPath(workspaceRoot);
    let content = '';
    try {
        content = await fs.promises.readFile(memoPath, 'utf8');
    } catch { /* file doesn't exist yet — that's fine */ }
    this._panel?.webview.postMessage({ type: 'memoContent', content });
    break;
}

case 'memoSave': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const memoPath = this._getMemoPath(workspaceRoot);
    const dir = path.dirname(memoPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(memoPath, typeof msg.content === 'string' ? msg.content : '', 'utf8');
    break;
}

case 'memoClear': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const memoPath = this._getMemoPath(workspaceRoot);
    await fs.promises.writeFile(memoPath, '', 'utf8');
    break;
}

case 'memoGeneratePrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const content = typeof msg.content === 'string' ? msg.content : '';
    const action = msg.action === 'send' ? 'send' : 'copy';

    // Parse entries: split on double-newline (blank line separates issues)
    // or single-line entries if no blank-line separation.
    const issues = this._parseMemoEntries(content);

    if (issues.length === 0) {
        this._panel?.webview.postMessage({
            type: 'memoPromptResult',
            message: 'No entries to process.'
        });
        break;
    }

    // Generate the planner prompt
    const prompt = this._buildMemoPlannerPrompt(issues, workspaceRoot);

    // Always copy to clipboard
    await vscode.env.clipboard.writeText(prompt);

    if (action === 'send') {
        // Dispatch to planner via the existing dispatch mechanism
        await this._dispatchMemoToPlanner(prompt, workspaceRoot);
    }

    this._panel?.webview.postMessage({
        type: 'memoPromptResult',
        message: action === 'send'
            ? `Sent ${issues.length} issue(s) to planner. Prompt copied to clipboard.`
            : `Prompt for ${issues.length} issue(s) copied to clipboard.`
    });
    break;
}

case 'openMemoModal': {
    // Forward to webview to open the modal
    this._panel?.webview.postMessage({ type: 'openMemoModal' });
    break;
}
```

#### 2c. Entry parser

```typescript
private _parseMemoEntries(content: string): string[] {
    const trimmed = content.trim();
    if (!trimmed) return [];

    // Split on blank lines (paragraph-separated entries).
    // If no blank lines exist, treat each non-empty line as a separate entry.
    const paragraphSplit = trimmed.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

    if (paragraphSplit.length > 1) {
        return paragraphSplit;
    }

    // Fallback: line-by-line, but merge continuation lines.
    // A line is a "new entry" if it starts with a known prefix (Bug:, Thought:, Issue:, TODO:, Note:)
    // or starts with an uppercase letter. Otherwise, it's a continuation of the previous entry.
    const ENTRY_PREFIXES = /^(bug|thought|issue|todo|note|fix|idea)[:\s]/i;
    const lines = trimmed.split('\n').map(s => s.trim()).filter(Boolean);
    const entries: string[] = [];
    for (const line of lines) {
        const isNewEntry = ENTRY_PREFIXES.test(line) ||
            (line.length > 0 && line[0] === line[0].toUpperCase() && line[0] !== line[0].toLowerCase());
        if (entries.length === 0 || isNewEntry) {
            entries.push(line);
        } else {
            // Continuation — merge with previous entry
            entries[entries.length - 1] += '\n' + line;
        }
    }
    return entries;
}
```

> ⚠️ **CORRECTION (parser heuristic)**: The original parser's line-by-line fallback would fragment a multi-line issue (e.g., "Bug: X happens\nwhen Y is clicked\nSteps: 1, 2, 3") into three separate "issues." The revised parser above merges continuation lines — lines that don't start with a known prefix (`Bug:`, `Thought:`, `Issue:`, `TODO:`, `Note:`, `Fix:`, `Idea:`) and don't start with an uppercase letter are treated as continuations of the previous entry.

#### 2d. Prompt builder

The prompt instructs the agent to create one plan file per issue. It does NOT use `generateUnifiedPrompt` (which is card/plan-centric) — instead it builds a standalone planner prompt:

```typescript
private _buildMemoPlannerPrompt(issues: string[], workspaceRoot: string): string {
    const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
    const issueList = issues.map((issue, i) =>
        `### Issue ${i + 1}\n${issue}`
    ).join('\n\n');

    return `You are a planner agent. The user has captured the following issues in their memo during testing. Your task is to refine EACH issue into a separate, complete plan file — one plan per issue. Do not combine issues.

## Issues to Refine

${issueList}

## Instructions

For EACH issue above:
1. Create a separate plan file in \`${plansDir}\` using the naming convention \`feature_plan_<timestamp>_<slug>.md\`
2. Follow the standard Switchboard plan format (Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan)
3. Investigate the codebase to understand the root cause and write an actionable plan
4. Each plan must be self-contained — do not reference other memo issues

## Plan File Format

Each plan file must include:
- # Title (derived from the issue)
- ## Goal (with problem analysis and root cause)
- ## Metadata (tags, complexity 1-10)
- ## Complexity Audit (Routine vs Complex/Risky)
- ## Edge-Case & Dependency Audit
- ## Proposed Changes (per-file breakdown with code snippets)
- ## Verification Plan

## Important
- Create ${issues.length} plan file(s) total — one per issue
- Write each plan to: ${plansDir}/feature_plan_<YYYYMMDDHHMMSS>_<slug>.md
- Do NOT skip the investigation step — read the relevant code before writing each plan
- After creating all plans, run a full sync so they appear on the kanban board`;
}
```

#### 2e. Dispatch to planner

> ⚠️ **CRITICAL CORRECTION (phantom method)**: The original plan called `this._taskViewerProvider?.dispatchPromptToTerminal(prompt, 'planner', workspaceRoot)` — a method that **does not exist** in `TaskViewerProvider`. The correct method is `dispatchCustomPromptToRole(role, prompt, workspaceRoot)` at `TaskViewerProvider.ts:2494`, which returns `Promise<boolean>`. The existing usage pattern at `KanbanProvider.ts:5967-5971` shows the correct call.

```typescript
private async _dispatchMemoToPlanner(prompt: string, workspaceRoot: string): Promise<void> {
    // Use the existing dispatchCustomPromptToRole method (TaskViewerProvider.ts:2494).
    // This mirrors the pattern at KanbanProvider.ts:5967-5971 (sendToLead dispatch).
    if (!this._taskViewerProvider) {
        vscode.window.showInformationMessage(
            'Memo prompt copied to clipboard. No planner terminal available — paste it manually.'
        );
        return;
    }
    try {
        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('planner', prompt, workspaceRoot);
        if (!dispatched) {
            vscode.window.showWarningMessage(
                'Memo prompt copied to clipboard but could not dispatch to planner. Paste manually.'
            );
        }
    } catch (err) {
        // Fallback: just keep the prompt on clipboard (already copied)
        vscode.window.showInformationMessage(
            'Memo prompt copied to clipboard. No planner terminal available — paste it manually.'
        );
    }
}
```

*Note*: `dispatchCustomPromptToRole` resolves the workspace root internally and dispatches to the first available terminal with the given role. It returns `false` if no matching terminal is found — the handler above surfaces a warning in that case.

---

### 3. `src/extension.ts` — Command + Status Bar + Hotkey

#### 3a. Register command

Add near the other command registrations (around line 746-749, after `openKanbanDisposable`):

> ⚠️ **CORRECTION (`open('memo')` is wrong)**: The `open(tab)` method at `KanbanProvider.ts:860` sets `_pendingTab` and posts `switchToTab` — there is no 'memo' tab. Calling `open('memo')` would attempt to switch to a non-existent tab. Call `open()` with no argument, then post the modal-open message.

> ⚠️ **CORRECTION (`postMessage` already exists)**: The plan hedged about needing to add `postMessage`. It already exists as a public method at `KanbanProvider.ts:1317`. No addition needed.

```typescript
const openMemoDisposable = vscode.commands.registerCommand('switchboard.openMemo', async () => {
    await kanbanProvider!.open();  // No tab argument — open() with no arg just reveals/creates the panel
    // After kanban opens, send message to open the memo modal
    kanbanProvider!.postMessage({ type: 'openMemoModal' });
});
context.subscriptions.push(openMemoDisposable);
```

#### 3b. Status bar hub menu

In the hub tooltip markdown builder (extension.ts lines 1955-1981), add a memo link. The hub tooltip is built from a `lines` array and rendered as a `MarkdownString` at line 1978. Add the memo link in the panels section (after line 1971, before the `hasPanels` block closes):

```typescript
lines.push(`[$(comment-discussion) Memo](command:switchboard.openMemo)`);
```

> ⚠️ **CORRECTION (hub menu placement)**: The memo link should be added unconditionally (not gated by `showMemoButton`) since it's a command link in a tooltip, not a dedicated status bar item. Place it after the panels block (after line 1972) as its own section:
> ```typescript
> if (lines.length > 2) lines.push('---');
> lines.push(`[$(comment-discussion) Memo](command:switchboard.openMemo)`);
> ```

Also add a dedicated status bar item (optional, configurable like the others). Add near the other status bar item creations (after line 1841, `switchboardHubStatusBarItem`):

```typescript
const memoStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 94
);
memoStatusBarItem.command = 'switchboard.openMemo';
memoStatusBarItem.text = '$(comment-discussion)';
memoStatusBarItem.tooltip = 'Open Memo';
memoStatusBarItem.show();
context.subscriptions.push(memoStatusBarItem);
```

> ⚠️ **CORRECTION (status bar config wiring)**: The plan mentioned wiring into `updateStatusBarVisibility()` but there are **THREE** separate locations that read status bar config keys and toggle visibility:
> 1. **Line 1847** — initial visibility setup (inside the hub-mode branch)
> 2. **Line 1944** — non-hub-mode visibility setup
> 3. **Line 2026** — `onDidChangeConfiguration` handler
>
> Additionally, the `onDidChangeConfiguration` filter at **line 1998** must include `switchboard.statusBar.showMemoButton`.
>
> Add `const showMemoButton = config.get<boolean>('statusBar.showMemoButton', false);` to all three locations, and add `e.affectsConfiguration('switchboard.statusBar.showMemoButton')` to the filter at line 1998. Then add `if (showMemoButton) { memoStatusBarItem.show(); } else { memoStatusBarItem.hide(); }` to both visibility branches (lines 1893 and 1909 areas).

Add a config key `switchboard.statusBar.showMemoButton` (default: `false`) to package.json configuration section (see section 4c).

---

### 4. `package.json` — Command + Keybinding + Config

#### 4a. Command registration

In the `contributes.commands` section:

```json
{
    "command": "switchboard.openMemo",
    "title": "Switchboard: Open Memo"
}
```

#### 4b. Keybinding (multi-key, uncommon)

Add a `contributes.keybindings` section (does not currently exist in package.json):

```json
"keybindings": [
    {
        "command": "switchboard.openMemo",
        "key": "ctrl+shift+alt+m",
        "mac": "cmd+shift+alt+m",
        "when": "editorTextFocus || editorFocus || workbenchFocus"
    }
]
```

This is a 4-key combination (modifier combo + letter) that is not widely used by VS Code or common extensions. The `when` clause ensures it works in most contexts.

#### 4c. Config keys

Add to `contributes.configuration`:

```json
{
    "title": "Memo",
    "properties": {
        "switchboard.memo.hotkey": {
            "type": "string",
            "default": "cmd+shift+alt+m",
            "description": "Hotkey to open the memo. Use VS Code keybinding format (e.g. 'ctrl+shift+alt+m'). Note: changing this requires a window reload to take effect."
        },
        "switchboard.statusBar.showMemoButton": {
            "type": "boolean",
            "default": false,
            "description": "Show a dedicated memo button in the status bar."
        }
    }
}
```

*Important note on hotkey redefinition*: VS Code keybindings are declarative in package.json and cannot be dynamically changed at runtime by the extension. The setup.html hotkey field will:
1. Update the `switchboard.memo.hotkey` config value (for display/documentation purposes)
2. Show instructions telling the user to also update their VS Code keybindings.json (or provide a button that opens the keybindings UI)
3. The actual functional keybinding remains the one declared in package.json. This is a VS Code platform limitation.

---

### 5. `src/webview/setup.html` — Hotkey Configuration UI

Add a new section in the "Status Bar" tab (the `status-bar-fields` div at line 1167), since the memo button visibility is also configured there. Alternatively, create a new "Memo" tab — but reusing the Status Bar tab is simpler and avoids adding a new tab button.

> ⚠️ **CORRECTION (CSS classes)**: The plan used `setting-row`, `setting-label`, `setting-control`, `setting-btn` — none of which exist in `setup.html`. The actual pattern is `startup-row` with inline-styled flex divs (see lines 1175-1205). Use that pattern instead.

#### 5a. HTML

Add at the end of the `status-bar-fields` div (after the last checkbox label, around line 1205+), using the existing `startup-row` pattern:

```html
<div style="font-size: 10px; color: var(--text-secondary); margin: 14px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
    MEMO HOTKEY
</div>
<div class="hint-text" style="margin-bottom: 8px; font-size: 10px; color: var(--text-secondary); line-height: 1.4;">
    Hotkey to open the memo modal. Default: Cmd+Shift+Alt+M (Mac) / Ctrl+Shift+Alt+M (Windows/Linux).
    Note: VS Code requires keybindings to be set in keybindings.json. Use the button below to open it.
</div>
<div class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
    <input type="text" id="memo-hotkey-input" placeholder="cmd+shift+alt+m" style="flex:1; min-width: 120px;" />
    <button id="memo-open-keybindings" class="strip-btn" style="white-space:nowrap;">Open Keybindings</button>
</div>
```

#### 5b. JavaScript (setup.html)

```javascript
// Load current hotkey setting
vscode.postMessage({ type: 'getMemoHotkey' });

// Save on change
document.getElementById('memo-hotkey-input')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'saveMemoHotkey', value: e.target.value });
});

// Open VS Code keybindings
document.getElementById('memo-open-keybindings')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openKeybindings' });
});
```

#### 5c. Backend handler (SetupPanelProvider.ts)

```typescript
case 'getMemoHotkey': {
    const config = vscode.workspace.getConfiguration('switchboard');
    const hotkey = config.get<string>('memo.hotkey', 'cmd+shift+alt+m');
    this._panel?.webview.postMessage({ type: 'memoHotkey', value: hotkey });
    break;
}
case 'saveMemoHotkey': {
    const config = vscode.workspace.getConfiguration('switchboard');
    await config.update('memo.hotkey', msg.value, vscode.ConfigurationTarget.Global);
    this._panel?.webview.postMessage({ type: 'memoHotkeySaved' });
    break;
}
case 'openKeybindings': {
    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
    break;
}
```

---

### 6. `/memo` Skill — Agent Chat Integration

#### 6a. Skill definition

Skills are documented in `AGENTS.md` and consumed by agents at runtime. Add the memo skill to the AGENTS.md skills table:

```markdown
| `memo` | User invokes `/memo` to enter progressive capture mode — agent appends each user message to `.switchboard/memo.md` without analysis until user says "investigate memo" or similar |
```

#### 6b. Skill behavior specification

The `/memo` skill works as follows:

1. **Invocation**: User types `/memo` in agent chat
2. **Mode activation**: Agent reads `.switchboard/memo.md` and displays current contents, then enters "capture mode"
3. **Capture loop**: For each subsequent user message:
   - Agent appends the message text to `.switchboard/memo.md` (with a timestamp header and blank-line separator)
   - Agent responds with a brief confirmation: `✓ Added to memo: "<first 50 chars>..." (N entries total)`
   - Agent does NOT analyze, investigate, or plan — just captures
4. **Exit trigger**: When the user says "investigate memo", "analyze memo", "refine memo", or similar:
   - Agent reads all entries from `.switchboard/memo.md`
   - Agent generates the same planner prompt as the modal's "Send to Planner" button
   - Agent begins refining each issue into a separate plan file in `.switchboard/plans/`
5. **Format for appended entries** (blank-line separated, matching the modal's expected format):

```markdown
Bug: login button overlaps on mobile viewport

Thought: maybe cache the user profile to avoid repeated fetches
```

#### 6c. Skill file

Since skills are bundled with the plugin (per AGENTS.md note: "Skill Files Location: `.agent/skills/` (distributed with plugin)"), create the skill definition file at `.agent/skills/memo/SKILL.md`:

```markdown
# Memo Skill

## Trigger
User invokes `/memo` in chat.

## Behavior

### Capture Mode
1. Read `.switchboard/memo.md` (create if it doesn't exist).
2. Display current entry count and last few entries.
3. Enter capture mode: subsequent user messages are appended to the file.

### Appending Entries
For each user message while in capture mode:
1. Append the user's message text to `.switchboard/memo.md`, separated from previous entries by a blank line.
2. Respond with: `✓ Added to memo: "<first 50 chars>..." (N entries total)`
3. Do NOT analyze, investigate, plan, or write code. Just capture.

### Exit Triggers
When the user says any of:
- "investigate memo"
- "analyze memo"
- "refine memo"
- "process memo"
- "send memo to planner"

Then:
1. Read all entries from `.switchboard/memo.md`.
2. Parse entries (split on blank lines).
3. For each entry, create a separate plan file in `.switchboard/plans/` following the standard plan format.
4. Investigate the codebase for each issue before writing its plan.
5. Report which plan files were created.

### Clearing
If the user says "clear memo":
1. Truncate `.switchboard/memo.md` to empty.
2. Confirm: `Memo cleared.`
```

---

### 7. `src/services/TaskViewerProvider.ts` — Brain Scanner Exclusion

**Location**: `EXCLUDED_BRAIN_FILENAMES` set (line ~376-381).

The existing exclusion list contains `scratchpad.md` but NOT `memo.md`. Add `memo.md` to prevent the brain scanner from auto-ingesting the memo file as a plan:

```typescript
private static readonly EXCLUDED_BRAIN_FILENAMES = new Set([
    'task.md', 'walkthrough.md', 'readme.md',
    'grumpy_critique.md', 'balanced_review.md', 'post_mortem.md',
    'review_response.md', 'meeting_notes.md', 'scratchpad.md',
    'analysis_results.md', 'research_notes.md', 'experiment_results.md',
    'memo.md'  // ← ADD THIS
]);
```

---

### 8. `.switchboard/memo.md` — Persistence File

- **Location**: `<workspaceRoot>/.switchboard/memo.md`
- **Format**: Plain markdown. The modal treats blank-line-separated paragraphs (or individual lines) as separate issues.
- **Brain scanner exclusion**: `memo.md` must be added to `EXCLUDED_BRAIN_FILENAMES` (see section 7 above). The existing `scratchpad.md` entry does NOT cover `memo.md`.
- **Gitignore**: The `.switchboard/` directory is already gitignored by the extension's gitignore strategy. No change needed.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent saves**: The debounced save (800ms) prevents rapid-fire writes. If the modal is open in two kanban panels simultaneously (unlikely — kanban is a singleton panel), last-write-wins is acceptable for a memo.
- **Skill + modal simultaneous access**: If the user has the modal open AND an agent is appending via `/memo` skill, the modal's debounced save could overwrite agent-appended content. **Mitigation**: The skill appends to the file on disk; the modal saves the full textarea content. If both are active, the modal save will clobber. **Recommendation**: When the modal opens, it loads from disk (getting any skill-appended content). **Added mitigation (v1)**: The modal now reloads from disk on `focusin` (see section 1c), so switching back to the modal picks up any skill-appended entries before the next debounced save. For v1, accept last-write-wins and document the limitation.

### Security
- No sensitive data handling. Memo content is user-authored text stored locally.
- No injection risk — content is written to a `.md` file and displayed in a textarea.

### Side Effects
- **Clear button**: Truncates the file immediately with NO confirmation dialog (per CLAUDE.md rules). This is intentional — the user explicitly demanded no confirmation dialogs. The clear is destructive but the button is deliberate.
- **Plan creation**: The "Send to Planner" action creates plan files but does NOT auto-advance them on the kanban board. The plans will appear after a full sync.

### Dependencies & Conflicts
- **No new npm dependencies** — uses existing `fs`, `path`, `vscode` APIs.
- **No database schema changes** — memo is a plain file, not tracked in `kanban.db`.
- **Webpack**: No changes needed — `kanban.html` and `setup.html` are already copied by CopyPlugin. Run `npm run compile` after edits.
- **Keybindings**: Adding the first `keybindings` section to package.json. No conflict with existing bindings since none exist.
- **Brain scanner**: Must add `memo.md` to `EXCLUDED_BRAIN_FILENAMES` — the existing `scratchpad.md` entry does not cover the new filename.

### Migration Concerns
- This is a **new feature** that has never shipped. No migration needed.
- `.switchboard/memo.md` does not exist on any user's system yet. First open creates it.
- The `keybindings` section in package.json is new but additive — existing users won't be affected.
- The `EXCLUDED_BRAIN_FILENAMES` change is additive — no existing behavior is altered.

---

## Dependencies

- No external session dependencies. This plan is self-contained.
- Internal code dependencies (verified during planning):
  - `KanbanProvider.postMessage()` — exists at `KanbanProvider.ts:1317` (public method)
  - `TaskViewerProvider.dispatchCustomPromptToRole()` — exists at `TaskViewerProvider.ts:2494` (public method, returns `Promise<boolean>`)
  - `KanbanProvider.open()` — exists at `KanbanProvider.ts:860` (public method, accepts optional `tab?: string`)
  - `TaskViewerProvider.EXCLUDED_BRAIN_FILENAMES` — exists at `TaskViewerProvider.ts:376-381` (private static readonly Set)

---

## Adversarial Synthesis

Key risks: (1) the original plan referenced a non-existent dispatch method (`dispatchPromptToTerminal`) — corrected to `dispatchCustomPromptToRole`; (2) multiple CSS class and line-number references were wrong — all corrected with verified values; (3) concurrent modal + `/memo` skill access can clobber entries — mitigated with reload-on-focus. Mitigations: all 8 factual errors corrected inline with ⚠️ markers; reload-on-focus added; entry parser enhanced with prefix-based merge heuristic. Remaining acceptable risk: last-write-wins for concurrent access is documented as a v1 limitation.

---

## Complexity Audit

### Routine
- Adding modal HTML/CSS/JS to kanban.html (follows existing modal pattern exactly)
- Adding message handlers to KanbanProvider.ts (follows existing case pattern)
- Adding command + keybinding to package.json (standard VS Code extension pattern)
- Adding setup.html hotkey config field (follows existing setting row pattern)
- File read/write for memo.md (trivial `fs.promises` calls)
- Adding `memo.md` to EXCLUDED_BRAIN_FILENAMES (one-line addition)

### Complex / Risky
- **Prompt generation**: The memo prompt is standalone (not card-based), so it can't reuse `generateUnifiedPrompt` directly. The custom `_buildMemoPlannerPrompt` method is straightforward but needs to produce a prompt that results in proper plan files. **Risk**: Agent might not create plans in the exact format. **Mitigation**: The prompt explicitly specifies the plan format and directory.
- **Dispatch to planner terminal**: The `_dispatchMemoToPlanner` method uses `dispatchCustomPromptToRole('planner', prompt, workspaceRoot)` (verified at `TaskViewerProvider.ts:2494`, returns `Promise<boolean>`). The existing usage pattern at `KanbanProvider.ts:5967-5971` confirms the API. **Risk**: If no planner terminal is registered, dispatch returns `false` — handler surfaces a warning and the prompt remains on clipboard.
- **Status bar config wiring**: The `showMemoButton` config must be read in 3 separate locations (lines 1847, 1944, 2026) and included in the `onDidChangeConfiguration` filter (line 1998). Missing any one breaks visibility toggling.
- **Hotkey redefinition limitation**: VS Code doesn't support runtime keybinding changes from extension code. The setup.html field can only store a preference and guide the user to keybindings.json. This is a platform limitation, not a bug.

---

## Verification Plan

### Automated Tests

> Per session directives: **SKIP COMPILATION** (do NOT run `npm run compile`, `tsc`, or webpack) and **SKIP TESTS** (do NOT run unit/integration/e2e tests). The test suite and build will be run separately by the user.

### Manual Verification (after user runs build)

1. **Modal opens from kanban button**: Click "Memo" button in kanban → modal appears with textarea focused
2. **Modal opens from status bar**: Click memo icon in status bar → kanban opens (if needed) → modal appears
3. **Modal opens from hotkey**: Press Cmd+Shift+Alt+M → modal appears
4. **Persistence**: Type text, close modal, reopen → text is preserved
5. **Auto-save**: Type text, wait 1 second, close modal without clicking save → text is persisted
6. **Copy Prompt**: Enter 3 issues (blank-line separated), click "Copy Prompt" → clipboard contains a prompt instructing agent to create 3 separate plan files
7. **Send to Planner**: Enter 2 issues, click "Send to Planner" → prompt is copied to clipboard AND dispatched to planner terminal (or info message if no terminal)
8. **Clear**: Click "Clear" → textarea empties, file is truncated, NO confirmation dialog appears
9. **Empty state**: Open memo with no file → textarea is empty, no errors
10. **Single-line entries**: Enter issues on separate lines (no blank line separation) → each line treated as separate issue (with prefix-based merge for continuations)
11. **Multi-line entry merge**: Enter "Bug: X happens\nwhen Y is clicked" (no blank line) → treated as ONE issue, not two
12. **Setup.html hotkey**: Open setup → Status Bar tab, change hotkey field, save → config updated; "Open Keybindings" button opens VS Code keybindings UI
13. **`/memo` skill**: Invoke `/memo` in agent chat → agent enters capture mode, appends subsequent messages to file, responds with confirmation only
14. **`/memo` skill exit**: While in capture mode, say "investigate memo" → agent reads entries and creates plan files
15. **Reload-on-focus**: While modal is open, append via `/memo` skill, click back into modal textarea → modal reloads from disk showing skill-appended content
16. **Brain scanner exclusion**: Verify `.switchboard/memo.md` is NOT ingested as a plan (confirm `memo.md` is in EXCLUDED_BRAIN_FILENAMES)

---

## Implementation Order

1. **TaskViewerProvider.ts** — Add `memo.md` to `EXCLUDED_BRAIN_FILENAMES` (one-line change, do first)
2. **kanban.html** — Modal HTML + CSS + JS (frontend)
3. **KanbanProvider.ts** — Message handlers + file I/O + prompt builder (backend)
4. **extension.ts** — Command registration + status bar item (all 3 config-read locations + onDidChangeConfiguration)
5. **package.json** — Command + keybinding + config keys
6. **setup.html** + **SetupPanelProvider.ts** — Hotkey config UI (in Status Bar tab, using `startup-row` pattern)
7. **AGENTS.md** + `.agent/skills/memo/SKILL.md` — Skill definition
8. **Build & test** — User runs `npm run compile` + manual verification (skipped per session directives)

---

## Resolved Questions

1. **Memo icon**: `$(comment-discussion)` — confirmed.
2. **Entry separation**: Blank-line if multiple paragraphs exist, otherwise line-by-line — confirmed.
3. **Send to Planner dispatch**: Both buttons exist as separate actions — "Send to Planner" dispatches to terminal AND copies to clipboard; "Copy Prompt" copies to clipboard only. Confirmed.
4. **Hotkey**: `Cmd+Shift+Alt+M` (Mac) / `Ctrl+Shift+Alt+M` (Windows/Linux) — confirmed.
5. **Skill append format**: Plain blank-line separators, no timestamp headers — matches the modal's expected output format. Confirmed.

---

## Recommendation

**Complexity: 5** (Mixed — majority routine modal/UI/file-IO work, with two moderate well-scoped risks: the dispatch integration via `dispatchCustomPromptToRole` and the status bar config wiring across 3 locations + `onDidChangeConfiguration`).

**Send to Coder.**

---

## Reviewer Pass — Completed

### Stage 1: Grumpy Principal Engineer Findings

#### CRITICAL
None. The implementation is structurally sound — all 8 plan sections are present and wired correctly.

#### MAJOR
1. **`focusin` reload destroys unsaved textarea content** (`src/webview/kanban.html:3645-3647`): The `focusin` listener on `#memo-modal` fires on EVERY internal focus shift (textarea → button, button → textarea), not just "window regained focus" as the plan intended. If the user types text and then clicks a button within the 800ms debounce window, the reload reads stale disk content and overwrites the textarea via the `memoContent` handler. The user's unsaved typing is silently destroyed. This is an active data-loss bug during normal single-user usage — far worse than the concurrent `/memo` skill clobber it was meant to mitigate.

#### NIT
1. **Double error messaging on dispatch failure** (`src/services/KanbanProvider.ts:6998-7002`): When no planner terminal is assigned, `dispatchCustomPromptToRole` internally shows `showErrorMessage("No agent assigned to role 'planner'...")` AND `_dispatchMemoToPlanner` then shows `showWarningMessage("...could not dispatch...")`. Two messages for one failure. Redundant, not incorrect.
2. **Entry parser digit-line heuristic** (`src/services/KanbanProvider.ts:6943-6944`): Lines starting with digits (e.g., "1. Fix the login bug") are treated as continuations, not new entries. Documented as v1-acceptable.
3. **`dispatchCustomPromptToRole` line reference**: Plan says line 2494, actual is 2495. Cosmetic.

### Stage 2: Balanced Synthesis

**Keep (verified correct):**
- Modal HTML/CSS/JS — matches existing modal patterns, all CSS classes exist (`modal-overlay`, `modal-content`, `modal-textarea`, `modal-btn-*`)
- Kanban button — uses `strip-icon-btn` (correct class), placed in control strip
- Backend handlers — all 5 cases present, proper `if (!workspaceRoot) break` guards, correct `stateFs` bridge usage (passes through for non-`state.json` paths)
- Entry parser — reasonable prefix-based merge heuristic for v1
- Prompt builder — clear, standalone, specifies plan format and directory
- Dispatch integration — correct method (`dispatchCustomPromptToRole` at `TaskViewerProvider.ts:2495`), correct call pattern matching existing `sendToLead` usage
- Status bar wiring — all 3 config-read locations (lines 1867, 1975, 2064) + `onDidChangeConfiguration` filter (line 2035) + hub tooltip (line 2000) + hub quick pick (line 2135) all correct
- `extension.ts` command — `open()` with no tab arg + `postMessage({ type: 'openMemoModal' })` correct
- `package.json` — command, keybinding, and both config keys present
- `setup.html` — hotkey UI uses valid `secondary-btn` class (better than plan's `strip-btn`), toggle + input + open-keybindings button all wired, load-on-tab-open via `getMemoHotkey` at line 1722
- `SetupPanelProvider.ts` — all 3 handlers (`getMemoHotkey`, `saveMemoHotkey`, `openKeybindings`) present
- `TaskViewerProvider.ts` — `memo.md` added to `EXCLUDED_BRAIN_FILENAMES` (line 381); `handleGetStatusShowMemoSetting`/`handleSetStatusShowMemoSetting` present (lines 3515-3522)
- `AGENTS.md` — memo skill entry in skills table (line 90)
- `.agent/skills/memo/SKILL.md` — exists, follows same directory pattern as other skills
- Gitignore — `.switchboard/*` covers `memo.md` (not in exception list)
- `.vscodeignore` — `!.agent/**` ensures skill file ships with extension

**Fix now:**
- MAJOR #1: Removed the `focusin` reload handler. The modal already loads from disk on open via `openMemoModal()`. The concurrent `/memo` skill access remains a documented v1 last-write-wins limitation.

**Defer:**
- NIT #1 (double error messaging) — cosmetic, future UX pass
- NIT #2 (digit-line heuristic) — documented v1-acceptable

### Fixes Applied

| File | Change | Severity |
|------|--------|----------|
| `src/webview/kanban.html:3645-3649` | Removed `focusin` reload listener that caused data loss during typing; replaced with explanatory comment | MAJOR |

### Verification Results

- **Compilation**: Skipped per session directives
- **Tests**: Skipped per session directives
- **Static verification (manual)**:
  - All plan sections (1-8) verified present in codebase ✓
  - `postKanbanMessage` hoisted function declaration — available to memo code ✓
  - `postMessage` public method exists at `KanbanProvider.ts:1322` ✓
  - `open(tab?)` accepts no args at `KanbanProvider.ts:865` ✓
  - `dispatchCustomPromptToRole(role, prompt, workspaceRoot)` signature matches at `TaskViewerProvider.ts:2495` ✓
  - `stateFs.promises` passes through `memo.md` paths (only intercepts `state.json`) ✓
  - `_resolveWorkspaceRoot(undefined)` falls back to `_currentWorkspaceRoot` ✓
  - All CSS classes (`modal-textarea`, `modal-btn-secondary`, `modal-btn-primary`, `strip-icon-btn`, `secondary-btn`) exist ✓
  - `memo.md` gitignored by `.switchboard/*` (not in exception list) ✓
  - Skill file ships via `!.agent/**` in `.vscodeignore` ✓

### Remaining Risks

1. **Concurrent `/memo` skill + modal access**: Last-write-wins. If both are active simultaneously, the modal's debounced save can clobber skill-appended entries. Documented as v1-acceptable. The removed `focusin` mitigation was worse than the problem (caused active data loss during normal typing). A proper fix would require file-watching or a merge strategy — deferred to v2.
2. **Double error messaging on dispatch failure**: Two VS Code messages shown when no planner terminal is assigned. Cosmetic, deferred.
3. **Hotkey redefinition limitation**: VS Code doesn't support runtime keybinding changes. The `setup.html` field stores a preference only; the functional keybinding is the one in `package.json`. This is a platform limitation, documented in the plan.
