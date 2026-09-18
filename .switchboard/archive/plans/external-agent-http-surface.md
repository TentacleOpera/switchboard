---
description: "Expose LocalApiServer's full plan/kanban/feature/orchestration surface to external AI coding tools via new read endpoints + a comprehensive skill. Enables natural-language orchestration from any agent with localhost HTTP access — Switchboard becomes board-as-source-of-truth, UI optional. Companion to the orchestration-automation-mode feature."
---

# External Agent HTTP Surface — Read Endpoints + Orchestration Skill

## Goal

Make Switchboard's full LocalApiServer HTTP surface accessible to **any external AI coding tool** (Antigravity, Zed, Claude Code, Cursor, Windsurf) so it can drive the board — including orchestration — via natural language, with the UI becoming optional rather than required. Two deliverables: (1) the **read endpoints** missing from LocalApiServer today (the mutations already exist), and (2) a **comprehensive skill** that documents the full HTTP contract so an external agent can call it via curl without Switchboard-specific code.

**Why this exists / problem analysis:**

Today, external agents can reach Switchboard's *mutations* — the `kanban_operations`, `linear_api`, `notion_api`, `clickup_api` skills all document HTTP endpoints an agent calls via curl. But they **cannot read board state**: `list_plans`, `get_kanban_state`, `get_feature`, `list_columns` are webview-internal `KanbanDatabase` method calls with no HTTP endpoint. An external agent that can move a card but can't see what's in the columns is flying blind. This is the single gap that prevents external tools from closing the orchestration loop.

The orchestration-automation-mode feature (`orchestration-automation-mode-b4c8934e`) makes this gap acute. That feature's orchestrator operates the board through LocalApiServer operations — grouping, fanning out, triaging, merging — and trusts git/board state as truth. Today the orchestrator is a terminal *inside* VS Code. But the operations it performs are all HTTP-callable (or will be, once the `POST /orchestrator/request` endpoint lands). If the read endpoints exist, an **external AI coding app can be the orchestrator** — it reads the board, groups plans, dispatches work to its own agents, verifies against git, advances cards, and merges, all via HTTP. Switchboard becomes purely natural-language control: the board is the source of truth, the UI is one possible view, and any agent with localhost access can run a batch.

This is the "simple first version" of editor-independent orchestration. No MCP server (the skill + curl pattern already works for mutations and integration proxies — extending it to reads is the smaller change). No standalone service, no terminal fleet, no browser board. The external tool's own terminal/agent context is the execution surface; Switchboard is the board and the HTTP API.

**Why not an MCP server (the alternative this plan replaces):**

An MCP server would wrap these same HTTP endpoints in MCP framing, giving external tools a discoverable, schema-validated tool surface. That has ergonomics value (no skill docs to copy, structured I/O instead of curl+JSON-parsing) but adds no capability — every operation is already reachable via HTTP. The user explicitly rejected the bloat concern: "MCP servers can become very bloated, and I didn't want people to have to have MCP tools running just on the off chance they needed it." The skill + curl pattern is lighter, already proven (the mutation skills ship today), and works with any agent that can run bash. If the skill friction proves painful in practice, an MCP server can be added later as a thin wrapper over these same endpoints — but it's not needed for v1.

**Relationship to orchestration-automation-mode:**

That feature builds the in-VS-Code orchestrator (mode config, kickoff, request channel, wake/triage loop, persona workflow). This plan is what enables the *same orchestration loop* to run from an external tool instead. The two are complementary:
- Orchestration-automation-mode defines the operations (group, fan out, triage, merge) and the `POST /orchestrator/request` endpoint.
- This plan exposes the read surface those operations require, and documents the full HTTP contract so an external agent can perform them.

If orchestration-automation-mode lands first, this plan completes the external-drive path. If this plan lands first, it enables external tools to do everything *except* the orchestration-specific request channel (which is net-new in that feature). Either sequence works.

## Metadata
- **Plan ID:** 7b3e9d2a-1f4c-4a8d-9e6b-2c1f5e8a7d03
- **Tags:** backend, infrastructure, api
- **Complexity:** 6
- **Project:** (unassigned — lands unassigned, can be reassigned on the board)

> **Re-score note (review):** originally 4. Raised to 6 after code verification — the read endpoints are **not** pure additions. LocalApiServer holds no `KanbanDatabase` handle today; every kanban op is an injected callback (`LocalApiServerOptions:9-104`). Exposing reads requires a new `getKanbanDatabase` accessor on the shipped options interface **and** wiring it in `TaskViewerProvider._startLocalApiServer()` (`:1020`), plus a `DELETE` method-guard/CORS fix (`LocalApiServer.ts:1342,1351`) and a root→`workspaceId` (UUID) resolution step in every column-scoped handler. Multi-file, shipped-code surface (~4,000 installs), 11 routes — the Mixed (5-6) band. Routine majority (thin handlers, skill doc, tests) with two moderate, well-scoped risks (accessor linchpin, DELETE guard).

## User Review Required
- None at authoring time. The scope (read endpoints + skill, no MCP server) and the orchestration-context framing were confirmed with the user.

## Scope

### ✅ IN SCOPE
- **Read endpoints on LocalApiServer (new):** `list_plans`, `get_plan`, `get_kanban_state`, `list_columns`, `list_features`, `get_feature` — the reads the webview does internally today, exposed as localhost GET routes. Same localhost boundary check (`LocalApiServer.ts:1334`) as existing endpoints; no new auth.
- **Plan-management endpoints on LocalApiServer (new, thin):** `set_plan_project`, `set_plan_complexity`, `import_plans`, `create_plan`, `delete_plan` — thin handlers wrapping existing `KanbanDatabase` methods. These round out the surface so an external agent can manage plan lifecycle, not just observe and move cards.
- **`external-orchestration` skill (new):** a comprehensive skill file (`.agents/skills/external_orchestration.md` or `.claude/skills/external-orchestration/SKILL.md` — match repo convention) documenting the **full HTTP contract** — every endpoint, its method, payload shape, response shape, and error codes — plus the orchestration workflow an external agent follows (read state → group → dispatch → verify against git → advance → merge → post comments). This is the document an external tool consumes to drive Switchboard.
- **Port discovery documentation:** the skill explains how to find LocalApiServer's port (read `.switchboard/api-server-port.txt`) and probe `/health`. This is the bootstrap step every external agent needs first.

### ⚙️ OUT OF SCOPE
- An MCP server (rejected for v1 — skill + curl is lighter; MCP can be added later as a wrapper if friction warrants).
- Direct DB access from external tools (rejected — LocalApiServer is the sole writer; no clobbering risk).
- The orchestration-automation-mode feature itself (that's a separate feature; this plan enables external-drive of it, doesn't build it).
- The `POST /orchestrator/request` endpoint (that's part of orchestration-automation-mode; this plan's skill documents how to call it once it exists).
- Deep plan authoring via HTTP (`/improve-plan`, adversarial review, prompt generation — stays in the webview/agent workflow).
- Live terminal observation (the external tool's own terminal is the observation surface).
- Autoban / automatic batch dispatch from external tools (the external agent *is* the dispatcher in this model).
- Writing IDE config files (the user configures the external tool manually).

## Architecture

```
External AI coding tool (Antigravity/Zed/Claude Code/Cursor)
  │ reads external-orchestration skill (HTTP contract + workflow)
  │ curl http://127.0.0.1:<port>/...
  ▼
LocalApiServer  (already running inside VS Code extension)
  │ owns kanban.db (sole writer — no clobbering risk)
  │ feature cascade, Linear/ClickUp sync, board refresh, orchestrator/request
  ▼
KanbanDatabase / KanbanProvider / sync services
```

No new process, no new state, no new lifecycle. The external tool is just another localhost HTTP client — same pattern as the `kanban_operations` scripts that ship today. The skill is the documentation that makes it usable without Switchboard-specific knowledge.

## LocalApiServer endpoints (new)

LocalApiServer today exposes mutations (`/kanban/move`, `/kanban/feature/*`, `/comment`, `/worktree/cleanup`, `/phone-a-friend`, `/api/clickup`, `/api/linear`, `/task/*`) but not reads. These are the additions.

### Read endpoints (new GET routes)
| Endpoint | Backing `KanbanDatabase` method | Purpose |
|---|---|---|
| `GET /plans?column=<col>&workspace=<root>` | `getPlansByColumn(workspaceId, column, projectFilter?)` (`KanbanDatabase.ts:3193`) — **single column**; if `column` omitted, iterate `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:122`) and concatenate | List plans, optionally filtered by column |
| `GET /plans/<planId>` | `getPlanByPlanId(planId)` (`KanbanDatabase.ts:3377`) + `fs.readFile` of `plan_file` | Get a single plan with full content |
| `GET /kanban/state?workspace=<root>` | `getPlansByColumn` for every column in `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:122`) | Full board snapshot — the one call an orchestrator makes on wake |
| `GET /kanban/columns` | `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:122`) + custom agent columns from DB | Column definitions (id, label, order, kind, role) |
| `GET /features?workspace=<root>` | `getFeaturePlans(workspaceId)` (`KanbanDatabase.ts:3398`) — returns `is_feature = 1` active plans | List all features |
| `GET /features/<featurePlanId>` | `getPlanByPlanId` (`:3377`) + `getSubtasksByFeatureId(featurePlanId)` (`KanbanDatabase.ts:4634`) | Get a feature with all its subtasks |

> **`workspaceId` resolution (applies to every column/feature-scoped handler):** `KanbanDatabase` methods key off `workspace_id` — the DB **UUID**, not the workspace root path. Endpoints receive `workspace=<root>`. Resolve exactly as the existing `moveCard` callback does (`TaskViewerProvider.ts:1049`): `const wsId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';` then pass `wsId` to `getPlansByColumn` / `getFeaturePlans`. `getPlanByPlanId`, `getSubtasksByFeatureId`, and `deletePlanByPlanId` take the plan/feature id directly and do **not** need `wsId`.

### Plan-management endpoints (new PUT/POST/DELETE routes)
| Endpoint | Backing `KanbanDatabase` method | Purpose |
|---|---|---|
| `PUT /plans/<planId>/project` | `getPlanByPlanId(planId)` (`:3377`) → `updatePlanProjectByPlanFile(planFile, workspaceId, project)` (`KanbanDatabase.ts:2220`) | Set a plan's project |
| `PUT /plans/<planId>/complexity` | `getPlanByPlanId(planId)` (`:3377`) → `updateComplexityByPlanFile(planFile, workspaceId, complexity)` (`KanbanDatabase.ts:2058`) | Set a plan's complexity score |
| `POST /plans/import` | `importPlanFiles(workspaceRoot, effectiveStateRoot?)` — **exported function**, not a class method (`PlanFileImporter.ts:30`) | Scan `.switchboard/plans/*.md` and upsert into DB |
| `POST /plans` | write `.switchboard/plans/<slug>.md` + `insertFileDerivedPlan(record: KanbanPlanRecord)` (`KanbanDatabase.ts:1696`) | Create a new plan (minimal frontmatter + body stub) |
| `DELETE /plans/<planId>` | `deletePlanByPlanId(planId)` (`KanbanDatabase.ts:2504`) | Delete a plan |

> **PUT handlers need a two-step resolution:** `updatePlanProjectByPlanFile` / `updateComplexityByPlanFile` take `(planFile, workspaceId, value)` — **not** `planId`. The handler must (1) `getPlanByPlanId(planId)` to obtain `plan_file` + confirm the plan exists (404 if not), then (2) resolve `workspaceId` from the plan record (or `db.getWorkspaceId() || db.getDominantWorkspaceId()`), then call the updater. `deletePlanByPlanId` and `getPlanByPlanId` take `planId` directly — no resolution step.
>
> **`DELETE` method guard (required fix):** the dispatcher's method whitelist rejects non-GET/POST/PUT with `405` (`LocalApiServer.ts:1351`), and the CORS `Access-Control-Allow-Methods` header omits DELETE (`:1342`). `DELETE /plans/<planId>` will **405 as-is**. Add `DELETE` to both the guard (`:1351`) and the CORS header (`:1342`). The existing `OPTIONS` preflight handler (`:1345`) already returns `204` for any method listed in Allow-Methods, so no preflight change is needed beyond the header. (Alternative if touching the guard is unwanted: `POST /plans/<planId>/delete` — but the one-line guard fix is preferred.)

### Existing endpoints the skill documents (no code change)
| Endpoint | Purpose |
|---|---|
| `POST /kanban/move` | Move a card (feature cascade + integration sync inherited) |
| `POST /kanban/feature` | Create a feature from subtask plan IDs |
| `POST /kanban/feature/assign` | Assign plans to a feature |
| `POST /kanban/feature/remove` | Remove a subtask from a feature |
| `POST /kanban/feature/delete` | Delete a feature |
| `POST /kanban/feature/split` | Split a feature |
| `POST /worktree/cleanup` | Mark a worktree merged and clean it up |
| `POST /comment` | Post a reply to a Linear/Notion/ClickUp remote-control card |
| `POST /phone-a-friend` | Notify a second-pass terminal |
| `POST /api/clickup` / `POST /api/linear` | Direct integration API proxy |
| `GET /health` | Liveness + port + roots (the bootstrap probe) |
| `POST /orchestrator/request` | *(lands with orchestration-automation-mode)* Agent→orchestrator request channel |

**Design notes for the new endpoints:**
- Same `_handleRequest` dispatcher (`LocalApiServer.ts:1331`); add routes alongside the existing `if/else if` chain. **Route ordering:** register `pathname === '/plans'` (list) and `pathname === '/plans/import'` / `'/plans'` (POST) before the `pathname.startsWith('/plans/')` catch-alls so `/plans/<planId>` sub-routes don't shadow them. Mirror the existing `/task/clickup/` prefix pattern (`:1368`).
- Same localhost boundary check (`LocalApiServer.ts:1334`) and `_checkAuth` (returns `true`, trusts the boundary — `:223`). GET read handlers may call `_checkAuth(req, false)` like the existing unauthenticated metadata route (`:697`) — or `true` to match the mutation handlers; either is safe behind the localhost boundary.
- Each handler is a thin wrapper: parse path/query/body → obtain the DB → call the existing `KanbanDatabase` method → serialize JSON. No new business logic.
- **`getKanbanDatabase` accessor (RESOLVED — required, not optional):** LocalApiServer holds **no** `KanbanDatabase` handle today. Every kanban op is an injected callback (`LocalApiServerOptions:9-104`); there is no DB field on the server. Add `getKanbanDatabase?: (workspaceRoot?: string) => Promise<KanbanDatabase | null | undefined>` to `LocalApiServerOptions`, mirroring the existing `getClickUpService` / `getLinearService` / `getNotionService` accessors (`:13-15`). Wire it in `TaskViewerProvider._startLocalApiServer()` (`:1020`) as `getKanbanDatabase: async (wsRoot) => this._getKanbanDb(wsRoot || effectiveRoot)` — the `_getKanbanDb` helper already exists (`TaskViewerProvider.ts:6012`) and returns `KanbanDatabase | undefined`. Each read/management handler follows the **503-when-absent** pattern proven by `_handleKanbanMove` (`:337-340`): `const db = await this._options.getKanbanDatabase?.(wsRoot); if (!db) { res.writeHead(503); res.end(JSON.stringify({ error: 'Kanban database not available' })); return; }`. Absent in headless/test harnesses → 503, same contract as the mutation callbacks.
- **`workspace` query/body param resolution:** optional. Default to `this._options.workspaceRoot` when omitted (matches the mutation handlers, e.g. `:349`); for multi-root setups the agent passes the specific root (the list of roots is available from `GET /health` → `roots`). No new resolution logic — reuse the existing `body?.workspaceRoot || this._options.workspaceRoot` pattern, adapted to query string for GETs.

## The `external-orchestration` skill

A single skill file that is the complete HTTP contract + the orchestration workflow. An external agent reads this skill and can drive Switchboard end-to-end. Structure:

1. **Bootstrap** — read `.switchboard/api-server-port.txt`, probe `GET /health`, confirm Switchboard is running.
2. **HTTP reference** — every endpoint (new + existing), method, path, payload shape, response shape, error codes. This is the machine-readable contract an agent curls against.
3. **Read patterns** — `GET /kanban/state` for a full board snapshot on wake; `GET /plans/<planId>` for plan content before dispatching; `GET /features/<id>` for subtask composition.
4. **Orchestration workflow** — the natural-language procedure an external orchestrator follows, mirroring the in-VS-Code orchestrator from orchestration-automation-mode:
   - Read board state (`GET /kanban/state`).
   - Group loose plans into features (`POST /kanban/feature`) — the external equivalent of `group-into-features`.
   - For each feature's subtasks: read the plan, dispatch to the tool's own agent/terminal, sleep.
   - On wake (the external tool's own interval or user prompt): verify progress against **git state** (not agent self-report), triage, advance cards (`POST /kanban/move`), post comments (`POST /comment`), and merge (`POST /worktree/cleanup`).
   - Escalate planner-stage questions to the human; auto-resolve coding/review-stage issues.
5. **Truth rule** — the skill emphasizes: trust git/board state, not agent self-report. Same rule as the in-VS-Code orchestrator.
6. **Failure modes** — `SWITCHBOARD_NOT_RUNNING` (port file missing or `/health` fails → tell the user to start the extension); 404 (plan/feature missing); 400 (invalid column/project → response body lists valid values).

**Skill file location (RESOLVED):** the repo uses **both** conventions. Older mutation skills are single files at `.agents/skills/<name>.md` (`notion_api.md`, `linear_api.md`, `clickup_api.md`). The **newest** skills use the directory form `.agents/skills/<name>/SKILL.md` (`group-into-features/SKILL.md`, `kanban_operations/SKILL.md`, `query_archive/SKILL.md`), and every skill is mirrored to `.claude/skills/<name>/SKILL.md`. Follow the newer convention: author the primary file at **`.agents/skills/external_orchestration/SKILL.md`** and mirror it to `.claude/skills/external-orchestration/SKILL.md` (the `.claude/` tree is the host-facing mirror the skill loader scans). The skill name in the registry becomes `external-orchestration`.

## Implementation Steps

1. **Add the `getKanbanDatabase` accessor (confirmed required)** — verified during review: LocalApiServer holds **no** DB handle; all kanban ops are injected callbacks (`LocalApiServerOptions:9-104`). Add `getKanbanDatabase?: (workspaceRoot?: string) => Promise<KanbanDatabase | null | undefined>` to the options interface, mirroring `getClickUpService`/`getLinearService`/`getNotionService` (`:13-15`). Wire it in `TaskViewerProvider._startLocalApiServer()` (`:1020`) as `getKanbanDatabase: async (wsRoot) => this._getKanbanDb(wsRoot || effectiveRoot)` (helper at `:6012`). Also fix the `DELETE` method guard (`LocalApiServer.ts:1351`) and CORS `Access-Control-Allow-Methods` (`:1342`) — both currently omit DELETE. This is the prerequisite for every endpoint below; without it all 11 routes 503.
2. **Add read endpoints** — extend `_handleRequest` in `src/services/LocalApiServer.ts` (`:1331`) with the six GET routes from the read-endpoints table. Each handler: resolve `workspaceId` (`db.getWorkspaceId() || db.getDominantWorkspaceId()`, per `TaskViewerProvider.ts:1049`) for column/feature-scoped reads, call the `KanbanDatabase` method (cited lines in the table), serialize JSON. Watch route ordering — register exact `/plans` and `/plans/import` before the `/plans/<planId>` prefix branch.
3. **Add plan-management endpoints** — the five PUT/POST/DELETE routes. `create_plan` is the one with real logic (write a format-compatible `.md` file + `insertFileDerivedPlan` (`:1696`)); the two PUT handlers must first `getPlanByPlanId` to resolve `planFile` + `workspaceId` before calling `updatePlanProjectByPlanFile`/`updateComplexityByPlanFile`; `import_plans` calls the exported `importPlanFiles` function (`PlanFileImporter.ts:30`); `delete_plan` calls `deletePlanByPlanId` directly. Test `create_plan` output against `PlanFileImporter` to confirm frontmatter format compatibility.
4. **Write the `external-orchestration` skill** — author `.agents/skills/external_orchestration/SKILL.md` + mirror to `.claude/skills/external-orchestration/SKILL.md`. Document the full HTTP contract + the orchestration workflow. Ground every endpoint description in the actual handler code (cite file + line). Include curl examples for each operation.
5. **Tests** — `src/services/__tests__/LocalApiServer.reads.test.ts` (or extend the existing LocalApiServer test file): spin LocalApiServer against a temp workspace, hit each new endpoint, assert response shape + content. Cover: `list_plans` (with and without column filter), `get_plan` (found + 404), `get_kanban_state` (all columns present), `list_columns` (built-in + custom), `list_features`, `get_feature` (with subtasks), `create_plan` + `import_plans` round-trip, `delete_plan`, the two PUT endpoints, the `DELETE`-method-guard fix, the accessor-absent → 503 path, and the `SWITCHBOARD_NOT_RUNNING` path (no server up).

## Complexity Audit

### Routine
- Read endpoint handlers (thin wrappers over existing `KanbanDatabase` methods — `getPlanByPlanId`, `getPlansByColumn`, `getFeaturePlans`, `getSubtasksByFeatureId`).
- The skill markdown (documentation, grounded in code — mechanical once endpoints exist).
- `delete_plan` (one-line `deletePlanByPlanId` call, planId-keyed — no resolution step).
- `import_plans` (one-line call to the exported `importPlanFiles` function).
- `get_plan` / `get_feature` / `list_features` / `list_columns` / `get_kanban_state` reads (serialize existing method output).

### Complex / Risky
- **`getKanbanDatabase` accessor (linchpin — confirmed required, not "if needed")** — LocalApiServer has **no** DB handle today; every kanban op is an injected callback (`LocalApiServerOptions:9-104`). Adding the accessor touches the shipped options interface **and** the extension construction path (`TaskViewerProvider._startLocalApiServer:1020`). If wired wrong, **all 11 routes 503** (the 503-when-absent pattern is by design, matching `_handleKanbanMove:337-340`). Mitigation: mirror the proven `getClickUpService`/`getLinearService` accessor pattern (`:13-15`); wire via the existing `_getKanbanDb` helper (`TaskViewerProvider.ts:6012`); test the accessor-absent → 503 path explicitly.
- **`DELETE` method-guard + CORS fix** — the dispatcher's method whitelist (`LocalApiServer.ts:1351`) and CORS `Access-Control-Allow-Methods` (`:1342`) both omit DELETE, so `DELETE /plans/<planId>` 405s as written. Mitigation: one-line addition of `DELETE` to both; test the guard; the `OPTIONS` preflight (`:1345`) already returns 204 for any Allow-Methods entry.
- **`workspaceId` (UUID) vs `workspace` (root path) resolution** — every column/feature-scoped read keys off the DB `workspace_id` UUID, but endpoints receive a root path. A handler that passes the root path where a UUID is expected returns empty result sets silently (no error — just `[]`). Mitigation: reuse the exact `db.getWorkspaceId() || db.getDominantWorkspaceId()` resolution from the `moveCard` callback (`TaskViewerProvider.ts:1049`); test a multi-root workspace.
- **`create_plan` file write** — writing a new `.switchboard/plans/<slug>.md` from an HTTP handler. Must produce frontmatter that `PlanFileImporter` parses correctly; a malformed file silently breaks the next import. Mitigation: reuse the exact frontmatter shape the importer expects; test `create_plan` → `import_plans` round-trip.
- **PUT handlers' two-step resolution** — `updatePlanProjectByPlanFile` / `updateComplexityByPlanFile` take `(planFile, workspaceId, value)`, not `planId`. A handler that calls them with the raw `planId` from the URL fails (0 rows) or updates the wrong row. Mitigation: `getPlanByPlanId` first to resolve `plan_file` + 404-on-miss, then call the updater with the resolved `planFile` + `workspaceId`.
- **Touching `LocalApiServer.ts` (shipped code, ~4,000 installs)** — adding routes to the `_handleRequest` dispatcher. Risk: a broken handler throws and 500s, or a route pattern shadows an existing one (e.g. `/plans` list shadowed by a `/plans/<planId>` prefix branch). Mitigation: each handler is a thin wrapper following the existing `_handleKanbanMove` pattern; no change to existing routes; careful route ordering; test file covers all new + existing routes.

## Edge-Case & Dependency Audit

### Race Conditions
- LocalApiServer stops while an external agent's call is in flight → HTTP call fails → agent sees an error and can tell the user to restart Switchboard. No partial state — LocalApiServer is the sole writer.
- Multiple external agents calling simultaneously → LocalApiServer serializes DB access internally (same as it does for the webview + `kanban_operations` scripts today). No clobbering risk.
- **`create_plan` vs the file-watcher (`GlobalPlanWatcherService`):** writing a `.md` file and immediately calling `insertFileDerivedPlan` could race with the watcher's own import of the same file (double-insert). `insertFileDerivedPlan` is an upsert keyed on `plan_file` + `workspace_id` (sticky `is_feature` COALESCE, `KanbanDatabase.ts:1696-1734`), so a double-insert converges — but the handler should still call `insertFileDerivedPlan` for deterministic test behavior rather than relying on the watcher (which may not run in headless test harnesses).

### Security
- New endpoints are gated by the same localhost boundary check (`LocalApiServer.ts:1334`) as existing endpoints. No new auth model.
- Read endpoints expose plan content — which is already readable from `.switchboard/plans/*.md` on disk. No new information exposure.
- `create_plan` / `delete_plan` / `import_plans` are new write paths, but gated by the same localhost boundary as existing mutations. Same trust model as `kanban_operations` scripts, which can already move cards from any external process.
- No secrets handled by the new endpoints — tokens for Linear/Notion/ClickUp stay inside LocalApiServer (VS Code secret storage); external agents never see them.
- **`create_plan` path control:** the `<slug>` must be sanitized (reject `..`, absolute paths, leading `/`) so an external agent can't write outside `.switchboard/plans/`. The existing mutation handlers trust the localhost boundary, but a file-write endpoint adds a path-traversal vector that pure-DB endpoints don't have. Mitigation: `path.resolve` + verify the result starts with the workspace's `.switchboard/plans/` directory before writing.

### Side Effects
- **New GET/PUT/POST/DELETE routes on LocalApiServer** — visible to any localhost process. This expands the surface any local process can reach, but the boundary (localhost) and trust model (the user's machine) are unchanged.
- **`create_plan` writes files to `.switchboard/plans/`** — visible to the extension's importer on next reset. Format-compatible by construction.
- **`delete_plan` does NOT delete the on-disk `.md` file** — `deletePlanByPlanId` (`KanbanDatabase.ts:2504`) is a DB row removal (tombstone/status change), not an `fs.unlink`. The orphaned file will re-import on the next `import_plans` unless the handler also unlinks it. Decision: the endpoint deletes the DB row only (matches the webview's delete semantics); document this in the skill so the external agent knows a deleted plan can reappear if the file persists and a re-import runs. (If full removal is desired, the handler may also `fs.unlink` the `plan_file` — but that is a behavioral choice to confirm with the user, not an assumption.)
- No IDE config files written. No PID files. No `.switchboard/` state writes from external tools (they're pure HTTP clients).

### Dependencies & Conflicts
- **No new deps.** No `@modelcontextprotocol/sdk`, no `node-pty`, no `@xterm`, no `ws`. Pure additions to an existing file + a new skill markdown + tests.
- **No dependency on standalone-npx subtasks.** This plan works entirely within the existing extension + LocalApiServer.
- **Complementary to orchestration-automation-mode** — that feature adds `POST /orchestrator/request`; this plan's skill documents how an external agent calls it. No code conflict; the skill just references the endpoint once it exists.
- **No conflict with the extension's MCP cleanup code** (`extension.ts:581-630`) — this plan writes no PID files and no IDE config.
- **`getKanbanDatabase` accessor is additive to `LocalApiServerOptions`** — optional field, absent in headless/test harnesses → 503, identical contract to the existing optional callbacks. No existing caller breaks; the extension wiring site (`TaskViewerProvider._startLocalApiServer:1020`) gains one field.

## Dependencies
- **Session dependencies:** None. This plan is standalone — it touches `LocalApiServer.ts` (options interface + endpoints), `TaskViewerProvider.ts` (wiring the `getKanbanDatabase` accessor in `_startLocalApiServer`), and adds a skill file + tests.
- **Complementary feature:** `orchestration-automation-mode-b4c8934e-ff8a-4986-939d-5310b1c16e9a.md` — this plan enables external-drive of that feature's orchestration loop. Either can land first; together they complete the "natural-language orchestration from any tool" path.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the `getKanbanDatabase` accessor is a linchpin on shipped code — if the wiring in `TaskViewerProvider._startLocalApiServer` is wrong, all 11 routes 503 silently; (2) the `DELETE` method-guard + CORS omission makes `DELETE /plans/<planId>` 405 as written — a one-line fix that's easy to miss; (3) the `workspace` (root path) → `workspaceId` (UUID) resolution mismatch returns empty result sets with no error if a handler passes the wrong key. Mitigations: mirror the proven `getClickUpService` accessor + `_getKanbanDb` wiring; add `DELETE` to the guard (`:1351`) and CORS (`:1342`); reuse the `db.getWorkspaceId() || db.getDominantWorkspaceId()` resolution from the `moveCard` callback (`:1049`); test all three paths explicitly.

**Challenge: "If the mutation skills already work via curl, why not just tell users to read the plan files directly for the read side?"**
Because reading scattered `.md` files doesn't give you board state — column assignment, feature composition, project filtering, and the relationship between plans and features all live in `kanban.db`, not in the files. An external agent reading files would have to reconstruct board state by parsing every plan's frontmatter and querying the DB directly (clobbering risk) or guessing. `GET /kanban/state` is one call that returns the full board as the webview sees it. The read endpoints are the piece that makes external orchestration actually work, not just technically possible.

**Challenge: "Why not build the MCP server at the same time? If you're adding endpoints anyway, the wrapper is cheap."**
Because the MCP server adds a spawn-lifecycle, a dependency, and a thing-to-maintain, for pure ergonomics. The skill + curl pattern already works for mutations today; extending it to reads is the smaller change that delivers the capability. If the friction of curl+JSON-parsing in agent context proves painful (high token usage, agents fumbling curl syntax), the MCP server becomes worth it — and it'll be a thin wrapper over endpoints that already exist and are already proven. Building it speculatively is the bloat the user rejected.

**Challenge: "An external orchestrator can't see terminal output. How does it verify progress against git state?"**
Same way the in-VS-Code orchestrator does — by reading git state (branch existence, commit log, worktree status) via its own bash tool, not by watching terminals. The orchestration-automation-mode feature's truth rule is "trust git/board state, not agent self-report." An external orchestrator has its own terminal/agent context and can run `git log`, `git status`, etc. directly. The read endpoints give it board state; git gives it ground truth. Terminal observation is not needed for the verify step.

**Challenge: "The skill documents an endpoint (`POST /orchestrator/request`) that doesn't exist yet."**
Correct — and the skill handles this by noting the endpoint lands with orchestration-automation-mode. Before that feature ships, the external agent can do everything except receive agent requests (it has no inbox). That's fine: the external agent *is* the orchestrator, so its own context is where agent questions surface. The `POST /orchestrator/request` endpoint matters for the in-VS-Case where fleet agents need to reach the orchestrator terminal; an external orchestrator's agents report back through the external tool's own channels.

**Challenge: "You're adding 11 new routes to shipped code. Isn't that risky?"**
Each route is a thin handler calling an existing `KanbanDatabase` method — the same methods the webview Providers already call. The risk is a broken handler 500-ing, not a logic bug (there's no new logic). The test file covers every new route + the existing ones. The existing `_handleKanbanMove` / `_handleKanbanCreateFeature` handlers prove the pattern. This is additive, not structural.

## Proposed Changes

### `src/services/LocalApiServer.ts` (modified — options accessor + DELETE guard + 11 endpoints)
- **Context:** Today LocalApiServer exposes mutations but not reads. External agents can move cards but can't see the board. The server holds no `KanbanDatabase` handle — all kanban ops are injected callbacks.
- **Logic:**
  1. Add `getKanbanDatabase?: (workspaceRoot?: string) => Promise<KanbanDatabase | null | undefined>` to `LocalApiServerOptions` (mirrors `getClickUpService`/`getLinearService`/`getNotionService` at `:13-15`).
  2. Fix the method whitelist (`:1351`) and CORS `Access-Control-Allow-Methods` (`:1342`) to include `DELETE`.
  3. Add the 11 routes from the endpoints tables to `_handleRequest` (`:1331`). Each handler: `const db = await this._options.getKanbanDatabase?.(wsRoot); if (!db) { 503; return; }` (the `_handleKanbanMove:337-340` pattern) → resolve `workspaceId` (`db.getWorkspaceId() || db.getDominantWorkspaceId()`, per `:1049`) for column/feature-scoped reads → call the cited `KanbanDatabase` method → serialize JSON.
- **Implementation:** Thin handlers, same pattern as existing `_handleKanbanMove`. No change to existing routes. Careful route ordering (`/plans` and `/plans/import` before `/plans/<planId>` prefix branch).
- **Edge Cases:** missing plan/feature → 404; invalid column/project → 400 with valid values in body; DB/accessor not ready → 503; `create_plan` slug path-traversal → 400 (sanitize, `path.resolve` + prefix-check against `.switchboard/plans/`); `delete_plan` deletes the DB row only (the `.md` file persists and re-imports on next `import_plans`) — document in the skill.

### `src/services/TaskViewerProvider.ts` (modified — wire the accessor)
- **Context:** `_startLocalApiServer()` (`:1020`) constructs `new LocalApiServer({...})` with the callback block. The new `getKanbanDatabase` accessor must be wired here.
- **Logic:** Add `getKanbanDatabase: async (wsRoot) => this._getKanbanDb(wsRoot || effectiveRoot)` to the options object, alongside `getClickUpService`/`getLinearService` (`:1024-1026`). The `_getKanbanDb` helper already exists (`:6012`) and returns `KanbanDatabase | undefined`.
- **Implementation:** One field in the options object. No other change to `_startLocalApiServer`. The `undefined`-when-no-provider case maps to the handler's 503 path, identical to how `moveCard`'s `!this._kanbanProvider` guard returns `{ success: false, error: 'Kanban provider not available' }` (`:1037-1038`).
- **Edge Cases:** provider not yet registered → `_getKanbanDb` returns `undefined` → endpoints 503 until the provider activates (same lifecycle gap the mutation callbacks already have).

### `.agents/skills/external_orchestration/SKILL.md` (new — mirrored to `.claude/skills/external-orchestration/SKILL.md`)
- **Context:** The mutation skills (`notion_api.md`, `linear_api.md`, `kanban_operations/`) document subsets of the HTTP surface. No single skill documents the full contract or the orchestration workflow.
- **Logic:** Bootstrap (port discovery + health probe) → full HTTP reference (every endpoint) → read patterns → orchestration workflow (mirror of the in-VS-Code orchestrator) → truth rule → failure modes.
- **Implementation:** Markdown file (directory form, matching the newest skills) with curl examples per endpoint. Grounded in actual handler code (cite file + line). Mirror to the `.claude/skills/` tree for the host-facing skill loader.
- **Edge Cases:** `SWITCHBOARD_NOT_RUNNING` guidance; 404/400 handling; the `POST /orchestrator/request` endpoint noted as landing with orchestration-automation-mode; `delete_plan` DB-row-only semantics documented.

### `src/services/__tests__/LocalApiServer.reads.test.ts` (new — or extend existing LocalApiServer tests)
- **Context:** No tests for the new endpoints.
- **Logic:** Spin LocalApiServer against a temp workspace; hit each new endpoint; assert response shape + content.
- **Implementation:** Cover all 11 new routes + the `DELETE`-method-guard fix + the accessor-absent → 503 path + the `SWITCHBOARD_NOT_RUNNING` path + the `create_plan` → `import_plans` round-trip + a multi-root `workspaceId`-resolution case.

## Open Questions (resolved during review)
- **Skill file location — RESOLVED:** use the directory form `.agents/skills/external_orchestration/SKILL.md` (matches the newest skills — `group-into-features`, `kanban_operations`, `query_archive`) and mirror to `.claude/skills/external-orchestration/SKILL.md`. The older single-file `.md` pattern (`notion_api.md`, `linear_api.md`) is legacy; new skills use the directory form. (See the resolved note in the skill section above.)
- **`create_plan` body shape — RESOLVED (recommendation):** minimal — frontmatter (`description`, `**Plan ID:**` UUID, `**Tags:**`, `**Complexity:**`) + a `## Goal` stub. The external agent or user fills the body via their normal workflow; the endpoint isn't an authoring surface. Confirm with the user at implementation time if a richer template is preferred.
- **`getKanbanDatabase` accessor — RESOLVED:** required. Verified LocalApiServer holds no DB handle (`LocalApiServerOptions:9-104` has only injected callbacks, no `KanbanDatabase` field). Add the optional accessor and wire it via `_getKanbanDb` (`TaskViewerProvider.ts:6012`). (See Implementation Step 1 + Proposed Changes.)
- **Workspace parameter — RESOLVED:** optional `?workspace=<root>` / `workspaceRoot` body field, defaulting to `this._options.workspaceRoot` when omitted (matches the mutation handlers, e.g. `:349`). For multi-root setups the agent passes the specific root; `allRoots` is surfaced via `GET /health` → `roots`. The column/feature-scoped handlers then resolve root → `workspaceId` UUID via `db.getWorkspaceId() || db.getDominantWorkspaceId()` (`:1049`). No new resolution framework — reuse the existing pattern.
- **`delete_plan` file cleanup — OPEN (confirm with user):** `deletePlanByPlanId` (`KanbanDatabase.ts:2504`) removes the DB row only; the on-disk `.md` persists and re-imports on the next `import_plans`. The endpoint as specified deletes the DB row only (matches webview delete semantics). If the user wants the file unlinked too, the handler adds an `fs.unlink` of the resolved `plan_file` — a behavioral choice, not an assumption. Flag at implementation time.

## Verification Plan

> **Session directives:** this review session **skips running `npm run compile`** and **skips running automated tests**. The steps below describe the verification the *coder* performs at implementation time; they are not executed during this planning pass.

### Automated Tests
- **Test file:** `src/services/__tests__/LocalApiServer.reads.test.ts` (new) or extend the existing LocalApiServer test file.
- **Harness:** spin `LocalApiServer` against a temp workspace with a seeded `kanban.db` (via `_getKanbanDb`/`KanbanDatabase` constructor against a temp root); wire `getKanbanDatabase` to return that DB instance. Hit each endpoint over `http` and assert response shape + content.
- **Coverage (per Implementation Step 5):** `list_plans` (with + without `column` filter; empty-result when column has no plans), `get_plan` (found + 404), `get_kanban_state` (all `DEFAULT_KANBAN_COLUMNS` present), `list_columns` (built-in + a custom agent column), `list_features` (`getFeaturePlans` returns `is_feature=1` only), `get_feature` (feature + its subtasks), `create_plan` + `import_plans` round-trip (frontmatter parses, row appears), `delete_plan` (DB row gone; `.md` file persists per resolved semantics), the two PUT endpoints (project + complexity update; 404 on missing plan), the `DELETE`-method-guard fix (DELETE no longer 405s), the accessor-absent → 503 path (construct without `getKanbanDatabase`), a multi-root `workspaceId`-resolution case, and the `SWITCHBOARD_NOT_RUNNING` path (no server up → connection refused, skill instructs user to start the extension).
- **Regression:** the test file must also exercise at least one existing route (`POST /kanban/move`, `GET /health`) to confirm the new routes + the DELETE-guard change did not disturb existing dispatch.

### Manual Verification
- With the extension running, `curl http://127.0.0.1:<port>/health` → `{ status:'ok', port, roots }`.
- `curl http://127.0.0.1:<port>/kanban/state?workspace=<root>` → full board snapshot matching the webview.
- `curl -X DELETE http://127.0.0.1:<port>/plans/<planId>` → 200 (confirms the guard fix), not 405.
- `curl http://127.0.0.1:<port>/plans` (no column) → concatenated plans across all columns.
- Compare `GET /kanban/state` output against the webview's visible columns to confirm `workspaceId` resolution is correct (no silent empty arrays).

### Static Checks (deferred per session directive)
- `npm run compile` (webpack → `dist/`) — **not run this session** per directive. The coder runs it before producing a VSIX. Note: `dist/` is not used during development/testing; `src/` is the source of truth.
- TypeScript typecheck of the new `getKanbanDatabase` accessor signature against `KanbanDatabase` + the `_getKanbanDb` return type (`KanbanDatabase | undefined`) — the coder confirms the union type matches the handler's null-check.

## Recommendation
**Complexity: 6 → Send to Coder.** The work is majority-routine (thin handlers over existing `KanbanDatabase` methods, a documentation skill, tests) but carries two moderate, well-scoped risks on shipped code (~4,000 installs): the `getKanbanDatabase` accessor linchpin (options interface + `TaskViewerProvider` wiring) and the `DELETE` method-guard/CORS fix. A coder can execute this with the existing `_handleKanbanMove` pattern as a template; no Lead-Coder-only architectural decisions remain (the accessor design, route ordering, and `workspaceId` resolution are all pinned to proven patterns in this plan).

**Stage Complete:** PLAN REVIEWED

## Review Findings

Reviewed against commit `fcd9846`. Files changed by this review: `src/services/LocalApiServer.ts` (new `_resolveBoard` helper + three read handlers). **CRITICAL (fixed):** `_handleGetBoard`/`_handleGetPlans`/`_handleGetFeatures` called `db.getBoard()` with no argument, but `getBoard(workspaceId)` filters `WHERE workspace_id = ?` — so every board/plans/features read returned an empty array with no error (the exact silent-empty-result trap this plan warned about); fixed by resolving `getWorkspaceId() || getDominantWorkspaceId()` before `getBoard(wsId)`. **MAJOR (deviation, deferred):** the implementation delivered a leaner, re-shaped surface than this plan — the accessor + `GET /kanban/board|plans|features`, `GET /worktree/list`, `GET /orchestrator/inbox|session-log`, and the `orchestration-http` skill landed and are internally coherent, but `get_plan` (single, with content), `list_columns`, all five plan-management endpoints (`set_plan_project`/`set_plan_complexity`/`import_plans`/`create_plan`/`delete_plan`), the `DELETE` method-guard + CORS fix, and the `external-orchestration` skill were **not** implemented. That superset is additive "external-drive-everything" scope the orchestration feature does not require; it is intentionally NOT re-implemented in this review pass (adding CRUD/file-write routes to shipped LocalApiServer is fresh work with the path-traversal/format risks this plan itself flags, not a review fix). Validation: static/caller-trace only (compile+tests skipped). Remaining risk: board reads don't apply `repo_scope` filtering (`getBoardFiltered`) — acceptable for single-workspace orchestration reads; the un-shipped CRUD scope should be tracked as follow-on work.

## Follow-up — deferred scope now implemented (2026-07-08)

The deferred CRUD/read superset was subsequently built rather than left as follow-on. Added to `src/services/LocalApiServer.ts`: `GET /kanban/plan?planId=` (single plan + file content), `GET /kanban/columns` (built-in defs + custom columns), `POST /kanban/plans` (create — writes the file then reuses the canonical `importPlanFiles`, with slug sanitization + traversal guard + no-clobber `409`), `DELETE /kanban/plans` (DB row, optional `deleteFile=true` unlink under a plans-dir guard), `PUT /kanban/plans/project`, `PUT /kanban/complexity` (both via `getPlanByPlanId`→resolve `planFile`+`workspaceId`→updater), and `POST /kanban/plans/import`. Also added `DELETE` to the method guard + CORS `Access-Control-Allow-Methods`, and taught `_handleReadEndpoint` to honour `400`/`404` status codes. The skill was rewritten to `switchboard-orchestration` documenting the **full** LocalApiServer surface (reads, plan lifecycle, board mutations, comms, integration proxies) plus two end-to-end workflows (fleet coder in a worktree; external orchestrator driving the board). Validation: `tsc -p tsconfig.test.json --noEmit` (the pretest gate) passes clean; only pre-existing, unrelated `TS2835` errors remain under the non-build `tsc -p .` config. Remaining choice: `delete_plan` defaults to DB-row-only (file re-imports unless `deleteFile=true`) — matches webview semantics.

**Second pass (2026-07-08, commit `ed01f0b`):** Re-verified all 11 endpoints and the DELETE guard. Endpoint paths differ from the plan's spec (`/kanban/plans` instead of `/plans`, `/kanban/plan?planId=` instead of `/plans/<planId>`, `/kanban/board` instead of `/kanban/state`, `/kanban/plans?featureId=` instead of `/features/<id>`) — these are naming convention choices, not functional gaps; the skill document (`switchboard-orchestration/SKILL.md`, 261 lines) documents the actual paths and is self-consistent. `_resolveBoard` helper (`:964`) correctly resolves `workspaceId` via `db.getWorkspaceId() || db.getDominantWorkspaceId()`. `_handleReadEndpoint` (`:843`) auth-gates all reads. `create_plan` has path-traversal guard (`path.resolve` + prefix-check), `409` on existing file. `delete_plan` supports optional `deleteFile=true`. DELETE method guard + CORS both include `DELETE` (`:1870`, `:1879`). Route ordering: specific routes (`/import`, `/project`, `/complexity`) registered before generic `/kanban/plans` — correct. The old `orchestration_http` skill was replaced by `switchboard-orchestration` (MIRROR_MANIFEST updated, no orphaned references). No code changes needed in this subtask. Validation: static caller/consumer trace only (compile+tests skipped per directive).
