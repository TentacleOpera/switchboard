---
description: Orchestration HTTP surface — read endpoints and request channel for external AI coding tools working inside Switchboard orchestration worktrees. Discover the API port, read board/features/plans/worktrees, file requests to the orchestrator, and read the session log.
---

# Skill: Orchestration HTTP Surface

This skill gives an external AI coding tool (running inside a Switchboard orchestration
worktree) the HTTP endpoints it needs to interact with the orchestrator and the board.

## Discovering the API Port

The LocalApiServer port is written to `.switchboard/api-server-port.txt` at startup.

```bash
PORT=$(cat .switchboard/api-server-port.txt)
```

All endpoints below are on `http://127.0.0.1:$PORT`. Authentication uses a bearer token
configured in VS Code (`Switchboard: Api Token` setting). If no token is set, endpoints
accept any request. If a token is set, pass it as `Authorization: Bearer <token>`.

## Read Endpoints (GET)

### GET /kanban/board
Returns the full kanban board (all plans, all columns).
```bash
curl -s http://127.0.0.1:$PORT/kanban/board
```
Response: `{ "success": true, "data": [ { planId, sessionId, topic, kanbanColumn, ... }, ... ] }`

### GET /kanban/plans
Returns plans, optionally filtered by column or feature.
```bash
# All plans
curl -s http://127.0.0.1:$PORT/kanban/plans
# Plans in a specific column
curl -s "http://127.0.0.1:$PORT/kanban/plans?column=PLAN%20REVIEWED"
# Subtasks of a specific feature
curl -s "http://127.0.0.1:$PORT/kanban/plans?featureId=abc-123"
```

### GET /kanban/features
Returns all features (plans with `isFeature` flag).
```bash
curl -s http://127.0.0.1:$PORT/kanban/features
```

### GET /worktree/list
Returns all worktrees (active, merged, deleted).
```bash
curl -s http://127.0.0.1:$PORT/worktree/list
```
Response: `{ "success": true, "data": [ { id, path, branch, subtask_plan_id, status, ... }, ... ] }`

### GET /orchestrator/inbox
Returns pending inbox request files (not yet processed).
```bash
curl -s http://127.0.0.1:$PORT/orchestrator/inbox
```
Response: `{ "success": true, "data": [ { file: "req-...-coder-12345.md", content: "---\n..." }, ... ] }`

### GET /orchestrator/session-log
Returns the orchestrator's append-only session log (markdown).
```bash
curl -s http://127.0.0.1:$PORT/orchestrator/session-log
```
Response: `{ "success": true, "data": "# Session Log\n\n## 2026-07-07 ..." }`

## Request Channel (POST)

### POST /orchestrator/request
File a request to the orchestrator. The orchestrator reads and handles these on its
next wake tick, then moves them to `inbox/processed/`.

```bash
curl -s -X POST http://127.0.0.1:$PORT/orchestrator/request \
  -H "Content-Type: application/json" \
  -d '{
    "stage": "coder",
    "type": "blocked",
    "from": "coder-worktree-3",
    "planId": "abc-123",
    "feature": "Auth Refactor",
    "body": "The test suite fails because the mock database does not implement the new transaction interface. I need guidance on whether to update the mock or skip the integration tests.",
    "worktreePath": "/repo/.worktrees/auth-refactor-subtask-3"
  }'
```

**Required fields:**
- `stage`: one of `planner`, `coder`, `reviewer` — your current role.
- `type`: one of `question`, `warning`, `research`, `blocked` — the request category.
- `body`: the free-form request text (markdown). This is the only field the orchestrator reads in full.

**Optional fields:**
- `from`: your terminal/agent name (for traceability).
- `planId`: the plan you're working on.
- `feature`: the feature name.
- `worktreePath`: your worktree path (so the orchestrator can inspect your git state).

**Request types:**
- `question`: you need a decision or clarification to proceed.
- `warning`: something looks wrong but you can work around it (non-blocking).
- `research`: you need a research agent dispatched (provide a well-formed research prompt in the body).
- `blocked`: you cannot proceed without orchestrator intervention.

## Write Endpoints (POST) — use with caution

These endpoints exist for the orchestrator and board automation. As a fleet coding agent,
you should NOT call these unless the orchestrator's persona workflow explicitly directs
you to:

- `POST /kanban/move` — move a card to a new column.
- `POST /kanban/orchestration/dispatch` — fan out a feature's subtasks.
- `POST /worktree/cleanup` — clean up a merged worktree.

## File-based Comms (no HTTP needed)

If the API server is down (no port file), you can still communicate via the filesystem:

- **Inbox:** write a markdown file to `.switchboard/orchestrator/inbox/` with YAML frontmatter
  (`from`, `stage`, `type`, `planId`, `feature`, `worktreePath`, `created`) and the body below `---`.
  The orchestrator reads this directory on each wake.
- **Session log:** `.switchboard/orchestrator/session-log.md` — append-only, read it to see
  what the orchestrator has done.
- **Progress tracking:** `.switchboard/orchestrator/progress.json` — the orchestrator's
  stall-detection state (per-plan `lastSeenSha` and `stallCount`).

## Notes

- The API server runs on localhost only (127.0.0.1), never on a public interface.
- All endpoints return JSON with `{ success: boolean, data?: ..., error?: string }`.
- The `workspaceRoot` query parameter is accepted by DB-backed endpoints for multi-root
  workspaces; omit it to use the primary workspace.
- If you get a 503, the extension or DB is not ready — retry after a short delay.
