# POST /kanban/move Silently Defaults to the First Registered Root, So a Move With No workspaceRoot Fails Against the Wrong Database in Any Multi-Root Setup

## Goal

Make `POST /kanban/move` resolve a card by identity across the registered roots instead of guessing a single workspace, so a caller that supplies a `planId` but no `workspaceRoot` moves the card that ID actually names — or fails with an error that says the card was not found and where it was looked for.

### Problem

`POST /kanban/move` accepts `workspaceRoot` as optional. When it is omitted the route falls back to the extension's own root:

```ts
const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
```
— `LocalApiServer.ts:1335`

In a multi-root install that fallback is a guess, and it is wrong for every root but one. This machine has four:

```
/Users/patrickvuleta/Documents/Gitlab            ← the fallback
/Users/patrickvuleta/Documents/GitHub/switchboard
/Users/patrickvuleta/Documents/Gitlab/analytics-dashboard
/Users/patrickvuleta/Documents/GitHub/pixel-spritesheet-studio
```

A `planId` is globally unique and unambiguous. Supplying one and still having the move fail — because the server looked in a workspace the caller never mentioned — is a defect in addressing, not in the caller's request. Observed 2026-08-08: `plan_id 65ef46d3-…` has 1 row in the `switchboard` DB and 0 in the `Gitlab` DB; a move with no `workspaceRoot` reported `Column update failed`, while the identical move with an explicit absolute root returned `success: true`.

### Root cause

The move path resolves the **database** before it resolves the **card**, so identity is subordinate to a location the caller may not have supplied:

`_handleKanbanMove` (defaults the root) → `moveCard(root, key, column)` (`TaskViewerProvider.ts:2159-2194`) → `moveCardToColumn(root, …)` (`KanbanProvider.ts:6923`) → `_getKanbanDb(root)` → `db.updateColumn(key)` (`KanbanDatabase.ts:2485`) → `getPlanBySessionId(key)` → `null` → `false`.

> **Superseded:** `moveCard(root, key, column)` (`TaskViewerProvider.ts:2181`).
> **Reason:** Line drift. The `moveCard` hook is the object literal at `TaskViewerProvider.ts:2159-2194`; `2183` is the `moveCardToColumn` call inside it, and `2181` is a closing brace. Precise anchors matter because the implementer will edit adjacent lines.
> **Replaced with:** `TaskViewerProvider.ts:2159-2194` for the hook, `:2183` for the `moveCardToColumn` call.

`getPlanBySessionId` already tries `session_id` and then falls back to `plan_id` (`KanbanDatabase.ts:4675-4694`), so identity resolution is sound — it is simply being run against the wrong database. Nothing in the chain ever asks "does any other root know this ID?".

This is the server-side half of a two-sided addressing problem; the client-side half is `move-card.js` sending a relative `'.'` (see the related plan).

### Exposure — the omitted root is the *documented* call shape

This is not a theoretical path. The sanctioned agent-facing contract documents `workspaceRoot` as optional (`.agents/skills/switchboard-orchestration/SKILL.md:117`) and **both** of its runnable examples omit it entirely:

```bash
curl -s -X POST "$BASE/kanban/move" -H "Content-Type: application/json" \
  -d '{"planId":"a1b2c3d4","targetColumn":"CODE REVIEWED"}'
```
— `SKILL.md:129-130`, and again inside the fleet-coder end-to-end walkthrough at `SKILL.md:290-291`.

So every orchestrator/fleet agent following the published contract hits the broken path, while `move-card.js` (which always sends a root, defaulting to `'.'` — `move-card.js:25,97-100`) hits the sibling defect instead. Neither caller currently works correctly in a multi-root install. *Clarification, not new scope: this is evidence for the existing Goal, not an extension of it.*

## Metadata

- **Complexity:** 5
- **Tags:** backend, api, bugfix, reliability
- **Project:** browser-switchboard

> **Superseded:** **Complexity:** 4.
> **Reason:** The improve pass found three load-bearing hazards the original score did not price in: (a) the obvious probe (`getPlanBySessionId`) is **not** read-only — it restores archived plans from the cold store into the hot DB, so a naive search *writes* to unrelated workspaces; (b) `_canonicalColumnId` already opened a DB against the **wrong** root at `:1342`, before the card's real root is known, so custom columns mis-resolve independently of the move itself; (c) `LocalApiServer` has no DB access except the `getKanbanDatabase` seam, and the extension-host implementation of that seam raises a user-facing warning toast on failure (`TaskViewerProvider.ts:7850`) — so a search implemented through it spams toasts for every uninitialised root. That is two files plus a new seam and a non-obvious correctness rule: Medium, not Low.
> **Replaced with:** **Complexity:** 5.

> **Superseded:** **Tags:** backend, kanban, api, multi-root, bugfix.
> **Reason:** `kanban` and `multi-root` are not in the permitted tag vocabulary; invented tags are dropped or mis-bucket the card.
> **Replaced with:** **Tags:** backend, api, bugfix, reliability.

## User Review Required

None.

## Complexity Audit

### Routine

- Snapshotting and iterating the registered-root list. `LocalApiServer` already holds it (`_allRoots`, set at `:379` from `options.allRoots`, populated in the extension host at `TaskViewerProvider.ts:2127` from `_filterMappedRoots(this._getWorkspaceRoots())` at `:1930`) and already publishes it on `/health` as `roots` (`:3499`).
- Adding a `resolvedWorkspaceRoot` field to the JSON the route already writes at `:1350-1351`.
- Key-shape classification (UUID vs legacy `sess_*` / `antigravity_*`) — a regex, no I/O.

> **Superseded:** "Iterating `this._allRoots` (already held by `LocalApiServer`, already surfaced on `/health` as `roots`)" listed as the *whole* routine surface, implying the search itself can be written inline in `LocalApiServer`.
> **Reason:** `LocalApiServer` deliberately does not import `KanbanDatabase` (see its import block, `:1-21` — only `PlanFileImporter`, `agentConfig`, `wsHub` and types). It reaches databases exclusively through the `getKanbanDatabase?: (workspaceRoot?) => Promise<any>` seam (`:273`). Keeping it that way is PRD contract #3 (host-agnostic via seams). Iterating the roots is routine; *probing* them from inside `LocalApiServer` is not, because the only available seam is the toast-raising one.
> **Replaced with:** Iterating `_allRoots` is routine. The per-root probe belongs behind a new, purpose-built seam implemented once in `TaskViewerProvider` (see Proposed Changes §1–§2).

### Complex / Risky

- **Do not scan roots on every move — scan only after the addressed root misses.** The common case is a correct explicit root and must stay a single DB open. A fan-out on the happy path multiplies `ensureReady()` across every registered workspace, and `ensureReady` on a cold DB runs the migration chain (`KanbanDatabase._initialize` → `SCHEMA_TABLES` → `_ensureSchemaColumns` → `_runMigrations` → `_persist`, `:6558-6570`). Fall back to the search only when the first lookup returns null.

- **The obvious probe is a WRITE. This is the single most dangerous thing in the change.** `getPlanBySessionId` (and therefore `resolvePlanByAnyId` at `:4810-4813`, and therefore `updateColumn` at `:2485`) ends with a cold-store restore:

  ```ts
  const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
  if (!cold) return null;
  const coldRec = await cold.getPlanBySessionId(sessionId);
  if (!coldRec) return null;
  return (await this.restoreToHot(coldRec.planId)) ?? coldRec;
  ```
  — `KanbanDatabase.ts:4699-4703`

  `restoreToHot` (`:4264`) `upsertPlans` into the hot DB **and** `DELETE`s the cold row (`:4273`). Probing N roots with this function can therefore un-archive plans in workspaces the caller never named, and opens each root's *archive* DB on top of its hot DB — doubling the heap cost the plan already worried about.

  The probe MUST be `hasPlan(key)` (`KanbanDatabase.ts:2416-2437`), which checks `session_id`, then `plan_id`, then delegates to cold as a pure boolean (`:2434-2436`) with no restore and no write.

  > **Superseded:** "No write-side race is introduced: the search is read-only and the subsequent move is the existing single-workspace path, unchanged." (original Race-Conditions section).
  > **Reason:** Factually wrong about the code. Any probe built on `getPlanBySessionId` / `resolvePlanByAnyId` performs a cold→hot restore plus a cold `DELETE` as a side effect of *reading*. Calling the search "read-only" would have licensed exactly the implementation that corrupts sibling workspaces.
  > **Replaced with:** The search is read-only **only if** the probe is `hasPlan()`. Using any `getPlan*` / `resolvePlan*` reader as the probe is a defect; treat "probe must be `hasPlan`" as a hard requirement, not a preference.

- **`ensureReady()` on an unopened root has real cost.** Opening every registered workspace's DB to answer one move loads several multi-megabyte sql.js images into the shared WASM heap. The known failure mode is a `disk I/O error` across all DBs from heap exhaustion, which looks like corruption and is not. Open lazily, one root at a time, and stop as early as the ambiguity rule permits.

  > **Superseded:** "…and no unbounded growth — the known WASM-heap exhaustion signature" (framing the risk as unbounded growth).
  > **Reason:** The codebase already bounds resident DB bytes. `startEvictionSweep` runs `_runEvictionSweep` on a `setInterval` (`KanbanDatabase.ts:1667-1670`), which TTL-evicts idle non-active instances after `EVICTION_TTL_MS = 10 min` (`:941`, `:1718-1729`) and then runs a size gate that evicts oldest-first — cold instances first — while `_summedResidentDbBytes()` (`:1758`) exceeds `_residentDbBudgetBytes` (`:1734-1746`). Growth is not unbounded.
  > **Replaced with:** The real risk is a **transient spike above budget inside a single search burst**, because the sweep is timer-driven, not synchronous per-open. Bound the spike by construction (stop early; probe with `hasPlan`; never open a root twice) and verify against `_summedResidentDbBytes()` vs `_residentDbBudgetBytes` plus absence of `disk I/O error`, rather than against a "no growth" claim the eviction sweep already owns.

- **Never create a database while searching.** A read that creates a DB in an unrelated root is worse than the bug being fixed.

  > **Superseded:** "The search must open only workspaces that already have a `.switchboard/kanban.db` … Check for file existence before opening."
  > **Reason:** Two problems. (1) The stated check is *wrong* for a real configuration: `KanbanDatabase.forWorkspace` resolves the DB path from `.switchboard/db-pointer` first (`:1065-1069`), then the `switchboard.kanban.dbPath` setting (`:1077-1091`), and only then defaults to `<root>/.switchboard/kanban.db` (`:1093`). A root whose DB is redirected would be **skipped**, so the search would miss the card and report not-found — reintroducing the exact bug for pointer-configured installs. (2) The check is not the safety mechanism it was credited as: `_initialize` already refuses to create (`KanbanDatabase.ts:6545-6552`, `'Database file does not exist (not auto-creating)'` → returns `false`), and the only `mkdir` sits *inside* the `fs.existsSync(this._dbPath)` branch (`:6513-6523`), so it cannot run for a missing DB.
  > **Replaced with:** Rely on `_initialize`'s existing no-create contract as the guarantee, and gate on the **resolved** DB path (the same resolution `forWorkspace` performs), never on a hardcoded `.switchboard/kanban.db`. Because the probe lives in `TaskViewerProvider` (§1), it can reuse the real resolution instead of re-deriving it. Verification step 6 stays — it proves the guarantee still holds.

- **The probe must not raise UI.** The extension-host `getKanbanDatabase` seam is `(wsRoot) => this._getKanbanDb(wsRoot)` (`TaskViewerProvider.ts:2121`), and `_getKanbanDb` calls `this._seams().ui.showWarningMessage("Kanban DB initialization failed: …")` on any init failure (`:7844-7855`). A search that touches an uninitialised root through that seam pops a warning toast per root (deduped per-root by `_lastKanbanDbWarnings`, so once each — still spurious). The probe path must use the non-toasting accessor (`KanbanProvider._getKanbanDb`, `:2208-2221`, plus an explicit `ensureReady()` whose `false` is handled silently) or suppress the warning for probe calls. It must also `try/catch` **per root**: `KanbanDatabase.forWorkspace` throws on an invalid root (`:1050-1054`) and `_getKanbanDb` does not catch it, so one bad root would otherwise reject the whole search.

- **An explicit-but-wrong root must not be silently overridden.** If the caller says `workspaceRoot: X` and the card lives in Y, moving it in Y hides a caller bug and could move a card the caller never intended to touch. Decide explicitly: an *explicit* root that misses is an error naming X; only an *omitted* root triggers the cross-root search. This distinction is the whole safety story of the change.

- **Ambiguity must not be resolved by luck — and "stop at first hit" and "fail on two hits" cannot both be unconditional.** The original plan asserted both (`stop at the first hit rather than collecting all matches` in Complex/Risky, `More than one hit ⇒ an ambiguity error` in Proposed Changes). Resolve the contradiction by key shape, which the codebase makes decidable:
  - `plan_id` is a DB-assigned UUID — collision across roots is not a practical concern.
  - Legacy `session_id` values are `sess_<timestamp>` or `antigravity_<64 hex>` (`KanbanDatabase.ts:5958-5966`, `TaskViewerProvider.ts:17602,17615`) — neither is UUID-shaped, and `sess_<timestamp>` *could* in principle repeat across workspaces.

  > **Superseded:** Unconditional "stop at the first hit" (Complex/Risky) coexisting with unconditional "more than one hit ⇒ ambiguity error" (Proposed Changes §1).
  > **Reason:** Directly self-contradictory: you cannot detect a second match after stopping at the first. An implementer would pick one arbitrarily, and either choice silently drops a stated requirement.
  > **Replaced with:** Branch on key shape. **UUID-shaped key** ⇒ stop at the first hit (cheapest; collisions impossible by construction). **Non-UUID key** (legacy `sess_*` / `antigravity_*` / anything else) ⇒ probe every remaining root and fail with all matching roots named if more than one hits. This honours both requirements and makes the cheap path the common one.

- **Column canonicalisation runs against the wrong root, before the card is located.** `_canonicalColumnId(rawColumn, workspaceRoot)` at `:1342` passes the *defaulted* root into `this._options.getKanbanDatabase?.(workspaceRoot)` (`:1103`) and reads that DB's board plus `kanban.customColumns` (`:1105-1117`). So on the omitted-root path a custom column that exists only in the card's real workspace resolves to `null` and the request 400s with "Unknown targetColumn" *before* the move is even attempted — a second, independent manifestation of the same wrong-database bug. The fix must re-canonicalise against the resolved root, and must not report a column error derived from a workspace the caller never named. *Clarification: same defect, same route, same request — not new scope.*

## Edge-Case & Dependency Audit

### Race conditions

- **The root list is a construction-time snapshot, and the real hazard is staleness, not mid-search mutation.** `_allRoots` is captured once when the server is built (`TaskViewerProvider.ts:1930` → `:2127`); `LocalApiServer` never re-reads it, and `TaskViewerProvider` does not restart the server on `onDidChangeWorkspaceFolders` (the listeners live in `extension.ts:1223`, `KanbanProvider.ts:460,1251`, `PlanningPanelProvider.ts:863`, `DesignPanelProvider.ts:740`, `GlobalPlanWatcherService.ts:228` — none of them restart the API server). `_startLocalApiServer` is re-entrant and *is* re-invoked by the liveness watchdog (`:1917`, `:2626`), so the list refreshes eventually — but a root added mid-session is invisible to the search until then.

  > **Superseded:** "A root registered or removed mid-search. Snapshot the root list once at the start of the search rather than re-reading it per iteration."
  > **Reason:** The mitigation is already structurally satisfied — there is nothing to re-read per iteration, because `_allRoots` is an immutable array captured at construction. The prescription addressed a race that cannot occur while missing the one that can.
  > **Replaced with:** Accept the snapshot. A newly added root is not searchable until the API server restarts; the not-found error must therefore **list the roots it actually searched**, so this limitation is legible from the response instead of presenting as "the card does not exist". Do not add a workspace-folder listener in this plan — that is a separate change with its own restart semantics.

- The search itself introduces no write-side race **provided** the probe is `hasPlan()` (see Complex/Risky). The subsequent move is the existing single-workspace path, unchanged.
- Concurrent probe and board activity on the same DB is safe: `ensureReady` awaits any in-flight eviction for that workspace before reopening (`KanbanDatabase.ts:1862-1868`), and `hasPlan` takes no locks.

### Security

- No new surface. The route's auth (`_checkAuth(req, true)`, `:1317`) is unchanged, and the search is confined to already-registered roots taken from `_allRoots` — it cannot be steered at an arbitrary path by the request body. The request body must never contribute a root to the candidate list.
- The not-found / ambiguity errors disclose absolute workspace paths to the caller. That is already true of `GET /health` (`roots: this._allRoots`, `:3499`) on the same loopback-only, token-gated server, so it introduces no new disclosure.

### Side effects

- **The current failure is read-only**, so there is no existing corruption to clean up: the miss returns false before any write. Verified 2026-08-08 — no stray `.switchboard/` or `kanban.db` was created by repeated failed moves.
- Successful cross-root moves will now fire integration sync and feature-file regeneration in a workspace the caller did not name — `queueIntegrationSyncForSession` plus `_regenerateFeatureFile` for the feature or its parent (`KanbanProvider.ts:6947-6965`). That is correct (it is the card's real home) but it means the response must report which root was used, so the caller can tell.
- A cross-root feature move cascades atomically by `plan_id` (`cascadeFeatureByPlanId`, `:6943`) and fans sync out to every subtask (`:6951-6957`) **in the resolved workspace**. Verification step 8 exists to prove that fan-out lands there and not in the default root.
- **Standalone host is unaffected and stays honestly gated.** `src/standalone/bootstrap.ts` builds its `LocalApiServer` options at `:1643-1786` with `allRoots: [workspaceRoot]` (`:1655`) and `getKanbanDatabase: async () => db` (`:1656`), and wires `createFeature` / `assignToFeature` / `removeSubtaskFromFeature` / `deleteFeature` / `splitFeature` / `reconcileFeatures` — but **no `moveCard`**. `POST /kanban/move` therefore returns `503 'Kanban move not available'` there (`:1322-1327`), which is correct capability-gating (PRD contract #6) and not a regression. Under PRD contract #7 this change is Layer-1-only by design: single-root standalone has nothing to search. Do not "fix" the 503 in this plan, and do not add a `resolvePlanRoots` implementation to `bootstrap.ts` — a single-root host resolving across one root is dead code that reads as capability.

### Dependencies & conflicts

- **Should land after** `column-update-failed-masks-plan-not-found` (`.switchboard/plans/feature_plan_20260808103200_column-update-failed-masks-plan-not-found.md`). That plan makes the "not found" case distinguishable from a genuine update failure; without it, this plan's new error paths have nowhere useful to report to and the improvement is invisible. Not strictly blocking — the two can be built together — but building this first means writing error text that the transport then discards. Concretely: `moveCard` collapses every failure into `{ success: false, error: 'Column update failed' }` (`TaskViewerProvider.ts:2190`), so a precise not-found message produced inside the search survives only because this plan returns it from the **route**, above that hook.
- **Related:** `move-card-script-sends-relative-workspace-root` (`.switchboard/plans/feature_plan_20260808103000_move-card-script-sends-relative-workspace-root.md`) — the client-side half. Note that fixing the script does **not** fix this: the script sends a root (`move-card.js:25`, defaulting to `'.'`), whereas this defect is about the root being *omitted*. Both paths need fixing, and neither subsumes the other.
- `this._allRoots` and `this._options.workspaceRoot` are both already available on `LocalApiServer`; no new *host* seam is required, but a new **option hook** is (§1) because the existing `getKanbanDatabase` seam raises UI on failure.
- **Route audit (completed in this pass — recorded, deliberately not fixed here).** 21 sites use the `body?.workspaceRoot || this._options.workspaceRoot` shape. Classified:

  | Route handler | Line | Resolves a plan by identity? | Verdict |
  |---|---|---|---|
  | `_handleKanbanDispatch` | 1180 | Yes (`plan` / `planId` / `sessionId`) | **Same defect, larger blast radius** — it moves a card *and* fires an agent. Highest-priority follow-up. |
  | `_handleKanbanMove` | 1335 | Yes | This plan. |
  | `_handleKanbanCreateFeature` | 1381 | Yes (`planIds[]`) | Same shape; creates a feature, so a wrong root produces a feature in the wrong workspace. Follow-up. |
  | `_handleKanbanAssignFeature` | 1427 | Yes | Same shape. Follow-up. |
  | `_handleKanbanFeaturesAssign` | 1472 | Yes | Same shape. Follow-up. |
  | `_handleKanbanRemoveSubtaskFromFeature` | 1522 | Yes | Same shape, destructive. Follow-up. |
  | `_handleKanbanDeleteFeature` | 1560 | Yes | Same shape, destructive. Follow-up. |
  | `_handleKanbanSplitFeature` | 1599 | Yes | Same shape, destructive. Follow-up. |
  | `_handleKanbanReconcileFeatures` | 1652 | Yes (manifest of IDs) | Same shape. Follow-up. |
  | `_handleOrchestrationDispatch` | 2200 | Yes (`featurePlanId`) | Documented as `workspaceRoot` **required** (`SKILL.md:123`); lower exposure. |
  | `_handleOrchestrationStart` | 2252 | No (root is the subject) | Correct as-is. |
  | `_handleWorktreeCleanup` | 2003 | No (`worktreeId` / `branch`) | Correct as-is. |
  | `_handleCreatePlan` | 2617 | No — root is the **destination** | Correct as-is. |
  | `_handleImportPlans` | 2811 | No — root is the **destination** | Correct as-is. |
  | `_handleTerminalVerb` / `KanbanVerb` / `PlanningVerb` / `TicketsVerb` / `DesignVerb` / `SetupVerb` / `TaskViewerVerb` | 1744, 1799, 1828, 1857, 1898, 1946, 1975 | No — root is a payload passthrough | Correct as-is. |

  Do not widen the fix beyond `/kanban/move` in this plan — the destructive feature routes each carry their own side-effect profile and deserve individual review. The `_handleKanbanDispatch` case in particular should become its own plan.

## Dependencies

- `.switchboard/plans/feature_plan_20260808103200_column-update-failed-masks-plan-not-found.md` — error semantics; land first or together (soft dependency).
- `.switchboard/plans/feature_plan_20260808103000_move-card-script-sends-relative-workspace-root.md` — client-side half of the same addressing problem; independent, neither blocks the other.

*(No `sess_*` session dependencies: these are file-based plans with DB-assigned `plan_id`s, so plan-file paths are the stable references.)*

## Adversarial Synthesis

Key risks: the obvious identity probe (`getPlanBySessionId` / `resolvePlanByAnyId`) silently **writes** — it restores archived plans from the cold store and deletes the cold row — so a naive cross-root search mutates workspaces the caller never named; `_canonicalColumnId` already queries the wrong root at `:1342`, meaning a custom-column move can 400 before the search ever runs; and the original plan self-contradicted by requiring both "stop at first hit" and "fail on two hits". Mitigations: probe with the pure-boolean `hasPlan()` behind a purpose-built, non-toasting, per-root `try/catch`ed hook; re-canonicalise the column against the resolved root; and branch the stop rule on key shape (UUID ⇒ first hit wins, legacy `sess_*` ⇒ probe all and refuse on ambiguity). The one property that must survive review unchanged: an **explicitly supplied** `workspaceRoot` is never overridden — it either hits or errors naming that root, with no search.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — a read-only, non-toasting cross-root plan probe

**Context.** `LocalApiServer` cannot probe roots itself: it does not import `KanbanDatabase` (import block `:1-21`) and its only DB access is the `getKanbanDatabase` seam (`:273`), whose extension-host implementation raises a warning toast on init failure (`TaskViewerProvider.ts:7844-7855`). Keeping DB knowledge out of `LocalApiServer` is PRD contract #3.

**Logic.** Add one option hook alongside `moveCard` on `LocalApiServerOptions` (`LocalApiServer.ts:47-52`):

```ts
/**
 * Read-only: which registered roots contain a plan addressed by `key`
 * (plan_id or legacy session_id)? Used ONLY when the caller omitted
 * workspaceRoot. Never opens a DB that does not exist, never writes.
 * `stopAtFirst` lets a UUID key short-circuit after one hit.
 */
resolvePlanRoots?: (
    key: string,
    opts: { candidates: string[]; stopAtFirst: boolean }
) => Promise<{ matched: string[]; searched: string[] }>;
```

**Implementation.**
- Implement it in the same options literal that already wires `moveCard` (`:2159-2194`).
- For each candidate root, in order, inside its own `try/catch` (`KanbanDatabase.forWorkspace` throws on an invalid root — `KanbanDatabase.ts:1050-1054`):
  - Obtain the instance via the **non-toasting** accessor path (`KanbanProvider._getKanbanDb`, `:2208-2221`) and `await db.ensureReady()`; a `false` result means "no DB here" — record the root in `searched`, add nothing to `matched`, log at debug only. Do **not** route probes through `TaskViewerProvider._getKanbanDb`, whose failure branch shows a warning message.
  - Probe with `await db.hasPlan(key)` (`KanbanDatabase.ts:2416-2437`) — checks `session_id`, then `plan_id`, then cold as a pure boolean. **Do not** use `getPlanBySessionId`, `getPlanByPlanId`, `resolvePlanByAnyId`, `resolvePlanIdentifier`, or `updateColumn` as the probe: each can trigger `restoreToHot` (`:4699-4703`, `:4264-4276`), which upserts into the hot DB and `DELETE`s from cold.
  - On a hit, push the root to `matched`; return immediately when `stopAtFirst`.
- De-duplicate candidates by their **effective** root before probing (`KanbanProvider.resolveEffectiveWorkspaceRoot`, used by `_getKanbanDb` at `:2213`) so two roots mapped to one parent DB are probed once. Note `_filterMappedRoots` (`:2695-2725`) already strips mapped children from `_allRoots`, so this is a cheap second belt.
- Return `searched` populated with every root actually visited, so the route's error text can name them.

**Edge cases.** Empty `candidates` ⇒ `{ matched: [], searched: [] }`. A root whose DB is redirected via `.switchboard/db-pointer` (`KanbanDatabase.ts:1065-1069`) or the `switchboard.kanban.dbPath` setting (`:1077-1091`) resolves correctly because `forWorkspace` performs that resolution — this is precisely why the probe lives here rather than behind a hardcoded `.switchboard/kanban.db` existence check. A workspace whose DB is missing is skipped without creation: `_initialize` returns `false` with `'Database file does not exist (not auto-creating)'` (`:6545-6552`), and its only `mkdir` is inside the `existsSync` branch (`:6513-6523`).

**Do not** implement `resolvePlanRoots` in `src/standalone/bootstrap.ts` — see Side effects.

### 2. `src/services/LocalApiServer.ts` — resolve identity before location, only when the root is omitted

**Context.** `:1335` conflates "caller supplied a root" with "caller supplied nothing"; `:1342` then canonicalises the column against that guess; `:1349` moves against it.

**Logic.** Split the two cases explicitly and order the work as: classify key → resolve root → canonicalise column → move.

**Implementation.**
- At `:1335`, keep the resolved value but also record provenance:
  ```ts
  const explicitRoot = String(body?.workspaceRoot || '').trim();
  const defaultRoot  = String(this._options.workspaceRoot || '').trim();
  const rootWasExplicit = explicitRoot.length > 0;
  ```
- **Explicit root** ⇒ behave exactly as today, including the current `_canonicalColumnId(rawColumn, explicitRoot)` call and the current 400. If the move misses, return a not-found error naming **that** root and do **no** search. This is the deliberate asymmetry and the safety property of the change.
- **Omitted root** ⇒
  1. **Zero-DB fast path for path-shaped keys.** If `effectiveKey` contains `/` or ends `.md`, it is a plan-file path (the `moveCard` hook already treats it as one — `TaskViewerProvider.ts:2170-2182`). Resolve the root by path containment against `_allRoots` — pure string work, no DB opened. Use that root and skip the probe entirely. *Clarification: this is the same key the route already accepts, not a new input form.*
  2. Otherwise classify the key: UUID-shaped ⇒ `stopAtFirst: true`; anything else (legacy `sess_<timestamp>` / `antigravity_<64 hex>` — `KanbanDatabase.ts:5958-5966`, `TaskViewerProvider.ts:17615`) ⇒ `stopAtFirst: false`.
  3. Probe the **default root first** (preserving today's fast path), then the remaining entries of `_allRoots`, via `resolvePlanRoots`. If the hook is not wired, fall back to today's behaviour unchanged (a host that cannot search must not start failing).
  4. `matched.length === 1` ⇒ that root wins.
     `matched.length === 0` ⇒ `404`-style not-found error naming the key **and** listing `searched`.
     `matched.length > 1` ⇒ ambiguity error naming every matching root. Do not pick one.
- **Canonicalise the column against the resolved root, not the guess.** Move the `_canonicalColumnId` call (`:1342`) to *after* root resolution on the omitted-root path, and pass the resolved root. Rationale: `_canonicalColumnId` reads that root's board and `kanban.customColumns` (`:1103-1117`), so canonicalising against the default root makes a custom column that exists only in the card's real workspace 400 as "Unknown targetColumn" before the move is attempted.
- Call `moveCard(resolvedRoot, effectiveKey, targetColumn, planFile)` as today (`:1349`).
- **Report the resolved root.** Add `resolvedWorkspaceRoot` (and, on the omitted-root path, `rootResolution: 'explicit' | 'default' | 'searched' | 'path'`) to the JSON the route already writes at `:1350-1351`. No change to the `moveCard` option signature (`:47-52`) is needed — the route knows the root it chose. *Clarification of the original "include the resolved root in the success response", which did not say who adds it; widening the hook's return type would touch `TaskViewerProvider` and `bootstrap.ts` for no benefit.*

**Edge cases.** `_allRoots` empty (single-root install, or a host that passed no `allRoots`) ⇒ the search degenerates to the default root and behaviour is byte-identical to today. `explicitRoot` that is not in `_allRoots` ⇒ still honoured verbatim, as today; do not start validating it in this plan (that is a behaviour change on shipped installs). A `planFile` body field is orthogonal and continues to be forwarded unchanged.

> **Superseded:** "When it was omitted: … search the remaining entries of `this._allRoots`, skipping any root with no existing `.switchboard/kanban.db` on disk, opening lazily and stopping at the first hit."
> **Reason:** Three defects in one sentence: it searches from inside `LocalApiServer` (which has no DB access except the toast-raising seam); it gates on a hardcoded `.switchboard/kanban.db` that is wrong for `db-pointer` / `kanban.dbPath` installs; and it stops at the first hit unconditionally, contradicting the same section's ambiguity requirement.
> **Replaced with:** The `resolvePlanRoots` hook (§1) plus the key-shape stop rule and resolved-root canonicalisation above.

### 3. Document the resolution rule at the route

The doc comment at `:1308-1315` currently presents `workspaceRoot` as a plain optional field. State the actual contract: omitted means "resolve by identity across registered roots (`GET /health` → `roots` lists them)", supplied means "this root or fail". A future reader must not re-introduce a silent fallback. Note explicitly that the probe is read-only and must stay `hasPlan`-based, and that the resolved root is echoed as `resolvedWorkspaceRoot`.

### 4. `.agents/skills/switchboard-orchestration/SKILL.md` — make the contract match

The row at `:117` says `workspaceRoot?` with no explanation, and the examples at `:129-130` and `:290-291` omit it. Once §2 lands, that omission is *correct* rather than accidentally broken — say so in the row: omitted ⇒ resolved by identity across `GET /health` `roots`, supplied ⇒ that root or a not-found error. Leave the examples as they are; they become the documented, working shape. Keep the note that `POST /kanban/move` is unavailable (503) on the standalone host.

## Verification Plan

Per session directive, compilation and automated test execution are out of scope for this pass. Steps 1–9 are manual/observational and are the acceptance gate.

### Automated Tests

None executed in this session (directive: SKIP TESTS, SKIP COMPILATION). For whoever adds coverage later, the assertions worth locking — all expressible against `new LocalApiServer({...})` with stubbed hooks, the pattern already used in `src/test/pty-route-surface-contract.test.js:92-156` and `src/test/design-asset-route-traversal.test.js:143-168` (which already passes `allRoots: [wsRoot, otherRoot]`):

1. Omitted root + key present only in a non-default root ⇒ `200`, and `resolvePlanRoots` was called; `resolvedWorkspaceRoot` equals that root.
2. Explicit root that misses ⇒ non-200 naming that root, and `resolvePlanRoots` was **never** called (the asymmetry, asserted on the stub's call count).
3. Correct explicit root ⇒ `moveCard` called exactly once with that root; `resolvePlanRoots` never called (the single-open guard).
4. Two matches for a `sess_*` key ⇒ non-200 whose body names both roots, and `moveCard` never called.
5. UUID key ⇒ hook invoked with `stopAtFirst: true`; `sess_*` key ⇒ `stopAtFirst: false`.
6. Hook absent from options ⇒ behaviour identical to the pre-change baseline (no throw, no search).
7. A static grep-style guard asserting the probe implementation calls `hasPlan(` and does **not** reference `getPlanBySessionId` / `resolvePlanByAnyId` / `restoreToHot` — the write-side-effect trap is the single most likely regression and is invisible to behavioural tests that use a fully-populated hot DB.

### Manual verification

1. **Reproduce.** With ≥2 roots registered, `POST /kanban/move` with a `planId` from a non-primary root and no `workspaceRoot`. Confirm today's failure first.
2. **Fix, then repeat.** Same request succeeds, the card moves in its own workspace, and the response names the resolved root (`resolvedWorkspaceRoot`).
3. **Happy path unchanged, and still single-open.** A move with a correct explicit root behaves exactly as before. Confirm via logging that no additional workspace DB was opened — this is the performance guard, and an assertion that only fires under a debug flag is acceptable.
4. **Explicit-but-wrong root.** Supply a root that does not contain the card. Must fail naming that root, and must **not** move the card in its real workspace. This is the safety property; if it silently succeeds, the change is wrong.
5. **Unknown key.** A `planId` present in no root fails with a not-found error listing the roots searched.
6. **No scaffolding.** Register a root that has never had Switchboard initialised. Run a search that traverses it. Confirm no `.switchboard/` directory and no `kanban.db` are created there, **and** that no "Kanban DB initialization failed" warning toast appears (the probe must use the non-toasting accessor).
7. **No archive mutation — the write-side-effect check.** Archive a plan in a non-default root (so it exists only in that root's `kanban-archive.db`). Run a cross-root search for an *unrelated* key that traverses that root. Confirm the archived plan is still in `kanban-archive.db` and has **not** appeared in `kanban.db`. A `hasPlan`-based probe leaves both untouched; a `getPlanBySessionId`-based one restores it and deletes the cold row.
8. **Heap cost.** With all four roots registered and populated, run 20 consecutive cross-root searches. Confirm no `disk I/O error`, and that `_summedResidentDbBytes()` returns under `_residentDbBudgetBytes` after the next eviction sweep tick (`EVICTION_TTL_MS` = 10 min; sweep at `KanbanDatabase.ts:1667-1670`, size gate at `:1734-1746`). Transient excursions above budget *between* ticks are expected and acceptable; a sustained excursion after a tick is not.
9. **Custom column cross-root.** Define a custom kanban column that exists **only** in a non-default root. Move a card from that root into it with no `workspaceRoot`. Must succeed — this proves `_canonicalColumnId` now runs against the resolved root, not the guess. Before the fix this 400s with "Unknown targetColumn".
10. **Feature cascade.** Resolve a *feature* card cross-root and confirm its subtasks cascade in the correct workspace and that external sync fans out there, not in the default root.
11. **Backwards move.** Cross-root move from `CODE REVIEWED` to `PLAN REVIEWED` succeeds — no transition guard exists and none should be introduced.
12. **Path-shaped key.** Pass a plan-file path as the key with no `workspaceRoot`. Confirm it resolves by path containment with **zero** additional DB opens (`rootResolution: 'path'`).
13. **Standalone unchanged.** `npx switchboard`, then `POST /kanban/move` ⇒ still `503 'Kanban move not available'`. No new route behaviour, no `resolvePlanRoots` wired.

## Recommendation

**Send to Coder.** Build it, after (or alongside) the error-semantics plan. Complexity 5 — the logic is small, but four things are load-bearing and easy to get subtly wrong: the asymmetry between omitted and explicit roots; the probe being `hasPlan()` rather than any `getPlan*`/`resolvePlan*` reader (those *write*); re-canonicalising the column against the resolved root; and the key-shape stop rule that reconciles "stop at first hit" with "refuse on ambiguity".

The single most important property to preserve under review: an explicitly supplied root is never overridden. The second: the search never writes. Everything else in this plan is an optimisation of a failure message.

## Review Findings

Reviewed 2026-08-10. Files changed: `LocalApiServer.ts` (explicit/omitted split, key-shape stop rule, resolved-root canonicalisation, `resolvedWorkspaceRoot`/`rootResolution` echo), `TaskViewerProvider.ts` (`resolvePlanRoots` via `KanbanDatabase.forWorkspace` + `hasPlan`, per-root try/catch, effective-root dedup), `switchboard-orchestration/SKILL.md`. Two MAJOR findings fixed: (1) path containment used `startsWith(root + '/')`, a permanent no-op on Windows where roots and absolute plan paths are backslash-separated — replaced with `path.relative`-based containment; (2) a containment miss fell out of the `if`/`else if` chain entirely, so a **relative** plan-file key with no `workspaceRoot` silently addressed the default root and never reached the probe — it now falls through to `resolvePlanRoots`, which learned to probe path keys via the equally pure `hasPlanByPlanFile`. Validated behaviourally against a live `LocalApiServer` with stubbed hooks (17/17): explicit root never searched, omitted UUID resolves cross-root with `stopAtFirst:true`, `sess_*` ambiguity ⇒ 409 naming both roots with no move, no match ⇒ 404 listing searched roots, absolute path key ⇒ zero DB opens, unwired hook ⇒ byte-identical pre-change behaviour, `moveCard` absent ⇒ 503; a real DB confirms `_initialize` logs "not creating" so the probe never scaffolds. Remaining risks: the ambiguity 409 omits `searchedRoots`, the 404 omits `resolvedWorkspaceRoot`/`rootResolution`, and `searched` records raw candidates so roots collapsed by the effective-root dedup are under-reported — all cosmetic, deferred.
