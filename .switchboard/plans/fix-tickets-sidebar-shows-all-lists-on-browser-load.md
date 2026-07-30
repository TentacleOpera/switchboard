# Fix: Tickets Sidebar Shows Every List's Tickets on First Load (Browser Rail)

## Goal

Make the Tickets tab sidebar show **only the selected ClickUp list / Linear project** on first load, in the browser cockpit as well as the VS Code webview. Today, on a fresh page load in the browser, the sidebar comes up populated with tickets from every list ever imported, and stays that way until the user manually re-selects a list.

### Problem Analysis & Background

The Tickets sidebar is file-backed: every row comes from the import registry (`getImportedTickets`) plus each file's YAML frontmatter, never from a live API list response. Because the registry accumulates **every list ever opened**, the rows must be scoped to the currently-selected list at read time. That scoping is driven entirely by an id the webview supplies.

`loadLocalTicketFiles()` (`src/webview/planning.js:12298`) sends:

```js
listId:   lastIntegrationProvider === 'clickup' ? (clickUpSelectedListId || undefined) : undefined,
projectId: lastIntegrationProvider === 'linear' ? (linearProjectPickerValue || undefined) : undefined
```

and the backend applies it at `src/services/PlanningPanelProvider.ts:6470`:

```ts
if (scopeId && fileScopeId !== scopeId) { continue; }   // no scopeId → no scoping, show everything
```

The `scopeId &&` short-circuit is deliberate ("If the webview didn't send a scope id, we don't scope (show all) so the sidebar is never wrongly emptied", `PlanningPanelProvider.ts:6386-6397`). That fallback is what turns a missing selection into a full-registry dump.

### Root Cause Analysis

`clickUpSelectedListId` / `linearProjectPickerValue` are populated by exactly one function: `restoreTicketsStateForRoot()` (`src/webview/planning.js:12422`). In the browser rail nothing calls it before the first sidebar load.

The backend pushes state in the right order inside `case 'fetchRoots'` — `workspaceItemsUpdated`, then `restoredTabState` (`src/services/PlanningPanelProvider.ts:2655`), then `integrationProviderStates` (`:2697`) — and *also* folds all three into the `fetchRootsComplete` return body (`:2701-2712`) because, per the handler's own comment, pushes issued inside `fetchRoots` are broadcast while a browser client is still inside its WS resync window and are lost.

The browser's `fetchRootsComplete` handler (`src/webview/planning.js:5223`) honours that contract for two of the three payloads and not the third:

| Payload | Body fallback in `fetchRootsComplete` | Effect |
| :--- | :--- | :--- |
| `workspaceItems` | Re-dispatched as a real message (`:5228`) | Handled |
| `integrationWorkspaces` | Re-dispatched, flag-guarded (`:5248`) | Handled |
| `integrationProviderStates` | Re-dispatched, flag-guarded (`:5253`) | Handled |
| `restoredTabState` | **Only assigned to `_restoredPanelState`** (`:5233-5236`) | **Side effects never run** |

The real `case 'restoredTabState'` (`:5273`) is where the side effects live: it sets `ticketsWorkspaceRoot` from `panel['tickets.root']`, calls `restoreTicketsStateForRoot()` (`:5284`), posts `ticketsRootChanged`, and then restores the research root, docs filter and kanban filters. The browser copies the data and drops all of it.

Twenty lines later the same handler re-dispatches `integrationProviderStates`, whose handler (`:7230`) fires immediately:

```js
if (isTicketsTabActive() && lastIntegrationProvider && !ticketsLoadedOnce) {
    if (lastIntegrationProvider === 'clickup') { loadClickUpSpaces(); }
    else if (lastIntegrationProvider === 'linear') { loadLinearProject(); }
    loadLocalTicketFiles();          // ← clickUpSelectedListId === '' → unscoped
}
```

So the first sidebar request goes out with no scope id, the backend dumps the whole registry, and `localTicketFilesListed` sets `ticketsLoadedOnce = true` (`:6102`). That latch then **suppresses the correcting load**: the `ticketsDefaultRoot` response handler (`:7157`), which does perform the restore properly at `:7172-7190`, guards its own `loadLocalTicketFiles()` on `!ticketsLoadedOnce` and skips it. The flood is sticky until the user re-picks a list by hand.

**A fourth trigger site exists (verified in the improve pass).** The tab-activation handler at `:2696-2710` also calls `loadLocalTicketFiles()` behind the same `!ticketsLoadedOnce` gate, and it is the *only* site that runs `initTicketsTab()` / `restoreTicketsState()` — both gated on `ticketsInitialized` (`:2700-2703`). This matters two ways:

- On a page load where the Tickets tab is **not** the active tab, `restoreTicketsState()` never runs until the user opens the tab, and the `isTicketsTabActive()` guards at `:7177` / `:7230` short-circuit both other load blocks. The first sidebar load then comes from `:2710`.
- That path is fixed by Stage 1 for free: the synthetic `restoredTabState` dispatch runs at `fetchRootsComplete` regardless of which tab is active, so `clickUpSelectedListId` is already populated by the time `:2710` fires. It needs a UAT step (step 10) but no extra code.

Two further consequences of the same missed restore, both user-visible:

- `_restoringClickUpHierarchy` is never armed, so the space/folder/list auto-select chain in `clickupSpacesLoaded` / `clickupFoldersLoaded` / `clickupListsLoaded` (`:6902`, `:6939`, `:6984`) never runs — the hierarchy dropdowns come up unselected even though a selection was persisted.
- The research root, docs workspace filter and kanban workspace/project filters restored in the same `case` block are also skipped in the browser. Same root cause, wider blast radius than the reported symptom.

**Why the VS Code webview mostly escapes it:** it receives the two pushes in order, so `restoredTabState` lands before `integrationProviderStates` and the restore wins the race. It is not structurally immune — any path where the provider state is handled before the restore produces the identical unscoped load — but the reported reproduction is browser-only.

#### Secondary defect: the empty-result fallback is unscoped too

When the scoped DB query yields nothing, `listLocalTicketFiles` falls back to a live filesystem scan (`src/services/PlanningPanelProvider.ts:6492`):

```ts
if (tickets.length === 0) {
    for (const dir of ticketDirs) { this._scanLocalTicketFiles(dir, provider, tickets); }
}
```

This path ignores `scopeId` entirely, and `_scanLocalTicketFiles` (`:9532`) recurses into subdirectories and — unlike the DB path at `:6461` — does **not** skip files carrying `parentId`. The directories come from `_getTicketDocumentDirs` (`:2291`), which builds them from the **backend service's** persisted `getSelectedHierarchy()` (`src/services/ClickUpSyncService.ts:551`, defaulting to `_unknown`), not from the webview's selection. So whenever those two disagree the fallback reads a *different* list's directory, and any legacy subtask files there surface as sidebar rows. This is host-independent and survives the primary fix, so it ships in the same change.

### Non-Goals

- No change to the file-backed sidebar model, the import registry schema, or the `listId:` / `projectName:` frontmatter keys.
- No change to Linear's name-based project scoping (it stays keyed on `projectName:`; the legacy-file caveat at `PlanningPanelProvider.ts:6390-6396` is unchanged).
- No change to `ticketsAutoSync`, the delta-pull cursor, or any import behaviour. Sidebar read path only.
- No new persistence: everything needed is already written by `saveTicketsState()` and already arrives in the `fetchRootsComplete` body.

## Metadata
- **Complexity:** 5
- **Tags:** bugfix, frontend, ui, reliability

> **Superseded:** **Complexity:** 4 — **Tags:** bugfix, frontend, browser, state-restore, reliability — plus **Repo:** switchboard
> **Reason:** `browser` and `state-restore` are not in the allowed tag vocabulary and are dropped on import, so the plan ends up with fewer tags than intended. The `**Repo:**` line is omitted because this workspace is single-repo (session directive). Complexity moves 4 → 5 because the improve pass verified that Stage 1 does more than re-dispatch a payload: it makes the browser post `ticketsRootChanged` for the first time, which arms two backend watchers including the autoSync delta-pull timer (`PlanningPanelProvider.ts:2795-2796`). That is a background-behaviour change in a second host, not a webview-local edit.
> **Replaced with:** **Complexity:** 5, **Tags:** bugfix, frontend, ui, reliability. Still "Send to Coder" — the routing does not change, but the UAT gate is wider than the original score implied.

## User Review Required

None. One judgement call was made and is recorded rather than deferred: when ClickUp is the provider and **no** list is selected, the sidebar now renders an explicit "select a list" empty state instead of falling back to every ticket in the registry. Showing an unscoped dump is never the correct answer to "which list am I looking at?" — see Stage 2.

## Complexity Audit

### Routine
- Re-dispatching a payload already present in the `fetchRootsComplete` body, using the flag-guarded pattern the same handler already uses three times.
- Adding a `_restoredTabStateReceived` flag alongside the existing `_integrationWorkspacesReceived` / `_integrationProviderStatesReceived`.
- Threading `scopeId` into the fallback scan and skipping `parentId` files there.
- Source-assertion regression test in the established `src/test/*.test.js` style.

### Complex / Risky
- The fix runs **inside** a message handler and its correctness depends on dispatch order: the synthetic `restoredTabState` must be dispatched before the `integrationProviderStates` re-dispatch in the same handler, and after `workspaceItemsUpdated` (the restore's `_workspaceItems.some(...)` guard fails against an empty list and silently degrades to `ticketsDefaultRoot`). `window.dispatchEvent(new MessageEvent(...))` is synchronous, so ordering is deterministic — but only if the call is placed correctly.
- `case 'restoredTabState'` restores four subsystems (tickets, research, docs, kanban). Re-dispatching it in the browser makes three previously-dead restores start working. That is the intended fix, not a side effect, but it is the change's real blast radius and the UAT must cover all four.
- The `ticketsLoadedOnce` latch is set from three sites (`:6102`, `:6689`, `:7006`) and **gated at four** (`:2705`, `:7177`, `:7186`, `:7230` — the tab-activation site at `:2705` was missed in the original survey). Making a late restore able to re-issue the load without re-opening double-fetch (the exact problem the latch was added to solve) needs a distinct flag, not a relaxation of the latch.
- **The latch is set inside the handler Stage 2 wants to reuse.** `:6102` sets `ticketsLoadedOnce = true` unconditionally at the top of `case 'localTicketFilesListed'`, before any branch on the payload. Any plan that dispatches a synthetic listing to reuse the render path *and* claims not to latch is self-contradictory — this one did, and its own Stage 5 assertion locked the contradiction in. Resolved by an explicit `unscopedPlaceholder` flag on the payload and a guarded latch; see the Stage 2 correction.
- Stage 1's edit is three lines in one handler, but its *effect* crosses a host boundary: it starts a `ticketsRootChanged` round trip the browser has never made, which arms the autoSync delta-pull timer and the tickets view watcher in the cockpit. Reviewing this as a webview-local change under-reads it.
- Changing the backend's "no scope id → show all" fallback affects every `listLocalTicketFiles` caller, including the post-import refresh at `:6067` and the post-delete refresh at `:6269`.

## Edge-Case & Dependency Audit

**Race Conditions**
- If the real `restoredTabState` push *does* land in the browser (outside the resync window, e.g. a later `fetchRoots`), the body fallback must not re-run the restore — hence the `_restoredTabStateReceived` guard, mirroring the existing integration flags.
- `restoreTicketsStateForRoot` is reachable from four sites (`:5284`, `:5295`, `:7174`, `:9736`). It is assignment-only and idempotent, but it also arms `_restoringClickUpHierarchy`; arming it twice while a hierarchy fetch is in flight is safe because each `clickup*Loaded` handler clears it, and the stale-result guards at `:6931` / `:6975` drop mismatched responses.
- `ticketsDefaultRoot` may still arrive after the synthetic restore has set a root. Its handler already bails on that (`:7158-7160`), so no double restore.
- The re-issued load (Stage 3) must be a single shot. Keying it on a `_ticketsListedUnscoped` flag that is cleared as soon as a scoped request is sent prevents a loop with `localTicketFilesListed`.

**Security**
- None. No new input parsing, no new persisted state, no new network or filesystem surface. The `scopeId` values are already sent today and are compared as strings, never path-joined.

**Side Effects**
- Kanban / research / docs filters begin restoring in the browser on first load. Desirable, and it will read as a behaviour change to anyone used to the current unrestored defaults.
- With Stage 2, a ClickUp user with no list selected sees an empty sidebar instead of a full one. Intended.
- The Stage 4 fallback-scan scoping can shrink results for **legacy files lacking `listId:` frontmatter** — the same trade the DB path already makes (`:6465-6469`), and re-importing the list rewrites the key.

**Dependencies & Conflicts**
- `.switchboard/plans/fix-tickets-link-all-omits-subtasks.md` touches the same tab but disjoint code (import content generation vs. sidebar read path). No merge conflict expected.

  > **Superseded:** Either order; no merge conflict expected.
  > **Reason:** the files are disjoint but the *risk* is not symmetric. Stage 1 makes the browser post `ticketsRootChanged`, whose backend handler arms `_updateTicketsAutoSyncWatcher` (`PlanningPanelProvider.ts:2795`) — the autoSync background **delta-pull** timer, in the browser, for the first time. That other plan documents an unguarded data-loss bug on exactly the delta write path (its Stage 2): a delta pull currently regenerates a parent's file and would wipe its `## Subtasks` section. Landing this plan first widens exposure to that bug in a second host before the guard exists.
  > **Replaced with:** develop in parallel; **prefer merging the subtask-embedding plan first**. If this plan lands first, that is acceptable — the same exposure already exists in the VS Code host — but treat the other plan's delta-preservation UAT as a blocking follow-up rather than a nice-to-have. This is an ordering preference, not a hard dependency, and it imports no requirements from that plan into this one.
- `_scanLocalTicketFiles` is also used by the DB-backfill scan at `:6353`, which registers orphan files. Do **not** add subtask filtering inside the helper unconditionally — the backfill should keep registering subtask files so `_findTicketFilePath` can still resolve them. Gate it behind an options argument used only by the display fallback.
- Verification must run against the **installed** extension folder, not the repo `dist/` — a repo build alone does not change what the running cockpit serves.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) the plan as originally written rested its correctness on the *source position* of one dispatch, defended by a positional test — brittle, so Stage 3's re-issue is now the guarantee and the ordering is a double-fetch optimisation; (2) Stage 2's synthetic `localTicketFilesListed` sets `ticketsLoadedOnce` at `:6102` whether the plan wants it to or not, so the "don't latch on the placeholder" intent needs an explicit payload flag and a guarded latch, otherwise a no-selection user is latched empty; (3) Stage 1 makes the browser post `ticketsRootChanged`, which arms the autoSync delta-pull timer and the view watcher in the cockpit for the first time and wakes three unrelated restores — the real blast radius, wider than the reported symptom; (4) Stage 4's scoping can turn a wrong-and-full sidebar into an empty one for users with legacy files lacking `listId:`, which passes the plan's own success check while being useless. Mitigations: treat Stage 3 as the correctness path (positional test retained as a perf guard), guard the latch on an `unscopedPlaceholder` flag, name the watcher activation and cover all four restore consumers plus the autoSync arming in UAT, and emit a coverage warn plus a distinguishing empty state whenever scoping hides every candidate file.

## Proposed Changes

### Stage 1 — Apply the restore in the browser body-fallback path

**File:** `src/webview/planning.js`

**Context.** `case 'fetchRootsComplete'` (`:5223`) already re-dispatches three of the four `fetchRoots` payloads as real messages so a single handler owns each concern. `restoredTabState` is the exception: `:5233-5236` assigns the data and drops the side effects.

**Logic.** Re-dispatch `restoredTabState` as a real message, flag-guarded, positioned before the `integrationProviderStates` re-dispatch and after the `workspaceItemsUpdated` re-dispatch.

**Implementation.**
- Add a module-scope `let _restoredTabStateReceived = false;` next to `_integrationProviderStatesReceived` (`:65`).
- Set it at the top of `case 'restoredTabState'` (`:5273`), mirroring `_integrationWorkspacesReceived` at `:5269` and `_integrationProviderStatesReceived` at `:7200`.
- **Keep the existing `_restoredPanelState` assignment at `:5233-5236` unconditional**, and add the guarded dispatch beside it rather than in place of it. The dispatched handler re-assigns the same two fields (`:5274-5275`), so on the normal path the assignment is redundant — but if the flag is ever already set, replacing the assignment would drop the payload data entirely, silently regressing today's unconditional behaviour. `fetchRoots` is posted from a single site (`:12734`) so this is insurance, not a live bug; it costs two lines.
- Add the guarded re-dispatch:

```js
// The restoredTabState push is emitted inside the backend's fetchRoots handler and
// is lost to the browser's WS resync window, exactly like the integration pushes
// below. Copying the data without dispatching the message left every restore
// consumer (tickets list selection, research root, docs filter, kanban filters)
// unrestored — and the tickets sidebar then loaded unscoped, showing every list.
// Dispatch BEFORE integrationProviderStates: that handler kicks the first
// loadLocalTicketFiles(), which needs the restored list id to scope the request.
if (msg.restoredTabState && !_restoredTabStateReceived) {
    window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'restoredTabState', ...msg.restoredTabState }
    }));
}
```

**Edge cases.** `_workspaceItems` must already be populated — it is, from the `workspaceItemsUpdated` re-dispatch immediately above; without it the restore's `_workspaceItems.some(...)` guard (`:5278`) fails and it degrades to posting `ticketsDefaultRoot`. Keep the `panel` / `byRoot` shape identical to the push (`{ type, panel, byRoot }`), since the handler reads `msg.panel` / `msg.byRoot`, not a nested object.

**Stage 1's real blast radius — it starts a backend round trip the browser has never made (verified).** `case 'restoredTabState'` posts `ticketsRootChanged` on both of its branches (`:5286` / `:5298`). Today the browser never reaches that case, so it never posts it; after Stage 1 it will. The backend handler (`PlanningPanelProvider.ts:2770-2803`) does three things beyond replying:

1. `_updateTicketsAutoSyncWatcher(root, ticketsAutoSync)` (`:2795`) — **arms the autoSync background delta-pull timer in the browser cockpit for the first time.** It honours the user's existing `ticketsAutoSync` setting rather than introducing a new default-ON capability, so this is consistent with the project PRD's default-OFF rule — but a browser session that previously did no background pulling will now do so whenever the user has autoSync enabled. It must be named, not discovered in production.
2. `_setupTicketsViewWatcher(root)` (`:2796`) — arms the file watcher for the tickets view.
3. Pushes a **second** `integrationProviderStates` (`:2797-2803`), whose handler re-runs the `!ticketsLoadedOnce` load block at `:7230`. Whether that produces a second sidebar load depends on whether the first `localTicketFilesListed` has returned and set the latch — so a second load is *possible and benign* (it is scoped by then). See the correction to UAT step 6.

None of this is a reason not to ship Stage 1 — arming the watchers is the browser reaching parity, which is the point of the cockpit. But it is why the complexity moved to 5, and it creates the ordering preference recorded under Dependencies & Conflicts.

### Stage 2 — Stop the webview from asking for an unscoped list

**File:** `src/webview/planning.js` (`loadLocalTicketFiles`, `:12298`)

**Context.** The function fires for any truthy `lastIntegrationProvider`, with or without a selection, and the backend interprets "no scope id" as "show everything".

**Logic.** For ClickUp, no selected list means there is nothing correct to show — request nothing and render an explicit empty state. Linear keeps its current unscoped behaviour (the picker is name-based and an empty picker legitimately means "all projects").

**Implementation.**

> **Superseded:** Early-return when `lastIntegrationProvider === 'clickup' && !clickUpSelectedListId`: dispatch a synthetic `localTicketFilesListed` with `tickets: []` (so the existing render path owns the empty state) and set the empty-state copy to "Select a space and list to see its tickets." Do **not** set `ticketsLoadedOnce` on this path — no real load happened.
> **Reason:** these two sentences contradict each other, and Stage 5's negative assertion ("the early-return path does not set `ticketsLoadedOnce`") locks in the contradiction as a test. `ticketsLoadedOnce = true` is set **inside** the `localTicketFilesListed` handler, unconditionally, at `:6102` — before any branch on the payload. Dispatching that message *is* setting the latch. As written, the early return would latch the tab as "loaded" with zero rows, and Stage 3's re-issue is then the only thing that could ever repopulate it — turning the belt-and-braces path into the sole load path for every no-selection user.
> **Replaced with:** keep the single-render-path design (it is the right call — a second empty-state renderer would drift), and make the latch conditional instead:
>
> - Dispatch the synthetic message with an explicit marker: `{ type: 'localTicketFilesListed', provider, workspaceRoot: ticketsWorkspaceRoot, tickets: [], unscopedPlaceholder: true }`.
> - At `:6102`, guard the latch: `if (!msg.unscopedPlaceholder) { ticketsLoadedOnce = true; }`. One line, one site, and it keeps the "no real load happened" intent that the original sentence expressed.
> - Everything downstream of the latch (the `tickets.map(...)` mapping at `:6103`+, the render call) runs unchanged on an empty array, so the empty state renders through the path it always has.
>
> Stage 5's negative assertion is restated accordingly: assert the **latch site at `:6102` is guarded by the placeholder flag**, not that the early return avoids dispatching.

- Set the empty-state copy to "Select a space and list to see its tickets."
- Set `_ticketsListedUnscoped = true` when a request goes out with no scope id (Linear only, after this change), and clear it whenever a scoped request is sent. Consumed by Stage 3.

**Edge cases.** The post-import (`:6067`), post-delete (`:6269`) and file-poll refresh paths all funnel through this function; with a list selected their behaviour is unchanged. The synthetic empty response must carry the current `workspaceRoot` or the race guard at `:5209-5215` will drop it.

### Stage 3 — Let a late restore correct an already-rendered unscoped list

**File:** `src/webview/planning.js`

**Context.** `ticketsLoadedOnce` is set on the first `localTicketFilesListed` (`:6102`) and gates the load blocks at `:7177` and `:7230`. Any restore that lands after the first load therefore cannot refresh the sidebar.

**Logic.** If a scope id becomes known *after* an unscoped listing was rendered, re-issue the load once.

> **Superseded:** Stage 3 is the belt-and-braces for every other path (a later `fetchRoots`, a manual `ticketsDefaultRoot`, a workspace switch).
> **Reason:** framing Stage 3 as optional insurance puts the plan's correctness entirely on Stage 1's dispatch *position* — which the plan's own Complex/Risky section concedes is fragile, and which it then defends with a source-index assertion in Stage 5. A test that asserts one line appears before another in a 13,000-line file is a brittle proxy for an invariant; any future refactor that moves the block passes the intent and fails the test, or moves it and the test is deleted.
> **Replaced with:** **Stage 3 is the correctness guarantee; Stage 1's ordering is a double-fetch optimisation.** With Stage 3 in place, an unscoped first listing is self-correcting whenever the restore lands later — so the fix holds even if a future edit disturbs the dispatch position. That inverts the risk: the worst outcome of wrong ordering becomes one extra scoped fetch, not a sticky registry dump. Stage 5's positional assertion is retained (it protects the optimisation and documents the intent) but is **downgraded from the safety mechanism to a guard against silent perf regression** — it must not be the only thing standing between the user and the bug.

**Implementation.** At the end of `restoreTicketsStateForRoot` (`:12422`), if `_ticketsListedUnscoped` and a scope id is now set, clear the flag and call `loadLocalTicketFiles()`. Leave `ticketsLoadedOnce` untouched.

**Edge cases.** Single-shot by construction — the flag is cleared before the call, and the follow-up request is scoped so it cannot set the flag again. This must not fire during the ClickUp hierarchy restore chain in a way that races `loadClickUpProject`; both end in a render, and `renderTicketsClickUpList`'s DOM-guard (`_lastTicketsClickUpIssuesContainerHtml`) absorbs the duplicate.

### Stage 4 — Scope the empty-result fallback scan and skip subtask files

**File:** `src/services/PlanningPanelProvider.ts`

**Context.** `case 'listLocalTicketFiles'` (`:6320`). The DB path scopes at `:6470` and skips `parentId` files at `:6461`. The fallback scan at `:6492` does neither, and its directories come from the backend's own persisted hierarchy (`_getTicketDocumentDirs`, `:2291`), which can differ from the webview's selection.

**Logic.** Make the fallback obey the same two rules as the DB path.

**Implementation.**
- Extend `_scanLocalTicketFiles` (`:9532`) with an options argument `{ scopeId?: string, skipSubtasks?: boolean }`. It already parses frontmatter — additionally read `parentId` and the provider's scope key (`listId:` for ClickUp, `projectName:` for Linear) and apply: skip when `skipSubtasks && parentId`, skip when `scopeId && fileScopeId !== scopeId`.
- Pass the options **only** from the display fallback at `:6492`. Call the backfill scan at `:6353` with no options, so orphan subtask files keep getting registered and `_findTicketFilePath` can still resolve them.

**Edge cases.** Legacy files with no `listId:` are hidden once a scope id is supplied — same trade the DB path already makes, and re-importing the list rewrites the key. With `scopeId` empty (Linear, no project picked) behaviour is unchanged. **Verified:** `_scanLocalTicketFiles` (`:9532-9576`) currently parses `kanbanColumn`, `created`, `assignees` and `priority` from frontmatter but reads neither `parentId` nor `listId`, so both reads are genuinely new — and it does recurse into subdirectories (`:9539-9540`), which is why a mismatched `_getTicketDocumentDirs` root can surface a sibling list's files. `_getTicketDocumentDirs` (`:2291-2325`) builds its ClickUp path from `clickUp.getSelectedHierarchy()`, which defaults to `_unknown`/`_unknown` when the backend config is empty (`ClickUpSyncService.ts:551-558`) — confirming the two-sources-of-truth problem the stage describes.

**The failure this stage must not cause: "empty" is not "correct".** Scoping converts a wrong-and-full sidebar into an empty one whenever the selected list id and the files' `listId:` frontmatter disagree — which is exactly the legacy-file case above. An empty sidebar satisfies "shows only the selected list's tickets" trivially while being useless, and it looks identical to "this list has no tickets", so no one reports it as a regression. Both the DB path and the fallback must therefore distinguish the two:

- When `scopeId` is set and the pre-scope candidate set was non-empty but the post-scope set is empty, `console.warn` the counts (candidates seen, hidden by scope, hidden as subtasks) and include a flag on the `localTicketFilesListed` payload so the empty state can say "N local files for this provider don't carry a list id — Refetch this list to re-key them" instead of the bare "no tickets" copy.
- This is the same honesty rule the primary fix relies on and it costs one counter per loop. Without it, the most likely real-world outcome of Stage 4 is a silent regression for exactly the users with the oldest ticket files.

### Stage 5 — Regression test

**File:** `src/test/tickets-sidebar-list-scoping.test.js` (new)

**Context.** Follows the source-assertion pattern of `src/test/kanban-card-button-drag-guard.test.js`.

> **Superseded:** read the source with `fs.promises.readFile`, assert with `node:assert`, export `run()`.
> **Reason:** the cited exemplar does none of those things. It uses synchronous `require('fs').readFileSync`, `require('assert')`, a single named test function, `module.exports = { testKanbanCardButtonDragGuard }`, and a `if (require.main === module) { … }` tail. There is no `run()` export anywhere in it. A test exporting only `run()` and invoked by CI as `node src/test/<file>.js` executes nothing and **passes vacuously** — the worst possible failure mode for a contract test.
> **Replaced with:** match the exemplar exactly — sync `readFileSync`, `require('assert')`, one named test function, `module.exports = { testTicketsSidebarListScoping }`, plus the `require.main === module` self-invocation so the CI step actually runs it.

**Implementation.** Every assertion must fail at HEAD and pass after:
- `case 'fetchRootsComplete'`'s body contains a `restoredTabState` `MessageEvent` dispatch, and its source index is **less than** the index of the `integrationProviderStates` dispatch and **greater than** the `workspaceItemsUpdated` dispatch. Ordering, not presence. *(Per the Stage 3 correction, this guards the double-fetch optimisation, not correctness — do not treat a green result here as proof the bug is fixed.)*
- The dispatch is guarded by `_restoredTabStateReceived`, and `case 'restoredTabState'` sets that flag.
- **Positive:** the `_restoredPanelState` assignment at `:5233-5236` is still present and **not** inside the flag guard.
- `loadLocalTicketFiles` contains a ClickUp-and-no-list early return that does not `postMessage` a `listLocalTicketFiles` request.
- **Negative (restated):** the `ticketsLoadedOnce = true` assignment inside `case 'localTicketFilesListed'` is guarded by the placeholder flag — assert the latch line is not reachable unconditionally. *(The original form, "the early-return path does not set `ticketsLoadedOnce`", was unsatisfiable — see the Stage 2 correction.)*
- `restoreTicketsStateForRoot` contains the `_ticketsListedUnscoped` re-issue, and does not modify `ticketsLoadedOnce`.
- In `PlanningPanelProvider.ts`, the `listLocalTicketFiles` fallback scan call (`:6494`) passes a scope/skip-subtask option, and the backfill scan call (`:6353`) does not.
- The scope-hid-everything warn from Stage 4 exists — assert the counter and the log call together, so the honesty path cannot be dropped as "noise".

**Edge cases.** Anchor regexes on identifiers (`restoredTabState`, `_restoredTabStateReceived`, `loadLocalTicketFiles`, `_scanLocalTicketFiles`, `unscopedPlaceholder`), never on whitespace or argument order.

**Wiring (exact locations).** Add `"test:contract:tickets-sidebar-scoping": "node src/test/tickets-sidebar-list-scoping.test.js"` to `package.json` beside the other `test:contract:*` entries (~`:793`), and a matching step in `.github/workflows/integration-tests.yml` after the `test:contract:drag-guard` step (~`:91`). An unwired contract test is not a gate.

## Verification Plan

### Automated Tests
- Add `src/test/tickets-sidebar-list-scoping.test.js` per Stage 5, with its `npm` script (`package.json` ~`:793`) and CI step (`.github/workflows/integration-tests.yml` ~`:91`).
- The implementing agent must run the existing planning/tickets suites for regressions — `planning-aggregate-cache.test.js`, `planning-modal-contract.test.js`, `verb-engine-planning-headless.test.js`, `tickets-link-to-ticket-regression.test.js`. Stash-verify any red test against HEAD before attributing it to this change.
- A TypeScript compile is required for the `PlanningPanelProvider.ts` / `_scanLocalTicketFiles` signature change.
- *Not executed in this planning pass:* compilation and test runs were skipped per session directive. Every code claim above was verified by reading the source at the cited lines, not by running anything.

### Manual UAT (the real gate)

Against the **installed** extension folder with a reload, not the repo `dist/`. Requires a ClickUp workspace with at least two lists that have both been imported at least once, so the registry holds rows for both.

1. **The reproduction.** In the browser cockpit, select list A, confirm the sidebar shows only A's tickets, then fully reload the page with the Tickets tab active. **Expected after fix:** the sidebar comes up scoped to A, and the space/folder/list dropdowns come up with A pre-selected. Before the fix it comes up showing A + B + everything else, with empty dropdowns.
2. **Ordering proof.** With devtools open, confirm the first `listLocalTicketFiles` request of the session carries a non-empty `listId`. A first request with no `listId` means the dispatch landed in the wrong position.
3. **No-selection state.** Clear the persisted selection (new profile or clear the tab state), reload with the Tickets tab active: sidebar shows the "Select a space and list" empty state, not a registry dump.
4. **List switching still works.** Switch A → B → A; each switch shows only that list's tickets and no cross-bleed.
5. **Empty-list fallback (Stage 4).** Select a list that has never been imported. The sidebar must be empty (or show only that list's files after Refetch) — **not** another list's tickets, and no subtask rows.
   - **Then the case that matters more:** point the selection at a list whose local files predate the `listId:` frontmatter key (or strip the key from a couple of files by hand). The sidebar will legitimately come up empty — confirm the Stage 4 coverage warn fires and the empty state says the files need re-keying, rather than the bare "no tickets" copy. An empty sidebar that looks like "no tickets here" is the one way this change ships a silent regression.
6. **Double-fetch check (expectation corrected).** Watch the network/log for sidebar loads per page load. **One is ideal; two is acceptable and not a bug.** Two can arise from Stage 1's `ticketsRootChanged` post triggering a second `integrationProviderStates` push (`PlanningPanelProvider.ts:2797`) whose handler re-enters the `!ticketsLoadedOnce` block at `:7230` before the first listing has returned. What matters is that **every** request carries a non-empty `listId` and the rendered rows never include a second list.
   > **Superseded:** Watch the network/log for exactly one sidebar load per page load. Two means Stage 3 is firing when Stage 1 already resolved the ordering.
   > **Reason:** the improve pass traced a second, pre-existing source of a duplicate load that has nothing to do with Stage 3 — the `ticketsRootChanged` → `integrationProviderStates` round trip that Stage 1 newly introduces in the browser. A tester following the original instruction would chase Stage 3 for a duplicate Stage 1 caused.
   > **Replaced with:** the scoped-request assertion above. If you want to attribute a duplicate, log which handler issued it rather than counting.
7. **Blast-radius check — the other three restore consumers now live in the browser.** After reload confirm: the Kanban tab's workspace + project filters, the Docs workspace filter, and the Research root all come up on their persisted values. Any of these landing on a wrong value is a Stage 1 regression, not a pre-existing bug.
8. **VS Code webview parity.** Repeat steps 1, 4 and 5 in the VS Code panel — behaviour must be unchanged there (it already restored in time; this must not double-restore or double-fetch).
9. **Linear provider.** Repeat steps 1 and 4 with Linear selected: project-scoped rows, and an empty project picker still legitimately shows all projects. Note that step 2's "non-empty `listId`" assertion does **not** apply here — Linear sends `projectId` and legitimately sends neither when no project is picked.
10. **Tab-inactive load path.** Reload the browser cockpit with a **non-Tickets** tab active, then switch to Tickets. The first sidebar load comes from the tab-activation handler (`:2710`), not from `integrationProviderStates` — confirm it is scoped and the hierarchy dropdowns are pre-selected. This path is fixed by Stage 1 without extra code, and is the one a Tickets-tab-first UAT never exercises.
11. **AutoSync watcher activation (new browser behaviour).** With `ticketsAutoSync` **enabled**, reload the cockpit and confirm from the logs that the autoSync delta pull now runs in the browser (it previously did not, because `ticketsRootChanged` was never posted). Then set `ticketsAutoSync` **off**, reload, and confirm no background pull occurs — the watcher must honour the setting, not arm unconditionally.

---

## Recorded Follow-Up (not scheduled)

**The transport is the real defect; this plan is the fourth patch to the same symptom.** Stage 1 adds a body-fallback re-dispatch because a push emitted inside the backend's `fetchRoots` handler is lost while a browser client is still inside its WS resync window. `integrationWorkspaces` (`:5248`) and `integrationProviderStates` (`:5253`) each already needed the identical workaround, and the handler's own comment (`:5240-5247`) documents why: "wsHub subscribes a connection only AFTER the snapshot is on the wire."

Two alternatives were considered and rejected **for this change**, correctly — but the first should be recorded rather than forgotten:

- **Fix the resync window** — buffer pushes emitted during the window and flush them on subscribe, or subscribe the connection before the snapshot goes on the wire. This fixes the whole class, in one place, and would eventually let all four body fallbacks be deleted. Rejected here because it touches the WS hub shared by every panel, and the project PRD's byte-compatibility contract over ~4,000 shipped installs makes that a poor vehicle for a tickets-sidebar bugfix. It is the right next piece of work if a fifth instance appears — and a fifth instance is the signal to stop patching.
- **An explicit readiness gate** — have `loadLocalTicketFiles` await a restore-applied promise instead of racing. Rejected as more machinery than Stage 3's single flag for the same order-tolerance, and it would add a new webview primitive that every future load site must remember to use.

## Uncertain Assumptions

None. Every claim in this plan was settled by reading this repository — the handler order and payload shapes in `planning.js`, the scoping and fallback behaviour in `PlanningPanelProvider.ts`, the `_getTicketDocumentDirs` / `getSelectedHierarchy` divergence, and the four `loadLocalTicketFiles` trigger sites. `window.dispatchEvent` is synchronous per the DOM standard, which is what makes the ordering deterministic. No web research is required before implementation.

**Recommendation: Send to Coder** (Complexity 5 — the edits are small and well-anchored, but Stage 1 arms two backend watchers and wakes three unrelated restores in the browser, and Stage 4 can silently trade a wrong sidebar for an empty one. The UAT, not the test suite, is the real gate).

## Completion Report

Implemented state-restoration re-dispatch in browser webview `fetchRootsComplete` body fallback to ensure tickets list selection restores prior to initial load. Added ClickUp no-list selection synthetic empty return with guarded latch, late-restore re-issue check, and scoped fallback scanning in backend `PlanningPanelProvider`. Modified `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `package.json`, `.github/workflows/integration-tests.yml`, and added contract test `src/test/tickets-sidebar-list-scoping.test.js`. No implementation issues encountered.

## Reviewer Pass — 2026-07-30

Stages 1, 3 and 4 verified correct as implemented; two MAJOR gaps in Stage 2's user-facing half were found and fixed.

### Findings

**MAJOR — Stage 2's required empty-state copy was never implemented.** `_ticketsEmptyStateCopy()` returned `'No tasks found.'` on the ClickUp no-list-selected path, i.e. the same string a genuinely empty list produces. The `unscopedPlaceholder` marker reached the webview and gated the latch, but never reached the copy. This failed three separate statements of the same requirement: the Stage 2 Implementation bullet, the **User Review Required** decision ("the sidebar now renders an explicit 'select a list' empty state"), and **UAT step 3**. It is also the exact "empty is not correct" failure the plan's Stage 4 legislates against, reproduced one level up.

**MAJOR — the Stage 4 honesty path was wired for one provider only.** `_ticketsEmptyStateCopy()` was called from `renderTicketsClickUpList` and nowhere else; `renderTicketsLinearList` kept a hard-coded `'No Linear issues are currently available.'`. The backend computes `scopeCoverage` for **both** providers (Linear scopes on `projectName:`, per the regex added in `_scanLocalTicketFiles`), so a Linear user with legacy files got the silent regression with the diagnostic sitting unread in the payload. The copy also hardcoded "list id" — a key Linear has no equivalent of, making the re-key instruction unfollowable.

**Correct as implemented (no change):** the `restoredTabState` re-dispatch position (after `workspaceItemsUpdated`, before `integrationProviderStates`) and its `_restoredTabStateReceived` guard; the `_restoredPanelState` assignment left unconditional beside the guard rather than inside it; Stage 3's re-issue at the end of `restoreTicketsStateForRoot` with `ticketsLoadedOnce` untouched; the `!msg.unscopedPlaceholder` latch guard; the option-gated `_scanLocalTicketFiles`; the display fallback scoped while the backfill scan at `PlanningPanelProvider.ts:6378` correctly stays unscoped so `_findTicketFilePath` can still resolve orphan subtask files; and the bounded probe re-scan that only runs on the already-empty path.

### Fixes applied

- `src/webview/planning.js:67-70` — added `_ticketsAwaitingListSelection`.
- `src/webview/planning.js:6120` — record `!!msg.unscopedPlaceholder` in the `localTicketFilesListed` handler.
- `src/webview/planning.js:11960-11981` — `_ticketsEmptyStateCopy(fallback)` returns `'Select a space and list to see its tickets.'` for the placeholder, and provider-accurate re-key copy (`list id` for ClickUp, `project name` for Linear).
- `src/webview/planning.js:11418-11422` — `renderTicketsLinearList` routes its empty state through the shared helper.
- `src/test/tickets-sidebar-list-scoping.test.js` — added gates: the placeholder copy, the Linear noun, the `unscopedPlaceholder` capture, and that **both** renderers call `_ticketsEmptyStateCopy` (so the honesty path cannot be half-wired again).

### Validation

`npx tsc -p tsconfig.test.json` exit 0; `npm run compile` clean (3 pre-existing optional-dep warnings). `test:contract:tickets-sidebar-scoping` **PASS**. `planning-aggregate-cache` and `tickets-link-to-ticket-regression` PASS. `verb-engine-planning-headless` 37 pass / 3 fail and `planning-modal-contract` fail — **both reproduce identically at baseline `ea28cd2`** (stash-verified by materialising that commit in a scratch tree), so neither is attributable to this change. `parity:check` / `push-routing:check` / `verb-returns:check` PASS.

Gate-wiring audit: `test:contract:tickets-sidebar-scoping` is defined at `package.json:794` **and invoked** at `.github/workflows/integration-tests.yml:94`. Not an orphaned script.

### Remaining risks

- **The manual UAT is still the gate and has not been run.** Steps 1–11 all remain open, in particular step 11 (autoSync watcher activation in the browser) and step 5's legacy-file case — the fixes above make the legacy-file state *legible*, but only a real run confirms the copy fires.
- Verification ran against the repo, not the installed extension folder. Per the plan's own note, a repo build alone does not change what the running cockpit serves.
- Behaviour change stands as designed: kanban / research / docs filters now restore in the browser on first load, and a ClickUp user with no list selected sees an empty sidebar (now correctly labelled) instead of a full one.

