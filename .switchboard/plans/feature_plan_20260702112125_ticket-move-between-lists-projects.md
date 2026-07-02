# Move Tickets Between Lists/Projects (ClickUp and Linear)

**Plan ID:** a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d

## Goal

### Problem

There is no way to move a ticket in ClickUp or Linear to another location — i.e., move a ClickUp task to a different list, or move a Linear issue to a different project. This is a task done all the time in project management: triaging incoming tickets into the right backlog, reorganizing after a restructure, moving misplaced tickets, handing off to another team's project. Users must leave the Switchboard extension and go to the ClickUp/Linear web app to change a ticket's location.

### Background Context

Switchboard integrates with both ClickUp and Linear through dedicated sync services (`ClickUpSyncService.ts`, `LinearSyncService.ts`) that communicate with a `LocalApiServer` proxy. The proxy exposes REST endpoints that agent skills shell out to via `sb_api_call.sh`. The webview (`planning.js`, `planning.html`) renders ticket cards in a sidebar with action buttons (Edit, Push, Delete, Comment, Attachments, Subtask, etc.).

**ClickUp status:** The `updateTask` method in `ClickUpSyncService.ts` (line 1400) supports name, description, status, assignees, due_date, priority, tags, and parent — but **not listId**. The standard ClickUp `PUT /api/v2/task/{taskId}` endpoint does not support changing a task's list. ClickUp has a **dedicated move endpoint** at `PUT /api/v3/workspaces/{workspace_id}/tasks/{task_id}/home_list/{list_id}` (confirmed at developer.clickup.com/reference/movetask). The codebase already has an `httpRequestV3` method (line 2311) used for doc operations. The service already has `getSpaces()`, `getFolders(spaceId)`, and `getLists(spaceId, folderId?)` methods (lines 1016, 1036, 1060) that can populate a target-list picker. The `_taskListIndex` reverse map (line 170) tracks taskId → listId for cache invalidation.

**Linear status:** The `LinearSyncService.ts` has dedicated update methods for state (`updateIssueState`, line 1064), labels (`updateIssueLabels`, line 1098), parent (`updateIssueParent`, line 1130), and description (`updateIssueDescription`, line 1557) — but **no method to change an issue's project**. Linear's `issueUpdate` GraphQL mutation does support `projectId` as an input field, so the API capability exists but is not exposed. The service already has `getAvailableProjects()` (line 551) that returns `{ id, name }[]` for the configured team, and `_issueProjectIndex` (line 138) tracks issueId → projectId for cache invalidation. Note: Linear does **not** support changing `teamId` on an existing issue — issues are team-scoped by design. This plan covers project moves only; cross-team moves require creating a new issue.

### Root Cause Analysis

1. **ClickUp:** The `updateTask` method was built to wrap the standard `PUT /api/v2/task/{taskId}` endpoint, which does not support list changes. The dedicated ClickUp move endpoint (`PUT /api/v3/.../home_list/{list_id}`) was never integrated. The `httpRequestV3` method exists but is only used for ClickUp Docs operations. No `moveTask` method, no LocalApiServer endpoint, no skill file, and no UI button exist for list moves.

2. **Linear:** The `issueUpdate` GraphQL mutation supports `projectId`, and the service already has `graphqlRequest` infrastructure plus `getAvailableProjects()` for listing projects. But no `updateIssueProject` method was ever added — the update methods cover state, labels, parent, and description but omit project. No LocalApiServer endpoint, no skill file, and no UI button exist for project moves.

## Metadata

- **Tags:** feature, backend, frontend, clickup, linear, tickets
- **Complexity:** 5

## User Review Required

Yes — review the UI approach for the move action (Proposed Change #5). The proposed approach is a "Move" button on each ticket card that opens a popover with a searchable dropdown of available lists (ClickUp) or projects (Linear). Confirm this is the preferred UX vs. a full modal dialog. Also confirm that cross-team Linear moves (not supported by the API) should be documented as a limitation rather than worked around with create-new-issue-and-close-old.

## Complexity Audit

### Routine
- Adding `moveTask` method to `ClickUpSyncService.ts` — uses the existing `httpRequestV3` method, follows the same config-check/normalize/validate/cache-invalidate pattern as `updateTask`.
- Adding `updateIssueProject` method to `LinearSyncService.ts` — follows the exact same pattern as `updateIssueState` / `updateIssueParent` (config check, ID normalization, GraphQL mutation, cache invalidation).
- Adding `PUT /task/clickup/{id}/move` and `PUT /task/linear/{id}/move` routes to `LocalApiServer.ts` — follows the existing routing + handler pattern.
- Creating `clickup_move_task.md` and `linear_move_issue.md` skill files — copy/adapt from `clickup_modify_task.md`.
- Adding "Move" button to both ClickUp and Linear ticket card render functions in `planning.js`.

### Complex / Risky
- **ClickUp status mappings**: when moving a task to a new list, the task's current status may not exist in the target list. The ClickUp move API requires `status_mappings` in that case (mapping old status → new status). The service method must either (a) fetch the target list's statuses and auto-map, or (b) let the caller provide mappings. Auto-mapping is more user-friendly but requires an extra API call.
- **ClickUp custom fields**: custom fields are list-specific. Moving to a new list may lose custom field data unless `move_custom_fields: true` is passed. The method should default to moving custom fields.
- **Cache invalidation after move**: both services must invalidate the **old** list/project cache AND the **new** list/project cache. The `_taskListIndex` / `_issueProjectIndex` reverse maps must be updated to reflect the new location.
- **Webview popover UI**: the move popover needs to load available lists (ClickUp) or projects (Linear) on demand. For ClickUp, this means traversing spaces → folders → lists (already available via `getSpaces`, `getFolders`, `getLists`). For Linear, `getAvailableProjects()` returns the list directly. The UI must handle loading states and empty results.
- **Sync map consistency**: if a moved ClickUp task or Linear issue is linked to a Switchboard plan, the sync map (planFile → taskId/issueId) remains valid — the external ID doesn't change. But the task's location in the external system changes, which may affect which list/project the sync service polls. This is handled by cache invalidation + re-fetch.

## Edge-Case & Dependency Audit

1. **ClickUp status not in target list**: the ClickUp move API returns 400 if the task's current status doesn't exist in the target list and `status_mappings` is not provided. The service method should fetch the target list's statuses, find a match (by name), and auto-generate the mapping. If no name match exists, default to the first status in the target list and warn.

2. **ClickUp custom fields mismatch**: custom fields from the source list may not exist in the target list. With `move_custom_fields: true`, ClickUp will attempt to map them. Fields that don't exist in the target will be dropped. This is acceptable — the alternative (creating custom fields in the target list) is out of scope.

3. **Linear project move to null (unassign from project)**: Linear allows setting `projectId` to `null` via `issueUpdate`, which removes the issue from its project (makes it a team-level issue). The method should support `projectId: null` for unassigning.

4. **Linear cross-team moves**: Linear issues cannot change teams. If the user wants to move an issue to a project in a different team, the API will reject it. The UI should only show projects within the configured team (which `getAvailableProjects()` already filters by `config.teamId`).

5. **ClickUp workspace ID resolution**: the move endpoint requires `workspace_id` as a path parameter. The service already has `loadWorkspaceIdIfNeeded()` (line 348) which returns the workspace ID from config or fetches it. The `moveTask` method should use this.

6. **Permission errors**: the user's ClickUp/Linear API token may lack permission to move tasks or change project. The API will return an error — the UI must display it gracefully.

7. **Ticket not yet synced**: the move action operates on ClickUp/Linear ticket IDs directly (not plan files). This works for tickets that exist in the external system regardless of kanban sync state.

8. **Existing `PUT /task/linear/{id}` route absence**: there is currently no `PUT /task/linear/{id}` route in `LocalApiServer.ts`. The routing table (around line 1004-1030) has `GET /task/linear/{id}` but no PUT. A new route must be added. Using a sub-path like `PUT /task/linear/{id}/move` avoids conflicting with a future general-purpose `PUT /task/linear/{id}`.

9. **ClickUp `httpRequestV3` vs `httpRequest`**: the default `httpRequest` method (line 2237) hits `/api/v2`. The move endpoint is v3. The `httpRequestV3` method (line 2311) hits `/api/v3` and is already used for doc operations. The `moveTask` method must use `httpRequestV3`.

10. **Webview message passing**: the webview communicates with the extension host via `postMessage`. New message types (`moveTicket`, `fetchLists`/`fetchProjects`) must be added to the message handler in `planning.js` and the corresponding receiver in the extension host.

## Dependencies

- `ClickUpSyncService.httpRequestV3` — existing v3 API call method (line 2311).
- `ClickUpSyncService.loadWorkspaceIdIfNeeded` — existing workspace ID resolver (line 348).
- `ClickUpSyncService.getSpaces` / `getFolders` / `getLists` — existing list hierarchy fetchers (lines 1016, 1036, 1060).
- `ClickUpSyncService._taskListIndex` — existing reverse map for cache invalidation (line 170).
- `LinearSyncService.graphqlRequest` — internal method used by all update methods.
- `LinearSyncService.getAvailableProjects` — existing project list fetcher (line 551).
- `LinearSyncService._issueProjectIndex` — existing reverse map for cache invalidation (line 138).
- `LocalApiServer._checkAuth` — auth pattern reused for new endpoints.
- `sb_api_call.sh` — shared shell library for agent skills.

## Proposed Changes

### 1. `src/services/ClickUpSyncService.ts` — Add `moveTask` method

Insert after `updateTask` (after line 1451):

```typescript
/**
 * Move a ClickUp task to a different list.
 * Uses the v3 move endpoint: PUT /api/v3/workspaces/{workspace_id}/tasks/{task_id}/home_list/{list_id}
 */
public async moveTask(
  taskId: string,
  targetListId: string,
  options?: {
    moveCustomFields?: boolean;
    statusMappings?: Array<{ oldStatusId: string; newStatusId: string }>;
  }
): Promise<void> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) {
    throw new Error('ClickUp not configured');
  }

  const normalizedTaskId = String(taskId || '').trim();
  const normalizedTargetListId = String(targetListId || '').trim();
  if (!normalizedTaskId || !normalizedTargetListId) {
    throw new Error('ClickUp task move requires both a task ID and a target list ID.');
  }

  const workspaceId = await this.loadWorkspaceIdIfNeeded();

  const moveBody: Record<string, unknown> = {
    move_custom_fields: options?.moveCustomFields ?? true
  };
  if (options?.statusMappings && options.statusMappings.length > 0) {
    moveBody.status_mappings = options.statusMappings;
  }

  const moveResult = await this.retry(() =>
    this.httpRequestV3(
      'PUT',
      `/workspaces/${workspaceId}/tasks/${normalizedTaskId}/home_list/${normalizedTargetListId}`,
      moveBody
    )
  );
  if (moveResult.status !== 200) {
    const detail = typeof moveResult.data === 'string'
      ? moveResult.data
      : JSON.stringify(moveResult.data);
    throw new Error(`Failed to move ClickUp task ${normalizedTaskId} to list ${normalizedTargetListId}. Status: ${moveResult.status} — ${detail}`);
  }

  // Invalidate cache for BOTH the old list and the new list
  if (this._cacheService) {
    const oldListId = this._taskListIndex.get(normalizedTaskId);
    if (oldListId) {
      this._cacheService.invalidateTaskCache('clickup', oldListId);
    }
    this._cacheService.invalidateTaskCache('clickup', normalizedTargetListId);
    // Update the reverse map to reflect the new location
    this._taskListIndex.set(normalizedTaskId, normalizedTargetListId);
  }
}
```

### 2. `src/services/LinearSyncService.ts` — Add `updateIssueProject` method

Insert after `updateIssueParent` (after line 1159), following the same pattern:

```typescript
public async updateIssueProject(issueId: string, projectId: string | null): Promise<void> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) {
    throw new Error('Linear not configured');
  }

  const normalizedIssueId = String(issueId || '').trim();
  if (!normalizedIssueId) {
    throw new Error('Linear project updates require an issue ID.');
  }

  const result = await this.graphqlRequest(`
    mutation($id: String!, $projectId: String) {
      issueUpdate(id: $id, input: { projectId: $projectId }) { success }
    }
  `, { id: normalizedIssueId, projectId: projectId || null });

  if (!result.data?.issueUpdate?.success) {
    throw new Error(`Linear issue ${normalizedIssueId} rejected the project update.`);
  }

  // Invalidate cache for BOTH the old project and the new project
  if (this._cacheService) {
    const oldProjectId = this._issueProjectIndex.get(normalizedIssueId);
    if (oldProjectId) {
      this._cacheService.invalidateTaskCache('linear', `project:${oldProjectId}`);
    }
    if (projectId) {
      this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
    } else {
      // If moving to no project, invalidate all Linear cache as fallback
      this._cacheService.invalidateTaskCache('linear');
    }
    // Update the reverse map
    if (projectId) {
      this._issueProjectIndex.set(normalizedIssueId, projectId);
    } else {
      this._issueProjectIndex.delete(normalizedIssueId);
    }
  }
}
```

### 3. `src/services/LocalApiServer.ts` — Add move endpoints

Add a handler for ClickUp task moves (modeled on `_handleUpdateClickUpTask`):

```typescript
private async _handleMoveClickUpTask(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!await this._checkAuth(req, true)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Unauthorized',
      detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
    }));
    return;
  }

  const service = this._options.getClickUpService();
  if (!service) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ClickUp service not available' }));
    return;
  }

  try {
    const body = await this._parseJsonBody(req);
    const { targetListId, moveCustomFields, statusMappings } = body || {};

    if (!targetListId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'targetListId is required' }));
      return;
    }

    await service.moveTask(taskId, targetListId, {
      moveCustomFields,
      statusMappings
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, taskId, targetListId }));
  } catch (err) {
    console.error('[LocalApiServer] ClickUp task move error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task move failed' }));
  }
}
```

Add a handler for Linear issue project moves:

```typescript
private async _handleMoveLinearIssue(issueId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!await this._checkAuth(req, true)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Unauthorized',
      detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
    }));
    return;
  }

  const service = this._options.getLinearService();
  if (!service) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Linear service not available' }));
    return;
  }

  try {
    const body = await this._parseJsonBody(req);
    const { targetProjectId } = body || {};

    // targetProjectId can be null (unassign from project) but must be present
    if (!('targetProjectId' in body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'targetProjectId is required (use null to unassign)' }));
      return;
    }

    await service.updateIssueProject(issueId, body.targetProjectId || null);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, issueId, targetProjectId: body.targetProjectId }));
  } catch (err) {
    console.error('[LocalApiServer] Linear issue move error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Issue move failed' }));
  }
}
```

Add routes in the routing section (after line 1014, near the existing ClickUp/Linear routes):

```typescript
} else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/move') && req.method === 'PUT') {
  const taskId = pathname.split('/')[3];
  await this._handleMoveClickUpTask(taskId, req, res);
} else if (pathname.startsWith('/task/linear/') && pathname.endsWith('/move') && req.method === 'PUT') {
  const issueId = pathname.split('/')[3];
  await this._handleMoveLinearIssue(issueId, req, res);
```

### 4. `.agents/skills/clickup_move_task.md` — New skill file

```markdown
---
description: Move a ClickUp task to a different list via LocalApiServer
---

# Move ClickUp Task

## When to Use
- User asks to move a task to a different list
- Need to relocate a ticket to another list within the workspace

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call PUT "/task/clickup/$TASK_ID/move" \
  -H "Content-Type: application/json" \
  -d '{
    "targetListId": "list-uuid-here",
    "moveCustomFields": true
  }'
```

## Parameters
- **targetListId** (required): ID of the destination list
- **moveCustomFields** (optional, default true): Bring custom fields to the new list
- **statusMappings** (optional): Array of `{ oldStatusId, newStatusId }` if the task's current status doesn't exist in the target list

## Response
```json
{
  "success": true,
  "taskId": "...",
  "targetListId": "..."
}
```

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: Missing targetListId
- 503: ClickUp service unavailable
- 500: Move failed (check error message for status mapping requirements)
```

Also create `.claude/skills/clickup-move-task/SKILL.md` with the same content.

### 5. `.agents/skills/linear_move_issue.md` — New skill file

```markdown
---
description: Move a Linear issue to a different project via LocalApiServer
---

# Move Linear Issue

## When to Use
- User asks to move an issue to a different project
- Need to relocate a ticket to another project within the same team

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call PUT "/task/linear/$ISSUE_ID/move" \
  -H "Content-Type: application/json" \
  -d '{
    "targetProjectId": "project-uuid-here"
  }'
```

## Parameters
- **targetProjectId** (required): UUID of the destination project, or null to remove from project

## Response
```json
{
  "success": true,
  "issueId": "...",
  "targetProjectId": "..."
}
```

## Limitations
- Linear does NOT support moving issues between teams. The target project must be in the same team as the issue.
- To move to a different team, create a new issue in the target team and close the original.

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: Missing targetProjectId
- 503: Linear service unavailable
```

Also create `.claude/skills/linear-move-issue/SKILL.md` with the same content.

### 6. `src/webview/planning.js` — Add "Move" button to ticket cards

In `_renderClickUpTicketCard` (line 8917), add a Move button to the card-actions div:

```javascript
<button type="button" class="card-icon-btn" data-move-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Move</button>
```

In `_renderLinearTicketCard` (line 8935), add the same:

```javascript
<button type="button" class="card-icon-btn" data-move-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Move</button>
```

Add a click handler for `data-move-ticket-id` that:
1. Sends a `postMessage` to the extension host: `{ type: 'fetchMoveTargets', provider: 'clickup'|'linear', ticketId: '...' }`
2. For ClickUp: host calls `getSpaces()` → user selects space → `getFolders(spaceId)` → user selects folder → `getLists(spaceId, folderId)` → user selects list. Or flatten the hierarchy into a searchable list.
3. For Linear: host calls `getAvailableProjects()` → returns `{ id, name }[]` directly.
4. Receives the target list back and renders a popover with a searchable dropdown.
5. On selection, sends a `postMessage`: `{ type: 'moveTicket', provider, ticketId, targetId: '...' }`
6. On success, refreshes the ticket list for that provider.

### 7. Extension host — Handle `moveTicket` and `fetchMoveTargets` messages

In the webview message receiver (likely `TaskViewerProvider` or `KanbanProvider`), add handlers:

```typescript
case 'fetchMoveTargets': {
  if (provider === 'clickup') {
    // Return spaces → folders → lists hierarchy (or flatten)
    const spaces = await clickUpService.getSpaces();
    const targets: Array<{ id: string; name: string; path: string }> = [];
    for (const space of spaces) {
      const lists = await clickUpService.getLists(space.id);
      for (const list of lists) {
        targets.push({ id: list.id, name: list.name, path: `${space.name} / ${list.name}` });
      }
      const folders = await clickUpService.getFolders(space.id);
      for (const folder of folders) {
        const folderLists = await clickUpService.getLists(space.id, folder.id);
        for (const list of folderLists) {
          targets.push({ id: list.id, name: list.name, path: `${space.name} / ${folder.name} / ${list.name}` });
        }
      }
    }
    webview.postMessage({ type: 'moveTargetsResult', provider, ticketId, targets });
  } else {
    const projects = await linearService.getAvailableProjects();
    webview.postMessage({ type: 'moveTargetsResult', provider, ticketId, targets: projects.map(p => ({ id: p.id, name: p.name, path: p.name })) });
  }
  break;
}
case 'moveTicket': {
  if (provider === 'clickup') {
    await clickUpService.moveTask(ticketId, targetId);
  } else {
    await linearService.updateIssueProject(ticketId, targetId);
  }
  webview.postMessage({ type: 'moveTicketResult', success: true, provider, ticketId });
  // Trigger ticket list refresh
  break;
}
```

### 8. Update AGENTS.md and CLAUDE.md skill registries

Add to the skill table:

```
| `clickup_move_task` | Move a ClickUp task to a different list via LocalApiServer |
| `linear_move_issue` | Move a Linear issue to a different project via LocalApiServer |
```

## Verification Plan

1. **ClickUp move — service unit check**: call `moveTask` with a known task ID and a valid target list ID. Verify the task appears in the target list in the ClickUp web app. Verify both the old and new list caches are invalidated.

2. **ClickUp move — status mapping**: move a task whose current status doesn't exist in the target list. Provide `statusMappings`. Verify the task's status is updated to the mapped status. Test without `statusMappings` — verify a clear error message about status mapping requirements.

3. **ClickUp move — custom fields**: move a task with custom fields and `moveCustomFields: true`. Verify the custom field values are preserved in the new list.

4. **Linear move — service unit check**: call `updateIssueProject` with a known issue ID and a valid target project ID. Verify the issue appears in the target project in the Linear web app. Verify both old and new project caches are invalidated.

5. **Linear move — unassign from project**: call `updateIssueProject` with `null`. Verify the issue becomes a team-level issue with no project.

6. **LocalApiServer endpoints**: send `PUT /task/clickup/{id}/move` with `{ "targetListId": "..." }`. Verify 200 response. Send `PUT /task/linear/{id}/move` with `{ "targetProjectId": "..." }`. Verify 200 response. Verify 400 when target ID is missing. Verify 401 without auth token.

7. **Skill files**: run `clickup_move_task` and `linear_move_issue` skills via `sb_api_call.sh` from a shell. Verify they successfully move tickets.

8. **Webview UI**: open the Tickets sidebar. Click "Move" on a ClickUp ticket — verify the list picker appears with spaces/folders/lists. Select a target — verify the ticket disappears from the old list and appears in the new list after refresh. Repeat for a Linear ticket with the project picker.

9. **Cross-team Linear move (limitation)**: attempt to move a Linear issue to a project in a different team. Verify the UI only shows projects within the configured team (no cross-team projects in the dropdown).

10. **Error handling**: disconnect the ClickUp/Linear API (revoke token) and attempt a move. Verify the UI shows an error message rather than silently failing.

11. **Sync map consistency**: move a ClickUp task that is linked to a Switchboard plan. Verify the plan's sync status remains intact (the external task ID doesn't change). Verify the next sync cycle correctly fetches the task from its new list.
