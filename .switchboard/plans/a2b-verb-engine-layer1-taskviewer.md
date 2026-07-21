---
description: "Layer-1 completion for TaskViewerProvider ONLY (split from the former 3-provider plan). Convert its read arms to return-in-body, add per-verb input schemas (taskViewer: {} is empty), and add a headless TaskViewer arm test. Sibling: a2b-verb-engine-layer1-completion-return-schemas-tests.md (Setup), a2b-verb-engine-layer1-design.md."
---

# Verb Engine — Layer-1: TaskViewerProvider — Return-in-Body + Schemas + Tests

> **Split note:** the TaskViewer slice of the former 3-provider Layer-1 plan, broken out per-provider. Design → `a2b-verb-engine-layer1-design.md`; Setup → `a2b-verb-engine-layer1-completion-return-schemas-tests.md`.

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, refactor, api, security
- **Complexity:** 6
- **Release phase:** B1 headless prerequisite (Layer 1, TaskViewer provider). Parallel with the Design/Setup/Planning Layer-1 cards (different files). Gated by the return-contract ratchet.

## Goal

Make every `TaskViewerProvider` read/query arm **return its result in the HTTP body** (push kept additive), **schema-validate** untrusted HTTP input, and prove it under a **headless arm test** with no `vscode` reachable.

### Problem / root-cause analysis
TaskViewer's arm-level seam swaps are done and dispatch is allowlist-gated ([TaskViewerProvider.ts:285](../../src/services/TaskViewerProvider.ts#L285)) — a `TODO(verb-engine·5)` at [:299](../../src/services/TaskViewerProvider.ts#L299) documents the gap outright — but:
- **Reads don't return.** Measured `return=0 / break=146` across 110 arms (`analyze-verb-migration2.js`) — none migrated to the return contract; HTTP callers get `{success:true}` with no data.
- **No schemas.** `verbSchemas.ts` has `taskViewer: {}` ([verbSchemas.ts:461](../../src/services/verbSchemas.ts#L461)) → validation is a no-op, while dispatch/plan-create/import arms take untrusted HTTP input over `/taskViewer/verb/*`.
- **No headless test.** Nothing proves TaskViewer arms run seam-only.

Note: the four memo verbs (`memoLoad`/`memoSave`/`memoClear`/`memoGeneratePrompt`) live here and are reached by the Project panel via `PlanningPanelProvider` delegation — their return shapes are already exercised by the shipped Memo feature; keep them intact when converting.

## User Review Required
- None.

## Scope
### ✅ IN SCOPE
- **Return-in-body conversion** of every TaskViewer read/query arm (`get*`/`fetch*`/`getRecentActivity`/`getRecoverablePlans`/`getVisibleAgents`/`getStartupCommands`/…): keep the push, replace trailing `break;` with `return { success: true, …<pushed fields> };`; failure = `return { success:false, error }`. Command/dispatch arms may keep the ack but must `return`.
- **Per-verb schemas** under `taskViewer: { … }`, prioritising: dispatch (`triggerAgentAction`, `sendToTerminal`, `dispatchProjectManager`), plan lifecycle (`createDraftPlanTicket`, `deletePlan`, `completePlan`, `restorePlan`, `importPlans`), DB/setting writes (`setCustomDbPath`, `editDbPath`, `saveStartupCommands`). Permissive/field-accurate.
- **Headless TaskViewer suite** in the harness: representative read+write arms through `handleServiceVerb` under the seam bundle; assert in-body data + push + no `vscode`.

### ⚙️ OUT OF SCOPE
- Standalone bootstrap construction/wiring → B1 bootstrap plan.
- Design / Setup / Planning arms → their own cards.
- Terminal-bound dispatch actually spawning terminals headless (VS Code-only; capability-gated) — no behaviour change.
- New verbs / behaviour changes.

## Implementation Steps
1. **One agent stream, `TaskViewerProvider.ts` only** (`verbSchemas.ts` shared — append the `taskViewer` block, serialise if others in flight).
2. Baseline with `analyze-verb-migration2.js`; batch ~20–30 arms.
3. Per read arm: `break;`→`return { success: true, …pushed };` (Kanban idiom); leave the memo arms' shapes intact.
4. Add the `taskViewer` schema block as arms migrate.
5. Add the headless TaskViewer suite; assert in-body data.
6. **Lower the `taskViewer` ratchet ceiling to its true residual `break` count** (whatever `analyze-verb-migration2.js` reports post-conversion — 0 only if TaskViewer has no legitimate nested-control-flow breaks; `break` inside inner switches / loops within an arm MUST stay, converting it to `return` is a control-flow bug) in the same change; update `## Review Findings` in `a2b-verb-engine-05-taskviewer-provider.md`.

## Complexity Audit
### Routine
- Mechanical `break→return`; simple schemas.
### Complex / Risky
- **Dispatch cluster** — `triggerAgentAction`, terminal sends, `/clear` pacing, pending-dispatch / recoverable-plan routing: return the dispatch result **without altering the state transitions the sidebar activity dots depend on**. Provider tests must pass unchanged.
- **Memo arms** — must keep their existing return/push shapes (the Project panel + standalone `planningVerb` both depend on them).

## Dependencies
- A2b ·1 Foundations — present. Return-contract ratchet — land first/with.

## Verification Plan (Definition of Done — objective)
- `analyze-verb-migration2.js`: TaskViewer read arms flipped to `return`; **`taskViewer` ceiling lowered to its residual `break` count** (not necessarily 0 — nested-control-flow breaks stay), `verb-returns:check` green.
- `verbSchemas.ts` `taskViewer` block non-empty covering the listed writes.
- New headless TaskViewer suite passes and **asserts payload fields, not just `success`**.
- `parity:check` / `push-routing:check` / `compile-tests` green.
- Manual: `POST /taskViewer/verb/<readVerb>` returns data in-body matching the push; the sidebar dots/dispatch behaviour is unchanged in the extension.

## Completion Report
Converted all `TaskViewerProvider` arms inside `_messageListener` to return contract objects (`{ success: true, ... }` or error objects) in the HTTP body while preserving webview WebSocket pushes. Added comprehensive `TASK_VIEWER_VERB_SCHEMAS` input validation in `src/services/verbSchemas.ts` and registered it in `VERB_SCHEMAS.taskViewer`. Added `TaskViewerProvider` headless seam test cases in `src/test/verb-engine-headless-seams.test.js` and updated the ratchet ceiling for `TaskViewer` to `0` in `scripts/verb-return-contract-baseline.json`. Files modified: `src/services/TaskViewerProvider.ts`, `src/services/verbSchemas.ts`, `src/test/verb-engine-headless-seams.test.js`, and `scripts/verb-return-contract-baseline.json`. No issues encountered during implementation.

