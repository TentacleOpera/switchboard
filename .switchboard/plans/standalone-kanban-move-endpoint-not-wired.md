# `POST /kanban/move` Is Dead in Standalone — `moveCard` Is Never Passed to `LocalApiServer`

## Metadata

**Complexity:** 3
**Tags:** standalone, parity, local-api, kanban
**Project:** Browser Switchboard

## Goal

Wire the `moveCard` callback into `LocalApiServer` from the standalone bootstrap so `POST /kanban/move` performs a real card move instead of returning a 503, and add a check that fails when a documented endpoint is left unwired in one host.

### Problem analysis and root cause

`reference/local-api-server.md` documents `POST /kanban/move` as "move card (no agent fire)" — a first-class endpoint of the local API, and the one an external agent or script is told to use when it wants to move a card **without** dispatching an agent. In the standalone host it does not work at all.

**Root cause, verified against the tree:**

- `LocalApiServer` takes `moveCard` as an **optional** option (`src/services/LocalApiServer.ts:47`).
- The route handler reads it and hard-fails when absent (`src/services/LocalApiServer.ts:1322-1325`):
  ```ts
  const moveCard = this._options.moveCard;
  if (!moveCard) {
      res.end(JSON.stringify({ error: 'Kanban move not available' }));
  ```
- `src/standalone/bootstrap.ts` **never passes `moveCard`** in the options object it constructs the server with. The only `moveCard`-adjacent references in that file are outbound `server.broadcastWs('moveCards', …)` pushes at `:964`, `:996`, `:1020` and `:1465` — those are UI notifications after a verb-driven move, not the endpoint's implementation.

So in standalone the endpoint answers every request with `{"error":"Kanban move not available"}`. In the extension host it is wired and works. This is a genuine host divergence on a documented surface.

**Why it went unnoticed for so long:** moving a card *does* work in standalone through the verb rail — `promptSelected`, `completeSelected` and friends all reach `KanbanProvider` through the `kanbanVerb` `default:` arm and land their writes. Anyone checking "can standalone move a card?" gets a yes. The dedicated documented HTTP endpoint is the only thing that is dead, and it is the path an external tool follows, not the path a human clicking the board follows. The optional-callback shape is what allows the divergence to exist silently: an omitted option is a valid construction, so nothing fails at boot, at compile time, or in any test.

**Blast radius.** Every consumer that follows the documented contract: the `switchboard-orchestration` skill's move flow, `move-card.js`, the orchestrator persona (whose sanctioned move path is explicitly `POST /kanban/move`, never SQL), and any third-party agent that read the docs. All of them silently lose the ability to move a card the moment the board is served by `npx switchboard` instead of the editor.

## User Review Required

None.

## Complexity Audit

### Routine

- Passing an existing callback through an options object.

### Complex / Risky

- **`moveCard`'s contract must match the extension's.** The extension's implementation is the reference; the standalone one must accept the same `(workspaceRoot, key, targetColumn, planFile)` signature (`LocalApiServer.ts:1349`) and apply the same column resolution and validation, or the endpoint will "work" while writing the wrong column. Reuse the extension's path rather than hand-writing a second mover — a hand-written duplicate here is how the next divergence gets created.
- **No agent fire.** The documented distinction between `/kanban/move` and `/kanban/dispatch` is precisely that move must **not** fire an agent. Whatever is wired must not route through the dispatch path.
- **The optional-option shape is the actual defect class.** Fixing this one callback leaves every other optional `LocalApiServer` option able to fail the same way. The guard below is the part of this plan that has lasting value.

## Edge-Case & Dependency Audit

**Race Conditions** — a move triggers `schedulePushFullState()` coalescing (`bootstrap.ts`, `PUSH_COALESCE_MS = 40`). The move must land before the coalesced push reads state, which the existing trailing-edge chain already guarantees. No new race.

**Security** — the endpoint is already behind the standalone session-cookie auth and `Host`-header guard. No change.

**Side Effects** — moving a card writes to `kanban.db` and emits a `moveCards` broadcast. Both are existing behaviour on the verb path.

**Dependencies & Conflicts** — related to but distinct from `standalone-kanban-column-parity-audit.md`, which owns *which column* an advance resolves to (`getNextKanbanColumn`). This plan owns *whether the endpoint functions at all*. Land them independently; neither blocks the other.

## Dependencies

None.

## Implementation

1. In `src/standalone/bootstrap.ts`, pass a `moveCard` implementation in the `LocalApiServer` options, delegating to the same provider path the extension host uses rather than reimplementing the move.
2. Confirm the callback signature matches `LocalApiServer.ts:1349`'s call site exactly.
3. Confirm the move does **not** fire an agent — `/kanban/move` and `/kanban/dispatch` must remain distinguishable.
4. Add a guard that enumerates the documented endpoint surface and fails when an endpoint is routable in one host and returns a not-available error in the other. This is the durable half of the plan: it converts "a callback was forgotten" from an invisible runtime divergence into a build-time number.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Context:** Constructs `LocalApiServer` without `moveCard`.
- **Logic:** Supply `moveCard`, delegating to the shared provider move path.
- **Edge Cases:** Signature drift from `LocalApiServer.ts:1349`; accidentally routing through dispatch and firing an agent.

### Endpoint-parity guard (new)
- **Context:** No check exists that a documented endpoint is live in both hosts.
- **Logic:** Assert every documented endpoint is wired in both composition roots; fail on any that is reachable-but-unavailable.
- **Edge Cases:** Endpoints that are legitimately editor-only need an explicit allowlist entry with a stated reason, so the exemption is visible rather than implicit.

## Verification Plan

1. `POST /kanban/move` against a standalone host moves the named card to the target column, and the move survives a re-read of `/kanban/board`.
2. The response is not `{"error":"Kanban move not available"}` under any workspace configuration.
3. No agent is dispatched by the move — terminal state is unchanged.
4. The same request against an extension-hosted server produces the same result, confirming parity rather than a second implementation.
5. The new endpoint-parity guard fails when `moveCard` is removed again, and passes with it wired.
6. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD, unrelated).

## Recommendation

Complexity 3 → **Send to Coder.** The wiring is a few lines; the guard is what stops the next optional callback from going missing the same way.
