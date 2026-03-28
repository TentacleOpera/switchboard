# Add Chat Mode Copy Button

## Goal
Add a new icon (`icons/25-1-100 Sci-Fi Flat icons-65.png`) to the CREATED column icon bar. When clicked, it copies a prompt to the clipboard instructing an agent to enter the `/chat` workflow to discuss the selected plans. If no plans are selected, the prompt references only the chat workflow without specific plans.

## Metadata
**Tags:** frontend, backend, UI
**Complexity:** Low

## User Review Required

> [!NOTE]
> This adds a clipboard-copy icon to the CREATED column. No plans are moved or modified — only a prompt is copied for the user to paste into an agent chat.

## Complexity Audit

### Routine
- Register icon placeholder `{{ICON_CHAT}}` in `KanbanProvider.ts` icon map.
- Add `ICON_CHAT` JS constant in `kanban.html`.
- Add the `<button>` element to the CREATED column header button area.
- Add `chatCopyPrompt` case to the webview click handler.
- Add `chatCopyPrompt` case to the `KanbanProvider.ts` message handler that builds the prompt string and writes to clipboard via `vscode.env.clipboard.writeText()`.

### Complex / Risky
- None. This follows the exact same pattern as the existing `promptSelected`/`copyPlanLink` handlers.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Clipboard write is a single atomic operation.
- **Security:** The prompt contains plan file paths which are local filesystem paths. No external data or user input.
- **Side Effects:** None. Plans are NOT moved or modified. Only the clipboard is written to. A success info message is shown.
- **Dependencies & Conflicts:**
  - **Cross-plan conflict with "Add Code Map Icon"**: Both plans add icons to the CREATED column button area. Icon ordering should be: existing move/prompt icons → code map icon → chat icon. Both plans must add to the same `buttonArea` div.
  - The chat workflow file is at `.agent/workflows/chat.md`. The prompt will reference this path.

## Adversarial Synthesis

### Grumpy Critique
"Another clipboard button. You're adding a button that generates a prompt asking an agent to read a workflow file. That's two levels of indirection — the user clicks a button to copy text that tells an agent to read a file that tells it how to behave. Why not just have the button open a chat panel directly? Also, when no plans are selected, you're generating a generic 'enter chat mode' prompt with no context — that's barely more useful than the user typing '/chat' themselves. And the prompt includes absolute file paths to `.agent/workflows/chat.md` — what if the user pastes it into a different workspace where that path doesn't exist?"

### Balanced Response
1. **Indirection is intentional:** The Switchboard architecture uses clipboard-based prompt handoff as a deliberate design pattern (see `promptSelected`, `copyPlanLink`). This allows the user to paste into ANY agent chat (Copilot, Windsurf, Cursor) — the extension can't control which chat window receives focus. This is a feature, not a bug.
2. **Empty-selection usefulness:** Even without specific plans, the prompt includes the workflow file path and the persona instructions, which saves the user from manually typing the workflow trigger. The no-plan path is a valid "quick start chat" shortcut.
3. **Relative vs absolute paths:** The prompt will use a workspace-relative path (`.agent/workflows/chat.md`) rather than an absolute path, making it portable across machines.

## Proposed Changes

### Icon URI Registration

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `iconMap` object (around line 2128) needs a new entry for icon 65.
- **Logic:** Add `{{ICON_CHAT}}` placeholder.
- **Implementation:**

Add to `iconMap` (after existing entries):
```typescript
'{{ICON_CHAT}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-65.png')).toString(),
```

### Icon Constant & Button HTML

#### [MODIFY] `src/webview/kanban.html`
- **Context:** Icon constants around line 1103. CREATED column button area around line 1320.
- **Logic:**
  1. Add `ICON_CHAT` constant.
  2. Create a `chatBtn` variable rendered only for the CREATED column (`isCreated`).
  3. Insert the button into the CREATED column's `buttonArea`.
- **Implementation:**

**Step 1 — Add icon constant** (after line 1112):
```javascript
const ICON_CHAT = '{{ICON_CHAT}}';
```

**Step 2 — Add conditional button** (around line 1304):
```javascript
const chatBtn = isCreated
    ? `<button class="column-icon-btn" data-action="chatCopyPrompt" data-column="${escapeAttr(def.id)}" data-tooltip="Copy chat prompt for selected plans to clipboard">
           <img src="${ICON_CHAT}" alt="Chat">
       </button>`
    : '';
```

**Step 3 — Insert into button area** for the CREATED column (in the `buttonArea` template, after other buttons):
```javascript
${chatBtn}
```

### Click Handler

#### [MODIFY] `src/webview/kanban.html`
- **Context:** The column-icon-btn click handler switch statement (around line 1386).
- **Logic:** Add a `chatCopyPrompt` case that gets selected plans (or empty array if none) and posts to backend.
- **Implementation:**

Add new case:
```javascript
case 'chatCopyPrompt': {
    const ids = getSelectedInColumn(column);
    postKanbanMessage({ type: 'chatCopyPrompt', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
    break;
}
```

Note: Unlike other handlers, this does NOT return early on empty `ids` — the backend generates a valid prompt even without specific plans.

### Backend Message Handler

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The webview message handler switch statement.
- **Logic:**
  1. Resolve workspace root.
  2. If session IDs provided, look up plan cards to get topics and file paths.
  3. Build a prompt string referencing `.agent/workflows/chat.md` and listing the selected plans.
  4. Write prompt to clipboard.
  5. Show success info message.
- **Implementation:**

Add new case (near other clipboard-related handlers):
```typescript
case 'chatCopyPrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }

    const chatWorkflowPath = '.agent/workflows/chat.md';
    let planSection = '';

    if (Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0) {
        await this._refreshBoard(workspaceRoot);
        const selectedCards = this._lastCards.filter(card =>
            card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
        );
        if (selectedCards.length > 0) {
            const planLines = selectedCards.map(card => {
                const absPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
                return `- [${card.topic}] Plan File: ${absPath}`;
            }).join('\n');
            planSection = `\n\n## Plans to Discuss\n${planLines}\n\nPlease read each plan file above before starting the discussion.`;
        }
    }

    const prompt = `/chat

Please enter the chat workflow defined at: ${chatWorkflowPath}

We will be discussing plans and requirements.${planSection}`;

    await vscode.env.clipboard.writeText(prompt);
    const count = Array.isArray(msg.sessionIds) ? msg.sessionIds.length : 0;
    const planWord = count > 0 ? ` for ${count} plan(s)` : '';
    vscode.window.showInformationMessage(`Chat prompt copied to clipboard${planWord}.`);
    break;
}
```
- **Edge Cases Handled:** Empty sessionIds array produces a valid generic prompt. Missing workspace root breaks early. Cards that don't match (e.g., deleted between click and handler) are silently filtered.

## Open Questions

None.

## Verification Plan

### Manual Verification
1. Open the Kanban board with plans in the CREATED column.
2. **Icon presence:** Verify the chat icon appears in the CREATED column header.
3. **With selection:** Select 2 plans, click the icon. Paste clipboard contents. Verify the prompt includes `/chat`, the workflow path, and both plan file paths.
4. **Without selection:** Deselect all plans, click the icon. Paste clipboard contents. Verify the prompt includes `/chat` and the workflow path but no plan list.
5. **Success message:** Verify VS Code shows "Chat prompt copied to clipboard for 2 plan(s)." (or without count for empty selection).

### Build Verification
- Run `npm run compile` — no errors.
- Verify icon file `icons/25-1-100 Sci-Fi Flat icons-65.png` exists and is bundled.

### Agent Recommendation
**Send to Coder** — Follows established clipboard-copy patterns exactly. No complex logic or state mutations.
