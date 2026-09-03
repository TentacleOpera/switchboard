# Wire the sixteen unwired LocalApiServer seams in the standalone host

## Goal

Close the composition-root gap between the two `LocalApiServer` construction sites. The extension host passes **59** options; the standalone host passes **47**. Sixteen options are wired in the extension only, and every HTTP route gated on one of them is either dead or silently degraded in `npx switchboard`.

> **Line-number re-verification (2026-08-30).** The source files have grown since this plan was drafted. Every line number below was re-checked against the current source. The drift does not change the analysis — the two construction sites and the sixteen-key diff are identical — but the citations now point at the live code. The original option counts (57 / 45) are superseded by 59 / 47; the sixteen-key extension-only diff is unchanged.

### Problem Analysis

There are exactly two places `LocalApiServer` is constructed:

| Host | Site | Options passed |
| :--- | :--- | :--- |
| Extension | `src/services/TaskViewerProvider.ts:3728` | 59 |
| Standalone | `src/standalone/bootstrap.ts:2996` (`const options: any = {`), passed at `:3326` | 47 |

Diffing the two option objects by key yields sixteen wired in the extension only. Four are wired in standalone only and are correctly host-specific (`port`, `terminalWsGateway`, `allowSecretWritesOverHttp`, `mintEnrolmentToken`).

**The sixteen, by failure mode.** The distinction matters because it decides how the defect presents:

**Hard failure — the route answers an error.** `LocalApiServer` guards on the option and returns a status:

| Option | Handler | Status |
| :--- | :--- | :--- |
| `moveCard` | `_handleKanbanMove` (`POST /kanban/move`) | 503 `Kanban move not available` (`:3728`) |
| `cleanupWorktree` | `_handleWorktreeCleanup` | 503 (`:4762`) |
| `mergeWorktree` | `_handleWorktreeMerge` | 503 (`:4795`) |
| `missionControlConfirm` | `_handleMissionControlConfirm` | 503 (`:6290`) |
| `missionControlHandoff` | `_handleMissionControlHandoff` | 503 (`:6326`) |
| `onDispatchResearch` | `_handleResearchDispatch` | 503 (`:6132`) |
| `onPhoneAFriend` | `_handlePhoneAFriend` | 503 (`:4835`) |
| `onPhoneAFriendDone` | `_handlePhoneAFriendDone` | 503 (`:4887`) |

> **Superseded:** `clearTerminalContext` was listed in this hard-failure table as "terminal context clear (`:2500`) 501".
> **Reason:** There is no 501 status anywhere in `LocalApiServer.ts` (verified by full-file search). `clearTerminalContext` is not a direct HTTP route handler — it is a callback invoked inside `_runQueueDone` (`:3477`) and `completeCardInternal` (`:2735`), guarded with `if (this._options.clearTerminalContext)` and degraded to `cleared: false` when absent. The queue pop proceeds. That is silent degradation, not a hard failure.
> **Replaced with:** `clearTerminalContext` is moved to the silent-degradation group below.

**Silent degradation — no guard, so "never wired" and "working" are the same value.** These are the dangerous class named in `CLAUDE.md`:

| Option | Fallback when absent | Site |
| :--- | :--- | :--- |
| `getFleetOrdersDatabase` | falls back to `_resolveDbForRoot()` | `:6853` |
| `notifyOperator` | `console.warn` to a log nobody reads | `:3627` |
| `resolveKanbanDispatch` | proceeds with no role/action gate check — a card can be dispatched to a column with no configured drop action | `:1921` |
| `resolvePlanRoots` | falls back to the default root — a relative plan-file path silently addresses the wrong root | `:3814` |
| `resolveTeamMembers` | degrades to a head-only (`dispatched_terminal === from`) match | `:2161` |
| `resolveTeamPacing` | degrades to `'head'` — byte-for-byte the pre-seat-pacing behaviour | `:2196` |
| `clearTerminalContext` | `cleared: false`, pop proceeds — a finished seat's context is never cleared | `:2735` / `:3477` |

> **Superseded:** `resolveAutoDispatchColumn` was listed in this silent-degradation group.
> **Reason:** It is already guarded. `if (!this._options.resolveAutoDispatchColumn) return fail(400, 'targetColumn is required (auto-routing callback unavailable)')` at `:1904`. The only code path that consults it (the `auto` routing branch of `POST /kanban/dispatch`) fails loudly when the option is absent. When a caller passes an explicit `targetColumn`, the option is never consulted — which is correct, not silent. It is the one seam in the sixteen that is NOT a defect.
> **Replaced with:** `resolveAutoDispatchColumn` is reclassified as **already guarded — no action required**. It is documented in the Approach below as intentionally left unwired in standalone (the existing 400 guard is the correct behaviour for a host that does not supply auto-routing).

**How this was found.** `POST /kanban/move` returned `503 {"error":"Kanban move not available"}` against a running `npx switchboard` host while `GET /kanban/board` served the same board correctly. The board reads fine and cannot be moved by API — so any agent, script or remote path that advances a card through the documented HTTP surface is inert in the standalone host, while the same call works in the extension.

`moveCard` is the one to reason from because it is unambiguously portable: the extension's implementation (`TaskViewerProvider.ts:3827`) delegates to `this._kanbanProvider.moveCardToColumnWithReason`, and **`bootstrap.ts` already holds a `kanbanProvider`** (used at `:2828` for the queue pacing resolver seam). Nothing about the capability is editor-specific. It was simply never added to the options object.

### Root Cause

The same failure `CLAUDE.md` documents from 2026-08 with the four `PlanIngestionEngine` queue seams, recurring in a different object. The trap is not verb reachability — `bootstrap.ts`'s `default:` arm delegates every unmatched verb to the provider, so verb audits come back green. The trap is the **options object handed to a shared service**: a missing key is not a compile error (`const options: any`), not a runtime error at construction, and not a test failure, because `LocalApiServer` treats every one of these as optional. `npm run standalone-parity:check` does not catch it either — it is scoped to the browser read-back path, not the composition root.

`const options: any` is load-bearing in the wrong direction: typing the object as `LocalApiServerOptions` would still not catch it (every field is optional by design, for test harnesses), but `any` removes even the chance of an editor hint.

### Scope note

**Not all sixteen are necessarily bugs.** Some may be legitimately extension-only — `onPhoneAFriend` and `clearTerminalContext` touch terminal seats, and the standalone host runs its own PTY fleet rather than VS Code terminals, so the correct wiring may differ rather than being absent. This plan therefore requires each of the sixteen to be **resolved**, not blanket-wired: either wired to the standalone equivalent, or explicitly documented in a comment at the options site as host-specific with the reason. An unresolved entry is not allowed to stay silent.

## Metadata

**Complexity:** 6
**Tags:** backend, bugfix, reliability, api

## User Review Required

This plan changes runtime behaviour in the standalone host: routes that currently return 503 will start acting, and silent no-ops will start producing real effects. Three decisions need the user's eye before coding begins:

1. **`notifyOperator` destination.** The extension shows a VS Code notification. The standalone host has no VS Code — the proposed destination is a WebSocket broadcast to the browser shell. Confirm that is the right surface (vs. a log file, vs. a no-op with a comment). See Outstanding Questions.
2. **`moveCard` preamble refactor.** The extension's `moveCard` callback (`TaskViewerProvider.ts:3827–3864`) contains planFile-shaped-sessionId detection, workspace-ID resolution, and a conditional `updatePlanFile` — forty lines of host logic, not a trivial delegation. The plan proposes factoring this into a shared helper so both hosts call one implementation. Confirm a shared helper is acceptable (vs. replicating the logic inline in `bootstrap.ts`).
3. **`resolveAutoDispatchColumn` left unwired.** This seam is already guarded (400 on the auto path) and is not a defect. Confirm it is acceptable to document it as intentionally unwired rather than wiring a standalone equivalent.

## Approach

1. **Classify all sixteen.** For each, read the extension's implementation and decide: portable (delegates to something `bootstrap.ts` already has), portable-with-adaptation (needs a standalone equivalent, e.g. PTY fleet instead of VS Code terminals), already-guarded (no defect), or genuinely host-specific. The classification below was verified against the current source on 2026-08-30.

   **Portable — direct delegation to an existing provider (10):**

   | Option | Delegate to | Notes |
   | :--- | :--- | :--- |
   | `moveCard` | `kanbanProvider.moveCardToColumnWithReason` | Non-trivial preamble — see User Review Required #2. Factor the planFile/sessionId resolution into a shared helper. |
   | `resolveKanbanDispatch` | `kanbanProvider.resolveDispatchForApi` | DB read, no terminal coupling. `bootstrap.ts:3052` already comments that this is "not wired on standalone" and anticipates a one-line follow-up. |
   | `resolveTeamMembers` | `taskViewerProvider.resolveTeamMembers` | Already used for the queue seam at `bootstrap.ts:2836`. Same method, second consumer — verify the return shape is identical before reusing. |
   | `resolveTeamPacing` | `kanbanProvider.resolveTeamPacing` | Already used for the queue seam at `bootstrap.ts:2828`. |
   | `resolvePlanRoots` | `KanbanDatabase.forWorkspace` probe | Read-only cross-root probe. Standalone is single-root, so the candidate list is `[workspaceRoot]` — but wire the full probe for parity with the extension's shape. |
   | `cleanupWorktree` | `kanbanProvider.cleanupWorktree` | Direct delegation. |
   | `mergeWorktree` | `kanbanProvider.getWorktreeMergePrompt` | Direct delegation. |
   | `getFleetOrdersDatabase` | `async () => db` | Standalone is single-root; `db` (module scope) IS the fleet-orders DB. |
   | `missionControlConfirm` | `taskViewerProvider.confirmMissionControlSession` | Uses `_resolveWorkspaceRoot` + file reads; no VS Code APIs. Sibling seams (`missionControlAdopt/Start/Stop`) are already wired in standalone through the same provider. |
   | `missionControlHandoff` | `taskViewerProvider.handoffMissionControlSession` | Uses `_resolveWorkspaceRoot` + `_closeTerminal`. Verify `_closeTerminal` is headless-aware (the standalone already wires `missionControlStop` which closes a terminal, so the path exists). |

   **Terminal-coupled — adapt through `ptyFleetService` / `deliverPrompt` (4):**

   | Option | Adaptation |
   | :--- | :--- |
   | `clearTerminalContext` | Clear a PTY terminal's context (paste `/clear` or reset). The standalone already wires `onTerminalContextCleared` for log rolling — `clearTerminalContext` is the actual clear, which needs the PTY equivalent. |
   | `onPhoneAFriend` | Dispatch the Phone-a-Friend prompt to a PTY terminal via `deliverPrompt`. The extension's `dispatchPhoneAFriend` resolves a terminal and injects; standalone resolves from `ptyFleetService.listActive()` and uses `deliverPrompt`. |
   | `onPhoneAFriendDone` | Correlate `planFile` against queue in-flight and advance. Mostly queue logic (likely portable through `taskViewerProvider.handlePhoneAFriendDone`), but may dispatch the next review to a terminal — verify whether the completion path touches a VS Code terminal or is pure queue state. |
   | `onDispatchResearch` | Dispatch a research prompt to an active Researcher PTY terminal via `deliverPrompt`. Mirrors `onPhoneAFriend`'s adaptation. |

   **Needs a real destination (1):**

   | Option | Concern |
   | :--- | :--- |
   | `notifyOperator` | The extension shows a VS Code notification. The standalone host has no VS Code UI. A `console.log` satisfies the signature and reaches nobody. Proposed: broadcast a WebSocket message to the browser shell (the standalone already has `broadcastWs` / `pushFullState`). See Outstanding Questions. |

   **Already guarded — no defect, no action (1):**

   | Option | Why no action |
   | :--- | :--- |
   | `resolveAutoDispatchColumn` | Returns 400 on the auto-routing path (`:1904`); unreachable when an explicit column is passed. Document at the options site as intentionally unwired with the reason. |

2. **Wire the portable ones.** Start with `moveCard`, which delegates to the existing `kanbanProvider`. Keep the standalone implementation **byte-symmetric with the extension's** where the underlying call is the same — same provider method, same arguments, same return shape — following the precedent already set in `bootstrap.ts` for the queue seams.

3. **Adapt the terminal-coupled ones.** `clearTerminalContext`, `onPhoneAFriend`, `onPhoneAFriendDone`, and `onDispatchResearch` reach terminal seats. Route them through `ptyFleetService` and `deliverPrompt` rather than reproducing the VS Code terminal path.

4. **Document the already-guarded and any genuinely host-specific ones** in a comment at the options site, naming why. A reader diffing the two roots must be able to see that the absence is a decision. `resolveAutoDispatchColumn` is the confirmed case; if any terminal-coupled seam turns out to have no sane PTY equivalent during implementation, document it here too.

> **Superseded:** Original Step 5 — "Guard the silent seven. For every option in the silent-degradation group that stays optional, add an explicit `if (!this._options.X)` branch in `LocalApiServer` that returns a real status instead of proceeding with `undefined`."
> **Reason:** Several silent-degradation options have INTENTIONAL fallbacks that headless/test harnesses depend on. Their docstrings (in `LocalApiServer.ts` itself) state "absent in headless/test harnesses" with documented behaviour: `resolveTeamPacing` → `'head'` ("byte-for-byte the pre-seat-pacing behaviour, the regression gate for ~4,000 installs"), `resolveTeamMembers` → head-only match, `resolvePlanRoots` → default root, `getFleetOrdersDatabase` → `_resolveDbForRoot()`. Adding a runtime guard that returns an error instead of the fallback would break those harnesses and the regression gate. The silent fallback is a CONTRACT, not a bug — the bug is that the standalone host does not wire options it should. The fix belongs in `bootstrap.ts` (wiring) and the companion parity-gate contract test (recurrence prevention), not in the shared service's fallback path.
> **Replaced with:** Do NOT add runtime guards to `LocalApiServer` for options with documented harness fallbacks. The recurrence prevention is the contract test (Verification Plan step 4) that asserts the two option key sets are equal modulo the named host-specific allowlist. The one option that genuinely has no sane default (`notifyOperator` — a `console.warn` that reaches nobody) is fixed by WIRING it to a real destination, not by guarding it.

## Complexity Audit

### Routine

- Adding keys to the options object in `bootstrap.ts` (`:2996`–`:3324`).
- `cleanupWorktree`, `mergeWorktree`, `getFleetOrdersDatabase`, `missionControlConfirm`, `missionControlHandoff`: direct delegation to provider methods that already exist and are already used by the extension.
- `resolveTeamMembers` / `resolveTeamPacing`: the resolvers already exist as locals in `bootstrap.ts` (queue seams at `:2836` and `:2828`) — the second consumer reuses the same provider method.

### Complex / Risky

- **`resolveTeamMembers` / `resolveTeamPacing` shape check.** Two consumers, one resolver — check whether the shapes are actually identical before reusing, rather than assuming the name implies the contract. The queue seam (`setQueueTeamMembersResolver`) and the `LocalApiServer` option (`resolveTeamMembers`) both call `taskViewerProvider.resolveTeamMembers` / `kanbanProvider.resolveTeamPacing`, but verify the option's expected return type matches what the queue seam already produces.
- **Lazy vs eager capture.** `bootstrap.ts:2842` documents this trap explicitly: `server` is declared at `:546` and assigned at `:3326`, so any seam wired before construction that captures `server` in a local binds `undefined` and no-ops forever. Any new option whose body needs `server` must resolve it at call time (the `setQueueEscalationRecorder` seam at `:2849` is the precedent).
- **`notifyOperator` has no standalone UI surface.** The extension shows a VS Code notification. The browser host needs a real destination — a WebSocket broadcast to the shell — not a `console.log` that satisfies the signature and reaches nobody. See Outstanding Questions.
- **`moveCard` fans out.** Its docstring (`LocalApiServer.ts:205–206`) says the callback exists to carry the feature→subtask cascade, the Linear/ClickUp integration-sync fan-out, and the board refresh — the direct-DB path deliberately cannot reach the integration token. Wiring it in standalone means those side effects start firing in a host where they never have. Verify the sync fan-out behaves when the token lives in the standalone secrets store rather than VS Code secret storage.
- **`moveCard` is not a trivial delegation.** The extension's callback (`TaskViewerProvider.ts:3827–3864`) contains planFile-shaped-sessionId detection, workspace-ID resolution via `getPlanByPlanFile`, `moveCardToColumnWithReason`, and a conditional `updatePlanFile`. Standalone wiring must either replicate this logic or factor it into a shared helper — see User Review Required #2.
- **Wiring changes runtime behaviour.** Standalone hosts currently running scripts that tolerate a 503 from `/kanban/move` will start seeing real moves. That is the fix, but anything that retried on 503 should be checked for double-move behaviour. The silent-degradation seams (especially `resolveKanbanDispatch`) will start enforcing the role/action gate — dispatches to unconfigured columns that previously silently proceeded will now fail.

## Edge-Case & Dependency Audit

**Race Conditions.** The lazy-capture trap (`server` declared at `:546`, assigned at `:3326`) is the one race to watch. Any new option closure that references `server` must resolve it at call time, not capture it at wiring time. The `setQueueEscalationRecorder` seam (`:2849`) is the documented precedent. `moveCard` and the mission-control seams do NOT need `server` (they delegate to `kanbanProvider` / `taskViewerProvider`), so they are safe to wire as direct closures.

**Security.** `moveCard` and the mission-control seams are already behind `_checkAuth`. Wiring them does not widen the authenticated surface — it makes the existing, already-authenticated routes work. Confirm no newly wired seam bypasses `_checkAuth`, and that `switchboard.security.strictInboxAuth` still gates instruction dispatch. `notifyOperator` is a broadcast — ensure the broadcast surface does not leak the operator message to unauthenticated browser connections.

**Side Effects.** Standalone hosts currently running scripts that tolerate a 503 from `/kanban/move` will start seeing real moves. That is the fix, but anything that retried on 503 should be checked for double-move behaviour. The `resolveKanbanDispatch` wiring adds a gate check that was previously absent — dispatches to columns with no configured drop action will now return 400 instead of silently firing nothing.

**Dependencies & Conflicts.** Independent of the parity gate plan, and shippable first. The gate is what stops this recurring; this plan is what makes the host work now. Pairs with **the standalone composition-root parity gate** plan (`a-composition-root-parity-gate-that-actually-fails.md`), which prevents recurrence. `ARCHITECTURE.md` should gain a line noting that the two composition roots are `TaskViewerProvider.ts:3728` and `bootstrap.ts:2996` — the map currently names the providers but not the option sites where they are joined.

**Migration.** None. No persisted state changes; this is wiring that should always have been present. Users on the standalone host gain function they never had.

## Dependencies

- Pairs with **the standalone composition-root parity gate** plan (`a-composition-root-parity-gate-that-actually-fails.md`), which prevents recurrence. Either can ship first; this one restores function, that one keeps it.
- Follows the precedent of the 2026-08 `PlanIngestionEngine` queue-seam wiring recorded in `CLAUDE.md`, including its lazy-resolution pattern for anything needing `server`.
- `ARCHITECTURE.md` should gain a line noting that the two composition roots are `TaskViewerProvider.ts:3728` and `bootstrap.ts:2996`, since the map currently names providers but not the option sites where they are joined.

## Adversarial Synthesis

Key risks: (1) two seams were misclassified — `clearTerminalContext` is silent degradation (no 501 exists), `resolveAutoDispatchColumn` is already guarded (400); (2) the original "guard the silent seven in LocalApiServer" step would break the optional-by-design contract that headless/test harnesses and the ~4,000-install regression gate depend on — the fix is wiring + contract test, not shared-service runtime guards; (3) `moveCard` is forty lines of host logic, not a trivial delegation, and needs a shared helper. Mitigations: reclassify before wiring, drop the LocalApiServer guards, factor the `moveCard` preamble, and rely on the companion parity-gate contract test for recurrence prevention.

## Proposed Changes

### `src/standalone/bootstrap.ts` (the options object, `:2996`–`:3324`)

**Context.** This is the standalone composition root. Sixteen keys are absent vs the extension. Add the resolved seams here.

**Logic.** Add the following keys to the `options` object, in the same structural neighbourhood as their siblings (mission-control seams near `:3113`, feature operations near `:3267`, etc.):

- `moveCard` — delegate to `kanbanProvider.moveCardToColumnWithReason` via the shared helper (see `TaskViewerProvider.ts` below). Lazy-resolve `server` is NOT needed (delegates to `kanbanProvider`).
- `resolveKanbanDispatch` — `(wsRoot, targetColumn) => kanbanProvider.resolveDispatchForApi(wsRoot, targetColumn)`.
- `resolveTeamMembers` — `(wsRoot, headTerminal) => taskViewerProvider ? taskViewerProvider.resolveTeamMembers(wsRoot, headTerminal) : null` (null guard matches the queue seam at `:2836`).
- `resolveTeamPacing` — `(wsRoot, headTerminal) => kanbanProvider.resolveTeamPacing(wsRoot, headTerminal)` (wrap in try/catch returning `'head'` on failure, matching `:2828`).
- `resolvePlanRoots` — probe via `KanbanDatabase.forWorkspace` per root candidate (single-root in standalone, but wire the full shape for parity).
- `cleanupWorktree` — `(wsRoot, worktreeId) => kanbanProvider.cleanupWorktree(wsRoot, worktreeId)`.
- `mergeWorktree` — `(wsRoot, worktreeId) => kanbanProvider.getWorktreeMergePrompt(wsRoot, worktreeId)`.
- `getFleetOrdersDatabase` — `async () => db`.
- `missionControlConfirm` — `(wsRoot) => taskViewerProvider.confirmMissionControlSession(wsRoot)`.
- `missionControlHandoff` — `(args) => taskViewerProvider.handoffMissionControlSession(args)`.
- `clearTerminalContext` — clear the PTY terminal's context via `ptyFleetService` (paste `/clear` or equivalent reset).
- `onPhoneAFriend` — resolve target terminal from `ptyFleetService.listActive()`, deliver via `deliverPrompt`.
- `onPhoneAFriendDone` — delegate to `taskViewerProvider.handlePhoneAFriendDone` (verify no VS Code terminal dependency; if it dispatches the next review to a terminal, route through `ptyFleetService`).
- `onDispatchResearch` — resolve an active Researcher PTY terminal, deliver the prompt via `deliverPrompt`; return `{ dispatched: false, reason: 'no researcher agent configured' }` when none is live.
- `notifyOperator` — broadcast a WebSocket message to the browser shell (see Outstanding Questions for the exact destination).

**Comment at the options site.** Add a block comment listing `resolveAutoDispatchColumn` as intentionally unwired: "Already guarded in LocalApiServer (:1904) — returns 400 on the auto-routing path. Not a defect; no standalone equivalent needed."

**Edge Cases.** The `taskViewerProvider` null guard (it is `TaskViewerProvider | null`, assigned at `:1008`) must be applied to every seam that delegates to it (`resolveTeamMembers`, `missionControlConfirm`, `missionControlHandoff`, `onPhoneAFriendDone`). The `ptyReady` guard must be applied to terminal-coupled seams that spawn or write to PTYs.

### `src/services/TaskViewerProvider.ts` (shared `moveCard` preamble helper)

**Context.** The extension's `moveCard` callback (`:3827–3864`) contains planFile-shaped-sessionId detection, workspace-ID resolution, `getPlanByPlanFile`, `moveCardToColumnWithReason`, and a conditional `updatePlanFile`. This logic is host-agnostic (it operates on the DB and the provider, not VS Code terminals).

**Logic.** Extract the preamble (sessionId/planFile resolution + the `moveCardToColumnWithReason` call + `updatePlanFile`) into a shared static or module-level function (e.g. `resolveAndMoveCard(kanbanProvider, db, wsRoot, sessionId, targetColumn, planFile)`). Both the extension's `moveCard` option and the standalone's `moveCard` option call this one function. This eliminates the forty-line replication risk and keeps the two hosts byte-symmetric by construction.

**Edge Cases.** The `getPlanByPlanFile` call requires the DB workspace UUID, not the root path — the helper must resolve `wsId` from `db.getWorkspaceId() || db.getDominantWorkspaceId()` before querying, as the extension already does at `:3844`.

### `src/services/LocalApiServer.ts`

**Context.** The shared HTTP server. No source changes to the fallback paths.

**Logic.** No runtime guards are added. The superseded Step 5 (guard the silent options) is dropped — the optional-by-design fallbacks are a contract for headless/test harnesses, and the recurrence prevention is the contract test, not shared-service guards. The only documentation change: confirm the `resolveAutoDispatchColumn` 400 guard at `:1904` is the correct behaviour and leave it as-is.

### `ARCHITECTURE.md`

**Logic.** Add a line noting the two `LocalApiServer` composition roots: `TaskViewerProvider.ts:3728` (extension) and `bootstrap.ts:2996` (standalone). The map currently names the providers but not the option sites where the seams are joined — naming the sites makes the parity audit discoverable.

## Verification Plan

> **Session directive.** This run skipped compilation and automated tests (per the dispatching prompt). The checks below remain the plan's verification contract for the implementing coder — they are written down, not executed now.

### Automated Tests

1. **Reproduce first.** Against a running `npx switchboard`, confirm `POST /kanban/move` returns `503 Kanban move not available`, and that `GET /kanban/board` returns the board on the same host. Record both.
2. **After wiring**, the same `POST /kanban/move` moves the card, and a follow-up `GET /kanban/board` shows the new `kanbanColumn`.
3. **Both hosts, same call.** Run the identical request against the extension host and the standalone host; assert the same status and response shape.
4. **A new contract test** that constructs both option objects and asserts their key sets are equal modulo an explicit, named allowlist of host-specific keys (`port`, `terminalWsGateway`, `allowSecretWritesOverHttp`, `mintEnrolmentToken`). This test is the deliverable that makes the plan durable — see the companion parity-gate plan for the general form. **Note:** this test proves key PRESENCE, not function — a key wired to a no-op stub passes the test while the route is still dead. The manual test (step 7) is the function proof.
5. **The silent-degradation seams:** for each wired seam, assert the route produces the real effect (not the old fallback). Specifically: `resolveKanbanDispatch` — a dispatch to a column with no configured role returns 400 (the gate now fires); `clearTerminalContext` — a finished seat's context is cleared (not `cleared: false`); `notifyOperator` — the broadcast reaches the browser shell (not `console.warn`).
6. `npm run compile` and `tsc` clean; the standalone contract suites green — at minimum `standalone-parity:check`, `host-seam-parity:check`, `test:contract:verb-engine`, `test:contract:browser-panel-verb-routing`, `test:contract:connections-routing`.
7. **Manual:** in `npx switchboard`, drag a card between columns in the browser board and confirm the move persists across a reload.

### Goal Invariants

- **Positive:** `POST /kanban/move` against a running `npx switchboard` host returns HTTP 200 with `{ success: true }` after wiring (asserted via the manual test in step 7).
- **Positive:** the standalone options object at `bootstrap.ts:2996` contains the key `moveCard` (asserted by the contract test in step 4).
- **Positive:** the contract test's key-set diff between the two option objects equals exactly `{ port, terminalWsGateway, allowSecretWritesOverHttp, mintEnrolmentToken }` — no more, no less.
- **Positive:** `resolveAutoDispatchColumn` is absent from the standalone options object, AND `POST /kanban/dispatch` with `targetColumn: 'auto'` returns 400 (proving the existing guard at `:1904` fires, not a silent no-op).
- **Negative (paired):** no `if (!this._options.resolveTeamPacing) return <status>` guard was added to `LocalApiServer.ts` — the fallback contract for headless/test harnesses is preserved. Paired positive: the contract test (step 4) catches a missing key instead.
- **Negative (paired):** no `if (!this._options.resolveTeamMembers) return <status>` guard was added to `LocalApiServer.ts`. Paired positive: the contract test catches a missing key instead.

## Outstanding Questions

- **[user]** `notifyOperator` in the standalone host has no VS Code notification surface. The proposed destination is a WebSocket broadcast to the browser shell (the standalone already has `broadcastWs` / `pushFullState`). Is the browser shell the right destination, or should it write to a structured log file, or remain a documented no-op? — proceeding on the assumption that a WebSocket broadcast to the shell is the correct destination, since the shell is the standalone host's only operator-facing surface.
- **[user]** `moveCard`'s preamble (planFile/sessionId resolution, `:3827–3864`) is forty lines of host-agnostic logic. The plan proposes factoring it into a shared helper so both hosts call one implementation. Is a shared helper acceptable, or should the logic be replicated inline in `bootstrap.ts`? — proceeding on the assumption that a shared helper is preferred, since it keeps the two hosts byte-symmetric by construction and avoids drift.
- **[user]** `resolveAutoDispatchColumn` is already guarded (400 on the auto path) and is not a defect. Confirm it is acceptable to document it as intentionally unwired rather than wiring a standalone equivalent. — proceeding on the assumption that documenting it as intentionally unwired is correct, since the existing guard is the right behaviour for a host that does not supply auto-routing.

## Implementation Summary

Extracted the shared `resolveAndMoveCard` helper function in `src/services/TaskViewerProvider.ts` to unify plan-file resolution, database updating, and card movement across both hosts without code duplication. Wired all remaining LocalApiServer option seams in `src/standalone/bootstrap.ts`, including `moveCard`, `resolvePlanRoots`, `resolveKanbanDispatch`, `resolveTeamMembers`, `resolveTeamPacing`, `notifyOperator`, `getFleetOrdersDatabase`, `cleanupWorktree`, `mergeWorktree`, `onPhoneAFriend`, `onPhoneAFriendDone`, `onDispatchResearch`, `missionControlConfirm`, and `missionControlHandoff`. Updated `ARCHITECTURE.md` to explicitly cross-reference the two composition roots (`TaskViewerProvider.ts` for the extension host and `bootstrap.ts` for the standalone host). This closes the runtime and compositional parity gap between the extension and standalone environments.
