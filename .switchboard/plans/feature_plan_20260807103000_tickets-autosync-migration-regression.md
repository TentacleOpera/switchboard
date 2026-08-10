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
  `GlobalIntegrationConfigService` (`ts:15`), `_getLocalFolderService` (`ts:657`),
  `_seams()` (`ts:647`), `_adapterFactories.getCacheService` (`ts:333`),
  `_ticketsCurrentSelection` (`ts:64`), `postMessageToWebview` (`ts:183`),
  `_cacheService` (`ts:63`).
- Dispose cleanup — same shape as `PlanningPanelProvider.dispose()` (`ts:7374-7386`).
- Restoring the toggle markup and its change handler.

> **Superseded:** the `TicketsPanelProvider.ts`, `tickets.js`, `tickets.html` and
> `verbSchemas.ts` line references carried by the previous revision of this plan
> (`ts:566`, `ts:556`, `ts:325`, `ts:56`, `ts:175`, `ts:832-853`, `ts:1366-1370`,
> `ts:1371-1409`, `ts:1411-1447`, `ts:1455`, `ts:2978`, `ts:3556-3571`, `ts:944`,
> `tickets.html:3968-3972`, `tickets.js:6662`, `tickets.js:7548-7575`,
> `bootstrap.ts:636`, `bootstrap.ts:1557`).
> **Reason:** all of them drifted with landed work — `TicketsPanelProvider.ts` by ~+90
> lines, `tickets.js`/`tickets.html` by ~+180, `bootstrap.ts` by ~+80. An implementer
> navigating to the quoted lines lands in unrelated code. Verified against HEAD
> (2026-08-09).
> **Replaced with:** the rebased references used throughout this revision. The
> `PlanningPanelProvider.ts` and `planning.js` references were re-checked and are
> **accurate as written** — only the other four files needed rebasing.

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
- **The Tickets panel has no initial-state handshake for this value.** Unlike the Project
  panel — whose `fetchRoots` arm pushes `integrationProviderStates` on every open
  (`PlanningPanelProvider.ts:2630`) — `TicketsPanelProvider` pushes
  `integrationProviderStates` from only two arms: `switchTicketsProvider` (`ts:935`) and
  `ticketsRootChanged` (`ts:1529`, unreachable — see below). Neither runs on a normal
  open. Restoring the toggle without adding a carrier gives an affected user a checkbox
  that renders **unticked while the engine is running** — the same silent-reset failure
  this plan exists to correct. See File 1 step 5 and File 6.

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
- **Broadcast cross-talk between surfaces.** `_pushTo` (`TicketsPanelProvider.ts:177-179`)
  writes to the `BroadcastHub` only — every push lands on *every* connected tickets
  surface. Two panels on different workspace roots therefore both receive
  `ticketsAutoSyncChanged`. Stamp `workspaceRoot` on the push and gate the frontend arm on
  `_isForThisPanel` (`tickets.js:192`), or one root's toggle silently rewrites the other's
  checkbox. This is the same class of defect already recorded in the `_stampReply`
  docstring (`ts:188-199`), where a 3-ticket panel rendered a foreign 67-ticket payload.

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
- **Standalone host (PRD contract #7, Layer 2) — reachable, but the engine is inert.**

> **Superseded:** "`bootstrap.ts` already constructs `TicketsPanelProvider` (`ts:636`) and
> wires `ticketsVerb` (`ts:1557`), so the new verb is reachable over `npx` with no
> bootstrap change. Note the timers then live for the life of the server process rather
> than a panel."
> **Reason:** true about *routing*, wrong about *working* — precisely the
> "reachable-but-empty" state PRD contract #7 names as incomplete. Two independent
> blockers, both verified at HEAD: (1) `bootstrap.ts:713-717` constructs
> `TicketsPanelProvider` with **three** arguments and passes **no `adapterFactories`**, so
> the constructor's default stubs apply and `_adapterFactories.getCacheService(root)`
> **throws** (`TicketsPanelProvider.ts:88`) — the delta timer's first statement after the
> selection guard; (2) `switchboard.pushTicketEdits` and `switchboard.importAllTasks` are
> registered **only** via `vscode.commands.registerCommand` in `extension.ts:2056`/`:2061`
> and are **absent** from the standalone `switchboardCommandRegistry` block
> (`bootstrap.ts:812-840`), so `VscodeHostCommands` falls through to
> `vscodeShim.commands.executeCommand`, which warns `command '…' is not bridged` and
> returns `undefined`. Both auto-sync halves therefore no-op over `npx`.
> **Replaced with:** the verb routes and returns correctly over `npx`
> (`bootstrap.ts:714` constructs the provider, `ts:1687-1688` wires `ticketsVerb`), and
> the setting persists — but **neither the delta pull nor the auto-push runs there**. This
> is *inherited*, not introduced: the manual `refreshTicketsDelta` (`ts:1567`),
> `importAllTickets` (`ts:3077`), `pushTicket` (`ts:2445`) and `syncAllTickets`
> (`ts:3183`) arms are already dead in standalone for the same two reasons. Do **not**
> claim npx parity, and do **not** paper over it inside this plan — passing the adapter
> factories alone buys nothing while the commands stay unbridged (the failure just moves
> from a throw to an `undefined` result, both counted as a failed tick). Recorded in
> *Out of Scope* with the concrete fix, and the standalone UAT step is rewritten to assert
> the honest behaviour rather than a working sync.
- **Gates:** `npm run catalog:generate` (new verb), then `catalog:check`, `parity:check`,
  `verb-returns:check` (Tickets ≤ 56), `push-routing:check`.

## Dependencies

- None. No prior session work is required; no `sess_*` prerequisites.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is treating this as a feature port rather than a state
migration: a correct-looking implementation that defaults everyone to OFF, or that drops
the local→global promotion branch, silently discards a setting real users deliberately
enabled — the exact failure this plan exists to correct, repeated. Its sharpest concrete
form is the **display** half: the Tickets panel has no initial-state handshake, so a
restored toggle wired only to `integrationProviderStates` renders unticked over a running
engine. The second risk is sequencing: moving the engine into `TicketsPanelProvider` before
deleting `PlanningPanelProvider`'s copy gives affected users two auto-push watchers and two
API writes per local edit, so move-and-delete must land together. The third is a false
completion claim: the verb routes over `npx` but the engine cannot run there (no adapter
factories, unbridged commands), so "works in both hosts" is unearned. Mitigations: preserve
the on-disk value end-to-end and assert it in UAT with a pre-seeded config on a *cold*
open; push the value from `setupTicketsWatcher`; keep the promotion branch; land the move
and the delete in one change; verify the exactly-one-push case with both panels open; and
scope standalone honestly rather than claiming parity.

## Proposed Changes

### File 1: `src/services/TicketsPanelProvider.ts` — take ownership

1. **State Maps** — add the five `_ticketsAutoSync*` fields after `_ticketsCurrentSelection`
   (`ts:64`), moved from `PlanningPanelProvider.ts:267-279`.
2. **`_getTicketsAutoSync()`** — move `PlanningPanelProvider.ts:2154-2166` verbatim into
   the 2b infrastructure block that already holds `_seams()` (`ts:647`) and
   `_getLocalFolderService()` (`ts:657`). **Keep the
   `globalConfig.ticketsAutoSync === undefined` branch exactly as-is** — it is the
   migration path for installs that only ever wrote the per-folder value.
3. **`_updateTicketsAutoSyncWatcher()`** — move `PlanningPanelProvider.ts:7139-7307`
   verbatim; change only the log prefix to `[TicketsPanel]`. Both of its internal
   dependencies already resolve on this provider unchanged: `this._cacheService` (`ts:63`)
   and `this._adapterFactories.getCacheService` (used identically at `ts:333`).
4. **Arm it from handlers that actually run.** `TicketsPanelProvider` has no
   `fetchRootsComplete` case, and its `ticketsRootChanged` arm (`ts:1502-1539`) is dead on
   both ends: `tickets.js` never posts that verb, and the only senders
   (`planning.js:4218`/`:4230`) route to `PlanningPanelProvider`, whose case was removed in
   2c (see the comment at `PlanningPanelProvider.ts:2659-2662`). Arm from the live entry
   points instead:
   - `setupTicketsWatcher` (`ts:1457-1461`) — **the only arm guaranteed to run on every
     open**; `tickets.js`'s `ensureTicketsWatcherArmed()` (`ts:4490-4495`) posts it from
     every path that resolves or changes the root
   - `ticketsDefaultRoot` (`ts:1462-1501`), before the reply push. Note this arm does
     **not** run on every open — `restoreTicketsState()` (`tickets.js:4497-4504`) gates it
     on `!lastIntegrationProvider`, so a reopen with a restored provider skips it entirely.
     That is exactly why `setupTicketsWatcher` is the primary carrier and this is the
     secondary one.
   - `refreshTicketsDelta` (`ts:1546`) and `importAllTickets` (`ts:3073`), immediately
     after `_ticketsCurrentSelection.set(...)` — the timer's precondition
   - `switchTicketsProvider` (`ts:923-944`), plus add `ticketsAutoSync` to the pushed
     `integrationProviderStates` (`ts:934-939`)

   All are safe to call repeatedly thanks to the idempotence guard.
5. **Carry the value to the webview on open — this is the migration's visible half.**

> **Superseded:** arming only, with `integrationProviderStates` assumed to deliver the
> value to the checkbox.
> **Reason:** `TicketsPanelProvider` pushes `integrationProviderStates` from exactly two
> arms — `switchTicketsProvider` (`ts:935`) and the dead `ticketsRootChanged` (`ts:1529`).
> Neither fires on a normal panel open, and the live one fires only when the user changes
> the provider dropdown (itself hidden unless *both* ClickUp and Linear are set up,
> `tickets.js:6841-6852`). An affected user would open the panel, see the box **unticked**,
> and conclude auto-sync is off while the engine is pushing their edits — the plan
> re-committing the exact bug it exists to fix, and its own UAT step 2 would fail.
> **Replaced with:** push `ticketsAutoSync` from the arms that actually run on open.
> `setupTicketsWatcher` is the load-bearing one; make it return in-body **and** push, so
> both the HTTP caller and the webview get the state:

```typescript
case 'setupTicketsWatcher': {
    const root = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!root) { return { success: false, error: 'No workspace root resolved' }; }
    this._setupTicketsViewWatcher(root);
    const ticketsAutoSync = await this._getTicketsAutoSync(root);
    this._updateTicketsAutoSyncWatcher(root, ticketsAutoSync);
    const res = { type: 'ticketsAutoSyncChanged', ticketsAutoSync, workspaceRoot: root };
    this._pushTo(targetPanel, 'tickets', res);
    return { ...res, success: true };
}
```

   Add the same `ticketsAutoSync` field to the `ticketsDefaultRoot` reply
   (`ts:1495-1499`) and to `switchTicketsProvider`'s `integrationProviderStates` push
   (`ts:934-939`) so every path that can reach the panel carries it.

   **`workspaceRoot` on the push is not optional.** `_pushTo` (`ts:177-179`) goes through
   the `BroadcastHub` only — every tickets push reaches *every* connected tickets surface
   (editor webview and all browser tabs). See the `_stampReply` docstring at `ts:188-199`:
   an unscoped reply is indistinguishable from the receiving panel's own, and this was
   already observed corrupting a panel's list in 2026-08. A multi-root user with two
   panels on different roots would otherwise see one panel's checkbox flip to the other's
   value.

   **Converting `setupTicketsWatcher` from `break` to `return` lowers the Tickets `break`
   count by one.** That is a ratchet win, not a risk — the ceiling (**56**) is a maximum.
   Leave the baseline alone unless `verb-returns:check` reports a new true residual.
6. **`setTicketsAutoSync` verb** — the restored writer, returning in-body:

```typescript
case 'setTicketsAutoSync': {
    const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
    const enabled = msg.enabled === true;
    await GlobalIntegrationConfigService.setTicketsAutoSync(enabled);
    // Keep the per-folder value in step so a downgrade to an older build still
    // sees the user's choice — the folder config is what shipped versions read.
    if (root) { await this._getLocalFolderService(root).setTicketsAutoSync(enabled); }
    if (root) { this._updateTicketsAutoSyncWatcher(root, enabled); }
    this._pushTo(targetPanel, 'tickets', {
        type: 'ticketsAutoSyncChanged',
        ticketsAutoSync: enabled,
        workspaceRoot: root || undefined
    });
    return { success: true, ticketsAutoSync: enabled };
}
```

   **Edge case:** writing *both* the global and the per-folder value is deliberate. A user
   who rolls back to an older VSIX must still find their setting where that build looks for
   it. This also gives `LocalFolderService.setTicketsAutoSync` (`ts:917`) a caller again —
   it currently has zero.

   **Edge case:** `GlobalIntegrationConfigService.setTicketsAutoSync` is written
   unconditionally, which also *closes* the `=== undefined` migration branch for this
   install. That is correct — once the user has made an explicit choice, the per-folder
   fallback must stop overriding it.
7. **Dispose cleanup** — in `dispose()` (`ts:3651-3668`), between
   `_ticketsViewWatcherFolders = []` (`ts:3659`) and the panel disposal (`ts:3660`):
   dispose the watchers, `clearTimeout` the debounces, `clearInterval` the timers, and
   clear the failure / next-eligible maps. Mirrors `PlanningPanelProvider.dispose()`
   (`ts:7374-7386`) minus the `_ticketsCurrentSelection.clear()`, which
   `TicketsPanelProvider` should also add since it now owns that map's lifetime.

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

Append to `TICKETS_VERB_SCHEMAS` near the existing `ticketsRootChanged` entry (`ts:967`).

> **Superseded:**
> ```typescript
> setTicketsAutoSync: {
>     enabled: { type: 'boolean', required: true },
>     workspaceRoot: { type: 'string', required: false }
> },
> ```
> **Reason:** wrong entry shape — it omits the `fields:` wrapper every neighbour uses
> (`refreshTicketsDelta` `ts:945`, `ticketsRootChanged` `ts:967`, `ticketsDefaultRoot`
> `ts:972`). As written the validator sees no declared fields. It is also stricter than
> contract #5 wants: the arm coerces with `msg.enabled === true`, and neighbours write
> optional fields as a bare `{ type: 'string' }` rather than `required: false`.
> **Replaced with:**

```typescript
setTicketsAutoSync: {
    fields: {
        enabled: { type: 'boolean', required: true },
        workspaceRoot: { type: 'string' },
    },
},
```

### File 4: `src/generated/verbAllowlist.ts` + `protocol-catalog.json`

Do not hand-edit. Run `npm run catalog:generate`
(`generate-protocol-catalog.js --write` + `generate-verb-allowlist.js --write`); confirm
`setTicketsAutoSync` lands in `TICKETS_VERBS` (`verbAllowlist.ts:11`).

> **Superseded:** "`src/test/browser-panel-verb-routing.test.js:150` enumerates tickets
> verbs and likely needs the new name added."
> **Reason:** wrong file location and wrong conclusion. Line 150 is
> `PLANNING_VESTIGIAL_TICKETS` — an exception list for the 13 tickets-family verbs
> **`planning.js`** still posts, nothing to do with this verb. `tickets.js` is checked
> against `TICKETS_VERBS` directly (`ts:161`), which is generated, so the new verb becomes
> reachable the moment `catalog:generate` runs.
> **Replaced with:** no edit to that test is required. It is still a useful gate — if it
> fails on `setTicketsAutoSync`, the catalog was not regenerated.

### File 5: `src/webview/tickets.html` — restore the control

Add to the controls-strip overflow popover (`tickets.html:3988-3991`, alongside
`#tickets-refetch` / `#tickets-sync-all` / `#tickets-agent-api`), as a menu item rather
than a strip button — this is a mode switch, not an action:

```html
<label class="strip-btn overflow-menu-item" style="display:flex; align-items:center; gap:6px; cursor:pointer;"
       title="Poll the provider every 45s for remote changes, and push local ticket edits back automatically">
    <input id="tickets-auto-sync-toggle" type="checkbox" style="width:auto; margin:0;">
    Auto-sync with provider
</label>
```

**Edge case:** the label must state that auto-sync also **pushes** local edits.

### File 6: `src/webview/tickets.js` — wire the toggle

- `getTicketsTabElements()` (`ts:273-326`): add
  `ticketsAutoSyncToggle: document.getElementById('tickets-auto-sync-toggle'),`
- `initTicketsTab` (`ts:4665`): on `change`, post
  `{ type: 'setTicketsAutoSync', enabled: e.target.checked, workspaceRoot: ticketsWorkspaceRoot || undefined }`
- **`ticketsAutoSyncChanged` arm — the load-bearing one.** Guard it with the existing
  `_isForThisPanel(message)` predicate (`ts:192`) so a broadcast for another root cannot
  flip this panel's checkbox, then set `checked = message.ticketsAutoSync === true`. This
  arm receives the value on every open (via `setupTicketsWatcher`, see File 1 step 5), on
  `ticketsDefaultRoot`, and after every toggle — including a toggle made in a *different*
  surface, which is how the editor panel and browser tab stay in agreement.
- `integrationProviderStates` arm (`ts:6834-6869`): also set the checkbox from
  `message.ticketsAutoSync === true` **when the field is present** (`!== undefined`) — this
  arm now carries it from `switchTicketsProvider`. Guard on presence, not truthiness: a
  push that omits the field must not silently untick a live setting.

> **Superseded:** "`integrationProviderStates` arm: set the checkbox … so an existing
> enabled install shows it **already ticked** on first open after upgrade."
> **Reason:** `integrationProviderStates` never reaches the Tickets panel on open — see
> File 1 step 5. Relying on it is what would have shipped an unticked box over a running
> engine.
> **Replaced with:** `ticketsAutoSyncChanged` (fed by `setupTicketsWatcher`) is the
> first-open carrier; the `integrationProviderStates` update is a secondary carrier for
> the provider-switch path only.

**No other frontend work.** The `importAllTicketsComplete` arm (`ts:7742-7768`) already
handles `autoSync: true` — suppressing the toast at `ts:7755` and refreshing via
`loadLocalTicketFiles()` at `ts:7766`.

## Out of Scope

- **Rate-limit hardening.** The inherited engine's backoff never reads `Retry-After` /
  `X-RateLimit-Reset` (`PlanningPanelProvider.ts:7296`, `:7302`), and its auto-push
  debounce is keyed per file path (`ts:7176`) so a bulk file change fires one push per
  file at once. Both are pre-existing behaviour in code this plan only *relocates*.
  Recorded, not fixed here. Separate plan if wanted.
- **Poll cadence.** 45s stays as-is.
- **The local `.md` sidebar-refresh bug.** Covered by `feature_plan_20260806153624`.
- **Making the tickets sync engine actually run in standalone.** Two wiring gaps, both
  pre-existing and both affecting the *manual* Refresh / Import / Sync buttons identically:
  (1) `bootstrap.ts:713-717` must pass a `TicketsPanelAdapterFactories` bundle — the three
  factories it needs (`getLinearSyncService`, `getClickUpSyncService`, `getCacheService`)
  already exist in `planningAdapterFactories` (`bootstrap.ts:783-790`); (2)
  `switchboard.pushTicketEdits` and `switchboard.importAllTasks` must be registered into
  `switchboardCommandRegistry` alongside the existing standalone handlers
  (`bootstrap.ts:812-840`). Fixing only (1) changes nothing observable. This plan does not
  do either — it would widen a shipped-state migration into a standalone feature port, and
  the payoff belongs to every tickets verb, not just this one. **Separate plan.**

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
   - The toggle shows **already ticked** — on a **cold** open, with **no** provider-dropdown
     interaction and with only one provider configured (so the dropdown is hidden entirely).
     This is the case the `integrationProviderStates`-only wiring would have failed; if the
     box is unticked here, File 1 step 5 was not implemented.
   - Repeat with the panel **reopened** after a provider was already restored — the path
     where `ticketsDefaultRoot` is never posted and only `setupTicketsWatcher` fires.
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

7. **Multi-root cross-talk:** with two workspace roots and a Tickets surface open on each
   (editor panel + browser tab), toggle auto-sync ON for root A. Root B's checkbox must
   **not** move — the `_isForThisPanel` guard on `ticketsAutoSyncChanged` is what prevents
   it, and every push from this provider is broadcast to all tickets surfaces.

8. **Standalone (`npx switchboard`) — assert the honest behaviour, not a working sync:**
   - The toggle renders, flips, and the value **persists** (visible in both the global and
     per-folder config on disk) — the verb routes and returns over HTTP.
   - The engine does **not** run: expect
     `[headless] command 'switchboard.importAllTasks' is not bridged` on the server console
     and no remote reads or writes. This is the documented pre-existing standalone gap (see
     *Out of Scope*), identical to the manual Refresh / Sync buttons in the same panel.
   - Do **not** record this step as a failure of this plan, and do **not** "fix" it here.

> **Superseded:** "**Both hosts:** repeat steps 2 and 5 over `npx switchboard`."
> **Reason:** step 2 asserts an end-to-end remote sync, which cannot pass in standalone —
> the tester would either report a false failure against this plan or paper over the real
> Layer-2 gap. See the Dependencies callout.
> **Replaced with:** step 8 above.

9. **Planning panel is clean:** with the auto-sync system deleted, the Project/Planning
   panel opens normally and its `integrationProviderStates` (`PlanningPanelProvider.ts:2605`,
   `:2629-2630`) no longer carries a `ticketsAutoSync` field, and
   `planning.js:189`'s unread `let ticketsAutoSync = false;` is gone (verified: that is its
   only occurrence in `planning.js`, so the deletion is safe).

### Automated Tests

Not run in this pass (SKIP TESTS / SKIP COMPILATION session directives). For the
implementer:

- `tsc --noEmit` (**not** `npm run compile` — `dist/` is unused in dev/test).
- `npm run catalog:generate` → `catalog:check`, `parity:check`, `verb-returns:check`
  (Tickets ≤ 56 — converting `setupTicketsWatcher` to `return` moves it *down*, which is
  fine), `push-routing:check`.
- `PlanningPanelProvider`'s per-provider tests must pass unchanged (PRD contract #2).
- `src/test/browser-panel-verb-routing.test.js` — run it; **no edit needed** (see File 4).
- **Highest-value new test — a regression guard for this exact bug class:** assert that a
  `LocalFolderService` config containing `ticketsAutoSync: true` still resolves to `true`
  through `TicketsPanelProvider._getTicketsAutoSync()`. That single assertion pins the
  migration and fails loudly if a future refactor orphans the setting again.
- **Second guard — the display half.** Assert that the `setupTicketsWatcher` verb's
  returned body carries `ticketsAutoSync: true` for a root whose folder config has it set.
  PRD enforcement is explicit that a headless test must assert the **body carries data**,
  and this is the one assertion that would have caught the unticked-box defect.

## Recommendation

**Send to Lead Coder** (Complexity 7).

---

## Completion Report

Implemented the tickets auto-sync migration: moved the five `_ticketsAutoSync*` state Maps, `_getTicketsAutoSync()` (with the local→global promotion branch preserved verbatim), and `_updateTicketsAutoSyncWatcher()` from `PlanningPanelProvider.ts` into `TicketsPanelProvider.ts` (log prefix changed to `[TicketsPanel]`); armed the engine from the live entry points (`setupTicketsWatcher` converted break→return and now carries `ticketsAutoSyncChanged` on open, plus `ticketsDefaultRoot`, `refreshTicketsDelta`, `importAllTickets`, `switchTicketsProvider`); added the `setTicketsAutoSync` verb (writes both global and per-folder config, arms/tears down the engine, broadcasts); restored the toggle markup in `tickets.html` and wired it in `tickets.js` (change listener, `ticketsAutoSyncChanged` arm guarded by `_isForThisPanel`, presence-guarded checkbox updates in `integrationProviderStates` and `ticketsDefaultRoot`); deleted the engine, fields, arming, dispose block, and `planning.js`'s unread `let ticketsAutoSync = false` from `PlanningPanelProvider.ts` in the same change; added the `setTicketsAutoSync` schema to `verbSchemas.ts`; regenerated the catalog and allowlist. Gates green: `catalog:check`, `parity:check`, `verb-returns:check` (Tickets 55 ≤ 55 — lowered the baseline from 56 to lock the break→return win), `push-routing:check`. No issues encountered. Per session directives, compilation and the automated test suite were not run.

---

## Review Findings

**CRITICAL (fixed):** the `ticketsAutoSyncChanged` arm was gated on `_isForThisPanel`, whose final clause compares `message.scopeId/listId/projectId` against `clickUpSelectedListId` — so a scope-less, root-scoped push is **rejected on every ClickUp panel with a list selected**, i.e. exactly the reopen path in UAT step 2. The toggle would have rendered unticked over a running engine: the defect this plan exists to correct, re-shipped. Replaced with the workspaceRoot-match guard the plan's cross-talk section actually calls for (`tickets.js:6817`). **MAJOR (fixed):** `switchTicketsProvider`'s `integrationProviderStates` push carried the new root-scoped `ticketsAutoSync` with no `workspaceRoot` stamp and an unguarded frontend arm — one root's provider switch rewrote every other surface's checkbox; stamped and guarded (`TicketsPanelProvider.ts:1146`, `tickets.js:6888`). **MAJOR (fixed):** both "highest-value" guards the plan names were missing; added four assertions to `src/test/verb-engine-tickets-headless.test.js` (CI-wired) covering fresh-install=false, per-folder→global promotion, `setupTicketsWatcher` **body** carrying the value, and `setTicketsAutoSync` writing both configs. Files changed: `TicketsPanelProvider.ts`, `tickets.js`, `verb-engine-tickets-headless.test.js`, plus catalog/allowlist regeneration. Validation: `tsc` clean (5 pre-existing TS2835 errors only, in untouched files), `catalog:check`/`parity:check`/`verb-returns:check` (Tickets 55 ≤ 55)/`push-routing:check` green, 35/35 tickets verb-engine assertions green, 14 related contract suites green.

**Remaining risks (not fixed, out of scope):** (1) `_panel.onDidDispose(() => this.dispose())` (`TicketsPanelProvider.ts:962`) means closing the *editor* Tickets panel now tears down the auto-sync engine and clears `_ticketsCurrentSelection` for a still-connected browser tab, which cannot re-arm because `ensureTicketsWatcherArmed`'s `_armedTicketsWatcherRoot` guard suppresses a repost — pre-existing shape for `_ticketsViewWatcher`, newly extended to the sync engine. (2) Plan text says the shipped value lives in "the per-folder config file on disk"; it actually lives in the workspace `kanban.db` `config` table under `folders.paths` — correct behaviour, misleading prose that invites the wrong migration fixture. (3) In the browser host `setupTicketsWatcher`'s reply body is re-dispatched by `transport.js` *and* arrives over WS, so the arm runs twice (idempotent). (4) Standalone remains inert as documented, and the 45s interval is still created there, backing off to a permanent pause after 5 failures.

## Completion Report — Review Pass

Reviewed the implementation against this plan, found and fixed one CRITICAL and two MAJOR defects, and ran full verification. The engine move, the deletion from `PlanningPanelProvider`, the preserved local→global promotion branch, the restored writer, dispose teardown, and the `verbSchemas` entry all match the plan as written. The display half did not: the first-open carrier was silently filtered out for ClickUp users, and the migration had no automated guard — both now corrected and covered by CI-wired assertions. No compilation or test steps were skipped in this pass; the plan's earlier "not run per session directive" note was the coder's record and did not apply to the review.
