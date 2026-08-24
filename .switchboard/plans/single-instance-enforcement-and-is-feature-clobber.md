# Enforce one database instance per path and fix the is_feature clobber

## Goal

Close the open `is_feature` clobber investigation by fixing the logic bug that survives any storage change, and — as an immediately shippable stopgap ahead of the engine swap — guarantee that a given database file is served by exactly one in-memory instance per process.

### Problem Analysis

`docs/investigation-epic-is_epic-clobber.md` has been open since 2025-07-05 with status "Root cause candidates identified, fix not yet written". The symptom: press GROUP INTO FEATURE, the feature file lands in `.switchboard/features/`, the board shows it as a plain plan (`is_feature=0`), and roughly 15 minutes later it self-heals to a feature. Two independent candidate vectors were identified and neither has been eliminated.

**Candidate ❶ — a plain logic bug, storage-engine-independent.** `KanbanProvider.ts:10170`, inside `createFeatureFromPlanIds`, links each subtask:

```ts
const linkOk = await db.updateFeatureStatus(st.planId || st.sessionId, 0, effectiveFeaturePlanId);
```

`updateFeatureStatus` (`KanbanDatabase.ts:1630-1658`) resolves the target by `planId`, looks up `plan_file`, then updates by `plan_file + workspace_id`. It is also the *only* function in the codebase that can set `is_feature = 0` by direct UPDATE — both `UPSERT_PLAN_SQL` (`:640`) and `insertFileDerivedPlan` (`:1465`) are guarded by `is_feature = CASE WHEN excluded.is_feature > 0 THEN excluded.is_feature ELSE plans.is_feature END`, which preserves an existing value on upsert. So if `st.planId` is empty and `st.sessionId` resolves to the feature's own row — or any `planId` collision or stale lookup occurs — the subtask-linking loop sets the freshly created feature's `is_feature` back to 0. The `|| st.sessionId` fallback is the specific hazard: two different id spaces feeding one lookup.

**Candidate ❷ — the stale-snapshot clobber.** The diagnostic comment at `KanbanDatabase.ts:1050` exists to determine "whether the KanbanProvider and the GlobalPlanWatcherService are operating on the SAME in-memory sql.js instance. If they differ for the same on-disk DB, a stale-snapshot `_persist()` can silently overwrite an `is_feature=1` write". With `_doPersist()` exporting the entire database (`:9511`), the loser of that race loses every row it had, not one field.

The ~15-minute self-heal is consistent with either: a later plan-watcher import re-asserting `is_feature=1` through the guarded upsert path.

Candidate ❷ is dissolved by the sidecar/real-binding plan. Candidate ❶ is not — it is arithmetic on ids and will behave identically against any storage engine. It therefore needs its own fix, and the fix should not wait on the engine work.

### Root Cause

Two separable causes behind one symptom, which is why the investigation stalled: fixing either alone would have produced an intermittent partial improvement that looked like a wrong diagnosis.

1. `updateFeatureStatus` accepts an id from two different namespaces (`planId || sessionId`) and resolves it to a row without asserting that the resolved row is the one the caller meant.
2. Multiple `sql.js` images of one file can exist concurrently — 62 files import `KanbanDatabase` across 158 `getInstance`/`forWorkspace`/`new` sites — and whole-file export makes the collision destructive.

### Non-goals

- Replacing the storage engine (separate plan; this one is deliberately useful before and independent of it).
- Consolidating databases.
- Changing the feature-file format or `_regenerateFeatureFile` behaviour.

## Metadata

**Complexity:** 4
**Tags:** bugfix, database, backend, reliability

## User Review Required

No. Both fixes are behaviour-preserving corrections to documented-intent code paths, and the investigation doc already establishes the intended semantics.

## Complexity Audit

### Routine

- Adding a guard in the subtask-linking loop so a subtask id equal to the feature's own id is skipped outright.
- Rejecting empty/whitespace ids in `updateFeatureStatus` rather than resolving them.
- Making `_instances` / `_instancesByDbPath` (`:1017-1018`) authoritative on both keys, so a lookup by workspace root and a lookup by resolved DB path can never mint two objects for one file.
- Adding the regression tests from the investigation doc's two candidate vectors.

### Complex / Risky

- **`updateFeatureStatus` needs to assert what it resolved.** The real fix is not a null check but making the function refuse to write when the resolved `plan_file` does not belong to the id it was given, and returning a distinguishable failure the caller checks. `createFeatureFromPlanIds` currently captures `linkOk` — that return value must become load-bearing rather than advisory.
- **The two-id-namespace problem is wider than this call site.** `st.planId || st.sessionId` implies plan ids and session ids are interchangeable keys somewhere in the subtask model. Removing the fallback may break callers that rely on it. The safe move is to keep accepting both but resolve them through separate, explicit lookups, and log when the `sessionId` arm fires — if it never fires in practice, it can be deleted later.
- **Single-instance enforcement interacts with eviction.** `_evictingKeys` (`:1045`) already makes `getInstance()` await an in-flight eviction before recreating. Making instance identity strict must not deadlock against that, and must not resurrect an instance mid-eviction.
- **158 acquisition sites.** Making identity strict may surface call sites that were quietly relying on getting a fresh image. Each needs checking rather than assuming.

## Edge-Case & Dependency Audit

**Race conditions**
- The plan watcher's `registerPendingCreation(featurePath)` gives a 10s skip window (`KanbanProvider.ts:10152`), and `_regenerateFeatureFile` registers its own at `:9974`. If `_regenerateFeatureFile`'s second write lands outside the first window, the watcher imports the file mid-creation. The `is_feature` upsert guard protects the flag, but this timing should be covered by a test regardless.
- `updateFeatureStatus(featurePlanId, 1, '')` at `:10181` re-asserts the flag after the linking loop. That re-assertion is currently what masks candidate ❶ intermittently — do not remove it as part of "cleanup", or the bug becomes fully visible instead of fixed.

**Security**
- None.

**Side effects**
- Making `linkOk` load-bearing means a link failure now surfaces instead of being ignored. Expect previously silent failures to start reporting; that is the point, but it may look like a new bug on first release.
- Strict instance identity reduces memory as a side effect (fewer duplicate images), which slightly changes eviction behaviour.

**Migration**
- None. No schema or file changes. Rows already clobbered to `is_feature=0` are re-asserted by the existing plan-watcher import path, so historical damage self-heals without a repair migration. Worth confirming on a real affected DB before relying on it.

## Dependencies

- Independent. Ships before the engine swap and remains correct after it.
- The single-instance half is largely superseded by the sidecar plan; the `updateFeatureStatus` half is not superseded by anything.

## Adversarial Synthesis

Key risks: `updateFeatureStatus` accepts ids from two different namespaces (`planId || sessionId`) and resolves without asserting the resolved row is the one the caller meant — the wrong-row UPDATE survives any storage engine change; making `linkOk` load-bearing surfaces previously silent failures (may look like new bugs on first release); and strict instance identity across 158 acquisition sites may surface call sites quietly relying on a fresh image. Mitigations: resolve `planId` and `sessionId` through separate explicit lookups and log when the session-id arm fires; keep the `:10181` re-assertion that currently masks the bug intermittently; and check each acquisition site rather than assuming.

## Proposed Changes

1. **`KanbanDatabase.updateFeatureStatus` (`:1630-1658`).** Reject empty/whitespace ids. Resolve `planId` and `sessionId` through separate explicit lookups rather than one coalesced argument. Assert the resolved `plan_file` corresponds to the requested id and return a distinguishable failure otherwise. Log when the session-id arm fires.
2. **`KanbanProvider.createFeatureFromPlanIds` (`:10170`).** Skip any subtask whose resolved row is the feature itself. Check `linkOk` and surface a failure rather than continuing silently. Keep the `:10181` re-assertion.
3. **`KanbanDatabase` instance registry (`:1017-1018`).** Make identity strict across both maps so one resolved DB path yields exactly one instance, without deadlocking against `_evictingKeys`.
4. **Remove the diagnostic** `_nextInstanceId` counter (`:1050`) and its comment once the tests below pass — it is explicitly marked "Remove once the clobber is identified".
5. **Update** `docs/investigation-epic-is_epic-clobber.md` to record the resolution rather than leaving it open.

### Migration

None. Historically clobbered rows self-heal via the plan-watcher re-import; verify on an affected database.

## Verification Plan

- **Candidate ❶ reproduction:** call `createFeatureFromPlanIds` with a subtask list containing an empty `planId` whose `sessionId` collides with the feature's id. Assert `is_feature` stays 1 and the link failure is reported. This test must fail before the fix.
- **Candidate ❷ reproduction:** drive a plan-watcher import concurrently with `createFeature` from two acquisition paths for the same DB path. Assert one instance is served and `is_feature` survives.
- **Instance identity:** acquire the same DB by workspace root and by resolved DB path; assert object identity. Repeat across an in-flight eviction; assert no deadlock and no mid-eviction resurrection.
- **All three creation entry points** from the investigation doc — kanban button, Features tab, and `create-feature.js` via `POST /kanban/feature` — assert `is_feature=1` immediately after creation, with no reliance on the 15-minute self-heal.
- **Regeneration window:** assert `_regenerateFeatureFile`'s second write does not produce an `is_feature=0` read at any point.
- **`linkOk` surfacing:** force a link failure; assert it is reported rather than swallowed.
- **Existing suite** passes, including the feature and kanban regression files.

### Goal Invariants

- `createFeatureFromPlanIds` with an empty `planId` whose `sessionId` collides with the feature's id leaves `is_feature=1` — the logic bug is fixed.
- Acquiring the same DB by workspace root and by resolved DB path returns the same object instance — one in-memory image per file per process.
- All three creation entry points (kanban button, Features tab, `POST /kanban/feature`) produce `is_feature=1` immediately — no reliance on the 15-minute self-heal.
- A link failure in `createFeatureFromPlanIds` is reported, not swallowed.

## Outstanding Questions

- Does the `sessionId` arm ever fire in practice? The added logging answers this and decides whether the fallback can be deleted.
- Are there other direct-UPDATE paths that can write a non-file-derivable field and therefore have no self-heal? `dispatched_terminal`, `dispatched_at`, `blocked_at` are the candidates worth auditing for the same wrong-row hazard.
