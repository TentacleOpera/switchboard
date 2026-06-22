# Integration Import Pipeline Overhaul — Fetched Data Loss, Orphaned Cards, Dead Config

## Goal

Make the ClickUp/Linear integration usable by collapsing its over-engineered configuration surface down to **two concrete, opinionated use cases**, each enabled as a one-click preset. The current implementation fetches rich ticket data from provider APIs but discards most of it, produces orphaned Kanban cards with no link back to the source ticket, only syncs in one direction at import time, and requires ~20 manual configuration steps that obscure what the feature is actually for.

The feature is over-engineered, but it is **not** single-purpose. There are two distinct workflows worth supporting, and the current plan must serve both:

> **Use Case 1 — Bug Triage board:** Connect provider → pick a list → enable triage → bugs flow in, get routed to a column agent, results sync back to the ticket.
>
> **Use Case 2 — Remote Control of Switchboard:** Connect provider → mirror your columns to Linear states and assign an agent per column → from your phone, move a card between states to dispatch its column agent, and post comments to question/instruct the current column's agent. The agent replies back as a comment. Linear becomes a remote terminal for the agents running on your laptop at home.

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

1. **You post a task** as a Linear issue (from your phone). Switchboard syncs it in as a card on the mirrored board.
2. **You move the card between Linear states.** Card moves in Linear drive **column moves in Switchboard** — never the reverse. (Switchboard is deliberately not designed for agents to move their own cards; humans/Linear drive moves.) Landing in a column **dispatches that column's assigned agent**.
3. **The column agent does its work** and posts its output back as a **comment on the Linear issue**.
4. **You post a comment** on the issue to question or instruct the agent. The comment is routed to **whichever agent owns the column the card is currently in**. For example: a comment asking "why this approach?" gets an answered comment back; a comment asking "revise the plan to do X" makes the agent revise the plan and post a confirmation comment.
5. Loop — all from your phone, with Linear comments as the conversation channel and Linear state as the dispatch control.

The plumbing for the *outbound* half (card → comment, status → state) largely exists. The **inbound half — pulling new Linear comments back into Switchboard and routing them to the current column's agent — is the missing piece** that turns this from "technically possible" into a usable feature.

### Problem Analysis

The pipeline is: API fetch → write stub `.md` file → `GlobalPlanWatcherService` detects file → `parsePlanMetadata` extracts metadata → DB insert → card appears on board.

**Three categories of problems block the triage pipeline from working:**

#### A. Cards are orphaned — no round-trip sync possible

The real-time watcher (`GlobalPlanWatcherService._handlePlanFile`, `GlobalPlanWatcherService.ts:497-520`) hardcodes `clickupTaskId: ''`, `linearIssueId: ''`, and `sourceType: 'local'` for every new plan. This means:

- Cards have **no link back** to the source ticket
- Agents can't update the original bug because the DB doesn't know which ticket the card came from
- Imported cards are indistinguishable from locally-created plans

Making this worse: the Linear stub doesn't even write a `**Linear Issue ID:**` line. The `extractLinearIssueId` function (`PlanFileImporter.ts:235-237`) looks for `> **Linear Issue ID:** <value>` but the stub only writes `> Imported from Linear issue \`ENG-123\`` using the human identifier, not the UUID. So even the batch importer can't extract the Linear ID.

The ClickUp side is slightly better — the stub writes `> **ClickUp Task ID:** abc123` which `extractClickUpTaskId` can find — but the watcher never calls the extraction function.

#### B. Stub files discard useful context

The Linear GraphQL query (`LinearSyncService.ts:1940-1951`) fetches comments, attachments, estimate, createdAt, project name, cycle, and sub-issues — then throws them all away. Only title, description, URL, priority, state, assignee, labels, dueDate, and parent are written to the stub.

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

A product manager who just wants "sync my bugs in" should not need to understand what `completeSyncEnabled` does (especially since it's a no-op — no code reads it). The existing `completeSyncEnabled` flag is persisted, shown in the UI, but never checked by `LinearSyncService.syncPlan()` (`LinearSyncService.ts:1595`) or `ClickUpSyncService.syncPlan()` (`ClickUpSyncService.ts:2113`).

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

**None** — the decisions below are made and baked into Proposed Changes. They are recorded here only as a changelog of resolved calls. The one item the user will most likely *customize* (not decide) is the per-column agent assignment for Remote Control (§10.3), which is editable after setup.

**Resolved decisions:**
1. **Triage preset columns** — Use the existing Switchboard kanban column constants (`CREATED` as the import-landing/inbox column → in-progress → `DONE`), not invented `INBOX`/`REVIEWING` names. The earlier draft contradicted itself (`CREATED`/`DONE` in §6 vs `INBOX`/`REVIEWING`/`DONE` in the review section); §6 now uses the real column enum so the routing rule references columns that actually exist.
2. **Triage default automation rule** — Single rule routing the import-landing column (`CREATED`) to the existing **`ticket_updater` role set to a new `triage` mode** (NOT the planner — the planner emits full feature plans, the wrong output for a ticket comment), final column `DONE`, `writeBackOnComplete: true`. Reuses the existing role + write-back skill rather than adding a new role; triage mode enforces a hard ≤120-word verdict contract and an `auto` / `needs-human` routing decision, and never overwrites the ticket description. See "Repurpose the `ticket_updater` role" in Proposed Changes.
3. **`completeSyncEnabled`** — Wire it up; default ON for new presets, preserve existing config values for current installs (per migration rule). Gates automatic `syncPlan()` on DONE/COMPLETED/ARCHIVED transitions; leaves manual dispatch untouched.
4. **Comment cap (import capture, §2)** — Max 20 most recent comments, 2000 chars each, truncation marker on overflow.
5. **Inbound comment routing target (§7, NEW)** — Comments route to the agent assigned to the card's **current column** (no fixed agent). Self-authored comments are filtered via a hidden marker to prevent feedback loops.

## Complexity Audit

### Routine
- Adding `> **Linear Issue ID:** <uuid>` line to Linear stub metaLines (`LinearSyncService.ts:2029-2038`)
- Changing `> **Labels:**` to `> **Tags:**` in Linear stub writer (`LinearSyncService.ts:2036`)
- Adding `kanbanColumn: BACKLOG` directive to stubs for backlog-state items
- Removing dead `kanbanColumn` variable (`LinearSyncService.ts:2021`) by wiring it up

### Complex / Risky
- **Provider ID extraction in watcher (Medium):** Moving `extractClickUpTaskId` / `extractLinearIssueId` to shared utility and calling from `GlobalPlanWatcherService._handlePlanFile`. New `sourceType` logic independent of `automationRuleName`.
- **Comment/attachment writing with truncation (Medium):** New `## Comments` / `## Attachments` sections in Linear stub writer. Must enforce size caps to prevent oversized stubs.
- **Repurpose `ticket_updater` — add a `triage` mode (Medium):** Reuse the existing role rather than registering a new one. Add `'triage'` to the `ticketUpdateMode` union (`agentConfig.ts:19`) and the addon radio options (`sharedDefaults.js:184`), and add a `triage` arm to the `ticket_updater` prompt branch (`agentPromptBuilder.ts:862`). The risk is prompt-design — the ≤120-word verdict contract must be tight enough the agent doesn't drift into the role's existing verbose-analysis behavior, and it must never overwrite the ticket description. Migration constraint: the role shipped (it has a `ticketUpdateEnabled → ticketUpdateMode` migration), so the existing four modes and all config keys must be preserved unchanged.
- **One-click triage setup (Medium-High):** New "Enable Triage Pipeline" flow that auto-creates a project board, sets sensible defaults, and wires up a default automation rule (dispatching to `ticket_updater` in `triage` mode). Touches `setup.html`, `TaskViewerProvider`, and `KanbanDatabase`.
- **`completeSyncEnabled` wiring (Medium):** Gating `syncPlan()` when target column is DONE/completed. Must distinguish automatic sync (gate it) from manual dispatch (don't gate it).
- **Inbound comment ingestion + routing (High — §7):** New polling path, per-card last-comment cursor, self-comment filtering, and dispatch to the current column's agent. The dispatch-to-column-agent linkage is the riskiest coupling: it reuses the automation dispatch path but is triggered by a comment rather than a card move. Per-card sequential queue needed to avoid concurrent agent runs on one plan.
- **Comment write-back channel (Medium — §8):** `postComment` with self-marker and truncation. Shared with the triage completion summary.
- **State → column dispatch mirror (High — §9):** Inbound state-change detection must trigger the same dispatch a manual drag does, while guarding against an echo loop with outbound status write-back (§4). Getting the echo guard wrong causes infinite sync churn.
- **One-click Remote Control setup (Medium-High — §10):** Mirrors columns↔states, builds the mapping, assigns per-column agents, tighter pull interval. Touches the same files as §6 plus the agent-assignment UI.

## Edge-Case & Dependency Audit

### Race Conditions
- **Stub write → watcher pickup:** `fs.promises.writeFile` is effectively atomic (write-to-temp + rename on most platforms). No risk of partial reads.
- **Concurrent import + manual edit:** Watcher checks `!plan` for new vs existing. Second fire takes update path, preserving `sourceType`/provider IDs. Safe.
- **Comment feedback loop (§7/§8):** The agent posts a reply comment; the next poll fetches it and would dispatch the agent again, ad infinitum. Mitigated by the hidden `<!-- switchboard -->` marker on all outbound comments — ingestion skips any comment containing it. The marker must survive the provider's markdown rendering (HTML comments are preserved by both Linear and ClickUp comment APIs; verify during implementation).
- **State sync echo loop (§9):** A local drag pushes a state change out (§4); the next pull sees that state as "changed" and re-applies it as a column move + dispatch. Mitigated by recording the last-pushed state per card and skipping inbound moves that match a state we just wrote.
- **Comment arrives mid-dispatch (§7):** Per-card sequential queue; a comment landing while the column agent is still running is enqueued, not dropped or run in parallel.

### Security
- **Comment body injection:** Linear comments are arbitrary external markdown. Writing them to stub is no new attack surface — plan parser only extracts structured metadata from specific patterns; freeform content is ignored.

### Side Effects
- **Stub file size increase:** Comments/attachments make stubs larger. Hard cap (20 comments, 2000 chars) limits this to ~50KB worst case.
- **`completeSyncEnabled` behavioral change for ClickUp:** ClickUp defaults to `false`. Wiring it up means existing ClickUp users will see DONE-column syncs suppressed unless they check the box. This matches the UI label intent but is a silent behavioral change for anyone who relied on unconditional sync.

### Dependencies & Conflicts
- `extractClickUpTaskId` / `extractLinearIssueId` are module-private in `PlanFileImporter.ts`. Must export or move to `planMetadataUtils.ts`.
- `ALLOWED_TAGS` in `planMetadataUtils.ts` (21 curated tags) will filter out most custom Linear labels. This is intentional — labels stay visible in the plan markdown.
- Existing ticket sync in `planning.html` (via `ContinuousSyncService`) handles bidirectional content sync. The triage pipeline should piggyback on this rather than building a parallel path.

## Dependencies

- None blocking. Self-contained across integration services, watcher, and setup UI.
- Decision on `completeSyncEnabled` (wire up vs. remove) should be made before implementation.

## Adversarial Synthesis

**Risk Summary:** The highest-risk items are now the two loop-closing mechanisms in Remote Control: **inbound comment ingestion → column-agent dispatch (§7)** and the **state→column dispatch mirror (§9)**. Both create cycles that, done wrong, cause runaway agent runs or infinite sync churn. They are mitigated by (a) the hidden self-comment marker, (b) a per-card last-pushed-state guard against echo, and (c) a per-card sequential dispatch queue. These guards are the load-bearing parts of the plan and should be the focus of review and testing.

The one-click setups (triage §6, remote §10) create opinionated defaults (board name, columns, automation rule, per-column agents) that may not fit every team. Mitigation: everything is editable after creation, framed as a starting point; the per-column agent assignment is explicitly expected to be customized.

The provider-ID extraction coupling (stub format ↔ extraction logic across 3 files) is mitigated by moving parsers to a shared utility. The `completeSyncEnabled` wiring for ClickUp is a silent behavioral change — mitigated by defaulting to ON for new setups and preserving existing config values per the migration rule.

## Proposed Changes

The changes split into **shared plumbing** (§1–5, needed by both use cases) and **two presets** layered on top (§6 Bug Triage, §7–10 Remote Control). Implement the plumbing first; the presets are thin orchestration over it.

### Shared plumbing (§1–5)

### 1. Fix provider ID linkage (make round-trip sync possible)

**Why this matters:** Without provider IDs in the DB, the triage pipeline can't push results back to ClickUp/Linear. This is the #1 blocker.

#### `src/services/LinearSyncService.ts` (stub writer, lines 2029-2046)
- Add `> **Linear Issue ID:** ${issue.id}` to the `metaLines` array after the `Imported from` line. Uses the UUID (`issue.id`), not the human identifier (`issue.identifier`).

#### `src/services/planMetadataUtils.ts` (shared utility)
- Move `extractClickUpTaskId`, `extractLinearIssueId`, and `extractEmbeddedMetadata` from `PlanFileImporter.ts` to here. Export them.
- Update `PlanFileImporter.ts` to import from `planMetadataUtils` instead of defining locally.

#### `src/services/GlobalPlanWatcherService.ts` (`_handlePlanFile`, lines 487-520)
- After reading file content (line 487), call `extractClickUpTaskId(content)` and `extractLinearIssueId(content)`.
- Set `sourceType` based on provider ID presence:
  - ClickUp ID only → `'clickup-import'`
  - Linear ID only → `'linear-import'`
  - Both (edge case) → `'local'`, clear both IDs
  - Neither → `'local'` (existing behavior, no change for local plans)
- Replace hardcoded `clickupTaskId: ''` / `linearIssueId: ''` / `sourceType: 'local'` in the `newRecord` with the extracted values.

### 2. Write comments and attachments to Linear stubs

**Why this matters:** Comments are the bug report context that agents need for triage. Without them, the planner agent sees only a title and description.

#### `src/services/LinearSyncService.ts` (stub assembly, lines 2040-2046)
- After the description, append `## Comments` section (max 20 most recent, max 2000 chars per body, truncated with `*[truncated]*` marker).
- After comments, append `## Attachments` section (list of `[title](url)` links).
- Empty sections are omitted entirely.

### 3. Fix tag parsing for Linear imports

**Why this matters:** Tags drive automation rules. Broken tag parsing means tag-based triage rules never match imported Linear tickets.

#### `src/services/LinearSyncService.ts` (line 2036)
- Change `> **Labels:** ${labels}` to `> **Tags:** ${labels}`.
- Tags will pass through `sanitizeTags` on the DB side — only `ALLOWED_TAGS` values survive. Custom Linear labels are preserved in the plan file markdown but filtered from the DB tag field. This is intentional.

### 4. Wire up `completeSyncEnabled`

**Why this matters:** The UI checkbox promises "sync completed status" but does nothing. Users who uncheck it expect DONE-column moves to NOT push state changes to the provider.

#### `src/services/LinearSyncService.ts` (`syncPlan()`, line 1595)
- After resolving `stateId` from column mapping, check: if `config.completeSyncEnabled === false` and `newColumn` is `DONE`/`COMPLETED`/`ARCHIVED` → skip the sync with a log message.

#### `src/services/ClickUpSyncService.ts` (`syncPlan()`, line 2113)
- Same pattern: if `config.completeSyncEnabled === false` and `plan.kanbanColumn` is `DONE`/`COMPLETED`/`ARCHIVED` → return early with `skippedReason`.

- **Leave manual dispatch (`changeTicketStatus`, `updateIssueState`) untouched** — those are explicit user actions that should always work.

### 5. Wire up `kanbanColumn` directive in stubs

**Why this matters:** When `excludeBacklog` is OFF and backlog items are imported, they should land in the BACKLOG column, not CREATED.

#### `src/services/LinearSyncService.ts` (line 2021)
- Keep the existing `kanbanColumn` variable (no longer dead code).
- Add `kanbanColumn: ${kanbanColumn}` line to the stub, after the title and before the metadata block.
- The parser at `planMetadataUtils.ts:57` already matches `kanbanColumn[:\s]+(\w+)`.

#### `src/services/ClickUpSyncService.ts` (after line 2492)
- Add equivalent: `const kanbanColumn = statusName === 'backlog' ? 'BACKLOG' : 'CREATED';`
- Add `kanbanColumn: ${kanbanColumn}` to the ClickUp stub.

### Preset 1 — Bug Triage (§6)

### Repurpose the `ticket_updater` role into the triage agent (add a `triage` mode)

**Why this matters:** The triage preset must NOT dispatch to the **planner** agent (`agentPromptBuilder.ts:456`), which emits full multi-section feature plans — a wall of planning ceremony posted onto the ticket. But it also shouldn't spawn a brand-new role: the existing **`ticket_updater`** role already has every surface wired and already owns the ClickUp/Linear write-back skill. We **reuse it** by adding a focused triage mode rather than building a parallel agent.

**Current state of `ticket_updater` (the relic to repurpose):** it has a `ticketUpdateMode` selector with modes `disabled | comment-only | refine-ticket | research-and-refine`. All current modes do the wrong thing for triage — they generate a ~500-word plan analysis (Goal Summary, Complexity Assessment, Key Dependencies, Implementation Notes, Estimated Effort) and either post it as an "AI Analysis" comment or **overwrite the ticket description**. The `refine-ticket` / `research-and-refine` description-overwrite behavior is especially unwanted for triage. It also keys off a different metadata field (`**Ticket:** CU-XXXXX/LIN-XXXXX`) than the stub pipeline (`**ClickUp Task ID:**` / `**Linear Issue ID:**`).

**The change — add a fifth mode `triage`:**

#### `src/services/agentConfig.ts` (line 19) + `src/webview/sharedDefaults.js` (line 184 radio options)
- Add `'triage'` to the `ticketUpdateMode` union and to the radio-option list in the addon UI.
- Preserve the existing four modes verbatim (migration: the role shipped, with a `ticketUpdateEnabled → ticketUpdateMode` migration — see `agent-prompt-builder-ticket-updater-modes.test.js`). Existing users' configs must keep working.

#### `src/services/agentPromptBuilder.ts` (the `ticket_updater` branch, line 862)
- Add a `ticketUpdateMode === 'triage'` arm that **replaces** the verbose `analysisTemplate()` with a hard triage contract. It does NOT analyze a plan; it reads the imported ticket (title, description, captured comments from the stub §2) and emits a single short comment, target ≤ ~120 words, fixed shape:
  - **Severity:** blocker / high / normal / low
  - **Area:** one or two tags
  - **Assessment:** 1–2 sentence root-cause hypothesis or restatement of the real problem
  - **Recommended action:** the concrete next step
  - **Routing:** `auto` (simple enough to action directly) **or** `needs-human` (complex/ambiguous/cross-cutting → move to the planning.html Tickets tab)
- Behavioral rules baked in: no preamble, no restating the whole ticket, no markdown section dumps, no speculative implementation detail, **never overwrite the ticket description** — comment only.
- Reuse the existing `clickup_api` / `linear_api` write-back skill the branch already invokes. Resolve the provider ID from the stub fields (`**ClickUp Task ID:**` / `**Linear Issue ID:**`) so triage uses the same linkage as §1, not the legacy `**Ticket:**` field.

#### `src/webview/kanban.html` (description map, line 3087)
- Update the `ticket_updater` `roleDescriptions` entry to reflect the broadened role (e.g. *"Posts triage verdicts or analysis/status back to connected PM systems (ClickUp/Linear)."*). Optionally relabel the visible name to "Ticket Agent" — but keep the `ticket_updater` role id and all config keys unchanged for migration.

#### Relationship to Remote Control
- `ticket_updater` in `triage` mode is the natural **default agent for the inbox/early column** in Remote Control (§10.3), since a freshly-posted issue wants triage before deeper work.

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
     - **Dispatch agent: `ticket_updater` in the new `triage` mode (NOT planner)** — see "Repurpose the `ticket_updater` role" above.
     - Final column: `DONE`
     - `writeBackOnComplete: true` (posts the triage verdict back as a ticket comment via §8)
  4. **Assign all imported plans** from that list/project to the new project board.
  5. Return success to the UI, which shows a confirmation with the project board name.

#### Design notes
- The one-click setup doesn't replace the existing detailed configuration — it's a fast-path that sets up the common case. Users can still manually configure everything via the existing setup UI.
- The auto-created project board and automation rule are fully editable after creation.
- The setup button is only enabled after a provider is connected and a list/project is selected.

### Preset 2 — Remote Control (§7–10)

This preset turns Linear into a remote terminal for the agents on your machine. It reuses the shared plumbing (provider IDs, status write-back, comment capture) and adds the **inbound comment loop** and a **state↔column dispatch mirror**. ClickUp gets the same treatment where its API supports comments; Linear is the primary target.

### 7. Inbound comment ingestion + routing to the current column's agent (NEW — core of Use Case 2)

**Why this matters:** This is the missing half of the loop. Without it, a comment you post from your phone never reaches the agent. This is the single most important new capability in the plan.

#### `src/services/LinearSyncService.ts` (and ClickUp equivalent) — comment polling
- Extend the existing auto-pull cycle so that, for each synced issue with a known provider ID, it fetches comments **created after the last-seen timestamp** for that card.
- Track a per-card `lastSyncedCommentAt` (or last comment ID) in the DB so the same comment is never processed twice. Store on the plan record / `config` table — **not** a fictional state.json (see project rule).
- Ignore comments authored by Switchboard itself (tag outbound comments with a hidden marker, e.g. a trailing `<!-- switchboard -->` HTML comment, and skip any inbound comment containing it) to prevent self-feedback loops.

#### Routing: comment → current column's agent
- On a new inbound comment, look up the card's **current kanban column** and the **agent assigned to that column** (the same per-column agent the automation rules dispatch to).
- Dispatch the comment text to that agent as an instruction, in the card's existing plan context — the agent decides whether it's a question (answer it) or a revision request (revise the plan, then confirm).
- If the column has no assigned agent, post a write-back comment explaining no agent is active on this column and skip dispatch (no silent drop).

#### Concurrency / ordering
- Process inbound comments for a card sequentially (queue per card) so a rapid-fire "do X" then "actually do Y" can't run two agents on the same plan simultaneously.
- A comment that arrives while the column agent is still working is queued, not dropped.

### 8. Agent reply → Linear comment write-back (NEW)

**Why this matters:** The agent's answer has to get back to your phone. Status write-back exists; conversational comment write-back does not.

#### `src/services/LinearSyncService.ts` (and ClickUp equivalent)
- Add a `postComment(providerId, body)` path used by whichever column agent is replying, to write its comment back to the source issue. This wraps the same low-level `clickup_api` / `linear_api` skill the `ticket_updater` branch already invokes — it is the shared write-back primitive, decoupled from `ticket_updater`'s opinionated analyze-and-publish behavior so that *any* column agent (planner, coder, the triage-mode agent) can post a reply.
- Prefix/suffix the body with the hidden `<!-- switchboard -->` marker (see §7) so the ingestion poller doesn't treat the agent's own reply as a new inbound instruction.
- Truncate to the provider's comment size limit; if the agent output exceeds it, post a head + "*[truncated — see plan file]*" tail.
- The triage-mode write-back (§6) and the triage agent's verdict comment use this same primitive — build it once and share it.

### 9. Card-move dispatch mirror — Linear state → Switchboard column → column agent (NEW)

**Why this matters:** Moving a card in Linear must move it in Switchboard *and* dispatch the destination column's agent. Switchboard never moves its own cards; the move is always driven from Linear (or by the human at the board).

#### `src/services/LinearSyncService.ts` — inbound state sync
- During auto-pull, detect when a synced issue's **state has changed** since last sync and the new state maps to a different Switchboard column (via the existing column↔state mapping).
- Apply the column move to the card, then **trigger the destination column's automation/agent dispatch** — the same dispatch path a manual board drag triggers, so behavior is identical whether the move came from Linear or from a drag.
- This is one-directional inbound (Linear → Switchboard) for *moves*. Outbound status write-back (§4) still handles Switchboard → Linear when a human drags the card locally; guard against an echo loop (don't re-push a state we just pulled).

### 10. One-click Remote Control setup (NEW)

**Why this matters:** Like triage, this should be one click, not 20 steps. The difference is what it configures.

#### `src/webview/setup.html`
- Add an "Enable Remote Control" button alongside "Enable Triage Pipeline", in both provider sections, enabled once connected and a project is selected.

#### `src/services/TaskViewerProvider.ts` (or `KanbanProvider.ts`) — handle `enableRemoteControl`
1. **Auto-create / select a project board** named "Remote — [project name]" whose columns mirror the Linear project's workflow states (or fall back to the standard Switchboard column set if state introspection isn't available).
2. **Build the column↔state mapping** automatically from the mirror, so moves round-trip without manual mapping.
3. **Prompt for / assign a default agent per column** (the conversational target for comments landing in that column). A sensible default: **`ticket_updater` in `triage` mode on the inbox/early column** (a freshly-posted issue wants triage first), planner on a review column, coder/lead on in-progress columns. This is the one piece the user will most likely customize.
4. **Set defaults:** `realTimeSyncEnabled: true`, `autoPullEnabled: true`, `pullIntervalMinutes: 5` (tighter than triage — remote control wants snappier comment turnaround), `completeSyncEnabled: true`, comment ingestion ON.
5. Return success with the board name and the per-column agent assignment so the UI can confirm.

#### Design notes
- Both presets are mutually compatible — a user can run a triage board on one list and a remote-control board on another project at the same time (consistent with the independent-workspace-per-tab behavior).
- `pullIntervalMinutes: 5` is a battery/rate-limit tradeoff; expose it so power users can tighten it. Note any provider comment-fetch rate limits in implementation.

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
8. **Inbound comment routing (§7):** Verify a new Linear comment is fetched, routed to the agent of the card's current column, and not re-processed on the next poll. Verify a comment containing the self-marker is skipped.
9. **Comment write-back (§8):** Verify the agent's reply posts as a Linear comment carrying the self-marker, and truncates oversized output.
10. **State→column dispatch (§9):** Verify a Linear state change moves the card and dispatches the destination column's agent; verify a locally-dragged card does NOT echo back as an inbound move.
11. **One-click Remote Control setup (§10):** Verify "Enable Remote Control" mirrors columns↔states, builds the mapping, assigns per-column agents, and enables comment ingestion.

### Manual Verification

**Triage (Use Case 1):**
1. Connect Linear, pick a project, click "Enable Triage Pipeline." Verify a project board appears on the Kanban with the project name.
2. Wait for auto-pull. Verify tickets appear as cards on the board with correct provider link, tags, and comments.
3. Open a card's plan file. Verify `> **Linear Issue ID:**` is present and comments section exists.
4. Move a card to DONE. Verify the Linear issue status updates (if `completeSyncEnabled` is ON).
5. Disable "Complete sync" checkbox. Move another card to DONE. Verify the Linear issue does NOT update.

**Remote Control (Use Case 2) — the full loop, ideally driven from a phone:**
6. Connect Linear, pick a project, click "Enable Remote Control." Verify a mirrored board appears with columns matching the Linear states and a per-column agent assignment shown.
7. From the Linear app, move an issue to a new state. Verify the card moves to the mapped column on Switchboard AND the destination column's agent is dispatched.
8. Post a comment on the issue asking the agent a question. Verify the current column's agent answers with a comment that appears back in Linear.
9. Post a comment asking the agent to revise the plan. Verify the plan file is revised and a confirmation comment is posted.
10. Confirm the agent's own reply comments do NOT trigger another agent run (no feedback loop), and a locally-dragged card does NOT echo back as a phantom inbound move.

---

**Recommendation:** Complexity 9 → **Send to Lead Coder.** Multi-file changes across integration services, file watcher, metadata parser, setup UI, and kanban project system, now spanning two presets over shared plumbing. Provider ID linkage (§1) is the critical path for both use cases — everything depends on cards having a valid link back to their source ticket. The Remote Control loop (§7–10) is the higher-risk, higher-value half: its inbound comment ingestion and state-dispatch mirror introduce cycles that must be guarded (self-marker, echo guard, per-card queue). Suggested sequencing: §1–5 shared plumbing → §6 triage preset (proves the outbound path end-to-end) → §7–10 remote control (closes the inbound loop).
