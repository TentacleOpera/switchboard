# Linear Channel Issues: Analyst Chat & Extension Command Interface

## Goal

Introduce **Linear channel issues** — designated Linear issues that act as persistent named channels rather than plan-linked issues. Two initial channel types:

1. **Analyst channel** — comments route directly to the analyst terminal (no plan file, no column agent). The analyst replies back as a comment on the same issue, making it a two-way chat thread in Linear.
2. **Command channel** — comments are parsed as extension commands (`open kanban`, `create terminal <role>`, `dispatch <plan> <role>`, `status`). The extension executes them and posts an ack reply.

## Dependencies

None — builds on existing RemoteControlService poll infrastructure and analyst terminal dispatch.

## Problem Analysis

### Current State: All Comments Are Plan-Scoped

`RemoteControlService._ingestComments()` only processes comments on plan-linked issues. Every comment is appended to a plan file and dispatched to the plan's current column agent. There is no way to send a message directly to the analyst terminal from Linear, and no way to trigger extension-level actions remotely.

### Design: Channel Issues Polled Alongside Plan Issues

Channel issues are stored by ID in `linear-config.json`. During each remote control poll cycle, they are fetched alongside plan issues using the same `fetchIssueUpdates()` call and the same `commentCursors` mechanism for deduplication. Comments on channel issues never touch plan files — they route to dedicated handlers.

The existing `REMOTE_MODE_DIRECTIVE` in `agentPromptBuilder.ts` already instructs agents to post results as Linear comments when under remote control. The analyst channel reuses this: no additional write-back plumbing is needed — the analyst receives the message and knows to reply via `linear_api` skill.

Self-comment loops are prevented by the existing `hasMarker()` guard on outbound comments.

## Implementation

### 1. Config schema — `src/services/LinearSyncService.ts` + `linear-config.json`

Add to the Linear config type:
```typescript
analystChannelIssueId?: string;
commandChannelIssueId?: string;
```
Persist in `linear-config.json` via the existing `loadConfig()` / `saveConfig()` pattern.

### 2. REMOTE tab UI — `src/webview/kanban.html`

Add a "Channel Issues" section to the REMOTE tab (below existing board-sync config):

- **Analyst channel**: text input for Linear issue URL or ID + "Auto-create" button (creates a Linear issue titled "Switchboard Analyst Channel", stores its ID).
- **Command channel**: same pattern.
- Status indicator per channel (green = configured, grey = not set).

Webview → extension message: `{ type: 'saveChannelConfig', analystChannelIssueId, commandChannelIssueId }` → `LinearSyncService.saveConfig()`.

### 3. Poll channel issues — `src/services/RemoteControlService.ts`

After the existing plan-issue batch in `_poll()`, call new `_pollChannelIssues()`:
1. Load channel IDs from config; skip if not set.
2. Call `LinearSyncService.fetchIssueUpdates([analystId, commandId])` (same method).
3. Filter new comments via existing `commentCursors` keyed by channel issue ID.
4. Skip `hasMarker()` comments (self-comment guard).
5. Route: analyst ID → `_handleAnalystChannelComment()`; command ID → `_handleCommandChannelComment()`.

### 4. Analyst channel handler — `src/services/RemoteControlService.ts`

New `_handleAnalystChannelComment(comment)`:
1. Format: `## Linear Message (ISO timestamp)\n\n{comment.body}\n\n[Post your response as a comment on this Linear issue via linear_api skill]`
2. Call injected `sendToAnalyst(formattedMessage)`.
3. Advance cursor for analyst channel issue.

Inject: `sendToAnalyst: (msg: string) => Promise<void>`
Provided by `KanbanProvider` calling `TaskViewerProvider._handleSendAnalystMessage()`.

### 5. Command channel handler — `src/services/RemoteControlService.ts`

New `_handleCommandChannelComment(comment)`:

Parse comment body (lowercase, trim) against command table:

| Comment | Action |
|---|---|
| `open kanban` | `vscode.commands.executeCommand('switchboard.openKanban')` |
| `status` | Build summary of open plans per column, reply as comment |
| `create terminal <role>` | Create VS Code terminal for named role |
| `dispatch <plan-substring> <role>` | Find matching plan, dispatch to role |
| `context map <plan-substring>` | Trigger analyst context map for plan |

Post reply on command channel issue via `LinearSyncService.addComment(issueId, resultText + hasMarker())`.

On unknown command, reply: `Unknown command: "<text>". Available: open kanban, status, dispatch <plan> <role>, create terminal <role>, context map <plan>`.

Advance cursor.

Inject: `executeCommand: (verb: string, args: string[]) => Promise<string>`
Provided by `KanbanProvider._executeChannelCommand()`.

### 6. Wire up — `src/services/KanbanProvider.ts`

In `_getRemoteControl()`, pass new deps:
```typescript
sendToAnalyst: async (msg) =>
  this._taskViewerProvider?._handleSendAnalystMessage(msg),
executeCommand: async (verb, args) =>
  this._executeChannelCommand(verb, args),
```

Add `_executeChannelCommand(verb, args)` — switch on verb, calls appropriate `vscode.commands.executeCommand(...)` or internal method, returns result string.

## Verification

1. **Analyst channel**: Configure issue ID in REMOTE tab → post comment in Linear → next poll picks it up → analyst terminal receives formatted message → analyst posts reply comment on same issue.
2. **Command channel**: Post `status` → extension replies with board summary. Post `open kanban` → kanban panel opens.
3. **No cross-contamination**: Plan-issue comments still route to plan agents; channel comments never appear in plan files.
4. **Self-comment guard**: Extension reply comments (marked with `hasMarker()`) are not re-ingested on next poll.
5. **Cursor persistence**: Restart extension → channel cursors loaded from DB → no re-processing of old comments.
6. **Auto-create**: Click "Auto-create" for analyst channel → new Linear issue created → ID saved → status indicator turns green.
