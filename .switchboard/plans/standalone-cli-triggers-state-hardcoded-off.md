# Standalone Board Reports CLI Triggers Permanently Off

## Metadata

**Complexity:** 2
**Tags:** bug, backend, standalone, parity
**Project:** Browser Switchboard

## Goal

The standalone/browser host tells the board that CLI triggers are disabled on every update, regardless of the workspace's actual setting. Send the live value.

### Problem analysis and root cause

Both standalone state builders emit a literal:

- `pushFullState` — `src/standalone/bootstrap.ts:342`
- `getFullState` — `src/standalone/bootstrap.ts:371`

```typescript
{ type: 'cliTriggersState', enabled: false, surface: SURFACES.kanban }
```

The extension sends the resolved value (`src/services/KanbanProvider.ts:1170`, with further refresh sites at `:2039`, `:3554`, `:3733`):

```typescript
{ type: 'cliTriggersState', enabled: cliEnabled, surface: SURFACES.kanban }
```

**Why this looked wired.** `toggleCliTriggers` is in `KANBAN_VERBS` and reaches the provider via the `default:` arm (`bootstrap.ts:1062-1087`), so it executes, persists and returns success. The board's toolbar control then reverts on the next coalesced push (`bootstrap.ts:1078`), which re-asserts `false`.

Note the comment at `KanbanProvider.ts:7392` explicitly groups `cliTriggersState` and `updateBoard.routingConfig` as state "rendered against" the board — they are siblings in the same class of defect, described in `standalone-push-parity-guard.md`.

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing two literals with the resolved setting.

### Complex / Risky
- **Both builders must change** — otherwise the value is correct on one path (initial fetch vs. broadcast) and wrong on the other, producing an intermittent bug that looks like a race.
- **Read the same source the extension reads.** Resolve `cliEnabled` through the provider rather than reading a settings key directly in `bootstrap.ts`; a second read path is how the hosts drift.

## Edge-Case & Dependency Audit

**Race Conditions** — none beyond the existing coalesced push.

**Security** — none.

**Side Effects**
- CLI triggers become genuinely active in the standalone host for workspaces that have them enabled. Drag-to-dispatch in the browser may now launch terminal agents where previously it did not. This is the intended behaviour, but it is the first time the browser host will act on that setting — verify the pty capability gate (`ptyReady`) still fails closed when node-pty is unavailable, so enabling the setting cannot produce a dead click.

**Dependencies & Conflicts**
- Adjacent lines to the backlog, routing-config and theme plans; expect merge conflicts if developed in parallel.

## Dependencies

- None (hard). Sequencing: after `standalone-push-parity-guard.md`.

## Implementation

**File:** `src/standalone/bootstrap.ts`

- Replace `enabled: false` at `:342` and `:371` with the live value resolved through the provider's existing path for the served workspace root.

**File:** `src/services/KanbanProvider.ts`

- Expose the resolved value if it is not already reachable. Do not duplicate the settings read.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Logic:** Live `cliTriggersState.enabled` in both builders.
- **Edge Cases:** Both builders; provider-sourced, not a direct settings read.

## Verification Plan

### Automated
- Test: `getFullState()`'s `cliTriggersState` entry reflects the configured setting rather than a constant `false`.
- Guard: `standalone-parity:check` hardcoded-field baseline drops by one.

### Manual (standalone host)
1. Enable CLI triggers in the editor; reload the browser board — the control shows enabled.
2. Toggle from the browser — the state survives a reload rather than reverting.
3. With triggers enabled and node-pty available, drag-dispatch launches a terminal agent.
4. With node-pty unavailable, the affordance fails closed — no dead click.
5. Extension unaffected.

## Recommendation

Complexity 2 → **Send to Coder.** Two-line change plus a provider accessor; the only judgement call is sourcing the value from the provider rather than re-reading the setting.
