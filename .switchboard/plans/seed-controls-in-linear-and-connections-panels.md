# The seed needs a surface: project selection in the Linear and Connections panels

## Goal

Put the bulk seed where a person connecting a tracker actually is — the Linear
panel and the Connections panel — with per-project selection and a visible record
of what has already been seeded and where.

### Problem analysis

The seed is useless if it is only reachable from an API call. The two panels that
own the connection are `src/webview/linear.js` / `linear.html` (via the Linear
setup surface) and `src/webview/connections.js` / `connections.html` (234-line
`ConnectionsPanelProvider.ts`, 803-line `connections.js`).

It explicitly does **not** belong in the Tickets panel. That panel owns ticket
documents and already carries `syncAllTickets` (`TicketsPanelProvider.ts:4078`),
a write-back of already-linked ticket files whose name invites exactly the
confusion this feature exists to resolve. Two differently-scoped "sync
everything" buttons in one panel is how a user pushes 250 full-description
overwrites believing they are seeding a board.

### Current state — verified against `src/`

**Already landed (the sibling seed plan's deliverables):**

- `LinearSyncService.seedProjectToRemote` (`LinearSyncService.ts:3492`) — the
  full engine: resolves the durable binding through `db.getRemoteProjectBinding`'s
  `{ value, source }` envelope, creates a remote project named after the board
  project on first seed, attaches instead on rerun, refreshes stale remote names,
  marks `seeded_at`, and streams `onProgress`/`onPreflight` callbacks.
- Provider seam: `RemoteProvider.seedBoardProject?` and
  `capabilities.seedProjects` (`src/services/remote/RemoteProvider.ts:98,254`).
  Linear implements it (`src/services/remote/LinearRemoteProvider.ts:313`);
  ClickUp and Notion declare `seedProjects: false`.
- DB accessors: `getRemoteProjectBinding`, `setRemoteProjectBinding`,
  `refreshRemoteProjectBindingName`, `markRemoteProjectBindingSeeded`,
  `listRemoteProjectBindings` (`KanbanDatabase.ts:16472–16597`), and
  `getActivePlansByProject` (`:16606`, `status = 'active'` only, `NULL`/`''`
  unified as unassigned).
- `KanbanProvider.getRemoteProvider(workspaceRoot, kind)`
  (`KanbanProvider.ts:3285`) — the composition point all provider-seam calls go
  through; `remoteGetConfigPayload`/`remoteSetConfig` (`:3291–3307`) are the
  delegation pattern to mirror.

**Missing (this plan's work):**

- `SeedResult.skipped` collapses two distinct counts — already-linked and
  skipped-unmapped-column — that the UI must report separately.
- No way to list remote destinations, bind one, or clear a binding without
  running the seed. No `clearRemoteProjectBinding` accessor exists.
- No verb arms — the surface is unreachable from any panel.
- The webview surface itself.
- **A dead rail:** `SetupPanelProvider.setKanbanProvider` is wired in
  `extension.ts:1276` but never in `bootstrap.ts`. Live probe on the standalone
  host: `POST /connections/verb/getRemoteConfig` and `/linear/verb/getRemoteConfig`
  return `{"success":true}` and push nothing — every `remote*` arm in
  `SetupPanelProvider` is inert in the standalone host. This feature's verbs
  would inherit the same dead rail.

## Metadata

- **Complexity:** 6
- **Tags:** ui, api, feature
- **Estimated files:** ~11 source files plus the regenerated protocol catalog

## User Review Required

Touches sync-adjacent seams and a composition root; creates real remote
destinations on user action. Review the binding-validation and broadcast-tag
decisions before implementation.

## Complexity Audit

Cross-layer but shallow: every change is a thin delegate to an engine that
already landed. The risk is wiring correctness (one missing `setKanbanProvider`
line kills the whole feature silently), binding validation, and broadcast
surface tagging — not algorithmic complexity.

## Edge-Case & Dependency Audit

- **Race:** a second `seedRun` for a project already in-flight must be rejected
  host-side; "the button disables" is a courtesy, not a guard.
- **Security:** new verbs ride the HTTP rail — declared in the catalog
  allowlists, schema-validated, and they must never reach for `dist/`-level
  shortcuts.
- **Side effects:** creates remote projects and writes durable bindings. Both
  must be idempotent under rerun and resumable after a host restart.
- **Dependencies:** the engine, seam, binding table, and `getRemoteProvider`
  composition point are landed (above). The ClickUp seed engine is not; this
  surface must degrade to honest unavailability for `seedProjects: false`
  providers.

## Dependencies

Depends on the seed engine and mapping table from **A Linear key buys you nothing
until the board is seeded** — landed, per the Current state section. Drives the
ClickUp seed through the same interface once **Seed board projects to ClickUp
lists** lands; the control is provider-agnostic and must not branch on kind.

## Resolved Assumptions

- `src/services/remote/RemoteProvider.ts` — `seedBoardProject?`, `SeedResult`,
  `SeedProgress`, and `capabilities.seedProjects` all exist.
- `LinearRemoteProvider.seedBoardProject` (`:313`) maps `onProgress` only;
  `onPreflight` exists in the engine options but is not threaded through the seam.
- `listRemoteProjectBindings` is provider-scoped — one binding set per provider,
  so Linear and ClickUp bindings never collide.
- `KanbanProvider._buildRemoteConfigPayload` (`:3241`) returns
  `db.getProjects(workspaceId)` names only — insufficient for the surface; a new
  payload is required rather than an extension of `remoteConfig`.
- `SETUP_VERBS` is the only allowlist consulted by all three relevant routes:
  `/connections/verb/` and `/linear/verb/` in `LocalApiServer` check it first,
  and `ConnectionsPanelProvider._forwardOne` forwards it in the extension.
- `wsHub` surfaces: `connections` → `['connections','common']`, `linear` →
  `['common']`. Only untagged broadcasts (or `common`) reach both panels; a
  `linear`-tagged push never reaches Connections and vice versa.
- `src/webview/*.js` is glob-copied to `dist/webview/` by webpack CopyPlugin and
  `ConnectionsPanelProvider`'s `resolveStaticUri` rewrites `/static/webview/*` —
  one shared module serves standalone `/linear`, standalone `/connections`, and
  the extension Connections webview.
- `window.sbCopyToClipboard` and the transport shim arrive via
  `injectTransportShim` (`headlessPanelHtml.ts:73`) — shared script injection is
  the established pattern.
- `verbSchemas.ts`: verbs with no schema pass unvalidated; schemas are optional
  hardening, added anyway for the new write verbs.

## Adversarial Synthesis

The engine is solid and the seam is real — this plan adds no algorithmic risk.
What it adds is reachability, and reachability in this codebase is where features
die silently: a missing `setKanbanProvider` wire, a result type that merges the
two counts the user needs, a broadcast tag no panel subscribes to. The binding
picker is the other live edge — a stale remote id must fail loudly inside the
provider against a live destination list, or the engine's create-on-missing logic
turns a dead binding into a duplicate remote project.

## Proposed Changes

### Product requirements (preserved)

1. **A project list, not a global button.** Each row is a board project with its
   active plan count, its seeded state, and — when seeded — the remote project or
   list it is bound to, by name, resolved from the mapping table. On this board
   that is 10 named projects (largest 212 active) plus 39 unassigned plans.
2. **Multi-select with an explicit destination per project.** Default for an
   unseeded project is "create a new project/list named after it"; a user may
   instead attach it to an existing remote project chosen from a picker. Once
   bound, the row shows the binding and re-running seeds into it.
3. **Unassigned plans are not a project** and must not be offered as one. Say so
   in the row rather than omitting them silently — 39 invisible cards is exactly
   the "why didn't everything appear" failure this feature is fixing. (The engine
   can seed `''`; the exclusion is deliberate UI scope, not a technical limit.)
4. **Progress and result, not a spinner.** Render `{ done, total, skipped }` as
   it streams, and on completion report created / attached /
   skipped-unmapped-column counts. A seed that skipped 40 cards because their
   column has no state mapping must say so on screen.
5. **No confirmation dialog.** Per the project rule this is non-negotiable, and
   there is a hard technical reason: `window.confirm()` is a silent no-op in a
   VS Code webview, so a confirm gate makes the button do nothing at all. Project
   selection plus an explicit Seed action *is* the deliberate act. A destination
   picker is a multi-choice decision surface, which is allowed; an "Are you
   sure?" is not.
6. **Scope.** Standalone host only, per the cutover — a seam built after the
   cutover decision lands in standalone, and wiring it into the legacy host is
   throwaway work. Two pre-existing facts sit outside that scope call: (a) the
   `setKanbanProvider` seam predates the cutover and both roots were meant to
   wire it, so bootstrap's missing wire is existing drift this feature must fix,
   not new extension scope; (b) the new verbs work in the extension automatically
   through `ConnectionsPanelProvider`'s existing `SETUP_VERBS` forward — the VS
   Code Connections webview gets the `seedRun` ack and can refetch the surface,
   but live progress pushes land on the bound kanban webview and browser mirrors.
   That is the intended legacy-host degradation, not a divergence to fix.

### Implementation

1. **`src/standalone/bootstrap.ts` — wire the dead seam.** Add
   `setupProvider.setKanbanProvider(kanbanProvider)` next to
   `setupProvider.setTaskViewerProvider` (~`:1694`). One line; it revives every
   `remote*` arm in `SetupPanelProvider` on the standalone host and is
   load-bearing for all four seed verbs. Verify with the `/linear/verb/` and
   `/connections/verb/` probes — today they return a bare `{"success":true}`.

2. **`src/services/remote/RemoteProvider.ts` — extend the seam.** Add to
   `SeedResult`: `skippedAlreadyLinked: number` and
   `skippedUnmappedColumn: string[]` (keep `skipped` as the total for compat).
   Add two optional methods beside `seedBoardProject?`:
   - `listSeedDestinations?(): Promise<{ id: string; name: string }[]>` — the
     remote projects/lists the configured scope can see.
   - `bindSeedDestination?(boardProject: string, remote: { id: string; name: string } | null): Promise<void>`
     — writes an `origin:'attached'` binding; `null` clears it.

3. **`src/services/remote/LinearRemoteProvider.ts`** — implement both methods as
   thin delegates to `LinearSyncService` (same shape as `seedBoardProject`'s
   delegate at `:313`), and map the two new `SeedResult` fields from the engine
   outcome (`alreadyLinked`, `skippedUnmappedColumn`).

4. **`src/services/LinearSyncService.ts` — new `bindSeedDestination(boardProject, remoteProjectId | null)`.**
   - `loadConfig` → teamId; unconfigured → throw naming the missing config (fail
     loud — no team fallback).
   - `null` → `db.clearRemoteProjectBinding({ workspaceId, provider: 'linear', remoteTeamId, boardProject })`.
   - id → `getAvailableProjects()` must contain it; absent → throw naming the
     team and the rejected id. Present → `setRemoteProjectBinding` with
     `origin:'attached'` and the live remote name. Validation happens here, in
     the provider impl, against the live list — never in the webview or the arm.

5. **`src/services/KanbanDatabase.ts` — `clearRemoteProjectBinding`.** Targeted
   single-row `DELETE` keyed on `(workspace_id, provider, remote_team_id,
   board_project)`. Never a bulk replace — the full-table-replace lesson from
   `saveSyncMap` is recorded in the sibling plan.

6. **`src/services/KanbanProvider.ts` — four remote methods**, following
   `remoteGetConfigPayload`'s `_resolveWorkspaceRoot` / `_getKanbanDb` /
   `getRemoteProvider` pattern. All gate on
   `provider.capabilities.seedProjects === true`; a provider without it returns
   `{ success: false, error }` — honest unavailability, never a silent no-op.
   - `remoteGetSeedSurface(workspaceRoot?, provider)` →
     `{ type:'seedSurface', provider, workspaceRoot, capabilities,
        projects:[{ boardProject, activePlans, binding | null }],
        unassigned:{ count } }`. Rows from `db.getProjects(workspaceId)`, counts
     from `getActivePlansByProject`, bindings from
     `listRemoteProjectBindings(workspaceId, provider)`, unassigned count from
     `getActivePlansByProject(workspaceId, '')`. `binding` carries the full
     `RemoteProjectBinding` (name, origin, `seededAt`) so the row can say
     "seeded into X on <date>" vs "bound, never seeded".
   - `remoteListSeedDestinations(workspaceRoot?, provider)` →
     `{ success, destinations: [{id,name}], error? }` via
     `provider.listSeedDestinations()`; the provider's own error (unconfigured,
     wrong team) propagates as the payload error.
   - `remoteBindSeedDestination(workspaceRoot?, provider, boardProject, remoteId | null)`
     → delegates to `provider.bindSeedDestination`, returns the refreshed surface
     row.
   - `remoteSeedRun(workspaceRoot?, provider, projects: string[], destinations?: Record<string,string>)`
     — fire-and-forget. Validates every `boardProject` against
     `db.getProjects(workspaceId)`; unknown names land in `skipped[]` with a
     named reason and produce zero remote writes — no `includeProjectNames[0]`,
     no first-project fallback, ever. Applies `destinations` entries through
     `bindSeedDestination` before seeding that project. In-flight guard:
     `Map<workspaceRoot:provider:boardProject, Promise>` — a second run for an
     in-flight project is rejected per-project in `skipped[]`, not queued.
     Projects run sequentially. Emits untagged broadcasts (both `seedProgress`
     and `seedResult`, see push contract below) through the provider's existing
     push + WS mirror.

7. **`src/services/SetupPanelProvider.ts` — four verb arms** beside the existing
   `getRemoteConfig` cluster (`:1375+`): `seedGetSurface`,
   `seedListDestinations`, `seedBindDestination`, `seedRun`. Read verbs push
   their payload (`type:'seedSurface'` / `type:'seedDestinations'`) AND return
   it — the HTTP rail reads the return, the extension webview reads the push.
   `seedRun` validates, starts, and returns `{ success, accepted, skipped }`
   immediately; outcomes arrive as pushes.

8. **`src/services/verbSchemas.ts`** — setup-provider schema entries for all
   four verbs: `provider` string required; `projects` array required for
   `seedRun`; `boardProject` string and `remoteId` (string-or-null) for
   `seedBindDestination`. Malformed HTTP payloads get `{ success:false }` before
   the arm runs.

9. **`protocol-catalog.json` — regenerate** (`npm run catalog:generate`). The
   new arms land in `SETUP_VERBS` automatically; review the diff — if the
   generator misses an arm, declare it in the catalog source instead.

10. **`src/webview/seedSurface.js` (new, shared module)** —
    `window.SeedSurface.mount({ root, provider, postMessage })` plus
    `SeedSurface.handleMessage(msg)` returning true for `seedSurface`,
    `seedDestinations`, `seedProgress`, `seedResult` so each host panel routes
    them inside its existing message switch. Renders: provider name and seed
    header, one row per board project (name, active count, binding chip or
    destination `<select>`, per-row progress/result line), the unassigned row
    (count + "not a project — assign plans on the board to seed them", not
    selectable), and an honest "Provider X cannot seed board projects" state
    when `capabilities.seedProjects === false` (same convention as the push /
    comments capability gates already in `connections.js:149,177`). The picker
    offers "Create new remote project" (default) plus fetched destinations;
    choosing an existing destination fires `seedBindDestination` immediately.
    Served at `/static/webview/seedSurface.js` — the webpack glob copy and
    `resolveStaticUri` make it reachable from all three hosts. `aria-live`
    progress, keyboard-operable rows, disabled/loading states, buttons that are
    hard to misclick and never confirm-gated.

11. **`src/webview/linear.html`** — a new `.conn-card` "Seed board → Linear" in
    the Connect tab after the boards-to-sync card: a mount element and a
    `<script src="/static/webview/seedSurface.js">` tag (nonce-carrying, per the
    template's existing script convention).

12. **`src/webview/connections.html`** — the same card in the Providers tab.

13. **`src/webview/linear.js`** — after `remoteConfig` resolves, mount
    `SeedSurface` with `provider:'linear'`, post `seedGetSurface`, route `seed*`
    messages to `SeedSurface.handleMessage`, and re-post `seedGetSurface` after
    each `seedResult` so binding chips and counts refresh.

14. **`src/webview/connections.js`** — same mount; `provider` comes from
    `_lastRemoteConfig.provider` (the stored/configured provider), **not** the
    `#remote-provider` select — a stored `linear` is deliberately unselectable
    in that dropdown (`:230–233`), so the select value would misroute the seed.
    Section stays hidden until `remoteConfig` arrives.

15. **Push contract.** `seedProgress` = `{ type, provider, boardProject, done,
    total, skipped }`; `seedResult` = `{ type, provider, boardProject, ok,
    created, attached, skippedAlreadyLinked, skippedUnmappedColumn, error? }`.
    Both broadcast **untagged** — the only tags that would pass the surface
    filter are `common` (equivalent reach, extra ceremony); `linear`/`connections`
    tags each reach only one of the two panels.

16. **Tickets panel untouched.** No seed control; `syncAllTickets`
    (`TicketsPanelProvider.ts:4078`) unchanged.

## Verification Plan

Written checks — execution is out of scope for the plan itself.

1. Both panels show every board project with its active count and seeded state.
2. Selecting three projects and seeding creates three remote projects and pushes
   only those projects' active plans.
3. A seeded row shows its remote binding by name; re-running seeds into it and
   creates nothing new.
4. Unassigned plans are visible as unassigned and cannot be seeded as a project.
5. Skipped counts (unmapped column, already linked) are shown, not swallowed.
6. `grep -rn "confirm(" src/webview/linear.js src/webview/connections.js
   src/webview/seedSurface.js` finds no confirm gate on the seed path.
7. The Tickets panel gains no seed control, and `syncAllTickets` is untouched.
8. **Dead rail fixed:** `/connections/verb/getRemoteConfig` and
   `/linear/verb/getRemoteConfig` on the standalone host return/push the
   `remoteConfig` payload (previously bare `{"success":true}`).
9. `seedGetSurface` returns identical project rows over `/connections/verb/` and
   `/linear/verb/`; the extension's Connections webview receives the pushed
   `seedSurface` message through the forward.
10. `npm run catalog:generate` produces a catalog containing all four verbs in
    the setup allowlist; `/setup/verb/seedGetSurface` also works.
11. Two browser tabs on `/linear`: seed in one, the other receives
    `seedProgress`/`seedResult` — proving the untagged broadcast clears the
    surface filter.
12. With `provider` configured to a `seedProjects:false` provider, the section
    renders honest unavailability and `seedRun` returns `{success:false}` naming
    the provider — no dead button, no silent no-op.
13. `seedRun` with a project name absent from this workspace → named rejection
    in `skipped[]`, zero remote writes.
14. A second `seedRun` while a project is in-flight → that project reported
    skipped as in-flight; exactly one run executes.
15. Kill the host mid-seed, restart, reseed → `attached`/`skipped` counts reflect
    the prior run; no duplicate remote issues; the binding survives.
16. Delete the bound remote project, reseed → named failure; attaching a
    different destination via the picker recovers without silently creating a
    new project.
17. Row counts equal `getActivePlansByProject` per project — features/subtasks
    are not double-counted; the `''` count equals the unassigned row.
18. `grep -rn "includeProjectNames"` on the seed path finds no
    fallback-to-first-project anywhere.
19. Malformed HTTP payloads (missing `provider`, non-array `projects`) are
    rejected by `verbSchemas` with `{success:false}` before any arm runs.
20. Keyboard-only operation works end to end: rows selectable, picker and Seed
    reachable, `aria-live` announces progress.

## Outstanding Questions

- **Split assessed, not recommended.** Three work streams exist (seam/DB,
  verbs/wiring, webview) but none ships alone — the UI without verbs renders
  nothing, verbs without UI are invisible. One deliverable, one plan.
- No open questions requiring user input; every uncertainty encountered was
  answerable from `src/` and is recorded under Resolved Assumptions.

---

## Completion summary

Reviewed the plan against `src/` and rewrote it for implementation. The major
findings: the seed engine, provider seam, and binding-table accessors are all
landed, but `SetupPanelProvider.setKanbanProvider` was never wired in
`bootstrap.ts`, leaving every remote verb arm dead on the standalone host — the
plan now makes that one-line fix load-bearing. The design adds four
`SETUP_VERBS` arms, two seam methods plus a `SeedResult` skip-breakdown
extension, a `clearRemoteProjectBinding` accessor, and a shared
`seedSurface.js` module mounted by both panels, with untagged progress/result
broadcasts. Scope remains standalone-only per the cutover; the extension path
works via the existing verb forward with degraded live progress, documented as
intentional.
