---
description: "Planning Layer-1, sub-card 1 of 3 (SEQUENTIAL, same file): the Plans & Features verb family. Convert its read arms to return-in-body and add per-verb schemas. Must land before P2 (docs) and P3 (tickets): a2b-verb-engine-layer1-planning-p2-docs.md, a2b-verb-engine-layer1-planning-p3-tickets.md. Establishes the headless Planning test suite the later two extend."
---

# Verb Engine — Layer-1: PlanningProvider · P1 — Plans & Features (Return-in-Body + Schemas + Test)

> **Split note:** `PlanningPanelProvider` (~169 verbs) is broken into 3 sequential family sub-cards because they all edit the same file — parallel cards would collide (the documented burndown hazard). Order is **hard**: P1 → P2 (`a2b-verb-engine-layer1-planning-p2-docs.md`) → P3 (`a2b-verb-engine-layer1-planning-p3-tickets.md`), one agent stream throughout. The `planning` ratchet ceiling lowers in three steps, reaching its residual `break` floor after P3 (0 only if `PlanningPanelProvider` has no legitimate nested-control-flow breaks — inner switches / loop breaks must stay `break`).

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, refactor, api, security
- **Complexity:** 5
- **Release phase:** B1 headless prerequisite (Layer 1, Planning provider — family 1/3). Gated by the return-contract ratchet; reachable over `npx` once the B1 bootstrap `planningVerb` rework lands.

## Goal

Convert the **Plans & Features** verb family in `PlanningPanelProvider` to the A2b return-in-body contract, add per-verb schemas for its untrusted writes, and **create the headless Planning test suite** (P2/P3 extend it). This is the first, foundational slice of the largest, least-migrated provider.

### Problem / root-cause analysis
The Project feature's own 2026-07-17 review found ·6's arm-level seam migration genuinely done, but the return-in-body contract is "the one material deviation." Verified: `handleServiceVerb` runs `_handleMessage` ([PlanningPanelProvider.ts:126](../../src/services/PlanningPanelProvider.ts#L126)); arms push then `break` (indicative ~340 `break` vs ~14 `return` file-wide; precise per-arm count from `analyze-verb-migration2.js`), and `verbSchemas.ts` has `planning: {}` ([verbSchemas.ts:458](../../src/services/verbSchemas.ts#L458)). So once the B1 bootstrap routes standalone `/project/verb/*` into this provider, reads are reachable-but-empty. Kanban (`return=360/break=0`) is the template.

## User Review Required
- None.

## Scope
### ✅ IN SCOPE — the Plans & Features family only
- **Return-in-body conversion** for this family's read arms: `fetchKanbanPlans`, `fetchKanbanPlanLog`, `fetchKanbanPlanPreview`, `getFeatureDetails`, `fetchMoveTargets`, `getProjectContextEnabled`, `getSyncConfig`, `planShown`, and any plan/feature arm that computes a result — keep the push, replace `break;` with `return { success: true, …<pushed fields> };`; failure = `return { success:false, error }`.
- **Per-verb schemas** under `planning: { … }` for this family's untrusted writes: `createPlan`, `importPlans`, `importPlansFromClipboard`, `deleteKanbanPlan`, `moveKanbanPlanColumn`, `setKanbanPlanComplexity`, `convertToSubtask`, `addSubtaskToFeature`, `removeSubtaskFromFeature`, `createFeature`, `deleteFeature`, `refineFeature`, `updateFeatureConfig`, `resolveDuplicate`, and the `createPlans*` flow. Permissive/field-accurate (accept the real webview payloads).
- **Create the headless Planning suite** in the `verb-engine-headless-seams` harness with this family's arms; assert (a) in-body data, (b) push still emitted, (c) no `vscode`.

### ⚙️ OUT OF SCOPE
- Docs/PRD/Constitution/Insights arms → **P2**. Tickets arms → **P3**.
- Standalone bootstrap `planningVerb` rework → B1 bootstrap plan.
- New verbs / behaviour changes — byte-compatible refactor.

## Implementation Steps
1. **One agent stream, `PlanningPanelProvider.ts` only**; append the `planning` schema block in `verbSchemas.ts` (serialise vs the Design/Setup/TaskViewer cards).
2. Baseline with `analyze-verb-migration2.js`; convert this family's read arms (Kanban idiom).
3. Add the `planning` schema entries for this family's writes.
4. Create the headless Planning suite; assert in-body data.
5. **Lower the `planning` ratchet ceiling by this family's converted-arm count** (partial — reaches its residual floor after P3, which may be > 0 if nested-control-flow breaks remain; never force 0); note progress in `a2b-verb-engine-06-planning-panel.md`.

## Complexity Audit
### Routine
- Mechanical `break→return`; plan/feature schemas are mostly ids + enums.
### Complex / Risky
- **Side-effect ordering** on multi-push arms (feature detail + subtask list); assemble the aggregate result.
- **Feature cascade arms** (`convertToSubtask`, `addSubtaskToFeature`) mutate feature membership — return the result without altering the cascade ordering; provider tests unchanged.

## Dependencies
- A2b ·1 Foundations — present. Return-contract ratchet — land first/with.
- **Blocks** P2 and P3 (they extend the suite this card creates; same file → sequential).

## Verification Plan (Definition of Done — objective)
- `analyze-verb-migration2.js`: this family's read arms `return`; **`planning` ratchet ceiling lowered by the converted count** and `verb-returns:check` green at the new ceiling.
- `verbSchemas.ts` `planning` block covers this family's writes.
- Headless Planning suite exists and **asserts payload fields, not just `success`** for this family.
- `parity:check` / `push-routing:check` / `compile-tests` green.
- Manual: `POST /project/verb/fetchKanbanPlans` (and a feature-detail read) return data in-body; a `createPlan`/`createFeature` write round-trips and a malformed payload is rejected.
