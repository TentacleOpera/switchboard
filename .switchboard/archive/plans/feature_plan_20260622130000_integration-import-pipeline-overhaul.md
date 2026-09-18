# Integration Import Pipeline Overhaul — Fetched Data Loss, Orphaned Cards, Dead Config

## Goal

Make the ClickUp/Linear integration usable by collapsing its over-engineered configuration surface down to **two concrete, opinionated use cases**, each enabled as a one-click preset. The current implementation fetches rich ticket data from provider APIs but discards most of it, produces orphaned Kanban cards with no link back to the source ticket, only syncs in one direction at import time, and requires ~20 manual configuration steps that obscure what the feature is actually for.

The feature is over-engineered, but it is **not** single-purpose. There are two distinct workflows worth supporting, and the current plan must serve both:

> **Use Case 1 — Bug Triage board:** Connect provider → pick a list → enable triage → bugs flow in, get routed to a column agent, results sync back to the ticket.
>
> **Use Case 2 — Remote Control of Switchboard:** Connect Linear → mirror your board's columns to Linear states → from your phone, move a card between states to dispatch its column's agent (the agent your existing automation routing already assigns to that column), and post comments to question/instruct the current column's agent. The agent replies back as a comment. Linear becomes a remote terminal for the agents running on your laptop at home.

Both use cases share the same underlying plumbing (provider-ID linkage, comment capture, tag parsing, status write-back). They differ only in how cards are driven and how comments are handled — so the plan implements the shared plumbing once and layers two presets on top.

### Background: The two use cases

#### Use Case 1 — Bug Triage (lightweight, mostly one-directional)

A bug board workflow for busy product managers:

1. A new bug is posted in ClickUp or Linear.
2. Auto-pull syncs it into the Switchboard Kanban as a card.
3. Kanban automation forwards the card to an agent (e.g., planner agent for review).
4. After processing, the agent's output (status + summary comment) is synced back to the provider ticket.
5. Complex items that need human collaboration are handled in the planning.html Tickets tab instead.

This is NOT a full project management integration. It's a lightweight, automated triage pipeline for routine work.

#### Use Case 2 — Remote Control (bidirectional, conversational)

The high-value case the current integration *technically* enables but never spells out as a usable feature. The scenario: your laptop sits at home running Switchboard with agents wired to your repo; you are out with only your phone and the Linear app.

The control loop is:

1. **You post a task** as a Linear issue (from your phone). Switchboard syncs it in as a card on whichever existing Kanban board(s) you've chosen to sync — there is no special "remote" board.
2. **You move the card between Linear states.** Card moves in Linear drive **column moves in Switchboard** — never the reverse. (Switchboard is deliberately not designed for agents to move their own cards; humans/Linear drive moves.) Landing in a column **dispatches that column's assigned agent**.
3. **The column agent does its work** and posts its output back as a **comment on the Linear issue**.
4. **You post a comment** on the issue to question or instruct the agent. The comment is routed to **whichever agent owns the column the card is currently in**. For example: a comment asking "why this approach?" gets an answered comment back; a comment asking "revise the plan to do X" makes the agent revise the plan and post a confirmation comment.
5. Loop — all from your phone, with Linear comments as the conversation channel and Linear state as the dispatch control.

The plumbing for the *outbound* half (card → comment, status → state) largely exists. The **inbound half — pulling new Linear comments back into Switchboard and routing them to the current column's agent — is the missing piece** that turns this from "technically possible" into a usable feature.

### Problem Analysis

The pipeline is: API fetch → write stub `.md` file → `GlobalPlanWatcherService` detects file → `parsePlanMetadata` extracts metadata → DB insert → card appears on board.

**Three categories of problems block the triage pipeline from working:**

#### A. Cards are orphaned — no round-trip sync possible

The real-time watcher (`GlobalPlanWatcherService._handlePlanFile`, `GlobalPlanWatcherService.ts:497-520`) hardcodes `clickupTaskId: ''` (line 518), `linearIssueId: ''` (line 519), and `sourceType: 'local'` (line 512) for every new plan. This means:

- Cards have **no link back** to the source ticket
- Agents can't update the original bug because the DB doesn't know which ticket the card came from
- Imported cards are indistinguishable from locally-created plans

Making this worse: the Linear stub doesn't even write a `**Linear Issue ID:**` line. The `extractLinearIssueId` function (`PlanFileImporter.ts:235-237`) looks for `> **Linear Issue ID:** <value>` but the stub only writes `> Imported from Linear issue \`ENG-123\`` using the human identifier, not the UUID. So even the batch importer can't extract the Linear ID.

The ClickUp side is slightly better — the stub writes `> **ClickUp Task ID:** abc123` which `extractClickUpTaskId` can find — but the watcher never calls the extraction function.

#### B. Stub files discard useful context

The Linear GraphQL query in `importIssuesFromLinear` (`LinearSyncService.ts:2170-2193`) fetches comments, attachments, estimate, createdAt, project name, cycle, and sub-issues (children) — then throws them all away. Only title, description, URL, priority, state, assignee, labels, dueDate, and parent are written to the stub. *(Note: both batch import and auto-pull use `importIssuesFromLinear` — confirmed via `KanbanProvider.ts:1636` — so comments are available in both paths.)*

For a triage pipeline, **comments are the most valuable data** — they contain the bug report context that an agent needs to assess severity and write a response. Without them, the planner agent sees a title and maybe a description.

Tags are also broken: Linear stubs write `> **Labels:**` but the parser only matches `**Tags:**` (`planMetadataUtils.ts:88`). Result: imported tickets always have empty tags in the DB, which breaks tag-based automation rules.

#### C. Setup is too complex

Enabling the import pipeline currently requires:
- Connecting the provider (API key, team/workspace selection)
- Configuring column-to-state mappings
- Optionally creating labels/tags
- Toggling realtime sync, auto-pull, delete sync, complete sync, exclude backlog (5 checkboxes)
- Manually defining automation rules (name, trigger tag/label, trigger lists/states, target column, final column, write-back toggle — 6 fields per rule)
- Setting up a separate kanban project board
- Configuring custom agents with MCP servers

A product manager who just wants "sync my bugs in" should not need to understand what `completeSyncEnabled` does (especially since it's a no-op — no code reads it). The existing `completeSyncEnabled` flag is persisted, shown in the UI, but never checked by `LinearSyncService.syncPlan()` (`LinearSyncService.ts:1832`) or `ClickUpSyncService.syncPlan()` (`ClickUpSyncService.ts:2424`).

#### D. The remote-control loop has no inbound comment path

This blocks Use Case 2 entirely. Today, comments only move **outward** — captured once at import time into the stub (and even that is incomplete, see B). There is no mechanism that:

- **Polls for new comments** on already-synced Linear issues after import.
- **Routes an inbound comment to the agent that owns the card's current column.** The system has no notion of "the current column's agent should answer this comment."
- **Posts the agent's reply back as a Linear comment** as a first-class action (status write-back exists; conversational comment write-back does not).

Without this, a comment posted from your phone lands in Linear and dies there — the agent never sees it. The card-move → column-move → dispatch half is closer to working (state sync exists), but it is not wired to *dispatch the column agent on arrival*, nor is it presented as a configurable preset.

### Root Cause

The feature was designed as "full ClickUp/Linear automation" but shipped as a half-built superset of two different products: a triage board and a remote-control surface. Neither is finished. The stub writer fetches more than it writes, the watcher extracts less than the stub contains, the configuration surface is too large, there's no guided setup path, and the conversational inbound-comment loop that makes remote control usable was never built. What's needed is two well-defined, one-click presets over shared plumbing — not 20 configuration options and two unfinished workflows.

## Metadata

**Complexity:** 9
**Tags:** backend, frontend, feature, ui, ux, reliability

## User Review Required

**None** — the decisions below are made and baked into Proposed Changes. They are recorded here only as a changelog of resolved calls. (Remote Control does not introduce its own agent assignment — it reuses the existing automation routing, so there's nothing new for the user to configure there.)

**Resolved decisions:**
1. **Triage preset columns** — Use the existing Switchboard kanban column constants (`CREATED` as the import-landing/inbox column → in-progress → `DONE`), not invented `INBOX`/`REVIEWING` names. The earlier draft contradicted itself (`CREATED`/`DONE` in §6 vs `INBOX`/`REVIEWING`/`DONE` in the review section); §6 now uses the real column enum so the routing rule references columns that actually exist.
2. **Triage default automation rule** — Single rule routing the import-landing column (`CREATED`) to the existing **`ticket_updater` role, simplified to do only triage** (NOT the planner — the planner emits full feature plans, the wrong output for a ticket comment), final column `DONE`, `writeBackOnComplete: true`. Reuses the existing role; the role is collapsed from 4 modes to a single behavior: a hard ≤120-word verdict with an `auto` / `needs-human` routing decision, comment-only (posted via §8's host-side `postComment`, reached through the robust `LocalApiServer` bridge), never overwriting the ticket description. See "Repurpose the `ticket_updater` role" in Proposed Changes.
3. **`completeSyncEnabled`** — Wire it up; default ON for new presets, preserve existing config values for current installs (per migration rule). Gates automatic `syncPlan()` on DONE/COMPLETED/ARCHIVED transitions; leaves manual dispatch untouched.
4. **Comment cap (import capture, §2)** — Max 20 most recent comments, 2000 chars each, truncation marker on overflow.
5. **Inbound comment routing target (§7, NEW)** — Comments route to the agent assigned to the card's **current column** (no fixed agent). Self-authored comments are filtered via a hidden marker to prevent feedback loops.
6. **Remote Control is Linear-only (§7–11)** — ClickUp is intentionally excluded from Remote Control (too heavy; wrong audience). Bug Triage (§1–6) stays dual-provider (ClickUp + Linear), ClickUp-leaning. GitHub Issues is the best future second provider (researched: strong data/comment APIs, GA issue types/dependencies; rough edges are the 4-ID Projects v2 card-move mutation and **unverified mobile board control** — see the Future provider note in §7–11) but is not built now.
7. **Remote Control transport: poll only, no webhooks (§7/§9)** — The extension polls the Linear API on a ~60–90s timer; it never receives webhooks. Webhooks would require a public endpoint (tunnel/relay) for a locally-running extension, which defeats the zero-setup goal. Webhooks are explicitly deferred as a future optimization.
8. **Remote Control surface & model (§10)** — Operates on the user's **selected existing board(s)**, not a separate board. Two independent mechanisms: **sync** (boards mirrored with Linear) and **ping** (the active poll loop that adds agent dispatch + comment routing). A **config-only "Remote" tab** in `kanban.html` holds the settings: boards-to-sync, **silent syncing** (stay synced even when ping is off), **ping mode** (Constant vs Manual), and **ping frequency** (30s–2min). No column→agent mapping — dispatch reuses the existing automation routing. A **board-toolbar toggle** next to `#btn-autoban` (reusing the Jules icon `{{ICON_28}}`) starts/stops pinging in Manual mode; on manual start, if silent sync is off, it runs a one-time reconciling sync first. Local and remote interaction are concurrent (work at desk → drive from phone at lunch → return).
9. **Comment posting: host-side `postComment`, agent reaches it via the robust bridge — not direct API from the agent, not MCP (§8/§11)** — `postComment` runs in the extension host (which holds the SecretStorage token), makes the authenticated API call, and stamps the `<!-- switchboard -->` marker. The host calls it inline when host-driven; **agents reach it through the `LocalApiServer` bridge** (`curl localhost/comment`), because a CLI agent has no token and the token must stay in the host (security — no tokens to disk/env). **This plan depends on `feature_plan_20260623120000_localapiserver-bridge-robustness`** to make that bridge reliable; it does NOT abandon the local server (the earlier "direct API, rip out the server" framing was wrong — the server is architecturally required for token isolation). MCP rejected (uneven CLI-agent support; OAuth Linear MCP awkward headlessly).
10. **Sync-mode question directive (§11)** — While a board is under remote control, `agentPromptBuilder` injects a directive into **all** role prompts telling agents to surface user-facing questions as issue comments (via the existing **`linear_api` skill**, which posts through the robust bridge) rather than waiting on terminal input. Gated on remote control being active; normal dispatch is unchanged. No new skill — comment-posting is a capability of `linear_api` (and `clickup_api`), which the agent already reaches for.

## Complexity Audit

### Routine
- Adding `> **Linear Issue ID:** <uuid>` line to Linear stub metaLines (`LinearSyncService.ts:2266-2275`)
- Changing `> **Labels:**` to `> **Tags:**` in Linear stub writer (`LinearSyncService.ts:2273`)
- Adding `kanbanColumn: BACKLOG` directive to stubs for backlog-state items
- Removing dead `kanbanColumn` variable (`LinearSyncService.ts:2258`) by wiring it up

### Complex / Risky
- **Provider ID extraction in watcher (Medium):** Moving `extractClickUpTaskId` / `extractLinearIssueId` to shared utility and calling from `GlobalPlanWatcherService._handlePlanFile`. New `sourceType` logic independent of `automationRuleName`.
- **Comment/attachment writing with truncation (Medium):** New `## Comments` / `## Attachments` sections in Linear stub writer. Must enforce size caps to prevent oversized stubs.
- **Repurpose `ticket_updater` — collapse to a single triage behavior (Medium):** Reuse the existing role rather than registering a new one, and **delete its 4-mode selector** (`comment-only`/`refine-ticket`/`research-and-refine`/`disabled`). Rewrite the `ticket_updater` prompt branch (`agentPromptBuilder.ts:862`) to one behavior, and remove the `ticketUpdateMode` radio group from the addon UI (`sharedDefaults.js:184`). The risk is prompt-design — the ≤120-word verdict contract must be tight, comment-only, never overwriting the description. Migration constraint: the role shipped (it has a `ticketUpdateEnabled → ticketUpdateMode` migration), so keep the `ticketUpdateMode` config key readable (value now ignored) so old configs don't error; update the existing modes test to the single behavior.
- **One-click triage setup (Medium-High):** New "Enable Triage Pipeline" flow that auto-creates a project board, sets sensible defaults, and wires up a default automation rule (dispatching to the simplified `ticket_updater`). Touches `setup.html`, `TaskViewerProvider`, and `KanbanDatabase`.
- **`completeSyncEnabled` wiring (Medium):** Gating `syncPlan()` when target column is DONE/completed. Must distinguish automatic sync (gate it) from manual dispatch (don't gate it).
- **Inbound comment ingestion + routing (High — §7, Linear only, poll-based):** Periodic poll, per-card last-comment cursor, self-comment filtering, and dispatch to the current column's agent. The dispatch-to-column-agent linkage is the riskiest coupling: it reuses the automation dispatch path but is triggered by a comment rather than a card move. Per-card sequential queue needed to avoid concurrent agent runs on one plan.
- **Comment write-back channel (Medium — §8):** Host-side `postComment` (extension holds token) makes the authenticated API call (Linear GraphQL `commentCreate` / ClickUp REST) and stamps the self-marker + truncation. Reached inline by host code, or by agents via the `LocalApiServer` bridge `/comment` route. **Depends on `feature_plan_20260623120000_localapiserver-bridge-robustness`** for transport reliability — do not re-solve it here. Dual-provider; shared by triage (§6), agent replies (§7/§9), sync-mode directive (§11).
- **Sync-mode question directive (Medium — §11):** Inject a directive into all role prompts (gated on remote control active) telling agents to surface user-facing questions as comments via the existing `linear_api` skill (which posts through the robust bridge; token + marker host-side). Touches `agentPromptBuilder.ts` and extends `linear_api`/`clickup_api` with a comment-post capability — no new skill file.
- **State → column dispatch mirror (High — §9, Linear only):** Poll-detected state-change must trigger the same dispatch a manual drag does, while guarding against an echo loop with outbound status write-back (§4). Getting the echo guard wrong causes infinite sync churn.
- **Remote Control surface (Medium-High — §10, Linear only):** A board-toolbar start/stop toggle next to `#btn-autoban` (reusing the Jules icon) plus a config-only "Remote" tab. The real complexity is the **sync-vs-ping separation**: silent-sync ON keeps boards mirrored while ping is off; Manual ping start with silent-sync OFF must run a reconciling sync *before* the ping loop; Constant mode keeps ping always on. Operates on selected existing board(s), reusing the existing column↔state mapping. Local + remote concurrency must not fight (echo guards, §9). Touches `kanban.html` and `KanbanProvider.ts`.

## Edge-Case & Dependency Audit

### Race Conditions
- **Stub write → watcher pickup:** `fs.promises.writeFile` is effectively atomic (write-to-temp + rename on most platforms). No risk of partial reads.
- **Concurrent import + manual edit:** Watcher checks `!plan` for new vs existing. Second fire takes update path, preserving `sourceType`/provider IDs. Safe.
- **Comment feedback loop (§7/§8):** The agent posts a reply comment; the next poll fetches it and would dispatch the agent again, ad infinitum. Mitigated by the hidden `<!-- switchboard -->` marker on all outbound comments — ingestion skips any comment containing it. The marker must survive Linear's markdown rendering (HTML comments are preserved by the Linear comment API; verify during implementation).
- **State sync echo loop (§9):** A local drag pushes a state change out (§4); the next poll then reports that state as "changed" and would re-apply it as a column move + dispatch. Mitigated by recording the last-pushed state per card and skipping inbound moves that match a state we just wrote.
- **Comment arrives mid-dispatch (§7):** Per-card sequential queue; a comment landing while the column agent is still running is enqueued, not dropped or run in parallel.

### Security
- **Comment body injection:** Linear comments are arbitrary external markdown. Writing them to stub is no new attack surface — plan parser only extracts structured metadata from specific patterns; freeform content is ignored.

### Side Effects
- **Stub file size increase:** Comments/attachments make stubs larger. Hard cap (20 comments, 2000 chars) limits this to ~50KB worst case.
- **`completeSyncEnabled` behavioral change for ClickUp:** ClickUp's config loader currently coerces `undefined` → `false`. Wiring up the flag without migrating would silently suppress DONE-column syncs for existing users who never touched the checkbox. **Resolution:** migrate `undefined` → `true` in the config loader to preserve the effective unconditional-sync behavior. New presets explicitly set `true`. See §4 migration note.
- **`ticket_updater` mode collapse — silent behavior change:** Users who configured `refine-ticket` or `research-and-refine` modes lose that behavior. Mitigated by a one-time console warning on load (see "Repurpose the `ticket_updater` role" — behavioral change warning). Not a UI dialog (per the no-confirm-dialogs rule).
- **In-memory queue volatility (§7):** Extension reload mid-queue loses queued comments. Mitigated by not advancing the `lastSyncedCommentAt` cursor until dispatch completes — the next poll re-fetches the lost comment. Accepted as a v1 limitation.
- **Echo-guard TTL expiry (§9):** If the extension is offline longer than the echo-guard TTL (5 min), the first poll after restart may echo a locally-pushed state change as a redundant dispatch. Self-correcting (no infinite loop). Accepted as a rare edge case.

### Dependencies & Conflicts
- `extractClickUpTaskId` / `extractLinearIssueId` are module-private in `PlanFileImporter.ts`. Must export or move to `planMetadataUtils.ts`.
- `ALLOWED_TAGS` in `planMetadataUtils.ts` (21 curated tags) will filter out most custom Linear labels. This is intentional — labels stay visible in the plan markdown.
- Existing ticket sync in `planning.html` (via `ContinuousSyncService`) handles bidirectional content sync. The triage pipeline should piggyback on this rather than building a parallel path.

## Dependencies

- **Blocking for all agent-side comment posting: `feature_plan_20260623120000_localapiserver-bridge-robustness`.** Triage write-back (§6), agent replies (§7/§9), and the sync-mode question directive (§11) all post through the `LocalApiServer` bridge (agent → host → SecretStorage token → provider API). That bridge is "almost always down" today; the bridge-robustness plan makes it reliable (health-gated discovery + retry + workspace-identity). The comment-posting features here are only as dependable as that bridge — sequence the bridge plan first, or land them together. This plan adds the host `/comment` route + `postComment` and a comment-posting capability in the existing `linear_api`/`clickup_api` skills (no new skill file); it does **not** re-solve transport.
- Host-driven posting paths (where the extension itself calls `postComment`) do not need the bridge — only agent-initiated posts do.
- Decision on `completeSyncEnabled` (wire up vs. remove) should be made before implementation. (Resolved: wire up, default ON; migrate existing `undefined` → `true` for ClickUp to preserve effective behavior.)
- **DB schema migration for `lastSyncedCommentAt` (§7):** Adding a `lastSyncedCommentAt TEXT` column to the plans table is a non-destructive additive migration via `ensureReady()` schema-version bump. Must be implemented before the inbound comment poll can work. This is a self-contained migration within this plan — no external dependency.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the two loop-closing mechanisms in Remote Control — inbound comment ingestion → column-agent dispatch (§7) and state→column dispatch mirror (§9) — create cycles that can cause runaway agent runs or infinite sync churn if guards fail; (2) the self-comment marker (`<!-- switchboard -->`) is load-bearing and unverified against Linear's markdown renderer — a fallback text-prefix marker is specified; (3) the `completeSyncEnabled` ClickUp default and `ticket_updater` mode collapse are silent behavioral changes for existing ~4,000 installs — mitigated by config migration (`undefined` → `true`) and a one-time console warning; (4) the `lastSyncedCommentAt` DB column requires a schema migration on a shipped extension. Mitigations: self-marker + fallback, per-card echo guard with TTL, per-card sequential queue with cursor-not-advanced-until-dispatch, DB schema migration via `ensureReady()`, config migration for `completeSyncEnabled`, and console warning for `ticketUpdateMode` override.

The triage one-click setup (§6) creates opinionated defaults (board, columns, automation rule routing to the simplified `ticket_updater`) that may not fit every team. Mitigation: everything is editable after creation, framed as a starting point. Remote Control (§10) adds no agent config of its own — it reuses existing automation routing — so there's less to get wrong.

The provider-ID extraction coupling (stub format ↔ extraction logic across 3 files) is mitigated by moving parsers to a shared utility. The `completeSyncEnabled` wiring for ClickUp is a silent behavioral change — mitigated by defaulting to ON for new setups and preserving existing config values per the migration rule.

## Proposed Changes

The changes split into **shared plumbing** (§1–5, needed by both use cases) and **two presets** layered on top (§6 Bug Triage, §7–11 Remote Control). Implement the plumbing first; the presets are thin orchestration over it.

### Shared plumbing (§1–5)

### 1. Fix provider ID linkage (make round-trip sync possible)

**Why this matters:** Without provider IDs in the DB, the triage pipeline can't push results back to ClickUp/Linear. This is the #1 blocker.

#### `src/services/LinearSyncService.ts` (stub writer, lines 2266-2275)
- Add `> **Linear Issue ID:** ${issue.id}` to the `metaLines` array after the `Imported from` line. Uses the UUID (`issue.id`), not the human identifier (`issue.identifier`).

#### `src/services/planMetadataUtils.ts` (shared utility)
- Move `extractClickUpTaskId`, `extractLinearIssueId`, and `extractEmbeddedMetadata` from `PlanFileImporter.ts` to here. Export them.
- Update `PlanFileImporter.ts` to import from `planMetadataUtils` instead of defining locally.

#### `src/services/GlobalPlanWatcherService.ts` (`_handlePlanFile`, lines 497-520)
- After reading file content (line 488), call `extractClickUpTaskId(content)` and `extractLinearIssueId(content)`.
- Set `sourceType` based on provider ID presence:
  - ClickUp ID only → `'clickup-import'`
  - Linear ID only → `'linear-import'`
  - Both (edge case) → `'local'`, clear both IDs
  - Neither → `'local'` (existing behavior, no change for local plans)
- Replace hardcoded `clickupTaskId: ''` / `linearIssueId: ''` / `sourceType: 'local'` in the `newRecord` with the extracted values.

### 2. Write comments and attachments to Linear stubs

**Why this matters:** Comments are the bug report context that agents need for triage. Without them, the planner agent sees only a title and description.

#### `src/services/LinearSyncService.ts` (stub assembly, lines 2277+)
- After the description, append `## Comments` section (max 20 most recent, max 2000 chars per body, truncated with `*[truncated]*` marker). The rich query at lines 2170-2193 already fetches `comments { nodes { body user { name } createdAt } }` — this data is available but currently discarded.
- After comments, append `## Attachments` section (list of `[title](url)` links).
- Empty sections are omitted entirely.

### 3. Fix tag parsing for Linear imports

**Why this matters:** Tags drive automation rules. Broken tag parsing means tag-based triage rules never match imported Linear tickets.

#### `src/services/LinearSyncService.ts` (line 2273)
- Change `> **Labels:** ${labels}` to `> **Tags:** ${labels}`.
- Tags will pass through `sanitizeTags` on the DB side — only `ALLOWED_TAGS` values survive. Custom Linear labels are preserved in the plan file markdown but filtered from the DB tag field. This is intentional.

### 4. Wire up `completeSyncEnabled`

**Why this matters:** The UI checkbox promises "sync completed status" but does nothing. Users who uncheck it expect DONE-column moves to NOT push state changes to the provider.

#### `src/services/LinearSyncService.ts` (`syncPlan()`, line 1832)
- After resolving `stateId` from column mapping, check: if `config.completeSyncEnabled === false` and `newColumn` is `DONE`/`COMPLETED`/`ARCHIVED` → skip the sync with a log message.

#### `src/services/ClickUpSyncService.ts` (`syncPlan()`, line 2424)
- Same pattern: if `config.completeSyncEnabled === false` and `plan.kanbanColumn` is `DONE`/`COMPLETED`/`ARCHIVED` → return early with `skippedReason`.

- **Leave manual dispatch (`changeTicketStatus`, `updateIssueState`) untouched** — those are explicit user actions that should always work.

- **Migration (ClickUp default):** Existing ClickUp installs with `completeSyncEnabled` undefined or absent must be migrated to `true` to preserve the *effective* behavior (sync was unconditional before; wiring up the flag with a `false` default would silently suppress DONE-column syncs for existing users who never touched the checkbox). New presets explicitly set `true`. The config loader (`ClickUpSyncService.ts:295`, `raw.completeSyncEnabled === true`) currently coerces undefined → `false`; change this to coerce undefined → `true` for the migration, or add an explicit migration step in `loadConfig()`.

### 5. Wire up `kanbanColumn` directive in stubs

**Why this matters:** When `excludeBacklog` is OFF and backlog items are imported, they should land in the BACKLOG column, not CREATED.

#### `src/services/LinearSyncService.ts` (line 2258)
- Keep the existing `kanbanColumn` variable (no longer dead code).
- Add `kanbanColumn: ${kanbanColumn}` line to the stub, after the title and before the metadata block.
- The parser at `planMetadataUtils.ts:57` already matches `kanbanColumn[:\s]+(\w+)`.

#### `src/services/ClickUpSyncService.ts` (stub writer area, after line 2485+)
- Add equivalent: `const kanbanColumn = statusName === 'backlog' ? 'BACKLOG' : 'CREATED';`
- Add `kanbanColumn: ${kanbanColumn}` to the ClickUp stub.

### Preset 1 — Bug Triage (§6)

### Repurpose the `ticket_updater` role: make it do one thing — triage

**Why this matters:** The triage preset must NOT dispatch to the **planner** agent (`agentPromptBuilder.ts:456`), which emits full multi-section feature plans — a wall of planning ceremony posted onto the ticket. The existing **`ticket_updater`** role already has every surface wired (UI, prompt branch), so we reuse it — but we **simplify it down to a single behavior** instead of leaving it as a 4-mode relic, and we point its write-back at §8's host-side `postComment` (reached via the robust `LocalApiServer` bridge) instead of the brittle discover-and-curl the skill uses today.

**Current state of `ticket_updater` (the over-engineered relic):** it has a `ticketUpdateMode` selector with four modes — `disabled | comment-only | refine-ticket | research-and-refine` — that variously generate a ~500-word plan analysis, post it as an "AI Analysis" comment, **overwrite the ticket description**, or web-research first. This is exactly the over-engineering this overhaul targets: too many options, and most of them do the wrong thing (nobody wants an agent silently rewriting their ticket descriptions).

**The change — collapse the modes; the agent only triages:**

#### `src/services/agentPromptBuilder.ts` (the `ticket_updater` branch, line 862)
- Replace the entire mode-switch (the `comment-only` / `refine-ticket` / `research-and-refine` / `disabled` arms and the verbose `analysisTemplate()`) with **one** behavior. It reads the imported ticket (title, description, captured comments from the stub §2) and emits a single short comment, target ≤ ~120 words, fixed shape:
  - **Severity:** blocker / high / normal / low
  - **Area:** one or two tags
  - **Assessment:** 1–2 sentence root-cause hypothesis or restatement of the real problem
  - **Recommended action:** the concrete next step
  - **Routing:** `auto` (simple enough to action directly) **or** `needs-human` (complex/ambiguous/cross-cutting → move to the planning.html Tickets tab)
- Behavioral rules baked in: no preamble, no restating the whole ticket, no markdown section dumps, no speculative implementation detail, **never overwrite the ticket description** — comment only.
- Post the verdict via the shared **host-side `postComment` primitive (§8)**, reached through the robust `LocalApiServer` bridge (per the bridge-robustness plan) — not the brittle current skill transport. Resolve the provider ID from the stub fields (`**ClickUp Task ID:**` / `**Linear Issue ID:**`) so triage uses the same linkage as §1, not the legacy `**Ticket:**` field.

#### Remove the mode selector from the UI
- Drop the `ticketUpdateMode` radio group from the addon UI (`sharedDefaults.js:184`) — there's nothing left to choose.
- **Migration (the role shipped):** keep the `ticketUpdateMode` config key readable so old stored configs don't error (it has a `ticketUpdateEnabled → ticketUpdateMode` migration — see `agent-prompt-builder-ticket-updater-modes.test.js`); the value is simply ignored now since the agent always triages. Update/adjust that test to the single behavior.
- **Behavioral change warning:** Users who configured `ticketUpdateMode: 'refine-ticket'` or `'research-and-refine'` (modes that rewrote ticket descriptions) will silently lose that behavior. On first load when `ticketUpdateMode` is present and not `'disabled'`/`'comment-only'`, log a one-time console warning: `"[Switchboard] ticketUpdateMode '${mode}' is no longer supported — the ticket_updater role now always performs triage-only verdicts."` This is not a UI dialog (per the no-confirm-dialogs rule); it's a diagnostic log so users investigating changed behavior can find the cause.

#### `src/webview/kanban.html` (description map, line 3088)
- Update the `ticket_updater` description entry (currently `'Synchronizes plan state and comments back to connected project management systems (e.g. ClickUp/Linear).'`) to: *"Reads a ticket and posts a short triage verdict (severity, area, recommended action, auto/needs-human) back to ClickUp/Linear."* Optionally relabel the visible name to "Ticket Triager" — but keep the `ticket_updater` role id and config keys unchanged for migration.

#### Relationship to Remote Control
- This (now single-purpose) `ticket_updater` is the natural **default agent for the inbox/early column** in Remote Control (§10.3), since a freshly-posted issue wants triage before deeper work.

### 6. One-click triage pipeline setup (NEW)

**Why this matters:** This is the core UX improvement for Use Case 1. A product manager should enable the triage pipeline in one click, not 20 configuration steps.

#### `src/webview/setup.html`
- Add a prominent "Enable Triage Pipeline" button/toggle in both ClickUp and Linear setup sections, after the provider is connected and a list/project is selected.
- When clicked, the button sends a single message to the backend that triggers the full setup (see below).

#### `src/services/TaskViewerProvider.ts` (or `KanbanProvider.ts`)
- Handle the `enableTriagePipeline` message:
  1. **Auto-create a project board** via `KanbanDatabase.setProjectForPlans()` named after the selected ClickUp list / Linear project (e.g., "Bug Triage — [list name]").
  2. **Set sensible defaults:**
     - `realTimeSyncEnabled: true`
     - `autoPullEnabled: true`
     - `pullIntervalMinutes: 15`
     - `completeSyncEnabled: true`
     - `excludeBacklog: true` (Linear) / `false` (ClickUp — redundant with list selection)
     - `deleteSyncEnabled: false`
  3. **Create a default automation rule:**
     - Name: `"Triage — [list/project name]"`
     - Trigger: all imported tickets (based on provider-specific trigger — tag for ClickUp, label for Linear)
     - Target column: `CREATED` (inbox)
     - **Dispatch agent: the simplified `ticket_updater` (triage-only, NOT planner)** — see "Repurpose the `ticket_updater` role" above.
     - Final column: `DONE`
     - `writeBackOnComplete: true` (posts the triage verdict back as a ticket comment via §8)
  4. **Assign all imported plans** from that list/project to the new project board.
  5. Return success to the UI, which shows a confirmation with the project board name.

#### Design notes
- The one-click setup doesn't replace the existing detailed configuration — it's a fast-path that sets up the common case. Users can still manually configure everything via the existing setup UI.
- The auto-created project board and automation rule are fully editable after creation.
- The setup button is only enabled after a provider is connected and a list/project is selected.

### Preset 2 — Remote Control (§7–11) — **Linear only**

This preset turns Linear into a remote terminal for the agents on your machine. It reuses the shared plumbing (provider IDs, status write-back, comment capture) and adds the **inbound comment loop** and a **state↔column dispatch mirror**.

**Scope decision: Remote Control is Linear-only.** ClickUp is intentionally *not* supported for this feature — it's too heavy for the lightweight phone-driven workflow, and the audience for remote agent control overwhelmingly uses Linear (or GitHub; see below). Linear's clean per-team workflow-state model maps 1:1 onto kanban columns. (The Bug Triage preset, §1–6, remains dual-provider — ClickUp + Linear — since triage is a different, ClickUp-leaning audience.)

**Future provider note (GitHub Issues) — researched against GitHub's mid-2026 state, not built now.** The audience already lives on GitHub and issues sit next to the code, so it's the strongest future second provider. Verified findings:
- **Strong on data + comments.** Issue types, sub-issues, and issue dependencies are all GA (and `gh` CLI-manageable as of the 2026-06-10 changelog). The comment loop is clean: a repo-wide comments list endpoint with a `since` (ISO-8601) filter for cheap incremental polling, and a single REST `POST` to reply. Authenticated rate limits (5,000/hr REST, 5,000 pts/hr GraphQL) comfortably absorb a 60–90s poll — but note the **content-creation cap of 80 comments/min, 500/hr** bounds reply volume.
- **Rough edge 1 — card moves.** Moving a card = updating a Projects v2 single-select **status field via the `updateProjectV2ItemFieldValue` GraphQL mutation**, which needs four resolved node IDs (project / item / field / target option). Workable but more plumbing than Linear's first-class workflow states; cache the project/field/option IDs to keep per-move cost down.
- **Rough edge 2 (load-bearing, UNVERIFIED) — mobile board control.** Research could **not confirm** whether the GitHub Mobile app can change an issue's Project v2 status / drag a board card from a phone in 2026. Since "drive it from your phone" is the whole premise, this must be validated before committing to GitHub as a provider. (GitHub's newest Issues surfaces — e.g. custom "Issue fields" — notably still lack mobile support, so skepticism is warranted.)
- **Overlap to watch.** GitHub's own Copilot coding agent can already be assigned to issues, which partially overlaps this feature's "card-move dispatches an agent" model.

Keep the dispatch/comment abstractions in §7–9 from hard-coding Linear specifics where cheap, to keep this door open.

**Mobile premise (verified, 2026).** The feature assumes you can drive Linear from a phone. Confirmed against primary Linear sources: the mobile app supports **changing an issue's workflow state** (tap the status icon in the issue list) and **posting/threaded-replying to comments** — the two load-bearing actions for Channels A and B. Caveat: the Linear mobile app has **no offline support** and some reliability gaps on poor connections, so the loop assumes connectivity. Note also Linear's own native "Linear Agent" (2026-03-24) lets you `@Linear` in mobile comments — adjacent to this feature but not conflicting (ours routes to the user's own repo agents).

**Transport: polling only.** The inbound loop (§7, §9) is driven by a periodic poll of the Linear API — **no webhooks**. A locally-running extension can't receive webhooks without a public endpoint (tunnel/relay), and that infrastructure entirely defeats the one-click, no-setup goal of this feature. Polling needs zero inbound networking: the extension reaches *out* to Linear on a timer. Default poll interval ~60–90s (snappy enough for a phone conversation, well within Linear's rate limits). Webhooks are explicitly deferred as a possible future optimization, not part of this plan.

### 7. Inbound comment ingestion + routing to the current column's agent (NEW — core of Use Case 2, Linear only)

**Why this matters:** This is the missing half of the loop. Without it, a comment you post from your phone never reaches the agent. This is the single most important new capability in the plan.

#### `src/services/LinearSyncService.ts` — comment poll
- On a periodic timer (interval from the Remote tab, ~60–90s default), for each Linear-synced card on the Kanban, fetch comments **created after the last-seen timestamp** for that card and process new ones. No webhooks — the extension polls Linear outbound.
- Track a per-card `lastSyncedCommentAt` (or last comment ID) in the DB so the same comment is never processed twice across poll cycles. Store on the plan record / `config` table — **not** a fictional state.json (see project rule).
- **DB schema migration (shipped extension, ~4,000 installs):** The plans table does not currently have a `lastSyncedCommentAt` column. Add it via `ALTER TABLE plans ADD COLUMN lastSyncedCommentAt TEXT` in the `ensureReady()` schema-version upgrade path (the same pattern used for prior column additions). Default to `NULL` (meaning "never polled — fetch all comments on first poll"). Bump the schema version and run the migration idempotently. This is a non-destructive additive migration — existing rows are unaffected.
- Ignore comments authored by Switchboard itself (tag outbound comments with a hidden marker, e.g. a trailing `<!-- switchboard -->` HTML comment, and skip any inbound comment containing it) to prevent self-feedback loops.
- **Self-marker fallback:** The `<!-- switchboard -->` HTML comment is the primary marker, but its survival through Linear's markdown renderer is unverified. If implementation testing shows Linear strips HTML comments, fall back to a short text prefix marker (e.g., `[sb]` at the start of the comment body) that survives markdown rendering. The ingestion filter checks for either marker. Do not ship the feedback loop without verifying the marker survives.
- Only poll while remote control is **started** (the board-toolbar toggle, §10) — not continuously. Stopping the toggle pauses the poll, bounding API usage and controlling when agents are phone-reachable.
- **Per-poll card cap:** To bound API usage, cap the number of cards polled per cycle at 100. Cards beyond the cap are deferred to the next cycle (ordered by most-recent activity). At 60s intervals with 100 cards, that's ~100 comment-fetch calls/min — well within Linear's 1,500 req/min team-plan limit. Document the scaling ceiling: users syncing >100 active cards will see increased poll latency, not failures.

#### Routing: comment → current column's agent
- On a new inbound comment, look up the card's **current kanban column** and the **agent assigned to that column** (the same per-column agent the automation rules dispatch to).
- Dispatch the comment text to that agent as an instruction, in the card's existing plan context — the agent decides whether it's a question (answer it) or a revision request (revise the plan, then confirm).
- If the column has no assigned agent, the comment (or move) simply triggers nothing — exactly like a manual move on a Switchboard board with no agent on that column today. No special-case handling, no explanatory comment back.

#### Concurrency / ordering
- Process inbound comments for a card sequentially (queue per card) so a rapid-fire "do X" then "actually do Y" can't run two agents on the same plan simultaneously.
- A comment that arrives while the column agent is still working is queued, not dropped.
- **Known limitation — queue is in-memory and volatile:** If the extension reloads (window reload, sleep/wake, crash) while a comment is queued or an agent is mid-run, the queued comment is lost. This is accepted as a v1 limitation; the companion bridge-robustness plan addresses reload resilience for the transport layer, and queue persistence can be added as a follow-up (e.g., persisting the queue to the DB and replaying on startup). The `lastSyncedCommentAt` cursor ensures the *next* poll cycle will re-fetch the lost comment if it hasn't been marked as processed — so the comment is delayed, not permanently lost, as long as the cursor wasn't advanced past it. **Do not advance the cursor until the comment has been dispatched (or explicitly skipped), not when it's merely fetched.**

### 8. Agent reply → ticket comment write-back (NEW — shared primitive)

**Why this matters:** The agent's answer has to get back to your phone (Remote Control) or onto the bug ticket (Triage). Status write-back exists; conversational comment write-back does not.

**Provider scope:** `postComment` is **dual-provider** because Triage (§6) writes verdicts back to both ClickUp and Linear. The *conversational inbound loop* that consumes replies (§7/§9) is Linear-only — but the outbound comment primitive itself is shared, so build it for both providers.

#### `src/services/LinearSyncService.ts` (and ClickUp equivalent — for triage write-back)
- Add a `postComment(providerId, body)` **host-side primitive** in the extension. It runs in the extension-host process (which holds the SecretStorage token), makes the authenticated provider API call (Linear GraphQL `commentCreate`; ClickUp REST `POST .../comment`) using the same API client `LinearSyncService` already uses for sync, and appends the `<!-- switchboard -->` marker itself. It is the **shared write-back primitive** used by triage (§6), agent replies (§7/§9), and the sync-mode question directive (§11).
- **Clarification — shared interface, dual implementation:** `postComment` is a common interface over two fundamentally different API shapes (Linear GraphQL vs ClickUp REST have different signatures, error shapes, rate limits, and comment body formats). The "shared primitive" is a thin abstraction — the Linear and ClickUp implementations are separate code paths behind a common function signature. Do not attempt to share API-client code between the two providers; share only the marker-stamping, truncation, and bridge-route logic.
- **Two invocation paths — the agent never calls the provider API directly:**
  - **Host-driven:** extension code calls `postComment` inline (e.g. when the poll/sync logic itself needs to post).
  - **Agent-driven:** the agent reaches `postComment` through the **`LocalApiServer` bridge** (agent → `curl localhost:<port>/comment` → host runs `postComment`). A CLI agent has no SecretStorage access and must not — the token stays in the host. This is the architecturally required path for any agent-initiated comment (triage verdict, §11 questions, §7 replies).
- **Dependency — does NOT re-solve transport.** The agent→host bridge's reliability is owned by the companion plan **`feature_plan_20260623120000_localapiserver-bridge-robustness`** (health-gated discovery + retry + workspace-identity). This plan only adds a host route (e.g. `/comment`) that invokes `postComment`; it relies on the bridge plan to make that route reachable. **Do not "abandon the local server" — it is necessary** (token isolation); the bridge plan is what makes it dependable.
- The marker + truncation live in `postComment` (host-side), **never** the agent — so an agent can't break the feedback-loop guard, and the ingestion poller skips the comment. (Marker home moved here from the skill, since the host is where both the token and the call live.)
- Truncate to the provider's comment size limit; if the agent output exceeds it, post a head + "*[truncated — see plan file]*" tail.
- The triage write-back (§6) and the agent's verdict comment use this same primitive — build it once and share it.

### 9. Card-move dispatch mirror — Linear state → Switchboard column → column agent (NEW, Linear only)

**Why this matters:** Moving a card in Linear must move it in Switchboard *and* dispatch the destination column's agent. Switchboard never moves its own cards; the move is always driven from Linear (or by the human at the board).

#### `src/services/LinearSyncService.ts` — inbound state sync (same poll as §7)
- On the same poll cycle, detect when a synced issue's **state has changed** since last seen and the new state maps to a different Switchboard column (via the existing column↔state mapping that Remote Control reuses, §10).
- Apply the column move to the card, then **trigger the destination column's automation/agent dispatch** — the same dispatch path a manual board drag triggers, so behavior is identical whether the move came from Linear or from a drag.
- This is one-directional inbound (Linear → Switchboard) for *moves*. Outbound status write-back (§4) still handles Switchboard → Linear when a human drags the card locally; guard against an echo loop (don't re-apply a state we just pushed, and don't re-push a state we just pulled — track last-applied / last-pushed state per card).
- **Echo-guard state persistence:** The last-applied / last-pushed state per card must survive extension reloads, or the first poll after a reload will echo a locally-pushed state change back as a phantom inbound move. Store this as an in-memory `Map<planId, { lastPushedState, lastAppliedState, timestamp }>` with a short TTL (e.g., 5 minutes) — long enough to bridge a typical reload gap but short enough to avoid stale guards blocking legitimate remote moves after a long offline period. The companion bridge-robustness plan's reload-recovery window is the reference for the TTL. If the TTL expires before the next poll, the guard is dropped and the first poll may echo once — this is accepted as a rare, self-correcting edge case (the echo causes a redundant dispatch, not an infinite loop, because the second poll sees no further state change). An alternative is a DB-persisted guard column, but the TTL approach avoids another schema migration for a rare edge case.

### 10. Remote Control: a board-toolbar toggle + a config tab (NEW)

**Why this matters:** Remote control layers **two independent things** onto the existing Kanban, and conflating them is the main design trap:
- **Sync** — selected Switchboard board(s) ↔ Linear kept in agreement (cards present in both, state/content mirrored). Builds on the existing continuous sync.
- **Ping (poll)** — the active remote-control loop: pull Linear state changes → move the card → dispatch the destination column's agent (§9); pull new comments → route to the current column's agent → reply (§7). **Ping = sync *plus* agent interaction.**

Keeping them separate is what lets a board stay mirrored to Linear without being actively remote-controlled, and lets local desk work and phone-driven remote control run at the same time.

#### Config — new **"Remote" tab in `kanban.html`** (NOT `setup.html`), config-only, no card list
Add a `shared-tab-btn` (label "REMOTE") + `shared-tab-content` panel, following the AGENTS/AUTOMATION tab pattern. Settings:
1. **Boards to sync** — choose which Switchboard board(s) participate in Linear sync (multiple allowed). This is the initial sync target.
2. **Silent syncing** (on/off) — when **ON**, the selected boards stay synced with Linear *even while pinging is off*. When **OFF**, the boards are only reconciled with Linear at ping start (see toolbar button below).
3. **Ping mode** — **Constant** (pinging is always on; the toolbar button stays permanently active) or **Manual** (pinging runs only while the toolbar button is toggled on).
4. **Ping frequency** — user-selectable from **30s up to 2 min**.
*(No column→agent mapping here.* Which agent a column dispatches to — and therefore which agent answers a comment landing on that column — is already defined by the **existing automation routing** (the AGENTS-tab routing / automation rules). Remote Control reuses it rather than adding a parallel mapping.)*

#### Board toolbar toggle — `#btn-remote-control` next to `#btn-autoban`, Jules icon
- Add a toggle button **next to `#btn-autoban`** (the existing "Start or stop the automation engine" button, `ICON_22`, strip near `kanban.html:2415`). Give it `id="btn-remote-control"`, tooltip *"Start or stop remote control"*. **This is where the Jules icon goes** — the `{{ICON_28}}` token (`ICON_JULES`, `kanban.html:3778`); reusing it ships zero new assets.
- **Manual ping mode:** the button starts/stops pinging. On **start**, if **silent sync is OFF**, first run a one-time **full sync with Linear** (the board wasn't kept in agreement while ping was off, so reconcile first), *then* begin the ping loop.
- **Constant ping mode:** the button shows permanently active; no manual press needed (pinging runs whenever remote control is configured).
- Active/idle state and a live "last ping / next ping" indicator mirror the autoban button's running-state + timer indicators (`#btn-pause-autoban-timer` etc.).

#### Concurrency — local + remote at the same time
- Manual board interaction (local card drags) and remote interaction (moving cards in Linear) are **both active simultaneously** — no mode switch. Expected workflow: work at your desk, then go to lunch and drive the same board from Linear on your phone, then return. The echo guards (§9: last-applied / last-pushed state per card) keep local drags and inbound Linear moves from fighting.

#### `src/services/KanbanProvider.ts` — backend
- `getRemoteConfig` / `setRemoteConfig {boards, silentSync, pingMode, pingFrequencySeconds}` → persist to the DB `config` table (not state.json). No column→agent map — dispatch reuses existing automation routing.
- `startRemoteControl` (manual mode): if `silentSync` is off, run the reconciling full sync first, then start the ping loop (§7/§9) at `pingFrequencySeconds`.
- `stopRemoteControl`: stop the ping loop; **sync continues iff `silentSync` is on**, otherwise the board stops reconciling until the next start.
- Constant mode: the ping loop auto-starts and stays on whenever remote control is configured.

#### Design notes
- No separate board — operates on the user's selected existing board(s); reuses the existing column↔state sync mapping rather than defining a parallel one.
- Zero infrastructure: pinging is outbound polling on a timer; nothing to expose, tunnel, or host.
- Manual start/stop (the default ping mode) deliberately mirrors the automation-engine button, so the user controls when their agents are reachable from the phone.

### 11. Sync-mode prompt directive — route user-facing questions to comments (NEW)

**Why this matters:** In remote/sync mode the user is on their phone, not at the terminal. If an agent stops to ask a question the normal way (printing it to the terminal and waiting), the user never sees it and the loop stalls. So while a board is under remote control, **every** dispatched agent — not just triage — must surface user-facing questions as comments on the linked issue.

#### `src/services/agentPromptBuilder.ts` — inject a directive in sync mode
- When the card being dispatched belongs to a board with **remote control active** (sync/ping on), inject a directive into the built prompt for **all roles** (planner, coder, lead, reviewer, triage, …), e.g.:
  > *"You are running in remote mode — the user is not at the terminal. If you need to ask the user anything or report a blocker, post it as a comment on the linked issue using the `linear_api` skill; do not wait on terminal input. Continue with any work you can do without the answer."*
- **Gating:** only injected when remote control is active for that card's board. Normal (non-remote) dispatch is unchanged — questions go to the terminal as today.
- This composes with each role's existing prompt; it does not replace role behavior, it just redirects the question channel.

#### How the agent posts — the existing `linear_api` skill, through the robust LocalApiServer bridge (token + marker stay host-side)
- Comment-posting is a capability of the existing **`linear_api` skill** (and `clickup_api` for ClickUp triage), not a new skill — the agent already knows to reach for `linear_api` when it needs to touch Linear. The skill reaches the **host `/comment` route through the `LocalApiServer` bridge** — it does **not** make a direct API call (a CLI agent has no SecretStorage token) and does **not** use MCP. The host route runs §8's `postComment`, which holds the token and stamps the marker.
- **This relies on the bridge being reliable**, owned by the companion plan `feature_plan_20260623120000_localapiserver-bridge-robustness` (health-gated discovery, retry across reload gaps, workspace-identity). `linear_api` is already one of the 9 skills that plan hardens via the `sb_api_call` helper, so the comment-post capability inherits that robustness for free.
- The agent resolves the issue ID from the plan/card metadata and passes it + the body to the skill; it never constructs API calls, handles tokens, or touches the marker — so it can't break the feedback-loop guard (§7) or hit the unreliable-server problem (once the bridge plan lands).
- Because the marker is applied host-side, the agent's question comment is skipped by the ingestion poller; your reply (a fresh, unmarked comment) is what the next ping picks up and feeds back to the agent (§7) — closing the conversation loop.

## Verification Plan

### Automated Tests

> **SKIP COMPILATION:** Do NOT run `npm run compile` or any project compilation step.
>
> **SKIP TESTS:** Do NOT run automated tests. The test suite will be run separately by the user.

**Recommended tests to add (for the user to run later):**

1. **Provider ID extraction:** Verify `GlobalPlanWatcherService._handlePlanFile` extracts `clickupTaskId` / `linearIssueId` from stub content and sets correct `sourceType`.
2. **Linear Issue ID in stubs:** Verify Linear stubs include `> **Linear Issue ID:** <uuid>` with the UUID, not the identifier.
3. **Comments in stubs:** Verify truncation (>20 comments → last 20; >2000 chars → truncated). Verify empty comments produce no section.
4. **Tag parsing:** Verify Linear stubs use `**Tags:**`. Verify `sanitizeTags` filters non-ALLOWED labels.
5. **`completeSyncEnabled` gating:** Verify `syncPlan()` skips DONE-column sync when flag is false. Verify manual `changeTicketStatus` is unaffected.
6. **`kanbanColumn` directive:** Verify backlog-state items get `kanbanColumn: BACKLOG` in stubs and land in BACKLOG column on the board.
7. **One-click triage setup:** Verify "Enable Triage Pipeline" creates project board, sets defaults, and creates automation rule.
8. **Inbound comment routing (§7, Linear):** Verify a new comment found by the poll is routed to the agent of the card's current column and processed exactly once across poll cycles (last-comment cursor). Verify a comment containing the self-marker (both `<!-- switchboard -->` and the `[sb]` text-prefix fallback) is skipped. Verify the `lastSyncedCommentAt` DB column is created via schema migration and defaults to `NULL`. Verify the cursor is NOT advanced until dispatch completes (simulating an extension reload mid-dispatch should cause the next poll to re-fetch the comment). Verify the per-poll card cap (100) defers excess cards to the next cycle.
9. **Comment write-back (§8):** Verify host-side `postComment` makes the authenticated API call, stamps the self-marker, and truncates oversized output. Verify an agent-initiated post reaches it through the `LocalApiServer` bridge (not a direct call, not MCP) and that the token never leaves the host. Test both providers (triage write-back is dual-provider).
9a. **Sync-mode question directive (§11):** Verify that when remote control is active, the prompt builder injects the "post questions as comments" directive into all role prompts (and does NOT inject it for non-remote dispatch). Verify an agent question reaches Linear as a marked comment via the `linear_api` skill (over the bridge) and does not stall waiting on the terminal.
10. **State→column dispatch (§9, Linear):** Verify a poll-detected state change moves the card and dispatches the destination column's agent; verify a locally-dragged card does NOT echo back as an inbound move.
11. **Remote Control surface (§10, Linear):** Verify the config-only "Remote" tab persists boards-to-sync, silent-sync, ping mode, and ping frequency (30s–2min) — and that it does NOT define its own agent mapping (dispatch reuses existing automation routing). Verify Manual-mode toolbar toggle (Jules icon, next to `#btn-autoban`) starts/stops pinging, and that starting with silent-sync OFF runs a reconciling sync first. Verify silent-sync ON keeps boards mirrored after ping stops; silent-sync OFF stops reconciling. Verify Constant mode keeps ping always on. Verify local drags and inbound Linear moves don't echo-fight (concurrency). No separate board, no webhook/endpoint config.
12. **`completeSyncEnabled` ClickUp migration:** Verify that existing ClickUp configs with `completeSyncEnabled` undefined are migrated to `true` (not `false`) on load, preserving the effective unconditional-sync behavior. Verify new presets explicitly set `true`.
13. **`ticket_updater` mode collapse warning:** Verify that loading a config with `ticketUpdateMode: 'refine-ticket'` or `'research-and-refine'` logs a one-time console warning. Verify the warning is NOT shown for `'disabled'` or `'comment-only'` or absent mode. Verify the agent always performs triage-only behavior regardless of the stored mode value.
14. **Echo-guard TTL (§9):** Verify that a locally-pushed state change is not re-applied as an inbound move within the TTL window. Verify that after the TTL expires, a matching inbound state is applied (the guard drops). Verify the echo causes a redundant dispatch, not an infinite loop.

### Manual Verification

**Triage (Use Case 1):**
1. Connect Linear, pick a project, click "Enable Triage Pipeline." Verify a project board appears on the Kanban with the project name.
2. Wait for auto-pull. Verify tickets appear as cards on the board with correct provider link, tags, and comments.
3. Open a card's plan file. Verify `> **Linear Issue ID:**` is present and comments section exists.
4. Move a card to DONE. Verify the Linear issue status updates (if `completeSyncEnabled` is ON).
5. Disable "Complete sync" checkbox. Move another card to DONE. Verify the Linear issue does NOT update.

**Remote Control (Use Case 2) — the full loop, ideally driven from a phone:**
6. In the Remote tab, pick the board(s) to sync, set silent-sync / ping mode / frequency. In Manual mode with silent-sync OFF, press the Remote toolbar toggle (Jules icon) and verify a reconciling sync runs, then pinging starts.
7. From the Linear app, move an issue to a new state. Verify the card moves to the mapped column on the existing Switchboard board AND the destination column's agent (per existing automation routing) is dispatched.
8. Post a comment on the issue asking the agent a question. Verify the current column's agent answers with a comment that appears back in Linear.
9. Post a comment asking the agent to revise the plan. Verify the plan file is revised and a confirmation comment is posted.
10. Confirm the agent's own reply comments do NOT trigger another agent run (no feedback loop), and a locally-dragged card does NOT echo back as a phantom inbound move.

---

**Recommendation:** Complexity 9 → **Send to Lead Coder.** Multi-file changes across integration services, file watcher, metadata parser, setup UI, and kanban project system, now spanning two presets over shared plumbing. Provider ID linkage (§1) is the critical path for both use cases — everything depends on cards having a valid link back to their source ticket. The Remote Control loop (§7–11) is the higher-risk, higher-value half: its inbound comment ingestion and state-dispatch mirror introduce cycles that must be guarded (self-marker, echo guard, per-card queue). Suggested sequencing: §1–5 shared plumbing → §6 triage preset (proves the outbound path end-to-end) → §7–11 remote control (closes the inbound loop).

---

## Reviewer Pass — 2026-06-23 (post-implementation, in-place)

Reviewed the implemented diff (commit `fb98123`) against this plan as source of truth. Two adversarial stages below; valid MAJOR findings fixed in code. No compilation/tests run per session directive (verification deferred to user).

### Stage 1 — Grumpy Principal Engineer

> **CRITICAL — none survived the autopsy.** I went in expecting carnage and found the plumbing actually *plumbed*. Provider IDs extracted in the watcher (`GlobalPlanWatcherService.ts:490-526`), shared parsers actually shared (`planMetadataUtils.ts`), the Linear stub finally writes `**Linear Issue ID:**` *with the UUID* and `**Tags:**` not `**Labels:**`, comments/attachments captured with caps, `completeSyncEnabled` wired AND migrated `undefined→true` for ClickUp so I don't silently nuke 4,000 installs' DONE-syncs. The `ticket_updater` 4-mode relic is genuinely dead — collapsed to one triage verdict, modes test rewritten, config key kept readable with a one-time warning. Every method, command, sourceType, automation-rule field, and DB call I traced *exists*. Annoying. I wanted blood.
>
> **MAJOR #1 — the "remote mode" directive is a workspace-wide broadcast, not a per-board whisper (`KanbanProvider.ts:2732`).** The plan says — in BOLD, twice — "only injected when remote control is active for *that card's board*." You wired a single `_remoteControlActive` boolean and slapped it on *every* dispatch in the workspace. So the moment I start pinging board A from my phone, my agent grinding on local board B at my desk gets told "YOU ARE IN REMOTE MODE, post your questions as comments on the linked issue" — except board B's plan has NO linked issue. The agent shrugs, stops asking me anything, and barrels ahead. You broke the *exact* concurrent local+desk-and-phone scenario §10 sells as the headline. Per-board or it's a lie.
>
> **MAJOR #2 — first poll replays the entire comment history as agent dispatches (`RemoteControlService.ts:_ingestComments`).** Empty cursor → `!cursor || c.createdAt > cursor` is `true` for *everything*. So I flip on remote control for a board whose Linear issues have 40 comments of human back-and-forth, and your poller cheerfully fires the column agent FORTY TIMES per card on the first tick. Your OWN Adversarial Synthesis lists "runaway agent runs" as top risk #1 and you walked straight into it. "Fetch all comments on first poll" in §335 meant *seed the cursor*, not *dispatch the backlog*.
>
> **MINOR — the `lastSyncedCommentAt` column you swore to migrate (Dependencies, test #8) doesn't exist.** You stored cursors in a `remote.commentCursors` config-table JSON blob instead. Fine, §7 literally permits "the plan record / config table," and dodging a schema migration on a shipped extension is *arguably smarter* — but test #8 asserts a column that'll never be there. Update the test or stop writing checks you can't cash.
>
> **NIT — you smuggled a whole V37 epic-plan_id migration + epic-UUID-filename rework into an "integration import" commit.** Coherent, idempotent, harmless. Still, that's not this plan. Label your scope creep.
>
> **NIT — §9 echo guard tracks only `lastAppliedState`, not the plan's `lastPushedState`/`lastAppliedState` pair.** Column-equality (`targetColumn === plan.kanbanColumn`) covers the local-drag echo and re-pushing an identical state to Linear is idempotent (no new change → no loop), so it holds. Simpler than spec; not wrong.
>
> **NIT — Constant ping mode's toolbar toggle still toggles.** §397 says it "shows permanently active; no manual press needed," but the click handler always fires start/stop. Cosmetic.

### Stage 2 — Balanced synthesis

**Keep as-is (correct & complete):** §1 provider-ID linkage + shared parsers; §2 comment/attachment capture with caps; §3 tag fix; §4 `completeSyncEnabled` gate + ClickUp `undefined→true` migration; §5 `kanbanColumn` directive (both providers); the `ticket_updater` collapse (prompt, UI removal, migration warning, rewritten test); §6 one-click triage setup (end-to-end wired through `SetupPanelProvider` → `handleEnableTriagePipeline`); §8 host-side `postManagedComment` (dual-provider) + `/comment` bridge route; §10 Remote tab + Jules-icon toolbar toggle (`{{ICON_28}}` confirmed substituted, `is-active` styled, tab-content id convention correct).

**Fix now (done — see below):** MAJOR #1 (per-board directive gating) and MAJOR #2 (first-poll history replay). Both are correctness defects in the headline Remote Control loop and both were cheap, contained fixes.

**Defer / accept:** the `lastSyncedCommentAt` test (#8) should be revised to assert the config-table cursor instead of a column — flagged for the user's test pass, not blocking. V37 migration scope creep — leave it, it's a real fix. §9 single-field echo guard — adequate. Constant-mode toggle cosmetics — leave.

### Fixes applied

1. **§11 per-board gating — `KanbanProvider.ts`.** Replaced `remoteControlActive: this._remoteControlActive` with `await this._isRemoteActiveForDispatch(workspaceRoot, plans)`. New helper short-circuits on the global flag (no cost when remote control is off), then resolves each dispatched plan's project via `getPlanByPlanFile` and injects the directive only if a plan lands on a board in the active remote config. Fails *open* (to the old global behavior) when a plan can't be resolved, so the directive is never silently lost on the genuine remote board; suppresses only when confident all dispatched plans are on non-remote boards.
2. **§7 first-poll baseline seed — `RemoteControlService.ts` `_ingestComments`.** On empty cursor, seed `lastSyncedComment` to the latest existing comment timestamp and return *without* dispatching. Only comments posted after remote control starts are acted on. Reload-safe (cursor persists in DB config), matching the intended "post from phone → agent responds" UX and eliminating the historical-replay runaway.

### Findings by severity

- **CRITICAL:** none.
- **MAJOR (fixed):**
  - Per-board remote directive gating — `src/services/KanbanProvider.ts:2732` + new `_isRemoteActiveForDispatch` (~`:1449`).
  - First-poll comment-history replay — `src/services/RemoteControlService.ts` `_ingestComments` (~`:260`).
- **MINOR (not fixed — flagged):**
  - `lastSyncedCommentAt` stored as `remote.commentCursors` config JSON, not a DB column; revise test #8 accordingly — `src/services/RemoteControlService.ts:42,286-306`.
- **NIT (not fixed):**
  - V37 epic-plan_id migration + epic-UUID watcher logic bundled out-of-scope — `KanbanDatabase.ts:4804-4860`, `GlobalPlanWatcherService.ts:512-541`.
  - §9 echo guard single-field (`lastAppliedState` only) — `RemoteControlService.ts:62,240-246`.
  - Constant-mode toolbar toggle still interactive — `kanban.html` `btn-remote-control` handler.

### Files changed in this reviewer pass
- `src/services/KanbanProvider.ts` — per-board `_isRemoteActiveForDispatch` gating for §11.
- `src/services/RemoteControlService.ts` — first-poll cursor baseline seed in `_ingestComments`.

### Remaining risks
- **Bridge dependency unchanged.** All agent-initiated comment posting still rides `feature_plan_20260623120000_localapiserver-bridge-robustness`. The `/comment` route + `postManagedComment` are in place, but agent-side reliability is only as good as that companion plan — sequence/land it alongside.
- **Self-marker survival unverified.** `<!-- switchboard -->` vs Linear's renderer is still untested; `[sb]` fallback exists in `hasMarker`, but `stampMarker` only writes the HTML form. If Linear strips HTML comments, outbound posts won't carry a detectable marker and the feedback-loop guard fails — verify before shipping the loop, and switch `stampMarker` to the text marker if needed.
- **In-memory per-card queue volatility** (§7) — accepted v1 limitation; cursor-not-advanced-until-dispatch means a lost comment is re-fetched, not lost.
- **Test suite not run** (per session directive) — provider-ID extraction, triage setup, and the rewritten `ticket_updater` modes test should be exercised by the user; test #8 needs the config-cursor revision noted above.
