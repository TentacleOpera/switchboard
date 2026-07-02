# Ticket Assignee Reassignment for ClickUp and Linear

**Plan ID:** a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d

## Goal

### Problem

There is no way to assign or reassign a ticket in ClickUp or Linear to another user. This is a task done all the time in project management — triaging incoming tickets, handing off work, balancing load across team members — yet the Switchboard extension provides no UI or agent-facing skill for it. Users must leave the extension and go to the ClickUp/Linear web app to change assignees.

### Background Context

Switchboard integrates with both ClickUp and Linear through dedicated sync services (`ClickUpSyncService.ts`, `LinearSyncService.ts`) that communicate with a `LocalApiServer` proxy. The proxy exposes REST endpoints that agent skills shell out to via `sb_api_call.sh`. The webview (`planning.js`) renders ticket cards in a sidebar with action buttons (Add to kanban, Link to ticket, Refine, Open).

**ClickUp status:** The `updateTask` method in `ClickUpSyncService.ts` (line 1400) already accepts an `assignees?: number[]` parameter, and the `PUT /task/clickup/{taskId}` endpoint in `LocalApiServer.ts` (line 538, `_handleUpdateClickUpTask`) already passes `assignees` through (line 564). The `clickup_modify_task` skill already documents the `assignees` parameter. So ClickUp assignment is **fully functional at the API and skill level** — it just has no UI button.

**Linear status:** The `LinearSyncService.ts` has dedicated update methods for state (`updateIssueState`, line 1064), labels (`updateIssueLabels`, line 1098), parent (`updateIssueParent`, line 1130), and description (`updateIssueDescription`, line 1557) — but **no method to update the assignee**. The `createIssue` (line 2075) and `createIssueSimple` (line 2167) methods also do not accept an `assigneeId` parameter. There is no `PUT /task/linear/{id}` endpoint in `LocalApiServer.ts` — Linear only has a generic `POST /api/linear` GraphQL proxy (line 872). The `linear_api` skill documents the proxy but has no dedicated assignment skill. So Linear assignment is **completely missing** at the service, endpoint, and skill level.

Both services already have member-lookup methods (`getListMembers` for ClickUp at line 1549, `getTeamMembers` for Linear at line 1430) that return user IDs/names/emails — these are used for the mention picker and can be reused for assignee dropdowns.

### Root Cause Analysis

1. **ClickUp:** The assignment capability exists end-to-end (service → API → skill) but was never surfaced in the webview UI. The ticket card action buttons (`_renderClickUpTicketCard`, planning.js line 8917) include "Add to kanban", "Link to ticket", "Refine", and "Open" — but no "Assign" button. The action-prompt list (planning.js line 168-170) mentions assignees in the "Update a task" prompt text, but there's no one-click assignee action.

2. **Linear:** The assignment capability was never built at any layer. The `LinearSyncService` has update methods for state, labels, parent, and description but the `issueUpdate` GraphQL mutation's `assigneeId` input field was never exposed. The `LocalApiServer` has no `PUT /task/linear/{id}` route (only `GET /task/linear/{id}` at line 1007). No dedicated skill file exists for Linear task modification.

## Metadata

- **Tags:** feature, frontend, backend, clickup, linear, tickets
- **Complexity:** 5

## User Review Required

Yes — review the UI approach for the assignee dropdown (Proposed Change #5). Two options were considered: (a) a dropdown `<select>` rendered inline in each ticket card, or (b) a lightweight popover/modal triggered by an "Assign" button. Option (b) is proposed because it keeps card height compact and avoids loading team member lists for every card on the page. Confirm this is the preferred UX.

## Complexity Audit

### Routine
- Adding `updateIssueAssignee` method to `LinearSyncService.ts` — follows the exact same pattern as `updateIssueState` / `updateIssueParent` (config check, ID normalization, GraphQL mutation, cache invalidation).
- Adding `assigneeId` to `createIssue` and `createIssueSimple` input objects — one-line spread additions.
- Adding `PUT /task/linear/{id}` route to `LocalApiServer.ts` — follows the exact pattern of `_handleUpdateClickUpTask` (auth check, service retrieval, body parsing, field mapping, response).
- Creating the `linear_modify_issue` skill file — copy/adapt from `clickup_modify_task.md`.
- Adding "Assign" button to both ClickUp and Linear ticket card render functions in `planning.js`.

### Complex / Risky
- **Assignee dropdown UI**: fetching team/list members is an async call. The dropdown needs to load members on demand (when the assign button is clicked) rather than eagerly for every card. Must handle the case where the member list is empty or the API is unavailable.
- **ClickUp assignees vs Linear assignee**: ClickUp supports multiple assignees (array of user IDs), Linear supports a single assignee (string). The UI and API must handle both models without leaking provider-specific logic into shared code.
- **Unassigning**: Linear allows setting `assigneeId` to `null` to unassign. ClickUp requires an empty array `[]` or using the `rem` field. The UI must offer an "Unassigned" option for both.
- **Cache invalidation after assignment**: both services invalidate the task cache after updates. The webview ticket list must refresh to show the new assignee. Need to trigger a re-fetch of the affected ticket list after a successful assignment.
- **Member ID vs member name**: the dropdown shows names/emails but the API needs IDs. The member lookup methods return both, so the dropdown value can be the ID and the label the name.

## Edge-Case & Dependency Audit

1. **ClickUp multi-assignee**: ClickUp tasks can have multiple assignees. The UI must allow selecting multiple users (checkboxes or a multi-select). The `assignees` field in the `PUT /task/clickup/{taskId}` body accepts `number[]` — sending the full array replaces all assignees. If the user wants to add one without removing others, the current card data must be pre-populated with existing assignee IDs.

2. **Linear single assignee**: Linear issues have exactly one assignee (or none). The UI should be a single-select dropdown. Setting `assigneeId` to `null` unassigns.

3. **Member list caching**: `getListMembers` (ClickUp) and `getTeamMembers` (Linear) both cache with a 5-minute TTL. If a new team member was added recently, they may not appear until the cache expires. This is acceptable — the cache is short-lived.

4. **No members returned**: if the API returns an empty member list (permissions issue, empty team), the dropdown should show "No team members found" rather than an empty dropdown.

5. **Permission errors**: the user's ClickUp/Linear API token may lack permission to assign tasks. The API will return an error — the UI must display it gracefully rather than silently failing.

6. **Ticket not yet synced**: the assignee action operates on ClickUp/Linear ticket IDs directly (not plan files). This works for tickets that exist in the external system regardless of kanban sync state.

7. **Existing `PUT /task/linear/{id}` absence**: there is currently no `PUT /task/linear/{id}` route. The routing table in `LocalApiServer.ts` (around line 1004-1030) has `GET /task/linear/{id}` but no PUT. A new route + handler must be added. Alternatively, Linear assignment could be done through the existing `POST /api/linear` GraphQL proxy, but a dedicated `PUT /task/linear/{id}` endpoint is more consistent with the ClickUp pattern and enables a dedicated skill file.

8. **Linear `createIssue` signature change**: adding `assigneeId` to `createIssue` is optional (spread operator), so existing callers won't break. But `createIssueSimple` is called from the webview and skill prompts — the parameter should be optional with a sensible default (no assignee).

9. **Webview message passing**: the webview communicates with the extension host via `postMessage`. A new message type (e.g., `assignTicket`) must be added to the message handler in `planning.js` and the corresponding receiver in the extension host (likely in `TaskViewerProvider` or `KanbanProvider`).

## Dependencies

- `ClickUpSyncService.updateTask` — already supports `assignees`, no change needed.
- `ClickUpSyncService.getListMembers` — already exists, returns `{ id, username, email, name }[]`.
- `LinearSyncService.getTeamMembers` — already exists, returns `{ id, name, email }[]`.
- `LinearSyncService.graphqlRequest` — internal method used by all update methods, no change needed.
- `LocalApiServer._checkAuth` — auth pattern reused for new endpoint.
- `sb_api_call.sh` — shared shell library for agent skills, reused for new skill.

## Proposed Changes

### 1. `src/services/LinearSyncService.ts` — Add `updateIssueAssignee` method

Insert after `updateIssueParent` (after line 1159), following the same pattern:

```typescript
public async updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) {
    throw new Error('Linear not configured');
  }

  const normalizedIssueId = String(issueId || '').trim();
  if (!normalizedIssueId) {
    throw new Error('Linear assignee updates require an issue ID.');
  }

  const result = await this.graphqlRequest(`
    mutation($id: String!, $assigneeId: String) {
      issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
    }
  `, { id: normalizedIssueId, assigneeId: assigneeId || null });

  if (!result.data?.issueUpdate?.success) {
    throw new Error(`Linear issue ${normalizedIssueId} rejected the assignee update.`);
  }

  if (this._cacheService) {
    const projectId = this._issueProjectIndex.get(normalizedIssueId);
    if (projectId) {
      this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
    } else {
      this._cacheService.invalidateTaskCache('linear');
    }
  }
}
```

### 2. `src/services/LinearSyncService.ts` — Add `assigneeId` to `createIssue` and `createIssueSimple`

In `createIssue` (line 2093-2107), add `assigneeId` to the mutation input:

```typescript
// Add to the params type or accept via config:
// In the input object spread:
...(assigneeId ? { assigneeId } : {})
```

In `createIssueSimple` (line 2167-2197), add `assigneeId?: string` to the params type and spread it:

```typescript
public async createIssueSimple(params: {
  title: string;
  description?: string;
  projectId?: string;
  stateId?: string;
  parentId?: string;
  assigneeId?: string;  // NEW
}): Promise<{ id: string; identifier: string }> {
  // ... existing code ...
  input: {
    teamId: config.teamId,
    title: params.title,
    description: params.description || '',
    labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.stateId ? { stateId: params.stateId } : {}),
    ...(params.parentId ? { parentId: params.parentId } : {}),
    ...(params.assigneeId ? { assigneeId: params.assigneeId } : {})  // NEW
  }
```

### 3. `src/services/LocalApiServer.ts` — Add `PUT /task/linear/{id}` route and handler

Add a new handler method `_handleUpdateLinearIssue` (modeled on `_handleUpdateClickUpTask` at line 538):

```typescript
private async _handleUpdateLinearIssue(issueId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    const updatedFields: string[] = [];

    if ('assigneeId' in body) {
      await service.updateIssueAssignee(issueId, body.assigneeId || null);
      updatedFields.push('assigneeId');
    }
    if ('stateId' in body) {
      await service.updateIssueState(issueId, body.stateId);
      updatedFields.push('stateId');
    }
    if ('labelIds' in body) {
      await service.updateIssueLabels(issueId, body.labelIds);
      updatedFields.push('labelIds');
    }
    if ('parentId' in body) {
      await service.updateIssueParent(issueId, body.parentId || null);
      updatedFields.push('parentId');
    }

    if (updatedFields.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No fields provided for update' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, updatedFields }));
  } catch (err) {
    console.error('[LocalApiServer] Linear issue update error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Issue update failed' }));
  }
}
```

Add the route in the routing section (after line 1008, next to the existing `GET /task/linear/{id}`):

```typescript
} else if (pathname.startsWith('/task/linear/') && req.method === 'PUT') {
  const issueId = pathname.split('/')[3];
  await this._handleUpdateLinearIssue(issueId, req, res);
```

### 4. `.agents/skills/linear_modify_issue.md` — New skill file

```markdown
---
description: Update Linear issue properties (assignee, state, labels, parent) via LocalApiServer
---

# Modify Linear Issue

## When to Use
- User asks to update a Linear issue
- Need to change assignee, state, labels, or parent

## Prerequisites
VS Code setting `switchboard.apiToken` must be configured.

## Usage
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call PUT "/task/linear/$ISSUE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "assigneeId": "user-uuid-here"
  }'
```

## Parameters (provide at least one)
- **assigneeId**: User UUID to assign (or null to unassign)
- **stateId**: State UUID to set
- **labelIds**: Array of label UUIDs
- **parentId**: Parent issue UUID (or null to unparent)

## Response
```json
{
  "success": true,
  "updatedFields": ["assigneeId"]
}
```

## Error Handling
- 401 Unauthorized: Token not configured
- 400 Bad Request: No fields provided
- 503: Linear service unavailable
```

Also create `.claude/skills/linear-modify-issue/SKILL.md` with the same content.

### 5. `src/webview/planning.js` — Add "Assign" button to ticket cards

In `_renderClickUpTicketCard` (line 8917), add an Assign button to the card-actions div:

```javascript
<button type="button" class="card-icon-btn" data-assign-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Assign</button>
```

In `_renderLinearTicketCard` (line 8935), add the same:

```javascript
<button type="button" class="card-icon-btn" data-assign-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Assign</button>
```

Add a click handler for `data-assign-ticket-id` that:
1. Sends a `postMessage` to the extension host: `{ type: 'fetchMembers', provider: 'clickup'|'linear', ticketId: '...' }`
2. Receives the member list back
3. Renders a lightweight popover with a searchable dropdown (single-select for Linear, multi-select with checkboxes for ClickUp)
4. On selection, sends a `postMessage`: `{ type: 'assignTicket', provider, ticketId, assigneeIds: [...] }`
5. On success, refreshes the ticket list for that provider

### 6. Extension host — Handle `assignTicket` and `fetchMembers` messages

In the webview message receiver (likely `TaskViewerProvider` or `KanbanProvider`), add handlers:

```typescript
case 'fetchMembers': {
  const members = provider === 'clickup'
    ? await clickUpService.getListMembers(listId)
    : await linearService.getTeamMembers();
  webview.postMessage({ type: 'membersResult', provider, ticketId, members });
  break;
}
case 'assignTicket': {
  if (provider === 'clickup') {
    await clickUpService.updateTask(ticketId, { assignees: assigneeIds });
  } else {
    await linearService.updateIssueAssignee(ticketId, assigneeIds[0] || null);
  }
  webview.postMessage({ type: 'assignTicketResult', success: true, provider, ticketId });
  // Trigger ticket list refresh
  break;
}
```

### 7. Update AGENTS.md skill registry

Add `linear_modify_issue` to the skill table in `AGENTS.md` and `CLAUDE.md`:

```
| `linear_modify_issue` | Update Linear issue properties (assignee, state, labels, parent) via LocalApiServer |
```

## Verification Plan

1. **Linear service unit check**: call `updateIssueAssignee` with a known issue ID and a valid team member UUID. Verify the Linear issue's assignee changes in the Linear web app. Verify cache invalidation triggers a re-fetch.

2. **Linear unassign**: call `updateIssueAssignee` with `null`. Verify the issue becomes unassigned.

3. **ClickUp assignment via existing API**: call `PUT /task/clickup/{taskId}` with `{ "assignees": [userId] }`. Verify the task's assignee changes in ClickUp.

4. **LocalApiServer `PUT /task/linear/{id}`**: send a PUT request with `{ "assigneeId": "uuid" }`. Verify 200 response with `updatedFields: ["assigneeId"]`. Verify 400 when body is empty. Verify 401 without auth token.

5. **Skill file**: run the `linear_modify_issue` skill via `sb_api_call.sh` from a shell. Verify it successfully updates an issue's assignee.

6. **Webview UI**: open the Tickets sidebar in the Switchboard webview. Click "Assign" on a ClickUp ticket — verify the member dropdown appears with team members. Select a member — verify the card's assignee display updates. Repeat for a Linear ticket.

7. **Multi-assignee (ClickUp)**: assign 2 users to a ClickUp task via the UI. Verify both appear in the card's assignee display. Remove one — verify only one remains.

8. **Unassign via UI**: select "Unassigned" in the dropdown. Verify the card shows "Unassigned".

9. **Error handling**: disconnect the Linear/ClickUp API (revoke token) and attempt assignment. Verify the UI shows an error message rather than silently failing.

10. **Empty member list**: test with a team that has no members. Verify the dropdown shows "No team members found".
