# Epic: Remote Planning Infrastructure

## Goal

Enable full Switchboard planning workflows from remote sessions (Claude Code on the web, claude.ai) without requiring the local machine or IDE to be running. Plans are read from and written directly to Linear/Notion via MCP — no git branches, no pull requests, no repo file writes for the planning phase.

### Problem & Background

Currently Switchboard plans are `.md` files in `.switchboard/plans/`. All column transitions are executed by the Switchboard VS Code extension on the local machine. This creates two blockers for remote sessions:

1. **Branch/git dependency**: A remote agent (Claude Code web) must commit plan files to a branch and open a PR. The user must pull and review before any work lands in the kanban board.
2. **No async column transitions**: If a remote agent improves a plan and wants to advance the kanban card, the extension must be running. Without it, the card stays stuck in its current column until the user manually moves it.

The fix is to make Linear/Notion the source of truth for plans during the remote phase, using the existing two-way sync infrastructure. The extension already maps Linear statuses to kanban columns — so a remote agent updating a Linear issue status is equivalent to moving a kanban card, picked up on next IDE startup via a new reconciliation step.

### Root-Cause Analysis (current-state audit)

A read of the shipped code refines the premise above. The bulk of the "async column transitions" infrastructure is **already built**:

- `src/services/RemoteControlService.ts` already implements **delta polling** with two persisted cursor streams — state (`remote.stateCursor.{kind}`) and comments (`remote.commentCursor.{kind}`) — plus seed-on-first-poll, echo guards (column-equality no-op, `authoredBySelf` skip, processed-comment seen-set), `importRemotePlan` for remote-authored new plans, `refreshLocalPlanFromRemote` (pulls remote body into the local plan before dispatch), and `postComment` dispatch acknowledgments.
- `src/services/remote/RemoteProvider.ts` defines the provider seam; `LinearRemoteProvider.ts` and `NotionRemoteProvider.ts` implement it (Linear queries `issues`/`comments` entities separately; Notion queries the plans DB + Comments DB).
- Startup auto-start is wired: `KanbanProvider.ts:5153` calls `rc.restoreFromConfig()` on webview `ready`, and `restoreFromConfig()` (`RemoteControlService.ts:183`) auto-starts **Constant** mode (which runs a one-time reconciling poll in `start()` when `silentSync` is off).

The **actual residual gap** is narrower than the original premise: `restoreFromConfig()` only reconciles on startup in **Constant** mode. In **Manual** mode it does nothing on startup, so remote status changes made while the machine was off sit unprocessed until the user manually clicks "start pinging." The startup reconciler child plan targets this gap but, as written, proposes a *parallel* reconciliation path against a config key (`last_remote_sync`) that does not exist in the codebase. The corrected approach is to extend the existing service (see `## Proposed Changes`).

---

## Metadata

**Complexity:** 7
**Tags:** infrastructure, backend, cli, feature, devops, reliability

---

## User Review Required

Yes — before implementation, the user should confirm:

1. **Reconciler approach correction**: The `kanban-startup-reconciler.md` child plan as written references a non-existent `last_remote_sync` config key and proposes a parallel reconciliation function in `TaskViewerProvider`. The recommended fix is to extend `RemoteControlService.restoreFromConfig()` instead. Confirm this correction is acceptable before touching the child plan.
2. **Skill consolidation vs. duplication**: A `switchboard_remote_notion.md` remote-orientation skill already ships. Confirm whether `/sw-remote` should **supersede/absorb** it or coexist (the plan below assumes consolidation to avoid drift).
3. **Phase 2 scope timing**: Phase 2 (repo mapping & live doc sync) remains a deferred design session. Confirm it stays out of this implementation pass.
4. **Resolved via web research** — the two uncertain assumptions (Linear MCP tool names; Notion body-block write fidelity) were confirmed via research. See `## Research Findings` for the resolved facts, including one **critical safety caveat**: a Notion `update-page-markdown` full overwrite permanently deletes/orphans nested sub-pages, DB views, and templates and breaks block IDs/deep-links.

---

## Complexity Audit

### Routine

- Authoring two new agent-side skill files (`.claude/skills/improve-remote-plan/SKILL.md`, `.claude/skills/sw-remote/SKILL.md`) — prose/inline-instruction files following the existing skill frontmatter pattern (e.g. `.agents/skills/switchboard_remote_notion.md`).
- Registering the two skills in the `### 📚 Available Skills` and Workflow Registry tables in `AGENTS.md` / `CLAUDE.md`.
- Marking the superseded stub `add-switchboard-remote-skill.md` as superseded.

### Complex / Risky

- **Reconciler correctness (residual gap)**: Extending `restoreFromConfig()` to run a one-time reconcile poll in **Manual** mode without starting the ongoing timer — must not double-reconcile with the existing Constant-mode path, must reuse the existing cursor machinery (no new timestamp key), and must remain a clean no-op when remote control is unconfigured. Mis-implementation risks duplicate agent dispatches or a feedback loop.
- **Remote write-back fidelity (Phase 1 write phase)**: The `/improve-remote-plan` skill writes improved markdown back to a Linear issue description / Notion page body. Round-trip fidelity (Linear description markdown format; Notion MCP body-block update support) is not guaranteed by the existing local skills, which only do property updates + comment posting.
- **Status-name drift**: The "next-column trigger" status name must be read live from the remote control mapping (`columnToStateId` for Linear; Notion `Kanban Column` select options), never hardcoded — a wrong status is a silent no-op or a wrong-column advance.
- **Coordination across 3 child plans + existing shipped infra**: The Epic must not re-implement what `RemoteControlService` already does.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- Two reconciliation paths (the existing `restoreFromConfig()` Constant-mode poll and a new Manual-mode startup poll) could both fire if a user toggles modes mid-startup. Mitigation: a single `_poll()` entry point with the `_polling` re-entrancy guard already in `RemoteControlService.ts:193` (`if (this._polling) { return; }`); do not add a second path that bypasses it.
- Outbound push → bumped remote timestamp → inbound delta: already defended by the echo guard (`targetColumn === plan.kanbanColumn` no-op, `RemoteControlService.ts:295`). The reconciler must not weaken this.
- Comment cursor advances only after dispatch (at-least-once); a startup reconcile must preserve this, not reset cursors.

**Security**
- Remote MCP tokens stay host-side (the existing `linear_api.md` / `notion_api.md` skills never expose tokens to the agent). The new skills must keep the same invariant — never call provider APIs with raw tokens from the agent side; in a remote claude.ai session the MCP connector holds the token.
- The `/improve-remote-plan` write phase must not inject content into a Linear issue / Notion page that the user did not approve; the skill is improvement-only and must not advance to an execution-trigger status unprompted.

**Side Effects**
- A startup reconcile poll in Manual mode will dispatch column agents for any remote status changes accumulated offline. This is the desired behavior but is a **new** side effect for Manual-mode users who previously saw no auto-activity on startup — it should be logged and, if disruptive, gated behind the existing `silentSync` flag.
- Writing improved content back to a Linear issue description overwrites the prior description (last-write-wins). If the user edited locally and remotely simultaneously, the remote write wins on the remote surface and the local file is refreshed on next dispatch.

**Dependencies & Conflicts**
- Depends on the already-shipped `RemoteControlService` + `LinearRemoteProvider` / `NotionRemoteProvider` and the persisted cursor keys `remote.stateCursor.{kind}` / `remote.commentCursor.{kind}` / `remote.commentSeen.{kind}` (DB config table). NotionBackupService already aligns to these keys (`NotionBackupService.ts:312`).
- Depends on the existing `switchboard_remote_notion.md` remote-orientation skill — `/sw-remote` must build on it, not re-derive it.
- Conflicts with the `kanban-startup-reconciler.md` child plan's proposed `last_remote_sync` key (does not exist) and its proposed `reconcileRemoteStatusChanges()` in `TaskViewerProvider` (duplicates the service). Resolution in `## Proposed Changes`.

---

## Dependencies

- `improve-remote-plan-skill.md` — child plan: new `/improve-remote-plan` skill (Complexity 3).
- `sw-remote-entry-skill.md` — child plan: new `/sw-remote` entry skill (Complexity 3).
- `kanban-startup-reconciler.md` — child plan: startup reconciler (Complexity 4) — **needs correction** per this Epic.
- `add-switchboard-remote-skill.md` — superseded stub; folded into `/sw-remote`.
- Existing shipped infra (no new work): `src/services/RemoteControlService.ts`, `src/services/remote/RemoteProvider.ts`, `src/services/remote/LinearRemoteProvider.ts`, `src/services/remote/NotionRemoteProvider.ts`, `src/services/KanbanProvider.ts:5147-5159` (startup wiring), `.agents/skills/switchboard_remote_notion.md`.

---

## Adversarial Synthesis

Key risks: (1) the startup-reconciler child plan re-invents a `last_remote_sync` key and a parallel reconciliation path that the already-shipped `RemoteControlService` delta-polling covers — implementing it as written would create a second, conflicting reconciliation stream; (2) the `/improve-remote-plan` write-back phase assumes Linear/Notion MCP fidelity (tool names + body-block updates) that the local skills never exercise; (3) a Manual-mode startup poll is a new side effect that silently dispatches agents for offline changes. Mitigations: extend `restoreFromConfig()` to reuse the existing `_poll()` + cursor machinery for Manual-mode startup reconciliation (single path, no new key), read status mappings live from remote config, and gate the new Manual-mode auto-poll behind `silentSync` so behavior is opt-in.

---

## Proposed Changes

### Phase 1 — Remote Plan Improvement (no git)

**Goal**: A remote agent can improve plans and advance kanban columns entirely via Linear/Notion MCP, with no git involvement. (Preserved from original Phase 1.)

**Child plans (preserved):**
- `improve-remote-plan-skill.md` — New `/improve-remote-plan` skill: reads plan from Linear/Notion, applies improve-plan logic, writes content and status back via MCP.
- `sw-remote-entry-skill.md` — New `/sw-remote` skill: entry point for remote sessions, orients agent to remote-mode workflow (supersedes `add-switchboard-remote-skill.md`).
- `kanban-startup-reconciler.md` — Extension feature: on startup, query Linear/Notion for status changes made during offline period and reconcile `kanban.db`.

**Dependency** (preserved): Phase 1 requires the Linear/Notion remote control to already be configured and a board mapped. No new sync infrastructure needed.

#### Clarification / Correction to the child plans

- **`improve-remote-plan-skill.md`** — valid gap; the skill does not yet exist. **Clarification (research-confirmed)**: it must reconcile with the already-shipped `.agents/skills/switchboard_remote_notion.md` (which covers Notion dispatch/authoring/commenting) — do not re-derive the Notion loop; cross-reference it and add only the improve-plan logic + Linear branch. The write phase now has confirmed MCP surfaces:
  - **Linear**: tools are `list_issue_statuses` (opt. `teamId`), `get_issue` (`issueId`), **`update_issue`** (`issueId` + opt. `title`, `description` as Markdown, `status` as a **status-name string**, `priority`, `assigneeId`), `list_projects`, `list_issues`, `search_issues`. NOTE: the child plan's assumed `save_issue` is **wrong** — the correct tool is `update_issue`, and `status` is the human-readable status name (read via `list_issue_statuses`), not an ID. Description Markdown (tables, code fences, nested lists) round-trips with high fidelity.
  - **Notion**: v2.x official server exposes `retrieve-page-markdown` (read body) and `update-page-markdown` (write body, with a `replace_content` option). **CRITICAL**: a full `replace_content` overwrite permanently deletes/orphans any nested inline sub-pages, database views, or templates on the page, and changes block IDs (breaking deep-links, comments, anchors). The improve skill must therefore either (a) avoid `replace_content` on pages known to hold inline content, or (b) clear-and-rewrite only the plan body block range, or (c) use `API-patch-block-children` append for additive improvements. Append is the safest default; full overwrite must be gated on a "this page has no inline children" check. The official local server is soft-deprecated with known OpenAPI schema-wrapping bugs (HTTP 400s on `API-update-a-block`); community servers (`suekou/mcp-notion-server` v2.x) are more robust for high-frequency writes and implement `Retry-After` backoff, which the official local server does not.
- **`sw-remote-entry-skill.md`** — valid gap; the skill does not yet exist. **Clarification**: it should **absorb/supersede** `switchboard_remote_notion.md` rather than parallel it, to prevent orientation drift. The existing skill's "how the loop works" + "pre-flight" + "steps" content is the source of truth for the Notion branch.
- **`kanban-startup-reconciler.md`** — **needs correction**. As written it (a) references a `last_remote_sync` config key that does **not** exist (the real keys are `remote.stateCursor.{kind}` / `remote.commentCursor.{kind}`), and (b) proposes a new `reconcileRemoteStatusChanges()` in `TaskViewerProvider` that duplicates `RemoteControlService`. Corrected approach:

  **Target file:** `src/services/RemoteControlService.ts`
  - **Context**: `restoreFromConfig()` (line 183) only auto-starts Constant mode; Manual mode does nothing on startup, leaving offline remote status changes unreconciled.
  - **Logic**: Extend `restoreFromConfig()` so that when remote control is configured (regardless of `pingMode`), it runs **one** `await this._poll()` for reconciliation. In Manual mode, do **not** call `_scheduleTimer` — the poll is one-shot. In Constant mode, behavior is unchanged (it already calls `start()` which runs the reconcile poll + schedules the timer). This reuses the existing `_poll()` → `fetchStateDeltas` → `_applyStateMirror` path and the existing persisted cursors; no new timestamp key and no second reconciliation function.
  - **Implementation**: guard the Manual-mode one-shot with `if (!config.silentSync)` to mirror the existing `start()` semantics, so the new auto-poll is opt-in via `silentSync` and avoids surprising Manual-mode users with a burst of offline dispatches.
  - **Edge cases**: rely on the existing `_polling` re-entrancy guard (line 193) and echo guard (line 295); network failure is already caught in `_poll()` (line 212); a no-config workspace returns early (line 153).

  **Target file:** `src/services/KanbanProvider.ts`
  - No change required — the existing call at line 5153 (`await rc.restoreFromConfig()`) already invokes the corrected method on webview `ready`. Do **not** add a second invocation in `TaskViewerProvider.initializeKanbanDbOnStartup()`.

  **Child plan update:** revise `kanban-startup-reconciler.md` to reflect the corrected approach (reuse `restoreFromConfig()` + existing cursors; drop `last_remote_sync` and the `TaskViewerProvider` function).

### Phase 2 — Repo Mapping & Live Doc Sync

**Goal** (preserved): Detailed codebase documentation lives in Linear/Notion, maintained continuously by the extension. Enables pure claude.ai + Notion connector planning sessions with no Claude Code remote, no GitHub MCP, no branches.

**Child plans:** TBD — requires a design session on:
- Rate limit management for continuous sync (research-confirmed: Notion = **3 req/s average**, 429 with `Retry-After`, 529 when overloaded; Linear = **1,500 req/hour** via PAT / **500 req/hour** via OAuth, plus 250k complexity points/hour, 429 with `X-RateLimit-*` headers). Notion is the binding constraint for continuous sync — write-batching and backoff queues are mandatory; the official local Notion server does NOT auto-retry (community servers do).
- Doc granularity strategy (file summaries, module docs, ADRs)
- Leveraging existing notebooklm integration folder as a base
- Sync state tracking (what changed, what was already pushed)

**Outcome** (preserved): User opens claude.ai, attaches Notion, asks Claude to write a plan. Claude reads live codebase docs from Notion, authors a plan, writes it back to Notion with the trigger status. Extension picks it up on startup. Zero git.

### Existing infrastructure (already built — no work in this Epic)

- Delta polling + state/comment mirroring + dispatch ack: `RemoteControlService.ts`.
- Provider seam + Linear/Notion backends: `src/services/remote/*`.
- Startup auto-start (Constant mode): `KanbanProvider.ts:5147-5159`.
- Notion remote orientation skill: `.agents/skills/switchboard_remote_notion.md`.

---

## Verification Plan

### Automated Tests

> Note: Per session directives, automated tests are **not run** in this planning pass — the suite will be run separately by the user. The following describes what to verify when implementation lands.

- **Reconciler unit test**: extend `src/test/integrations/shared/remote-control-service.test.js` to assert that `restoreFromConfig()` in Manual mode (with `silentSync` off) runs exactly one `_poll()` and does **not** schedule a timer (`isActive` stays false); and that Constant mode behavior is unchanged.
- **No-double-reconcile test**: assert that a Constant-mode `restoreFromConfig()` does not poll twice (the `_polling` guard holds), and that the persisted cursor advances exactly once.
- **No-op when unconfigured**: assert `restoreFromConfig()` with empty `boards` or no provider is a clean no-op (no poll, no timer), reusing the existing `start()` early-return at `RemoteControlService.ts:153`.
- **Skill existence check**: assert `.claude/skills/improve-remote-plan/SKILL.md` and `.claude/skills/sw-remote/SKILL.md` are present and registered in `AGENTS.md` / `CLAUDE.md` skill tables.
- **Echo guard regression**: re-run the existing delta-polling orchestration tests to confirm the Manual-mode startup poll does not weaken the `targetColumn === plan.kanbanColumn` no-op or the `authoredBySelf` comment skip.

### Manual Verification

- With remote control in **Manual** mode and the machine offline, change a Linear issue status / Notion `Kanban Column` remotely; restart the IDE; confirm the kanban card advances exactly once and the destination column's agent is dispatched (or a dispatch-ack comment appears) without a duplicate.
- In a remote claude.ai session, invoke `/sw-remote` → `/improve-remote-plan` on a "Created" plan; confirm content is read, improved, written back, and the status advances to the improvement column (not an execution-trigger column).

---

## Research Findings

The two assumptions flagged during planning were confirmed via web research. Key resolved facts (full detail folded into `## Proposed Changes`):

1. **Linear MCP tool names — CONFIRMED** (`https://mcp.linear.app/mcp`, 21 core tools). The exact surface for the `/improve-remote-plan` write phase: `list_issue_statuses` (opt. `teamId`), `get_issue` (`issueId`), **`update_issue`** (`issueId` + opt. `title`, `description` as Markdown, `status` as a **status-name string** — not an ID, `priority` 0–4, `assigneeId`), `list_projects`, `list_issues`, `search_issues`. The `improve-remote-plan-skill.md` child plan's assumed `save_issue` is **wrong** → must be `update_issue`. Linear description Markdown (tables, code fences, nested lists) round-trips with high fidelity (last-write-wins, no merge). Rate limits: 1,500 req/hour (PAT) / 500 req/hour (OAuth) + 250k complexity points/hour; 429 with `X-RateLimit-*` headers.

2. **Notion MCP body-block write — CONFIRMED with a critical safety caveat.** The v2.x official server (`@notionhq/notion-mcp-server`) exposes `retrieve-page-markdown` (read body) and `update-page-markdown` (write body, with `replace_content`), plus `API-patch-block-children` (append) and `API-patch-page` (properties only), and `query-data-source` (replaces `post-database-query`). **The caveat**: a `replace_content` full overwrite **permanently deletes/orphans nested inline sub-pages, database views, and templates** on the page, and changes block IDs (breaking deep-links, comments, anchors). The `/improve-remote-plan` skill must default to append (`API-patch-block-children`) and only use full overwrite after confirming the page has no inline children. The official local server is soft-deprecated with OpenAPI schema-wrapping bugs causing HTTP 400s on `API-update-a-block`; community servers (`suekou/mcp-notion-server` v2.x) are more robust and implement `Retry-After` backoff (the official local server passes 429s straight to the client). Rate limit: 3 req/s average (429 + `Retry-After`, 529 when overloaded) — the binding constraint for Phase 2 continuous sync.

No outstanding uncertainties remain.

---

## Out of Scope (this epic)

- Changes to the existing `/sw` (switchboard-chat) skill — it remains for users without remote integration
- ClickUp support in Phase 1 (Linear/Notion only, ClickUp can follow)
- Automated plan creation from scratch remotely (Phase 1 covers improvement only)

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add `/create-epic` Skill for Remote Agent Epic Creation](../plans/create-epic-skill.md) — **PLAN REVIEWED**
- [ ] [Add Epic-Grouping Awareness to Chat and Memo-Planning Skills](../plans/epic-grouping-awareness-in-chat-and-memo-skills.md) — **PLAN REVIEWED**
- [ ] [Add /improve-remote-plan Skill for Linear/Notion-Native Plan Improvement](../plans/improve-remote-plan-skill.md) — **PLAN REVIEWED**
- [ ] [Kanban Startup Reconciler for Remote Plan Status Changes](../plans/kanban-startup-reconciler.md) — **PLAN REVIEWED**
- [ ] [Add /sw-remote Entry Skill for Remote Switchboard Sessions](../plans/sw-remote-entry-skill.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
