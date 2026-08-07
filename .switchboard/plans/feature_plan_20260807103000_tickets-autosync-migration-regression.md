# Tickets Auto-Sync Lost in the Panel Extraction — Migration Regression

## Goal

Restore tickets auto-sync for users who enabled it in a shipped version. The Tickets
panel extraction moved the tickets UI into `TicketsPanelProvider` but left the auto-sync
engine behind in `PlanningPanelProvider`, and separately deleted the only control that
could write the setting. Users who ticked "auto-sync" in a released build still have
`ticketsAutoSync: true` on disk and still have the engine running — in a provider that is
being emptied out — with no way to see it, change it, or turn it off.

### Problem & Background

This is a **shipped-state regression**, not a missing feature. The distinction matters
under the repo's migration rule (~4,000 installs, many on much older versions): state that
exists in a released version must be migrated, not silently orphaned.

**There was a real, working, shipped writer.** At commit `a906a3eb` (2026-06-17):

- `src/webview/setup.html:661` and `:815` — a `.tickets-auto-sync-toggle` checkbox
- `setup.html:3265-3272` — its `change` handler posts `{ type: 'saveTicketsAutoSync', enabled }`
- `SetupPanelProvider.ts:1125-1132` — the handler calls
  `localService.setTicketsAutoSync(message.enabled === true)`
- `LocalFolderService.ts:917-919` — writes `ticketsAutoSync` into the **per-folder config
  file on disk**

That is persisted user state written by a control the user could see and click. It was not
a stub.

**The read path still works, today.** For a user whose folder config carries
`ticketsAutoSync: true`:

1. `LocalFolderService.ts:139` / `:202` parse it back as `true`
2. `LocalFolderService.ts:913-915` — `getTicketsAutoSync()` returns `true`
3. `PlanningPanelProvider.ts:2154-2166` — `_getTicketsAutoSync()` finds the **global**
   value `undefined`, falls back to the local value, sees `true`, **promotes it to the
   global config** via `GlobalIntegrationConfigService.setTicketsAutoSync(true)`, returns `true`
4. `PlanningPanelProvider.ts:2627-2628` — arms `_updateTicketsAutoSyncWatcher(root, true)`
   on every Project/Planning panel open

So the 45-second delta-pull timer and the auto-push file watcher
(`PlanningPanelProvider.ts:7139-7307`) are **live right now** on those installs.

### Root Cause

Three independent losses, which together make the setting invisible, unchangeable, and
homeless:

**1. The writer was deleted without a replacement.** `saveTicketsAutoSync` exists in
neither `src/generated/verbAllowlist.ts` nor any provider switch at HEAD — verified by
grep (0 allowlist entries, 0 handlers). `LocalFolderService.setTicketsAutoSync`
(`ts:917`) now has **zero callers**. The setting can no longer be turned on *or off* by
any user, in any host.

**2. The engine did not move with the panel.** The extraction ported the display watcher
(`_setupTicketsViewWatcher`) into `TicketsPanelProvider` but not the auto-sync system.
`TicketsPanelProvider` has none of the five `_ticketsAutoSync*` state Maps, no
`_getTicketsAutoSync()`, and no `_updateTicketsAutoSyncWatcher()`. `getTicketsAutoSync` is
read at exactly one site repo-wide — `PlanningPanelProvider.ts:2158` — a provider whose
tickets tab is being retired.

**3. Planning's own delta-pull is already half-dead.** `PlanningPanelProvider`'s
`_ticketsCurrentSelection` map is declared (`ts:283`), read by the timer (`ts:7230`), and
cleared on dispose (`ts:7385`) — but **never written**. The setter moved to
`TicketsPanelProvider` (`ts:1455`, `ts:2978`) with the extraction. So on an affected
install today the *pull* half already no-ops (the timer fires and returns early at the
selection guard), while the *push* half still fires on every local `.md` edit. Users who
enabled auto-sync are getting silent background writes to ClickUp/Linear with no reads —
the worst of both halves.

### Why prior review passes missed this

Recorded so the next audit does not repeat it. Every review of the extraction asked
**"was the code ported?"** — a structural question that a diff answers. None asked
**"is the user's persisted on-disk state still read and still writable?"** A structural
review passes cleanly while a shipped setting quietly stops being reachable, because
nothing is missing from the new file — the state simply has no writer and its reader lives
in the old one.

The reproducible check that finds this class:

```
# For each shipped setting, all three must have a home:
#   1. a writer (a verb/handler the user can reach)
#   2. a reader (something that acts on the value)
#   3. the on-disk key (still parsed, not dropped)
# An orphan is any setting where the writer's verb resolves to 0 handlers
# while the reader still exists.
```

**Sweep result (2026-08-07).** Diffing `SetupPanelProvider`'s verb surface between
`a906a3eb` and HEAD found 13 removed verbs. Of those: 9 relocated cleanly into
`TICKETS_VERBS` (`applyClickUpConfig`, `applyLinearConfig`, `browseTicketsFolder`,
`linearBrowseProjects`, `listTicketsFolders`, `saveClickUpAutomation`,
`saveClickUpMappings`, `saveLinearAutomation`, `saveTicketsFolder`); 3 were removed on
**both** sides — setter and reader together, which is a correct removal
(`preventAgentFileOpening`, `statusShowAgentOpen`, `planningPanelSyncMode` have no
remaining references anywhere); and `globalSettingsEnabled` has an explicit migration at
`TaskViewerProvider.ts:1335-1361` that reads the old flag and clears it.

**`ticketsAutoSync` is the only orphan of its class.** This plan is the whole remainder —
no further sweep is owed.

## Metadata

**Complexity:** 7
**Tags:** backend, frontend, bugfix, reliability, ui

**Project:** Browser Switchboard

## User Review Required

- None. The three decisions are made below: the setting is **preserved, never reset**;
  the system is **moved** out of `PlanningPanelProvider`, not copied; and the restored
  toggle reflects existing on-disk state rather than defaulting everyone to OFF.

## Complexity Audit

### Routine

- Moving the five `_ticketsAutoSync*` state Maps and `_getTicketsAutoSync()` — verbatim,
  no adaptation needed. All dependencies already exist on `TicketsPanelProvider`:
  `HostWatchHandle` (`ts:1`), `path` (`ts:6`), `fs` (`ts:7`),
  `GlobalIntegrationConfigService` (`ts:15`), `_getLocalFolderService` (`ts:566`),
  `_seams()` (`ts:556`), `_adapterFactories.getCacheService` (`ts:325`),
  `_ticketsCurrentSelection` (`ts:56`), `postMessageToWebview` (`ts:175`).
- Dispose cleanup — same shape as `PlanningPanelProvider.dispose()` (`ts:7374-7386`).
- Restoring the toggle markup and its change handler.

### Complex / Risky

- **This is shipped-state migration, and the value must survive.** The user's on-disk
  `ticketsAutoSync: true` must keep working end-to-end after the move. Do **not** reset it,
  do **not** default it to `false` for existing installs, and do **not** drop the
  local→global promotion branch in `_getTicketsAutoSync` (`PlanningPanelProvider.ts:2156-2164`)
  — that branch is the migration for users who never got the global write.
- **Double-write window.** `PlanningPanelProvider` still arms its watcher from `fetchRoots`
  (`ts:2627-2628`) on every Project panel open. If `TicketsPanelProvider` gains a copy
  before Planning's is deleted, affected users get **two** `.md` folder watchers and two
  `switchboard.pushTicketEdits` calls per local edit. Move and delete must land in the
  same change, not sequentially.
- **Deleting from a shipped provider.** `PlanningPanelProvider` is on ~4,000 installs
  (PRD contract #2). The deletion is observably behaviour-preserving *only* once
  `TicketsPanelProvider` owns the same behaviour — so it is not independently safe.
- **New verb surface.** `setTicketsAutoSync` must **return** in-body (PRD contract #4),
  carry a permissive field-accurate schema (contract #5), and regenerate the catalog. The
  Tickets `break` ceiling (**56**, `scripts/verb-return-contract-baseline.json`) must not
  rise.

## Edge-Case & Dependency Audit

### Race Conditions

- **Both panels open during the transition.** With the move and the delete in one change
  there is no window where both providers arm a watcher. Verify explicitly (see
  Verification step 4) — this is the failure this plan exists to prevent.
- **Toggle flipped while a poll is in flight.** Tearing down cannot cancel an awaited
  `executeCommand`; one trailing silent refresh after disabling is acceptable and should
  not be "fixed" with extra state.
- **Watcher idempotence.** `_updateTicketsAutoSyncWatcher`'s `if (existing) { return; }`
  guard (`PlanningPanelProvider.ts:7157`) is what makes arming from several hooks safe.
  Preserve it verbatim.

### Security

- No new external endpoints or secrets. The new verb is reachable over the LocalApiServer
  HTTP boundary in both hosts, so coerce with `msg.enabled === true`, never truthiness.

### Side Effects

- **For affected users, behaviour visibly changes on upgrade** — from "silent pushes, no
  pulls" (the current half-dead state) to a working bidirectional sync they can finally
  see and control. That is the fix, but it is a behaviour change on an existing install
  and should be treated as one.
- Auto-sync pushes local `.md` edits to the provider. The restored toggle's label must say
  so — the user is opting into remote **writes**, not just reads.

### Dependencies & Conflicts

- **Sibling plan:** `feature_plan_20260806153624` (Tickets tab local `.md` refresh) fixes a
  *different* bug — the local file watcher not refreshing the sidebar — in the same two
  files. That plan needs no API access; this one is entirely about the remote sync engine.
  **Serialise them**; they collide in `TicketsPanelProvider.ts` and `tickets.js`.
- `verbSchemas.ts` is shared across all provider work — serialise the edit.
- **Standalone host (PRD contract #7, Layer 2):** `bootstrap.ts` already constructs
  `TicketsPanelProvider` (`ts:636`) and wires `ticketsVerb` (`ts:1557`), so the new verb is
  reachable over `npx` with no bootstrap change. Note the timers then live for the life of
  the server process rather than a panel.
- **Gates:** `npm run catalog:generate` (new verb), then `catalog:check`, `parity:check`,
  `verb-returns:check` (Tickets ≤ 56), `push-routing:check`.

## Dependencies

- None. No prior session work is required; no `sess_*` prerequisites.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is treating this as a feature port rather than a state
migration: a correct-looking implementation that defaults everyone to OFF, or that drops
the local→global promotion branch, silently discards a setting real users deliberately
enabled — the exact failure this plan exists to correct, repeated. The second risk is
sequencing: moving the engine into `TicketsPanelProvider` before deleting
`PlanningPanelProvider`'s copy gives affected users two auto-push watchers and two API
writes per local edit, so move-and-delete must land together. Mitigations: preserve the
on-disk value end-to-end and assert it in UAT with a pre-seeded config; keep the promotion
branch; land the move and the delete in one change; and verify the exactly-one-push case
with both panels open.

## Proposed Changes

### File 1: `src/services/TicketsPanelProvider.ts` — take ownership

1. **State Maps** — add the five `_ticketsAutoSync*` fields after `_ticketsCurrentSelection`
   (`ts:56`), moved from `PlanningPanelProvider.ts:267-279`.
2. **`_getTicketsAutoSync()`** — move `PlanningPanelProvider.ts:2154-2166` verbatim into
   the block already labelled *"2b infrastructure: host seams, local folder service,
   auto-sync"* (`ts:554`). **Keep the `globalConfig.ticketsAutoSync === undefined` branch
   exactly as-is** — it is the migration path for installs that only ever wrote the
   per-folder value.
3. **`_updateTicketsAutoSyncWatcher()`** — move `PlanningPanelProvider.ts:7139-7307`
   verbatim; change only the log prefix to `[TicketsPanel]`.
4. **Arm it from handlers that actually run.** `TicketsPanelProvider` has no
   `fetchRootsComplete` case, and its `ticketsRootChanged` arm (`ts:1411-1447`) is dead —
   `tickets.js` never sends that verb (only `planning.js:4218`/`:4230` do, routed to
   `PlanningPanelProvider`). Arm from the live entry points instead:
   - `setupTicketsWatcher` (`ts:1366-1370`)
   - `ticketsDefaultRoot` (`ts:1371-1409`), before the reply push
   - `refreshTicketsDelta` (`ts:1455`) and `importAllTickets` (`ts:2978`), immediately
     after `_ticketsCurrentSelection.set(...)` — the timer's precondition
   - `switchTicketsProvider` (`ts:832-853`), plus add `ticketsAutoSync` to the pushed
     `integrationProviderStates`

   All are safe to call repeatedly thanks to the idempotence guard.
5. **`setTicketsAutoSync` verb** — the restored writer, returning in-body:

```typescript
case 'setTicketsAutoSync': {
    const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
    const enabled = msg.enabled === true;
    await GlobalIntegrationConfigService.setTicketsAutoSync(enabled);
    // Keep the per-folder value in step so a downgrade to an older build still
    // sees the user's choice — the folder config is what shipped versions read.
    if (root) { await this._getLocalFolderService(root).setTicketsAutoSync(enabled); }
    if (root) { this._updateTicketsAutoSyncWatcher(root, enabled); }
    this._pushTo(targetPanel, 'tickets', { type: 'ticketsAutoSyncChanged', ticketsAutoSync: enabled });
    return { success: true, ticketsAutoSync: enabled };
}
```

   **Edge case:** writing *both* the global and the per-folder value is deliberate. A user
   who rolls back to an older VSIX must still find their setting where that build looks for
   it. This also gives `LocalFolderService.setTicketsAutoSync` a caller again.
6. **Dispose cleanup** — in `dispose()` (`ts:3556-3571`), between the
   `_ticketsViewWatcherDebounces.clear()` (`ts:3562`) and the panel disposal (`ts:3563`):
   dispose the watchers, `clearTimeout` the debounces, `clearInterval` the timers, and
   clear the failure / next-eligible maps.

### File 2: `src/services/PlanningPanelProvider.ts` — remove, in the same change

Delete: the five field declarations (`ts:267-279`); `_getTicketsAutoSync()`
(`ts:2154-2166`); `_updateTicketsAutoSyncWatcher()` (`ts:7139-7307`); the arming call and
flag in the `fetchRoots` arm (`ts:2605`, `ts:2627-2629`); the auto-sync block in
`dispose()` (`ts:7374-7386`) including `_ticketsCurrentSelection.clear()` (`ts:7385`) and
the orphaned `_ticketsCurrentSelection` field (`ts:283`); and the unread
`let ticketsAutoSync = false;` at `src/webview/planning.js:189`.

**Sequencing is not optional.** This deletion and File 1 land together. Shipping File 1
alone gives affected users two live auto-push watchers.

### File 3: `src/services/verbSchemas.ts`

Append to the Tickets block (near the existing `ticketsRootChanged` entry at `ts:944`),
matching the exact entry shape used by its neighbours:

```typescript
setTicketsAutoSync: {
    enabled: { type: 'boolean', required: true },
    workspaceRoot: { type: 'string', required: false }
},
```

### File 4: `src/generated/verbAllowlist.ts` + `protocol-catalog.json`

Do not hand-edit. Run `npm run catalog:generate`; confirm `setTicketsAutoSync` lands in
`TICKETS_VERBS`. `src/test/browser-panel-verb-routing.test.js:150` enumerates tickets verbs
and likely needs the new name added.

### File 5: `src/webview/tickets.html` — restore the control

Add to the controls-strip overflow popover (`tickets.html:3968-3972`), as a menu item
rather than a strip button — this is a mode switch, not an action:

```html
<label class="strip-btn overflow-menu-item" style="display:flex; align-items:center; gap:6px; cursor:pointer;"
       title="Poll the provider every 45s for remote changes, and push local ticket edits back automatically">
    <input id="tickets-auto-sync-toggle" type="checkbox" style="width:auto; margin:0;">
    Auto-sync with provider
</label>
```

**Edge case:** the label must state that auto-sync also **pushes** local edits.

### File 6: `src/webview/tickets.js` — wire the toggle

- `getTicketsTabElements()` (`ts:273-324`): add
  `ticketsAutoSyncToggle: document.getElementById('tickets-auto-sync-toggle'),`
- `initTicketsTab`: on `change`, post
  `{ type: 'setTicketsAutoSync', enabled: e.target.checked, workspaceRoot: ticketsWorkspaceRoot || undefined }`
- `integrationProviderStates` arm (`ts:6662`): set the checkbox from
  `message.ticketsAutoSync === true` so an existing enabled install shows it **already
  ticked** on first open after upgrade
- add a `ticketsAutoSyncChanged` arm that re-asserts the checkbox, keeping two open
  surfaces (editor panel and browser tab) in agreement

**No other frontend work.** The `importAllTicketsComplete` arm (`ts:7548-7575`) already
handles `autoSync: true` — suppressing the toast at `ts:7560` and refreshing via
`loadLocalTicketFiles()` at `ts:7573`.

## Out of Scope

- **Rate-limit hardening.** The inherited engine's backoff never reads `Retry-After` /
  `X-RateLimit-Reset` (`PlanningPanelProvider.ts:7296`, `:7302`), and its auto-push
  debounce is keyed per file path (`ts:7176`) so a bulk file change fires one push per
  file at once. Both are pre-existing behaviour in code this plan only *relocates*.
  Recorded, not fixed here. Separate plan if wanted.
- **Poll cadence.** 45s stays as-is.
- **The local `.md` sidebar-refresh bug.** Covered by `feature_plan_20260806153624`.

## Verification Plan

### Manual verification

1. **The regression reproduces before the fix** *(do this first — it defines "affected")*:
   - Inspect the folder config for `ticketsAutoSync`. If absent, seed `true` by hand to
     simulate a user who enabled it in a shipped build.
   - Open the Project/Planning panel and confirm the auto-push watcher arms
     (`PlanningPanelProvider.ts:2627-2628` reached with `enabled === true`).
   - Confirm the *pull* half no-ops — the timer fires and returns at the
     `_ticketsCurrentSelection` guard (`ts:7230-7231`), because that map is never written
     in Planning.

2. **The setting survives the migration** *(the core assertion)*:
   - With `ticketsAutoSync: true` pre-seeded on disk, install the change and open the
     Tickets panel.
   - The toggle shows **already ticked**. The user is not silently reset to OFF.
   - Auto-sync works end-to-end: change a ticket in the provider's web UI, and within ~45s
     the sidebar updates with no click and no toast.

3. **A fresh install is unaffected:**
   - With no `ticketsAutoSync` key on disk, the toggle is unticked and no polling occurs.

4. **Exactly one push, both panels open** *(the double-write regression this plan
   prevents)*:
   - With auto-sync ON, open **both** the Project/Planning panel and the Tickets panel.
   - Edit a local ticket `.md` and save.
   - Confirm exactly **one** `switchboard.pushTicketEdits` call and one remote write.

5. **The toggle works in both directions, without a reload:**
   - Flip OFF → polling stops. Flip ON → first poll within 45s.
   - Confirm the value lands in **both** the global config and the per-folder config.

6. **Provider switch and disposal:**
   - Switch ClickUp ↔ Linear with auto-sync ON — the next tick polls the new provider, no
     calls to the old.
   - Close the panel — no `setInterval` callbacks continue. Reopen — auto-sync resumes
     from the persisted state.

7. **Both hosts:** repeat steps 2 and 5 over `npx switchboard`.

8. **Planning panel is clean:** with the auto-sync system deleted, the Project/Planning
   panel opens normally and its `integrationProviderStates` no longer carries a
   `ticketsAutoSync` field.

### Automated Tests

Not run in this pass (SKIP TESTS / SKIP COMPILATION session directives). For the
implementer:

- `tsc --noEmit` (**not** `npm run compile` — `dist/` is unused in dev/test).
- `npm run catalog:generate` → `catalog:check`, `parity:check`, `verb-returns:check`
  (Tickets ≤ 56), `push-routing:check`.
- `PlanningPanelProvider`'s per-provider tests must pass unchanged (PRD contract #2).
- `src/test/browser-panel-verb-routing.test.js` — add `setTicketsAutoSync`.
- **Highest-value new test — a regression guard for this exact bug class:** assert that a
  `LocalFolderService` config containing `ticketsAutoSync: true` still resolves to `true`
  through `TicketsPanelProvider._getTicketsAutoSync()`. That single assertion pins the
  migration and fails loudly if a future refactor orphans the setting again.

## Recommendation

**Send to Lead Coder** (Complexity 7).
