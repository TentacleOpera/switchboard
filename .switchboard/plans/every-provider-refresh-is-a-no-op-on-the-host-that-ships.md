# A Project Created by an Agent Never Reaches the Dropdown

## Goal

Creating a project through the board's own verbs writes the row and never tells the browser. The
project list is delivered only inside the standalone full-state push, and no project-mutating verb
triggers that push. Give those verbs the coalesced push that already exists — not a general refresh
wake-up.

### Problem analysis

**Observed 2026-09-15.** An agent created eight projects and assigned 81 features to them via
`addProject` and `assignSelectedToProject`. Every call returned `{"success":true}`, and the database
is correct — a direct `getProjects()` against the resolved board database returns all ten names. The
operator's dropdown stayed empty across a reload.

**Standalone has its own push, and it works.** `bootstrap.ts:1068` defines `pushFullState()`, which
calls `kanbanProvider.getFullStateMessages(...)` and broadcasts every message it returns —
`updateColumns`, `updateWorkspaceSelection`, `cliTriggersState`, `updateBoard` and the rest — each
over the WS hub with its surface tag (the `else` arm at `:1137` forwards anything it does not
special-case). `updateWorkspaceSelection` is built at `KanbanProvider.ts:1508-1519` and carries
`workspaces`, `projects` and `allWorkspaceProjects`. So the delivery path for the dropdown exists
and is the same one the cards ride.

**It fires on three triggers, and none of them is a project change.** `pushFullState` is called from
startup (`:1929`), from the `ready` and `refresh` verbs (`:2019-2020`), and from plan discovery via
the 40 ms coalescer `schedulePushFullState` (`:1216-1224`). Cards therefore refresh fine: every
ingest fires `onPlanDiscovered`. A project insert fires nothing.

**What `addProject` calls instead is dead on this host.** After the insert it calls
`this._refreshBoard(workspaceRoot)` (`KanbanProvider.ts:10605`), and `_refreshBoard` (`:4034`)
returns immediately when `this._panel` is falsy. `_panel` is assigned only by
`vscode.window.createWebviewPanel` (`:1873`), which standalone never calls — `bootstrap.ts:1497`
states it outright: *"no sidebar in npx and never will be; pushes go to the WS hub once."* The
board log for this session contains **17** `[KanbanProvider] _refreshBoard skipped: no panel` lines,
one per state-changing verb the agent issued.

> **Superseded:** an earlier revision of this plan concluded that `_refreshBoard`'s panel gate was
> the defect and proposed widening it so all **44** call sites push on the standalone host.
> **Reason:** that is wrong and expensive. Cards already refresh correctly on standalone *because*
> they ride `pushFullState`, not `_refreshBoard` — so the 44 sites are not a latent outage, they are
> a second path that standalone deliberately does not use. Waking them would add a full board
> rebuild per mutation on a board this size, which is the exact hazard `bootstrap.ts:1236-1240`
> already documents: *"a misfiring event source turns every tick into a full board rebuild (2658
> cards here) with nothing bounding concurrency."* The cost would be paid on every card operation to
> fix a list that changes a few times a year.
> **Replaced with:** leave `_refreshBoard` alone. Hook the handful of project-mutating verbs into
> the coalesced push standalone already has.

**A second defect, independent of delivery.** `addProject` also calls `setProjectFilter(projectName)`
on every create (`:10603`), making the new project the active filter. That is right for the board's
single create-project button, which is its only intended caller. Called eight times in a loop it left
the operator's board filtered to the last project created — a blank board on top of an empty
dropdown. A side effect correct for one caller and wrong for every other must not live in the shared
path.

**A third, smaller one.** `POST /kanban/verb/getProjects` answers *"Verb 'getProjects' not
implemented in standalone mode"*, so an agent can create projects on the shipping host but cannot
read them back to verify.

### Root cause

`KanbanProvider` treats `_panel` as the test for "is anyone listening", because a VS Code webview was
once the only consumer. Standalone added a second consumer with its own push loop rather than
teaching the provider about it — a reasonable split, since the provider's own refresh rebuilds far
more than standalone needs. But it left every provider-side `_refreshBoard(...)` as a silent no-op
here, and nothing re-routed the cases that have no other trigger. Card state has another trigger.
Project state does not.

## Metadata

**Tags:** bugfix, reliability, backend, ux
**Complexity:** 3
**Repo:** switchboard

## User Review Required

No. The operator set both the requirement — *"agents should be able to create projects and they
should show instantly in the dropdown"* — and the constraint: *"I don't want to implement 44
different refreshes for a fucking dropdown, that will tank performance for no gain."*

## Settled Design

- **`_refreshBoard`'s panel gate is not touched.** Cards already refresh through `pushFullState`.
  The 44 call sites stay dormant on standalone by design; widening them buys nothing and costs a
  board rebuild per mutation.
- **Project mutations use the existing coalescer, `schedulePushFullState()`** (40 ms), never a bare
  `pushFullState()`. The coalescer exists precisely so a burst of writes produces one rebuild, and a
  batch of agent-created projects is that burst.
- **The trigger is enumerated, not general.** Only the verbs that change the project set get the
  hook. A blanket "push after every verb" re-creates the performance problem this plan is
  constrained to avoid.
- **Creating a project stops meaning "switch to it".** The filter change moves out of `addProject`
  into the board button's own handler. If some caller genuinely needs it, it becomes an explicit
  `makeActive` flag defaulting to false — never an implicit side effect of creation.
- **`getProjects` becomes readable on standalone**, so an agent can verify its own write.
- **The dead-refresh log line stops pretending to be routine.** It printed 17 times during a visible
  outage and means nothing on this host. Either drop it on the standalone path or state plainly that
  this host refreshes elsewhere, so it stops reading like the cause of a problem.

## Complexity Audit

### Routine
- Adding the project verbs to the standalone push trigger.
- Moving the filter side effect.
- Wiring one read verb.

### Complex / Risky
- **Finding every project-mutating verb.** `addProject` and `deleteProject` are obvious;
  `assignSelectedToProject` changes assignment rather than the list, and the dropdown does not
  depend on it — but the board's card grouping might. Establish which surfaces each verb actually
  affects instead of hooking them all.
- **Removing the filter side effect changes behaviour for the board button**, which currently gets
  the switch for free. Its handler must take over the call, or creating a project from the UI
  silently stops selecting it.

## Edge-Case & Dependency Audit

- **Race conditions.** `schedulePushFullState` already serialises through `pushChain`; use it rather
  than adding a second scheduler.
- **Security.** None.
- **Side effects.** One extra full-state push per project mutation — a rare operation. This is the
  whole cost of the fix and is the reason for choosing the coalescer.
- **Dependencies & conflicts.**
  - `13c97a2b` *Panel Pushes Carry a Surface Tag* — the push already carries
    `surface: SURFACES.kanban`; do not introduce an untagged broadcast.
  - `30e0c0a7` *Defects the Parity Audits Could Not See* — this is a member of that class (a seam
    wired in one root only) and may belong inside that feature.
  - **Not the cause, but present:** line 2 of `.switchboard/workspace-id` is
    `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db`, a macOS path absent
    on this machine (`879ceb0f`). The resolver falls through to the correct per-board database —
    verified by direct query — so it did **not** cause this bug, but it will mislead the next person
    debugging a data-path fault.

## Adversarial Synthesis

**Risk summary.** The change is small by construction, and its main risk is scope: the tempting fix
is the general one (repair `_refreshBoard` for everybody), which is both larger and a measurable
regression on a 2,658-card board. The second risk is hooking too many verbs and paying a rebuild on
card operations that already have a working path. The third is the filter side effect: removing it
is correct, but the board button depends on it today, so the two changes must land together or
creating a project from the UI quietly stops selecting it.

## Proposed Changes

### Change A — project mutations trigger the standalone push

#### `src/standalone/bootstrap.ts` — `kanbanVerb` (`:2014`)
- **Context:** `case 'ready'` / `case 'refresh'` already `await pushFullState()` (`:2019-2020`);
  everything else falls through to the provider via the `default:` arm.
- **Logic:** after the provider handles a project-mutating verb, call `schedulePushFullState()`.
  Use the coalescer, not `pushFullState()` directly, so a batch of creates produces one rebuild.
- **Edge case:** the push must happen *after* the provider's handler resolves, or it rebuilds from
  pre-write state and delivers a list missing the project just created.
- **Edge case:** do not add this to the `default:` arm wholesale — that is "push after every verb",
  the thing this plan exists to avoid.

### Change B — `addProject` stops moving the operator's view

#### `src/services/KanbanProvider.ts` — `case 'addProject'` (`:10581`)
- **Logic:** remove the unconditional `setProjectFilter(projectName)` (`:10603`). Give the verb an
  optional `makeActive` flag, default false, and have the board's create-project button pass it.
- **Edge case:** the existing comment argues the switch stops subsequently-created plans landing in
  the wrong project. Confirm what relies on that before removing it; if something does, the flag is
  how it opts in.

### Change C — `getProjects` answers on standalone

- **Logic:** wire the verb in the standalone composition root so an agent can read back what it
  wrote.
- **Edge case:** check whether other read verbs share the gap. One unwired verb is a miss; several
  is a pattern worth its own plan.

### Change D — the dead log line stops misleading

#### `src/services/KanbanProvider.ts` — `_refreshBoard` (`:4034`)
- **Logic:** the `skipped: no panel` line is expected on standalone and printed 17 times during a
  visible outage. Say what it means — this host pushes via the WS hub — or drop it here.
- **Edge case:** **do not change the gate itself.** The early return is correct for this host; only
  the message is misleading.

## Verification Plan

### Automated Tests
1. **A created project reaches the wire without a reload.** Against the standalone host, subscribe
   to the WS hub, `POST /kanban/verb/addProject`, and assert an `updateWorkspaceSelection` arrives
   whose project list contains the new name. Fails today — the headline regression. Note the WS
   frame is an envelope (`{type, seq, surface, payload}`); assert on the payload, not the wrapper.
2. **A batch produces one rebuild, not N.** Create three projects in quick succession; assert the
   number of full-state pushes is fewer than three — the coalescer is doing its job.
3. **`addProject` does not move the active filter.** Create a project; assert
   `kanban.activeProjectFilter` is unchanged. Fails today.
4. **Card operations gain no new pushes.** Move a card and assert the full-state push count is
   unchanged from today — the guard against this fix turning into the 44-site version.
5. **`getProjects` answers on standalone.** No "not implemented in standalone mode".

### Goal Invariants
1. `bootstrap.ts` calls `schedulePushFullState` (not `pushFullState`) on the project-mutating verbs,
   and the `default:` arm gains no push. *(Paired positive: `ready`/`refresh` keep their direct
   `pushFullState`, so the connect path is unchanged.)*
2. `KanbanProvider._refreshBoard` still returns early when no panel is attached — this plan does not
   widen that gate.
3. `case 'addProject'` contains no unconditional `setProjectFilter` call.
4. `getProjects` is absent from the standalone not-implemented set.
5. The count of `_refreshBoard` call sites is unchanged, and none of them is newly reachable on
   standalone.

## Review Findings

Files changed: `src/standalone/bootstrap.ts` (project verbs delegate to the provider + `schedulePushFullState`, new `getProjects` arm), `src/services/KanbanProvider.ts` (`invalidateProjectCache`, degraded-read handling, `makeActive` opt-in, `_refreshBoard` log text), `src/services/TaskViewerProvider.ts` (triage writer invalidates), `src/services/verbSchemas.ts` (`makeActive` typed), `src/webview/kanban.html` (button passes `makeActive: true`), plus this review's `src/test/verb-engine-kanban-headless.test.js`. The plan's diagnosis was wrong on one fact and the implementation corrected it: the old standalone arm *did* `await pushFullState()`, but wrote the row through its own `db` handle, so `KanbanProvider`'s memoised `allWorkspaceProjects` — the map the dropdown is actually built from — stayed stale until restart; delegating to the provider arm is what fixes it. Two MAJOR findings were fixed in this pass: the plan's five named automated tests did not exist (six now live in `verb-engine-kanban-headless.test.js`, exposed as `test:contract:verb-engine-kanban` and invoked by CI at `integration-tests.yml:818`), and the degraded project read refused to memoise at all, which re-ran `KanbanDatabase._initialize()` for every unreadable root on every push (`ensureReady()` returns false for a root with no board DB — probed, not assumed); it now memoises with a 5 s expiry while still omitting the failed root rather than recording `[]`. Verification: `npm run compile-tests` clean, `test:contract:verb-engine-kanban` 25/25, `test:contract:board-payload-size` 18/18, `kanban-create-project-modal` pass; all five Goal Invariants hold (`_refreshBoard` call sites still 44, gate untouched, no push added to the `default:` arm). Remaining risk: the end-to-end wire assertion (an `updateWorkspaceSelection` frame carrying the new project) is pinned only at source level, so passing these suites is not proof the frame arrives — the live host still runs a `dist/` build predating the change.

## Deferred Findings

- MAJOR — process, not code: this plan's implementation was committed inside `e6c816ac` ("plan: board operations leave the file path"), a different plan's commit, so it carries no `Switchboard-Plan` trailer for `febaab3b` and the diff is not separable. Not correctable without history rewriting. (`.switchboard/plans/every-provider-refresh-is-a-no-op-on-the-host-that-ships.md:1`)
- NIT — `case 'getProjects'` answers from the host-level `db` handle and ignores `workspaceRootArg`; correct under one-store-one-host, but it is an identity/routing read that returns no source tag. (`src/standalone/bootstrap.ts:2057`)
- NIT — the plan reports the dropdown as *empty*, yet a stale memo would have delivered the two pre-existing projects. The memo is the proven staleness mechanism; "empty rather than stale" is unexplained and may be a second, smaller fault. (`.switchboard/plans/every-provider-refresh-is-a-no-op-on-the-host-that-ships.md:12`)
- NIT — plan verification items 1, 2 and 4 (WS frame arrival, one rebuild per batch, card ops gain no pushes) need a booted standalone host and were not executed; only item 1 has a source-level pin. (`src/test/verb-engine-kanban-headless.test.js:1`)
- NIT — pre-existing and unrelated: `npm run test:contract:verb-engine` cannot load `out/services/mirrorSync` because `src/services/mirrorSync.js` is hand-written plain JS that `tsc` never emits (same gap `verb-engine-kanban-headless.test.js` works around for `kanbanColumnDerivationImpl.js`). (`src/services/TaskViewerProvider.ts:1`)
- NIT — pre-existing: `src/test/kanban-create-project-modal.test.js` is defined nowhere in `package.json` and invoked by no CI job. (`src/test/kanban-create-project-modal.test.js:1`)
