# Query Kanban

Read kanban board state. **READ-ONLY** — this skill never writes. Card moves go through
the `kanban_operations` skill (`move-card.js` / `POST /kanban/move`), never through SQL.

## Preconditions

The **primary method is the LocalApiServer read endpoints**, reached through the
Switchboard CLI. You need:

1. **A running Switchboard host** — the VS Code extension with its API server, or the
   standalone/npx host. Probe it exactly the way `manage-features` does:
   ```bash
   switchboard api GET /health     # -> { status: 'ok', port, roots: [...] }
   ```
2. **Nothing else.** The CLI owns port discovery, the `/health` probe and token
   attachment. Do not resolve a port yourself.

**When absent** — `switchboard api` reports no running Switchboard: say so and stop.
The board is **not reachable from this session**. That is **not a fault** and not
something to route around: it is expected in a cloud VM, a tracker-only session, or on a
machine where the extension is not open. Report it as the configuration fact it is, then
ask the user to start the host. Do **not** hand-write SQL to compensate, and do not
report an empty board.

> **Why endpoints and not the file.** `.gitignore` ignores `.switchboard/*`, so a fresh
> per-feature worktree checkout has no database and no port file at all — a direct read
> from inside a worktree is broken today, not eventually. The endpoints work from any
> directory because the CLI finds the host, not the file. The endpoints also span the
> board's storage window (see below), canonicalise column ids, and honour the
> resolve-only project semantics; a raw file read does none of that.

## Primary method — the LocalApiServer read endpoints

Every read returns `{ "success": true, "data": <payload> }`.

| Endpoint | Returns |
|---|---|
| `GET /kanban/board` | Every active plan record for the workspace |
| `GET /kanban/plans?column=<id>` | Plans in one column (storage id, URL-encoded) |
| `GET /kanban/plans?featureId=<id>` | Subtasks of a feature |
| `GET /kanban/plan?planId=<id>` | **One** plan record, its file content (`.data.content`), and `.data.source` |
| `GET /kanban/columns` | The live `{id, label, enabled, enabledSource}` catalogue — built-in and custom |
| `GET /kanban/features` | All features (`isFeature` rows) |

```bash
switchboard api GET /kanban/board
switchboard api GET "/kanban/plans?column=PLAN%20REVIEWED"
switchboard api GET "/kanban/plan?planId=<planId>"
switchboard api GET /kanban/columns
switchboard api GET /kanban/features
```

`?workspaceRoot=<root>` scopes any of these to a specific root from `/health`'s `roots`;
omit it for the primary workspace.

### Three outcomes, and you must branch on all three

A read has exactly three answers. Two of them used to look identical, and that is what
made an agent report an empty board it could not see:

| Outcome | Shape | What it means |
|---|---|---|
| **Rows** | `200` `{success:true, data:[...]}` (or `data:{}`) | The store answered. An empty `data:[]` here genuinely means *no cards match*. |
| **No such record** | `404` `{error:"Plan not found: <id>"}` | The card does not exist in the board window **or** the archive. Both were searched. |
| **Store unavailable** | `503` `{error, code:"STORE_UNAVAILABLE", tier}` | The store did not answer. **Say nothing about the board's contents.** |

On `STORE_UNAVAILABLE`: report the store as unreachable and name `tier` (`board` or
`archive`). Retry **once** after a few seconds; if it repeats, stop and tell the user.
Never treat it as an empty board, and never loop on it.

### `GET /kanban/plan` spans the archive and tells you which store answered

A completed card that has aged past the board's window moves to the archive store. A
record lookup **spans both** and labels the result:

- `.data.source === 'board'` — the live board store.
- `.data.source === 'archive'` — past the window, still found, returned exactly once.

So a `404` from this endpoint means the card exists in neither store — it is a real
absence, not an aged card. Collection reads (`/kanban/board`, `/kanban/plans`,
`/kanban/features`) stay **windowed** and deliberately exclude dormant cards: that is the
human board's view. To ask about a specific old card, use `GET /kanban/plan?planId=`.

> **`planId` is not a filter on `GET /kanban/plans`.** That handler reads only `column`
> and `featureId`; a `planId` param is ignored and the full workspace array comes back.
> Reading `data[0]` then inspects an unrelated card. Use `GET /kanban/plan?planId=`.

### ⚠️ Users say the BOARD LABEL, not the stored column id — translate silently

`kanban_column` values are **storage ids**. They are NOT what the user sees on the board,
and NOT what the user will say to you. When a user names a column, they mean the label.
Map it and move on — **never** reply that a column "doesn't exist" or list storage ids
back at them. That is a bug in your response, not a correction.

| Board label (what the user says) | `kanban_column` (what you query) |
| :--- | :--- |
| **New** | `CREATED` |
| **Backlog** | `BACKLOG` *(display mode of `CREATED`)* |
| **Planned** | `PLAN REVIEWED` |
| **Dispatch** | `DISPATCH` *(display mode of `PLAN REVIEWED`)* |
| **Researcher** | `RESEARCHER` |
| **Lead Coder** | `LEAD CODED` |
| **Coder** | `CODER CODED` |
| **Intern** | `INTERN CODED` |
| **Reviewed** | `CODE REVIEWED` |
| **Acceptance Tested** | `ACCEPTANCE TESTED` |
| **Ticket Updater** | `TICKET UPDATER` |
| **Completed** | `COMPLETED` |

**Three traps — guessing gets these wrong:**
- **"Planned" is `PLAN REVIEWED`.** There is no column stored as `PLANNED`.
- **"Reviewed" is `CODE REVIEWED`, not `PLAN REVIEWED`.** The label that *looks* like
  `PLAN REVIEWED` belongs to a different column. Resolving "Reviewed" to `PLAN REVIEWED`
  reads the wrong column, and on a write path moves cards backwards through the workflow.
- **"New" is `CREATED`.** Nothing is stored as `NEW`.

**Custom columns:** users can add their own, with labels this table cannot cover. The
authoritative live mapping is `GET /kanban/columns`, which tags every column with
`enabled` (`true`/`false`) and `enabledSource` (`'config' | 'default' | 'structural' |
'unknown'`). Destinations must be filtered to `enabled !== false`; a disabled column may
still hold historical cards. Source of truth in code is `DEFAULT_KANBAN_COLUMNS` /
`DISPLAY_MODE_COLUMNS` in `src/services/agentConfig.ts` — if this table ever disagrees
with that file, the file wins and this table is stale.

**If a label is genuinely ambiguous**, query the closest match and say which column you
read (*"Planned (`PLAN REVIEWED`) has 3 plans"*) — one clause, then the answer. Do not
open with a correction, and do not ask the user to restate the column in storage terms.

### Common reads

```bash
# Everything in one column
switchboard api GET "/kanban/plans?column=BACKLOG"

# Dependency-gate check — the three pre-coding columns
for col in CREATED BACKLOG "PLAN%20REVIEWED"; do
  switchboard api GET "/kanban/plans?column=$col"
done

# One card, with its file content and source label
switchboard api GET "/kanban/plan?planId=<planId>"

# Features, then one feature's subtasks
switchboard api GET /kanban/features
switchboard api GET "/kanban/plans?featureId=<featurePlanId>"
```

Filtering the board client-side (by `project`, `workspaceName`, `complexity`,
`isFeature`, `featureId`) is the right way to answer "which plans are in project X" —
`GET /kanban/board` returns the whole record, so `jq` over it replaces every join the SQL
templates used to spell out.

```bash
# Plans in a project
switchboard api GET /kanban/board | jq '.data[] | select(.project == "MyProject")
  | {planId, topic, kanbanColumn}'

# Unassigned plans
switchboard api GET /kanban/board | jq '.data[] | select(.project == null or .project == "")
  | {planId, topic, kanbanColumn}'

# Subtask counts per feature
switchboard api GET /kanban/board | jq '[.data[] | select(.featureId != null and .featureId != "")]
  | group_by(.featureId) | map({featureId: .[0].featureId, subtasks: length})'

# Card counts per column
switchboard api GET /kanban/board | jq '[.data[] | .kanbanColumn] | group_by(.)
  | map({column: .[0], count: length})'
```

Plan records include: `planId`, `sessionId`, `topic`, `planFile`, `kanbanColumn`,
`status`, `complexity`, `tags`, `project`, `workspaceName`, `isFeature`, `featureId`,
`worktreeId`, `worktreeStatus`, `dispatchedAt` (null = not currently working),
`recommendedRole`.

## Fallback — none for board reads

**Direct SQL is a fallback that no longer exists for this skill.** There is no SQL path
here, by decision and not by omission:

- The endpoints above already cover every read this skill ever performed.
- SQL bypasses column canonicalisation and the resolve-only project semantics, so it
  answers a slightly different question than the board does.
- The label-vs-id trap above is an artifact of SQL, not a fact about the board;
  `GET /kanban/columns` removes it.
- The board's own storage moves — a per-project database, a machine-local runtime tier, a
  windowed board plus an archive, and possibly a remote target with a WAL-mode replica.
  A hard-coded path and a hard-coded column list are wrong in at least one deployment
  mode each, and silently so.
- Dispatch and liveness state (`dispatched_terminal`, `dispatched_at`,
  `last_liveness_at`, `blocked_at`) is **not** in the `plans` table any more. It is
  machine-local runtime state in `plan_runtime_state`, keyed by `plan_id` + `device_id`.
  A query selecting those columns from `plans` fails outright on a current board — and on
  an older one it returns another machine's answer.

If the host is not running, the correct action is the one in **Preconditions**: report the
board as unreachable and stop. Do **not** hand-write SQL, and do not report an empty
board.

## Related skills

- `kanban_operations` — move cards, create/split/delete features (the write path).
- `switchboard-orchestration` — the full HTTP contract for all read and mutation
  endpoints, including response shapes and failure modes.
- `manage-features` — the canonical host-reachability probe this skill reuses.
