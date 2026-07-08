# Switchboard Manage — Host-Agnostic Management Console Skill

## Goal

Add `/switchboard-manage`: a **host-agnostic management console** for driving Switchboard conversationally from any agentic coding host (Claude Code, OpenAI Codex, Zed, Google Antigravity), with a **minimised VS Code as the background execution engine**. On entry it reports board/project state and then waits — every action is user-directed. Automation is one explicit option, never the default.

### Problem & background

Today the only human-facing entry near this need is the `/switchboard-orchestrator` slash command, which the mirror manifest exposes (`ClaudeCodeMirrorService.ts:62`, `invocation: 'no-model'`). But that command loads the **unattended automation persona** (`.agents/workflows/switchboard-orchestrator.md`) — whose first section is the Kickoff Protocol (scan → group → dispatch) and whose Hard Rule #5 is "run unattended, no confirmation gates." So invoking it as a human silently kicks off batch automation. This surprised the user in a live session (grouped loose plans into a feature and fired dispatch with no confirmation) — behaviour that is *correct for the machine caller* but wrong for a human opening a management view.

Root cause: **one artifact serves two entry points.** The engine legitimately launches the automation persona (AUTOMATION tab "Start orchestrator" → `TaskViewerProvider.startOrchestratorFromKanban:7579`; autoban wake → `:9235`), referencing the workflow by **file path** and injecting a runtime block (`UNATTENDED=true`, `WORKSPACE_ROOT`, `ACTIVE_PROJECT_FILTER`). The human slash command should instead open a *consultative management console*, like `/switchboard-chat` is for planning. Because the engine references the persona by file path, the human command can be repointed without touching the machine launch.

Vision context: the API server is becoming the real product surface (see the `standalone-npx-switchboard` feature) and the VS Code webview one of several clients. `/switchboard-manage` is the **conversational client** for third-party agent hosts; the standalone-npx browser board is the **graphical client**. Both drive the same LocalApiServer; both are capped by how much of the UI surface the API exposes, and both grow as that feature's transport-parity work lands. This skill is buildable now against today's surface and grows automatically.

## Metadata
- **Plan ID:** 4815a200-424b-4b35-b4ac-f5cb2f4e0d5a
- **Tags:** backend, api, cli, feature
- **Complexity:** 5

## User Review Required
- None. (Delivery is a skill, not MCP — decided: over an existing localhost HTTP API with shell-capable hosts, MCP adds discoverability/ergonomics, not capability, and is a second surface to keep in sync. Discoverability is served by `GET /catalog` instead.)

## Scope

### ✅ IN SCOPE
- **New skill `.agents/skills/switchboard-manage/SKILL.md`** (host-agnostic; the source of truth per the control-plane convention). Content = the LocalApiServer HTTP surface (curl, port from `.switchboard/api-server-port.txt`) + the console **persona/interaction model**. Reuses the `switchboard-orchestration` skill's HTTP documentation by reference rather than duplicating it.
  - **Persona:** role = Switchboard project manager operating from another UI. On entry, read board/project state (`GET /kanban/board`, or `.switchboard/kanban-board.md`) and report it; then stop and ask what the user wants. No eager action, no eager research.
  - **User-directed actions**, each mapped to an existing endpoint/skill: browse a board / switch project view; examine plans (`GET /kanban/plan`); write new plans (switchboard-chat planning behaviour → `.switchboard/plans/`); move/complete cards (`POST /kanban/move`); feature ops (`/kanban/feature*`); dispatch a feature's coding (`POST /kanban/orchestration/dispatch`); focus-code a single plan; drive ClickUp/Linear (`/api/*`, `/task/*`). Hosts with filesystem access may also edit docs/constitution/PRD/plan files directly.
  - **Automation is opt-in only:** offered as an explicit choice, never run on entry. "Run one pass now" = drive group→dispatch→verify-via-git→merge inline. "Arm the unattended engine" = `POST /orchestration/start` (below). "Stop" = `POST /orchestration/stop`.
- **Repoint the mirror (`ClaudeCodeMirrorService.ts` `MIRROR_MANIFEST`):** the `/switchboard-orchestrator` human command → `switchboard-manage`. Remove the automation persona from human-invocable commands entirely (the engine launches it by file path, so nothing breaks). Result: a human can no longer slash-invoke the raw unattended persona — the original footgun is closed.
- **New endpoints on `LocalApiServer`:**
  - `POST /orchestration/start` → calls `startOrchestratorFromKanban(workspaceRoot)` (already `public`). Arms the real self-waking engine (terminal + kickoff + autoban clock) — the same thing the AUTOMATION tab button does.
  - `POST /orchestration/stop` → calls `stopOrchestratorFromKanban()` (already `public`, `TaskViewerProvider.ts:7769` — confirmed by scout; no wrapper needed). This method disables orchestration, stops the autoban engine, persists state, and broadcasts — exactly what the stop path needs. (The plan originally cited `setAutomationModeFromKanban` `:7773`; `stopOrchestratorFromKanban` is the cleaner public entry point.)
  - `GET /catalog` → **owned by A1** (Protocol Catalog subtask `eb75281d-...`). Manage's skill documents and *consumes* this endpoint for self-discovery but does NOT implement it. Interim (before A1's scanner lands): A1 serves a hardcoded enumeration of the if-else route arms in `_handleRequest` (lines 1889-1980) — there is no centralized route table. Canonical (after A1): serves the checked-in `protocol-catalog.json`. This is the MCP-free discoverability layer, single-sourced and auto-growing.
  - Wire each via the existing injected-callback pattern (`LocalApiServerOptions` interface, `LocalApiServer.ts:11–136`), following `orchestrationDispatch` (`:791-839`, route at `:1925-1926`) exactly. `Host`/`Origin`/token checks as for existing routes; `127.0.0.1` bind unchanged. (Note: `GET /catalog` is A1's deliverable — Manage does not add this route; it references A1's route in the skill docs.)
- **Declarative feature management (first-class — feature mgmt is central to this skill):** the skill drives feature/plan structure through the **declarative, path-addressed** API specified in `feature-management-declarative-path-addressed.md` (Feature A · A3) — plans addressed by file path/slug (never UUID) and one idempotent `POST /kanban/features/reconcile` that converges the whole structure atomically, with inline plan-splitting. Rationale (the existing `create`/`assign`/`remove`/`split` verbs are UUID-choreography, unusable for an agent) lives in A3. Until A3 lands, the skill falls back to the existing verb scripts but MUST resolve IDs itself and never subject the user to UUID discovery.
- **Hard rules baked into the skill:** default is never automation; no eager action on entry; deletes execute immediately (no confirm gates — project rule); all writes via API/scripts, never direct DB writes; project pin per the current protocol (**never ask** which project — omit if none named); state the capability ceiling honestly (control-plane actions light up as the standalone transport work lands endpoints).

### ⚙️ OUT OF SCOPE
- The full webview↔host transport parity (that is `standalone-npx-switchboard` subtask "handler extraction + transport migration"). This skill *consumes* whatever endpoints exist; it does not build the 706-verb surface.
- `node-pty`/browser terminals, npx packaging, the graphical BYO board UI — all the standalone feature.
- MCP server (explicitly deferred; revisit only for a host that permits MCP but forbids shell).
- Any change to the automation persona's behaviour (it stays engine-launched, unattended, unchanged).

## Capability note (honest ceiling)
Against **today's** API + filesystem + scripts, a `/switchboard-manage` agent can: read everything; create/delete/move/complete plans; all feature ops; set project/complexity per plan; dispatch a feature's coding; drive ClickUp/Linear; and (fs-capable hosts) edit docs/constitution/PRD/plan files. It **cannot yet**: control most settings, drive/observe terminals, create worktrees, create projects/columns — those need the standalone transport subtask's endpoints. `GET /catalog` is how the skill discovers newly-available verbs without a skill rewrite. Ships useful now; grows automatically.

## Implementation Steps
1. `LocalApiServer`: add `orchestrationStart`, `orchestrationStop` optional callbacks to the options type (lines 11-136); add `_handleOrchestrationStart` + `_handleOrchestrationStop` route arms mirroring `_handleOrchestrationDispatch` (lines 791-839). (Note: `GET /catalog` route is A1's deliverable — NOT added here. Manage's skill references it.)
2. Provider wiring: where `orchestrationDispatch` is passed to the API server (`TaskViewerProvider.ts:1164-1166`), also pass `orchestrationStart: (root) => this.startOrchestratorFromKanban(root)` and `orchestrationStop: () => this.stopOrchestratorFromKanban()`. Both methods are already `public` (`:7579` and `:7769` respectively — confirmed by scout; **no wrapper needed** for stop).
3. Author `.agents/skills/switchboard-manage/SKILL.md` (persona + HTTP surface by reference + hard rules).
4. `ClaudeCodeMirrorService` manifest: add the `switchboard-manage` mirror entry (`invocation: 'default'` or `no-model`); repoint/remove the `switchboard-orchestrator` human entry.
5. Cross-host delivery: ensure the source lives under `.agents/` so it also reaches Codex (`AGENTS.md`/`.agents/skills`) and Antigravity (skill files); note Zed via its rules/MCP as a follow-up.

## Edge cases & risks
- Repointing the mirror must not break the engine launch — verified: engine references `.agents/workflows/switchboard-orchestrator.md` by path (`TaskViewerProvider.ts:7711,7723,9235`), independent of the manifest.
- `POST /orchestration/start` is heavier than dispatch (spawns agents that write code) — it stays localhost-gated and is only ever called on explicit user instruction inside the console.
- Users on older installs: additive endpoints + a new skill; no migration, no shipped-state change.

## Verification
- `POST /orchestration/start` from a curl (VS Code minimised) spins the orchestrator terminal + arms the autoban clock exactly as the button does; `/stop` disables it.
- `GET /catalog` returns the route list; a management agent can enumerate capabilities from it.
- `/switchboard-manage` in Claude Code: on entry reports board state and does nothing else; performs a card move / feature create / dispatch only when asked; never emits a confirm gate; never asks about project pinning.
- Human `/switchboard-orchestrator` no longer resolves to the unattended persona.

## Files changed
- `src/services/LocalApiServer.ts` — 3 new route arms + options callbacks.
- `src/services/TaskViewerProvider.ts` — pass the new callbacks when constructing the API server (methods already public; add a stop wrapper if none is public yet).
- `.agents/skills/switchboard-manage/SKILL.md` — new skill (source of truth).
- `src/services/ClaudeCodeMirrorService.ts` — manifest: add `switchboard-manage`; repoint/remove `switchboard-orchestrator` human command.

## Complexity Audit
### Routine
- Adding 2 HTTP route arms (`POST /orchestration/start`, `POST /orchestration/stop`) following the exact `orchestrationDispatch` template (lines 791-839) — mechanical, patterned.
- Passing 2 new callbacks in `TaskViewerProvider` construction (lines 1164-1166) — both methods already public.
- Authoring the skill `.md` file — documentation, no logic.
- Mirror manifest edit — one line change in `ClaudeCodeMirrorService.ts:62`.
### Complex / Risky
- **Mirror repoint correctness** — must verify the engine launch (file-path refs at `TaskViewerProvider.ts:7711,7723,9235`) is truly independent of the manifest. Scout confirmed this, but a regression here silently breaks orchestration.
- **`POST /orchestration/start` is heavy** — it spawns agents that write code (arms the autoban engine). It must stay localhost-gated and only called on explicit user instruction. No confirm gate (project rule) but the skill persona must make the consequence explicit before calling.

## Edge-Case & Dependency Audit
- **Race conditions:** `POST /orchestration/start` while an orchestrator is already running → `startOrchestratorFromKanban` reuses the existing terminal (line 7579 logic). `POST /orchestration/stop` while no orchestrator is running → `stopOrchestratorFromKanban` is idempotent (disables + stops + persists, no-op if already stopped).
- **Security:** Both endpoints are localhost-bound (`127.0.0.1` check at `_handleRequest:1862`). Current `_checkAuth` is a no-op (returns `true`) — acceptable for the existing surface but A2a must add real auth before WS endpoints land. These 2 POST endpoints follow the existing auth posture (same as `orchestrationDispatch`).
- **Side effects:** `POST /orchestration/start` spawns a terminal + arms a self-waking engine — this is a deliberate, user-requested side effect, not accidental. The skill persona makes it opt-in only.
- **Dependencies & conflicts:** `GET /catalog` is owned by A1 — Manage references it in skill docs but does not implement the route, avoiding a conflict. `switchboard-manage` is NOT currently in `AGENTS.md` or `CLAUDE.md` skill tables — must be added. The `switchboard-orchestration/SKILL.md` (12 sections, all endpoints documented) is referenced by the new skill, not duplicated.

## Dependencies
- **A1** (`eb75281d-d8f3-4e50-b396-f7626abed020`) — provides `GET /catalog` which Manage's skill references for self-discovery. Not a hard build-time dependency (skill works without it; the catalog endpoint is additive), but the skill's discoverability story depends on A1 landing.
- **A3** (`9d3dbf13-c82c-4946-bc3b-f35f07d56214`) — provides `POST /kanban/features/reconcile` which Manage's skill drives for feature management. Until A3 lands, the skill falls back to existing verb scripts (resolving IDs itself).
- No session dependencies.

## Adversarial Synthesis

Key risks: (1) **`GET /catalog` ownership conflict** — the original plan listed `GET /catalog` as a Manage endpoint, but A1 owns the catalog generation + route. Manage must reference it, not implement it, or two plans claim the same route. Fixed: route removed from Manage's implementation steps. (2) **Stop wrapper assumed missing** — the plan said "add a stop wrapper if none is public yet" but `stopOrchestratorFromKanban` is already public at line 7769. Fixed: no wrapper needed; use existing method directly. (3) **"Route table" doesn't exist** — the plan said "interim: current route table" but routes are a 90-line if-else chain. Fixed: reworded to "enumerate the if-else route arms". (4) **Skill table omission** — `switchboard-manage` is not in `AGENTS.md`/`CLAUDE.md` skill tables. Must be added as part of delivery. Mitigations: all four issues are factual corrections grounded in the scout's code investigation; no architectural risk remains.

## Proposed Changes

### `src/services/LocalApiServer.ts`
- **Context:** Injected-callback options at lines 11-136. `orchestrationDispatch` handler at lines 791-839, route at 1925-1926. Route dispatch is an if-else chain in `_handleRequest` (lines 1889-1980). Auth is a no-op (`_checkAuth:255-258`). 127.0.0.1 bind at line 178.
- **Logic:** Add `orchestrationStart?: (workspaceRoot: string) => Promise<void>` and `orchestrationStop?: () => Promise<void>` to `LocalApiServerOptions`. Add `_handleOrchestrationStart` and `_handleOrchestrationStop` private methods mirroring `_handleOrchestrationDispatch` (auth check → callback availability → parse body → validate → call callback → return response). Add 2 route arms in the `_handleRequest` chain.
- **Implementation:** `_handleOrchestrationStart`: parse `{ workspaceRoot }` from body (default to `this._options.workspaceRoot`), call `orchestrationStart(workspaceRoot)`, return `{ success: true }`. `_handleOrchestrationStop`: no body needed, call `orchestrationStop()`, return `{ success: true }`. Route arms: `else if (pathname === '/orchestration/start' && req.method === 'POST')` and `else if (pathname === '/orchestration/stop' && req.method === 'POST')`.
- **Edge cases:** Start while already running → the callback reuses the existing terminal (idempotent). Stop while not running → the callback is a no-op (idempotent). Missing `workspaceRoot` on start → 400 with clear message (same as `orchestrationDispatch`'s validation at lines 814-820).

### `src/services/TaskViewerProvider.ts`
- **Context:** LocalApiServer constructed at lines 1039-1167. `orchestrationDispatch` callback passed at lines 1164-1166. `startOrchestratorFromKanban` is public at line 7579. `stopOrchestratorFromKanban` is public at line 7769.
- **Logic:** Add 2 callback lines alongside the existing `orchestrationDispatch` callback: `orchestrationStart: async (root) => { await this.startOrchestratorFromKanban(root); }` and `orchestrationStop: async () => { await this.stopOrchestratorFromKanban(); }`. No new methods needed — both are already public.
- **Implementation:** 2 lines added to the options object passed to `new LocalApiServer({ ... })` at line 1039.
- **Edge cases:** None — the methods are already battle-tested (used by the AUTOMATION tab button and autoban wake handler).

### `.agents/skills/switchboard-manage/SKILL.md` (new file)
- **Context:** `.agents/skills/switchboard-manage/` does NOT exist (confirmed by scout). The `switchboard-orchestration/SKILL.md` has 12 sections documenting all HTTP endpoints — referenced by the new skill, not duplicated.
- **Logic:** Skill content = persona (Switchboard project manager operating from another UI) + HTTP surface documented by reference to `switchboard-orchestration/SKILL.md` sections + hard rules (no automation by default, no eager action, no confirm gates, no direct DB writes, no project-pin questions, honest capability ceiling). User-directed actions mapped to existing endpoints. Automation is opt-in only.
- **Implementation:** On entry: read board/project state (`GET /kanban/board`) and report it; then stop and ask what the user wants. User-directed actions: browse board / switch project, examine plans, write new plans, move/complete cards, feature ops (via A3's reconcile when available), dispatch coding, drive ClickUp/Linear. Automation options: "Run one pass now" (inline group→dispatch→verify→merge), "Arm the unattended engine" (`POST /orchestration/start`), "Stop" (`POST /orchestration/stop`). Reference `GET /catalog` (A1's endpoint) for self-discovery of newly-available verbs.
- **Edge cases:** Hosts without filesystem access → skill works via HTTP only. Hosts with filesystem access → may also edit docs/constitution/PRD/plan files directly. The skill must state the capability ceiling honestly (control-plane actions light up as A2b's per-verb burn-down lands endpoints).

### `src/services/ClaudeCodeMirrorService.ts`
- **Context:** `MIRROR_MANIFEST` array with `MirrorEntry` interface (lines 27-38). `switchboard-orchestrator` entry at line 62: `{ source: 'workflows/switchboard-orchestrator.md', name: 'switchboard-orchestrator', invocation: 'no-model', allowedTools: 'Bash' }`. `SkillInvocation` type at line 25: `'default' | 'no-model' | 'no-user'`.
- **Logic:** Add a new entry for `switchboard-manage` pointing to the new skill: `{ source: 'skills/switchboard-manage', name: 'switchboard-manage', invocation: 'default' }`. Repoint/remove the `switchboard-orchestrator` human entry — the engine launches the persona by file path (`TaskViewerProvider.ts:7711,7723,9235`), NOT via the manifest, so removing the human mirror entry does NOT break the engine.
- **Implementation:** Add the new `switchboard-manage` entry. Change the `switchboard-orchestrator` entry: either remove it entirely (humans can no longer slash-invoke the automation persona) or repoint it to `switchboard-manage`. Recommended: remove the `switchboard-orchestrator` entry and add `switchboard-manage` — this closes the footgun where a human slash command launches unattended automation.
- **Edge cases:** Engine launch independence verified: `TaskViewerProvider.ts:7711` (`const personaPath = path.join(root, '.agents', 'workflows', 'switchboard-orchestrator.md')`), `:7723` (kickoff prompt references the file path), `:9235` (wake prompt references the file path) — all direct file-path refs, independent of the mirror manifest. Removing the manifest entry has zero effect on the engine.

### `AGENTS.md` / `CLAUDE.md`
- **Context:** Neither file lists `switchboard-manage` in its skill table (confirmed by scout).
- **Logic:** Add a row to both skill tables: `| switchboard-manage | Host-agnostic management console for driving Switchboard from any agentic host with VS Code minimised |`.
- **Implementation:** One line per file, following the existing table format.
- **Edge cases:** The skill must also be discoverable by the `skill` tool — it lives under `.agents/skills/` which is the distributed skill location.

## Verification Plan
### Automated Tests
- Skipped per session directive — no automated test run required.
### Manual Verification
- `POST /orchestration/start` from a curl (VS Code minimised) spins the orchestrator terminal + arms the autoban clock exactly as the AUTOMATION tab button does; `POST /orchestration/stop` disables it.
- `/switchboard-manage` in Claude Code: on entry reports board state and does nothing else; performs a card move / feature create / dispatch only when asked; never emits a confirm gate; never asks about project pinning.
- Human `/switchboard-orchestrator` no longer resolves to the unattended persona (mirror entry removed or repointed).
- Engine launch still works after mirror edit: AUTOMATION tab "Start orchestrator" button still launches the orchestrator persona (file-path ref independent of manifest).
- `GET /catalog` (A1's endpoint) is documented in the skill but NOT implemented by Manage — verify no duplicate route arm exists in Manage's code changes.

**Stage Complete:** PLAN REVIEWED
