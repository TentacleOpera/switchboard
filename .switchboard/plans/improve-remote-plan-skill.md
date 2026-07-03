# Add /improve-remote-plan Skill for Linear/Notion-Native Plan Improvement

> **Scope update (2026-07-01):** The Notion write phase MUST use the **Notion Overwrite Data-Loss Guard** (`notion-overwrite-guard.md`) — append-by-default, full overwrite only after a verified childless check. Linear writes use **`update_issue`** (not `save_issue`), with `status` as a status-name string read via `list_issue_statuses`. This is the single orientation family with `/sw-remote`. See `feature_plan_20260701_remote-control-production-sequencing.md`.

## Goal

Create an `/improve-remote-plan` skill that improves a Switchboard plan living in Linear or Notion — reading content from the issue/page, deepening it with improve-plan logic, writing the result back via MCP, and advancing the card's status — all without touching the git repo or local filesystem.

### Problem & Background

The existing `/improve-plan` workflow reads `.md` plan files from `.switchboard/plans/` and writes back to the same files. In a remote session (Claude Code web, claude.ai) with no local machine running, this creates a git dependency: the agent must commit to a branch and open a PR before any improvement lands in the kanban board. There is also a timing race where the extension starts before the branch is pulled, so column transitions are missed.

The root fix is to treat Linear/Notion as the canonical plan store during the remote phase. The extension's existing two-way sync already maps Linear statuses to kanban columns — so writing content and updating a status in Linear is functionally equivalent to editing the plan file and moving the card, picked up by the startup reconciler (see `kanban-startup-reconciler.md`).

This skill is the agent-side half of that fix.

### Codebase Findings — Correction of Original Plan Assumptions

**The original plan (Implementation Tasks below) was written without verifying how Switchboard agents actually reach Linear/Notion.** The plan assumes MCP-native tool calls (`get_issue`, `save_issue`, `list_issue_statuses`, `list_projects`). The reality is different and has a significant gap for Notion:

1. **Linear access is via a LocalApiServer GraphQL proxy, NOT MCP tool calls.** Agents shell out through `.agents/skills/_lib/sb_api_call.sh` to `POST /api/linear` with a raw GraphQL query string (see `linear_api.md` skill, lines 17–22). There is no `get_issue` / `save_issue` / `list_issue_statuses` wrapper — the agent writes GraphQL directly. This is confirmed in `src/webview/planning.js` lines 199–203: "Linear writes (create issue, change state, add comment) go through the GraphQL proxy (POST /api/linear, linear_api skill)... Do not use the MCP."

2. **Comments go through a dedicated `/comment` route, NOT raw GraphQL.** The host stamps a hidden `<!-- switchboard -->` self-marker so the inbound poll skips the agent's own comment (no feedback loop). This is documented in `linear_api.md` lines 31–48 and `notion_api.md` lines 20–35. The route is `POST /comment` with `provider: "linear"` or `provider: "notion"` and the issue/page ID.

3. **Notion has NO read/write API route exposed to agents — only reply.** The `notion_api.md` skill (lines 1–46) is reply-only: it posts to `POST /comment` with `provider: "notion"`. There is no `/api/notion` route in `LocalApiServer.ts` (confirmed: only `/api/linear` at line 985 and `/api/clickup` at line 983 exist). Notion page reads and body updates happen inside the extension via `NotionFetchService` (used by `NotionRemoteProvider`), but that service is NOT exposed to agents over the LocalApiServer. **This is a critical gap:** the plan's "Read phase" and "Write phase" for Notion cannot be implemented with the current agent-facing API surface.

4. **The skill file path is correct.** `.claude/skills/improve-remote-plan/SKILL.md` is consistent with the existing `.claude/skills/` directory structure (confirmed: 27 subdirectories including `improve-plan`, `switchboard-chat`, `sw`, etc.).

5. **The CLAUDE.md skills table insertion point is confirmed.** The table is at `CLAUDE.md` lines 106–127. The new row should go after the `improve-plan`-adjacent skills (after line 126, the `refine_ticket` row, before line 128). BUT: the table in `CLAUDE.md` is a GENERATED artifact from the plugin's protocol block (the `<!-- switchboard:agents-protocol:start -->` markers at the top of the file). The same table also appears in `AGENTS.md`. **Clarification:** The plan says to add a row to `CLAUDE.md` — but since the table is auto-generated, the skill registration may need to happen at the source (the plugin that emits the protocol block) rather than by hand-editing `CLAUDE.md`. If hand-editing, the row must be added to BOTH `CLAUDE.md` and `AGENTS.md` to stay consistent, and may be overwritten on the next plugin update. See **## User Review Required**.

6. **Linear status → column mapping is available via GraphQL.** The agent can query `teams { states { id name } }` to enumerate Linear workflow states, and the `LinearSyncService` config (`columnToStateId` mapping, used in `LinearRemoteProvider.ts` line 40) defines which state ID maps to which kanban column. The agent can read this mapping by querying the Linear API for the team's states and matching against the known column names. However, the `columnToStateId` config is stored in the extension's `LinearSyncService` config, NOT in the kanban DB's `remote.config` key — the agent has no direct way to read it over the LocalApiServer. **Clarification:** The skill should query Linear for the team's workflow states and let the USER confirm which state corresponds to the "Improved" column, rather than assuming the config is readable.

---

## Metadata

**Complexity:** 5
**Tags:** cli, infrastructure, feature, docs

## User Review Required

**Decision 1: Notion read/write gap — how to handle it?**

The current agent-facing API surface has NO route for reading or updating Notion page bodies. The `notion_api` skill is reply-only (posts comments). Options:
- **(A) Linear-only for v1:** Ship the skill for Linear only; for Notion, direct the user to the local `/improve-plan` workflow until a Notion read/write API route is added to `LocalApiServer.ts`. This is the safest path and matches the current capabilities.
- **(B) Add a Notion read/write route first:** Implement a `POST /api/notion` route in `LocalApiServer.ts` that proxies page reads (fetch blocks → markdown) and page updates (markdown → blocks), then ship the skill for both providers. This is a larger scope change (a separate plan) and depends on `NotionFetchService` exposing update capabilities.
- **Recommended: (A).** Ship Linear-only now; file a follow-up plan for the Notion API route.

**Decision 2: Skill table registration — hand-edit or source-level?**

The `### 📚 Available Skills` table in `CLAUDE.md` (lines 106–127) and `AGENTS.md` is inside a `<!-- switchboard:agents-protocol:start -->` generated block. Hand-editing may be overwritten by plugin updates.
- **Recommended:** Add the row to the plugin's skill registry source (wherever the protocol block is generated from), so it's included automatically. If that source isn't accessible in this session, hand-edit BOTH `CLAUDE.md` and `AGENTS.md` as a stopgap and note the risk.

## Complexity Audit

### Routine
- Creating the skill markdown file at `.claude/skills/improve-remote-plan/SKILL.md` — pure documentation, mirrors the existing `improve-plan/SKILL.md` structure.
- Writing the Linear GraphQL query templates for reading an issue (`query { issue(id: "...") { ... } }`) and updating it with GraphQL variables (`mutation UpdateIssue($id: String!, $desc: String, $stateId: String) { issueUpdate(...) }` — variables avoid double-escaping, confirmed by web research).
- Adding a row to the skills table in `CLAUDE.md` (and `AGENTS.md`).

### Complex / Risky
- **Notion read/write gap** — the skill cannot read or update Notion page bodies with the current API surface. This is a blocking architectural gap, not a documentation issue. See User Review Required Decision 1.
- **Status mapping discovery** — the agent has no direct way to read the `columnToStateId` config that maps Linear states to kanban columns. The skill must either query Linear for team states and ask the user to confirm, or accept the target status name as an argument. Getting this wrong means the card advances to the wrong column (or no-ops).
- **Generated table overwrite risk** — hand-editing the protocol block in CLAUDE.md/AGENTS.md may be overwritten by plugin updates, silently unregistering the skill.

## Edge-Case & Dependency Audit

- **Race Conditions:** ELIMINATED by web research. The corrected Write Phase uses a SINGLE `issueUpdate` mutation with both `description` and `stateId` in the same `input` object (confirmed: `IssueUpdateInput` accepts both as optional fields in one atomic transaction). The original two-call design (description first, status second) had a race where a crash between calls would leave improved content stranded with the old status. The single-call approach makes this impossible.
- **Security:** The skill uses the existing `sb_api_call.sh` proxy — no new credential exposure. The Linear token stays host-side (the proxy adds it). The agent never sees the token.
- **Side Effects:** A single `issueUpdate` mutation updating both `description` and `stateId` bumps the issue's `updatedAt` timestamp ONCE (confirmed by web research: any `issueUpdate` mutation bumps `updatedAt` to the transaction execution time, regardless of which fields changed). The startup reconciler's `fetchStateDeltas` query (`updatedAt > cursor`) will pick this up. Since the status changed in the same transaction, the card advances + dispatches. The echo guard (`targetColumn === plan.kanbanColumn`) no-ops if the card is somehow already in the target column. Safe.
- **Dependencies & Conflicts:**
  - **Hard dependency on `kanban-startup-reconciler.md`** — without the startup reconciler, status changes written by this skill will NOT advance the kanban card until the user manually starts pinging. The skill's confirmation message must note this caveat.
  - **Hard dependency on the LocalApiServer running** — `sb_api_call.sh` checks for `.switchboard/api-server-port.txt` and health-checks the server. If the extension isn't active, the skill fails with a clear error.
  - **Conflict with MCP usage** — the `linear_api` skill explicitly says "Do not use the MCP" (per `planning.js` line 200). The new skill must follow the same convention: use the LocalApiServer proxy, not the Linear MCP connector.

## Dependencies

- `kanban-startup-reconciler.md` — the startup reconciler that picks up the status changes this skill writes. Without it, the card won't advance automatically.

## Adversarial Synthesis

Key risks: (1) the plan assumes MCP-native tool calls that don't exist in this codebase — agents use a GraphQL proxy with raw queries, not `get_issue`/`save_issue` wrappers; (2) Notion has NO agent-facing read/write API route — only reply — making the Notion branch of the skill unimplementable without a new `LocalApiServer` route; (3) the status→column mapping isn't readable by agents, so the skill must discover it at runtime or accept it as an argument. Mitigations: ship Linear-only for v1 with GraphQL query templates using variables (confirmed best practice by web research); document the Notion gap as a follow-up plan; require the user to confirm the target status name rather than hardcoding it. The two-call race condition (original risk #4) is eliminated by using a single `issueUpdate` mutation with both `description` and `stateId` (confirmed by web research).

## Proposed Changes

### [CREATE] `.claude/skills/improve-remote-plan/SKILL.md` — New skill file

**Context:** The existing `/improve-plan` skill (`.claude/skills/improve-plan/SKILL.md`) reads/writes local `.md` files. This new skill mirrors its improvement logic but operates on Linear issues via the LocalApiServer GraphQL proxy. Notion support is deferred (see User Review Required Decision 1).

**Logic:** The skill file is agent instruction markdown (no executable code). It orients the agent on the following workflow:

```markdown
---
name: improve-remote-plan
description: Improve a Switchboard plan stored in Linear — reads, deepens, writes back via the LocalApiServer GraphQL proxy without touching git. Use in remote sessions.
---

# Improve Remote Plan (Linear)

Improve a Switchboard plan stored as a Linear issue — without touching the git repo
or local filesystem. This is the remote-session counterpart to `/improve-plan`, which
operates on local `.md` files.

## When to Use
- You are in a remote session (Claude Code web, claude.ai) with no local machine running.
- A plan exists as a Linear issue in a Switchboard-mapped project.
- You need to deepen the plan and advance its status so the startup reconciler moves the kanban card.

## When NOT to Use
- You have a local VS Code session with the Switchboard extension active → use `/improve-plan` instead (it edits local files directly).
- The plan is in Notion → Notion read/write is not yet supported via the agent API. Use the local `/improve-plan` workflow instead (see User Review notes in the plan file).

## Prerequisites
- The Switchboard extension must be active (LocalApiServer running) — `sb_api_call.sh` health-checks this automatically.
- Linear integration must be configured in Switchboard (the proxy adds the token host-side).

## Pre-flight
1. Confirm the LocalApiServer is reachable: `sb_api_call.sh` will fail with a clear error if not.
2. Identify the target Linear issue:
   - If the user provides an issue ID/URL: use it directly.
   - If no issue specified: query for issues in the "Created"/backlog status in the Switchboard-mapped project:
     ```bash
     sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
       "query": "query { issues(first: 50, filter: { team: { id: { eq: \"<TEAM_ID>\" } } }) { nodes { id identifier title state { id name } } } }"
     }'
     ```
   - Present the list to the user and let them choose.
3. Identify the target "Improved" status:
   - Query the team's workflow states:
     ```bash
     sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
       "query": "query { teams(first: 1) { states { id name type } } }"
     }'
     ```
   - Present the state names to the user and ask which one corresponds to the "Improved" column. Do NOT guess — an incorrect status = wrong column advance or silent no-op.

## Read Phase
1. Fetch the full issue:
   ```bash
   sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
     "query": "query { issue(id: \"<ISSUE_ID>\") { id title description state { id name } } }"
   }'
   ```
2. Parse the `description` field as the plan content.
3. If the description is empty or missing a `## Goal` section, warn the user — the plan may not have been authored yet. Ask whether to proceed with minimal content or abort.

## Improve Phase
Apply the same logic as `/improve-plan`:
- Sharpen and expand the `## Goal` section with problem analysis and root cause if missing.
- Identify and document edge cases not covered by the current tasks.
- Deepen implementation tasks with specific file paths, method names, and constraints where inferable from the description.
- Add or improve `## Edge Cases & Risks` and `## Out of Scope` sections.
- Do NOT change the plan's intent or introduce scope the user hasn't approved.

## Write Phase
Write the improved content AND update the status in a SINGLE `issueUpdate` mutation using GraphQL variables (avoids double-escaping and eliminates the two-call race condition — confirmed by web research):
```bash
sb_api_call POST /api/linear -H "Content-Type: application/json" -d '{
  "query": "mutation UpdateIssue($id: String!, $desc: String, $stateId: String) { issueUpdate(id: $id, input: { description: $desc, stateId: $stateId }) { success issue { id } } }",
  "variables": { "id": "<ISSUE_ID>", "desc": "<IMPROVED_CONTENT>", "stateId": "<STATE_ID>" }
}'
```
- **Use GraphQL variables** (the `"variables"` key) to pass the description and stateId — NOT string concatenation in the query body. This avoids the JSON-in-GraphQL double-escaping chain entirely; only standard JSON escaping (`\"`, `\n`, `\\`) is needed, which `jq` or any JSON serializer handles automatically.
- The `issueUpdate` mutation accepts both `description` and `stateId` in the same `input` object atomically (confirmed: `IssueUpdateInput` type has both as optional fields). A single call updates both in one transaction.
- Check `success === true` in the response before reporting success.
- Do NOT move the issue to a status that triggers local execution (e.g. "Coded") unless the user explicitly instructs it — the purpose of this skill is improvement, not dispatch.
- **Size limit:** The `description` field has a 250,000-character maximum. If the improved plan exceeds this, the mutation will reject with a validation error. Extremely large plans are unlikely but should be checked.

## Confirmation
1. Report back: issue ID/identifier, what was changed (summary), and what status it was set to.
2. Remind the user that the kanban card will advance on next IDE startup via the startup reconciler (see `kanban-startup-reconciler.md`).
3. If the startup reconciler has NOT been deployed yet, warn the user that the card won't advance automatically — they'll need to manually move it or start pinging.

## Out of Scope
- Creating new plans from scratch (the read phase requires existing plan content).
- Dispatching local execution (that's a separate status transition the user controls).
- Notion support (the agent API surface doesn't expose Notion page read/write — follow-up plan needed).
- Modifying the `/improve-plan` skill (the local session variant stays unchanged).
```

**Edge Cases:**
- The GraphQL `issueUpdate` mutation returns `{ success, issue { id } }` — check `success === true` before reporting success.
- **Use GraphQL variables** (the `"variables"` key in the JSON payload) to pass the description and stateId values. This avoids the JSON-in-GraphQL double-escaping chain entirely — only standard JSON escaping is needed, which `jq` or any JSON serializer handles automatically. Do NOT inline the description content in the query string (confirmed best practice by web research).
- If the issue ID is a URL (`https://linear.cc/ENG-123`), the agent must resolve it to the UUID first (query `issues(filter: { identifier: "ENG-123" })`). Note: the `issueUpdate` mutation also accepts the human-readable identifier (e.g. `"ENG-123"`) directly as the `id` argument, so resolution may not be necessary.
- **Description size limit:** 250,000 characters maximum. If the improved plan exceeds this, the mutation rejects with a validation error.

### [MODIFY] `CLAUDE.md` — Add skill to Available Skills table (lines 106–127)

**Context:** The skills table is at lines 106–127, inside a `<!-- switchboard:agents-protocol:start -->` generated block.

**Logic:** Add a new row after the `refine_ticket` row (line 126), before the `**Usage**` line (line 128):

```markdown
|| `improve-remote-plan` | Improve a plan stored in Linear via the LocalApiServer GraphQL proxy — reads, deepens, writes back, and advances status without touching git. Use in remote sessions. |
```

**Edge Cases:**
- **Generated block overwrite risk:** This table is inside a `<!-- switchboard:agents-protocol:start -->` block that may be regenerated by the plugin. If the row is hand-edited, it may be overwritten on the next plugin update. The row should also be added to `AGENTS.md` (which has the same block) for consistency. The durable fix is to register the skill in the plugin's skill registry source so it's included in the generated block automatically.

### [MODIFY] `AGENTS.md` — Add skill to Available Skills table

**Context:** `AGENTS.md` contains the same `<!-- switchboard:agents-protocol:start -->` block with the same skills table.

**Logic:** Add the identical row after the `refine_ticket` row, matching the position in `CLAUDE.md`.

**Edge Cases:** Same overwrite risk as `CLAUDE.md`.

## Verification Plan

### Automated Tests

> Per session directives: compilation and automated tests are NOT run in this session. The following documents what tests would verify the change; the user will run the suite separately.

1. **Skill file validation:** Confirm `.claude/skills/improve-remote-plan/SKILL.md` exists with valid frontmatter (`name: improve-remote-plan`, `description: ...`). The extension's skill loader reads frontmatter — malformed frontmatter would prevent the skill from being discovered.
2. **Manual smoke test (Linear):** In a workspace with Linear remote control configured, invoke the skill, select a test issue, and verify: (a) the issue description is read correctly, (b) the improved content is written back, (c) the status is updated to the confirmed state, (d) the kanban card advances on next IDE startup (requires the startup reconciler to be deployed).
3. **Table registration check:** Confirm the new row appears in both `CLAUDE.md` and `AGENTS.md` skills tables and renders correctly.

## Research Findings (Web Research Completed)

Both uncertain assumptions from the initial plan have been confirmed via web research:

1. **Linear `issueUpdate` supports combined `description` + `stateId` in a single atomic mutation.** The `IssueUpdateInput` type has both fields as optional — passing both in one `input` object updates them in a single transactional write. This eliminates the two-call race condition. The corrected Write Phase uses a single mutation call.

2. **GraphQL variables eliminate the escaping problem entirely.** Instead of inlining the description content in the query string (which requires double-escaping for JSON-in-GraphQL), the agent passes values via the `"variables"` key in the JSON payload. Only standard JSON escaping is needed (handled automatically by `jq` or any JSON serializer). This is the confirmed best practice.

Additional research-confirmed facts incorporated into the plan:
- Any `issueUpdate` mutation bumps `updatedAt` to the transaction execution time, regardless of which fields changed.
- The `description` field has a 250,000-character maximum.
- The `issueUpdate` mutation accepts both UUIDs and human-readable identifiers (e.g. `"ENG-123"`) as the `id` argument.
- Rate limits: 1,500 requests/hour for personal API keys; a single `issueUpdate` costs 1 complexity point (negligible).

---

## Original Plan Content (Preserved — Superseded by Codebase Findings Above)

> The following is the original plan text, preserved per the content-preservation rule. The **Codebase Findings** section above corrects the assumptions here. Implementers should follow **## Proposed Changes**, not the tasks below.

### 1. Create skill file

**Path:** `.claude/skills/improve-remote-plan/SKILL.md`

**Frontmatter:**
```
---
name: improve-remote-plan
description: Improve a Switchboard plan stored in Linear or Notion — reads, deepens, and writes back via MCP without touching git
---
```

> **CORRECTION:** The description should say "via the LocalApiServer GraphQL proxy" not "via MCP" — agents do not use MCP for Linear operations in this codebase. The skill path is correct.

### 2. Skill instruction content

The skill must orient the agent on the following workflow:

**Pre-flight**
- Confirm Linear or Notion MCP is connected before proceeding
- If neither is available, abort and tell the user to use `/improve-plan` instead (requires local session)
- Use `list_issue_statuses` (Linear) or equivalent Notion query to identify the column-trigger status names before writing — never guess

> **CORRECTION:** There is no `list_issue_statuses` MCP tool. The agent queries Linear's GraphQL API for `teams { states { id name } }` via the proxy. Notion status discovery is not possible with the current agent API surface.

**Read phase**
- Locate the target plan: accept an issue ID/URL directly, or if none provided, query for issues in the "Created" / backlog status within the Switchboard-mapped project
- Read the full issue description (Linear: `get_issue`; Notion: read the page body)
- If description is empty or missing a `## Goal` section, warn the user — the plan may not have been authored yet

> **CORRECTION:** There is no `get_issue` MCP tool. The agent runs a GraphQL `query { issue(id: "...") { ... } }` via `POST /api/linear`. Notion page body reading is not available to agents.

**Improve phase**
Apply the same logic as `/improve-plan`:
- Sharpen and expand the `## Goal` section with problem analysis and root cause if missing
- Identify and document edge cases not covered by the current tasks
- Deepen implementation tasks with specific file paths, method names, and constraints where inferable from the description
- Add or improve `## Edge Cases & Risks` and `## Out of Scope` sections
- Do NOT change the plan's intent or introduce scope the user hasn't approved

**Write phase**
- Write the improved content back to the issue description (Linear: `save_issue`; Notion: update page body)
- Update the issue status to the "Improved" / next-column trigger state as configured in the remote control mapping
- Do NOT move the Linear issue to a status that triggers local execution (e.g. "Coded") unless the user explicitly instructs it — the purpose of this skill is improvement, not dispatch

> **CORRECTION:** There is no `save_issue` MCP tool. The agent runs a GraphQL `mutation { issueUpdate(...) }` via `POST /api/linear`. Notion page body updates are not available to agents. The "next-column trigger state" is not readable by agents (it's in the extension's `LinearSyncService` config) — the user must confirm the target status name.

**Confirmation**
- Report back: issue ID, what was changed (summary), and what status it was set to
- Remind the user that the kanban card will advance on next IDE startup via the reconciler

### 3. Register the skill in CLAUDE.md

Add a row to the `### 📚 Available Skills` table:

```
|| `improve-remote-plan` | Improve a plan stored in Linear/Notion via MCP — reads, deepens, writes back, and advances status without touching git. Use in remote sessions. |
```

> **CORRECTION:** The table row should say "via the LocalApiServer GraphQL proxy" not "via MCP". The row must also be added to `AGENTS.md` (same generated block). The overwrite risk from the generated protocol block is noted in User Review Required Decision 2.

### Original Edge Cases & Risks

- **No MCP connected**: Skill must detect this and abort gracefully with a clear message
- **Multiple Switchboard projects in Linear**: Agent must use `list_projects` to identify the correct one, not assume
- **Status name mismatch**: The "next column" status name must be read from the remote control config, not hardcoded. Incorrect status = silent no-op or wrong column advance
- **Plan has no content yet**: If the issue description is a stub, the skill should warn rather than silently produce a minimal improvement
- **Notion vs Linear branch**: The skill should detect which MCP is available and use the appropriate tool calls — don't assume Linear
- **Reconciler not yet deployed**: If the startup reconciler (see `kanban-startup-reconciler.md`) hasn't been implemented yet, the status update will be written to Linear/Notion but won't advance the kanban card until the user manually moves it. The skill should note this caveat until the reconciler ships.

> **CORRECTIONS:** "No MCP connected" → "LocalApiServer not reachable" (agents use the proxy, not MCP). "Use `list_projects`" → there is no such tool; the agent queries Linear GraphQL directly. "Status name mismatch → read from remote control config" → the config is NOT readable by agents; the user must confirm the target status. "Notion vs Linear branch" → Notion is not implementable with the current agent API; ship Linear-only for v1.

### Original Out of Scope

- Creating new plans from scratch (read-phase requires existing plan content)
- Dispatching local execution (that's a separate status transition the user controls)
- ClickUp support (follow-on)
- Modifying the `/improve-plan` skill (local session variant stays unchanged)

> **ADDITION:** Notion support is also out of scope for v1 (no agent-facing read/write API route exists). A follow-up plan to add a `POST /api/notion` route to `LocalApiServer.ts` is required first.

---

**Recommendation:** Complexity 5 → **Send to Coder**. The skill file is pure documentation (agent instructions with GraphQL templates), and the table registration is a two-line edit in two files. The complexity comes from the Notion gap (a User Review decision) and the status-mapping discovery (a runtime UX flow, not code complexity).

## Review Findings

**Files reviewed:** `.claude/skills/improve-remote-plan/SKILL.md`, `AGENTS.md`, `CLAUDE.md`. **One fix applied:** added `source "$(git rev-parse --show-toplevel)/.agents/skills/_lib/sb_api_call.sh"` instruction to Prerequisites — without it, `sb_api_call` is an undefined shell function and every bash example in the skill fails with "command not found." The `linear_api.md` skill sources this helper; the improve-remote-plan skill was missing the step. Linear-only scoping, single `issueUpdate` mutation with GraphQL variables, user-confirmed status mapping, and 250K char limit are all correct. Registered in both AGENTS.md and CLAUDE.md. **NIT (deferred):** skill lives only in `.claude/skills/`, not in `.agents/skills/` or MIRROR_MANIFEST. **Remaining risk:** the `.agents/` sourcing gap for Antigravity hosts.
