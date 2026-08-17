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
curl -s "$BASE/health"     # -> { status: 'ok', port, roots: [...] }
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
| `GET /health` | `{ status, port, roots }` — liveness + workspace roots |
| `GET /kanban/board` | Full board: every active plan record for the workspace |
| `GET /kanban/plans?column=<col>` | Plans filtered to one column |
| `GET /kanban/plans?featureId=<id>` | Subtasks of a feature |
| `GET /kanban/plan?planId=<id>` | **One** plan record **plus its full file content** (`.data.content`) |
| `GET /kanban/columns` | `{ builtIn: [...defs], custom: [{id,label,labelSource,displayModeOf?,legacyAliasOf?}], displayOnly: [{label,aliasOf}] }` — `displayModeOf`/`legacyAliasOf` mark a column that is NOT an independent peer (`BACKLOG` is a view of `CREATED`; `CODED` is a legacy alias of `LEAD CODED`) |
| `GET /kanban/features` | All features (`isFeature` rows) |
| `GET /worktree/list` | All worktree rows (`path`, `branch`, `subtask_plan_id`, `feature_id`, `tier`, `status`, `base_branch`) |
| `GET /orchestrator/session-log` | The orchestrator's session file — `.switchboard/orchestrator/session.md` when it exists, falling back to the legacy `.switchboard/orchestrator/session-log.md` (markdown string, `''` when neither exists) |

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
| `POST /kanban/dispatch` | `{ plan: planId or plan-file path, targetColumn?, workspaceRoot?, from? }` | ONE-call advance-and-dispatch. `targetColumn` omitted/`"auto"` → routed by plan complexity through the board's own rule (default bands 1–4 → INTERN CODED, 5–6 → CODER CODED, 7+/unknown → LEAD CODED; custom routing maps + pair-mode bypass honored; decision returned in `routing`). Canonicalizes explicit columns, persists the move, fires the column's role prompt (CLI-triggers setting does not gate API dispatches), verifies vs DB. Honest response (`moved`, `dispatched`, `dispatchedAt`); 4xx/409 when it can't work (no role on column, no live terminal agent). Prefer this over move + raw `triggerAction` (whose exact webview field names and hollow `{success:true}` acks hide no-ops). `from` — your own terminal name. Supply it and a role dispatch (e.g. CODE REVIEWED → reviewer) is routed to the member of YOUR team rather than the first matching terminal on the board. The response echoes `teamRouting` naming the decision, including when it fell back |
| `POST /kanban/move` | `{ planId or sessionId, targetColumn, workspaceRoot? }` | Move a card (feature cascade + tracker sync inherited). Column IDs are canonical uppercase (`LEAD CODED`), never state-file slugs (`lead-coded`) — both endpoints canonicalize and 400 on unknown columns. `workspaceRoot` omitted ⇒ resolved by identity across all registered roots (`GET /health` → `roots`); supplied ⇒ that root or a not-found error. Response echoes `resolvedWorkspaceRoot` and `rootResolution` (`explicit`/`default`/`searched`/`path`). Unavailable (503) on the standalone host |
| `POST /kanban/feature` | `{ name, planIds: [...], description?, workspaceRoot? }` | Create a feature from plan IDs |
| `POST /kanban/feature/assign` | `{ featurePlanId, planIds: [...], workspaceRoot? }` | Assign plans to a feature |
| `POST /kanban/feature/remove` | `{ subtaskPlanId, workspaceRoot? }` | Detach a subtask from its feature |
| `POST /kanban/feature/delete` | `{ featurePlanId, deleteSubtasks?, workspaceRoot? }` | Delete a feature |
| `POST /kanban/feature/split` | `{ featurePlanId, keptPlanIds: [...], firstFeatureName, secondFeatureName, workspaceRoot? }` | Split a feature in two |
| `POST /worktree/cleanup` | `{ worktreeId or branch, workspaceRoot? }` | Mark a worktree merged and clean it up (kind-aware) |
| `POST /orchestration/start` | `{ workspaceRoot? }` | Seat the orchestrator terminal and deliver the pre-flight interview. **Does not arm** — returns a message saying the orchestrator is seated and awaiting confirmation. Arming is `POST /orchestration/confirm` |
| `POST /orchestration/confirm` | `{ workspaceRoot? }` | Arm an orchestration session after the pre-flight. Verifies `.switchboard/orchestrator/session.md` exists, then flips `orchestrationConfig.enabled` to true and applies agent-managed mode. Returns `{ success, sessionFile }` or `{ success:false, error }` when `session.md` is absent. The only path that arms |
| `POST /orchestration/stop` | — | Disarm the orchestrator and archive `session.md` to `sessions/session-<ISO>.md` |

```bash
# Column vocabulary: CREATED | PLAN REVIEWED | LEAD CODED | CODER CODED | INTERN CODED
#                    | CODE REVIEWED | ACCEPTANCE TESTED | COMPLETED   (see GET /kanban/columns)
curl -s -X POST "$BASE/kanban/move" -H "Content-Type: application/json" \
  -d '{"planId":"a1b2c3d4","targetColumn":"CODE REVIEWED"}'

curl -s -X POST "$BASE/kanban/feature" -H "Content-Type: application/json" \
  -d '{"name":"Auth Refactor","planIds":["id1","id2"],"description":"Group the auth work."}'
```

---

## 4b. Prompt delivery (POST /terminals/verb/*) — attended coder driving

When you are a head agent **driving a coder terminal** (dispatch a subtask, get called back,
review the diff, resend a fix) — not running an unattended column sweep — use the
prompt-delivery verb pair. The full contract lives in the
**`terminal-coder-dispatch`** skill; the endpoints are:

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /terminals/verb/ptySendPrompt` | `{ name, data, clearBeforePrompt }` | Deliver a prompt to a named terminal. **Pass `clearBeforePrompt: false` explicitly** — the omitted-field default has moved once already; if it moves back, every send wipes the coder's conversation. Both hosts apply standing orders (the callback contract). |
| `POST /terminals/verb/ptyListTerminals` | `{}` | Enumerate live terminals: `{ terminals: [...], hiddenTerminals: [...] }`. Copy `friendlyName` verbatim. |
| `POST /terminals/verb/ptyClearTerminal` | `{ name }` | Reset a named terminal's context. Send it when you put a terminal **at rest** — a clear issued at rest is what resets a coder you always send with `clearBeforePrompt: false`, and it lands long before the next dispatch instead of racing it. Never send it to your own terminal, and never use `ptyClearAllTerminals` (it clears every active terminal, you included). |

Clear a coder the moment you stand it down, not on the way back in — see
`terminal-coder-dispatch`, "Resting a terminal", for the precondition (completion received
**and** next work assigned elsewhere) and the self-clear prohibition.

---

## 5. Comms (POST)

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

You were dispatched into a worktree to code or review one plan. You report back to your head
agent via `ptySendPrompt` (installed as a standing order on every team member). You do **not**
have a chat channel to the orchestrator; you use HTTP for board reads.

```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"

# 1. Find your plan (its planId is in your dispatch prompt) and read its full spec.
curl -s "$BASE/kanban/plan?planId=$PLAN_ID" | jq -r '.data.content'

# 2. Do the work in this worktree. Commit as you go (the orchestrator verifies via git, not chat).

# 3. Report back to your head agent when done (the standing order installed on dispatch).
#    The head agent or the extension's turn-end notifier will signal the orchestrator.
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

# 3. For each feature, read its subtasks + message the team leads (or dispatch to your own agents).
curl -s "$BASE/kanban/plans?featureId=$FEATURE_ID" | jq '.data'
curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" -H "Content-Type: application/json" -d "{
  \"name\":\"<lead terminal friendlyName>\",
  \"data\":\"You are leading the <feature name> feature. Your PLAN REVIEWED subtasks are: <list>. Implement each, commit, and report back when done.\",
  \"clearBeforePrompt\":false}"

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
If the API server is down you can still communicate via the filesystem (the orchestrator reads these):
- **Session file:** `.switchboard/orchestrator/session.md` — the current session file (Rules + append-only Log); read it to see the orchestrator's decisions. The legacy `.switchboard/orchestrator/session-log.md` is still honoured as a fallback by `GET /orchestrator/session-log` on installs that have one.
- **Progress:** `.switchboard/orchestrator/progress.json` — the orchestrator's per-plan stall state.

## Notes
- localhost only (127.0.0.1) — never a public interface.
- Reads wrap payloads in `.data`; mutations return `{ success, ...fields }`.
- This surface is documented for external tools; the in-VS-Code orchestrator persona is `switchboard-orchestrator`.
