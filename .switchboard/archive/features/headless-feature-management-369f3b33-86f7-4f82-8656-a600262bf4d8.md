# Headless Feature Management

**Complexity:** 6

## Goal

Make feature management work in the standalone (npx switchboard) host, and stop the browser cockpit lying about it in the meantime.

Feature management is extension-only: six LocalApiServerOptions hooks are supplied solely by TaskViewerProvider, and the three UI verbs fall through standalone's kanbanVerb switch. The browser board ships the full feature UI anyway — PROMOTE TO FEATURE renders, enables, opens a modal, accepts a name, and does nothing. The failure is invisible because transport.js discards every {success:false} response without surfacing it.

This is a live violation of PRD contract #6 (capability-gating honesty) and contract #7 (two-layer completion, migrated-but-unreachable). The set fixes it in three steps: make failures visible, make the control honest, then give the standalone host the provider it was missing.

### Reconciled design decision (2026-07-28)

The set originally carried a fourth subtask that **extracted** the six feature operations out of `KanbanProvider` into a host-agnostic `FeatureManagementService`, on the premise that the standalone host cannot construct that provider. Auditing the code disproved the premise: `bootstrap.ts` already constructs `DesignPanelProvider` (`:502`), `SetupPanelProvider` (`:513`), `TaskViewerProvider` (`:519`) and `PlanningPanelProvider` (`:553`) under `vscodeShim` + `createVscodeHostSeams`, and routes each one's verbs through its real `handleServiceVerb`. **Kanban is the only panel the bootstrap hand-rolls** — and that outlier, not any inherent coupling, is the actual root cause.

The extraction plan was therefore deleted and the wiring plan rewritten around constructing the provider. This is what PRD contract #7 literally prescribes for Layer 2 (*"the standalone bootstrap constructs the provider and wires its verb router into `LocalApiServer`"*), and it is strictly better on four counts the extraction could not match:

1. **`KanbanProvider.ts` changes by zero lines**, so byte-compatibility with the ~4,000 shipped installs (contract #2) holds by construction rather than by golden fixture. The feature no longer contains any subtask that can break the extension.
2. **It actually covers the UI verbs.** Two of the three — `promoteToFeature` (`KanbanProvider.ts:10656-10730`) and `addSubtaskToFeature` (`:10623-10655`) — are substantial `_handleMessage` arms, *not* members of the six extracted methods. `promoteToFeature` moves a plan's own file into `.switchboard/features/` and flips `is_feature` on that row; the superseded plan proposed normalising it to `createFeature`'s array signature, which would have created a *new* feature with the plan as a subtask instead of promoting it.
3. **It avoids a third copy of the feature-file regenerator.** `src/standalone/headlessFeatureCallbacks.ts` already mirrors `_regenerateFeatureFile` and `recomputeFeatureColumnFromSubtasks` for the ingestion engine — and already cites stale provider line numbers in its header, evidence that mirrored copies drift.
4. **It makes schema validation real.** `validateVerbPayload` is called only inside the five providers' `handleServiceVerb`; `bootstrap.ts` never imports it. Schemas added for verbs dispatched by the hand-rolled switch would have satisfied contract #5 on paper and validated nothing.

It also removed the feature's only cross-feature file contention (see below).

## How the Subtasks Achieve This

- **Surface Verb Failures in the Browser Transport** (Cx 2): Adds the missing `result.success === false` branch to `transport.js`'s verb response handler. Today a failure is re-dispatched as a typeless `MessageEvent` no UI handler consumes, so the server's honest *"Verb 'X' not implemented in standalone mode"* never reaches a human. Because `showStatusMessage` is handled by `kanban.html` **only**, the plan pairs that dispatch with a transport-owned fallback toast so the other three panels are not silently left out. Scope is deliberately wider than features — this makes **every** failing or unimplemented verb diagnosable in **every** panel, and it is the reason this gap went unnoticed for as long as it did.
- **Capability-Gate Feature Management in the Browser** (Cx 4): Adds a `featureManagement` capability *derived* from whether all six `LocalApiServerOptions` hooks are actually supplied, threads it through `HostCapabilities` and both hosts' assembly sites, and disables `#btn-feature-action` with an explanatory tooltip when false. Restores PRD contract #6 immediately, without waiting for the wiring. The derivation is all-six by design (a flag that overstates what is wired turns a dead button into a lying one) and must be **late-bound** — both capability literals are evaluated before their `LocalApiServer` exists, so a captured read would disable the button in VS Code too.
- **Construct KanbanProvider in the Standalone Host and Wire Feature Management** (Cx 6): Constructs `KanbanProvider` in `bootstrap.ts` the way the other four providers are already constructed, attaches it via the public `taskViewerProvider.setKanbanProvider()`, supplies the six hooks so the seven routes stop returning 503, and routes the three UI verbs to the provider's real `handleServiceVerb` — which brings allowlisting, schema validation, and byte-identical behaviour with it. Completes PRD contract #7's Layer 2 and flips the capability flag to true. Deliberately routes only those three verbs; blanket-routing all ~151 kanban arms is the A2b burndown, not this.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Surface Verb Failures in the Browser Transport](../plans/browser-surface-verb-failures.md) — **CODE REVIEWED** — ID: c71b9857-51bb-4973-a214-5c10c89081dd
- [ ] [Capability-Gate Feature Management in the Browser](../plans/capability-gate-feature-management.md) — **CODE REVIEWED** — ID: c61e2594-6565-4e10-9736-5bf51e29e28c
- [ ] [Construct KanbanProvider in the Standalone Host and Wire Feature Management](../plans/wire-feature-management-standalone.md) — **CODE REVIEWED** — ID: caa7ba7c-85a1-46d6-8686-4181b5906578
<!-- END SUBTASKS -->

## Dependencies & sequencing

**No hard dependencies remain.** Removing the extraction subtask removed the set's only blocking edge — every subtask is now independently shippable, and the ordering below is preference, not constraint.

| # | Subtask | Constraint |
|---|---|---|
| 1 | Surface Verb Failures | None — fully independent. |
| 2 | Capability-Gate | None. Best after #1 so anything slipping the gate reports itself. |
| 3 | Construct KanbanProvider + Wire | None. Previously blocked on the extraction; now self-contained. |

**Ship #1 first.** It is a few lines, independently shippable, and converts this entire class of failure from silent to diagnosable — including any residual gap the later subtasks leave behind. Bringing up #3 before it means debugging the provider construction blind, which is exactly the step most likely to surprise.

**#2 before #3 is preferred**, so the button is never enabled-and-inert: #2 disables it honestly while unwired, #3 flips the capability and enables it. Reversing them leaves a window where the control works only for operations that happen to be wired. Note the window is now short — #3 no longer waits on an extraction — so this is a small win, not a gating concern.

### Shared-file serialisation (within this feature)

Two files are touched by more than one subtask. Neither is a logical conflict; both are merge contention and must be serialised:

| File | Subtasks | Contended surface |
|---|---|---|
| `src/webview/transport.js` | #1, #2 | #1 edits the verb response handler (`:176-192`); #2 edits `applyCapabilityGating` (`:225-335`). Different functions. |
| `src/standalone/bootstrap.ts` | #2, #3 | #2 edits `getStandaloneCaps` (`:388-409`); #3 adds the provider construction, the six hooks, and three verb arms. Different regions — but #2 needs a `server` binding that #3's work sits near, so land #2's one-line change first or rebase it onto #3. |

`src/webview/kanban.html` is touched by #2 only. `src/services/verbSchemas.ts` is touched by #3 only, but it is shared across **all** provider work repo-wide — serialise concurrent edits there per the PRD's orchestration discipline.

### Cross-feature dependencies

**None.** This is a direct consequence of the restructure. The deleted extraction subtask edited `src/services/KanbanProvider.ts`, which the **Cross-Client Project Scope Independence** feature also edits, forcing the two features to serialise under the PRD's one-stream-per-provider-file rule. The replacement subtask does not touch `KanbanProvider.ts` at all, so **this feature and Cross-Client Project Scope Independence can now run fully concurrently.**

Nothing from any other feature must land first.

### Where the risk actually is

**No subtask in this set can break the ~4,000 shipped installs.** #1 and #2 are browser-only (`transport.js` is not loaded inside the VS Code webview) plus one additive capability field; #3 changes only `bootstrap.ts`, `verbSchemas.ts`, and adds tests. That is the single biggest gain from the restructure — the previous set's #3 was explicitly "the one that can break shipped installs" and needed golden fixtures across seven routes as a merge gate.

The residual risk moved rather than vanished, and it is now concentrated in one place: **constructing `KanbanProvider` under the shim**. Four providers prove the pattern, but kanban is the heaviest and the only one whose constructor fires async work (`_reconcileStaleWorktreeMode`). The plan's step-1 smoke gate exists to surface that in minutes. The other trap is the workspace root: the shim's `workspaceFolders` is `[]`, so the root must be assigned post-construction or every routed verb throws *"Kanban service unavailable"*.

Two shared-input risks carry across the set and are pinned by tests in their owning plans: an over-strict verb schema is a shipped-install regression (these verbs also arrive from the extension's webview through the same validated path), and a `featureManagement` flag read too early disables the button in VS Code as well as standalone.

## Completion Summary
Implemented all subtasks for headless feature management. Surfaced verb failure messages in `src/webview/transport.js` via `showStatusMessage` or fallback toast. Capability-gated feature management controls via a derived, late-bound `featureManagement` flag across `HostCapabilities`, `LocalApiServer`, `TaskViewerProvider`, `bootstrap.ts`, `transport.js`, and `kanban.html`. Constructed `KanbanProvider` in `bootstrap.ts`, supplied all six `LocalApiServerOptions` feature hooks, routed `createFeature`/`promoteToFeature`/`addSubtaskToFeature` UI verbs to `kanbanProvider.handleServiceVerb`, and added schemas in `verbSchemas.ts`. Files modified: `src/webview/transport.js`, `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/webview/kanban.html`, `src/services/verbSchemas.ts`. No issues encountered.

## Code Review Completion (2026-07-29)
Reviewed all three subtasks in-place (Grumpy → Balanced → fix → verify). The implementation was faithful on every trap the plans named (strict-equality failure keying, late-bound all-six capability derivation, re-enable guard placement, zero changes to `KanbanProvider.ts`), but shipped with **no tests at all** — the set-wide MAJOR. Fixed in review: loosened two over-strict kanban verb schemas (`createFeature.subtaskPlanIds`, `promoteToFeature.name`) that would have rejected payloads the arms handle (PRD contract #5), and added `src/test/headless-feature-management-contract.test.js` (33 tests: capability derivation, fail-closed serialisation, schema liveness/field-accuracy, standalone `KanbanProvider` construction smoke under the vscodeShim, in-body `createFeature`, promote-not-create semantics, transport/gating source contracts), wired as `test:contract:headless-feature-mgmt` in `package.json` and `.github/workflows/integration-tests.yml`. Verification: tsc clean, lint 0 errors, 33/33 new tests green, parity/push-routing/verb-returns/catalog gates green; one pre-existing unrelated red (`verb-engine-kanban` `getDbPath`, dates to 00d6a94). Residual: destructive/convergence paths (delete, split, reconcile, watcher exclusion) remain manual-verify.

