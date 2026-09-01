# Skill: Switchboard Orchestration HTTP Surface

This is the **complete** HTTP contract for driving Switchboard from outside the VS Code webview —
whether you are a **fleet coding/review agent** working inside a Mission Control worktree, an
**external Mission Control** (Cursor / Zed / Claude Code / Antigravity) driving the whole board, or a
**team member** (a discoverable-skill agent) reading the local board.

Switchboard's LocalApiServer runs inside the VS Code extension and is the **sole writer** of
`kanban.db`. You never touch the DB directly — you call these endpoints. The board is the source
of truth; the UI is just one view of it.

> **Endpoint inventory.** The hand-written list below is a subset for the calls agents most often
> make. The **authoritative, generated inventory is `GET /catalog`** — it lists every verb,
> endpoint, and prefix the server actually serves (drift-checked in CI via `catalog:check`), so it
> can never lag behind the server the way a hand-maintained list can. When you need a call this
> document does not cover, hit `GET /catalog` first; the payload contract for any call below still
> lives here, since the catalog carries only `{path, method, prefix}` and not request shapes.

> **Behavior vs. invocation.** This skill is the *invocation* authority (endpoints, verbs,
> payload fields). For *behavior* contracts — how the system behaves (cards move on coding
> start, completion = plan-file mtime advance, plan files are write-once-at-the-end, subtask
> column exclusion) — consult **`.agents/protocols/switchboard-contracts/SKILL.md`**. Never consult that skill
> for invocation; never consult this skill for behavior conventions.

---

## 1. Bootstrap

> **If your prompt includes a `SWITCHBOARD STATUS: Live` line, skip this port-discovery/health-check section — you already know the port and that the server is up. Use the port from that line directly. This section is for external agents connecting independently.**

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
| `GET /mission-control/session-log` | Mission Control's session file — `.switchboard/mission-control/session.md` when it exists, falling back to the legacy `.switchboard/mission-control/session-log.md` (markdown string, `''` when neither exists) |

```bash
curl -s "$BASE/kanban/board"
curl -s "$BASE/kanban/plans?column=PLAN%20REVIEWED"
curl -s "$BASE/kanban/plan?planId=a1b2c3d4"      # includes .data.content (the .md file)
curl -s "$BASE/kanban/features"
curl -s "$BASE/worktree/list"
```

> **⚠ `planId` is NOT a valid query filter on `GET /kanban/plans`.** The handler
> (`_handleGetPlans`, LocalApiServer.ts:6483) reads only `column` and `featureId`
> from the query string — a `planId` param is silently ignored and the **full
> workspace array** is returned. An agent consuming `res.data[0]` then inspects
> whichever card happens to be first in the DB (often from a different column),
> generating false reports. For a single plan, use `GET /kanban/plan?planId=<id>`
> (returns one plan plus its file content at `.data.content`). Client-side
> filtering (`res.data.find(p => p.planId === id)`) works but fetches the whole
> board — prefer the dedicated endpoint.
>
> **Column filter requires the storage column id**, not the board label.
> `GET /kanban/plans?column=Planned` returns an empty array — the stored id is
> `PLAN REVIEWED`, URL-encoded as `PLAN%20REVIEWED`. See the column-translation
> table in `query-kanban/SKILL.md` or call `GET /kanban/columns` for the live
> `{id, label}` mapping.

Plan records include: `planId`, `sessionId`, `topic`, `planFile`, `kanbanColumn`, `status`,
`complexity`, `tags`, `project`, `isFeature`, `featureId`, `worktreeId`, `worktreeStatus`,
`dispatchedAt` (null = not currently working), `recommendedRole`.

`recommendedRole` (`lead` | `coder` | `intern`) is the seat the **board** would route this plan
to — resolved through the operator's `kanban.routingMapConfig` and the pair-mode intern bypass,
the same rule `POST /kanban/dispatch` uses for `"auto"`. Dispatch a subtask to a seat of that
role on your team; if your team has no such seat, dispatch to a coder and say why. Absent when
the plan's complexity is unknown — treat absence as `coder`. Do **not** re-derive it by reading
the plan file's `Recommendation:` line: nothing in the system parses that line, and a remapped
board or an active pair mode would make it wrong.

---

## 3. Plan lifecycle (POST / PUT / DELETE)

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /kanban/plans` | `{ title, slug?, complexity?, tags?, project?, description?, body?, workspaceRoot? }` | Create a plan (writes `.switchboard/plans/<slug>.md`, imports it, returns assigned `planId`). `workspaceRoot` must match a server root from `GET /health` (`roots`), else `400`. |
| `DELETE /kanban/plans?planId=<id>[&deleteFile=true]` | — | Delete the DB row; `deleteFile=true` also unlinks the `.md` |
| `PUT /kanban/plans/project` | `{ planId, project, workspaceRoot? }` | Set a plan's project |
| `PUT /kanban/plans/complexity` | `{ planId, complexity, workspaceRoot? }` | Set a plan's complexity (`"1"`–`"10"` or `"Unknown"`) |
| `PUT /kanban/plans/priority` | `{ planId, starred, workspaceRoot? }` | Set a plan's priority star (`starred: true/false/1/0/"true"/"false"`). Starred cards sort first in every consumer. Idempotent. Accepts `sessionId` as an alias for `planId`. Returns `{ success, planId, starred }`. |
| `POST /kanban/plans/import` | `{ workspaceRoot? }` | Rescan `.switchboard/plans/*.md` and upsert. `workspaceRoot` must match a server root from `GET /health` (`roots`), else `400`. |

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

curl -s -X PUT "$BASE/kanban/plans/priority" -H "Content-Type: application/json" \
  -d '{"planId":"a1b2c3d4","starred":true}'

curl -s -X DELETE "$BASE/kanban/plans?planId=a1b2c3d4"                    # DB row only
curl -s -X DELETE "$BASE/kanban/plans?planId=a1b2c3d4&deleteFile=true"    # also remove the file
```

> **`workspaceRoot` validation:** `POST /kanban/plans` and `POST /kanban/plans/import` require `workspaceRoot`
> (if provided) to match a known registered workspace root as reported by `GET /health` → `roots`.
> Any unregistered root (or a differently-cased / symlinked spelling that does not match) is refused with `400`.

> **`delete_plan` gotcha:** without `deleteFile=true`, the `.md` file stays on disk and the plan
> **re-appears on the next `import_plans`** (or a webview reset). Use `deleteFile=true` for a
> permanent delete. `create_plan` refuses to overwrite an existing file (`409`) and rejects
> path-traversal slugs (`400`).

---

## 4. Board mutations (POST)

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /kanban/dispatch` | `{ plan: planId or plan-file path, targetColumn?, workspaceRoot?, from? }` | ONE-call advance-and-dispatch. `targetColumn` omitted/`"auto"` → routed by plan complexity through the board's own rule (default bands 1–4 → INTERN CODED, 5–6 → CODER CODED, 7+/unknown → LEAD CODED; custom routing maps + pair-mode bypass honored; decision returned in `routing`). Canonicalizes explicit columns, persists the move, fires the column's role prompt (CLI-triggers setting does not gate API dispatches), verifies vs DB. Honest response (`moved`, `dispatched`, `dispatchedAt`); 4xx/409 when it can't work (no role on column, no live terminal agent). Prefer this over move + raw `triggerAction` (whose exact webview field names and hollow `{success:true}` acks hide no-ops). `from` — your own terminal name. Supply it and a role dispatch (e.g. CODE REVIEWED → reviewer) is routed to the member of YOUR team rather than the first matching terminal on the board. The response echoes `teamRouting` naming the decision, including when it fell back |
| `POST /kanban/queue/next` | `{ from, workspaceRoot? }` | The coding lead's pull door onto the same dispatch machinery `POST /kanban/dispatch` is. Pops the next staged card (STAGING column only; subtasks excluded via empty `featureId`), dispatches it through `performKanbanDispatch` with `targetTerminalOverride: from` (complexity routing picks the column, the requesting head is the terminal — the lead asked, the lead receives, and it delegates subtasks itself), and returns what it dispatched. **The head is the expected caller** — call this after you have posted `POST /kanban/task/complete` for the card your team holds. Three response shapes: `200 { success:true, dispatched:{...} }` (a card was popped and dispatched — work it), `200 { success:true, dispatched:null, reason:'queue empty' }` (the session is ending normally — report and stop), and `409 { success:false, error, inFlight:{...} }` (a seat on your team still HOLDS a card with no completion post — `completed_at` is the only fact that releases a team, in any column; POST `/kanban/task/complete` for the planId named in `inFlight` before asking again. Moving the card releases nothing). The pop is serialized per-process so two heads asking at once never receive the same card. A failed dispatch (no live terminal, card dragged out) is passed through and the card stays staged. `from` is the head's own terminal name; an unresolvable `from` is a `400`. The route is a thin wrapper over the in-process `dispatchNextFromQueue` method — the schedule timer and the handoff call the method directly so the serialization chain is the single critical section |
| `POST /kanban/move` | `{ planId or sessionId, targetColumn, workspaceRoot? }` | Move a card (feature cascade + tracker sync inherited). Column IDs are canonical uppercase (`LEAD CODED`), never state-file slugs (`lead-coded`) — both endpoints canonicalize and 400 on unknown columns. `workspaceRoot` omitted ⇒ resolved by identity across all registered roots (`GET /health` → `roots`); supplied ⇒ that root or a not-found error. Response echoes `resolvedWorkspaceRoot` and `rootResolution` (`explicit`/`default`/`searched`/`path`). Unavailable (503) on the standalone host |
| `POST /kanban/feature` | `{ name, planIds: [...], description?, workspaceRoot? }` | Create a feature from plan IDs |
| `POST /kanban/feature/assign` | `{ featurePlanId, planIds: [...], workspaceRoot? }` | Assign plans to a feature |
| `POST /kanban/feature/remove` | `{ subtaskPlanId, workspaceRoot? }` | Detach a subtask from its feature |
| `POST /kanban/feature/delete` | `{ featurePlanId, deleteSubtasks?, workspaceRoot? }` | Delete a feature |
| `POST /kanban/feature/split` | `{ featurePlanId, keptPlanIds: [...], firstFeatureName, secondFeatureName, workspaceRoot? }` | Split a feature in two |
| `POST /worktree/cleanup` | `{ worktreeId or branch, workspaceRoot? }` | Mark a worktree merged and clean it up (kind-aware) |
| `POST /mission-control/adopt` | `{ workspaceRoot?, terminalName? }` | **The caller IS Mission Control.** Records the seat and returns `{ mode, prompt, seat, liveDelivery, note? }` — the same pre-flight prompt `/mission-control/start` would have injected into a terminal it created, handed back so you run it in your own session. Seats no terminal. **Does not arm** — arming is `POST /mission-control/confirm`. Pass `terminalName` from `$SWITCHBOARD_TERMINAL` when set; omitted or unmatched → `liveDelivery: false` and turn-end notices arrive in the reports inbox instead |
| `POST /mission-control/start` | `{ workspaceRoot? }` | Two paths, decided by whether a lead/coder agent is configured. **Terminal mode**: create a pty terminal named `Mission Control`, boot the lead/coder CLI into it, and deliver the pre-flight interview (the agent adopts the seat itself via `POST /mission-control/adopt` — the server does NOT seat). **Clipboard mode** (no agent configured, or pty unavailable): NO terminal is created; returns `{ mode:'clipboard', prompt }` with the `/switchboard` launcher text for the caller to run. **Does not arm** in either path — the terminal-mode message says Mission Control is seated and awaiting confirmation; arming is `POST /mission-control/confirm`. Double-click protection: a second call while an `Mission Control` terminal is already live redelivers the persona prompt to it instead of spawning a second terminal |
| `POST /mission-control/confirm` | `{ workspaceRoot? }` | Arm a Mission Control session after the pre-flight. Verifies `.switchboard/mission-control/session.md` exists, then arms Mission Control switch (sets `missionControlArmed`; the schedule switch is independent and may also be on). Returns `{ success, sessionFile }` or `{ success:false, error }` when `session.md` is absent. The only path that arms |
| `POST /mission-control/handoff` | `{ headTerminal, stagedCount?, firstCardPlanId?, summary, workspaceRoot? }` | Hand off Mission Control to a coding lead and exit (default pre-flight exit). Refuses with 409 if no live coding head, if queue is empty, if already armed, or if already handed off. Writes summary to session log, closes Mission Control seat, and leaves automation state untouched |
| `POST /mission-control/stop` | — | Disarm Mission Control and archive `session.md` to `sessions/session-<ISO>.md` |

```bash
# Column vocabulary: CREATED | PLAN REVIEWED | LEAD CODED | CODER CODED | INTERN CODED
#                    | CODE REVIEWED | ACCEPTANCE TESTED | COMPLETED   (see GET /kanban/columns)
curl -s -X POST "$BASE/kanban/move" -H "Content-Type: application/json" \
  -d '{"planId":"a1b2c3d4","targetColumn":"CODE REVIEWED"}'

curl -s -X POST "$BASE/kanban/feature" -H "Content-Type: application/json" \
  -d '{"name":"Auth Refactor","planIds":["id1","id2"],"description":"Group the auth work."}'
```

---

## 4a. Verb-rail traps (read before you call `POST /<panel>/verb/<name>`)

The generic verb rail (`POST /<panel>/verb/<name>`) routes webview messages through
the same handler a UI click takes. Two traps hide on this surface, and they share
one failure mode: **the route answers `{success:true}` and nothing happens.** An
agent cannot detect the no-op from the response, so it reports success and moves
on — the most expensive class of bug on this surface.

### Trap 1 — read verbs return only `{success:true}`

Read verbs (`get*` / `fetch*` / `load*`) over the generic rail return only
`{success:true}` — their data arrives on the **WS hub**, which an HTTP client
cannot see. The call looks successful and returns nothing.

**Use the dedicated GET endpoints instead:** `GET /kanban/board`,
`GET /kanban/plans`, `GET /kanban/plan?planId=<id>`. They return the data in
the response body (wrapped in `.data`).

### Trap 2 — exact webview field names

Raw verbs expect the **exact webview message field names**. The two that bite:

- `triggerAction` takes `{ sessionId, targetColumn }` — **not** `planId`, **not** `column`.
- `promptOnDrop` takes `{ sessionIds, sourceColumn, targetColumn }` — **not** `planId`, **not** `column`.

Wrong names (`planId`, `column`) make the arm silently no-op while the route
layer still answers `{success:true}` — the call LOOKS successful and nothing
happened.

**Prefer the first-class endpoints** (`POST /kanban/dispatch`, `POST /kanban/move`)
— they validate, canonicalize columns, verify against the DB, and return honest
errors. Use raw verbs only when no endpoint exists, and **verify the effect
afterwards** (`GET /kanban/plan?planId=<id>` → check `dispatchedAt` and
`kanbanColumn`).

---

## 4b. Prompt delivery (POST /terminals/verb/*) — attended coder driving

When you are a head agent **driving a coder terminal** (dispatch a subtask, get called back,
review the diff, resend a fix) — not running an unattended column sweep — use the
prompt-delivery verb pair. The behavioral rules are inlined in the enriched
drive prefix built by `_buildDrivePrefix` in KanbanProvider.ts; the endpoints are:

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /terminals/verb/ptySendPrompt` | `{ name, data, clearBeforePrompt, origin?, dispatch?, kind?, machineOrigin? }` | Deliver a prompt to a named terminal. **Pass `clearBeforePrompt: false` explicitly** — the omitted-field default has moved once already; if it moves back, every send wipes the coder's conversation. Both hosts apply standing orders (the callback contract) unless `kind: "message"` or `machineOrigin: true` is passed. **Payload kinds:**<br>• `kind: "dispatch"` — seat starting work; receives standing orders, seat directive block, and dispatch directives.<br>• `kind: "message"` (or legacy alias `machineOrigin: true`, to be retired once coder standing-order texts are reissued) — questions, instructions, relayed messages, and notifications; suppresses all three appends.<br>• `kind: "orders-refresh"` — reserved for after-clear delivery path (rejected if sent).<br>Omitted `kind` defaults to `dispatch` if `dispatch` object is supplied or if prompt text contains dispatch identity (`PLANS TO PROCESS:`), and defaults to `message` otherwise. **Dispatching a subtask? Pass `dispatch: { planFile\|planId, role }`** — the host then registers the dispatch before delivering *and* attaches the protocol directives the board attaches (plan-file completion report + Mission Control reports directive), echoing `attributed` and `directivesAttached`. Without it the coder is never told to write a completion report, so a finished subtask reports nothing the board can see. Fails closed: `attributed: 0` → `success: false`, nothing delivered. Never send `dispatch` on a plain message or on a report back to your head — it would make the recipient write a plan file and fire a false `completed`. The dispatch-protocol directives (COMPLETION REPORT, ORCHESTRATOR REPORT) are appended automatically for coder/intern/lead recipients — do not paste your own. **Messaging or dispatching from your own seat? Pass `origin: "<your own terminal name>"`** — the roster barrier clears the rest of the team when a new feature enters it, and `origin` is how it knows not to clear *you*. Without it a lead can wipe its own context with its own dispatch; the busy check only saves a seat that happens to be emitting output at that instant. Omit it only when you are relaying a human's board action. |
| `POST /terminals/verb/ptyListTerminals` | `{}` | Enumerate live terminals: `{ terminals: [...] }` — one array, every live terminal. Copy `friendlyName` verbatim. |
| `POST /terminals/clear` | `{ from, name? \| team? \| seats? }` | Canonical first-class clear endpoint. Clears a single seat (`name`), team roster (`team`), or explicit set (`seats`). Enforces server-side invariants: `from` is required and never cleared; team scope preserves the lead and defers mid-turn seats; redelivers standing orders; rolls log session boundary. Returns `{ success: true, cleared: [...], deferred: [...], skipped: [{ name, reason }] }`. |

*(Note: `POST /terminals/verb/ptyClearTerminal` remains as a low-level host verb used internally, but `POST /terminals/clear` is the canonical agent-facing endpoint.)*

### `ptySendPrompt` delivery evidence & response fields

- **`success: true`**: Bytes were written to the pty and the submit CR was sent. It is not an echo, not a round trip, and not a claim that the CLI parsed anything.
- **`bytesWritten`**: UTF-8 byte length of text written to the terminal, including host-appended directive, seat, and standing-orders blocks. It is **expected** to exceed the length of your `data` field. A larger number is not evidence of corruption.
- **`promptSeq`**: That seat's delivery ordinal (post-increment `promptCount`). Re-reading `promptCount` on `ptyListTerminals` and seeing it advance *past* your `promptSeq` means a **later** send landed, not that yours did — your own evidence is the `promptSeq` on your own response.
- **`lastDataAt`**: The seat's **output** heartbeat from `ptyListTerminals`. It proves the CLI emitted something; it never proves the CLI received something.

Clear a coder the moment you stand it down, not on the way back in — the
precondition is completion received **and** next work assigned elsewhere, and
never clear your own terminal (see the inlined "Clear a terminal only when at
rest" rule in the drive prefix).

### Terminal Reset & Clear Protocol — why `/clear` via `ptySendPrompt` fails

Agents frequently try to clear a terminal by sending `/clear` through
`ptySendPrompt`. **This does not work, pollutes the prompt, and is rejected.**

`ptySendPrompt` wraps `data` in bracketed-paste escape sequences
(`\x1b[200~ ... \x1b[201~`). A CLI receiving bracketed-paste `/clear` treats it
as **literal text input**, not a slash command. Inside the block it is absorbed as
literal text and silently prefixes or pollutes the payload with appended orders.
Sending bare slash commands like `/clear` via `ptySendPrompt` is rejected by the
server with an error directing callers to `POST /terminals/clear`.

**The canonical mechanism is `POST /terminals/clear`**:

```bash
# Clear a single seat
curl -s -X POST "$BASE/terminals/clear" -H "Content-Type: application/json" \
  -d '{"name":"<terminal friendlyName>","from":"<your terminal name>"}'

# Clear team terminals
curl -s -X POST "$BASE/terminals/clear" -H "Content-Type: application/json" \
  -d '{"team":"<head terminal friendlyName or teamId>","from":"<your terminal name>"}'
```

**Rules:**
- `from` is required on all calls to prevent accidental caller context wipe.
- Clear a coder the moment you stand it down, not on the way back in. A clear
  issued at rest is what resets a coder you always send with
  `clearBeforePrompt: false`, and it lands long before the next dispatch
  instead of racing it.
- Never clear your own terminal.
- Never use `ptyClearAllTerminals` (it clears every active terminal, you
  included).

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
have a chat channel to Mission Control; you use HTTP for board reads.

```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"

# 1. Find your plan (its planId is in your dispatch prompt) and read its full spec.
curl -s "$BASE/kanban/plan?planId=$PLAN_ID" | jq -r '.data.content'

# 2. Do the work in this worktree. Commit as you go (Mission Control verifies via git, not chat).

# 3. Report back to your head agent when done (the standing order installed on dispatch).
#    The head agent or the extension's turn-end notifier will signal Mission Control.
```

You do **not** move your own card or merge — Mission Control does that after verifying your git state.

---

## 8. Workflow B — external Mission Control driving the board

You are an external agent acting as Mission Control. Mirror the in-VS-Code persona
(`switchboard-mission-control`): coding + code-review only; planner-stage questions escalate to the human.

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
  \"origin\":\"<your own terminal friendlyName>\",
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

## 9a. Fleet Completion Detection Recipe

When an operator asks you to monitor a fleet until completion, three concrete
signals define "done". Check them in order; the first non-null/stopping signal
wins.

1. **Database signal — `completedAt`.** `completed_at` is non-null on the plan
   record (written by `POST /kanban/task/complete` via `setCompletedAt`). Read
   it via `GET /kanban/plan?planId=<id>` → `.data.completedAt`. **NULL means the
   team is still working** — do not report completion.
   - The `completed_at` write is **idempotent** — a repeat `POST /kanban/task/complete`
     for the same planId returns the existing timestamp without re-writing. When
     polling, a stable timestamp is not a new event; do not re-report.

2. **Queue signal — `POST /kanban/queue/next`.** Returns
   `200 { success: true, dispatched: null, reason: "queue empty" }` when the
   session is ending normally — report and stop. (The response is wrapped in the
   standard success envelope; an agent parsing for a bare `{ dispatched, reason }`
   object will not find it under `res.data` and may misread the response.)
   - A `409 { success: false, error, inFlight: {...} }` means a seat on your team
     still HOLDS a card with no completion post — post
     `POST /kanban/task/complete` for the `inFlight` planId before asking again.
     Moving the card releases nothing.

3. **Git signal — `Switchboard-Plan` trailer.** A commit on the integration
   branch (`main` or the feature's shared worktree branch) carrying the git
   trailer `Switchboard-Plan: <planId>` (one line per planId in a batch
   dispatch), preceded by `Switchboard-Stage: <stage>`. The trailer block
   requires a blank line before it (git only parses trailers in the message's
   final paragraph). Verify with:
   ```bash
   git log --format='%(trailers:key=Switchboard-Plan,valueonly)'
   ```

**All three are ground truth; an agent's self-reported "done" is not.** Trust
the database timestamp, the queue response, and the git trailer — never a chat
claim.

---

## 10. Failure modes
- **`SWITCHBOARD_NOT_RUNNING`** — port file missing or `/health` fails → tell the user to start the extension. Never edit `kanban.db` directly.
- **`404`** — plan/feature/worktree not found (bad id).
- **`400`** — invalid input (bad column, empty body, path-traversal slug); the message names the problem.
- **`409`** — `create_plan` slug already exists.
- **`503`** — DB/extension not ready yet → retry after a short delay.

## 11. File-based fallback (no HTTP)
If the API server is down you can still communicate via the filesystem (Mission Control reads these):
- **Session file:** `.switchboard/mission-control/session.md` — the current session file (Rules + append-only Log); read it to see Mission Control's decisions. The legacy `.switchboard/mission-control/session-log.md` is still honoured as a fallback by `GET /mission-control/session-log` on installs that have one.
- **Progress:** `.switchboard/mission-control/progress.json` — Mission Control's per-plan stall state.

### Reports channel — `.switchboard/mission-control/reports/`

A **report is a message *to* Mission Control**; the session file is Mission Control's own record. Do not write your update into the session file, and do not write it into the plan file — plan files are write-once-at-the-end, so a mid-work edit breaks completion detection for that card.

This is a directory convention, **not an HTTP surface**. There is no endpoint. Post a file; Mission Control lists the directory on its next wake.

**Write one file per report, never rewritten:**

```
.switchboard/mission-control/reports/report-<UTC-compact>-<kind>-<5 digits>.md
```

`<UTC-compact>` is an ISO timestamp with `-` and `:` stripped and the milliseconds dropped (`20260817T031403Z`). The 5-digit random tail is what keeps two agents posting in the same second from colliding — pick a fresh one and retry if the name is taken.

```markdown
---
from: Coding-lead
kind: blocked          # finished | blocked | question | status
planId: <planId>       # or feature: <featureId>
created: 2026-08-17T03:14:03Z
---

Subtask 3 needs a decision on the migration key before I can continue.
```

- Every frontmatter value is a single line. A value containing a newline is flattened on write — this is deliberate, so a message body cannot forge a `kind:` or `from:` key.
- `from: system` marks a report the extension wrote itself: each `[switchboard:turn-end]` notice is mirrored here (`finished` when a seat completed, `blocked` when it went quiet or a feature stalled) so a non-pty Mission Control sees the same notices a pty one is sent.
- An unrecognised `kind` reads as `status`. Mis-binning a message beats dropping it.

**Claiming.** Mission Control marks what it has acted on by writing `reports/claimed/<report-filename>.claim`:

```
claimed_ts: 2026-08-17T03:15:11Z
agent: mission-control
```

A claim older than the staleness window (**24 hours** by default) reads as unclaimed again, so a long-running session can legitimately re-surface a report it already handled. Claims are a de-duplication record across ticks of one agent — Mission Control is a singleton — **not** a mutual-exclusion lock between agents. Do not rely on them for exclusion.

This sits alongside `ptySendPrompt`, it does not replace it: a pty-hosted lead reporting to a pty-hosted head keeps working exactly as it does now.

## Notes
- localhost only (127.0.0.1) — never a public interface.
- Reads wrap payloads in `.data`; mutations return `{ success, ...fields }`.
- This surface is documented for external tools; the in-VS-Code Mission Control persona is `switchboard-mission-control`.

### Remote & Mobile Network Addressing (Tailscale)

When the operator machine is reachable over Tailscale, the board and terminals
are addressable at `http://100.x.y.z:7777` (the Tailscale IP, port from the live
server). SSH access to the host requires **key-based authentication** when
password auth is hardened — the operator must have a registered SSH key, not a
password.

**Tailscale IS the network boundary.** The API server must never be exposed on
a public interface. Tailscale's encrypted mesh is the controlled boundary that
replaces exposing a port to the open internet; it is not a hole in the localhost
boundary, it is the boundary itself.
