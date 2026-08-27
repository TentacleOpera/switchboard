# Wire the sixteen unwired LocalApiServer seams in the standalone host

## Goal

Close the composition-root gap between the two `LocalApiServer` construction sites. The extension host passes **57** options; the standalone host passes **45**. Sixteen options are wired in the extension only, and every HTTP route gated on one of them is either dead or silently degraded in `npx switchboard`.

### Problem Analysis

There are exactly two places `LocalApiServer` is constructed:

| Host | Site | Options passed |
| :--- | :--- | :--- |
| Extension | `src/services/TaskViewerProvider.ts:3707` | 57 |
| Standalone | `src/standalone/bootstrap.ts:2756` (`const options: any = {`), passed at `:3082` | 45 |

Diffing the two option objects by key yields sixteen wired in the extension only. Four are wired in standalone only and are correctly host-specific (`port`, `terminalWsGateway`, `allowSecretWritesOverHttp`, `mintEnrolmentToken`).

**The sixteen, by failure mode.** The distinction matters because it decides how the defect presents:

**Hard failure — the route answers an error.** `LocalApiServer` guards on the option and returns a status:

| Option | Handler | Status |
| :--- | :--- | :--- |
| `moveCard` | `_handleKanbanMove` (`POST /kanban/move`) | 503 `Kanban move not available` |
| `cleanupWorktree` | `_handleWorktreeCleanup` | 503 |
| `mergeWorktree` | `_handleWorktreeMerge` | 503 |
| `missionControlConfirm` | `_handleMissionControlConfirm` | 503 |
| `missionControlHandoff` | `_handleMissionControlHandoff` | 503 |
| `onDispatchResearch` | `_handleResearchDispatch` | 503 |
| `onPhoneAFriend` | `_handlePhoneAFriend` | 503 |
| `onPhoneAFriendDone` | `_handlePhoneAFriendDone` | 503 |
| `clearTerminalContext` | terminal context clear (`:2500`) | 501 |

**Silent degradation — no guard, so "never wired" and "working" are the same value.** These are the dangerous class named in `CLAUDE.md`: `getFleetOrdersDatabase`, `notifyOperator`, `resolveAutoDispatchColumn`, `resolveKanbanDispatch`, `resolvePlanRoots`, `resolveTeamMembers`, `resolveTeamPacing`.

**How this was found.** `POST /kanban/move` returned `503 {"error":"Kanban move not available"}` against a running `npx switchboard` host while `GET /kanban/board` served the same board correctly. The board reads fine and cannot be moved by API — so any agent, script or remote path that advances a card through the documented HTTP surface is inert in the standalone host, while the same call works in the extension.

`moveCard` is the one to reason from because it is unambiguously portable: the extension's implementation (`TaskViewerProvider.ts:3806`) does nothing but delegate to `this._kanbanProvider`, and **`bootstrap.ts` already holds a `kanbanProvider`** (used at `:2592` for `resolveTeamPacing`, `:305` and `:316` for scoped settings). Nothing about the capability is editor-specific. It was simply never added to the options object.

### Root Cause

The same failure `CLAUDE.md` documents from 2026-08 with the four `PlanIngestionEngine` queue seams, recurring in a different object. The trap is not verb reachability — `bootstrap.ts`'s `default:` arm delegates every unmatched verb to the provider, so verb audits come back green. The trap is the **options object handed to a shared service**: a missing key is not a compile error (`const options: any`), not a runtime error at construction, and not a test failure, because `LocalApiServer` treats every one of these as optional. `npm run standalone-parity:check` does not catch it either — it is scoped to the browser read-back path, not the composition root.

`const options: any` is load-bearing in the wrong direction: typing the object as `LocalApiServerOptions` would still not catch it (every field is optional by design, for test harnesses), but `any` removes even the chance of an editor hint.

### Scope note

**Not all sixteen are necessarily bugs.** Some may be legitimately extension-only — `onPhoneAFriend` and `clearTerminalContext` touch terminal seats, and the standalone host runs its own PTY fleet rather than VS Code terminals, so the correct wiring may differ rather than being absent. This plan therefore requires each of the sixteen to be **resolved**, not blanket-wired: either wired to the standalone equivalent, or explicitly documented in a comment at the options site as host-specific with the reason. An unresolved entry is not allowed to stay silent.

## Metadata

**Complexity:** 6
**Tags:** backend, standalone, parity, reliability, api

## Approach

1. **Classify all sixteen.** For each, read the extension's implementation and decide: portable (delegates to something `bootstrap.ts` already has), portable-with-adaptation (needs a standalone equivalent, e.g. PTY fleet instead of VS Code terminals), or genuinely host-specific.

2. **Wire the portable ones.** Start with `moveCard`, which is a direct delegation to the existing `kanbanProvider`. Keep the standalone implementation **byte-symmetric with the extension's** where the underlying call is the same — same provider method, same arguments, same return shape — following the precedent already set in `bootstrap.ts` for the queue seams.

3. **Adapt the terminal-coupled ones.** `clearTerminalContext`, `onPhoneAFriend`, `onPhoneAFriendDone` and `resolveKanbanDispatch` reach terminal seats. Route them through `ptyFleetService` rather than reproducing the VS Code terminal path.

4. **Document the genuinely host-specific ones** in a comment at the options site, naming why. A reader diffing the two roots must be able to see that the absence is a decision.

5. **Guard the silent seven.** For every option in the silent-degradation group that stays optional, add an explicit `if (!this._options.X)` branch in `LocalApiServer` that returns a real status instead of proceeding with `undefined`. A capability that is absent should say so, not behave as if it succeeded. This is what converts the next occurrence of this bug from invisible to reportable.

## Complexity Audit

### Routine

- Adding keys to the options object in `bootstrap.ts`.
- `moveCard` specifically: the delegate already exists on both sides.

### Complex / Risky

- **`resolveTeamPacing` / `resolveTeamMembers` already exist as locals in `bootstrap.ts`** (`:2588`, `:2600`) but are wired into `PlanIngestionEngine`, not into the `LocalApiServer` options. Two consumers, one resolver — check whether the shapes are actually identical before reusing, rather than assuming the name implies the contract.
- **Lazy vs eager capture.** `bootstrap.ts:2607` documents this trap explicitly: `server` is declared at `:514` and assigned at `:3082`, so any seam wired before construction that captures `server` in a local binds `undefined` and no-ops forever. Any new option whose body needs `server` must resolve it at call time.
- **`notifyOperator` has no standalone UI surface.** The extension shows a VS Code notification. The browser host needs a real destination — the broadcast hub to the shell, most likely — not a `console.log` that satisfies the signature and reaches nobody.
- **The silent seven are behaviour changes, not just wiring.** Adding a guard where none existed turns a silent no-op into a visible error. That is the intent, but it will surface latent breakage in the standalone host that users have been living with unknowingly. Expect the first run after this change to fail louder than before, and treat that as the plan working.
- **`moveCard` fans out.** Its docstring (`LocalApiServer.ts:141-146`) says the callback exists to carry the feature→subtask cascade, the Linear/ClickUp integration-sync fan-out, and the board refresh — the direct-DB path deliberately cannot reach the integration token. Wiring it in standalone means those side effects start firing in a host where they never have. Verify the sync fan-out behaves when the token lives in the standalone secrets store rather than VS Code secret storage.

## Edge-Case & Dependency Audit

**Migration.** None. No persisted state changes; this is wiring that should always have been present. Users on the standalone host gain function they never had.

**Security.** `moveCard` and the mission-control seams are already behind `_checkAuth`. Wiring them does not widen the authenticated surface — it makes the existing, already-authenticated routes work. Confirm no newly wired seam bypasses `_checkAuth`, and that `switchboard.security.strictInboxAuth` still gates instruction dispatch.

**Side effects.** Standalone hosts currently running scripts that tolerate a 503 from `/kanban/move` will start seeing real moves. That is the fix, but anything that retried on 503 should be checked for double-move behaviour.

**Ordering.** Independent of the parity gate plan, and shippable first. The gate is what stops this recurring; this plan is what makes the host work now.

## Verification Plan

1. **Reproduce first.** Against a running `npx switchboard`, confirm `POST /kanban/move` returns `503 Kanban move not available`, and that `GET /kanban/board` returns the board on the same host. Record both.
2. **After wiring**, the same `POST /kanban/move` moves the card, and a follow-up `GET /kanban/board` shows the new `kanbanColumn`.
3. **Both hosts, same call.** Run the identical request against the extension host and the standalone host; assert the same status and response shape.
4. **A new contract test** that constructs both option objects and asserts their key sets are equal modulo an explicit, named allowlist of host-specific keys. This test is the deliverable that makes the plan durable — see the companion parity-gate plan for the general form.
5. **The silent seven:** for each, assert the guarded route returns a defined status rather than proceeding with `undefined`.
6. `npm run compile` and `tsc` clean; the standalone contract suites green — at minimum `standalone-parity:check`, `host-seam-parity:check`, `verb-engine-headless-seams`, `browser-panel-verb-routing`, `connections-routing-contract`.
7. **Manual:** in `npx switchboard`, drag a card between columns in the browser board and confirm the move persists across a reload.

## Dependencies

- Pairs with **the standalone composition-root parity gate** plan, which prevents recurrence. Either can ship first; this one restores function, that one keeps it.
- Follows the precedent of the 2026-08 `PlanIngestionEngine` queue-seam wiring recorded in `CLAUDE.md`, including its lazy-resolution pattern for anything needing `server`.
- `ARCHITECTURE.md` should gain a line noting that the two composition roots are `TaskViewerProvider.ts:3707` and `bootstrap.ts:2756`, since the map currently names providers but not the option sites where they are joined.
