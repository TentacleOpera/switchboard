# A Linear key buys you nothing until the board is seeded — add a project-scoped bulk seed

## Goal

Connecting Linear today produces a mirror that reflects only the future. A user
enters a key, enables sync, and nothing appears: the board's existing cards are
never pushed. Driving the board from Linear is therefore impossible on a fresh
connection, which is the entire promise of the integration.

### Problem analysis

A Linear issue is created in exactly three places, all event-driven:

1. `LinearSyncService.debouncedSync` (`:3145`) → `syncPlan` (`:2878`), which fires
   on a **column change** and returns early unless `config.columnToStateId[newColumn]`
   is mapped, `config.setupComplete` is true, `hasApiToken()` is true, and this
   machine holds `syncOwnershipLease.isOwner()`.
2. The feature-creation path — `syncFeatureWithSubtasks` (`:3640`), gated on
   `config.realTimeSyncEnabled === true`.
3. `linearCreateIssue` — one issue, by hand, from the Tickets panel.

> **Superseded:** the line citations `debouncedSync (:3081)`, `syncPlan (:2824)`,
> the feature path at `:3596`, `createIssue (:2925)` and
> `_resolveSingleIncludeProjectId (:766)`.
> **Reason:** `LinearSyncService.ts` grew by ~60 lines when the `planId`
> description anchor landed (`src/services/remote/linearPlanIdAnchor.ts`, wired at
> `:676` and `:2955`). Every cited offset is now stale, and a coder navigating by
> them lands in unrelated code.
> **Replaced with:** `debouncedSync :3145`, `syncPlan :2878`, `syncPlanContent
> :2934`, `syncFeatureWithSubtasks :3640`, `createIssue :2989`, `createIssueSimple
> :3081`, `_buildInitialIssueDescription :669`, `_resolveSingleIncludeProjectId
> :820`, and its near-duplicate public twin `resolveSingleIncludeProjectId :758`.
> `TicketsPanelProvider.syncAllTickets :4078` is unchanged and still correct.

Nothing walks the board. A card that already exists and does not move never
reaches Linear.

> **Superseded:** "On this install that is 577 active plans across 10 named
> projects (largest: *Browser Switchboard*, 212 active) plus 39 unassigned."
> **Reason:** the census was re-measured against the live board on 2026-09-16 via
> `GET /kanban/board` and has drifted; the shape of the argument is unchanged but
> the numbers a coder will size the seed against were wrong.
> **Replaced with:** **620 active plans** — 581 across **9 named projects**
> (largest: *Browser Switchboard*, 212 active) plus **39 unassigned**. Of those
> 620, **110 are features** (`is_feature = 1`). Column distribution: PLAN REVIEWED
> 347, CODE REVIEWED 145, BACKLOG 65, CREATED 48, LEAD CODED 13, CODER CODED 2.
> `select count(*) from plans where linear_issue_id <> ''` still returns **0** —
> confirmed: not one card on this board has ever reached Linear.

Three of those measurements are load-bearing and are used throughout this plan:
**110 features** (structure the seed must not flatten), **347 cards in PLAN
REVIEWED** (a non-stock column whose `columnToStateId` mapping decides whether a
"successful" seed pushes a majority or a minority of the board), and **620 fresh
`updatedAt` bumps** (what the inbound poller sees the instant the seed finishes).

`syncAllTickets` (`TicketsPanelProvider.ts:4078`) is not this. It scans for
`linear_<id>_<slug>.md` ticket documents — files already carrying a remote id —
and pushes their content back. It cannot create an issue for a plan that has
none, and its own comment warns that push is a full description replacement
("~250 overwrites per click") when its sync-status cache is unreachable.

**The structural blocker.** `createIssue` (`:2989`) resolves its destination
project through `_resolveSingleIncludeProjectId(config)` (`:820`), which returns
a project id **only** when `includeProjectNames.length === 1 && excludeProjectNames.length === 0`,
and `undefined` otherwise. There is one project for the whole config. A board
project cannot target its own Linear project because no per-project destination
exists to target.

This plan adds that mapping, and the seed pass that uses it.

### What the code does *not* have yet (verified this pass)

- **`projectCreate` does not exist.** `grep -rn "projectCreate\|ProjectCreateInput" src/`
  returns nothing. The only project surface is `getAvailableProjects()` (`:734`),
  which **reads**. Creating a remote project is net-new GraphQL, not a call to an
  existing helper.
- **`getAvailableProjects()` is unpaginated** — `team(id) { projects { nodes { id name } } }`
  with no `first`/`after` and no `pageInfo`. Linear returns **50 results by
  default** when a connection carries no arguments (confirmed against Linear's
  pagination documentation this pass), so this function has a hard **50-project
  ceiling**. At project 51, "this project does not exist remotely" is
  indistinguishable from "it is on page 2", and a name-based attach silently
  creates a duplicate. Paginating it is a prerequisite of the attach path, not a
  nicety.
- **`_cachedProjects` (`:238`) has no TTL.** It is cleared in exactly one place —
  `saveConfig` (`:408`). On the standalone host, which runs for weeks on the Pi,
  a project created by the seed is invisible to `getAvailableProjects()` and to
  `_resolveProjectIdToName()` (`:774`) for the life of the process.
- **Linear's config is machine-global**, not workspace-scoped: `loadConfig()`
  (`:361`) reads through `GlobalIntegrationConfigService.loadConfig('linear')`.
  `config.teamId` can be re-pointed at a different Linear team without any
  workspace-scoped record changing.
- **Rate-limit handling is unreachable dead code, and the failure is a hard
  fast-fail.** Linear signals a rate limit as **HTTP 400** with
  `errors[0].extensions.code === "RATELIMITED"` — *not* 429 (confirmed against
  Linear's rate-limiting documentation this pass). `_graphqlRequestAttempt`
  rejects on `res.statusCode !== 200` at `:2641`, **before the body is parsed**,
  so the `RATELIMITED` branch at `:2654-2658` — which sets `err.code` and
  `err.isRateLimited` — can never run for a real Linear rate limit. Those two
  properties also have **zero consumers** anywhere in `src/`. The 400 instead
  produces `localizeHttpError`'s `default:` arm (`errorMessages.ts:21`):
  `"Could not fetch from Linear (HTTP 400)."` That string matches none of
  `_transientMarkers` (`:245`), so `_isTransientError` returns false and
  `retry()` (`:3187`) **throws on the first attempt with no backoff at all**.
  Today a rate-limited seed dies immediately behind a message that names nothing.
  `_parseRateLimitHeaders` (`:2504`) does correctly record the headers into
  `_lastRateLimitState`, and **nothing reads it**. `_throttle()` (`:265`)
  enforces a flat 50 ms floor by mutating one shared `_lastRequestTime`, which
  under concurrency is read-modify-write racy and does not bound in-flight
  requests.
- **Linkage lives in two stores.** `plans.linear_issue_id` (schema `:385`) *and*
  the `linear_issue_links` table (schema `:535`, keyed by `plan_path`).
  `createIssue` writes both. `loadSyncMap`/`saveSyncMap` (`:2033`/`:2038`) read
  and write the whole link table, and `replaceAllLinearIssueLinks`
  (`KanbanDatabase.ts:7341`) is a **`DELETE FROM` + re-insert full replace**.

## Metadata

- **Tags:** backend, database, api, feature, reliability
- **Complexity:** 8
- **Project:** Trackers & Tickets

> **Superseded:** `**Complexity:** 6` and `**Tags:** integrations, linear, board-sync, seed`.
> **Reason:** the tags were outside the allowed vocabulary and would not parse. The
> score was set before this pass established the true blast radius: a schema
> migration plus a storage-tier entry, a net-new capability on the provider seam
> whose parity contract asserts an *exact* field-name snapshot across **four**
> providers, net-new GraphQL, a rate-limit story the existing `retry()` cannot
> carry, an inbound-cursor re-baseline to stop a 620-issue echo storm, and a
> second pass to preserve 110 features' structure. That is multi-file
> coordination with data-consistency risk and a new architectural pattern — 8.
> **Replaced with:** Complexity 8, tags drawn from the allowed list.

## User Review Required

**One item, and it does not block coding.** Every fork this pass surfaced was
decided from code already in the repo, from a sibling plan, or from the Linear API
research recorded under `## Resolved Assumptions`. The single residual is whether
an OAuth **app actor** may create a Linear project — see `## Outstanding
Questions`. The plan proceeds under a stated assumption that makes the answer
non-blocking either way (probe once, degrade to attach-an-existing-project on
refusal), so implementation starts now and the answer, when it arrives, deletes a
branch rather than changing the design.

## Complexity Audit

### Routine

- Selecting `status = 'active'` plans for a board project. `KanbanPlanStatus` is a
  closed union — `'active' | 'archived' | 'completed' | 'deleted' | 'missing'`
  (`KanbanDatabase.ts:71`, enforced by `VALID_STATUSES` at `:1718`) — so "active
  only" is one predicate with no judgement in it.
- Persisting `linear_issue_id` per issue. `createIssue` (`:3054`) already does this
  via `db.updateLinearIssueIdByPlanFile` and already throws when the write fails.
- The `{ done, total, skipped }` progress shape. Deliberately identical to the
  shape the ClickUp seed emits, so one UI drives both.
- Bounded concurrency at 4. `syncAllTickets` (`TicketsPanelProvider.ts:4136`,
  `const CONCURRENCY = 4`) is the precedent, verified.

### Complex / Risky

- **The inbound cursor — and the query is sorted on the wrong field.** A completed
  seed leaves 620 issues with a fresh `updatedAt`.
  `LinearRemoteProvider.fetchStateDeltas` (`:79`) queries
  `issues(filter: { updatedAt: { gt: … } }, first: 100)` with **no pagination and
  no `orderBy`**, then sets `nextCursor` to the maximum `updatedAt` it saw
  (`:127`). Linear's documented default ordering for any connection is
  **`createdAt`**, not `updatedAt` (confirmed this pass; `PaginationOrderBy` is an
  enum of exactly `createdAt` and `updatedAt`, with **no direction control**). So
  the query filters on one field, sorts on a second, and cursors on the first —
  the 100 rows returned are *not* the 100 oldest by `updatedAt`, and the maximum
  `updatedAt` among them can sit far ahead of rows that were never returned.
  Those rows are then **permanently excluded** by the advanced cursor. This is not
  a rare interleaving; it is the deterministic behaviour of the query as written,
  and a 620-issue seed is what makes it fire. The ~100 deltas that *do* arrive are
  replayed into the dispatch path.
  **Raising `first` is not the fix.** With the nested `children` connection in
  that selection (a connection multiplies its children by its `first`, defaulting
  to 50), `first: 100` already costs roughly 5,000 complexity points; `first: 250`
  would breach Linear's 10,000-point single-query ceiling. The fix is
  `orderBy: updatedAt` plus real `pageInfo`/`after` pagination — and, for the seed
  specifically, not generating the burst at all (below).
- **The capability seam and its parity contract.** `RemoteProviderCapabilities`
  (`remote/RemoteProvider.ts`) has no seed field, and
  `src/test/provider-capability-parity-contract.test.js` asserts an *exact sorted
  snapshot* of the field names (`:322-331`), enumerates **four** providers
  (`clickup`, `linear`, `notion`, `store` — `:250`), demands a typed exemption for
  every asymmetry, requires `not-yet-built` exemptions to name a plan file **that
  exists on disk** (`:378`), and fails a `true` backed by a stub. It also ratchets
  the removed `boardSyncPush`/`boardSyncRestore` names (`:130`, `:487-506`).
- **Two project resolvers, five write-irrelevant call sites and one that matters.**
  `_resolveSingleIncludeProjectId` (`:820`) is called at `:970`, `:1072`, `:1177`,
  `:3004` and `:3255`; the public twin `resolveSingleIncludeProjectId` (`:758`) is
  called once, from `LinearAutomationService.ts:499`. Only `:3004` (inside
  `createIssue`) is a **write destination**. The rest build inbound `IssueFilter`s.
  Changing the wrong one silently re-scopes what the board *reads*.
- **Feature structure.** 110 of 620 active plans are features. A flat seed produces
  620 sibling issues. `syncFeatureWithSubtasks` (`:3640`) already performs the
  parent-link pass — but returns early unless `config.realTimeSyncEnabled === true`
  (`:3646`), so a deliberate seed on an install with realtime off yields a
  structurally flat mirror and no error.
- **Rate limits at 620 mutations — the budget is fine, the handling is not.**
  Confirmed ceilings: **2,500 requests/hour** for an API key and **5,000/hour**
  for OAuth, against complexity budgets of **3,000,000** and **2,000,000**
  points/hour respectively, with a hard **10,000-point cap on any single query**.
  620 `issueCreate` mutations plus ~9 `projectCreate`s sit comfortably inside all
  of those, so the seed does **not** need to be split across hours. The risk is
  entirely in the handling: per the bullet above, a rate-limit response arrives as
  HTTP 400 and currently fast-fails with no retry. A seed must not inherit that.
- **`saveSyncMap` is a full-table replace.** Under concurrency 4, `createIssue`'s
  `finally` block (`:3069-3072`) does load → delete-one-key → **replace the entire
  table**. A sibling worker's successful `setLinearIssueLink` landing between that
  load and that save is erased — an issue that exists in Linear whose link is gone
  locally, which the next re-run duplicates.
- **A mapping keyed only by `(workspace_id, provider, board_project)` under-keys
  the binding**, because `config.teamId` is machine-global and re-pointable.
- **This is shipped state.** Linear sync exists in released versions, so
  `linear_issue_id`, `linear_issue_links` and the global Linear config all carry
  real install data. Per the repo's migration rule the new table is additive and
  nothing existing is dropped, rewritten or assumed already migrated.

## Edge-Case & Dependency Audit

### Race Conditions

- **Seed vs. the inbound poller.** `RemoteControlService._pollState`
  (`RemoteControlService.ts:685`) reads `remote.stateCursor.linear` from the
  `config` table. A seed running while Remote Control is polling produces the
  truncation described above *and* feeds up to 100 self-caused state deltas into a
  path that moves cards and dispatches agents. The precedent for the fix is in the
  same function: seed-on-first-poll already baselines the cursor to `now` and
  processes nothing, "so an existing board's history isn't replayed as a burst of
  agent runs" (`:687-692`).
- **Seed vs. `saveSyncMap`'s full replace** (above).
- **Seed vs. `debouncedSync`.** A card moved by a human mid-seed enters `syncPlan`,
  finds no issue id yet, and creates a second one. `createIssue`'s `creating_*`
  temp marker (`:3002`) is the existing guard; the seed must write the same marker
  before its own create, or opt out of `createIssue` entirely and hold the marker
  itself.
- **Two concurrent seeds.** Nothing today prevents two seed invocations for the
  same board project.

### Security

- No new credential surface: the seed uses the already-stored Linear token via
  `hasApiToken()`/`getApiToken()`. It must not log the token or the raw GraphQL
  auth header.
- The seed writes plan-file bodies into a third-party SaaS in bulk. That is the
  feature, but it is a one-way, hard-to-undo publication of up to 620 documents,
  so the destination it resolved must be logged with its source (below) and the
  per-project selection must be explicit, never "seed everything by default".
- `hostInlineImages` (`ImageHostingHelper.ts:99`) uploads every inline image found
  in a description as a Linear attachment. At seed scale that publishes the
  board's images too. This is correct behaviour, not a leak, but it is a cost and
  a volume multiplier that must be stated rather than discovered.

### Side Effects

- **`_cachedProjects` goes stale the moment the seed creates a project.** Anything
  rendering the binding by name (`_resolveProjectIdToName :774`) answers `null`
  until the host restarts or `saveConfig` runs.
- **The Tickets panel and "Import All as Plans" stay single-project.** `queryIssues`
  (`:970`) and `importIssuesFromLinear` (`:3255`) scope their `IssueFilter` through
  `_resolveSingleIncludeProjectId`. After a 9-project seed those surfaces still
  show one project. Remote Control's own pull is **not** affected —
  `fetchStateDeltas` and `reconcileLiveIds` are workspace-wide, verified at
  `LinearRemoteProvider.ts:79` and `:301`. This asymmetry is real, is out of this
  plan's scope to fix, and must be written down rather than left to be found.
- **Backlog asymmetry.** 65 active cards sit in BACKLOG. `excludeBacklog` defaults
  to `true` but is **inbound-only** — it is read at `:3384` (import) and
  `LinearAutomationService.ts:569`, never on any outbound path. So the seed pushes
  backlog cards that the puller will then ignore. Stated assumption: **the seed
  pushes them**, because the seed's contract is "the live board", and silently
  dropping 65 cards to match an inbound filter is exactly the invisible-omission
  failure this feature exists to end.
- **Deleted/archived/completed plans are never seeded**, so nothing in Linear is
  created for board history. Re-running after a card is archived does not remove
  its issue — the seed is additive and never deletes remotely.

### Dependencies & Conflicts

- **`provider-capability-parity-contract.test.js` will fail on the first commit
  that touches `RemoteProviderCapabilities`** unless the snapshot, the four
  providers' declarations, the exemption table and a stub-probe are updated in the
  same change. Treat it as part of the diff, not as a follow-up.
- **Verb surface.** Any new webview verb must be added to `protocol-catalog.json`
  and regenerated into `src/generated/verbAllowlist.ts` via `npm run
  catalog:generate`; `scripts/check-protocol-parity.js` fails on drift. **This plan
  adds no verbs** — the panel surface and its verbs belong to
  *"The seed needs a surface: project selection in the Linear and Connections
  panels"*. This plan ships the engine and the seam only.
- **Storage tier.** A new table that is in neither `SHARED_TABLES` nor
  `LOCAL_TABLES` (`src/services/storageTiers.ts:19`/`:44`) is silently excluded
  from the board snapshot, the state serializers and the export formats —
  `linear_issue_links` is already in exactly that limbo. The mapping table must be
  placed deliberately.
- **Sibling plans.** `seed-board-projects-to-clickup-lists.md` consumes this
  plan's mapping table; `clickup-columns-are-statuses-not-lists.md` unblocks
  ClickUp's list axis; `seed-controls-in-linear-and-connections-panels.md` is the
  UI. `linear-board-restore-and-planid-anchor.md` is **CANCELLED** — do not
  resurrect `boardSyncPush`/`boardSyncRestore`; its `planId` anchor half
  *did* land and is live in `src/services/remote/linearPlanIdAnchor.ts`.

## Dependencies

No `sess_` session dependencies — this plan was not derived from a prior session
transcript. The dependencies that exist are on files in this repo:

- `.switchboard/plans/seed-controls-in-linear-and-connections-panels.md` — the UI
  that drives this engine. Downstream of this plan; owns all webview verbs.
- `.switchboard/plans/seed-board-projects-to-clickup-lists.md` — consumes the
  mapping table introduced here. Must not duplicate it per provider.
- `.switchboard/plans/linear-board-restore-and-planid-anchor.md` — **cancelled**;
  its `planId` anchor shipped and this plan reuses it.
- `src/services/remote/linearPlanIdAnchor.ts` — already landed; the seed reuses
  `parseLinearPlanIdAnchor` rather than inventing a second identity scheme.

## Adversarial Synthesis

**Key risks:** (1) the seed's own 620 `updatedAt` bumps overrun the inbound
poller — `fetchStateDeltas` is `first: 100` and unpaginated and advances its
cursor to the newest row it saw, so ~520 cards lose their first inbound signal
permanently while the 100 that arrive replay into the dispatch path; (2) the
unmapped-column skip is the *majority* case on this board, not an edge — 347 of
620 cards sit in PLAN REVIEWED — so a seed can report success and still mirror a
minority of the board; (3) 110 of 620 plans are features, and a flat seed
destroys that structure while `syncFeatureWithSubtasks` sits unused behind a
`realTimeSyncEnabled` gate; (4) Linear reports a rate limit as **HTTP 400**, which
`_graphqlRequestAttempt` rejects before parsing the body, so the existing
`RATELIMITED` detection is unreachable and `retry()` hard-fails on the first
attempt — a seed inheriting that dies mid-run behind `"Could not fetch from Linear
(HTTP 400)."` **Mitigations:** the classifier is fixed to parse the body of a
non-200 JSON response before rejecting, and the seed paces off
`_lastRateLimitState` (whose reset fields are epoch **milliseconds**); the seed
re-baselines
`remote.stateCursor.linear` to its own completion time (the exact move
seed-on-first-poll already makes at `RemoteControlService.ts:687`); the
unmapped-column set is surfaced as a **pre-flight count before any write**, not
only as an after-the-fact report; and a second pass runs `syncFeatureWithSubtasks`
per seeded feature with the realtime gate bypassed for the deliberate-seed caller.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — the durable destination mapping

**Context.** There is no per-board-project remote destination anywhere in the
schema. The closest precedent is `linear_managed_artifacts` (`:625`), whose
doc-comment states the discipline this table inherits: *"provenance for tracker
objects Switchboard itself created … the reconciler may only ever remove what this
table records; a link or membership absent here was drawn by a person in Linear
and is not ours to delete."*

**Logic.** One row per `(workspace_id, provider, remote_team_id, board_project)`
recording the remote project/list id, the remote name captured at bind time, the
origin (`created` | `attached`), and `seeded_at`. The row is what makes a re-run
idempotent: a project with a row seeds into its existing remote project; a project
without one creates a new remote project and writes the row.

`remote_team_id` is part of the key, not a payload column. `config.teamId` lives in
the machine-global integration config (`loadConfig :361` →
`GlobalIntegrationConfigService`), so it can be re-pointed at a different Linear
team while every workspace-scoped value stays put. Without the team on the key, a
retargeted config resolves a stale row to a project id in a team the install no
longer uses — a destination that looks configured and is wrong, which is precisely
the failure the repo's fallback rule exists to prevent.

**Implementation.**

- Take the **next free migration version at implementation time**. As of this pass
  the runner ends at **V81** (`:11203`, `_runMigrationV81` at `:12548`), so V82 is
  the expected number — confirm before writing, and do not reserve it here.
- Strictly additive: `CREATE TABLE IF NOT EXISTS` plus its workspace index, in the
  same shape as the V80 `linear_managed_artifacts` block. Nothing is read,
  rewritten or deleted, so there is no data to preserve and no prior-migration
  assumption to make.
- Add the table to `SHARED_TABLES` in `src/services/storageTiers.ts:19`. It is
  board state — which board project points at which remote project — not machine
  runtime, and it must travel with the Board store. Do **not** leave it untiered:
  `linear_issue_links` is untiered today and is consequently absent from every
  snapshot and export, which is a bug this plan should not copy.
- Accessors return `{ value, source }`, never a bare id. `source` is one of
  `'mapping'` (a row answered), `'include-project'` (the legacy
  `_resolveSingleIncludeProjectId` fallback answered) or `'none'`. Log the source
  at the call site. Per the repo's fallback rule, a destination that came from a
  mapping row and one guessed from `includeProjectNames` must never be
  indistinguishable — "which store answered?" has to be answerable after the fact,
  and a wrong answer here silently files a card in the wrong Linear project.

**Edge cases.** A row whose `remote_project_id` no longer resolves in Linear
(project deleted remotely) must surface as a **failed** seed naming the dead
binding, never as a silent fall-through to create-a-new-one — an auto-recreate on
a deleted project quietly doubles the mirror. A row whose `remote_project_name`
differs from Linear's current name is **normal** (someone renamed it); the id
wins, and the stored name is refreshed as a display value only.

### `src/services/LinearSyncService.ts` — project creation, the seed pass, the destination resolver

**Context.** `createIssue` (`:2989`) is the only issue-create path that anchors,
links and persists — but it resolves its destination through
`_resolveSingleIncludeProjectId` (`:3004`), performs the `creating_*` temp-marker
dance (`:3002`, `:3069`), and returns `void`. `createIssueSimple` (`:3081`) already
accepts `projectId` **and** `parentId`, already applies the switchboard label, and
**returns `{ id, identifier }`** — but it writes no anchor and persists no link.

**Logic — four pieces.**

**1. `createLinearProject(name, teamId)` — net-new.** No `projectCreate` mutation
exists anywhere in `src/`. Add one. The input shape is confirmed: `ProjectCreateInput`
requires **`name`** and **`teamIds: [String!]!`** — a project belongs to one or more
teams and cannot be created without at least one, so pass `[config.teamId]`:

```graphql
mutation($input: ProjectCreateInput!) {
  projectCreate(input: $input) { success project { id name url } }
}
```

> **Trap for the implementer:** the `linear/linear-node-sdk` `schema.md` that
> search engines rank highly for `ProjectCreateInput` is an **archived, pre-Relay
> schema**. It lists `key` and `organizationId` and has no `teamIds` at all, and
> its `issues` field takes no arguments. It does not describe the current API.
> Use the live schema (GraphOS Studio / introspection), not that file.

Clear `_cachedProjects` (`:238`)
immediately after a successful create; it has no TTL and is otherwise cleared only
by `saveConfig` (`:408`), so on the long-lived standalone host every
`getAvailableProjects()`/`_resolveProjectIdToName()` read would keep denying the
project's existence for the rest of the process's life.

**2. `resolveSeedDestination(boardProject, config): { value, source }`.** Mapping
row first; `_resolveSingleIncludeProjectId` second; `'none'` third. This is the
single resolver both the seed and `createIssue` call.

**3. `seedProjectToRemote(boardProject, options)`.**

- Selects plans with `status = 'active'` and `project = <boardProject>`.
  **Archived, completed, missing and deleted plans are never seeded** — the seed
  is the live board, not its history.
- Skips any plan that already has a non-empty `linear_issue_id` (already linked).
  **Check both stores**: `plans.linear_issue_id` *and* `linear_issue_links`
  (`getLinearIssueLinkByPlan`). `createIssue` writes both, so a plan present in
  either is linked; consulting only one re-creates issues that already exist.
  Record which store answered.
- **Pre-flight, before any remote write:** count plans whose `kanban_column` has no
  `columnToStateId` mapping and return that set to the caller *first*. On this
  board 347 cards sit in PLAN REVIEWED and 145 in CODE REVIEWED; if those columns
  are unmapped the seed is a no-op for 79% of the board, and a user must learn that
  before 130 issues are created, not after.
- **Resolve-before-create by anchor.** Before creating, look for an existing issue
  carrying this plan's `[Switchboard] Plan: {planId}` footer and attach to it
  instead. `parseLinearPlanIdAnchor` (`remote/linearPlanIdAnchor.ts:43`) already
  parses it and `fetchStateDeltas` already strips it on the way in. This is the
  ClickUp seed's step 3 (`_findTaskByPlanId` before create) — Linear can now do the
  same, and without it a lost local link duplicates the issue.
- Creates the remote project when the mapping row is absent, attaches when present,
  and writes the row with its origin.
- Creates one issue per plan and persists `linear_issue_id` immediately, per issue
  — not batched at the end. A crash mid-seed must leave every issue created so far
  linked, so the re-run resumes instead of duplicating.
- Bounded concurrency (4, matching `syncAllTickets`'s existing choice —
  `TicketsPanelProvider.ts:4136`) with Linear's rate-limit backoff, and a progress
  callback of `{ done, total, skipped }`.
- **On completion, re-baseline the inbound state cursor.** Write
  `remote.stateCursor.linear` (`RemoteControlService.stateCursorKey`, stored via
  `db.setConfig`) to the seed's completion timestamp. Every one of those 620
  `updatedAt` bumps is Switchboard's own write; replaying them is meaningless at
  best and a burst of agent dispatches at worst. This is the identical move
  seed-on-first-poll already makes at `RemoteControlService.ts:687-692` for
  identical reasons. Without it, `fetchStateDeltas`'s unpaginated `first: 100`
  (`LinearRemoteProvider.ts:79`) plus its `nextCursor = max(updatedAt)` (`:127`)
  drops ~520 cards' first inbound signal permanently.
- **Second pass: feature structure.** For each seeded plan with `is_feature = 1`,
  call `syncFeatureWithSubtasks` (`:3640`) after the flat pass, so 110 features
  regain their parent/child shape. Its `config.realTimeSyncEnabled !== true` early
  return (`:3646`) must be bypassed for this deliberate-seed caller — a background
  toggle has no business deciding whether an explicit user action preserves
  structure. Subtasks whose parent was skipped (unmapped column, already linked
  elsewhere) are reported, not silently unparented.

**Clarification — which create primitive.** The seed calls `createIssueSimple`
(`:3081`) with the resolved `projectId`, not `createIssue`. `createIssueSimple`
already takes `projectId` and `parentId` and returns the issue id the seed needs
for its per-issue link write, and it avoids `createIssue`'s baked-in
`_resolveSingleIncludeProjectId` destination. The seed therefore owns three things
`createIssue` would otherwise have done, and must do all three: append the
`planId` anchor to the description (`buildLinearPlanIdAnchor`), hold the
`creating_*` temp marker across the create so a concurrent `debouncedSync` cannot
double-create, and persist `linear_issue_id` on success. This is implementation
detail implied by the existing requirement "creates one issue per plan and
persists `linear_issue_id` immediately" — not new scope.

**4. `createIssue`'s destination (`:3004`).** Replace the direct
`_resolveSingleIncludeProjectId(config)` call with `resolveSeedDestination`, so a
seeded board project's later column moves land in its bound project.
`_resolveSingleIncludeProjectId` becomes the fallback *after* a mapping lookup, not
the only resolver. This is the half that makes the seed durable rather than a
one-time snapshot: without it, the first column change after a seed sends the card
to the config's single `includeProjectNames` project and the 1:1 breaks
immediately.

**Change `:3004` and nothing else.** The other four private-resolver call sites —
`:970` (`queryIssues`), `:1072` (`fetchAllIssueIds`), `:1177`, `:3255`
(`importIssuesFromLinear`) — and the public twin's single caller
(`LinearAutomationService.ts:499`) all build **inbound `IssueFilter`s**. Re-scoping
them would change what the board *reads*, which is not this plan's job and is a
silent behaviour change. Leave a comment at `:820` saying so, so the next reader
does not "fix" the inconsistency.

**Edge cases.**
- **Rate limiting at 620 mutations — fix the classifier before the seed can rely
  on it.** Linear answers a rate limit with **HTTP 400** and
  `errors[0].extensions.code === "RATELIMITED"`, never 429.
  `_graphqlRequestAttempt` rejects on `statusCode !== 200` at `:2641` before
  parsing the body, so the existing `RATELIMITED` detection at `:2654-2658` is
  unreachable and `retry()` fast-fails on the first attempt. Three concrete
  changes, in order:
  1. At `:2641`, parse the body **before** rejecting on a non-200 status when the
     response is JSON, so a 400 carrying `extensions.code === "RATELIMITED"` is
     classified as rate-limited rather than as `"Could not fetch from Linear
     (HTTP 400)."` Keep the existing localized message for every other non-200.
  2. Make `_isTransientError` (`:260`) honour `err.isRateLimited` / `err.code ===
     'RATELIMITED'` directly rather than string-matching the message — those two
     properties are set at `:2657-2658` and have **no consumers today**.
  3. Have the seed's pacer read `_lastRateLimitState`, which
     `_parseRateLimitHeaders` (`:2504`) already populates and nothing consumes,
     and pause until `requestsReset` / `complexityReset` when `requestsRemaining`
     or `complexityRemaining` runs low. **Both reset fields are UTC epoch
     _milliseconds_** (confirmed against Linear's documentation this pass) — no
     unit conversion, and no `* 1000`.

  Budget is not the constraint: 2,500 requests/hour on an API key, 5,000/hour on
  OAuth, against 3,000,000 / 2,000,000 complexity points/hour. 620 creates fit in
  one pass with room to spare. Step 1 is what stops a transient limit from killing
  the run.
- `_throttle()` (`:265`) is a shared read-modify-write on `_lastRequestTime` and
  does not bound concurrent in-flight requests; the seed's own concurrency limiter
  is the real bound, not the throttle.
- `saveSyncMap` (`:2038`) is a **full table replace**. The seed must never call it,
  and must use `setLinearIssueLink` (per-row upsert) exclusively. If the seed
  routes through `createIssue`, its `finally` cleanup (`:3069-3072`) performs
  load → delete-one → replace-all, and under concurrency 4 that erases a sibling
  worker's link. Using `createIssueSimple` and owning the marker avoids this path
  entirely; if `createIssue` is used anyway, that cleanup must be converted to a
  targeted single-row delete first.
- `hostInlineImages` uploads every inline image per issue. At 620 issues this is
  the dominant cost and the dominant failure surface. An image-upload failure must
  not fail the issue — `createIssueSimple` already warns and continues (`:3130`).
- A plan whose `plan_file` is missing on disk: `_buildInitialIssueDescription`
  (`:669`) already falls back to `_buildFallbackDescription` + anchor and logs.
  Acceptable; the anchor still lands, so the card stays matchable.
- `createIssueSimple` throws when `config.setupComplete`/`teamId` are absent. The
  seed must fail fast on that once, up front, not 620 times.
- The seed does not check `syncOwnershipLease.isOwner()` (`syncPlan :2879` does).
  Stated assumption: **the seed is a deliberate local action and does not require
  the lease.** On the Pi appliance there is one host and it always holds the lease;
  requiring it would block the only machine that can run the seed if a stale lease
  is held. Log the lease holder at seed start so a surprise is diagnosable.

### `src/services/remote/RemoteProvider.ts` + the four providers — the seed capability

**Context.** `seed-controls-in-linear-and-connections-panels.md` requires the
control to be "provider-agnostic and must not branch on kind". The seam is the only
way to honour that, and `RemoteProvider.ts`'s own doc-comment says callers must
"gate on these, never on `kind`".

**Logic.** Add **one** capability field and **one** interface method. Name them for
what they are — `seedProjects` / `seedBoardProject(boardProject, progress?)` — and
**not** `boardPush`/`boardRestore`/`boardSyncPush`/`boardSyncRestore`. Those four
names are ratcheted dead by `provider-capability-parity-contract.test.js:130` and
`:487-506`; the test's own comment says *"a seed belongs behind its own capability
with its own mapping"*. This is that capability.

**Implementation.**
- Declare `seedProjects: true` on `LinearRemoteProvider` (`:59`), `false` on
  `ClickUpRemoteProvider`, `NotionRemoteProvider` and `StoreRemoteProvider`.
- Implement `seedBoardProject` on `LinearRemoteProvider` as a thin delegate to
  `LinearSyncService.seedProjectToRemote`, matching how `pushState`/`pushContent`
  delegate today.
- Mark the field optional (`seedProjects?: boolean`) only if the other three are
  genuinely to omit it; the contract's check 3 treats an absent **required** field
  as a failure and an absent optional one as "never asked". Preferring explicit
  `false` on all four is the honest declaration and needs no optionality.

**Edge cases.** The store provider is a one-way `plan_inbox` queue with no project
concept — its exemption is `platform-limitation`, and must carry **no** `plan`
key (`:381` asserts this).

### `src/test/provider-capability-parity-contract.test.js` — update in the same commit

**Context.** This suite fails the moment `RemoteProviderCapabilities` gains a
field. That is deliberate: *"a capability cannot slip in unenumerated."*

**Implementation.**
- Add `'seedProjects'` to the exact sorted snapshot at `:325-330` (it sorts between
  `pullState` and `push`; recompute rather than guess).
- Add exemptions: `clickup` → `not-yet-built`, `plan:
  '.switchboard/plans/seed-board-projects-to-clickup-lists.md'` (**the file exists
  on disk — `:378` asserts existence, so confirm before committing**); `notion` →
  `not-yet-built` naming an existing file (the board-sync parity feature file
  already referenced as `FEATURE_PARITY` at `:77` is the honest choice, since no
  Notion seed plan exists); `store` → `platform-limitation`, no `plan` key.
- Add a bespoke stub-probe for `seedProjects` alongside the `push` and `archive`
  probes (`:439`, `:453`): a declared-`true` seed must produce a remote write on a
  mocked provider, a declared-`false` one must not. Check 4's entire purpose is
  that a `true` cannot hide a stub.
- Leave the `REMOVED_BOARD_SYNC_*` ratchets untouched.

**Edge cases.** The provider list is discovered from source by scanning for
`implements RemoteProvider` (`:271`), so no new provider is being added and that
check stays green.

### `src/standalone/bootstrap.ts` — composition root

**Context.** `LinearSyncService` is already constructed at `:950` and handed out by
`getLinearService` (`:953`), `:1639`, `:1798` and `:4775`. `LinearRemoteProvider`
is already reachable through the remote wiring.

**Logic.** The seed needs no new service seam — it is a method on a service the
standalone host already builds and a method on a provider it already constructs.
Verify by inspection that nothing new needs an `engine.setX(...)`-style wiring
call; if the seed grows a progress callback that the host must supply, that
callback **is** a composition-root seam and its absence and its presence look
identical at runtime, which is the exact trap CLAUDE.md documents.

**Scope.** Standalone host only. Per the cutover, the extension is not wired for
this and that is the intended state, not a divergence. Do not add a second
implementation in `src/extension.ts`.

**Edge cases.** None — this section is a verification obligation, not a change.

## Verification Plan

### Automated Tests

1. A board project with no mapping row seeds into a newly created Linear project;
   the mapping row records `created` and the issue count matches the project's
   active plan count.
2. Re-running the same seed creates **zero** new issues and **zero** new projects.
3. A seed interrupted after N issues resumes on re-run and finishes with exactly
   one issue per active plan — no duplicates.
4. Archived, completed, missing and deleted plans in a seeded project have no
   Linear issue.
5. A plan in an unmapped column is reported in the skipped set **before any remote
   write**, not silently absent and not only in the after-the-fact report.
6. After a seed, moving a card in that project creates/updates its issue in the
   **mapped** project, not in `includeProjectNames[0]`.
7. Renaming the Linear project does not re-bind or re-create — the mapping is by
   id. Renaming it also refreshes the stored display name without touching the id.
8. A plan whose local link was lost but whose issue still carries the
   `[Switchboard] Plan: {planId}` anchor is **attached**, not duplicated.
9. A plan linked in `linear_issue_links` but not in `plans.linear_issue_id` (and
   vice versa) is treated as linked and skipped.
10. After a completed seed, `remote.stateCursor.linear` is at or past the seed's
    last write, and the next `_pollState` yields zero deltas for the seeded issues.
11. Seeding a project containing a feature and its subtasks produces a Linear
    parent issue with those subtasks as children — with `realTimeSyncEnabled` set
    to `false`.
12. A mapping row whose `remote_team_id` differs from the current `config.teamId`
    does **not** resolve as a destination.
13. `provider-capability-parity-contract.test.js` passes with `seedProjects`
    enumerated, three typed exemptions, and the stub-probe green.
14. **A stubbed HTTP 400 whose body carries `extensions.code === "RATELIMITED"`
    is classified as rate-limited, retried after a pause, and succeeds** — not
    thrown on the first attempt as `"Could not fetch from Linear (HTTP 400)."`
    This is the regression test for the unreachable branch at `:2654-2658`.
    A 400 *without* that code must still surface the localized message unchanged.
15. `_lastRateLimitState.requestsReset` is treated as **epoch milliseconds** — a
    pause computed from it must not be ~1000× too short or too long.
16. Two concurrent creates do not lose a link — assert the seed never calls
    `saveSyncMap`/`replaceAllLinearIssueLinks`.
17. **`fetchStateDeltas` passes `orderBy: updatedAt` and paginates.** Given a
    fixture of 250 issues all newer than the cursor, every one is returned across
    pages and the cursor lands on the true maximum `updatedAt` — none are skipped.
18. `createLinearProject` sends `teamIds` and fails loudly, naming the API error
    and the attach-instead remedy, when the API refuses project creation.

### Goal Invariants

- `grep -rn "projectCreate" src/services/LinearSyncService.ts` resolves to exactly
  one mutation, and it is followed by a `this._cachedProjects = null` assignment.
- The mapping table name appears in `SHARED_TABLES` in
  `src/services/storageTiers.ts` — zero occurrences means it is untiered and
  silently absent from every snapshot and export.
- The mapping accessor's return type is an object carrying a `source` field; a bare
  `Promise<string | undefined>` destination resolver is a schema violation of the
  repo's fallback rule.
- `'seedProjects'` appears in the capability snapshot array in
  `src/test/provider-capability-parity-contract.test.js`, and the count of
  `EXEMPTIONS` rows whose `capability === 'seedProjects'` is exactly **3**.
- `grep -c "boardSyncPush\|boardSyncRestore\|boardPush\|boardRestore"` over
  `src/services/remote/` and `src/services/StoreRemoteProvider.ts` is **0** — the
  removed pair must not return under the seed's banner (paired positive: the seed
  is instead resolvable as `seedBoardProject` on `LinearRemoteProvider`).
- In `src/services/LinearSyncService.ts`, `_resolveSingleIncludeProjectId` is
  called at exactly **four** sites after the change (the three inbound-filter sites
  plus `importIssuesFromLinear`), and `createIssue`'s destination line calls
  `resolveSeedDestination` instead.
- `src/extension.ts` contains **zero** references to the seed symbols (paired
  positive: `src/standalone/bootstrap.ts` resolves the seeding provider) — the
  cutover means standalone-only, and a second implementation in the legacy host is
  throwaway work.
- The seed module contains a write to `remote.stateCursor.linear`; its absence is
  the 520-dropped-cards bug with no visible symptom.
- `grep -n "orderBy" src/services/remote/LinearRemoteProvider.ts` finds
  `orderBy: updatedAt` on the `fetchStateDeltas` query, and that query's selection
  includes `pageInfo { hasNextPage endCursor }` — a `first:`-only query filtering
  on `updatedAt` while sorting on Linear's `createdAt` default is the bug.
- `grep -n "statusCode !== 200" src/services/LinearSyncService.ts` is preceded by
  a JSON body parse that can classify `RATELIMITED`, and
  `grep -rn "isRateLimited" src/` returns **more than the two assignment lines at
  `:2657-2658`** — a set-but-never-read flag is the defect.
- `grep -n "teamIds" src/services/LinearSyncService.ts` appears in the
  `projectCreate` mutation's input; `ProjectCreateInput` rejects a project with no
  team, so its absence fails every create.

## Resolved Assumptions

These were flagged as external unknowns and have since been **researched and
closed** against Linear's official developer documentation. They are recorded here
as settled facts — do not re-open them, and do not commission research on them.

1. **`ProjectCreateInput` requires `name` and `teamIds`.** `teamIds` is
   `[String!]!` — a project must be associated with at least one team. Pass
   `[config.teamId]`. **Do not trust `linear/linear-node-sdk`'s `schema.md`**: it
   is an archived pre-Relay schema listing `key`/`organizationId` and no
   `teamIds`, and search engines rank it highly.

2. **Rate limits and header units.** Requests/hour: **2,500** (API key, per user),
   **5,000** (OAuth, per user or app user), 600 (unauthenticated, per IP).
   Complexity points/hour: **3,000,000** (API key), **2,000,000** (OAuth),
   100,000 (unauthenticated). **Any single query is capped at 10,000 points.**
   `X-RateLimit-Requests-Reset` and `X-RateLimit-Complexity-Reset` are
   **UTC epoch milliseconds**. A 620-issue seed fits inside a single hour's budget
   on either credential — the constraint is handling, not volume.

3. **A rate limit arrives as HTTP 400, not 429**, with
   `errors[0].extensions.code === "RATELIMITED"` in the body. This makes the
   existing detection at `LinearSyncService.ts:2654-2658` unreachable, because
   `:2641` rejects on `statusCode !== 200` before parsing. Rate-limit rejections
   happen *before* execution, so retrying them is safe for mutations too. See the
   three-step fix under the `LinearSyncService.ts` edge cases.

4. **Connection defaults and ordering.** A connection with no arguments returns
   **50** results. The default ordering of every connection is **`createdAt`**;
   `PaginationOrderBy` is an enum of exactly `createdAt` and `updatedAt` and
   carries **no direction control**. This is what makes
   `fetchStateDeltas`'s filter-on-`updatedAt` / sort-on-`createdAt` /
   cursor-on-`updatedAt` combination lose rows deterministically, and it is what
   puts a hard 50-project ceiling on `getAvailableProjects()`.

5. **Raising `first` is not an escape from the 100-row window.** With the nested
   `children` connection in `fetchStateDeltas`'s selection (a connection
   multiplies its children by its `first`, default 50), `first: 100` already costs
   roughly 5,000 complexity points. `first: 250` would breach the 10,000-point
   single-query ceiling. Pagination via `pageInfo`/`after` is the only correct fix.

## Outstanding Questions

- **[user]** Can an OAuth **app actor** (`actor=app`) create a Linear project with
  the `write` scope this integration requests? Linear documents that app actors
  can create issues and comments, that they **cannot request `admin` scope**, and
  that their team access is granted and revocable by workspace admins — but no
  official source states whether `projectCreate` is permitted or admin-gated. This
  could not be closed from documentation and is not answerable from this
  repository. *Proceeding on the assumption that it may be refused:* the seed
  **probes** project creation once, and on refusal fails that project with the
  literal API error plus a named remedy — attach to an existing Linear project via
  the mapping row, which needs no create permission — rather than aborting the run
  or silently seeding into the wrong destination. Personal-API-key installs are
  unaffected either way. If the answer turns out to be "yes, always", the probe
  costs one mutation and nothing else changes.
- **[research]** Does `issueUpdate(input: { projectId })` move an existing issue
  between projects, and are there cross-team restrictions? The field is present on
  `IssueUpdateInput` and the pattern is widely used in third-party clients, but no
  official Linear source confirms the move semantics or its limits. *Proceeding on
  the assumption that it works within a single team:* this affects only the
  **repair** path for a card seeded to the wrong destination, which is not on the
  critical path. If it does not work, repair is archive-and-recreate, and the
  mapping row makes the mis-binding visible either way.

---

**Recommendation: Send to Lead Coder.** (Complexity 8.)
