# Tickets Tab: "Diagram Prompt" Copy-to-Clipboard Button

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, feature

## Goal

Add a "Diagram Prompt" button to the tickets tab action bar in `planning.html`. When clicked, it copies a prompt to the user's clipboard that they can paste into an agent chat session. The prompt contains the selected ticket's URL, ID, provider, workspace root, and generic instructions for the agent to generate a mermaid diagram, render it to PNG, save it locally, and insert it as an inline image reference into the ticket's local `.md` file. The existing Push flow (`hostInlineImages` in `ImageHostingHelper.ts`) automatically uploads inline images and rewrites URLs on push — no API instructions needed in the prompt.

### Problem & Background

Mermaid diagrams are valuable for ticket refinement, but there's no UI affordance in the tickets tab to encourage this workflow. The backend infrastructure exists (`DiagramRenderer.ts`, `MermaidGenerator.ts`, `/diagram/generate` endpoint), but it's agent-facing only and not surfaced in the UI. Users currently have to manually ask agents to create diagrams, with no structured prompt or context about the ticket.

### Root Cause

The tickets action bar (`planning.html:3266-3278`) has buttons for Edit, Push, Delete, Tags, Comment, Attachments, and Open — but nothing diagram-related. There's no way for a user to quickly hand off diagram generation to an agent with the right ticket context.

## Implementation

### 1. Add button to tickets action bar in `planning.html`

**File:** `src/webview/planning.html` (~line 3278, after `btn-open-ticket`)

Add a new button:
```html
<button id="btn-diagram-prompt" class="strip-btn" style="display:none;">Diagram Prompt</button>
```

The button is hidden by default and shown only when a ticket is selected (same pattern as `btn-view-attachments` and `btn-open-ticket`).

### 2. Add click handler in `planning.js`

**File:** `src/webview/planning.js`

Add an event listener for `btn-diagram-prompt` that:

1. Gets the current selected ticket (Linear or ClickUp) — same pattern used by other action bar handlers (e.g., `btn-push-ticket`, `btn-comment-ticket`)
2. Extracts:
   - **Ticket URL** — use the existing `_ticketExternalUrl()` helper for Linear, or the ClickUp task URL
   - **Ticket ID** — `selectedLinearIssue.issue.id` or `selectedClickUpIssue.task.id`
   - **Provider** — `lastIntegrationProvider` (`'linear'` or `'clickup'`)
   - **Workspace root** — `ticketsWorkspaceRoot`
3. Builds a prompt string (see Prompt Template below)
4. Sends a `vscode.postMessage` to the extension host to copy the prompt to clipboard (clipboard write from webview is unreliable; use the extension host's `env.clipboard.writeText`)

### 3. Handle clipboard write in `PlanningPanelProvider.ts`

**File:** `src/services/PlanningPanelProvider.ts`

Add a new case in the message switch for `copyDiagramPrompt`:

```typescript
case 'copyDiagramPrompt': {
    const { prompt } = msg;
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage('Diagram prompt copied to clipboard');
    break;
}
```

### 4. Show/hide button on ticket selection

**File:** `src/webview/planning.js`

In `renderTicketsLinearTaskDetail()` and the ClickUp equivalent (`renderTicketsClickUpTaskDetail`), toggle the button visibility alongside `btn-view-attachments` and `btn-open-ticket`:

```javascript
const btnDiagramPrompt = document.getElementById('btn-diagram-prompt');
if (btnDiagramPrompt) {
    btnDiagramPrompt.style.display = '';  // show when ticket selected
}
```

And hide it when no ticket is selected (in the early return paths where `btn-view-attachments` is hidden).

### Prompt Template

The copied prompt should look approximately like:

```
Generate an architectural diagram for this ticket and attach it inline.

Ticket: {title}
URL: {ticketUrl}
ID: {ticketId}
Provider: {provider}
Workspace: {workspaceRoot}

Instructions:
1. Ask me what kind of diagram I want (flowchart, sequence, component, etc.) and what it should represent.
2. Generate Mermaid syntax for the diagram.
3. Render the Mermaid to a PNG file. You can use mermaid-cli (`npx @mermaid-js/mermaid-cli -i input.mmd -o output.png`) or any other method.
4. Find the ticket's local markdown file — it's located under the `.switchboard/tickets/{provider}/` directory in the workspace root, and the filename starts with `{provider}_{ticketId}_`.
5. Save the PNG file in the same directory as the ticket markdown file.
6. Edit the ticket markdown file directly and insert the diagram as an inline image: `![{diagram-name}](./{filename}.png)` — place it where it makes sense in the description.
7. Tell me when done. I will click "Push" in the Switchboard tickets tab, which will automatically upload the image to {ClickUp/Linear} and rewrite the URL.
```

## Files Changed

| File | Change |
|------|--------|
| `src/webview/planning.html` | Add `btn-diagram-prompt` button to action bar |
| `src/webview/planning.js` | Add click handler, show/hide on ticket selection, build prompt string |
| `src/services/PlanningPanelProvider.ts` | Add `copyDiagramPrompt` message handler for clipboard write |

## Edge Cases

- **No ticket selected** — button hidden (same as Attachments/Open buttons)
- **No integration configured** — button hidden (no provider/ticket context)
- **Ticket not yet imported as local file** — the prompt instructs the agent to find the file, but if it doesn't exist yet, the agent should tell the user to click "Edit" first to create the local file. The prompt can include a note about this.
- **Clipboard write failure** — show error message via `vscode.window.showErrorMessage`

## Out of Scope

- No changes to `DiagramRenderer.ts`, `MermaidGenerator.ts`, or `LocalApiServer.ts`
- No new API endpoints
- No mermaid rendering inside the webview
- No auto-generation of diagrams — the agent does the work, the button just provides context
