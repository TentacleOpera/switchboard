---
description: "Layer-1 completion for SetupPanelProvider ONLY (split out from the former 3-provider plan). Convert its read arms to return-in-body, add per-verb input schemas (setup: {} is empty today), and add a headless Setup arm test. Sibling per-provider plans: a2b-verb-engine-layer1-design.md, a2b-verb-engine-layer1-taskviewer.md."
---

# Verb Engine — Layer-1: SetupPanelProvider — Return-in-Body + Schemas + Tests

> **Split note:** this was the Setup slice of the former `...completion-return-schemas-tests` (Design+Setup+TaskViewer) plan, broken out per-provider so each card is independently completable and has its own objective Definition of Done. Design → `a2b-verb-engine-layer1-design.md`; TaskViewer → `a2b-verb-engine-layer1-taskviewer.md`.

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, refactor, api, security
- **Complexity:** 6
- **Release phase:** B1 headless prerequisite (Layer 1, Setup provider). Parallel with the Design/TaskViewer/Planning Layer-1 cards (different files → no collision). Gated by the return-contract ratchet (`verb-engine-return-contract-ratchet.md`); reachable over `npx` only once the B1 bootstrap wiring lands.

## Goal

Make every `SetupPanelProvider` read/query arm **return its result in the HTTP body** (webview push kept additive), **schema-validate** its untrusted HTTP input, and prove it under a **headless arm test** with no `vscode` reachable. Setup is the highest-risk provider (token/config writes) and today the least migrated.

### Problem / root-cause analysis
Verified via the reviewer passes + current source: Setup's arm-level `vscode.*`→`this._seams()` swaps are done and dispatch is allowlist-gated ([SetupPanelProvider.ts:43](../../src/services/SetupPanelProvider.ts#L43)), but the A2b contract is unmet:
- **Reads don't return.** `handleServiceVerb` runs `_handleMessage`; arms push over the hub then `break`, so HTTP callers get `{success:true}` with no data. Measured `return=2 / break=123` (`scripts/analyze-verb-migration2.js`). Kanban (`return=360/break=0`) is the template.
- **No schemas.** `verbSchemas.ts` has `setup: {}` ([verbSchemas.ts:460](../../src/services/verbSchemas.ts#L460)) → `validateVerbPayload('setup', …)` is a no-op, and Setup takes untrusted HTTP token/config writes over `/setup/verb/*`.
- **No headless test.** Nothing proves Setup arms run seam-only.

## User Review Required
- None — contract, template, and provider partition are fixed.

## Scope
### ✅ IN SCOPE
- **Return-in-body conversion** of every Setup read/query arm (`get*`/`detect*`/`preview*`/`getWorkspaceMappings`/`getStartupCommands`/…): keep the push, replace the trailing `break;` with `return { success: true, …<same pushed fields> };`; failure branches `return { success: false, error }`. Command arms may keep the `{success:true}` ack but must `return`, not `break`, once touched (honest count).
- **Per-verb schemas** under `setup: { … }`, prioritising untrusted writes: `applyClickUpConfig`/`applyLinearConfig`/`applyNotionConfig` and token saves, `saveWorkspaceMappings`/`setCustomDbPath`/`executeControlPlaneMigration`, `updateGitIgnoreConfig`/`setProtocolTarget`/`setRemoteConfig`. Permissive enough to accept the real webview payloads (require only dereferenced fields) — a too-strict schema that rejects a valid token save is a regression on ~4,000 installs.
- **Headless Setup suite** in the `verb-engine-headless-seams` harness: drive representative read+write arms through `handleServiceVerb` under the seam bundle, assert (a) body carries data, (b) push still emitted, (c) no `vscode`.

### ⚙️ OUT OF SCOPE
- Standalone bootstrap construction/wiring → B1 bootstrap plan.
- Design / TaskViewer / Planning arms → their own Layer-1 cards.
- The five gated terminal/editor families staying gated (Remote Control, startup commands, agent-dir cleanup, `runSetup`, `open*`) — no behaviour change; they still `return { success:false, capabilityGated:true }` or their existing shape, just via `return`.
- New verbs / behaviour changes — byte-compatible refactor.

## Implementation Steps
1. **One agent stream, `SetupPanelProvider.ts` only.** `verbSchemas.ts` is shared with the Design/TaskViewer/Planning cards — append the `setup` block, serialise if others are in flight.
2. Baseline with `analyze-verb-migration2.js`; batch ~20–30 arms.
3. Per read arm: `break;`→`return { success: true, …pushed };` (Kanban idiom).
4. Add the `setup` schema block as arms migrate.
5. Add the headless Setup suite; assert in-body data.
6. **Lower this provider's ratchet ceiling to 0 in the same change** and update `## Review Findings` in `a2b-verb-engine-03-setup-panel.md`.

## Complexity Audit
### Routine
- Mechanical `break→return`; simple toggle/string/id schemas.
### Complex / Risky
- **Schema strictness on token/config writes** — reject-valid-input bricks a token; keep minimal + field-accurate; manual Linear/ClickUp token round-trip before done.
- **Control-Plane/DB-mutating arms** (`executeControlPlaneMigration`, `setCustomDbPath`, `saveWorkspaceMappings`) — return the result without altering the mutation ordering; provider tests unchanged.

## Dependencies
- A2b ·1 Foundations (seams, dispatcher, `validateVerbPayload`, harness) — present.
- Return-contract ratchet — land first/with, to lock the ceiling at 0.

## Verification Plan (Definition of Done — objective)
- `scripts/analyze-verb-migration2.js`: Setup read-arm `break`→`return` flipped; **ratchet ceiling for `setup` lowered to 0** and `verb-returns:check` green.
- `verbSchemas.ts` `setup` block non-empty and covering the listed high-risk writes.
- New headless Setup suite passes and **asserts payload fields, not just `success`**.
- `parity:check` / `push-routing:check` / `compile-tests` green.
- Manual: `POST /setup/verb/<readVerb>` returns data in-body matching the push; a token save→get round-trips; a malformed payload is rejected, a valid one is not.
