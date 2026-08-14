# `POST /kanban/move` Is Dead in Standalone — and 13 More `LocalApiServer` Options the Bootstrap Never Passes

## Metadata

**Complexity:** 5
**Tags:** standalone, parity, local-api, kanban, ci-guard
**Project:** Browser Switchboard

## Goal

Wire the `moveCard` callback into `LocalApiServer` from the standalone bootstrap so `POST /kanban/move` performs a real card move instead of failing closed, and build the option-supply parity guard that turns the whole optional-option surface — where `moveCard` is one of **14** omissions, not a lone slip — from an invisible runtime divergence into a ratcheted CI number.

### Problem analysis and root cause

`reference/local-api-server.md` documents `POST /kanban/move` as "move card (no agent fire)" — a first-class endpoint of the local API, and the one an external agent or script is told to use when it wants to move a card **without** dispatching an agent. In the standalone host it does not work at all.

**Root cause, verified against the tree at HEAD:**

- `LocalApiServer` takes `moveCard` as an **optional** option (`src/services/LocalApiServer.ts:55`).
- The route handler reads it and fails closed when absent (`src/services/LocalApiServer.ts:1383-1384`):
  ```ts
  const moveCard = this._options.moveCard;
  if (!moveCard) {
      res.end(JSON.stringify({ error: 'Kanban move not available' }));
  ```
- `src/standalone/bootstrap.ts` **never passes `moveCard`** in the options object it constructs the server with (`server = new LocalApiServer(options)` at `:1936`). The only `moveCard`-adjacent reference in that file is an outbound `server.broadcastWs('moveCards', …)` push at `:1527` — a UI notification after a verb-driven move, not the endpoint's implementation.

So in standalone the endpoint answers every request with `{"error":"Kanban move not available"}`. In the extension host it is wired (`TaskViewerProvider.ts:2407`) and works. This is a genuine host divergence on a documented surface.

**The omission is one of fourteen, and that reframes the plan.** A scan of the 40 optional options on `LocalApiServerOptions` against both composition roots — matching both `key: value` and shorthand `key,` supply forms — finds **14 supplied by the extension and not by standalone**:

| | |
|---|---|
| `moveCard` | `resolvePlanRoots` |
| `resolveKanbanDispatch` | `resolveAutoDispatchColumn` |
| `cleanupWorktree` | `onPhoneAFriend` |
| `onDispatchResearch` | `onOrchestratorRequest` |
| `orchestrationDispatch` | `orchestrationStart` |
| `orchestrationStop` | `oversightStart` |
| `oversightStatus` | `oversightStop` |

Zero options are supplied by neither root, so every one of these 14 is a live asymmetry rather than a dormant field. Several are very likely **legitimately** editor-only — `onPhoneAFriend` fires a VS Code terminal; the `orchestration*` and `oversight*` families drive editor-hosted automation — but "likely" is the entire problem. Today nothing distinguishes a deliberate editor-only option from a forgotten one, because both look identical: an absent key on a valid object.

*Instrument honesty:* that count comes from a crude structural scan (interface field extraction + an indentation-anchored supply regex over both roots). It is indicative, not authoritative, and it may miss an option supplied conditionally or through a spread. Producing the authoritative number is the guard's first job, not a precondition for writing it. The number is quoted here because it changes the plan's shape — from "pass one callback" to "triage a surface" — not because it is being relied on as a final figure.

**Why it went unnoticed for so long:** moving a card *does* work in standalone through the verb rail — `promptSelected`, `completeSelected` and friends all reach `KanbanProvider` through the `kanbanVerb` `default:` arm and land their writes. Anyone checking "can standalone move a card?" gets a yes. The dedicated documented HTTP endpoint is the only thing that is dead, and it is the path an external tool follows, not the path a human clicking the board follows. The optional-callback shape is what allows the divergence to exist silently: an omitted option is a valid construction, so nothing fails at boot, at compile time, or in any test.

**The fix is patterned, not novel.** Bootstrap already wires **six** sibling callbacks to the same `kanbanProvider` in the same shape — `createFeature:1878`, `assignToFeature:1885`, `removeSubtaskFromFeature:1892`, `deleteFeature:1899`, `splitFeature:1906`, `reconcileFeatures:1913` — each a `try`/`catch` delegate returning `{success:false, error}` on throw. `moveCard` is the one member of that family left out. That is strong evidence of omission rather than intent, and it hands the implementation its exact template.

**Blast radius.** Every consumer that follows the documented contract: the `switchboard-orchestration` skill's move flow, `move-card.js`, the orchestrator persona (whose sanctioned move path is explicitly `POST /kanban/move`, never SQL), and any third-party agent that read the docs. All of them silently lose the ability to move a card the moment the board is served by `npx switchboard` instead of the editor.

## User Review Required

None.

## Complexity Audit

### Routine

- Passing an existing callback through an options object, following the six sibling delegates already in the same block.

### Complex / Risky

- **`moveCard`'s contract must match the extension's.** The extension's implementation (`TaskViewerProvider.ts:2407-2440`) is the reference. It accepts `(workspaceRoot, sessionId, targetColumn, planFile?)`, and it does more than delegate: when `sessionId` looks like a path (`includes('/')` or `endsWith('.md')`) it treats it as a plan file, resolves the real session id via `db.getPlanByPlanFile(...)` against the DB **workspace id** (a UUID, not the root path), then calls `moveCardToColumnWithReason` and writes back the plan file with `db.updatePlanFile`. A standalone version that delegates straight to `moveCardToColumnWithReason` without the plan-file branch will "work" for UUID keys and fail for exactly the callers that pass a plan path — which is most script callers. Port the branch, do not hand-write a shorter mover.
- **Integration-sync reach is an open capability question, and PRD contract #6 governs the answer.** The extension's own comment states the reason for routing through the provider: the move inherits the feature→subtask cascade, the **integration-sync fan-out**, and the board refresh, because the direct-DB path "can't sync … (the token lives in secret storage)". Whether standalone's secrets seam reaches that same token is not established by this plan. If it does not, wiring `moveCard` produces a move that succeeds locally and silently skips the outbound tracker sync — a *narrower* capability wearing a `success: true`. Per PRD contract #6 (capability-gating honesty) that must be surfaced, not smoothed over: determine the reach, and if sync is unavailable, say so in the response (e.g. a `syncedExternally: false` field) rather than returning an unqualified success. This is the one place where "wire it like the extension" is not automatically the right answer.
- **No agent fire.** The documented distinction between `/kanban/move` and `/kanban/dispatch` is precisely that move must **not** fire an agent. `moveCardToColumnWithReason` is the non-dispatching path; `triggerAction` (used by `performKanbanDispatch`) is not. Do not route through the latter.
- **Triaging the other 13 is the bulk of the work, and it is judgement, not typing.** Each needs a decision recorded as either "wire it" or "editor-only, because X". An unexamined option dumped into the allowlist to make CI green reproduces the defect with extra steps.

## Edge-Case & Dependency Audit

**Race Conditions** — a move triggers `schedulePushFullState()` coalescing (`bootstrap.ts`, `PUSH_COALESCE_MS = 40`). The move must land before the coalesced push reads state, which the existing trailing-edge chain already guarantees. No new race.

**Security** — the endpoint is already behind the standalone session-cookie auth and `Host`-header guard. No change. Note that standalone sets `allowSecretWritesOverHttp: true`; that is pre-existing and out of scope here, but it is relevant to the secret-storage question above and should not be widened by this work.

**Side Effects** — moving a card writes to `kanban.db` and emits a `moveCards` broadcast. Both are existing behaviour on the verb path.

**Dependencies & Conflicts**

- Related to but distinct from `standalone-kanban-column-parity-audit.md`, which owns *which column* an advance resolves to (`getNextKanbanColumn`). This plan owns *whether the endpoint functions at all*. Land them independently; neither blocks the other.
- **This plan owns the optional-option enumeration for the whole feature.** `standalone-code-verification-sweep-stubs-and-omissions.md` lists the same enumeration as its first defect shape. It does not re-derive it: this plan produces the machine-checked version, and the sweep consumes the guard's output. That makes this plan a prerequisite of the sweep.

## Dependencies

None inbound. Outbound: the sweep subtask consumes this plan's guard rather than hand-enumerating the option surface.

## Implementation

1. In `src/standalone/bootstrap.ts`, add `moveCard` to the `LocalApiServer` options object alongside the six existing `kanbanProvider` delegates (`:1878-1919`), following their `try`/`catch` → `{success:false, error}` shape.
2. Port the extension's plan-file-key branch verbatim in behaviour (`TaskViewerProvider.ts:2416-2437`): path-shaped key → resolve via `getPlanByPlanFile` against the DB workspace UUID → `moveCardToColumnWithReason` → `updatePlanFile` on success. Reuse the shared provider path; do not write a second mover.
3. Establish whether the standalone secrets seam reaches the integration token. Record the answer in the plan's outcome either way, and if it does not, qualify the response per PRD contract #6 rather than returning a bare success.
4. Confirm the move does **not** fire an agent — `/kanban/move` and `/kanban/dispatch` must remain distinguishable.
5. **Add the option-supply parity assertion to `scripts/check-standalone-push-parity.js`** as a fourth assertion, next to its existing broadcaster-installation assertion (which is the same shape: "the composition root must supply X"). Do **not** author a new standalone script. The assertion: extract every optional field of `LocalApiServerOptions`, determine supply in each composition root (handling both `key: value` and shorthand `key,`), and fail when an option is supplied by one root and neither supplied nor allowlisted in the other.
6. Record the residual editor-only options in `scripts/standalone-parity-allowlist.json` — the existing exemption file — **one entry per option with a stated reason**. Triage all 13 remaining omissions individually. Ratchet, do not zero-check: the file already carries baselines that may only be lowered, matching the repo idiom.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Context:** Constructs `LocalApiServer` with six `kanbanProvider` delegates and no `moveCard`.
- **Logic:** Supply `moveCard`, delegating to `moveCardToColumnWithReason` with the extension's plan-file-key resolution.
- **Edge Cases:** Path-shaped keys must resolve via the DB workspace UUID, not the root path; must not route through `triggerAction`; integration-sync reach qualified in the response if unavailable.

### `scripts/check-standalone-push-parity.js`
- **Context:** Already asserts broadcaster installation in `bootstrap.ts` and ratchets two other gaps. No assertion covers constructor-option supply.
- **Logic:** Fourth assertion — option-supply parity across both composition roots, allowlisted exemptions only.
- **Edge Cases:** Shorthand property supply must count as supplied (a naive `key:` regex under-reports and would flag correctly-wired options); conditionally-supplied options need an explicit decision rather than a silent pass.

### `scripts/standalone-parity-allowlist.json`
- **Logic:** One entry per genuinely editor-only option, each with its reason.
- **Edge Cases:** An entry with no reason is not an exemption, it is a suppression — reject that shape.

## Verification Plan

*Per session directive, no compilation or automated-test execution is part of this plan's verification; the guards below are CI-gated on merge (`.github/workflows/integration-tests.yml` already runs `standalone-parity:check`).*

1. `POST /kanban/move` against a standalone host moves the named card to the target column, and the move survives a re-read of `/kanban/board`.
2. The response is not `{"error":"Kanban move not available"}` under any workspace configuration.
3. A request keyed by **plan file path** (not UUID) moves the correct card — the branch most script callers exercise.
4. No agent is dispatched by the move — terminal state is unchanged, and `dispatchedAt` on the moved plan is unchanged.
5. The same request against an extension-hosted server produces the same result, confirming parity rather than a second implementation.
6. The integration-sync reach question is answered in writing, and if sync is unavailable in standalone the response says so rather than implying it happened.
7. The new assertion fails when `moveCard` is removed again, and passes with it wired.
8. Every one of the 13 residual omissions appears in the allowlist with a stated reason, or is wired. Zero appear as unexplained entries.

## Recommendation

Complexity 5 → **Send to Coder.** The `moveCard` wiring is a few lines against a six-sibling template. The weight is in the triage of the other 13 and in the guard — which is what converts "a callback was forgotten" from a class of defect three audits could not see into a number CI can.
