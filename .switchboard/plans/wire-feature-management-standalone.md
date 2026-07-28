---
description: "Close the headless gap the way the bootstrap already closes it for every other panel: construct KanbanProvider in the standalone host under the existing vscodeShim + seam bundle, attach it to the already-constructed TaskViewerProvider, supply the six LocalApiServerOptions hooks so the seven feature routes stop returning 503, and route the three UI verbs (createFeature, promoteToFeature, addSubtaskToFeature) to the provider's real handleServiceVerb. Zero changes to KanbanProvider — no extraction, no risk to the ~4,000 shipped installs, schema validation and byte-identical behaviour for free. Supersedes the FeatureManagementService extraction plan."
---

# Construct KanbanProvider in the Standalone Host and Wire Feature Management

## Goal

**Definition of done: every feature-management operation works over `npx switchboard` — from both the browser board UI and the `kanban_operations` scripts — through the *same code path the extension uses*, with results returned in-body, and with `src/services/KanbanProvider.ts` unmodified.**

### Core problem (root-cause analysis)

Two distinct callers reach feature management, and both fail in the standalone host, differently.

**The script path fails loudly.** `create-feature.js` POSTs `/kanban/feature`, discovering the port from `.switchboard/api-server-port.txt`. **Standalone writes that file** (`bootstrap.ts:1016`), so discovery succeeds and the request reaches a real, shared route. `_handleKanbanCreateFeature` (`LocalApiServer.ts:1261-1299`) then hits:

```ts
const createFeature = this._options.createFeature;
if (!createFeature) {
    res.writeHead(503, …);
    res.end(JSON.stringify({ error: 'Feature creation not available' }));
    return;
}
```

The script surfaces that 503 clearly and deliberately refuses a raw-DB fallback (orphan risk, per its header comment). The same holds for the five sibling hooks and their six other routes (`LocalApiServer.ts:1313`, `:1359`, `:1408`, `:1446`, `:1485`, `:1539`) — none is supplied by `bootstrap.ts`. In the extension all six are supplied by `TaskViewerProvider.ts:1672-1740`, each a four-line delegate to `this._kanbanProvider`.

**The UI path fails silently.** The browser board's **PROMOTE TO FEATURE** button (`kanban.html:2751`) posts `createFeature`, `promoteToFeature`, or `addSubtaskToFeature`. Standalone's `kanbanVerb` (`bootstrap.ts:578-838`) implements twenty verbs — `addProject, chatCopyPrompt, completePlan, completeSelected, createPlan, deleteProject, getSetting, importFromClipboard, improvePlan, moveAll, moveSelected, promptAll, promptSelected, ready, refresh, reviewPlan, saveSetting, scanFoldersNow, selectWorkspace, setProjectFilter` — and none of the three is among them, so all three hit the `default:` at `:836` and return `{success:false, error:"Verb 'X' not implemented in standalone mode"}` (which the browser then discards — see the companion transport plan).

#### The real root cause: kanban is the only panel the bootstrap hand-rolls

The standalone host is **not** a `KanbanProvider`-free environment by design. It already constructs four providers under the `vscodeShim` + `createVscodeHostSeams` + minimal in-memory `ExtensionContext` pattern, and routes each one's verbs through its **real** `handleServiceVerb`:

| Provider | Constructed at | Verb routing |
|---|---|---|
| `DesignPanelProvider` | `bootstrap.ts:502` | `:983` → `designProvider.handleServiceVerb` |
| `SetupPanelProvider` | `:513` | `:987` → `setupProvider.handleServiceVerb` |
| `TaskViewerProvider` | `:519` | `:989` → `taskViewerProvider.handleServiceVerb` |
| `PlanningPanelProvider` | `:553` | `:960` → `planningProvider.handleServiceVerb` |
| **`KanbanProvider`** | **never** | **`:578` hand-rolled 20-arm switch** |

The bootstrap's own comment at `:440-451` describes the pattern precisely: *"Each provider is constructed with a minimal in-memory ExtensionContext … then injected with the seam bundle + a BroadcastHub … pre-assigning `_hostSeams`/`_broadcaster` pre-empts each provider's `_initXService` … `handleServiceVerb` then dispatches read/query arms over HTTP with no `vscode` process reachable."*

Kanban is the outlier, and that outlier — not any inherent VS Code coupling in the six feature methods — is why feature management is unreachable headlessly. This is exactly what PRD contract #7 describes as the missing Layer 2: *"the standalone bootstrap **constructs the provider** and wires its **verb router** into `LocalApiServer`."*

Everything needed is already in place and verified:

- **All three UI verbs are already allowlisted.** `createFeature`, `promoteToFeature`, `addSubtaskToFeature` (plus `removeSubtaskFromFeature`, `deleteFeature`) are present in `src/generated/verbAllowlist.ts`'s `KANBAN_VERBS`, so `handleServiceVerb`'s allowlist check (`KanbanProvider.ts:7093`) passes.
- **`TaskViewerProvider.setKanbanProvider()` is public** (`:3068`), so the already-constructed standalone `TaskViewerProvider` can be given the provider and its six hook bodies work verbatim.
- **The DB instance is shared, not duplicated.** `KanbanDatabase.forWorkspace` is a process-wide cache keyed by resolved root (`KanbanDatabase.ts:938-948`) and `KanbanProvider._getKanbanDb` delegates to it, so the provider and the bootstrap's existing `db` are the *same object*. No dual-instance hazard.
- **The shim covers the constructor's `vscode` surface**: `workspace.getConfiguration` (`vscodeShim.ts:195`, workspace-root-aware), `onDidChangeWorkspaceFolders` (`:193`), `onDidChangeConfiguration` (`:194`), `workspaceFolders` (`:192`), `createOutputChannel` (`:141`).

#### The alternative that was rejected, and why

An earlier version of this feature carried a companion plan to **extract a host-agnostic `FeatureManagementService`** — moving `createFeatureFromPlanIds`, `assignPlansToFeature`, `_removeSubtaskFromFeature`, `_deleteFeature`, `splitFeature` and `reconcileFeatures` out of `KanbanProvider` behind an injected context, leaving thin forwarders. That plan is superseded and deleted. The reasons are concrete, not stylistic:

1. **It was the only work in the feature that could break the ~4,000 shipped installs.** It moved live, mutating code — including operations that abandon worktrees and unlink external trackers — out of the provider the extension depends on, and needed golden fixtures across seven routes as a merge gate. Constructing the provider changes `KanbanProvider.ts` by **zero lines**, so byte-compatibility (PRD contract #2) is satisfied by construction rather than by test.
2. **It did not actually cover the UI verbs.** Two of the three — `promoteToFeature` (`KanbanProvider.ts:10656-10730`) and `addSubtaskToFeature` (`:10623-10655`) — are substantial `_handleMessage` arms, **not** members of the six. `promoteToFeature` alone rewrites the plan's H1, moves the file from `.switchboard/plans/` to `.switchboard/features/<slug>-<planId>.md`, updates `plan_file`, flips `is_feature`, registers watcher suppression on both paths, regenerates, refreshes, and syncs outbound. It is *not* `createFeature` with one plan id, and normalising it to the array signature — as the superseded plan proposed — would have created a new feature with the plan as a subtask instead of promoting it. Routing to `handleServiceVerb` gets both arms verbatim, for free.
3. **It would have produced a third copy of the feature-file regenerator.** `src/standalone/headlessFeatureCallbacks.ts` already reimplements `_regenerateFeatureFile` and `recomputeFeatureColumnFromSubtasks` for the ingestion engine, and its header already cites stale provider line numbers (`:6213`/`:10971`; the real ones are `:6494`/`:11424`) — evidence that mirrored copies drift. Adding a third path was the wrong direction.
4. **It left schema validation inert.** `validateVerbPayload` is called only inside the five providers' `handleServiceVerb` methods; `bootstrap.ts` never imports it. Adding schemas for verbs dispatched by the hand-rolled switch would have satisfied PRD contract #5 on paper and validated nothing. Routing through `handleServiceVerb` makes the schemas actually run.

The extraction remains a defensible long-term refactor for its own sake. It is not the cheapest or safest way to make feature management reachable, which is what this feature is for.

## Metadata
- **Tags:** feature, backend, api, reliability
- **Complexity:** 6
- **Project:** browser-switchboard

## User Review Required
- **None.**

## Scope

### ✅ IN SCOPE
1. Construct `KanbanProvider` in `src/standalone/bootstrap.ts` alongside the other providers, with the shim context, seam bundle, broadcaster, API-server handle, and an explicitly-set workspace root.
2. Attach it via `taskViewerProvider.setKanbanProvider(kanbanProvider)`.
3. Supply all six `LocalApiServerOptions` hooks — `createFeature`, `assignToFeature`, `removeSubtaskFromFeature`, `deleteFeature`, `splitFeature`, `reconcileFeatures` — delegating to the provider, so the seven existing routes answer identically in both hosts.
4. Route `createFeature`, `promoteToFeature`, and `addSubtaskToFeature` in `kanbanVerb` to `kanbanProvider.handleServiceVerb(verb, payload)`, returning the result in-body (PRD contract #4).
5. Payload schemas for those three verbs in `verbSchemas.ts` (PRD contract #5) — now load-bearing, because `handleServiceVerb` validates.
6. Board refresh after each mutation so the browser board reflects the change.
7. Headless tests asserting each operation returns **data** in-body, not a bare ack.

### ⚙️ OUT OF SCOPE
- **Any change to `src/services/KanbanProvider.ts`.** This is a hard constraint, not a preference: it is what makes this plan zero-risk to shipped installs. If the provider must change, that is a separate plan with its own gate.
- **Replacing the hand-rolled `kanbanVerb` switch wholesale.** Only the three feature verbs route to the provider; the existing twenty arms and the `default:` fall-through stay exactly as they are. Blanket-routing every kanban verb to `handleServiceVerb` would expose ~140 arms — including terminal-, autoban- and worktree-coupled ones — that have never run headlessly. That is a much larger change with a different risk profile and belongs to the A2b burndown.
- Changing the `kanban_operations` scripts. They stay HTTP-only; this plan makes the endpoint answer.
- Linear/ClickUp outbound sync behaviour. It is **not** disabled and has never been "never synced": `_syncFeatureOutbound` (`KanbanProvider.ts:12456`) is called by `createFeatureFromPlanIds` (`:12042`), `assignPlansToFeature` (`:12116`) and the `promoteToFeature` arm (`:10728`). It self-gates on `setupComplete && realTimeSyncEnabled` and is best-effort. Standalone inherits that behaviour unchanged — no new work, no suppression.
- Extracting a `FeatureManagementService` (superseded — see above).
- Feature worktree operations, which are gated by git/terminal capability separately.

## Implementation Steps

1. **Construct the provider** in `bootstrap.ts`, immediately after `taskViewerProvider` is built (it must exist first, for the `setKanbanProvider` attach). Follow the established four-step shape: construct with the shim context → poke `_hostSeams` / `_broadcaster` → set the workspace root explicitly → `setApiServer` once `server` exists.
2. **Set `_currentWorkspaceRoot` explicitly.** The shim's `workspaceFolders` is `[]` (`vscodeShim.ts:192`), so the constructor's `_resolvePersistedWorkspace` resolves to empty and `handleServiceVerb` would throw *"Kanban service unavailable — no workspace root resolved"* (`KanbanProvider.ts:7089-7091`). Assign the bootstrap's `workspaceRoot` post-construction, before any verb can arrive.
3. **Smoke-gate the construction** before wiring anything: assert the provider constructs, `_initKanbanService()` succeeds, and a trivially safe allowlisted read verb returns data. Do this first — it is the step that can surprise, and everything downstream assumes it.
4. **Attach to TaskViewer:** `taskViewerProvider.setKanbanProvider(kanbanProvider)`.
5. **Supply the six hooks** on the `LocalApiServer` options object, each mirroring the four-line shape at `TaskViewerProvider.ts:1672-1682`: try/catch, return `{success:false, error}` on throw so an HTTP caller sees the failure rather than a false success (PRD contract #4).
6. **Add the three verb arms** before the `default:` at `bootstrap.ts:836`, each delegating to `handleServiceVerb`, refreshing the board, and returning its result in-body.
7. **Add the three schemas** to `verbSchemas.ts` — permissive and field-accurate.
8. **Verify the capability flips.** With all six hooks supplied, `hasFeatureManagement()` returns `true`, so the companion gating plan enables the browser controls with no further change.
9. Add the tests below.

## Proposed Changes

### `src/standalone/bootstrap.ts` — construct the provider

- **Context.** `headlessContext`, `headlessSeams`, `headlessBroadcaster` and `panelStateStore` are already built (`:486-499`); `taskViewerProvider` at `:519`. `server` is constructed later, around `:980`.
- **Logic.** One construction, one attach, mirroring the four existing providers.
- **Implementation.**
  ```ts
  // Kanban: the last provider the bootstrap hand-rolled around. Constructed the
  // same way as Design/Setup/TaskViewer/Planning — shim context, seams and
  // broadcaster injected post-construction to pre-empt _initKanbanService's
  // empty-root bail. Only the three feature verbs are routed to it (see
  // kanbanVerb below); the existing hand-rolled arms are unchanged.
  const kanbanProvider = new KanbanProvider(
      { fsPath: repoRoot } as any,
      headlessContext,
      undefined,
      undefined
  );
  (kanbanProvider as any)._hostSeams = headlessSeams;
  (kanbanProvider as any)._broadcaster = headlessBroadcaster;
  // The shim's workspaceFolders is [], so the constructor could not resolve a
  // root; handleServiceVerb throws without one.
  (kanbanProvider as any)._currentWorkspaceRoot = workspaceRoot;
  taskViewerProvider.setKanbanProvider(kanbanProvider);
  ```
  and once the server exists: `kanbanProvider.setApiServer(server);`
- **Edge cases.**
  - **Constructor side effects are real but benign.** It calls `KanbanDatabase.setActiveWorkspaceRoot(...)` (only when a root resolved — here it has not yet, so this is a no-op at construction) and fires `_reconcileStaleWorktreeMode(...)` as an unawaited promise. In standalone that runs against the shared DB with no worktree manager attached; assert in test that it neither throws unhandled nor mutates worktree rows. If it proves noisy, the fix is to set the root *after* construction (as above) so the constructor's guarded block does not run at all — which the shape above already achieves.
  - The constructor pushes two disposables onto `_context.subscriptions`; `headlessContext.subscriptions` is a plain array, so this is inert.
  - Pass `undefined` for `outputChannel` and `globalPlanWatcher` — standalone uses `PlanIngestionEngine` directly, and the provider's watcher calls are all optional-chained (`this._globalPlanWatcher?.…`).

### `src/standalone/bootstrap.ts` — supply the six hooks

- **Context.** The options object at `:980` supplies `kanbanVerb`, `planningVerb`, `designVerb`, `setupVerb`, `taskViewerVerb` and no feature hooks.
- **Logic.** Six four-line delegates, identical in shape to `TaskViewerProvider.ts:1672-1740`.
- **Implementation.**
  ```ts
  createFeature: async (wsRoot, name, planIds, description) => {
      try {
          return await kanbanProvider.createFeatureFromPlanIds(wsRoot, name, planIds, description);
      } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
  },
  ```
  …and the same for `assignToFeature` → `assignPlansToFeature`, `removeSubtaskFromFeature` → `_removeSubtaskFromFeature`, `deleteFeature` → `_deleteFeature`, `splitFeature` → `splitFeature`, `reconcileFeatures` → `reconcileFeatures`.
- **Edge cases.** `assignToFeature`'s failure shape must include `assigned: []` and `skipped: []` to match the extension's (`TaskViewerProvider.ts:1687`); a caller that destructures `assigned` would otherwise crash on the error path only in standalone.

### `src/standalone/bootstrap.ts` — the three verb arms

- **Logic.** Delegate to the provider's real dispatcher, refresh, return in-body.
- **Implementation.**
  ```ts
  case 'createFeature':
  case 'promoteToFeature':
  case 'addSubtaskToFeature': {
      const result = await kanbanProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: root });
      await pushFullState();
      return result;   // in-body, not a bare ack
  }
  ```
- **Edge cases.**
  - `handleServiceVerb` **throws** on an unknown verb or a schema failure rather than returning `{success:false}`. The surrounding `try/catch` at `bootstrap.ts:839-842` already converts a throw into `{success:false, error}`, so the HTTP contract holds — confirm this rather than adding a second catch.
  - **`promoteToFeature` is not `createFeature` with one id.** It promotes an existing plan in place, moving its file into `.switchboard/features/`. Do not normalise it to the array signature; route it as its own verb.
  - `addSubtaskToFeature` is posted **once per selected subtask** by the UI (`kanban.html:11965-11971`), so the arm must be safe to call repeatedly in quick succession. Each call already triggers the provider's own `_refreshBoard`; consider debouncing the extra `pushFullState()` on bursts, but never drop it.
  - The provider's arms call `this._seams().ui.showWarningMessage(...)` on validation failures. Under `createVscodeHostSeams` these are rejecting/no-op dialogs — the arm still **returns** `{success:false, error}`, which is what the browser now renders via the companion transport plan.

### `src/services/verbSchemas.ts`

- **Context.** Per-verb payload validation at the HTTP boundary. Consulted by `handleServiceVerb` (`KanbanProvider.ts:7098`) — so with this plan's routing, the three new schemas actually execute in standalone.
- **Logic.** Add schemas for the three verbs.
- **Edge cases.** Require only what the arms dereference: `createFeature` needs `name` and `subtaskPlanIds`; `description` and `workspaceRoot` are optional. `promoteToFeature` needs `planId` and `name`. `addSubtaskToFeature` needs `featureSessionId` and `subtaskSessionId`. **An over-strict schema rejects valid payloads from shipped webview builds** — a regression on ~4,000 installs, since these verbs also arrive from the extension's webview through this same validated path. Serialise edits to this shared file per the PRD's orchestration discipline.

### Board refresh

- **Context.** All operations mutate DB and filesystem; the browser board only updates on push. The provider's own `_refreshBoard` routes through the injected `headlessBroadcaster`, which reaches the WS hub once `setApiServer` has run.
- **Edge cases.** A correct DB with a stale board reads to the user as "it didn't work" — the same complaint class that surfaced this whole gap. Verify the broadcaster path end-to-end rather than assuming the provider's internal refresh suffices; if `setApiServer` is missed, every mutation succeeds silently and the board never moves.

## Complexity Audit

### Routine
- Six hooks, each four lines and already written once in `TaskViewerProvider`.
- Three `case` arms delegating to an existing dispatcher.
- Three permissive schemas.

### Complex / Risky
- **Provider construction under the shim is the one genuinely new thing.** Four providers prove the pattern, but `KanbanProvider` is the heaviest of them and the only one whose constructor kicks off async work. Step 3's smoke gate exists so this is discovered in five minutes rather than during feature-creation debugging.
- **The empty workspace root is the silent killer.** Miss step 2 and every routed verb throws *"Kanban service unavailable"* — which, thanks to the companion transport plan, at least now says so out loud.
- **Two feature-file writers now live in one process.** `KanbanProvider._regenerateFeatureFile` (used by the feature ops) and `createHeadlessFeatureFileRegenerator` (`headlessFeatureCallbacks.ts`, wired into the ingestion engine at `bootstrap.ts:269-270`) both rewrite the same auto-generated blocks. Both carry a no-op-skip guard (`newContent === existingContent`), so they converge rather than fight — but the provider's version consults custom kanban columns while the headless one hardcodes `DEFAULT_KANBAN_COLUMNS`. Test 8 pins that they produce identical output for a standalone feature.
- **Schema over-strictness is a shipped-install regression**, not just a headless bug.
- **`reconcileFeatures` is the one external agent hosts drive.** It is also the largest. Verify its full create/assign/remove convergence headlessly, not just a smoke call.

## Edge-Case & Dependency Audit

- **Race conditions:** feature creation writes into `.switchboard/features/` while the standalone plan watcher is running. The provider's `_regenerateFeatureFile` and `promoteToFeature` arm already register suppression (`GlobalPlanWatcherService.registerPendingCreation`, which delegates to `PlanIngestionEngine.registerPendingCreation` — `GlobalPlanWatcherService.ts:72-73`), and standalone's ingestion engine is the same `PlanIngestionEngine`. Verify the suppression actually lands (test 7) rather than assuming the delegation holds headlessly.
- **Security:** the seven routes are already `_checkAuth`-gated (`LocalApiServer.ts:1262`) — unchanged. The three verbs arrive over the HTTP verb rail and are now schema-validated at dispatch, closing a real contract-#5 gap: the hand-rolled `kanbanVerb` switch validates nothing today, because `bootstrap.ts` never imports `validateVerbPayload`.
- **Side effects:** DB writes, feature-file writes, worktree abandonment (`_deleteFeature` → `_cleanupFeatureWorktrees`; `_removeSubtaskFromFeature` → `_removeWorktreeRow` + `_pruneWorktrees`), and best-effort tracker unlink (`linearSvc.unlinkSubtasksFromFeature` / `clickupSvc.unlinkSubtasksFromFeature`). All of these now run in standalone *identically to the extension*, because the code is the same code. This is a strict improvement over the superseded extraction plan, whose central risk was one of these side effects being dropped in the move.
- **Migration / shipped state:** no persisted state changes. `KanbanProvider.ts` is untouched, so the extension path is byte-identical by construction. The standalone path goes from 503/silent to working, which is purely additive.
- **Dependencies & conflicts:** touches `bootstrap.ts` (also edited by the capability-gating plan) and `verbSchemas.ts` (shared across all provider work) — serialise both. Does **not** touch `KanbanProvider.ts`, so it does not contend with the *Cross-Client Project Scope Independence* feature at all — a second concrete gain over the superseded extraction plan, which did.
- **Capability honesty:** once all six hooks are supplied, `hasFeatureManagement()` returns `true` and the companion gating plan enables the controls automatically. Supplying only some hooks must leave the flag `false` — the derivation is all-six by design.
- **No confirmation dialogs** are added — including for `deleteFeature`, which deletes immediately (project rule).

## Dependencies

- **None hard.** This plan no longer depends on an extraction landing first; it is self-contained.
- Pairs with `capability-gate-feature-management.md`: that plan makes the control honest while unwired, this plan flips it on. Either order works, but shipping the gate first means the button is never enabled-and-inert. Both edit `bootstrap.ts` — serialise.
- Best sequenced after `browser-surface-verb-failures.md` so that any failure during bring-up is visible rather than silent.

## Verification Plan

### Automated Tests
1. **Construction smoke.** The standalone bootstrap constructs `KanbanProvider`, `_initKanbanService()` resolves, and an allowlisted read verb returns data. No unhandled rejection from the constructor's `_reconcileStaleWorktreeMode`.
2. **Headless create returns data in-body.** Against a standalone harness, `POST /kanban/feature` returns `200` with `featurePlanId` — not `503`, and not a bare `{success:true}`.
3. **All seven routes, both hosts, equivalent results.** Table-driven: identical inputs produce equivalent responses from the extension-wired and standalone-wired `LocalApiServer`. This is the anti-divergence guard, and it is now a genuine equivalence rather than an approximation, because both hosts execute the same provider code.
4. **The three UI verbs reach the provider.** `createFeature`, `promoteToFeature`, `addSubtaskToFeature` posted to `/kanban/verb/<verb>` each succeed and return their result in-body — no `default:` fall-through.
5. **`promoteToFeature` promotes, it does not create.** A single-plan promotion moves the plan file into `.switchboard/features/<slug>-<planId>.md`, sets `is_feature=1` on **that same** `plan_id`, and creates no second row. This is the regression guard for the superseded plan's normalise-to-createFeature proposal.
6. **Schema enforcement is live.** A payload missing a dereferenced required field is rejected at dispatch with a clear error (proving `handleServiceVerb`'s validation runs in standalone); a payload captured from the real webview validates; a payload missing an optional field validates.
7. **Watcher exclusion.** A feature file written by the standalone host is not re-imported as a plain plan.
8. **One feature file, two writers, one result.** After a standalone feature mutation, the file produced by the provider's `_regenerateFeatureFile` is byte-identical to what `createHeadlessFeatureFileRegenerator` would produce for the same DB state.
9. **Blank-feature contract preserved.** Zero resolvable plan IDs still returns success and creates a blank feature (`KanbanProvider.ts:11865`) — the behaviour `create-feature-from-plans` documents and depends on.
10. **Side effects present headlessly.** A standalone `deleteFeature` abandons child worktree rows and attempts the tracker unlink; `removeSubtaskFromFeature` abandons the subtask worktree row and regenerates the feature file.
11. **Board refresh.** Each mutation is followed by a state push over the WS hub; the browser board reflects the change without a manual refresh.
12. **Capability flips.** With all six hooks supplied `hasFeatureManagement()` is `true`; removing any one returns it to `false`.
13. **`reconcileFeatures` convergence headlessly** — one call that creates a feature, assigns an existing plan by path, and removes an unmentioned one.
14. **The other twenty verbs are unchanged.** The existing hand-rolled arms still take their original path; only the three feature verbs route to the provider.

### Manual
- Run `npx switchboard`, select two plans on the browser board, press **GROUP INTO FEATURE**, name it, submit — the feature appears on the board and the file exists under `.switchboard/features/`.
- Select one plan, press **PROMOTE TO FEATURE**, name it — the plan's own file moves to `.switchboard/features/` and the card becomes a feature.
- Select a feature plus two plans, press **ADD 2 TO FEATURE** — both attach, the feature file's subtask block regenerates, and the board updates without a manual refresh.
- With the extension stopped, run `node .agents/skills/kanban_operations/create-feature.js …` against the standalone port — it succeeds instead of returning 503.
- Exercise delete and split from the browser and confirm cleanup matches the editor's behaviour.

## Code Investigation Before Implementation

Every claim in this plan is grounded in the current source and was verified by reading it. Three items are **read-verified but not run-verified** — they depend on runtime behaviour of the standalone host, which no amount of further reading settles. They are internal codebase questions, not external/library questions: resolve them by executing step 3's smoke gate first, before writing any of the wiring.

- **Constructor and `_initKanbanService()` complete cleanly under `vscodeShim`.** The shim covers every `vscode.*` surface the constructor touches (verified: `getConfiguration` `:195`, `onDidChangeWorkspaceFolders` `:193`, `onDidChangeConfiguration` `:194`, `workspaceFolders` `:192`, `createOutputChannel` `:141`), and four providers already construct this way — but kanban is the heaviest and the only one firing async work from its constructor.
- **`_reconcileStaleWorktreeMode` is harmless with no worktree manager attached.** The construction shape in this plan sets the workspace root *after* construction specifically so the constructor's guarded block does not run; confirm that holds and that no unhandled rejection escapes.
- **Direct field assignment of `_hostSeams` / `_broadcaster` / `_currentWorkspaceRoot` is sufficient for `KanbanProvider` specifically.** It is the documented pattern for the other four (`bootstrap.ts:440-451`), but each provider has a different `_initXService`; check `_initKanbanService` (`KanbanProvider.ts:6958-6987`) actually accepts the pre-assigned values rather than overwriting them.

No web research is required — nothing here is external to this repository.

---

**Recommendation:** Complexity 6 → **Send to Coder.**

**Stage Complete:** CREATED
