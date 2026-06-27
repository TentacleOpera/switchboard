# Linear Channel Issues: Analyst Chat & Extension Command Interface

## Goal

Introduce **Linear channel issues** — designated Linear issues that act as persistent named channels rather than plan-linked issues. Two initial channel types:

1. **Analyst channel** — comments route directly to the analyst terminal (no plan file, no column agent). The analyst replies back as a comment on the same issue, making it a two-way chat thread in Linear.
2. **Command channel** — comments are parsed as extension commands (`open kanban`, `create terminal <role>`, `dispatch <plan> <role>`, `status`). The extension executes them and posts an ack reply.

### Problem Analysis

#### Current State: All Comments Are Plan-Scoped

`RemoteControlService._pollComments()` (line 309) only processes comments on plan-linked issues. Every comment is appended to a plan file via `_remoteDispatchComment()` (KanbanProvider line 1518) and dispatched to the plan's current column agent. There is no way to send a message directly to the analyst terminal from Linear, and no way to trigger extension-level actions remotely.

The existing `_pollComments()` fetches ALL new comments from the provider via `provider.fetchCommentDeltas(cursor)` (line 323), then routes each to the plan matching `byRemoteId.get(d.remoteId)`. Comments on issues NOT in `byRemoteId` are silently skipped (line 334: `!byRemoteId.get(d.remoteId)` → continue). Channel issue comments fall into this gap — they're fetched but discarded.

#### Design: Channel Issues Polled Alongside Plan Issues

Channel issues are stored by ID in `linear-config.json`. During each remote control poll cycle, they are fetched alongside plan issues using `LinearSyncService.fetchIssueUpdates()` (line 1195) and separate cursor keys in the DB config table for deduplication. Comments on channel issues never touch plan files — they route to dedicated handlers.

The existing `REMOTE_MODE_DIRECTIVE` in `agentPromptBuilder.ts` (line 310) already instructs agents to post results as Linear comments when under remote control. The analyst channel reuses this: no additional write-back plumbing is needed — the analyst receives the message and knows to reply via `linear_api` skill.

Self-comment loops are prevented by the existing `hasMarker()` guard (commentMarker.ts line 26) on outbound comments — used by `postManagedComment()` (LinearSyncService line 1182) which stamps the marker via `stampMarker()` (commentMarker.ts line 20). On inbound, `LinearRemoteProvider.fetchCommentDeltas()` (line 95) sets `authoredBySelf: hasMarker(body)`, and `_pollComments()` skips those (line 334).

## Metadata

**Tags:** backend, api, ui, feature
**Complexity:** 6

## User Review Required

- Confirm that channel issues are Linear-only (not Notion) for the initial implementation.
- Confirm the command table (open kanban, status, create terminal, dispatch, context map) covers the desired initial command set.
- Confirm that auto-create should create the Linear issue in the configured team (no project assignment).

## Complexity Audit

### Routine
- Adding two optional fields to `LinearConfig` type + `_normalizeConfig()` + `_createEmptyConfig()` — follows existing pattern exactly.
- REMOTE tab UI: adding a "Channel Issues" subsection with text inputs and auto-create buttons — standard webview HTML/JS.
- Webview message handler for `saveChannelConfig` — mirrors existing `setRemoteConfig` handler pattern.
- `_executeChannelCommand()` switch statement — straightforward command dispatch.

### Complex / Risky
- **Cursor architecture for channel issues**: The existing `_pollComments()` uses a single cursor per provider kind (`remote.commentCursor.linear`). Channel issues need their own cursor keys (e.g. `remote.channelCommentCursor.linear`) and a separate seen-set, or the existing `_pollComments()` must be refactored to route channel comments in-band. The plan opts for a separate `_pollChannelIssues()` method with its own cursors — this avoids touching the existing plan-comment path but means two separate comment-fetch passes per poll cycle.
- **`_handleSendAnalystMessage` is `private`** (TaskViewerProvider line 15940): KanbanProvider cannot call it directly. Requires either making it public, adding a public wrapper, or routing through a different mechanism.
- **Command channel security**: Parsing untrusted comment body as commands. Must validate/sanitize inputs (e.g. `dispatch` args, `create terminal` role name) to prevent injection.
- **`fetchIssueUpdates` vs `fetchCommentDeltas`**: The plan calls `fetchIssueUpdates([analystId, commandId])` which fetches both state AND comments for specific issue IDs. This is a different API path than the existing `fetchCommentDeltas()` which queries the `comments` entity globally. Both paths can see the same comments — the seen-sets must be coordinated to avoid double-processing.

## Edge-Case & Dependency Audit

### Race Conditions
- **Dual cursor advance**: `_pollComments()` and `_pollChannelIssues()` both process comments from the same Linear team. If both run concurrently, a comment could be processed twice. Mitigation: `_pollChannelIssues()` runs AFTER `_pollComments()` within the same `_poll()` call (sequential, not parallel), and uses its own cursor/seen-set namespace.
- **Config change mid-poll**: If the user changes `analystChannelIssueId` while a poll is in progress, the new ID won't be picked up until the next poll cycle. This is benign — same pattern as existing board-list changes.

### Security
- **Command injection**: The command channel parses untrusted text. Role names and plan substrings in `dispatch`/`create terminal` must be validated against known roles/plans. No arbitrary shell execution.
- **Auto-create writes to Linear**: The auto-create button creates a Linear issue via API. No user content is injected into the issue title (hardcoded "Switchboard Analyst Channel" / "Switchboard Command Channel").

### Side Effects
- **Analyst channel dispatch triggers terminal focus**: `_handleSendAnalystMessage` focuses the analyst terminal (line 15986). This is acceptable — same behavior as the sidebar "Send to Analyst" button.
- **Command channel `open kanban` opens a panel**: This is the intended behavior, but it's a UI side effect triggered remotely. No mitigation needed — it's the point.

### Dependencies & Conflicts
- **Linear-only**: Channel issues use `LinearSyncService.fetchIssueUpdates()` which is Linear-specific. Notion provider does not have an equivalent method. The feature is gated behind `config.provider === 'linear'` in `_pollChannelIssues()`.
- **`_handleSendAnalystMessage` visibility**: Currently `private` on TaskViewerProvider. Must be made `public` or wrapped. Changing to `public` is the minimal change — the method is already called from the sidebar webview handler (line 9442) via `this._handleSendAnalystMessage()`.
- **`postManagedComment` vs manual marker**: The original plan says `addComment(issueId, resultText + hasMarker())` but the correct approach is `postManagedComment(issueId, resultText)` which calls `stampMarker()` internally (line 1185). Manually concatenating `hasMarker()` is wrong — `hasMarker()` is a boolean check function, not a string. The correct marker injection is via `stampMarker()` or `postManagedComment()`.

## Dependencies

None — builds on existing RemoteControlService poll infrastructure and analyst terminal dispatch.

## Adversarial Synthesis

Key risks: dual-cursor comment processing could double-dispatch if seen-sets diverge; `_handleSendAnalystMessage` is private and needs visibility change; command channel parses untrusted input requiring strict validation. Mitigations: sequential poll execution with separate cursor namespaces, public wrapper for analyst dispatch, whitelist-based command parsing with no shell execution.

## Proposed Changes

### `src/services/LinearSyncService.ts`

**Context**: `LinearConfig` interface (line 17–34) defines the persisted config shape. `_normalizeConfig()` (line 202) normalizes raw config. `_createEmptyConfig()` (line 181) seeds defaults. `fetchIssueUpdates()` (line 1195) fetches state+comments for specific issue IDs. `postManagedComment()` (line 1182) posts a marker-stamped comment.

**Logic**: Add two optional fields to `LinearConfig` for channel issue IDs. Normalize them as optional strings. No changes to `fetchIssueUpdates` or `postManagedComment` — they already support the needed operations.

**Implementation**:
1. Add to `LinearConfig` interface (after line 33):
   ```typescript
   analystChannelIssueId?: string;   // UUID of the Linear issue used as analyst chat channel
   commandChannelIssueId?: string;   // UUID of the Linear issue used as command channel
   ```
2. Add to `_normalizeConfig()` return object (after line 239):
   ```typescript
   analystChannelIssueId: raw.analystChannelIssueId || undefined,
   commandChannelIssueId: raw.commandChannelIssueId || undefined,
   ```
3. No changes to `_createEmptyConfig()` — optional fields default to undefined.

**Edge Cases**: Existing configs without these fields load fine (optional, undefined). Migration not needed — these are new optional keys.

### `src/webview/kanban.html`

**Context**: REMOTE tab content starts at line 2545 (`<div id="remote-tab-content">`). The tab includes provider selector, workspace selector, board checkboxes, ping mode radios, and frequency slider. The `renderRemoteConfig()` JS function (line ~6959) hydrates the UI from the config payload. `remoteCollectConfig()` (line 6973) reads the UI state. `remoteAutosave()` (line 6999) sends `setRemoteConfig` messages.

**Logic**: Add a "Channel Issues" subsection below the existing board-sync config, visible only when provider is `linear`. Each channel has a text input for the issue ID/URL and an auto-create button.

**Implementation**:
1. Add HTML after the ping-frequency section (after line ~2614, before `remote-config-status`):
   ```html
   <!-- Channel Issues (Linear only) -->
   <div id="remote-channel-issues" style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border-color, rgba(127,127,127,0.2));">
       <div style="font-size:11px; color:var(--text-secondary); margin-bottom:8px;">Channel Issues — designated Linear issues for direct analyst chat and extension commands</div>
       <label style="display:block; margin-bottom:8px;">
           <span style="display:block; margin-bottom:2px; font-size:10px; color:var(--text-secondary);">Analyst channel issue ID or URL</span>
           <div style="display:flex; gap:6px; align-items:center;">
               <input type="text" id="remote-analyst-channel" class="workspace-project-select" placeholder="e.g. SW-42 or UUID" style="flex:1;">
               <button id="btn-auto-create-analyst-channel" class="strip-btn" style="font-size:10px;">Auto-create</button>
               <span id="analyst-channel-status" style="font-size:10px;">⚪</span>
           </div>
       </label>
       <label style="display:block; margin-bottom:8px;">
           <span style="display:block; margin-bottom:2px; font-size:10px; color:var(--text-secondary);">Command channel issue ID or URL</span>
           <div style="display:flex; gap:6px; align-items:center;">
               <input type="text" id="remote-command-channel" class="workspace-project-select" placeholder="e.g. SW-43 or UUID" style="flex:1;">
               <button id="btn-auto-create-command-channel" class="strip-btn" style="font-size:10px;">Auto-create</button>
               <span id="command-channel-status" style="font-size:10px;">⚪</span>
           </div>
       </label>
   </div>
   ```
2. Show/hide based on provider in `applyRemoteProviderUi()` (line ~6990):
   ```javascript
   const channelSection = document.getElementById('remote-channel-issues');
   if (channelSection) channelSection.style.display = provider === 'linear' ? 'block' : 'none';
   ```
3. Hydrate in `renderRemoteConfig()` — set input values from `msg.config.analystChannelIssueId` / `msg.commandChannelIssueId`, update status indicators (🟢 if set, ⚪ if not).
4. Include channel IDs in `remoteCollectConfig()` return object.
5. Add auto-create button handlers that send `{ type: 'autoCreateChannelIssue', channel: 'analyst' | 'command' }` messages.
6. Handle `autoCreateChannelIssueResult` messages to update the input and status indicator.

**Edge Cases**: User pastes a Linear URL like `https://linear.app/team/issue/SW-42/abc` — must parse to extract the identifier or UUID. The `_isIssueIdentifier()` method (LinearSyncService line 464) validates `SW-42` format. For UUIDs, the input is used directly with `fetchIssueUpdates`.

### `src/services/RemoteControlService.ts`

**Context**: `_poll()` (line 192) is the main poll cycle. It calls `_pollState()` then `_pollComments()`. `RemoteControlDeps` (line 62) defines injected dependencies. Cursor keys are per-provider-kind (line 58–60). The seen-set is per-provider-kind (line 60).

**Logic**: Add a `_pollChannelIssues()` method that runs after `_pollComments()` in `_poll()`. It uses its own cursor keys and seen-set namespace to avoid interfering with plan-comment processing. Channel issues are Linear-only.

**Implementation**:
1. Add to `RemoteControlDeps` interface (after line 71):
   ```typescript
   /** Send a message to the analyst terminal. */
   sendToAnalyst?: (msg: string) => Promise<void>;
   /** Execute a channel command and return the result text. */
   executeChannelCommand?: (verb: string, args: string[]) => Promise<string>;
   /** Load the Linear config (for channel issue IDs). */
   getLinearConfig?: () => Promise<import('./LinearSyncService').LinearConfig | null>;
   /** Post a managed (marker-stamped) comment on a Linear issue. */
   postManagedComment?: (issueId: string, body: string) => Promise<{ success: boolean; error?: string }>;
   /** Fetch issue updates for specific channel issue IDs. */
   fetchChannelIssueUpdates?: (issueIds: string[]) => Promise<Record<string, { comments: Array<{ id: string; body: string; createdAt: string; author: string }> }>>;
   ```
2. Add cursor/seen key helpers (after line 60):
   ```typescript
   const channelCommentCursorKey = (kind: RemoteProviderKind) => `remote.channelCommentCursor.${kind}`;
   const channelCommentSeenKey = (kind: RemoteProviderKind) => `remote.channelCommentSeen.${kind}`;
   ```
3. In `_poll()` (after line 211, `await this._pollComments(...)`):
   ```typescript
   await this._pollChannelIssues(db, provider);
   ```
4. Add `_pollChannelIssues()` method:
   ```typescript
   private async _pollChannelIssues(db: KanbanDatabase, provider: RemoteProvider): Promise<void> {
       if (provider.kind !== 'linear') { return; } // Linear-only for now
       if (!this._deps.getLinearConfig || !this._deps.sendToAnalyst || !this._deps.executeChannelCommand || !this._deps.postManagedComment || !this._deps.fetchChannelIssueUpdates) { return; }

       const config = await this._deps.getLinearConfig();
       const channelIds = [config?.analystChannelIssueId, config?.commandChannelIssueId].filter(Boolean) as string[];
       if (channelIds.length === 0) { return; }

       // Use separate cursor namespace for channel issues
       const cursorKey = channelCommentCursorKey(provider.kind);
       const cursor = await db.getConfig(cursorKey);
       if (!cursor) {
           await db.setConfig(cursorKey, new Date().toISOString());
           return; // seed-on-first-poll
       }

       // Fetch updates for channel issues specifically
       const updates = await this._deps.fetchChannelIssueUpdates(channelIds);

       // Load seen-set for dedup
       const seen = await this._loadChannelSeen(provider.kind);
       let advanced = cursor;

       for (const [issueId, update] of Object.entries(updates)) {
           const isAnalyst = issueId === config?.analystChannelIssueId;
           const isCommand = issueId === config?.commandChannelIssueId;
           if (!isAnalyst && !isCommand) { continue; }

           for (const comment of update.comments) {
               if (hasMarker(comment.body) || seen.has(comment.id)) {
                   seen.add(comment.id);
                   if (comment.createdAt > advanced) { advanced = comment.createdAt; }
                   continue;
               }

               try {
                   if (isAnalyst) {
                       await this._handleAnalystChannelComment(comment);
                   } else if (isCommand) {
                       await this._handleCommandChannelComment(comment, issueId);
                   }
                   seen.add(comment.id);
                   if (comment.createdAt > advanced) { advanced = comment.createdAt; }
               } catch (e) {
                   this._log(`Channel comment handler failed for ${comment.id} — cursor NOT advanced: ${e instanceof Error ? e.message : String(e)}`);
                   break; // stop processing, retry next poll
               }
           }
       }

       await this._saveChannelSeen(provider.kind, seen);
       if (advanced !== cursor) { await db.setConfig(cursorKey, advanced); }
   }
   ```
5. Add `_handleAnalystChannelComment(comment)`:
   ```typescript
   private async _handleAnalystChannelComment(comment: { id: string; body: string; createdAt: string }): Promise<void> {
       const stamp = new Date().toISOString();
       const formatted = `## Linear Message (${stamp})\n\n${comment.body}\n\n[Post your response as a comment on this Linear issue via linear_api skill]`;
       await this._deps.sendToAnalyst?.(formatted);
   }
   ```
6. Add `_handleCommandChannelComment(comment, issueId)`:
   ```typescript
   private async _handleCommandChannelComment(comment: { id: string; body: string; createdAt: string }, issueId: string): Promise<void> {
       const text = comment.body.toLowerCase().trim();
       const parts = text.split(/\s+/);
       const verb = parts[0] || '';
       const args = parts.slice(1);

       let result: string;
       try {
           result = await this._deps.executeChannelCommand?.(verb, args) || 'Command execution failed.';
       } catch (e) {
           result = `Error: ${e instanceof Error ? e.message : String(e)}`;
       }

       await this._deps.postManagedComment?.(issueId, result);
   }
   ```
7. Add `_loadChannelSeen` / `_saveChannelSeen` (mirrors existing `_loadSeen` / `_saveSeen` pattern but uses `channelCommentSeenKey`).

**Edge Cases**: If `sendToAnalyst` or `executeChannelCommand` deps are not provided (e.g. KanbanProvider doesn't wire them), `_pollChannelIssues` exits early — no crash. If `fetchChannelIssueUpdates` fails, the method logs and returns — same error pattern as existing poll methods. The `hasMarker` import is needed from `./commentMarker` (already imported in `LinearRemoteProvider` but not in `RemoteControlService` — add the import).

### `src/services/TaskViewerProvider.ts`

**Context**: `_handleSendAnalystMessage()` at line 15940 is `private`. Signature: `private async _handleSendAnalystMessage(instruction: string, resultRole: 'analyst' | 'analystMap' = 'analyst'): Promise<boolean>`.

**Logic**: Make the method accessible to KanbanProvider for channel-issue routing.

**Implementation**:
1. Change visibility from `private` to `public` on line 15940:
   ```typescript
   public async _handleSendAnalystMessage(
       instruction: string,
       resultRole: 'analyst' | 'analystMap' = 'analyst'
   ): Promise<boolean> {
   ```
   **Clarification**: Alternatively, add a thin public wrapper `public async sendAnalystMessage(instruction: string): Promise<boolean>` that delegates to `_handleSendAnalystMessage(instruction)`. This preserves the private naming convention but adds surface area. The simpler approach is changing visibility — the method is already effectively public via the webview message handler (line 9442).

**Edge Cases**: The `resultRole` parameter defaults to `'analyst'` — channel messages should use this default (not `'analystMap'`). The method returns `boolean` for success/failure — the channel handler should log but not crash on failure.

### `src/services/KanbanProvider.ts`

**Context**: `_getRemoteControl()` (line 1438) creates `RemoteControlService` with `RemoteControlDeps`. `_taskViewerProvider` (line 154) is the TaskViewerProvider reference. `_remoteDispatchComment()` (line 1518) shows the existing comment-routing pattern.

**Logic**: Wire the new deps into `_getRemoteControl()` and add `_executeChannelCommand()`.

**Implementation**:
1. In `_getRemoteControl()` (line 1442, inside the `new RemoteControlService({...})` call), add after `onComment` (line 1466):
   ```typescript
   sendToAnalyst: async (msg) => {
       if (this._taskViewerProvider) {
           await this._taskViewerProvider._handleSendAnalystMessage(msg);
       }
   },
   executeChannelCommand: async (verb, args) => {
       return this._executeChannelCommand(verb, args, resolved);
   },
   getLinearConfig: async () => {
       return this._getLinearService(resolved).loadConfig();
   },
   postManagedComment: async (issueId, body) => {
       return this._getLinearService(resolved).postManagedComment(issueId, body);
   },
   fetchChannelIssueUpdates: async (issueIds) => {
       return this._getLinearService(resolved).fetchIssueUpdates(issueIds);
   },
   ```
2. Add `_executeChannelCommand()` method:
   ```typescript
   private async _executeChannelCommand(verb: string, args: string[], workspaceRoot: string): Promise<string> {
       switch (verb) {
           case 'open':
               if (args[0] === 'kanban') {
                   vscode.commands.executeCommand('switchboard.openKanban');
                   return 'Kanban panel opened.';
               }
               return `Unknown open target: ${args[0] || '(none)'}. Available: kanban.`;
           case 'status': {
               const db = this._getKanbanDb(workspaceRoot);
               const workspaceId = await db.getWorkspaceId();
               if (!workspaceId) { return 'No workspace configured.'; }
               const plans = await db.getAllPlans(workspaceId);
               const active = plans.filter(p => p.status !== 'deleted');
               const byColumn: Record<string, number> = {};
               for (const p of active) {
                   const col = p.kanbanColumn || 'UNKNOWN';
                   byColumn[col] = (byColumn[col] || 0) + 1;
               }
               const lines = Object.entries(byColumn).map(([col, n]) => `${col}: ${n}`);
               return `Board status (${active.length} active plans):\n${lines.join('\n')}`;
           }
           case 'create':
               if (args[0] === 'terminal' && args[1]) {
                   const validRoles = ['planner', 'lead', 'coder', 'intern', 'reviewer', 'analyst', 'chat'];
                   const role = args[1].toLowerCase();
                   if (!validRoles.includes(role)) {
                       return `Unknown role: ${role}. Available: ${validRoles.join(', ')}.`;
                   }
                   vscode.commands.executeCommand('switchboard.createTerminalForRole', role);
                   return `Terminal creation requested for role: ${role}.`;
               }
               return `Usage: create terminal <role>. Available roles: planner, lead, coder, intern, reviewer, analyst, chat.`;
           case 'dispatch': {
               if (args.length < 2) { return 'Usage: dispatch <plan-substring> <role>'; }
               const planSubstring = args.slice(0, -1).join(' ');
               const role = args[args.length - 1].toLowerCase();
               const db = this._getKanbanDb(workspaceRoot);
               const workspaceId = await db.getWorkspaceId();
               if (!workspaceId) { return 'No workspace configured.'; }
               const plans = await db.getAllPlans(workspaceId);
               const match = plans.find(p =>
                   p.status !== 'deleted' &&
                   (p.topic?.toLowerCase().includes(planSubstring) || p.planFile?.toLowerCase().includes(planSubstring))
               );
               if (!match) { return `No plan matching "${planSubstring}" found.`; }
               const sessionId = match.sessionId || match.planId;
               await this._remoteDispatchColumnAgent(workspaceRoot, sessionId, match.kanbanColumn);
               return `Dispatched plan "${match.topic}" to ${match.kanbanColumn} column agent.`;
           }
           case 'context': {
               if (args[0] !== 'map' || !args[1]) { return 'Usage: context map <plan-substring>'; }
               const planSubstring = args.slice(1).join(' ');
               const db = this._getKanbanDb(workspaceRoot);
               const workspaceId = await db.getWorkspaceId();
               if (!workspaceId) { return 'No workspace configured.'; }
               const plans = await db.getAllPlans(workspaceId);
               const match = plans.find(p =>
                   p.status !== 'deleted' &&
                   (p.topic?.toLowerCase().includes(planSubstring) || p.planFile?.toLowerCase().includes(planSubstring))
               );
               if (!match) { return `No plan matching "${planSubstring}" found.`; }
               if (this._taskViewerProvider) {
                   await this._taskViewerProvider._handleSendAnalystMessage(
                       `Generate a context map for plan: ${match.planFile}`,
                       'analystMap'
                   );
                   return `Context map requested for "${match.topic}".`;
               }
               return 'Analyst not available.';
           }
           default:
               return `Unknown command: "${verb} ${args.join(' ')}". Available: open kanban, status, create terminal <role>, dispatch <plan> <role>, context map <plan>.`;
       }
   }
   ```
3. Add webview message handler for `saveChannelConfig` (in the message switch, near line 5435):
   ```typescript
   case 'saveChannelConfig': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (workspaceRoot && (msg.analystChannelIssueId !== undefined || msg.commandChannelIssueId !== undefined)) {
           const linear = this._getLinearService(workspaceRoot);
           const config = await linear.loadConfig();
           if (config) {
               if (msg.analystChannelIssueId !== undefined) {
                   config.analystChannelIssueId = msg.analystChannelIssueId || undefined;
               }
               if (msg.commandChannelIssueId !== undefined) {
                   config.commandChannelIssueId = msg.commandChannelIssueId || undefined;
               }
               await linear.saveConfig(config);
           }
       }
       break;
   }
   case 'autoCreateChannelIssue': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (workspaceRoot && msg.channel) {
           const linear = this._getLinearService(workspaceRoot);
           const config = await linear.loadConfig();
           if (config?.setupComplete) {
               const title = msg.channel === 'analyst'
                   ? 'Switchboard Analyst Channel'
                   : 'Switchboard Command Channel';
               const description = msg.channel === 'analyst'
                   ? 'Post comments here to chat with the Switchboard analyst terminal.'
                   : 'Post commands here to control the Switchboard extension. Available: open kanban, status, create terminal <role>, dispatch <plan> <role>, context map <plan>.';
               try {
                   const issue = await linear.createIssue(config.teamId, title, { description });
                   if (issue?.id) {
                       if (msg.channel === 'analyst') {
                           config.analystChannelIssueId = issue.id;
                       } else {
                           config.commandChannelIssueId = issue.id;
                       }
                       await linear.saveConfig(config);
                       this._panel?.webview.postMessage({
                           type: 'autoCreateChannelIssueResult',
                           channel: msg.channel,
                           issueId: issue.id,
                           identifier: issue.identifier,
                           success: true
                       });
                   }
               } catch (e) {
                   this._panel?.webview.postMessage({
                       type: 'autoCreateChannelIssueResult',
                       channel: msg.channel,
                       success: false,
                       error: e instanceof Error ? e.message : String(e)
                   });
               }
           }
       }
       break;
   }
   ```

**Edge Cases**: `_executeChannelCommand` must handle missing workspace, empty args, and unknown roles gracefully — always returning a string (never throwing). The `dispatch` command uses substring matching which could match multiple plans — it picks the first match. **Clarification**: A future enhancement could list multiple matches, but for the initial implementation, first-match is sufficient.

### `src/services/agentPromptBuilder.ts`

**Context**: `REMOTE_MODE_DIRECTIVE` (line 310) is already injected into all role prompts when `remoteControlActive` is true. No changes needed to this file — the analyst already knows to reply via `linear_api` skill because of this directive.

**Implementation**: No changes required.

## Verification Plan

1. **Analyst channel**: Configure issue ID in REMOTE tab → post comment in Linear → next poll picks it up → analyst terminal receives formatted message → analyst posts reply comment on same issue.
2. **Command channel**: Post `status` → extension replies with board summary. Post `open kanban` → kanban panel opens.
3. **No cross-contamination**: Plan-issue comments still route to plan agents; channel comments never appear in plan files.
4. **Self-comment guard**: Extension reply comments (stamped by `postManagedComment`) are not re-ingested on next poll — `fetchIssueUpdates` returns them but `hasMarker()` filtering in `_pollChannelIssues` skips them.
5. **Cursor persistence**: Restart extension → channel cursors loaded from DB → no re-processing of old comments.
6. **Auto-create**: Click "Auto-create" for analyst channel → new Linear issue created → ID saved → status indicator turns green.
7. **Notion provider**: When provider is Notion, channel issues section is hidden and `_pollChannelIssues` exits early — no errors.
8. **Unknown command**: Post `foo bar` → extension replies with unknown-command help text.
9. **Missing analyst terminal**: Post to analyst channel with no analyst terminal assigned → `_handleSendAnalystMessage` returns false → logged but no crash.

### Automated Tests

- **Test file**: `src/test/channel-issues.test.js` (new)
  - Test `_pollChannelIssues` skips when provider is Notion
  - Test `_pollChannelIssues` skips when no channel IDs configured
  - Test `_handleCommandChannelComment` parses known commands correctly
  - Test `_handleCommandChannelComment` returns help for unknown commands
  - Test `_executeChannelCommand` validates role names
  - Test cursor key namespacing (channel cursors don't collide with plan cursors)
- **Existing test files to verify no regression**:
  - `src/test/analyst-direct-dispatch-regression.test.js` — verify `_handleSendAnalystMessage` still works after visibility change
  - `src/test/context-map-batching-regression.test.js` — verify analyst map dispatch still works

## Uncertain Assumptions

> **Research completed.** The user ran web research (findings in `docs/imported_document_2026_06_27t11_27_53.md`) and the results have been incorporated below.

| Assumption | Verdict | Plan Impact |
|:---|:---|:---|
| `LinearSyncService.createIssue()` method exists | **PARTIALLY RESOLVED.** Research confirms the raw `issueCreate` GraphQL mutation shape (`IssueCreateInput` with `title`, `description`, `teamId`; issues without `stateId` route to backlog/triage). | If `LinearSyncService` has no convenience wrapper, the auto-create feature should use `graphqlRequest()` with the `issueCreate` mutation directly. The implementer must verify whether a wrapper exists; if not, the raw GraphQL path is confirmed viable. |
| `switchboard.createTerminalForRole` / `switchboard.openKanban` commands registered | **UNRESOLVED — VS Code code concern, not Linear API.** | Implementer must grep the codebase for these command registrations. If unregistered, use alternative terminal-creation / panel-reveal mechanisms. Not researchable via Linear docs. |
| **Comments do NOT bump parent issue `updatedAt`** | **CONFIRMED — CRITICAL for this plan.** Adding/editing a comment does NOT modify the parent issue's `updatedAt` timestamp (corroborated by the `notion-remote-control-and-delta-polling.md` plan). | **HIGH IMPACT:** `_pollChannelIssues()` must NOT rely on `fetchIssueUpdates()` filtering by `updatedAt` to detect new comments on channel issues — a new comment won't bump `updatedAt`, so an `updatedAt`-based delta query would miss it. Channel comments must be polled via a separate comment-delta query (e.g. `comments(filter:{ createdAt:{ gt: $cursor }})`) keyed by the channel issue ID, NOT via issue-level `updatedAt` deltas. The plan's existing `commentCursors` / `fetchCommentDeltas` approach is correct IF it queries comments independently of issue `updatedAt`. Verify `fetchIssueUpdates()` fetches comments regardless of `updatedAt`, or add a dedicated channel-comment fetch. |
| Linear stores comment/description bodies verbatim as Markdown (incl. HTML comment markers) | **CONFIRMED.** Linear does not strip HTML comment blocks (`<!-- marker -->`). | `hasMarker()` / `postManagedComment()` marker-based loop prevention is SOUND — markers persist across sync cycles. No change needed. |
| GraphQL subscriptions over WebSocket now available | **CONFIRMED — new capability.** `graphql-ws` protocol subscriptions in the public API; webhooks on all tiers (incl. free) but need public endpoint. | **Future optimization, not v1.** A follow-up plan could subscribe to comment-create events on channel issues instead of polling, eliminating poll overhead and the `updatedAt` gap entirely. Noted as future enhancement; v1 polling design remains valid with the comment-delta fix above. |
| Linear rate limits | **CONFIRMED.** Personal keys: 2,500 req/hour, 3M complexity/hour, 10k complexity/single-query. Connections multiply cost by pagination limit. | Constrain pagination explicitly (e.g. `first: 10`) on channel-comment queries to avoid complexity-budget drain. Not a blocker for v1 poll cadence. |

**Summary:** The critical Linear-API finding is that **comments don't bump `updatedAt`** — the channel-comment poll path MUST query comments independently of issue `updatedAt` deltas. The marker-based loop prevention is confirmed sound. The `createIssue` concern is resolvable via raw GraphQL. The two VS Code command questions remain open (code concerns, not Linear API). No further Linear research needed; implementer should grep for the VS Code commands.

---

**Recommendation**: Complexity 6 → Send to Coder
