# CI has been red on four stale Linear tests, and the hang in front of them hid it

## Goal

`npm run test:integration:all` runs in CI (`.github/workflows/integration-tests.yml:2085`)
and has been failing. Four tests in the Linear group assert behaviour the product
deliberately changed months ago. None of them is a product bug — every one was
diagnosed to a specific removed option, renamed field or deleted symbol on
2026-09-18. Until they are corrected, the suite is red, and a red suite is a suite
nobody reads.

### Problem analysis

The four were **invisible**, not ignored. `run-integration-tests.js:60` exits on
the first failing file, and the file that runs before them —
`linear-sync-service.test.js` — did not fail: it **hung**, on an unbounded
`loadConfig()` ↔ `getAvailableProjects()` recursion that grew the heap to ~1.9 GB
over ~7 minutes and then aborted the process. The runner never reached the rest of
the group. That recursion is fixed (`2f0e7029`); with the road open, the four
behind it are now reachable and each fails on its own first assertion.

Each has been traced to root cause. **All four are stale tests. No product change
is proposed by this plan.**

**1. `linear-regression.test.js:77` — asserts a removed setup option.**
The test calls `service.applyConfig({ … scopeProject: true … })`, but
`LinearApplyOptions` (`LinearSyncService.ts:184-195`) has **no `scopeProject`
field** — project scoping became `includeProjectNames`/`excludeProjectNames`, and
`grep -n "scopeProject" src/services/LinearSyncService.ts` returns nothing. The
option is inert, so no interactive project picker runs. The test still queues an
HTTP response for that vanished request:

```js
http.queueJson(200, { data: { team: { projects: { nodes: [] } } } });   // :55
```

Those queue entries carry **no matcher**, so `dequeue`
(`http-mock-helpers.js:11-17`) hands them out strictly FIFO. The projects payload
is therefore consumed by the **states** query inside `_mapColumnsToStates`
(`LinearSyncService.ts:3051`), which finds no `team.states.nodes`, falls back to
`[]` (`:3054-3056`), and builds `stateOptions` with only its single skip entry
(`:3057-3063`). The test's column responder is `(items) => items[1]` — `undefined`
against a one-element list — so the loop throws at `:3071`. It surfaces as
`No Linear state selected for column "RESEARCHER"` because RESEARCHER is
`CANONICAL_COLUMNS[1]` (measured: 13 columns, `CREATED | RESEARCHER | PLAN
REVIEWED | STAGING | LEAD CODED | CODER CODED | INTERN CODED | CODE REVIEWED |
ACCEPTANCE TESTED | TICKET UPDATER | COMPLETED | BACKLOG | CODED`) and the stale
second `items[0]` responder is absorbed by CREATED first. The column name in the
error is a red herring; the cause is one response queued for a request that no
longer happens.

**2. `linear-automation-service.test.js:233` — asserts legacy `projectId` scoping.**
The config it saves carries `projectId: 'project-1'` and no `includeProjectNames`.
Scoping now runs through `resolveSingleIncludeProjectId`, and the legacy key is
only honoured via `loadConfig`'s `projectId → includeProjectNames` migration
(`LinearSyncService.ts:421-436`), which must resolve the project **name** through
`getAvailableProjects()`. The test queues no projects response, so the migration
logs *"deferring migration. API may be unavailable"* and leaves
`includeProjectNames` empty. The issue filter is correctly team-only; the test
expects `project: { id: { eq: 'project-1' } }`. The working pattern already exists
in this repo — `linear-import-flow.test.js`'s project-scoped case sets
`includeProjectNames: ['Acme Project']` and queues the projects list.

**3. `linear-remote-provider.test.js:157` — stubs a field that does not exist.**
`pollMentionsAndRelay` gates delivery on `plan.ownerSeat`
(`LinearRemoteProvider.ts:528`, `:533`, `:545`). `ownerSeat` is a real
`KanbanPlanRecord` field (`KanbanDatabase.ts:65`, persisted at `:3064` as the
advisory owner stamp) and is read the same way across
`teamWiring.ts:2315` and `PlanIngestionEngine.ts:1351/1642-1644`. The test's
`importRemotePlan` stub returns `dispatchedTerminal: 'seat-1'` instead —
`grep -rn "dispatchedTerminal" src/services/KanbanDatabase.ts` returns **nothing**.
With no `ownerSeat`, the `:528` guard is false, zero prompts are delivered, and
the assertion `Delivered mention to live seat` fails `0 !== 1`. **The provider is
correct; the stub names a field the schema does not have.**

**4. `tickets-subtask-embedding.test.js:372` — slices on a deleted symbol.**
`sliceBetween('public async getAttachmentList(', 'public static readonly SOURCE_PRESETS')`
over `TaskViewerProvider.ts`. `getAttachmentList` is still there (`:29058`), but
`grep -rn "SOURCE_PRESETS" src/` returns **nothing anywhere in the tree** — it was
removed in `6a4df070`. The end anchor is gone, `indexOf` returns `-1`, and the
helper's own assertion fires (`:13`). The next member declaration after
`getAttachmentList` is `_schedulerTerminalName` (`:29121`), which is the natural
replacement anchor. The assertion the slice guards — that `getAttachmentList`
resolves `isDownloaded` from `_readAttachmentIndex(` rather than a bare
`existsSync` — is still worth keeping; only the anchor rotted.

**Why this keeps happening is the real finding.** Every one of the four is a test
reaching around its public seam: into a removed options field, a legacy config
key, a record field name, and a source-file symbol two members away from the thing
under test. Item 4 is not even a behavioural test — it greps source text, which is
why a rename in an unrelated part of a 29,000-line file breaks it. Fixing the four
without saying that invites the fifth.

## Metadata

- **Tags:** test, reliability, devops
- **Complexity:** 4
- **Project:** Engineering Quality

## User Review Required

None. Every fix is determined by code already in the repo — the current
`LinearApplyOptions`, the current scoping path, the current `KanbanPlanRecord`
field, and the current contents of `TaskViewerProvider.ts`. No product behaviour
is in question, and the one judgement call (whether item 4's grep-the-source
assertion should survive at all) is recorded under `## Outstanding Questions` with
a stated assumption that keeps it.

## Complexity Audit

### Routine

- Items 1, 2 and 3: delete a dead option, queue the response the code actually
  requests, and rename a stub field to the one the schema defines. Each is
  confined to a single test file and changes no product code.
- Item 4: replace one string literal with a symbol that exists.

### Complex / Risky

- **The risk is fixing them the lazy way.** Each of these can be made green by
  weakening the assertion — dropping the project-filter check, asserting
  `promptDeliveries.length >= 0`, deleting the slice. That converts a red test
  into a test that proves nothing, which is worse than red because it stops
  reporting. Every fix here must keep the original assertion's *intent* and change
  only the setup that drifted.
- **Item 1's FIFO mock is a trap for the fixer too.** The queue entries in that
  test have no matchers, so removing the stale projects response shifts every
  later response by one. The fix is to attach matchers (the pattern
  `linear-sync-service.test.js` already uses) rather than to count positions —
  otherwise the next product change silently re-misroutes a payload, which is the
  exact failure being fixed.
- **Item 3 is one guard away from being a product bug, and the distinction
  matters.** The test's failure mode — "mentions are not delivered to seats" —
  reads exactly like a live Remote Control outage. It was diagnosed as a stub
  field name only by confirming `ownerSeat` is the persisted column and
  `dispatchedTerminal` exists nowhere in the DB layer. The fix must not paper over
  a *real* future regression in the same assertion, so the corrected test should
  assert delivery **and** that it was gated on `ownerSeat`.
- **A green run is not the finish line — a green run in CI is.** These four have
  been failing behind a hang; nothing proves the *rest* of `test:integration:all`
  (the notion, clickup, shared, regression and e2e groups) is green, because the
  runner has not reached them either. Expect more.

## Edge-Case & Dependency Audit

### Race Conditions

- None introduced. These are single-process test fixtures with a mocked HTTPS
  layer and no concurrency.
- Worth noting for the fixer: `run-integration-tests.js:60` is fail-fast, so each
  fix reveals the next failure rather than all of them at once. Budget for
  iteration, and re-run the whole group after each fix rather than the single file.

### Security

- None. No credential surface, no network. Item 1's fix specifically *removes* a
  path where a test could reach the real API if a mock were exhausted.

### Side Effects

- **Fixing these changes what CI reports, which is the point.** The first green
  `test:integration:all` may expose failures in the four groups that run after
  Linear and have therefore never been reached in this state. Those are out of
  this plan's scope but must be reported, not absorbed.
- Failed integration runs leave workspace fixtures behind under
  `src/test/integrations/fixtures/generated/` — the interrupted run that produced
  this work left two `linear-rate-limiting-*` directories untracked. Green runs
  clean up after themselves; the leftovers are a symptom, not state to preserve.

### Dependencies & Conflicts

- **`2f0e7029` is a hard prerequisite.** Without the recursion fix,
  `linear-sync-service.test.js` hangs and the runner never reaches any of these
  four. It has landed.
- `61ec4fc5` and `7acd64d5` already fixed the fifth member of this set,
  `linear-import-flow.test.js`, which failed for the same *category* of reason (a
  stale expectation of where an imported parent is written) but concealed a real
  product divergence behind it. **That is the precedent for not assuming staleness
  — each of these four was diagnosed individually, and the import one turned out
  to be half real.**
- No product file is touched by this plan, so there is no composition-root or
  standalone/extension surface to keep in step.

## Dependencies

No `sess_` session dependencies. File dependencies in this repo:

- `2f0e7029` `review(linear-seed)` — the recursion fix that makes these reachable.
  Already landed.
- `src/test/integrations/run-integration-tests.js` — the fail-fast runner that
  hid them.
- `.github/workflows/integration-tests.yml:2085` — the single CI step that runs
  the whole set.

## Adversarial Synthesis

**Key risks:** (1) the cheapest way to make each of these green is to delete the
assertion that fails, which turns four loud tests into four silent ones and is
strictly worse than the current state; (2) item 1's matcher-less FIFO mock means a
positional fix will re-break on the next product change, so the fix has to be
matchers rather than re-counting; (3) item 3's symptom is indistinguishable from a
genuine mention-relay outage, so a future real regression could be "fixed" the
same way this stale one is. **Mitigations:** every fix keeps the original
assertion and changes only the drifted setup; item 1 attaches matchers to the
queued responses instead of relying on order; item 3 asserts both delivery and its
`ownerSeat` gate, so the test still fails if the product stops honouring the
field; and item 4 keeps the `_readAttachmentIndex` check while replacing only the
dead anchor.

## Proposed Changes

### `src/test/integrations/linear/linear-regression.test.js`

**Context.** `testApplyConfigCreatesSwitchboardLabelWithExpectedColor` (`:43`),
failing at `:77`.

**Logic.** Drive the API the service actually exposes, and stop queueing a
response for a request it no longer makes.

**Implementation.**
- Drop `scopeProject: true` from the `applyConfig` call. It is not in
  `LinearApplyOptions` and never reaches the service.
- Delete the `team.projects` queued response (`:55`) and the now-orphaned second
  `(items) => items[0]` quickPick responder.
- Attach matchers to the remaining queued responses (viewer, teams, states,
  labels, `issueLabelCreate`) so a payload can never again be dequeued by a
  different query. Match on the query text, as `linear-sync-service.test.js` does.
- Keep the assertion unchanged: `applyConfig` returns `{ success: true }` and the
  label is created with `#6366f1`. That is what this test is for.

**Edge cases.** The states response must supply at least one state, or
`stateOptions` is the skip entry alone and `(items) => items[1]` is `undefined`
again — the failure being fixed. Assert the mapping that results, so a silently
empty state list cannot pass.

### `src/test/integrations/linear/linear-automation-service.test.js`

**Context.** `testProjectScopedPollingUsesFilterVariable` (`:176`), failing at
`:233`.

**Logic.** Scope the config the way the product scopes, and let the resolver run.

**Implementation.**
- Replace `projectId: 'project-1'` with `includeProjectNames: ['Acme Project']`.
- Queue a `team.projects` response resolving that name to `project-1`, with a
  matcher on the projects query. Note the query is **paginated** — it carries
  `first:`/`after:` and reads `pageInfo` (`LinearSyncService.ts:864-884`) — so the
  fixture needs `pageInfo { hasNextPage endCursor }` or the mock does not
  terminate the loop for the right reason.
- Keep the assertion exactly as it is: the filter must carry
  `project: { id: { eq: 'project-1' } }` alongside the team. That is the
  regression this test exists to catch.

**Edge cases.** Do not reintroduce the legacy `projectId` "to be safe" — it would
route through the migration path and make the test depend on
`getAvailableProjects` succeeding for a *second* reason.

### `src/test/integrations/linear/linear-remote-provider.test.js`

**Context.** The mention-relay assertion at `:157`.

**Logic.** Name the field the board actually persists.

**Implementation.**
- In the `importRemotePlan` stub (`:134`), return `ownerSeat: 'seat-1'` in place
  of `dispatchedTerminal: 'seat-1'`.
- Ensure the mock `db.findPlanByLinearIssueId` returns a record carrying that
  `ownerSeat`, since `:525` is what the delivery guard reads — the stub's return
  value and the db's must agree, or the test passes for the wrong reason.
- Add one assertion that a plan with **no** `ownerSeat` delivers nothing. Without
  it, the test cannot tell "delivered because the seat matched" from "delivered
  unconditionally", and a future regression that drops the gate stays green.

**Edge cases.** `:533` matches on `friendlyName` **or** `name` and requires
`status === 'active'`; the existing `ptyListTerminals` stub already supplies both
fields, so no change there.

### `src/test/tickets-subtask-embedding.test.js`

**Context.** `:372`, the attachment-provenance slice.

**Logic.** Re-anchor the slice on a symbol that exists; keep what it asserts.

**Implementation.**
- Replace the end anchor `'public static readonly SOURCE_PRESETS'` with
  `'private _schedulerTerminalName('`, the next member declaration after
  `getAttachmentList` (`TaskViewerProvider.ts:29121`).
- Keep the `_readAttachmentIndex(` assertion verbatim — the defect it guards (two
  tickets with identically-named attachments claiming each other's file) is real
  and unfixed by anything here.
- Make `sliceBetween`'s failure name **both** needles and say which one was not
  found. The current message reports the pair, which is why this read as
  "getAttachmentList is missing" when the missing symbol was the other one.

**Edge cases.** An end anchor that is merely the next declaration is itself
fragile — see `## Outstanding Questions`.

### `src/test/integrations/run-integration-tests.js` — report, do not just stop

**Context.** `:60` exits on the first non-zero file, so one failure masks every
later one. That is what let four tests rot unseen behind a fifth.

**Logic.** Keep fail-fast as the exit status, but run the remaining files and
print a per-file summary first, so one CI run names every broken suite instead of
the earliest one.

**Edge cases.** A file that **hangs** rather than fails still stops the run — the
exact case that hid these. A per-file timeout would bound it; that is a judgement
about CI runtime and is recorded under `## Outstanding Questions` rather than
assumed here.

## Verification Plan

### Automated Tests

1. `node src/test/integrations/linear/linear-regression.test.js` exits 0, and the
   resulting `columnToStateId` maps every one of the 13 canonical columns — not an
   empty map that merely avoided the throw.
2. `linear-regression`'s queued responses all carry matchers; reordering the
   queue in the test does not change the outcome.
3. `node src/test/integrations/linear/linear-automation-service.test.js` exits 0
   with the filter assertion unchanged and still asserting `project.id.eq`.
4. `node src/test/integrations/linear/linear-remote-provider.test.js` exits 0, and
   the added no-`ownerSeat` case delivers zero prompts.
5. `npm run test:contract:tickets-subtasks` exits 0 with the
   `_readAttachmentIndex` assertion still present.
6. `npm run test:integration:linear` exits 0 for all six files in the group.
7. `npm run test:integration:all` is run once end to end and its result reported —
   green, or with the previously-unreachable groups named.

### Goal Invariants

- `grep -c "scopeProject" src/test/integrations/linear/linear-regression.test.js`
  is **0** (paired positive: the file still calls `applyConfig` and still asserts
  `{ success: true }` — the option is gone, the coverage is not).
- `grep -c "dispatchedTerminal" src/test/` is **0** — the field exists nowhere in
  `src/services/KanbanDatabase.ts`, so any surviving occurrence is a test asserting
  against a schema that does not exist.
- `grep -c "SOURCE_PRESETS" src/` is **0**, and
  `src/test/tickets-subtask-embedding.test.js` still contains
  `_readAttachmentIndex` — the anchor dies, the assertion lives.
- `grep -n "projectId: 'project-1'" src/test/integrations/linear/linear-automation-service.test.js`
  returns nothing, while `project: { id: { eq: 'project-1' } }` is still asserted —
  the setup changes, the expectation does not.
- Every `http.queueJson` call in `linear-regression.test.js` passes a third
  (matcher) argument; a matcher-less entry is the FIFO misrouting that caused this.
- No file under `src/services/` is modified by this plan. A product diff here
  means a stale test was diagnosed wrong and the finding is real — stop and
  re-open it, as happened with `linear-import-flow`.

## Outstanding Questions

- **[user]** Should `tickets-subtask-embedding.test.js` keep asserting on
  **source text** at all? It greps a 29,000-line file for member declarations, so
  an unrelated rename two members away breaks it — which is precisely what
  happened. *Proceeding on the assumption that it stays as-is with a corrected
  anchor:* converting it to a behavioural test of `getAttachmentList` is real work
  with its own fixture cost, and the provenance defect it guards is worth keeping
  covered in the meantime. If review wants it converted, that is a separate card
  and this plan's item 4 becomes its stopgap.
- **[user]** Should `run-integration-tests.js` impose a per-file timeout? A hang,
  not a failure, is what hid these four for months, and a summary that runs the
  remaining files does not help if the run never ends. *Proceeding on the
  assumption that it does not, for now:* a timeout tuned too tight turns a slow Pi
  run into a flaky CI failure, and picking the bound needs a measurement of each
  file's honest runtime that this plan does not have. The per-file summary is the
  part that is unambiguously right.

---

**Recommendation: Send to Coder.** (Complexity 4.)
