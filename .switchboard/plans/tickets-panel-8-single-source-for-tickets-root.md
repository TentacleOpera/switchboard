# Give `tickets.root` a single source of truth: wire the host push, then drop the local mirror

## Goal

Make the host-side panel state store the sole authority for the Tickets panel's remembered workspace root. Wire `TicketsPanelProvider` to push `restoredTabState`, then remove the webview-local `vscode.setState` mirror that currently shadows it. **Order matters and is the whole point of this plan** — reversed, it regresses persistence.

### Problem and background

Slice 2a needed the Tickets panel to remember its workspace root across a reload. The host-side path — `persistTab('tickets.root', …)` posting `persistTabState`, then the host pushing `restoredTabState` back — was only half-built: the write worked, the read-back was never wired. So 2a added a deliberate, documented bridge: mirror the value into the webview-local `vscode.setState` blob and read it first on load.

That bridge is still the **only working** across-reload path:

| | State |
|---|---|
| `TicketsPanelProvider` pushes `restoredTabState` | **0 times** |
| `PlanningPanelProvider` pushes it | 3 times (the pattern to copy) |
| `tickets.js` local mirror | `persistTicketsRoot()` `:380`, writes at `:385`, local-first read at `:7632` |
| `tickets.js` `restoredTabState` arm | present at `:6415` — currently dead, nothing pushes to it |

So `tickets.js` writes the value to two stores and reads the local one first. The `restoredTabState` arm only overrides when `ticketsWorkspaceRoot` is still empty, which after the local read it never is.

### Root cause

The host push was scheduled for "a later slice" and no slice claimed it. Slice 2f was supposed to resolve the dual-write but could not, because removing the mirror without first wiring the push would have deleted the only functioning persistence path. The dependency was one-directional and nobody sequenced it.

### Why it matters now

Slice 2f added a one-time migration (`TicketsPanelProvider._migrateTicketsRootFromPlanning()`) that carries the legacy `tickets.root` across from the *planning* panel's store so existing installs keep their selection. That migration writes to the **host** store. With the local blob winning on load, a stale local value will shadow the correctly-migrated one and the migration will look like it silently no-opped — which is exactly the failure mode the migration exists to prevent.

## Metadata

**Tags:** bugfix, frontend, backend, state

**Complexity:** 4

## Approach — strictly in this order

1. **Wire the host push.** Give `TicketsPanelProvider` a `restoredTabState` push, copying `PlanningPanelProvider`'s three existing sites. Note the shape `tickets.js:6415` already expects: `{ type: 'restoredTabState', panel, byRoot }`, where `panel` and `byRoot` come from `PanelStateStore.getAllStates(tabKeys, roots)`. Include at minimum `tickets` and `tickets.root` in `tabKeys`.

2. **Prove the host path works on its own** before deleting anything. Temporarily disable the local read at `tickets.js:7632`, confirm the root still survives a reload in both hosts, then re-enable it. If the root does not survive with the local read disabled, the push is not correctly wired and step 3 must not proceed.

3. **Remove the mirror.** Delete the `vscode.setState` write inside `persistTicketsRoot()` (`:385`) and the local-first read (`:7632–7633`). Keep `persistTab('tickets.root', …)` — that is the surviving write. Update the comments at `:375`, `:383` and `:7629–7631`, which currently describe the bridge as intentional and temporary; leaving them makes the next reader think the mirror is still there.

4. **Confirm the migration is no longer shadowed.** With the mirror gone, `_migrateTicketsRootFromPlanning()`'s value is the only candidate on a fresh upgrade.

### Do not

- Do **not** remove the mirror before step 2 passes. That is the one sequencing mistake this plan exists to prevent, and it silently resets every user's ticket workspace selection on reload.
- Do **not** touch `PlanningPanelProvider`'s three `restoredTabState` sites — the Artifacts panel's own tab state depends on them.
- Do **not** change the `tickets.root.migrated` marker semantics. It is deliberately write-once so a user who clears their selection is never re-seeded from the stale planning value.

## Verification Plan

### Automated

- `node --check src/webview/tickets.js`, `npm run compile-tests`, `npm run lint` (only `terminals.js:1013` is acceptable, and belongs to the Terminals feature).
- `npm run catalog:generate` then `npm run catalog:check` — run the regen last; removing a post site changes the catalog.
- `npm run parity:check`, `npm run push-routing:check` (`TicketsPanelProvider.ts` must stay at its ceiling — a `restoredTabState` push must go through `_pushTo`, **not** a raw `webview.postMessage`), `npm run verb-returns:check`, `npm run icons:parity`, `npm run mirror:check`.
- `npm run test:contract:panel-revival-retention` — this is the suite that covers the revival path the mirror was compensating for. It must stay green.
- `npm run test:contract:verb-engine-tickets`, `test:contract:tickets-sidebar-scoping`, `test:contract:tickets-assignee-filter`.
- Verify by exit code, not by matching output text.

### Manual

The whole plan is a persistence change, so the manual checks are the real gate:

- **Editor host:** select a non-default workspace root in the Tickets panel, reload the window, confirm the selection survives. Repeat with the panel closed and reopened rather than reloaded.
- **Standalone host:** same at `/tickets`. The two hosts seed webview state through different code (`injectInitialWebviewState` + the `sb-initial-state` meta vs `transport.js`'s `vscode` shim), so passing in one proves nothing about the other.
- **Migration check, the highest-value one:** on an install that has a `tickets.root` under the *planning* store and no tickets-store value, upgrade and confirm the Tickets panel opens on the carried-over root. Then confirm the `tickets.root.migrated` marker means a second launch does not re-seed.
- **Clear-selection check:** deliberately clear the root selection, reload, and confirm it stays cleared rather than being re-seeded from the legacy planning value.
- Confirm the Artifacts panel's own tab state still restores — it shares the `restoredTabState` mechanism.
