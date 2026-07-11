---
name: Switchboard Orchestration
description: Switchboard orchestration HTTP surface — the complete LocalApiServer contract for external AI coding tools and fleet agents. Discover the port, read the board/plans/features/worktrees/inbox/session-log, manage plan lifecycle, move cards, group and split features, dispatch fan-out, file requests to the orchestrator, and merge/clean up worktrees — all over localhost HTTP. Includes end-to-end workflows for a fleet coder inside a worktree and for an external orchestrator driving the board.
---

# Skill: Switchboard Orchestration HTTP Surface

This is the **complete** HTTP contract for driving Switchboard from outside the VS Code webview —
whether you are a **fleet coding/review agent** working inside an orchestration worktree, or an
**external orchestrator** (Cursor / Zed / Claude Code / Antigravity) driving the whole board.

Switchboard's LocalApiServer runs inside the VS Code extension and is the **sole writer** of
`kanban.db`. You never touch the DB directly — you call these endpoints. The board is the source
of truth; the UI is just one view of it.

> **Behavior vs. invocation.** This skill is the *invocation* authority (endpoints, verbs,
> payload fields). For *behavior* contracts — how the system behaves (cards move on coding
> start, completion = plan-file mtime advance, plan files are write-once-at-the-end, subtask
> column exclusion) — consult the **`switchboard-contracts`** skill. Never consult that skill
> for invocation; never consult this skill for behavior conventions.

---

## 1. Bootstrap

```bash
# The port is written to a file at extension startup.
PORT=$(cat .switchboard/api-server-port.txt)
BASE="http://127.0.0.1:$PORT"

# Confirm Switchboard is up before anything else.
curl -s "$BASE/health"     # -> { status: 'ok', port, roots: [...], terminals: [...], terminalCount, selectedWorkspaceRoot }
```

If `.switchboard/api-server-port.txt` is missing or `/health` fails, Switchboard is **not running** —
tell the user to open the workspace in VS Code with the Switchboard extension active. Do not fall
back to editing `kanban.db` directly.

**Auth.** All endpoints sit behind the localhost boundary. If a token is set in VS Code
(`Switchboard: Api Token`), pass `Authorization: Bearer <token>`; if none is set, any localhost
request is accepted.

**Multi-root.** `/health` returns `roots`. DB-backed endpoints accept an optional
`?workspaceRoot=<root>` (GET) or `"workspaceRoot"` body field (POST/PUT/DELETE); omit it to use the
primary workspace.

**Response envelope.**
- **Read** endpoints return `{ "success": true, "data": <payload> }`.
- **Mutation** endpoints return `{ "success": true, ...fields }` (no `data` wrapper).
- Errors return `{ "error": "<message>" }` with an HTTP status: `400` bad input, `401` unauthorized,
  `404` not found, `409` conflict, `503` DB/extension not ready, `500` handler error.

---

## 2. Read endpoints (GET)

| Endpoint | Returns |
|---|---|
| `GET /health` | `{ status, port, roots, terminals?, terminalCount?, selectedWorkspaceRoot? }` — liveness + workspace roots + live terminal agents + board's selected workspace root |
| `GET /kanban/board` | Full board: every active plan record for the workspace |
| `GET /kanban/plans?column=<col>` | Plans filtered to one column |
| `GET /kanban/plans?featureId=<id>` | Subtasks of a feature |
| `GET /kanban/plan?planId=<id>` | **One** plan record **plus its full file content** (`.data.content`) |
| `GET /kanban/columns` | `{ builtIn: [...defs], custom: [...ids] }` |
| `GET /kanban/features` | All features (`isFeature` rows) |
| `GET /worktree/list` | All worktree rows (`path`, `branch`, `subtask_plan_id`, `feature_id`, `tier`, `status`, `base_branch`) |
| `GET /orchestrator/inbox` | Pending request files: `[{ file, content }]` |
| `GET /orchestrator/session-log` | The orchestrator's session log (markdown string) |

```bash
curl -s "$BASE/kanban/board"
curl -s "$BASE/kanban/plans?column=PLAN%20REVIEWED"
curl -s "$BASE/kanban/plan?planId=a1b2c3d4"      # includes .data.content (the .md file)
curl -s "$BASE/kanban/features"
curl -s "$BASE/worktree/list"
```

Plan records include: `planId`, `sessionId`, `topic`, `planFile`, `kanbanColumn`, `status`,
`complexity`, `tags`, `project`, `isFeature`, `featureId`, `worktreeId`, `worktreeStatus`,
`dispatchedAt` (null = not currently working).

---

## 3. Plan lifecycle (POST / PUT / DELETE)

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /kanban/plans` | `{ title, slug?, complexity?, tags?, project?, description?, body?, workspaceRoot? }` | Create a plan (writes `.switchboard/plans/<slug>.md`, imports it, returns the assigned `planId`) |
| `DELETE /kanban/plans?planId=<id>[&deleteFile=true]` | — | Delete the DB row; `deleteFile=true` also unlinks the `.md` |
| `PUT /kanban/plans/project` | `{ planId, project, workspaceRoot? }` | Set a plan's project |
| `PUT /kanban/plans/complexity` | `{ planId, complexity, workspaceRoot? }` | Set a plan's complexity (`"1"`–`"10"` or `"Unknown"`) |
| `POST /kanban/plans/import` | `{ workspaceRoot? }` | Rescan `.switchboard/plans/*.md` and upsert |

```bash
# Create — returns { success:true, planId, planFile, slug }
curl -s -X POST "$BASE/kanban/plans" -H "Content-Type: application/json" -d '{
  "title": "Add rate limiting to the API",
  "complexity": "5",
  "tags": "backend, api",
  "body": "Add token-bucket rate limiting to the public endpoints."
}'

curl -s -X PUT "$BASE/kanban/plans/project" -H "Content-Type: application/json" \
  -d '{"planId":"a1b2c3d4","project":"Platform"}'

curl -s -X DELETE "$BASE/kanban/plans?planId=a1b2c3d4"                    # DB row only
curl -s -X DELETE "$BASE/kanban/plans?planId=a1b2c3d4&deleteFile=true"    # also remove the file
```

> **`delete_plan` gotcha:** without `deleteFile=true`, the `.md` file stays on disk and the plan
> **re-appears on the next `import_plans`** (or a webview reset). Use `deleteFile=true` for a
> permanent delete. `create_plan` refuses to overwrite an existing file (`409`) and rejects
> path-traversal slugs (`400`).

---

## 4. Board mutations (POST)

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /kanban/dispatch` | `{ plan: planId or plan-file path, targetColumn?, workspaceRoot? }` | ONE-call advance-and-dispatch. `targetColumn` omitted/`"auto"` → routed by plan complexity through the board's own rule (default bands 1–4 → INTERN CODED, 5–6 → CODER CODED, 7+/unknown → LEAD CODED; custom routing maps + pair-mode bypass honored; decision returned in `routing`). Canonicalizes explicit columns, persists the move, fires the column's role prompt (CLI-triggers setting does not gate API dispatches), verifies vs DB. Honest response (`moved`, `dispatched`, `dispatchedAt`); 4xx/409 when it can't work (no role on column, no live terminal agent). Prefer this over move + raw `triggerAction` (whose exact webview field names and hollow `{success:true}` acks hide no-ops) |
| `POST /kanban/move` | `{ planId or sessionId, targetColumn, workspaceRoot? }` | Move a card (feature cascade + tracker sync inherited). Column IDs are canonical uppercase (`LEAD CODED`), never state-file slugs (`lead-coded`) — both endpoints canonicalize and 400 on unknown columns |
| `POST /kanban/feature` | `{ name, planIds: [...], description?, workspaceRoot? }` | Create a feature from plan IDs |
| `POST /kanban/feature/assign` | `{ featurePlanId, planIds: [...], workspaceRoot? }` | Assign plans to a feature |
| `POST /kanban/feature/remove` | `{ subtaskPlanId, workspaceRoot? }` | Detach a subtask from its feature |
| `POST /kanban/feature/delete` | `{ featurePlanId, deleteSubtasks?, workspaceRoot? }` | Delete a feature |
| `POST /kanban/feature/split` | `{ featurePlanId, keptPlanIds: [...], firstFeatureName, secondFeatureName, workspaceRoot? }` | Split a feature in two |
| `POST /kanban/orchestration/dispatch` | `{ featurePlanId, workspaceRoot }` | Fan out a feature's PLAN REVIEWED subtasks into their worktree terminals |
| `POST /worktree/cleanup` | `{ worktreeId or branch, workspaceRoot? }` | Mark a worktree merged and clean it up (kind-aware) |

```bash
# Column vocabulary: CREATED | PLAN REVIEWED | LEAD CODED | CODER CODED | INTERN CODED
#                    | CODE REVIEWED | ACCEPTANCE TESTED | COMPLETED   (see GET /kanban/columns)
curl -s -X POST "$BASE/kanban/move" -H "Content-Type: application/json" \
  -d '{"planId":"a1b2c3d4","targetColumn":"CODE REVIEWED"}'

curl -s -X POST "$BASE/kanban/feature" -H "Content-Type: application/json" \
  -d '{"name":"Auth Refactor","planIds":["id1","id2"],"description":"Group the auth work."}'
```

---

## 5. Comms (POST)

### `POST /orchestrator/request` — fleet agent → orchestrator
File a question / warning / research request / blocker. The extension writes it to
`.switchboard/orchestrator/inbox/`; the orchestrator drains it on its next wake.

```bash
curl -s -X POST "$BASE/orchestrator/request" -H "Content-Type: application/json" -d '{
  "stage": "coder",
  "type": "blocked",
  "from": "coder-worktree-3",
  "planId": "a1b2c3d4",
  "feature": "Auth Refactor",
  "worktreePath": "/repo/.worktrees/auth-refactor-3",
  "body": "The mock DB does not implement the new transaction interface. Update the mock or skip the integration tests?"
}'
```
- **Required:** `stage` (`planner|coder|reviewer`), `type` (`question|warning|research|blocked`), `body`.
- **Optional:** `from`, `planId`, `feature`, `worktreePath`.
- Do **not** use this for routine progress — the orchestrator reads git/board state directly.

### Other comms
- `POST /comment` — `{ provider, id, body }`: reply to a Linear/Notion/ClickUp remote-control card.
- `POST /phone-a-friend` — `{ planFile, originRole? }`: notify a second-pass terminal at batch end.

---

## 6. Integration proxies (POST)
Passthrough to the tracker APIs using Switchboard's stored tokens (you never see the tokens):
- `POST /api/clickup`, `POST /api/linear` — raw API proxy.
- `GET /resolve/<clickup|linear>/name/<name>`, `GET /metadata/<clickup|linear>`, `/task/*`,
  `POST /doc/clickup`, `POST /diagram/generate` — see the `clickup_api` / `linear_api` skills.

---

## 7. Workflow A — fleet coding/review agent inside a worktree

You were dispatched into a worktree to code or review one plan. You do **not** have a chat channel to
the orchestrator; you use HTTP.

```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"

# 1. Find your plan (its planId is in your dispatch prompt) and read its full spec.
curl -s "$BASE/kanban/plan?planId=$PLAN_ID" | jq -r '.data.content'

# 2. Do the work in this worktree. Commit as you go (the orchestrator verifies via git, not chat).

# 3. Hit a blocker or ambiguity? File a request — then continue or stop per its severity.
curl -s -X POST "$BASE/orchestrator/request" -H "Content-Type: application/json" -d "{
  \"stage\":\"coder\",\"type\":\"question\",\"planId\":\"$PLAN_ID\",
  \"from\":\"$(basename "$PWD")\",\"worktreePath\":\"$PWD\",
  \"body\":\"Should the cache be per-tenant or global?\"}"

# 4. Check whether the orchestrator answered (it replies in the session log / a reply file).
curl -s "$BASE/orchestrator/session-log" | jq -r '.data' | tail -40
```

You do **not** move your own card or merge — the orchestrator does that after verifying your git state.

---

## 8. Workflow B — external orchestrator driving the board

You are an external agent acting as the orchestrator. Mirror the in-VS-Code persona
(`switchboard-orchestrator`): coding + code-review only; planner-stage questions escalate to the human.

```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"

# 1. Read the whole board on each wake.
curl -s "$BASE/kanban/board" | jq '.data'

# 2. Group loose plans into features (the external equivalent of group-into-features).
curl -s -X POST "$BASE/kanban/feature" -H "Content-Type: application/json" \
  -d '{"name":"Checkout v2","planIds":["id1","id2","id3"]}'

# 3. For each feature, read its subtasks + fan out (or dispatch to your own agents).
curl -s "$BASE/kanban/plans?featureId=$FEATURE_ID" | jq '.data'
curl -s -X POST "$BASE/kanban/orchestration/dispatch" -H "Content-Type: application/json" \
  -d "{\"featurePlanId\":\"$FEATURE_ID\",\"workspaceRoot\":\"$PWD\"}"

# 4. On each wake: VERIFY VIA GIT, not self-report. A subtask is "coded" only when its worktree
#    branch is ahead of base with committed work. Use the base_branch from GET /worktree/list.
curl -s "$BASE/worktree/list" | jq -r '.data[] | [.path, .base_branch] | @tsv' |
while IFS=$'\t' read -r wt base; do
  echo "$wt: $(git -C "$wt" rev-list --count "${base:-main}"..HEAD 2>/dev/null) commits ahead"
done

# 5. Advance verified cards; escalate planner-stage questions to the human.
curl -s -X POST "$BASE/kanban/move" -H "Content-Type: application/json" \
  -d "{\"planId\":\"$PLAN_ID\",\"targetColumn\":\"CODE REVIEWED\"}"

# 6. When all of a feature's subtasks are CODE REVIEWED, merge the feature's single shared
#    worktree branch into main (per-feature model: one worktree per feature, so one merge —
#    git -C <main checkout> merge <feature branch>), then clean up the worktree.
curl -s -X POST "$BASE/worktree/cleanup" -H "Content-Type: application/json" \
  -d "{\"branch\":\"$BRANCH\"}"
```

---

## 9. The truth rule

Trust **git and board state**, never an agent's self-reported "done":
- **Coded** = worktree branch ahead of base with committed work (`git -C <wt> rev-list --count <base>..HEAD > 0`) and a clean tree (`git -C <wt> status --porcelain`).
- **Reviewed** = the review stage genuinely passed and the card sits in `CODE REVIEWED`.
- Read board state via these endpoints; read ground truth via your own `git` commands.

---

## 10. Failure modes
- **`SWITCHBOARD_NOT_RUNNING`** — port file missing or `/health` fails → tell the user to start the extension. Never edit `kanban.db` directly.
- **`404`** — plan/feature/worktree not found (bad id).
- **`400`** — invalid input (bad column, empty body, path-traversal slug); the message names the problem.
- **`409`** — `create_plan` slug already exists.
- **`503`** — DB/extension not ready yet → retry after a short delay.

## 11. File-based fallback (no HTTP)
If the API server is down you can still communicate via the filesystem (the orchestrator reads these each wake):
- **Inbox:** write `.switchboard/orchestrator/inbox/req-<UTC>-<stage>-<rand>.md` — YAML frontmatter (`from`, `stage`, `type`, `planId`, `feature`, `worktreePath`, `created`) + body below `---`.
- **Session log:** `.switchboard/orchestrator/session-log.md` — append-only; read it to see the orchestrator's decisions.
- **Progress:** `.switchboard/orchestrator/progress.json` — the orchestrator's per-plan stall state.

## Notes
- localhost only (127.0.0.1) — never a public interface.
- Reads wrap payloads in `.data`; mutations return `{ success, ...fields }`.
- This surface is documented for external tools; the in-VS-Code orchestrator persona is `switchboard-orchestrator`.
