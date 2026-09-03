# Give `tickets.root` a single source of truth: wire the host push, then drop the local mirror

<!-- board-collapse-03 -->
> **MERGE TARGET 2026-09-04 (Board Collapse 03, decision 15).** *Tickets Tab Source Selection Not Sticky Across Restarts in Browser/Standalone* has been **merged into this plan and deleted**. It fixed the same broken `restoredTabState` push and the same `persistTabState` arm from a different feature.
> > 
> > Carry these two points from it: (1) **embed the restore payload in the `rootsFetched` HTTP body** as well as pushing `restoredTabState`, so the standalone browser path restores without depending on a separate push; (2) that leaves **three** entry points to keep in step — the `restoredTabState` push, the embedded body, and the pre-existing tab-state read — so route them through **one** shared restore helper in `tickets.js` rather than three call sites.
> > 
> > This plan is also the prerequisite for *Wire the Tickets sidebar collapse toggle*, which now persists through the host store rather than `vscode.setState`.


## Goal

Make the host-side panel state store the sole authority for the Tickets panel's remembered workspace root. Wire `TicketsPanelProvider` to push `restoredTabState`, fix the provider's `persistTabState` arm so root-scoped writes are actually stored root-scoped, then remove the webview-local `vscode.setState` mirror that currently shadows the host value. **Order matters and is the whole point of this plan** — reversed, it regresses persistence.

### Problem and background

Slice 2a needed the Tickets panel to remember its workspace root across a reload. The host-side path — `persistTab('tickets.root', …)` posting `persistTabState`, then the host pushing `restoredTabState` back — was only half-built: the write worked, the `restoredTabState` read-back was never wired. So 2a added a deliberate, documented bridge: mirror the value into the webview-local `vscode.setState` blob and read it first on load.

State at HEAD (line numbers re-verified 2026-08-14; the plan's original numbers had drifted and are corrected below):

| | State |
|---|---|
| `TicketsPanelProvider` pushes `restoredTabState` | **0 times** |
| `PlanningPanelProvider` pushes it | 2 push sites + 1 return-body key (`:2561`, `:2611`) — the pattern to copy |
| `DesignPanelProvider` pushes it | 1 site (`:2533`) |
| `tickets.js` local mirror | `persistTicketsRoot()` **`:397`**, mirror write **`:401–406`**, local-first read **`:8390–8392`** |
| `tickets.js` `restoredTabState` arm | present at **`:6972`** — currently dead, nothing pushes to it |

> **Superseded:** `persistTicketsRoot()` `:380`, writes at `:385`, local-first read at `:7632`, `restoredTabState` arm at `:6415`; "`PlanningPanelProvider` pushes it 3 times".
> **Reason:** `tickets.js` has grown since authoring. Every line number in the original table is stale by 17–758 lines, and `PlanningPanelProvider`'s three `restoredTabState` occurrences are two pushes plus one return-body key, not three pushes. A coder editing `:385` edits the wrong function.
> **Replaced with:** the re-verified table above.

So `tickets.js` writes the value to two stores and reads the local one first. The `restoredTabState` arm only overrides when `ticketsWorkspaceRoot` is still empty, which after the local read it never is.

### Root cause — deeper than the original plan recorded

The host push was scheduled for "a later slice" and no slice claimed it. Slice 2f was supposed to resolve the dual-write but could not, because removing the mirror without first wiring the push would have deleted the only functioning persistence path. The dependency was one-directional and nobody sequenced it.

Re-tracing the code at HEAD found **three composing defects**, not one. The original plan named only the first.

**Defect 1 — nothing pushes `restoredTabState` to the Tickets panel.** As recorded above.

**Defect 2 — `_restoredPanelState` is therefore permanently empty, so *all* per-root Tickets state restore is dead, not just the root.** `_restoredPanelState` (`tickets.js:55`) is written in exactly one place: the `restoredTabState` arm at `:6973–6974`. Nothing pushes that message, so `getRestoredState('tickets', root)` (`:77–82`) returns `undefined` on every call, forever. That makes `persistTab('tickets', state, ticketsWorkspaceRoot)` at `:4466` a **write-only** store — the panel saves its per-root list scope, filters and selection on every change and can never read any of it back. `_pendingTicketsRestore` (set at `:7060` in the `ticketsDefaultRoot` arm) is consumed only inside the same dead `restoredTabState` arm, so it is a flag that is set and never read.

**Defect 3 — the provider's `persistTabState` arm discards `workspaceRoot`, so root-scoped writes land in the panel-scoped slot.** `TicketsPanelProvider.ts:1332–1337`:

```ts
case 'persistTabState': {
    if (msg.tabKey) {
        this._stateStore.setPanelState(msg.tabKey, msg.state);
    }
    return { success: true };
}
```

`tickets.js`'s `persistTab` (`:59–74`) *does* send `workspaceRoot`. The provider ignores it. Compare `PlanningPanelProvider.ts:2617+`, which branches on `root` and calls `setRootState(tabKey, root, state)`.

This matters because the two writes use **different memento keys** (`PanelStateStore.ts`):

- `setPanelState(k, v)` → `switchboard.panelState.tickets.<k>.panel`
- `setRootState(k, root, v)` → `switchboard.panelState.tickets.<k>` (a map keyed by `path.resolve(root)`)

So today:

- `persistTab('tickets.root', root)` → `setPanelState('tickets.root', …)` → **correct**. This is the key `_migrateTicketsRootFromPlanning` writes (`:1306`) and `ticketsDefaultRoot` reads (`:1939`).
- `persistTab('tickets', state, root)` → `setPanelState('tickets', …)` → **wrong slot, and all roots collide in it**. `getAllStates(...).byRoot['tickets']` reads `getRootState('tickets', root)`, a key nothing has ever written. It will return `{}` even after Defect 1 is fixed.

**Consequence for this plan:** wiring the push without fixing Defect 3 makes `restoredTabState` arrive carrying a real `panel` payload and an empty `byRoot`. The root restore would work; per-root restore would stay dead, and the plan would report success against a goal it only half-met.

### Why it matters now

Slice 2f added a one-time migration (`TicketsPanelProvider._migrateTicketsRootFromPlanning()`, `:1292–1311`) that carries the legacy `tickets.root` across from the *planning* panel's store so existing installs keep their selection. That migration writes to the **host** store. With the local blob winning on load, a stale local value will shadow the correctly-migrated one and the migration will look like it silently no-opped — which is exactly the failure mode the migration exists to prevent.

## Metadata

**Tags:** bugfix, frontend, backend, state, reliability

**Complexity:** 6

> **Superseded:** **Complexity:** 4
> **Reason:** The plan as authored was a two-file, four-step sequencing fix — a fair 4. Re-tracing found a third defect (the provider's `persistTabState` arm collapsing root state into panel state) that must be fixed for the plan to meet its own goal, plus a behaviour flip in the `ticketsDefaultRoot` arm that the wiring triggers as a side effect. It is now a persistence-semantics change across two files with a migration interaction, a message-ordering constraint, and a shipped-install blast radius.
> **Replaced with:** **Complexity:** 6.

## User Review Required

None. The sequencing is settled, the extra defect is a strict prerequisite rather than a scope choice, and the behaviour flip has a decided resolution (see Proposed Changes → step 4).

## Approach — strictly in this order

> **Superseded:** The original three-step order — (1) wire the host push, (2) prove it, (3) remove the mirror — with (4) confirm the migration.
> **Reason:** Step 1 as written is insufficient. Pushing `restoredTabState` built from `getAllStates(tabKeys, roots)` reads root-scoped keys that the provider's `persistTabState` arm has never written (Defect 3). The push would ship with a permanently empty `byRoot`, and step 2's proof ("the root survives a reload") would pass while per-root state restore stayed dead — a green check against a goal that is only half met, which is precisely the goal-vs-appearance failure the project's engineering contracts call out.
> **Replaced with:** the five-step order below. Steps 2–5 are the original 1–4 unchanged; the new step 1 is the prerequisite that makes the original step 1 actually deliver.

1. **Fix the write path first.** Make `TicketsPanelProvider`'s `persistTabState` arm root-aware, mirroring `PlanningPanelProvider`'s:

   ```ts
   case 'persistTabState': {
       const { tabKey, workspaceRoot: root, state } = msg;
       if (tabKey) {
           if (root) {
               await this._stateStore.setRootState(tabKey, root, state);
           } else {
               await this._stateStore.setPanelState(tabKey, state);
           }
       }
       return { success: true };
   }
   ```

   Note the arm becomes `await`-ing; it already sits in an `async _handleMessage`. Note also this **changes which memento key `persistTab('tickets', …)` writes** — from `…tickets.tickets.panel` to `…tickets.tickets`. That is a deliberate clean break: the old slot was never read by anything, so there is nothing to migrate and no user-visible state to lose. Do **not** write a compat shim for it. `tickets.root` is unaffected — it is sent without a `workspaceRoot`, so it keeps taking the `setPanelState` branch and the same key the migration uses.

2. **Wire the host push.** Add a `restoredTabState` push to `TicketsPanelProvider`'s `fetchRoots` arm (`:1338–1343`), immediately **after** the existing `rootsFetched` push. Shape, matching what `tickets.js:6972` already expects:

   ```ts
   case 'fetchRoots': {
       const roots = this._getWorkspaceRoots();
       const items = buildWorkspaceItems(roots);
       const res = { type: 'rootsFetched', items };
       this._pushTo(targetPanel, 'tickets', res);

       const tabKeys = ['tickets', 'tickets.root'];
       const statePayload = this._stateStore.getAllStates(tabKeys, roots);
       this._pushTo(targetPanel, 'tickets', {
           type: 'restoredTabState',
           panel: statePayload.panel,
           byRoot: statePayload.byRoot
       });

       return { ...res, restoredTabState: statePayload, success: true };
   }
   ```

   **Push order is load-bearing.** The `restoredTabState` arm validates the restored root against `_workspaceItems` (`:6977`), and `_workspaceItems` is populated by the `rootsFetched` arm (`:6960`). Pushing `restoredTabState` first validates against an empty array, silently drops the restore, and looks exactly like "the push isn't wired".

   `restoredTabState` is also added to the **return body**, per the project PRD's return-in-body verb contract — an HTTP caller must be able to read the state without depending on the WS push.

   On `_pushTo` vs `postMessageToWebview`: in this provider they are the same thing. `postMessageToWebview` (`:205–207`) is a one-line alias for `this._pushTo(this._panel, 'tickets', message)`, and `_pushTo` (`:199–201`) ignores its panel argument entirely and calls `this._broadcaster?.push(message, surface)`. Use `_pushTo` for consistency with the surrounding arms; `push-routing:check` counts raw `webview.postMessage` calls, and neither of these is one.

3. **Prove the host path works on its own** before deleting anything. Temporarily disable the local read at `tickets.js:8390–8392`, confirm the root still survives a reload **in both hosts**, then re-enable it. If the root does not survive with the local read disabled, the push is not correctly wired and step 4 must not proceed.

4. **Remove the mirror.** Delete the `vscode.setState` write inside `persistTicketsRoot()` (`:401–406`) and the local-first read (`:8390–8392`). Keep `persistTab('tickets.root', ticketsWorkspaceRoot)` at `:398` — that is the surviving write. Update the comments at `:388–395`, `:399–400` and `:8387–8389`, which currently describe the bridge as intentional and temporary; leaving them makes the next reader think the mirror is still there.

   **Handle the behaviour flip this wiring causes.** In the `ticketsDefaultRoot` arm (`tickets.js:7030`) the tail branches are:

   ```js
   const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
   if (restoredState) { restoreTicketsStateForRoot(restoredState); loadActiveTicketSource(); }
   else if (Object.keys(_restoredPanelState.byRoot).length > 0) { ticketsLoadedOnce = false; loadActiveTicketSource(); }
   else { _pendingTicketsRestore = true; }
   ```

   Today `_restoredPanelState.byRoot` is `{}` so the third branch runs and `_pendingTicketsRestore` is set and never read — the panel loads nothing on this path. Once the push is wired the second branch becomes reachable **even with no stored state**, because `getAllStates` unconditionally seeds `byRoot[tabKey] = {}` for every requested `tabKey` (`PanelStateStore.ts:35`) — so `Object.keys(...).length` is `2`, not `0`, on a completely fresh install. `loadActiveTicketSource()` will now fire where it previously did not. **This is the correct outcome** (a panel that has resolved a root should load its source) and it is what the first branch already does, so no guard is needed — but it is a real behaviour change on a shipped surface, it must be exercised in manual verification, and it must not be mistaken for a regression. Do **not** "fix" it by testing `byRoot` for non-empty inner maps; that would reintroduce the dead-load path.

5. **Confirm the migration is no longer shadowed.** With the mirror gone, `_migrateTicketsRootFromPlanning()`'s value is the only candidate on a fresh upgrade.

### Do not

- Do **not** remove the mirror before step 3 passes. That is the one sequencing mistake this plan exists to prevent, and it silently resets every user's ticket workspace selection on reload.
- Do **not** touch `PlanningPanelProvider`'s `restoredTabState` sites — the Artifacts panel's own tab state depends on them.
- Do **not** delete the `case 'restoredTabState':` arm from `tickets.js`. `src/test/tickets-sidebar-list-scoping.test.js:21` asserts the literal string `case 'restoredTabState':` is present in the file. The arm is being *brought to life*, not removed — but a coder tidying "dead" arms will trip this.
- Do **not** change the `tickets.root.migrated` marker semantics. It is deliberately write-once so a user who clears their selection is never re-seeded from the stale planning value.
- Do **not** add a compat shim for the `tickets` per-root memento key change in step 1. Nothing has ever read the old slot.

## Complexity Audit

### Routine

- Adding the `restoredTabState` push — a direct copy of an existing, working pattern in two sibling providers.
- Making the `persistTabState` arm root-aware — a direct copy of `PlanningPanelProvider`'s arm.
- Deleting six lines of mirror code and updating three comment blocks.

### Complex / Risky

- **Sequencing.** Steps 1→2→3→4 are a strict chain. Doing 4 before 3 passes silently resets every user's ticket workspace selection on reload; doing 2 without 1 ships a permanently empty `byRoot` and a half-met goal.
- **Two hosts seed webview state through different code.** Editor: `injectInitialWebviewState` + the `<meta name="sb-initial-state">` seed (`tickets.js:30–37`). Standalone/browser: `transport.js`'s `vscode` shim. Passing in one proves nothing about the other — this is why step 3 is explicitly a both-hosts check.
- **Migration interaction.** The mirror is what currently shadows a correctly-migrated value; the whole point of removing it is to unblock `_migrateTicketsRootFromPlanning`. Getting the order wrong makes the migration look like it works when it doesn't, or vice versa.
- **Broadcast, not targeted delivery.** `_pushTo` ignores its panel argument and broadcasts to every connected Tickets surface (editor webview + all browser tabs). `restoredTabState` carries no `workspaceRoot` stamp, so it is not covered by the `_stampReply` cross-talk defence documented at `TicketsPanelProvider.ts:209–217`. Assessed and accepted: the receiving arm acts only when `ticketsWorkspaceRoot` is falsy, and the payload is panel-scoped globalState identical for every surface. Re-check this if the arm ever gains a branch that runs with a root already set.
- **Shipped install base (~4,000).** `tickets.root` under the planning store is shipped state and must keep migrating. The `tickets` per-root key is *not* — it has never been readable — so it takes a clean break.

## Edge-Case & Dependency Audit

### Race Conditions

- **Message ordering, `rootsFetched` before `restoredTabState`.** Both go through the same `_pushTo` → broadcaster path from the same synchronous arm, so order is preserved on a given connection. Do not reorder them, and do not move the `restoredTabState` push into a separate async continuation where ordering stops being guaranteed.
- **`ticketsDefaultRoot` vs `restoredTabState` arrival order.** These originate from different verbs and can interleave. Both are guarded on `!ticketsWorkspaceRoot`, so whichever lands first wins and the second is a no-op — safe in either order. `_pendingTicketsRestore` becomes genuinely reachable once the push is wired: `ticketsDefaultRoot` first sets it, `restoredTabState` then consumes it at `:6986–6992`. That path has never executed before; exercise it.
- The browser host's WS resync window is a known race for `fetchRoots`-time pushes (documented in `planning.js:4165–4172`). The return-body copy of `restoredTabState` added in step 2 is the mitigation — it rides the HTTP response and cannot lose the race.

### Security

- No new surface. The payload is the panel's own persisted state, already reachable by the same webview.

### Side Effects

- `persistTab('tickets', state, root)` starts writing a different memento key. Intentional, no migration (see step 1).
- `loadActiveTicketSource()` begins firing on a `ticketsDefaultRoot` path where it previously did not (see step 4). Intentional.
- Adding a push site changes the generated verb catalog — run `catalog:generate` **last**.
- `_pendingTicketsRestore` transitions from write-only to a live flag.

### Dependencies & Conflicts

- **No file overlap with the sibling subtask.** This plan edits `tickets.js` and `TicketsPanelProvider.ts`. The sibling (`tickets-panel-7-sweep-dead-ticket-code-from-planning`) edits `planning.js`, `planning.html`, `PlanningPanelProvider.ts`. Disjoint — safe to run in parallel under the project's one-agent-stream-per-provider-file rule.
- **The one shared concept is the legacy `tickets.root` value under the planning store.** The sibling deletes `planning.js`'s code that *wrote* it; this plan's migration *reads* it. No conflict: the migration reads the memento key `switchboard.panelState.planning.tickets.root.panel` directly via `new PanelStateStore(this._context.globalState, 'planning')` (`:1297–1298`), not via any payload the sibling touches. Deleting a writer does not erase values already persisted on shipped installs — and those installs are the entire population the migration exists to serve.
- **The sibling must not add any cleanup that clears the legacy planning-store value.** It does not, and its plan says so explicitly. If that ever changes, this migration breaks for every user who has not yet upgraded past it.

## Dependencies

- No prior agent sessions to reference; this plan was authored standalone and re-verified against HEAD on 2026-08-14.
- Sibling subtask `tickets-panel-7-sweep-dead-ticket-code-from-planning` — related by the legacy `tickets.root` value only, not by file. No ordering constraint in either direction.

## Adversarial Synthesis

Key risks: (1) removing the mirror before the host path is proven, which silently resets every user's ticket workspace selection on reload; (2) wiring the push without first making `persistTabState` root-aware, which ships an always-empty `byRoot` and a plan that passes its own check while per-root restore stays dead; (3) validating the restored root against an empty `_workspaceItems` by pushing `restoredTabState` before `rootsFetched`. Mitigations: the five-step order is mandatory and step 3 is a hard gate on step 4; `byRoot` must be asserted non-empty for a root that has stored state, not merely present; the two pushes stay in one synchronous arm in the stated order; and every persistence check runs in **both** hosts, because they seed webview state through entirely different code.

## Proposed Changes

### `src/services/TicketsPanelProvider.ts`

**Context.** `persistTabState` at `:1332–1337`; `fetchRoots` at `:1338–1343`; `_migrateTicketsRootFromPlanning` at `:1292–1311`; `ticketsDefaultRoot` at `:1937+`; `_pushTo` at `:199–201`; `postMessageToWebview` alias at `:205–207`. Zero `restoredTabState` occurrences today.

**Logic.** Make the write path root-aware, then add the read-back push the webview has been waiting for since slice 2a.

**Implementation.** Steps 1 and 2 of the Approach, verbatim.

**Edge cases.** `getAllStates` is synchronous and reads memento state only — safe to call inside the arm with no `await`. Keep `tabKeys` to `['tickets', 'tickets.root']`; do not copy `PlanningPanelProvider`'s thirteen-key list, which includes keys under the *planning* store that this provider cannot and should not read.

### `src/webview/tickets.js`

**Context.** Mirror write at `:401–406` inside `persistTicketsRoot()` (`:397`); local-first read at `:8390–8392`; `restoredTabState` arm at `:6972`; `ticketsDefaultRoot` arm at `:7030`; bridge comments at `:388–395`, `:399–400`, `:8387–8389`.

**Logic.** Once the host is authoritative and proven, delete the bridge and the comments that advertise it.

**Implementation.** Steps 3 and 4 of the Approach.

**Edge cases.** The `<meta name="sb-initial-state">` seed (`:30–37`) stays — it is the general webview-revival mechanism for this panel, not the ticket-root bridge. Only the `ticketsWorkspaceRoot` entry stops being written into it. Do not remove the seed block.

## Verification Plan

### Automated Tests

- `node --check src/webview/tickets.js`, `npm run compile-tests`, `npm run lint` (only `terminals.js:1013` is acceptable, and belongs to the Terminals feature).
- `npm run catalog:generate` then `npm run catalog:check` — run the regen last; adding a push site changes the catalog.
- `npm run parity:check`, `npm run push-routing:check` (`TicketsPanelProvider.ts` must stay at its ceiling — the `restoredTabState` push must go through `_pushTo`, **not** a raw `webview.postMessage`), `npm run verb-returns:check`, `npm run icons:parity`, `npm run mirror:check`.
- `npm run test:contract:panel-revival-retention` — this is the suite that covers the revival path the mirror was compensating for. It must stay green.
- `npm run test:contract:verb-engine-tickets`, `test:contract:tickets-sidebar-scoping`, `test:contract:tickets-assignee-filter`.
- Grep `case 'restoredTabState':` in `tickets.js` — must still be present (`tickets-sidebar-list-scoping.test.js:21` asserts it).
- Grep `vscode.setState` inside `persistTicketsRoot` — must return 0 after step 4.
- **Assert the body carries data, not just `success`.** Per the project PRD, a headless test must show `fetchRoots`' response body containing a populated `restoredTabState.panel['tickets.root']` for an install that has one stored. A `{success:true}` with an empty payload is the exact "reachable but not usable" failure the contract exists to catch.
- Verify by exit code, not by matching output text.

### Manual

The whole plan is a persistence change, so the manual checks are the real gate:

- **Editor host:** select a non-default workspace root in the Tickets panel, reload the window, confirm the selection survives. Repeat with the panel closed and reopened rather than reloaded.
- **Standalone host:** same at `/tickets`. The two hosts seed webview state through different code (`injectInitialWebviewState` + the `sb-initial-state` meta vs `transport.js`'s `vscode` shim), so passing in one proves nothing about the other.
- **Step 3 gate, both hosts:** with the local read at `:8390–8392` temporarily disabled, the root must still survive a reload. Do not proceed to step 4 until this passes in both.
- **Per-root state restore (new, and the proof that step 1 mattered):** on a multi-root workspace, set a distinct list/project scope and filter set on root A and on root B, reload, and confirm each root comes back with its own scope rather than sharing one. Before this plan the state was written to a single shared slot and never read back at all, so any per-root distinction surviving a reload is new behaviour.
- **The `loadActiveTicketSource()` flip:** on a fresh profile with no stored ticket state, open the Tickets panel and confirm the source loads once — not twice, and not zero times.
- **Migration check, the highest-value one:** on an install that has a `tickets.root` under the *planning* store and no tickets-store value, upgrade and confirm the Tickets panel opens on the carried-over root. Then confirm the `tickets.root.migrated` marker means a second launch does not re-seed.
- **Clear-selection check:** deliberately clear the root selection, reload, and confirm it stays cleared rather than being re-seeded from the legacy planning value.
- **Multi-surface check:** with the editor panel and a browser tab both open on Tickets, reload one and confirm the `restoredTabState` broadcast does not disturb the other's already-chosen root.
- Confirm the Artifacts panel's own tab state still restores — it shares the `restoredTabState` mechanism.

---

**Recommendation:** Send to Coder (complexity 6).
