---
description: "Close the headless gap: construct FeatureManagementService in the standalone bootstrap, supply all six LocalApiServerOptions hooks so the seven existing feature routes answer instead of 503, and add the three UI verbs (createFeature, promoteToFeature, addSubtaskToFeature) to standalone's kanbanVerb switch so the browser board's PROMOTE TO FEATURE button works. Flips the featureManagement capability to true in both hosts. Depends on the extraction plan."
---

# Wire Feature Management into the Standalone Host

## Goal

**Definition of done: every feature-management operation works over `npx switchboard` — from both the browser board UI and the `kanban_operations` scripts — through the same code path the extension uses, with results returned in-body.**

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

The script surfaces that 503 clearly and deliberately refuses a raw-DB fallback (orphan risk, per its header comment). Same for the five sibling hooks and their six other routes — none is supplied by `bootstrap.ts`.

**The UI path fails silently.** The browser board's **PROMOTE TO FEATURE** button (`kanban.html:2751`) posts `createFeature`, `promoteToFeature`, or `addSubtaskToFeature`. Standalone's `kanbanVerb` (`bootstrap.ts:578-841`) implements twenty verbs — `addProject, chatCopyPrompt, completePlan, completeSelected, createPlan, deleteProject, getSetting, importFromClipboard, improvePlan, moveAll, moveSelected, promptAll, promptSelected, ready, refresh, reviewPlan, saveSetting, scanFoldersNow, selectWorkspace, setProjectFilter` — and none of the three is among them, so all three hit:

```ts
default:
    return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
```

This is Layer 2 of the PRD's two-layer completion model: *"the standalone bootstrap constructs the provider and wires its verb router into `LocalApiServer`. Neither layer alone makes a verb usable over `npx`."* The companion extraction plan delivers Layer 1; this plan delivers Layer 2. Until both land, feature management is "migrated-but-unreachable" — a state the PRD names explicitly as incomplete.

## Metadata
- **Tags:** feature, backend, api, reliability
- **Complexity:** 5
- **Project:** browser-switchboard

## User Review Required
- **None.**

## Scope

### ✅ IN SCOPE
1. Construct `FeatureManagementService` in `src/standalone/bootstrap.ts` alongside the other standalone services.
2. Supply all six `LocalApiServerOptions` hooks — `createFeature`, `assignToFeature`, `removeSubtaskFromFeature`, `deleteFeature`, `splitFeature`, `reconcileFeatures` — so the seven existing routes answer identically in both hosts.
3. Add `createFeature`, `promoteToFeature`, and `addSubtaskToFeature` to standalone's `kanbanVerb` switch, returning results in-body (PRD contract #4).
4. Payload schemas for those three verbs in `verbSchemas.ts` (PRD contract #5).
5. Board refresh after each mutation so the browser board reflects the change.
6. Headless tests asserting each operation returns **data** in-body, not a bare ack.

### ⚙️ OUT OF SCOPE
- Any change to the six operations' logic. They arrive intact from the extraction plan; this plan only constructs and wires.
- Changing the `kanban_operations` scripts. They stay HTTP-only; this plan makes the endpoint answer.
- Linear/ClickUp sync on feature creation (has never synced; preserved).
- Constructing `KanbanProvider` standalone. Still out — the service is what makes that unnecessary.
- Feature worktree operations, which are gated by git/terminal capability separately.

## Implementation Steps

1. **Construct the service** in `bootstrap.ts`, supplying the `FeatureManagementContext` from the standalone equivalents already present there: the DB accessor, the workspace root, the broadcaster, and the standalone seam bundle. Where a context member has no standalone equivalent (worktree abandonment, tracker unlink), supply an explicit no-op **and log it** — a silent no-op here reproduces the orphaned-worktree failure the extraction plan guards against.
2. **Supply the six hooks** on the `LocalApiServer` options object, each mirroring the four-line shape at `TaskViewerProvider.ts:1672-1682`: try/catch, return `{success:false, error}` on throw so an HTTP caller sees the failure rather than a false success (PRD contract #4).
3. **Add the three verb arms** before the `default:` at `bootstrap.ts:836`, each delegating to the service, refreshing the board, and returning its result in-body.
4. **Add the three schemas** to `verbSchemas.ts` — permissive and field-accurate.
5. **Verify the capability flips.** With all six hooks supplied, `hasFeatureManagement()` returns `true`, so the companion gating plan enables the browser controls with no further change.
6. Add the tests below.

## Proposed Changes

### `src/standalone/bootstrap.ts` — construct and supply

- **Context.** Supplies `kanbanVerb` (`:578`, `:980`) and none of the six feature hooks. Writes the port file at `:1016`.
- **Logic.** One service construction, six hooks, three verb arms.
- **Implementation.** Hook shape:
  ```ts
  createFeature: async (wsRoot, name, planIds, description) => {
      try {
          return await featureService.createFeature(wsRoot, name, planIds, description);
      } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
  },
  ```
  Verb arm shape:
  ```ts
  case 'createFeature': {
      const result = await featureService.createFeature(
          root, payload.name, payload.subtaskPlanIds || [], payload.description);
      await pushFullState();
      return result;   // in-body, not a bare ack
  }
  ```
- **Edge cases.** `promoteToFeature` carries a single `planId` (`kanban.html:12002`), not an array — normalise to the service's array signature rather than adding a second service method. `addSubtaskToFeature` is posted **once per subtask** by the UI (`:11965-11970`), so it must be safe to call repeatedly in quick succession and each call must refresh; alternatively debounce the refresh, but never drop it.

### `src/services/verbSchemas.ts`

- **Context.** Per-verb payload validation at the HTTP boundary — the network turns trusted `postMessage` input into untrusted input.
- **Logic.** Add schemas for the three verbs.
- **Edge cases.** Require only what the arms dereference: `createFeature` needs `name` and `subtaskPlanIds`; `description` and `workspaceRoot` are optional. `promoteToFeature` needs `planId` and `name`. `addSubtaskToFeature` needs `featureSessionId` and `subtaskSessionId`. **An over-strict schema rejects valid payloads from shipped webview builds** — a regression on ~4,000 installs, since these verbs also arrive from the extension's webview. Serialise edits to this shared file per the PRD's orchestration discipline.

### Board refresh

- **Context.** All six operations mutate DB and filesystem; the browser board only updates on push.
- **Logic.** Each standalone verb arm refreshes after mutating.
- **Edge cases.** A correct DB with a stale board reads to the user as "it didn't work" — the same complaint class that surfaced this whole gap. The refresh is part of the fix, not a nicety.

## Complexity Audit

### Routine
- Six hooks, each four lines and already written once in `TaskViewerProvider`.
- Three `case` arms in an existing switch.
- Three permissive schemas.

### Complex / Risky
- **Missing context members are the real risk.** The extraction plan's context includes worktree abandonment and tracker unlink. Standalone has no tracker sync and may have no worktree manager; supplying silent no-ops would let a `deleteFeature` tombstone rows and orphan worktrees with no signal. Every no-op must log, and test 5 asserts the logging.
- **Schema over-strictness is a shipped-install regression**, not just a headless bug — these verbs also arrive from the extension's webview through the same validated path.
- **`reconcileFeatures` is the one external agent hosts drive.** It is also the largest. Verify its full create/assign/remove convergence headlessly, not just a smoke call.
- **Refresh discipline.** `addSubtaskToFeature` fires once per selected subtask; naive per-call full refreshes on a large selection is a push storm against the same board.

## Edge-Case & Dependency Audit

- **Race conditions:** feature creation writes into `.switchboard/features/` while the standalone plan watcher is running. The extension deliberately skips the new feature file on import; the standalone watcher must honour the same exclusion or the feature re-imports as a plain plan.
- **Security:** the seven routes are already `_checkAuth`-gated (`LocalApiServer.ts:1262`) — unchanged. The three new verbs arrive over the HTTP verb rail and therefore **must** be schema-validated at dispatch (PRD contract #5).
- **Side effects:** DB writes, feature-file writes, and — where the context supports them — worktree abandonment and tracker unlink. Where unsupported, logged no-ops.
- **Migration / shipped state:** no persisted state changes. The extension path is untouched; the standalone path goes from 503/silent to working, which is purely additive.
- **Dependencies & conflicts:** touches `verbSchemas.ts`, which is shared across all provider work — serialise. Does **not** touch `KanbanProvider.ts`, so it does not contend with the *Cross-Client Project Scope Independence* feature.
- **Capability honesty:** once all six hooks are supplied, `hasFeatureManagement()` returns `true` and the companion gating plan enables the controls automatically. Supplying only some hooks must leave the flag `false` — the derivation is all-six by design.
- **No confirmation dialogs** are added — including for `deleteFeature`, which deletes immediately (project rule).

## Dependencies

- **`extract-feature-management-service.md` must merge first.** This plan constructs and wires the service that plan creates; there is nothing to wire before it lands.
- Pairs with `capability-gate-feature-management.md`: that plan makes the control honest while unwired, this plan flips it on. Either order works, but shipping the gate first means the button is never enabled-and-inert.

## Verification Plan

### Automated Tests
1. **Headless create returns data in-body.** Against a standalone harness, `POST /kanban/feature` returns `200` with `featurePlanId` — not `503`, and not a bare `{success:true}`.
2. **All seven routes, both hosts, equivalent results.** Table-driven: identical inputs produce equivalent responses from the extension-wired and standalone-wired `LocalApiServer`. This is the anti-divergence guard.
3. **The three UI verbs reach the service.** `createFeature`, `promoteToFeature`, `addSubtaskToFeature` posted to `/kanban/verb/<verb>` each succeed and return their result in-body — no `default:` fall-through.
4. **Schema permissiveness.** A payload captured from the real webview validates. A payload missing an optional field validates. A payload missing a dereferenced required field is rejected with a clear error.
5. **Unsupported context members log.** A standalone `deleteFeature` whose worktree/tracker members are no-ops emits a log line naming what was skipped.
6. **Board refresh.** Each mutation is followed by a state push; the browser board reflects the change without a manual refresh.
7. **Watcher exclusion.** A feature file written by the standalone host is not re-imported as a plain plan.
8. **Capability flips.** With all six hooks supplied `hasFeatureManagement()` is `true`; removing any one returns it to `false`.
9. **`reconcileFeatures` convergence headlessly** — one call that creates a feature, assigns an existing plan by path, and removes an unmentioned one.

### Manual
- Run `npx switchboard`, select two plans on the browser board, press **GROUP INTO FEATURE**, name it, submit — the feature appears on the board and the file exists under `.switchboard/features/`.
- With the extension stopped, run `node .agents/skills/kanban_operations/create-feature.js …` against the standalone port — it succeeds instead of returning 503.
- Exercise delete and split from the browser and confirm cleanup matches the editor's behaviour, or is logged as skipped where standalone lacks the capability.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

**Stage Complete:** CREATED
