# Standalone Board Sends an Empty Routing Config — Dynamic Complexity Routing Is Dead in the Browser

## Metadata

**Complexity:** 3
**Tags:** bug, backend, standalone, parity
**Project:** Browser Switchboard

## Goal

The standalone/browser host sends `routingConfig: {}` on every board update, so dynamic complexity routing has no configuration to act on and its UI cannot reflect the workspace's real settings. Send the live routing map, as the extension does.

### Problem analysis and root cause

Both standalone state builders emit an empty object literal:

- `pushFullState` — `src/standalone/bootstrap.ts:345`
- `getFullState` — `src/standalone/bootstrap.ts:374`

```typescript
{ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: false, routingConfig: {}, featureWorktrees, surface: SURFACES.kanban }
```

The extension resolves it per scope (`src/services/KanbanProvider.ts:1140`, sent at `:1171`):

```typescript
const routingConfig = this._routingMapForScope(scope);
```

and refreshes it from three further sites (`:2027`, `:3550`, `:3730`).

The board renders a complexity-routing toggle on the Planned column (`src/webview/kanban.html:5521-5525`) whose tooltip promises "auto-routes by score (low→Coder, high→Lead)". In standalone that toggle is driven by an empty map.

**Why this looked wired.** `toggleDynamicComplexityRouting` and `updateRoutingConfig` are both in `KANBAN_VERBS` and reach the provider through the `default:` arm's delegation (`bootstrap.ts:1062-1087`), so they execute, persist and return `{ success: true }`. The board then receives the empty literal on the next coalesced push (`bootstrap.ts:1078`) and the toggle reverts. `dynamicComplexityRoutingState` — the message the provider posts to confirm the change — is one of the types discarded because `KanbanProvider.postMessage` has no sink in standalone (`KanbanProvider.ts:2105-2120`).

One instance of the hardcoded-payload class described in `standalone-push-parity-guard.md`.

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing two literals with a call to the existing resolver.

### Complex / Risky
- **Scope argument.** `_routingMapForScope(scope)` takes a scope. Standalone serves a single workspace root; pass the equivalent scope the extension would use for that root rather than inventing a value, or the map resolves against the wrong key and returns empty — reproducing the bug with more code.
- **Both builders.** Fixing one leaves the bug on the other path.
- **The toggle only becomes observable once pushes are bridged.** The confirming `dynamicComplexityRoutingState` message needs `restore-backlog-view-to-standalone-host.md`'s broadcaster bridge to reach the browser. Without it the payload is correct but the immediate toggle feedback still relies on the ~40 ms coalesced board push. Acceptable, but state it in verification rather than discovering it during UAT.

## Edge-Case & Dependency Audit

**Race Conditions** — the post-verb coalesced push (`bootstrap.ts:395`) becomes the delivery mechanism instead of the reverting one.

**Security** — none; reads existing workspace configuration.

**Side Effects**
- Routing becomes active in standalone for workspaces that have it configured. Cards dispatched from the browser board may now land in a different coder column than before — correct behaviour, but a behavioural change for existing browser users. Note in release notes.

**Dependencies & Conflicts**
- Touches the same two payload lines as the backlog and CLI-triggers plans; expect merge conflicts if developed in parallel.

## Dependencies

- None (hard). Sequencing: after `standalone-push-parity-guard.md`; ideally after the broadcaster bridge for full UI feedback.

## Implementation

**File:** `src/standalone/bootstrap.ts`

- Replace `routingConfig: {}` at `:345` and `:374` with the live map resolved through the provider's existing `_routingMapForScope` path (exposed publicly if it is not already), using the scope corresponding to the served workspace root.

**File:** `src/services/KanbanProvider.ts`

- Expose the resolver if required. Do not reimplement the map in standalone.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Logic:** Live routing map in both builders.
- **Edge Cases:** Correct scope value; both builders.

### `src/services/KanbanProvider.ts`
- **Logic:** Public access to the existing resolver.

## Verification Plan

### Automated
- Test: `getFullState()`'s `updateBoard.routingConfig` reflects configured routing rather than `{}`.
- Guard: `standalone-parity:check` hardcoded-field baseline drops by one.

### Manual (standalone host)
1. Configure complexity routing in the editor; reload the browser board — the toggle reflects the real state.
2. Toggle it from the browser — the state persists across a reload rather than reverting after ~40 ms.
3. Dispatch a low-complexity plan with routing on — it lands in the Coder column, not Lead.
4. Dispatch with routing off — all cards land in Lead Coder.
5. Extension unaffected.

## Recommendation

Complexity 3 → **Send to Coder.** Small and well-bounded; the only real trap is passing the wrong scope.
