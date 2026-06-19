# Tickets Tab: "Diagram Prompt" Copy-to-Clipboard Button

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, feature

## Goal

Add a "Diagram Prompt" button to the tickets tab action bar in `planning.html`. When clicked, it copies a prompt to the user's clipboard that they can paste into an agent chat session. The prompt contains the selected ticket's title, URL, ID, provider, workspace root, and generic instructions for the agent to generate a mermaid diagram, render it to PNG, save it locally, and insert it as an inline image reference into the ticket's local `.md` file. The existing Push flow (`hostInlineImages` in `ImageHostingHelper.ts`) automatically uploads inline images and rewrites URLs on push — no API instructions needed in the prompt.

### Problem & Background

Mermaid diagrams are valuable for ticket refinement, but there's no UI affordance in the tickets tab to encourage this workflow. The backend infrastructure exists (`DiagramRenderer.ts`, `MermaidGenerator.ts`, `/diagram/generate` endpoint), but it's agent-facing only and not surfaced in the UI. Users currently have to manually ask agents to create diagrams, with no structured prompt or context about the ticket.

### Root Cause

The tickets action bar (`planning.html:3265-3279`) has buttons for Edit, Push, Delete, Tags, Comment, Attachments, and Open — but nothing diagram-related. There's no way for a user to quickly hand off diagram generation to an agent with the right ticket context.

## User Review Required

No user review required. This is a self-contained UI addition that follows existing patterns. No API changes, no data model changes, no breaking changes.

## Complexity Audit

### Routine
- Adding a single `<button>` element to an existing action bar in `planning.html`
- Adding a click event listener following the exact same pattern as `btn-push-ticket`, `btn-open-ticket`, etc.
- Adding a new `case` to an existing `switch` statement in `PlanningPanelProvider.ts`
- Toggling `style.display` on the button in two existing render functions
- Building a template string from already-available variables (`selectedLinearIssue`, `selectedClickUpIssue`, `lastIntegrationProvider`, `ticketsWorkspaceRoot`)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The click handler is synchronous up to the `postMessage` call. The extension host clipboard write is a single async operation with no shared mutable state.
- **Security:** The prompt string is built from ticket metadata (title, URL, ID, provider, workspace root). No user input is injected unsanitized — the prompt is copied to clipboard, not rendered as HTML. No XSS risk.
- **Side Effects:** Clipboard contents are overwritten. This is expected behavior and matches the existing `copyChatPrompt` and `copyToClipboard` patterns.
- **Dependencies & Conflicts:** No new dependencies. The button reuses the existing `strip-btn` CSS class. The clipboard write reuses `vscode.env.clipboard.writeText` (already used in 5+ places in `PlanningPanelProvider.ts`). No conflicts with existing functionality.

## Dependencies

None — this plan is self-contained and does not depend on other plans.

## Adversarial Synthesis

Key risks: (1) `getTicketsTabElements()` cache not updated — render functions that destructure button references would need raw `getElementById` calls, breaking the established pattern. (2) Missing title extraction in implementation steps despite `{title}` placeholder in the prompt template. (3) No `try/catch` on clipboard write despite the plan's own Edge Cases mentioning error handling. (4) Prompt template hardcodes `.switchboard/tickets/` path but custom tickets folder paths are supported via `LocalFolderService`. Mitigations: Add `btnDiagramPrompt` to the cached elements object, include title in extraction steps, wrap clipboard write in `try/catch`, and add a parenthetical note in the prompt template about custom folder locations.

## Proposed Changes

### `src/webview/planning.html`

**Context:** The tickets action bar lives inside `#tickets-preview-meta-bar` (line 3265). It contains `btn-edit-ticket`, `btn-save-ticket-edit`, `btn-cancel-ticket-edit`, `btn-push-ticket`, `btn-delete-ticket`, status select, `tickets-tags`, `btn-comment-ticket`, `btn-view-attachments`, and `btn-open-ticket` (line 3278).

**Implementation:** Add the new button after `btn-open-ticket` at line 3278:

```html
<button id="btn-open-ticket" class="strip-btn" style="display:none;">Open</button>
<button id="btn-diagram-prompt" class="strip-btn" style="display:none;">Diagram Prompt</button>
```

**Edge Cases:** Button is `display:none` by default. It is shown unconditionally whenever a ticket is selected (when `previewMetaBar` becomes visible). Unlike `btn-view-attachments` (conditional on attachments existing) or `btn-open-ticket` (conditional on URL existing), the Diagram Prompt button has no conditional gating — it should always be visible when any ticket is selected.

### `src/webview/planning.js`

#### Change 1: Add to `getTicketsTabElements()` cache (line ~473)

**Context:** `getTicketsTabElements()` (line 460-484) caches DOM references for all action bar buttons. `btnViewAttachments` and `btnOpenTicket` are cached at lines 471-472. The render functions destructure from this cache.

**Implementation:** Add `btnDiagramPrompt` immediately after `btnOpenTicket`:

```javascript
btnOpenTicket: document.getElementById('btn-open-ticket'),
btnDiagramPrompt: document.getElementById('btn-diagram-prompt'),
```

#### Change 2: Add click handler (after line ~5940, after `btn-open-ticket` handler)

**Context:** Action bar click handlers are registered in the initialization block around lines 5889-5968. The `btn-open-ticket` handler is at line 5937. The `btn-view-attachments` handler starts at line 5943.

**Implementation:** Add the click handler after the `btn-open-ticket` handler (after line 5940) and before the `btn-view-attachments` handler (line 5943):

```javascript
// Action bar: Diagram Prompt — copies a prompt to clipboard for agent handoff
document.getElementById('btn-diagram-prompt')?.addEventListener('click', () => {
    const provider = lastIntegrationProvider;
    if (!provider) return;
    const isLinear = provider === 'linear';
    const issue = isLinear ? selectedLinearIssue : selectedClickUpIssue;
    if (!issue) return;
    const id = isLinear ? issue.issue.id : issue.task.id;
    const title = isLinear ? (issue.issue.title || issue.issue.identifier || id) : (issue.task.name || issue.task.title || id);
    const ticketUrl = _ticketExternalUrl(provider, isLinear ? (issue.issue.identifier || id) : id, isLinear ? issue.issue.url : issue.task.url);
    const workspaceRoot = ticketsWorkspaceRoot;
    const providerName = isLinear ? 'Linear' : 'ClickUp';
    const prompt = `Generate an architectural diagram for this ticket and attach it inline.

Ticket: ${title}
URL: ${ticketUrl}
ID: ${id}
Provider: ${provider}
Workspace: ${workspaceRoot}

Instructions:
1. Ask me what kind of diagram I want (flowchart, sequence, component, etc.) and what it should represent.
2. Generate Mermaid syntax for the diagram.
3. Render the Mermaid to a PNG file. You can use mermaid-cli (\`npx @mermaid-js/mermaid-cli -i input.mmd -o output.png\`) or any other method.
4. Find the ticket's local markdown file — it's located under the \`.switchboard/tickets/${provider}/\` directory in the workspace root (or a custom tickets folder if configured), and the filename starts with \`${provider}_${id}_\`.
5. Save the PNG file in the same directory as the ticket markdown file.
6. Edit the ticket markdown file directly and insert the diagram as an inline image: \`![{diagram-name}](./{filename}.png)\` — place it where it makes sense in the description.
7. Tell me when done. I will click "Push" in the Switchboard tickets tab, which will automatically upload the image to ${providerName} and rewrite the URL.`;
    vscode.postMessage({ type: 'copyDiagramPrompt', prompt });
});
```

#### Change 3: Show button in `renderTicketsLinearTaskDetail()` (line ~6625)

**Context:** At line 6625, the function destructures `btnViewAttachments` and `btnOpenTicket` from `getTicketsTabElements()`. At line 6630-6634, `btnOpenTicket` visibility is toggled.

**Implementation:** After the `btnOpenTicket` block (after line 6634), add:

```javascript
const { btnDiagramPrompt } = getTicketsTabElements();
if (btnDiagramPrompt) {
    btnDiagramPrompt.style.display = '';
}
```

Alternatively, destructure `btnDiagramPrompt` alongside `btnViewAttachments` and `btnOpenTicket` at line 6625:
```javascript
const { btnViewAttachments, btnOpenTicket, btnDiagramPrompt } = getTicketsTabElements();
```
Then add the visibility toggle after the `btnOpenTicket` block.

#### Change 4: Show button in `renderTicketsClickUpTaskDetail()` (line ~7092)

**Context:** At line 7092, the function destructures `btnViewAttachments` and `btnOpenTicket`. At line 7097-7101, `btnOpenTicket` visibility is toggled.

**Implementation:** Same pattern as Change 3 — destructure `btnDiagramPrompt` and show it after the `btnOpenTicket` block:

```javascript
const { btnViewAttachments, btnOpenTicket, btnDiagramPrompt } = getTicketsTabElements();
```

Then after the `btnOpenTicket` block (after line 7101):
```javascript
if (btnDiagramPrompt) {
    btnDiagramPrompt.style.display = '';
}
```

#### Change 5: Hide button on no selection (automatic)

**Context:** When no ticket is selected, both render functions set `previewMetaBar.style.display = 'none'` (line 6608 for Linear, line 7075 for ClickUp). Since `btn-diagram-prompt` is a child of `previewMetaBar`, it is automatically hidden when the parent is hidden. No explicit hide call is needed.

### `src/services/PlanningPanelProvider.ts`

**Context:** The `_handleMessage` switch statement starts at line 1357. Existing clipboard-write cases include `copyChatPrompt` (line 2123), `copyToClipboard` (line 4085), and `constitutionPromptCopied` (line 2780). The `openExternalUrl` case at line 3745 shows the pattern for simple message handlers.

**Implementation:** Add a new case in the switch statement. Place it near the other ticket-related cases (e.g., after `copyToClipboard` at line ~4110, or near `openExternalUrl` at line ~3750):

```typescript
case 'copyDiagramPrompt': {
    try {
        const { prompt } = msg;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            vscode.window.showErrorMessage('Diagram prompt is empty.');
            break;
        }
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Diagram prompt copied to clipboard');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to copy diagram prompt: ${String(err)}`);
    }
    break;
}
```

**Edge Cases:**
- Empty/missing prompt string → show error, break early
- Clipboard write failure → caught by `try/catch`, error shown to user
- Message received when no panel is active → the handler is inside `_handleMessage` which is only called from the panel's `onDidReceiveMessage` listener, so this cannot happen

## Verification Plan

### Automated Tests

No new automated tests required for this change. The feature is a UI-only clipboard copy that delegates to `vscode.env.clipboard.writeText`. The existing test infrastructure does not mock the webview DOM or clipboard API.

**Manual verification steps:**
1. Open the Switchboard planning panel and navigate to the Tickets tab
2. Load tickets from either Linear or ClickUp
3. Select a ticket — verify the "Diagram Prompt" button appears in the action bar
4. Click "Diagram Prompt" — verify a notification "Diagram prompt copied to clipboard" appears
5. Paste into a text editor — verify the prompt contains the correct ticket title, URL, ID, provider, and workspace root
6. Deselect the ticket (select another or switch tabs) — verify the button disappears
7. Switch between Linear and ClickUp providers — verify the button appears/disappears correctly as tickets are selected/deselected
8. Verify the prompt text mentions the correct provider name ("ClickUp" or "Linear") in step 7

## Files Changed

| File | Change |
|------|--------|
| `src/webview/planning.html` (line ~3278) | Add `btn-diagram-prompt` button to action bar, after `btn-open-ticket` |
| `src/webview/planning.js` (line ~473) | Add `btnDiagramPrompt` to `getTicketsTabElements()` cache |
| `src/webview/planning.js` (line ~5940) | Add click handler for `btn-diagram-prompt` that builds prompt and sends `copyDiagramPrompt` message |
| `src/webview/planning.js` (line ~6625) | Show `btnDiagramPrompt` in `renderTicketsLinearTaskDetail()` |
| `src/webview/planning.js` (line ~7092) | Show `btnDiagramPrompt` in `renderTicketsClickUpTaskDetail()` |
| `src/services/PlanningPanelProvider.ts` (line ~4110) | Add `copyDiagramPrompt` case with `try/catch` for clipboard write |

## Edge Cases

- **No ticket selected** — button hidden automatically because `previewMetaBar` parent is hidden (lines 6608, 7075)
- **No integration configured** — button hidden because no tickets are loaded, `previewMetaBar` never becomes visible
- **Ticket not yet imported as local file** — the prompt instructs the agent to find the file by filename prefix `${provider}_${id}_`. If it doesn't exist, the agent should tell the user to click "Edit" first to create the local file. The prompt includes the filename pattern so the agent can search.
- **Clipboard write failure** — caught by `try/catch` in the `copyDiagramPrompt` handler, error shown via `vscode.window.showErrorMessage`
- **Custom tickets folder path** — the prompt template includes a parenthetical note: "(or a custom tickets folder if configured)". The agent will search for the file by prefix regardless of exact directory.
- **Provider switching** — non-issue. Both render functions control the same `previewMetaBar`. When provider switches, the appropriate render function runs and toggles button visibility.

## Out of Scope

- No changes to `DiagramRenderer.ts`, `MermaidGenerator.ts`, or `LocalApiServer.ts`
- No new API endpoints
- No mermaid rendering inside the webview
- No auto-generation of diagrams — the agent does the work, the button just provides context

---

**Recommendation:** Complexity 3 → Send to Intern
