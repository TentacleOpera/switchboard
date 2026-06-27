# Notion as a Remote-Control Provider (MCP Control Surface) + Delta Polling for Linear & Notion

## Goal

Extend Switchboard's Remote Control feature — currently Linear-only — so the user can choose **Linear or Notion** as the remote backend via a dropdown in the Remote tab of `kanban.html`. Notion has no active-issue cap, so it is the escape hatch for Linear's 250-issue free-tier limit (the limit a recent commit added a warning for; see `linear-free-tier-auto-archive-on-completion.md`).

**Critical framing:** Notion Remote Control is **not** a human-facing Notion UI. It is a **control surface for an agent**. The user connects Notion to **claude.ai** and the **remote Claude session drives everything through the Notion MCP connector** — authoring plans, triggering execution, talking to the local machine, reading results. The human just tells Claude what to do. This mirrors the Linear model documented in `add-switchboard-remote-skill.md` (control surface #2: "Claude.ai web + MCP"), which is the highest-value surface because Claude can analyse the repo and author a thorough plan before anything runs locally.

For Notion to be a true peer to Linear, three things must work:
1. **State mirroring** — the remote agent flips a page's `Kanban Column` (via Notion MCP) → the local Kanban card moves and the destination column's agent is dispatched.
2. **A comments channel** — the remote agent and the local dispatched agent exchange messages (instructions in, results out) through a medium both can reach.
3. **An orientation skill** — so the remote claude.ai session knows how to operate the Notion control surface, plus a bridge skill so the **local** dispatched agent can write replies back.

While building the Notion path, replace the current **poll-all-cards** loop with **delta polling** for **both** providers.

### Background & Problem (root-cause analysis)

**The two-agent topology (same as Linear remote, new backend):**

```
Human ──tells──► Remote Claude (claude.ai)
                      │  Notion MCP
                      ▼
                 Notion (plans DB + comments DB)   ◄── async message bus
                      ▲
                      │  poll (delta) / write-back (bridge)
                 Switchboard extension ──dispatch──► Local Claude (user's machine)
```

- The **remote agent** writes the plan into a Notion page, sets `Kanban Column` to the trigger column, and posts comments — all via the Notion MCP connector on claude.ai.
- The **Switchboard extension** polls Notion, mirrors the column change onto the local board, refreshes the local plan from the page body, and dispatches the **local agent**.
- The **local agent** does the code work and writes replies/results back through the LocalApiServer bridge, which the remote agent reads next session via MCP.

**Today (`src/services/RemoteControlService.ts`) the feature is Linear-only**, with three structural gaps:

1. **No provider seam.** `RemoteControlService` depends directly on `LinearSyncService`; the comment loop assumes Linear issue comments + the `<!-- switchboard -->` marker (`src/services/commentMarker.ts`); `RemoteConfig` has no provider field.

2. **Poll-all-cards does not scale, and is fatal for Notion.** Each cycle fetches *every* tracked card (`fetchIssueUpdates([...all ids])`, capped at `PER_POLL_CARD_CAP = 100`). On Notion's ~3 req/sec API, per-card fetches for 100 cards blow past the 30–120s poll window. Fix (user-identified): poll the **delta** — ask the remote API "what changed since my cursor?" Both APIs support a server-side change filter, so a poll returns only the handful of cards the remote agent actually touched (usually zero).
   - **Why not Switchboard's local change log?** It records *Switchboard-originated* changes. Remote Control's inbound direction reacts to changes the **remote agent** makes in Notion/Linear, which never appear in the local log until we poll. So the delta must come from the remote API's own change filter. (The local log still drives the *outbound* direction and echo-guarding — unchanged.)

3. **The Linear comment marker doesn't transfer to Notion, and native comments are unreliable for delta polling** (see Decision D3).

### Non-goals / explicit scope cuts (per user)

- **No hot-swap between providers.** Dev-stage; switching providers = re-run the one-time setup sync in the Remote tab. No migration / dual-provider / cross-provider-move logic.
- **No simultaneous providers.** Exactly one active at a time.
- **No human-facing Notion UX polish.** The Notion side is an agent control surface, not a person's workspace. No linked views, templates, or friendly forms for humans.
- **No webhooks.** Polling stays the transport.

---

## Metadata

**Tags:** backend, api, feature, refactor, ui, reliability, performance, docs
**Complexity:** 8

---

## User Review Required

Yes — before implementation begins, the user should:
1. Review the **Uncertain Assumptions** section and run the supplied web-research prompt to confirm Notion/Linear API behaviors (rate limits, filter syntax, `created_by` exposure, MCP connector capabilities) that the design depends on.
2. Confirm the **provider-config defaulting** behavior (D1): when both integrations are configured, which one wins as the dropdown default. The plan assumes "whichever integration is configured," but if both are configured the tie-break is unspecified — user should pick a rule (e.g. prefer Linear, or last-used, or explicit).
3. Confirm the cursor-storage model change (see Task 2): existing installs store per-card comment cursors keyed by issue id. Delta polling introduces per-board/global state cursors. User should confirm the migration path for existing Linear users (re-seed on first delta poll).

---

## Uncertain Assumptions

**Research completed.** The user ran web research (findings in `docs/technical_platform_integration_analysis.md`) and the results have been incorporated into this plan. Summary of resolved assumptions:

| Assumption | Verdict | Plan Impact |
|:---|:---|:---|
| Notion `last_edited_time`/`created_time` timestamp filters | **Confirmed** (syntax caveat: no `"property"` field) | Task 3 updated with exact filter shape + syntax warning |
| Notion `created_by` = integration bot id | **Confirmed** | D3 self-identification design validated; Task 3 updated |
| Notion `/v1/users/me` returns bot id | **Confirmed** (PAT returns `person` instead of `bot` — id still matches) | Task 3 edge case updated with PAT caveat |
| Notion native comments don't bump `last_edited_time` | **Confirmed** | D3 rationale validated; Comments DB design confirmed correct |
| Notion MCP: query/create-row universal, native comments not | **Confirmed** (official hosted server has inline-comment bug + non-default toggles) | D3 + Task 6 validated; remote agent uses interactive OAuth MCP (browser-based), which is fine for the human-driven claude.ai session |
| Linear `updatedAt` filter supported | **Confirmed** (`gt`/`gte` both work) | Task 2 state-delta query validated |
| **Linear comment bumps issue `updatedAt`** | **WRONG — broken** | **Critical fix applied to Task 2**: comments do NOT bump `updatedAt`; Linear must query the `comments` entity separately via `comments(filter:{ createdAt:{ gt: cursor }})` |

The only remaining open item is the D1 tie-break (when both Linear and Notion are configured, which defaults) — see User Review Required.

---

## Complexity Audit

### Routine
- Adding `notionPageId?: string` field + `notion_page_id` column + migration + update methods to `KanbanDatabase.ts` — mirrors the existing `linearIssueId`/`clickupTaskId` pattern verbatim (lines 52–53, 133–134, 1786–1850).
- Adding `'notion-import' | 'notion-automation'` to the `sourceType` union and the read-normalization guard (lines 46, 5760–5766).
- Extending the `_handlePostComment` provider guard from `linear`/`clickup` to include `notion` and adding a `getNotionService()` option (LocalApiServer.ts lines 195, 201–203, options lines 8–14).
- Adding a `provider` field to `RemoteConfig` + defaulting in `getConfig`/`setConfig` (RemoteControlService.ts lines 23–39, 78–113).
- Authoring two skill markdown files mirroring `linear_api.md` and registering them in `AGENTS.md` + `MIRROR_MANIFEST`.
- Adding a `**Notion Page ID:**` metadata line mirroring `**Linear Issue ID:**` (LinearSyncService.ts lines 2345–2357; agentPromptBuilder.ts lines 960–962).

### Complex / Risky
- **Provider abstraction seam** — extracting a `RemoteProvider` interface and refactoring `RemoteControlService._poll` (lines 178–232) and `_applyStateMirror` (lines 242–267) to be provider-agnostic without breaking the existing echo-guard / per-card-queue / seed-on-first-poll / advance-after-dispatch invariants.
- **Delta polling cursor model** — replacing per-card `fetchIssueUpdates(ids)` (lines 211–213) with global "changed since cursor" queries; migrating the existing per-card comment cursors (key `remote.commentCursors`, lines 313–333) to per-provider global cursors; ensuring at-least-once + idempotency holds under the new scheme. **Research finding applied:** Linear comments do NOT bump `updatedAt`, so the provider must run a separate `comments`-entity query — this is the highest-risk correctness issue caught by research.
- **Notion Comments DB as a new subsystem** — creating a second Notion database with a relation back to the plans DB, agent-operated over MCP, with `created_by`-based self-identification (no marker) and `created_time`-based delta polling. This is a net-new architectural pattern with no existing precedent in the codebase.
- **Notion `Kanban Column` select must match arbitrary board columns** — `NotionBackupService.autoCreateDatabase` (lines 164–173) hardcodes 8 column options; the remote setup must instead populate the select from the actual board columns or state mirroring silently fails.
- **`refreshLocalPlanFromRemote` body-render race** — reading the Notion page body at dispatch time and overwriting the local plan file; the remote agent's "write body fully, then flip column" convention is a soft contract, not enforced.
- **Skill generation pipeline** — new skills must be added to `MIRROR_MANIFEST` in `ClaudeCodeMirrorService.ts` (lines 41–98) or the `.claude/skills/` copies are never generated.

---

## Edge-Case & Dependency Audit

### Race Conditions
- **`last_edited_time` / `created_time` minute rounding (research-confirmed).** Notion rounds these **down to the nearest minute**. Multiple updates within the same calendar minute cannot be sequentially ordered by timestamp. With a 30–120s poll and an inclusive `on_or_after` cursor it self-heals via at-least-once + echo guard (same-minute items re-fetched and no-op'd); but the cursor must not advance past the current minute boundary or a miss is possible.
- **Plan-body refresh race.** If the remote agent edits the body and flips the column near-simultaneously, the poll might refresh a half-written body. Mitigate by reading the body at dispatch time (Task 3), accepting the remote agent's convention of "write body fully, then flip column" (document in the orientation skill).
- **Cursor advance vs. dispatch crash.** A crash between dispatch and cursor-advance re-delivers next poll. State → echo-guard no-op; comment → guarded by advance-after-dispatch (existing pattern, lines 299–301).
- **Overlapping polls.** Existing `_polling` guard (lines 179–180) is preserved.

### Security
- **Token stays host-side.** Notion integration token remains in VS Code SecretStorage (`switchboard.notion.apiToken`); the local bridge (`/comment`) posts via the host, never exposing the token to the agent — same model as Linear/ClickUp.
- **`created_by` self-identification** replaces the HTML marker for Notion. If the bot-id fetch fails, `authoredBySelf` is uncomputable (loop risk). Fail safe: skip comment ingestion that cycle and retry the id fetch — never fail loud.

### Side Effects
- **Echo guard under delta.** Outbound pushes bump remote `last_edited_time`, re-surfacing the card; the existing column-equality + short-TTL guard (lines 252–258, `ECHO_GUARD_TTL_MS = 5min`) handles it — keep it.
- **Notion select must contain every column name.** Setup must create/extend the `Kanban Column` select options to match the board's columns, or state can't round-trip.
- **Over-fetch is harmless.** Notion `last_edited_time` bumps on any property edit, not just column changes — the column-equality echo guard no-ops unchanged columns.

### Dependencies & Conflicts
- **Comment row missing its `Plan` relation.** If the remote agent forgets the relation, the poll can't route it — drop with a logged warning (don't guess). The orientation skill must stress setting `Plan`.
- **`add-switchboard-remote-skill.md` path discrepancy.** That older plan instructs writing `.claude/skills/switchboard-remote/SKILL.md` directly + registering in `CLAUDE.md`. That contradicts the generation pipeline (sources live in `.agents/skills/`; `.claude/` is generated by `ClaudeCodeMirrorService.ts`). Author the Linear analog the same way (in `.agents/`) and treat that older plan's path as outdated.
- **`linear-free-tier-auto-archive-on-completion.md`** is a separate, already-planned feature (Complexity 3) that archives Linear issues on plan completion. Notion has no such cap, so no equivalent is needed for Notion. The two plans are independent.
- **Published extension (~4,000 installs).** The new `notion_page_id` column and `notion-*` source types did NOT ship in any released version, so a clean-break schema migration (ALTER TABLE) is acceptable for the column, but existing Linear users' per-card comment cursors must be respected (re-seed on first delta poll).

---

## Dependencies

- `linear-free-tier-auto-archive-on-completion.md` — related plan (Linear free-tier limit; the motivation for the Notion escape hatch). Independent; no execution ordering required.
- `add-switchboard-remote-skill.md` — related plan (Linear remote orientation skill). Its file-path instructions are outdated (see Discrepancy to resolve in Task 6); this plan supersedes them for the skill-authoring convention.

---

## Decisions (made — not open questions)

- **D1 — Provider is a single enum, dropdown-selected, integration-defaulted.** Add `provider: 'linear' | 'notion'` to `RemoteConfig`. The Remote tab dropdown defaults to whichever integration is configured. One active provider.
- **D2 — Notion state uses the existing `Kanban Column` select** that `NotionBackupService` already writes. The remote agent edits it via MCP; the poll mirrors it. No new status property.
- **D3 — Notion comments live in a dedicated "Switchboard Comments" Notion database**, operated by agents over MCP/bridge — not native page comments. Two decisive, design-independent reasons (**both research-confirmed**):
  1. **MCP lowest common denominator.** Database query + create-row + page creation + property updates are core operations every Notion MCP connector supports. Native comment tools are inconsistent/absent — even the official hosted MCP server has a `page_id`-vs-`block_id` bug for inline comments and requires non-default capability toggles. (Research: docs/technical_platform_integration_analysis.md, Finding 5.)
  2. **Delta-poll reliability.** A comments DB row has its own `created_time`, giving one cheap delta query for *all* new comments across *all* cards. **Research-confirmed:** creating a native Notion page comment does NOT bump the page's `last_edited_time` — so a comment-only change would be silently missed by a plans-DB delta query. The Comments DB design is validated as correct. (Research: Finding 4.)

  Self-identification needs no text/HTML marker: rows the **local** agent writes (via the bridge, using Switchboard's integration token) carry `created_by = Switchboard bot` and `From = Switchboard`; rows the **remote** agent writes carry a different author and `From = Remote`. The poll ingests only non-self rows. (Linear keeps its existing native-comment + marker path unchanged.)
- **D4 — Delta polling for both providers.** Replace `fetchIssueUpdates(ids)` with a "changed since cursor" query per provider; intersect results with locally-synced plans by remote id; keep a per-board high-watermark cursor in the DB config table. At-least-once delivery; idempotency from the existing echo guard (state) and comment cursor (comments).
- **D5 — Provider abstraction seam.** A `RemoteProvider` interface lets `RemoteControlService` orchestrate cursors / echo guards / per-card queues provider-agnostically, with `LinearRemoteProvider` and `NotionRemoteProvider` implementations.
- **D6 — Two skills, both authored in `.agents/skills/` (the generated `.claude/skills/` copies are produced by the build — never hand-edit them):**
  - a **remote orientation skill** for the claude.ai session driving Notion via MCP;
  - a **local bridge skill** (`notion_api.md`) for the dispatched local agent to post replies via `/comment`.
- **D7 — The plan body lives in the Notion page body.** On a triggering column change, the poll refreshes the **local plan file** from the page body before dispatch, so the local agent runs against what the remote agent authored (the Notion analog of Linear's issue description → local plan sync).

---

## Architecture

### New seam: `RemoteProvider` interface

```ts
interface RemoteStateDelta { remoteId: string; stateKey: string; }
interface RemoteCommentDelta {
  remoteId: string; commentId: string; body: string;
  createdAt: string;        // ISO; the comment high-watermark
  authoredBySelf: boolean;  // true → Switchboard/local authored → skip on ingest
}
interface RemoteProvider {
  readonly kind: 'linear' | 'notion';
  fetchStateDeltas(sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }>;
  fetchCommentDeltas(sinceCursor: string): Promise<{ deltas: RemoteCommentDelta[]; nextCursor: string }>;
  stateKeyToColumn(stateKey: string): string | undefined;
  refreshLocalPlanFromRemote(remoteId: string): Promise<void>; // D7
}
```

`RemoteControlService` keeps `_echoGuards`, `_queues`, cursor persistence, seed-on-first-poll, and advance-after-dispatch — and loses all direct Linear knowledge.

### Poll cycle (provider-agnostic)

```
1. provider = makeProvider(config.provider)
2. state: { deltas, nextCursor } = provider.fetchStateDeltas(stateCursor)
   - match delta.remoteId → local plan (linearIssueId | notionPageId)
   - column = provider.stateKeyToColumn(delta.stateKey)
   - if column && column !== plan.kanbanColumn && not echo-guarded:
        await provider.refreshLocalPlanFromRemote(remoteId)   // D7
        await onColumnMove(plan, column)
   - persist nextCursor AFTER processing
3. comments: { deltas, nextCursor } = provider.fetchCommentDeltas(commentCursor)
   - drop authoredBySelf; enqueue per-card; onComment; advance cursor after dispatch
```

`PER_POLL_CARD_CAP` becomes a safety backstop, not the primary mechanism.

---

## Proposed Changes

### Task 1 — Plan-record linkage for Notion
**File:** `src/services/KanbanDatabase.ts`
- **Context:** `KanbanPlanRecord` (lines 31–60) has `clickupTaskId?` (line 52) and `linearIssueId?` (line 53) but no Notion field. The `plans` table (CREATE TABLE lines 111–141) has `clickup_task_id` (line 133) and `linear_issue_id` (line 134) columns. The `sourceType` union is at line 46.
- **Logic:**
  - Add `notionPageId?: string;` to `KanbanPlanRecord` (after line 53).
  - Add `'notion-import' | 'notion-automation'` to the `sourceType` union (line 46).
  - **Add a new migration** `MIGRATION_VXX_SQL` (next number after the existing highest) mirroring `MIGRATION_V12_SQL` (lines 241–244): `ALTER TABLE plans ADD COLUMN notion_page_id TEXT DEFAULT ''` + `CREATE INDEX idx_plans_notion_page ON plans(workspace_id, notion_page_id)`. Register it in the migration runner. (Clean-break column add is fine — the column didn't ship — but the ALTER is still required so existing installs get the column.)
  - Add `notion_page_id` to `UPSERT_PLAN_SQL` (lines 549–584) INSERT column list + VALUES placeholders + the `ON CONFLICT` UPDATE set clause (mirror `linear_issue_id = excluded.linear_issue_id` at line 578).
  - Add `notion_page_id` to `PLAN_COLUMNS` (lines 589–593) and to `insertFileDerivedPlan` INSERT (lines 1321–1327).
  - Add `notionPageId` to the row-read mapping in `upsertPlans` (~line 1265–1266) and `restoreFromBackup` (~line 5265–5266).
  - **[REVIEW FIX 2026-06-27]** `restoreFromBackup` was MISSED in the initial implementation — it passed 27 params to the 28-placeholder `UPSERT_PLAN_SQL` (the new `notion_page_id` at column #23), misaligning every field from `worktree_id` onward and breaking backup restore for ALL users (not just Notion). Fixed: added `notionPageId` to the restored record object and `record.notionPageId || '',` at param position 23. Verified placeholder count (28) == param count (28).
  - Add `updateNotionPageIdByPlanFile(planFile, workspaceId, notionPageId)` and deprecated `updateNotionPageId(sessionId, notionPageId)` mirroring `updateLinearIssueIdByPlanFile` (lines 1786–1810) and `updateLinearIssueId` (lines 1812–1817).
- **Edge Cases:** Update the **source-type read normalization** at lines 5760–5766 — currently unknown values silently become `'local'`. Add `'notion-import'` and `'notion-automation'` to the allow-list or Notion plans will be misread as `'local'` and skipped by the poll filter. Tolerate other unknown legacy types (don't throw).

### Task 2 — `RemoteProvider` seam + Linear implementation
**Files:** `src/services/RemoteControlService.ts`, new `src/services/remote/LinearRemoteProvider.ts`
- **Context:** `RemoteControlService` (lines 57–68) depends on `LinearSyncService` via `RemoteControlDeps.getLinearService` (line 49). The `_poll` method (lines 178–232) hardcodes the Linear source-type filter (lines 193–198: `'linear-import' || 'linear-automation'`), loads Linear config + reverses `columnToStateId` (lines 208–209), and calls `linear.fetchIssueUpdates(ids)` (lines 211–213). `RemoteConfig` (lines 23–32) has no `provider` field; `getConfig`/`setConfig` (lines 78–113) persist to config key `'remote.config'` (line 41). Comment cursors are stored per-card under key `'remote.commentCursors'` (line 42, load/advance at lines 313–333).
- **Logic:**
  - Extract the `RemoteProvider` interface (above). Refactor `RemoteControlService` to depend on `RemoteProvider`, not `LinearSyncService`. Replace `RemoteControlDeps.getLinearService` (line 49) with a `getProvider: (kind) => RemoteProvider | null` (or `makeProvider(config)`). Preserve echo guard (`_echoGuards`, lines 62, 242–267), per-card queue (`_queues`, lines 64, 269–309), seed-on-first-poll (lines 283–287), advance-after-dispatch (lines 299–301).
  - Add `provider: 'linear' | 'notion'` to `RemoteConfig` (lines 23–32) and `DEFAULT_REMOTE_CONFIG` (lines 34–39). Update `getConfig` (lines 78–98) and `setConfig` (lines 100–113) to normalize/persist `provider` (default to `'linear'`).
  - Replace the `_poll` body (lines 178–232): build the provider from `config.provider`; call `provider.fetchStateDeltas(stateCursor)` then `provider.fetchCommentDeltas(commentCursor)`. Make the plan filter (lines 193–198) provider-aware: Linear → `linearIssueId` + `'linear-*'` source types; Notion → `notionPageId` + `'notion-*'` source types.
  - **Cursor model:** Introduce per-provider global cursors (config keys e.g. `remote.stateCursor.linear`, `remote.commentCursor.linear`, `remote.stateCursor.notion`, `remote.commentCursor.notion`). Both providers now use **global** cursors — Linear's comment query targets the `comments` entity directly (one global cursor), and Notion's comment query targets the Comments DB (one global cursor). The existing per-card comment cursors (`remote.commentCursors`) are migrated to a single global Linear comment cursor on first delta poll (seed to "now" — no history replay). The `RemoteProvider` interface's `fetchStateDeltas`/`fetchCommentDeltas` each take one opaque cursor string; each provider manages its own cursor serialization internally. On first delta poll for an existing Linear install with no state cursor, **seed** both state + comment cursors to "now" so history isn't replayed (mirror seed-on-first-encounter).
  - `LinearRemoteProvider`: **two separate queries** (research-confirmed — see Research Findings below):
    1. **State deltas:** `issues(filter:{ updatedAt:{ gt: cursor } }, first: 100)` — `updatedAt` filters with `gt`/`gte` are supported (confirmed). Returns state changes. Intersect with local plans by `linearIssueId`.
    2. **Comment deltas:** `comments(filter:{ createdAt:{ gt: commentCursor } }, first: 100)` — querying the **`comments` entity directly** (NOT piggybacking on issues). Each returned comment includes `issue { id }` to match back to the local plan by `linearIssueId`. **This is required because creating a Linear comment does NOT bump the parent issue's `updatedAt`** (research-confirmed wrong assumption — `updatedAt` only reflects issue *property* changes: state, priority, assignee, description, title).
    - `authoredBySelf = hasMarker(body)` (unchanged — Linear keeps the marker path).
    - `stateKeyToColumn` = existing reverse `columnToStateId` (mirror `_reverseStateMap`, lines 234–240).
    - `refreshLocalPlanFromRemote` = existing Linear description→plan sync.
    - The existing per-card comment cursor (`remote.commentCursors`) is replaced by a **single global comment cursor** for the `comments`-entity query — advance it after dispatch, same at-least-once + idempotency model.
- **Edge Cases:** Existing Linear users with per-card comment cursors but no state cursor must re-seed without replaying history. The `comments`-entity query is a structural change from the current per-issue comment fetch — the cursor migrates from per-card to global.

### Task 3 — Notion provider
**Files:** new `src/services/remote/NotionRemoteProvider.ts`; extend `src/services/NotionFetchService.ts` (and/or `NotionBrowseService.ts`)
- **Context:** `NotionFetchService.ts` has `httpRequest` (lines 75–191, with `Retry-After` handling at lines 154–159), `fetchBlocksRecursive` (lines 247–276, 200ms delays at 264/272), and `convertBlocksToMarkdown` (lines 284–417). It has **no database query/filter methods** — those live in `NotionBackupService._queryDatabasePages` (~line 235 filter `{ property:'Plan ID', rich_text:{ equals } }`) and `NotionBrowseService.listDatabasePages` (lines 131–167). No `last_edited_time`/`created_time` timestamp filters exist anywhere. Token is in SecretStorage key `'switchboard.notion.apiToken'` (line 60). The ~350ms limiter is in `NotionBackupService` (lines 74, 267), not `NotionFetchService`.
- **Logic:**
  - Add delta-query methods (place in `NotionFetchService` or a new `NotionRemoteProvider` that composes it): `fetchStateDeltas(sinceCursor)` queries the plans DB with `filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: cursor } }` (research-confirmed syntax — **must NOT include a `"property"` field** or the API returns 400); read each returned page's `Kanban Column` select; intersect with local plans by `notionPageId`. Over-fetch (any property edit bumps `last_edited_time`) is harmless — the column-equality echo guard no-ops unchanged columns.
  - `fetchCommentDeltas(sinceCursor)` queries the **Comments DB** with `filter: { timestamp: "created_time", created_time: { on_or_after: cursor } }` (same syntax rule — no `"property"` field); `authoredBySelf = (created_by.id === ourBotId)` (research-confirmed: `created_by` IS populated with the integration bot's id, matching `/v1/users/me` — fetch once, cache); each row's `Plan` relation → `remoteId`.
  - `stateKeyToColumn`: the select option name **is** the column name (D2) → normalized exact match to a real board column.
  - `refreshLocalPlanFromRemote`: fetch the page body blocks via `fetchBlocksRecursive` → render to markdown via `convertBlocksToMarkdown` → overwrite the local plan file for that plan (D7).
  - Respect the existing ~350ms limiter + retry/`Retry-After` (carry the `NotionBackupService` limiter pattern, or centralize it).
- **Edge Cases:** **Minute-level rounding** (research-confirmed): Notion rounds `created_time` and `last_edited_time` **down to the nearest minute**. Multiple updates in the same calendar minute cannot be sequentially ordered by timestamp. Mitigation: advance the cursor to the max timestamp seen but rely on `on_or_after` (inclusive) + at-least-once + idempotency (echo guard for state, advance-after-dispatch for comments) — items in the same minute are re-fetched and no-op'd. Bot-id fetch failure → skip comment ingestion that cycle, retry the id fetch (never fail loud). **PAT caveat:** if a user configures Notion via a Personal Access Token (PAT) instead of an internal integration token, `/v1/users/me` returns a `person` object (not `bot`), and `created_by` shows that person — the id-match still works, but `type` won't be `"bot"`. Switchboard's token key is `switchboard.notion.apiToken`; confirm at setup which token type is in use.

### Task 4 — "Switchboard Comments" Notion database
**File:** `src/services/NotionBackupService.ts` (or sibling `NotionRemoteSetupService.ts`)
- **Context:** `NotionBackupService.autoCreateDatabase` (lines 150–214) creates the backup DB with a `Kanban Column` select hardcoded to 8 options (lines 164–173: CREATED/BACKLOG/PLAN REVIEWED/LEAD CODED/CODED/REVIEWED/DONE/CLOSED). `_upsertPlanToNotion` (lines 231–252) creates/updates pages but does **not** write page ids back to `KanbanPlanRecord`. Config I/O at lines 32–42.
- **Logic:** On Notion remote **setup** (one-time, from the Remote tab):
  1. Ensure the **plans** DB exists (reuse `autoCreateDatabase`); back up participating plans so each has a page; **write each page id back** to `KanbanPlanRecord.notionPageId` via the new `updateNotionPageIdByPlanFile` (Task 1) — this is the gap `_upsertPlanToNotion` currently leaves open.
  2. Ensure the **Comments** DB exists; create if missing; store `commentsDatabaseId` in remote config. Schema (agent-operated, not human-facing):
     - `Message` (title) — the comment body
     - `Plan` (relation → plans DB) — the target card
     - `From` (select: `Remote` / `Switchboard`) — who wrote it
     - `Created` (created_time) — the comment cursor source
     - `Author` (created_by) — drives `authoredBySelf`
  3. **Populate the `Kanban Column` select from the actual board columns**, not the hardcoded 8 — query the local board's column set and create/extend select options to match, or state mirroring silently fails for any column not in the select.
  4. Seed both cursors (state + comment) to "now" so history is **not** replayed (mirror seed-on-first-encounter).
- **Edge Cases:** Boards with custom column names must round-trip; the setup sync is the only place that can ensure the select matches.

### Task 5 — Bridge: `/comment` route + Notion comment write-back (local agent → Notion)
**Files:** `src/services/LocalApiServer.ts` (`_handlePostComment`, lines 180–218), `src/services/NotionFetchService.ts`
- **Context:** `_handlePostComment` (lines 180–218) guards the provider at line 195 (`provider !== 'linear' && provider !== 'clickup'`), selects the service via ternary at lines 201–203, and calls `service.postManagedComment(id, text)`. `LocalApiServerOptions` (lines 8–14) has `getLinearService` and `getClickUpService` but no `getNotionService`. Route registered at lines 970–971.
- **Logic:**
  - Add `getNotionService: () => NotionFetchService | null;` to `LocalApiServerOptions` (lines 8–14).
  - Extend the provider guard (line 195) to accept `notion`.
  - Replace the ternary (lines 201–203) with a dispatch by provider: linear → `getLinearService()`, clickup → `getClickUpService()`, notion → `getNotionService()`.
  - Notion `postManagedComment(pageId, body)` **inserts a Comments-DB row** (`From = Switchboard`, `Plan` relation set from the page id). No marker (D3 — self-id via `created_by`). Token stays host-side.
- **Edge Cases:** Missing Comments DB id (setup not run) → return a clear 503 error so the agent knows to surface the setup requirement.

### Task 6 — Remote orientation skill (claude.ai + Notion MCP)
**File:** new `.agents/skills/switchboard_remote_notion.md` (generation produces the `.claude/skills/` copy). Register in `.agents/`-sourced `AGENTS.md` (skills table, lines 74–93), **not** the generated `CLAUDE.md`. **Also add to `MIRROR_MANIFEST`** in `src/services/ClaudeCodeMirrorService.ts` (lines 41–98) or the `.claude/skills/` copy is never generated.
- **Logic:** Orient the remote agent on the control surface, step by step:
  1. Locate the Switchboard plans DB (Notion MCP search/query).
  2. Create or find the page for the work; **write the implementation plan into the page body**.
  3. Read the board's column names; set `Kanban Column` to the **trigger** column to dispatch the local agent.
  4. To converse without a state change: **create a Comments-DB row** (`From = Remote`, `Plan` = the page) — routed to the current column's agent.
  5. Read results: **query the Comments DB** for rows `From = Switchboard` (and/or re-read the page) on a later turn.
- Pre-flight: remind the agent remote control must be enabled and the board mapped in the Remote tab; note read-back latency (≤ poll interval).
- **Discrepancy to resolve:** `add-switchboard-remote-skill.md` instructs writing `.claude/skills/switchboard-remote/SKILL.md` directly + registering in `CLAUDE.md`. That contradicts the generation pipeline (sources live in `.agents/skills/`; `.claude/` is generated). Author the Linear analog the same way (in `.agents/`) and treat that older plan's path as outdated.
- **Edge Cases:** The claim that every Notion MCP connector supports database query + create-row (but not necessarily native comments) is an uncertain assumption — verify; if a specific connector lacks create-row, the orientation skill must note a fallback.

### Task 7 — Local bridge skill for Notion replies
**File:** new `.agents/skills/notion_api.md` (mirror `.agents/skills/linear_api.md`, lines 1–48); generation produces the `.claude/skills/` copy. Add to `MIRROR_MANIFEST` (ClaudeCodeMirrorService.ts lines 41–98) + register in `AGENTS.md` (lines 74–93).
- **Logic:** Document the **reply** path only (inbound comments are pushed host-side): `POST /comment` with `provider:"notion"`, `id:<Notion Page ID>`, `body:"..."`. Mirror the `linear_api.md` structure (frontmatter → When to Use → Usage with `sb_api_call.sh` → Post a Comment section).
- Surface the id to the local agent: add a `**Notion Page ID:**` line to plan metadata, generated during Notion setup sync (mirror `**Linear Issue ID:**` in LinearSyncService.ts lines 2345–2357), and update the triager instructions in `agentPromptBuilder.ts` (lines 960–962) to resolve the Notion id and use the `notion_api` skill.
- **Edge Cases:** If a plan has no `Notion Page ID` metadata, the local agent must skip posting and notify the user (mirror the existing ClickUp/Linear guard in agentPromptBuilder.ts).

### Task 8 — Remote tab UI (provider dropdown + Notion setup)
**Files:** `src/webview/kanban.html` (Remote tab, lines 2544–2594), `src/services/KanbanProvider.ts` (config save handlers, lines 5406–5427 — **NOT** `TaskViewerProvider.ts`, which does not handle RemoteConfig)
- **Context:** The Remote tab HTML (lines 2544–2594) hardcodes "Linear" in the subsection header (line 2548) and has no provider dropdown. `remoteCollectConfig()` (lines 6938–6980) collects `boards`/`silentSync`/`pingMode`/`pingFrequencySeconds` but no `provider`. The `change` listener (lines 6962–6969) autosaves. Config messages `getRemoteConfig`/`setRemoteConfig` are handled in `KanbanProvider.ts` (lines 5406–5427), which calls `rc.getConfig()`/`rc.setConfig()` and posts back via `_buildRemoteConfigPayload`.
- **Logic:**
  - Add a **Provider** dropdown (`Linear`/`Notion`) at the top of the Remote tab, defaulting per D1. Persist `provider` into `RemoteConfig` via `remoteCollectConfig` (lines 6938–6980) and the existing autosave path.
  - When Notion is selected, show board checkboxes + a **"Run Notion setup sync"** button (Task 4). No confirm dialogs (project rule — `window.confirm` is a silent no-op in webviews).
  - Update `KanbanProvider.ts` `setRemoteConfig` handler (lines 5406–5427) to pass `provider` through; ensure `_buildRemoteConfigPayload` includes the provider + Notion setup state.
- **Edge Cases:** The dropdown header text "Remote Control (Linear)" (line 2548) must become provider-agnostic or update with the selection.

### Task 9 — Tests
**Files:** `src/test/integrations/notion/`, `src/test/integrations/linear/`
- Delta cursor advance / seed-on-first-poll / no-history-replay (both providers).
- **Linear comment-entity query:** a comment created on an issue does NOT bump the issue's `updatedAt`; the separate `comments(filter:{ createdAt:{ gt: cursor }})` query detects it and matches it back via `issue.id`. (Research-confirmed behavior.)
- **Notion minute-rounding:** two updates in the same minute are both re-fetched on the next poll and no-op'd by idempotency (echo guard / advance-after-dispatch).
- Echo guard still suppresses outbound→inbound state loops under delta polling.
- `authoredBySelf` skips the local agent's own Notion rows (`created_by` = bot) and Linear marker comments.
- `refreshLocalPlanFromRemote` overwrites the local plan from the Notion page body before dispatch.
- Provider dropdown round-trips through `RemoteConfig`.
- Source-type read normalization preserves `'notion-import'`/`'notion-automation'` (does not collapse to `'local'`).

---

## Verification Plan

### Automated Tests
Tests are defined in Task 9 (`src/test/integrations/notion/`, `src/test/integrations/linear/`). Per session directives, automated tests and compilation are **skipped in this planning session** and will be run separately by the user. The test list above defines what the separate run should cover.

### Manual Verification (no compile/test needed)
- Confirm the new `notion_page_id` column is added via migration on an existing install (ALTER TABLE) without data loss.
- Confirm the source-type normalization (KanbanDatabase.ts lines 5760–5766) preserves Notion source types.
- Confirm `MIRROR_MANIFEST` entries produce `.claude/skills/` copies after the generation runs.
- Confirm the `/comment` route accepts `provider:"notion"` and routes to the Notion service.

---

## Edge Cases & Risks (preserved)

- **`last_edited_time` minute rounding (research-confirmed).** Notion rounds `created_time` and `last_edited_time` **down to the nearest minute**. Multiple updates within the same calendar minute cannot be ordered. With a 30–120s poll and inclusive `on_or_after` cursor, same-minute items are re-fetched and no-op'd via at-least-once + echo guard — self-healing, but the cursor cannot advance past the current minute boundary without risking a miss.
- **At-least-once delivery.** A crash between dispatch and cursor-advance re-delivers next poll. State → echo-guard no-op; comment → guarded by advance-after-dispatch.
- **Notion select must contain every column name.** Setup must create/extend the `Kanban Column` select options to match the board's columns, or state can't round-trip.
- **Comment row missing its `Plan` relation.** If the remote agent forgets the relation, the poll can't route it — drop with a logged warning (don't guess). The orientation skill must stress setting `Plan`.
- **Bot-id fetch failure.** If `/v1/users/me` fails, `authoredBySelf` is uncomputable (loop risk). Fail safe: **skip comment ingestion that cycle** and retry the id fetch — never fail loud.
- **Plan-body refresh race.** If the remote agent edits the body and flips the column near-simultaneously, the poll might refresh a half-written body. Mitigate by reading the body at dispatch time (Task 3), accepting the remote agent's convention of "write body fully, then flip column" (document in the orientation skill).
- **Echo guard under delta.** Outbound pushes bump remote `last_edited_time`, re-surfacing the card; the existing column-equality + short-TTL guard handles it — keep it.
- **Linear comment detection (research-confirmed critical).** Creating a Linear comment does NOT bump the issue's `updatedAt`. The original plan's "one query covers state + comments" assumption was wrong. Task 2 now uses a separate `comments`-entity query — if this were missed, all inbound Linear comments would be invisible to the poll.

---

## Out of Scope

- Native Notion page comments — the Comments DB is the committed design, unconditionally.
- Migrating existing cards between providers (re-run setup).
- Running Linear and Notion simultaneously; webhooks; human-facing Notion UX.
- Changes to Linear's auto-archive-on-completion behaviour (separate plan).

---

## Adversarial Synthesis

Key risks: (1) the delta-polling cursor model is a structural break from the existing per-card comment cursors — existing Linear installs must re-seed without replaying history, and the cursor migrates from per-card to global (resolved: both providers use global cursors, see Task 2); (2) the original plan assumed a Linear comment bumps the issue's `updatedAt` — **research proved this wrong**, and the fix (a separate `comments`-entity query) has been applied to Task 2 — missing this would have made all inbound Linear comments invisible; (3) Notion's minute-level timestamp rounding means same-minute updates can't be ordered — mitigated by inclusive `on_or_after` + at-least-once + idempotency; (4) the `Kanban Column` select must be populated from real board columns at setup, not the hardcoded 8, or state mirroring silently fails. The three Notion API behaviors the design hinges on (`last_edited_time`/`created_time` filters, `created_by` bot-id, `/v1/users/me`) are all **research-confirmed** (see `docs/technical_platform_integration_analysis.md`). Remaining open item: the D1 tie-break when both providers are configured (User Review Required). The skill-generation pipeline gap (MIRROR_MANIFEST) and the TaskViewerProvider→KanbanProvider misattribution are mechanical fixes already captured in the tasks.

**Recommendation:** Complexity 8 → Send to Lead Coder.

---

## Code Review Pass (2026-06-27) — Findings, Fixes & Validation

Reviewer-executor pass against the implemented commit `9fbceb4` ("remote automation fixes"). Each task was assessed against this plan as the source of truth. Two code fixes applied; NITs and remaining risks recorded below. Per session directives, compilation (`tsc`/webpack) and automated tests were NOT run — the test suite is to be executed separately by the user.

### Stage 1 — Adversarial findings (severity-tagged)

| Severity | Finding | Location |
|:---|:---|:---|
| **CRITICAL** | `restoreFromBackup` passed 27 params to the 28-placeholder `UPSERT_PLAN_SQL` after `notion_page_id` was added as column #23. The `upsertPlans` caller was updated; `restoreFromBackup` was missed. Result: every column from `worktree_id` onward shifted one slot (`worktree_id`←`isEpic`, `is_epic`←`epicId` [type error: INTEGER←string], `epic_id`←`workspaceName`, `workspace_name`←`projectId`, `project_id`←missing). Backup restore either throws per-plan (silently skipped) or corrupts restored rows. Blast radius: ALL users, not just Notion. Plan Task 1 explicitly required this update. | `src/services/KanbanDatabase.ts:5357` (params) + `:5349` (record) |
| NIT | `MIGRATION_V39_SQL` declared between V12 and V13 in source order, not after V35 (the numerically-last declaration). Functionally correct (top-level const; runner executes it after V38 at line 4944). Cosmetic. | `src/services/KanbanDatabase.ts:252` |
| NIT | V39 migration runner lacks the `BEGIN/COMMIT/ROLLBACK` transaction wrapper its siblings (V34/V35) use. Safe because both ops are idempotent (`ALTER` guarded by duplicate-column check, `CREATE INDEX IF NOT EXISTS`), but stylistically inconsistent. | `src/services/KanbanDatabase.ts:4944-4956` |
| NIT | Dead ternary `insertAt === 1 ? '' : ''` — both branches return `''`, a no-op conditional that inserts a stray leading blank line for H1-less plans and misrepresents intent. **FIXED.** | `src/services/NotionBackupService.ts:327` |
| NIT | `_getCurrentClickUpColumns` is misnamed — it returns LOCAL kanban column ids, not ClickUp's. Now called from the Notion setup path (`runNotionRemoteSetup`), widening the misnomer. Returns correct data. Pre-existing. | `src/services/KanbanProvider.ts:1625`, used at `:5453` |
| NIT | Task 9 lists a test for "`refreshLocalPlanFromRemote` overwrites the local plan from the Notion page body before dispatch." No test asserts the actual file-overwrite (shared test B verifies refresh runs before move; the empty-render guard exists but is untested). | test coverage gap |

### Stage 2 — Synthesis (what was fixed / deferred)

- **Fixed now (CRITICAL):** `restoreFromBackup` — added `notionPageId` to the restored record object and `record.notionPageId || '',` at param position 23. Placeholder count (28) == param count (28), aligned with the `UPSERT_PLAN_SQL` column order.
- **Fixed now (NIT, trivial):** `_writeNotionPageIdMetadata` — collapsed the dead `'' : ''` ternary to a plain `''`. Output semantics preserved (no behavioral change); dead code removed.
- **Deferred (cosmetic/pre-existing):** `MIGRATION_V39_SQL` declaration ordering; V39 transaction-wrapper inconsistency; `_getCurrentClickUpColumns` rename (touches callers, risk of regression — defer to a dedicated cleanup). These are non-functional; flagged, not fixed.
- **Deferred (test gap):** `refreshLocalPlanFromRemote` overwrite assertion — per session directives no tests were written/run this pass; flagged for the user's separate test run.
- **No fix (design-aligned risk):** State cursor advances unconditionally after the delta loop even if `onColumnMove` threw (`RemoteControlService.ts:283-285`), while comments do NOT advance past a failed dispatch (`:349-352`). This matches the plan's stated "persist nextCursor AFTER processing" for state. A transient state-dispatch failure can lose the mirror until the remote card is touched again. Recorded as a remaining risk; changing it would deviate from the source-of-truth design.

### Files changed by this review pass

- `src/services/KanbanDatabase.ts` — `restoreFromBackup`: +`notionPageId` record field, +param #23 (2 lines added).
- `src/services/NotionBackupService.ts` — `_writeNotionPageIdMetadata`: dead ternary collapsed (1 line changed).

### Validation results (manual, no compile/test per directives)

- [x] V39 migration (`ALTER TABLE plans ADD COLUMN notion_page_id TEXT DEFAULT ''` + index) present and idempotent-guarded — existing installs gain the column without data loss.
- [x] Source-type read normalization (`KanbanDatabase.ts:5866`) preserves `'notion-import'`/`'notion-automation'` (does not collapse to `'local'`).
- [x] `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts:56,58`) contains both `notion_api.md` and `switchboard_remote_notion.md` → `.claude/skills/` copies will generate.
- [x] `/comment` route (`LocalApiServer.ts:197,207`) accepts `provider:"notion"` and dispatches to `getNotionService()`; missing-setup surfaces as 503 `notConfigured`.
- [x] `KanbanPlanRecord` interface (`KanbanDatabase.ts:54`) has `notionPageId?: string` → the `restoreFromBackup` fix is type-valid.
- [x] `UPSERT_PLAN_SQL` VALUES placeholders == 28; `restoreFromBackup` params == 28 (post-fix). Aligned.
- [x] No other `INSERT INTO plans` callers were missed (only `plans_v20`/`plans_v11` migration temp tables remain, both unrelated).

### Remaining risks (post-fix)

1. **State-cursor advance-on-failure asymmetry** — a transient `onColumnMove` failure loses the state mirror until the remote card is re-touched (comments retry, state does not). Design-aligned per the plan; not changed.
2. **`postManagedComment` opens `KanbanDatabase.forWorkspace(this._workspaceRoot)`** rather than an injected DB handle (`NotionFetchService.ts`). `forWorkspace` caches instances, so the connection is reused — acceptable, but a DI purist would prefer the DB passed in.
3. **D1 tie-break unresolved** — when both Linear and Notion are configured, the dropdown default is unspecified (the code defaults to `'linear'` in `getConfig`/`setConfig`). User Review item still open.
4. **Test gaps** — `refreshLocalPlanFromRemote` file-overwrite assertion missing (Task 9); user's separate test run should add it.

### Tasks 2–9 spot-check (no issues requiring code change)

- **Task 2 (LinearRemoteProvider):** two separate queries (`issues`/`updatedAt` + `comments`/`createdAt`) confirmed; `authoredBySelf` via marker; reverse state map; global cursor model; seed-on-first-poll. ✓
- **Task 3 (NotionRemoteProvider):** filter shape `{ timestamp, [ts]: { on_or_after } }` with NO `property` field (tested); `created_by` self-id with bot-id fail-safe (skip, retry); `Plan`-relation routing; empty-render clobber guard; ~350ms limiter + paging backstop. ✓
- **Task 4 (NotionBackupService.setupRemoteControl):** plans DB reuse, page-id write-back via `updateNotionPageIdByPlanFile`, `_writeNotionPageIdMetadata`, `_ensureColumnSelectOptions` from real board columns, Comments DB creation, cursor seeding to "now". ✓
- **Task 5 (LocalApiServer):** `getNotionService` added; provider guard accepts `notion`; ternary→dispatch; `notConfigured`→503. ✓
- **Task 6 (switchboard_remote_notion.md):** orientation skill authored in `.agents/skills/`, registered in `AGENTS.md` + `MIRROR_MANIFEST`; covers body-first-then-column convention, `Plan` relation requirement, capability note. ✓
- **Task 7 (notion_api.md):** reply-bridge skill mirrors `linear_api.md`; `**Notion Page ID:**` metadata surfaced; `agentPromptBuilder.ts` triager instructions updated for the notion_api skill + Notion ID line. ✓
- **Task 8 (kanban.html Remote tab):** provider dropdown, Notion setup button + status, `remoteCollectConfig` carries `provider`, `applyRemoteProviderUi` toggles setup block + header, `runNotionRemoteSetup` handler in `KanbanProvider.ts`. ✓
- **Task 9 (tests):** three test files added + registered in `run-integration-tests.js`; cover state/comment delta separation, filter shape, self-id, dedup, seed, advance-after-failure, Notion page-id keying, remote import. (Not run this pass.) ✓ (coverage gap noted above)
- **Provider seam (D5):** `RemoteProvider` interface extracted; `RemoteControlService` is provider-agnostic; echo guard / per-card queue / seed-on-first-poll / advance-after-dispatch preserved. An `importRemotePlan` method was added to the interface beyond the plan's original signature — a reasonable extension for picking up remotely-authored new items. ✓
