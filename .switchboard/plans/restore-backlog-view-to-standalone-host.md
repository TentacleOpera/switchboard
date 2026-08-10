# Restore the Backlog View to the Standalone (Browser) Host

## Metadata

**Complexity:** 4
**Tags:** bug, backend, reliability, performance
**Project:** Browser Switchboard

## Goal

The Backlog view — the `BACKLOG` / `NEW` toggle in the New column header — is completely dead in the standalone/browser host. The button renders (the board HTML is shared), the click posts a verb, the verb executes and mutates state on the server, and the browser UI never changes. Restore it to full parity with the extension host, and fix the shared transport defect that makes it fail, because that defect disables several other board features the same way.

### State of the tree at improve time (2026-08-07) — read this before the analysis below

Both root causes this plan originally identified have since been closed in the tree. What remains is a **third, still-live defect in the same transport**, plus the end-to-end verification this plan always owed. The original analysis is preserved below with superseded callouts, because it is the record of how this class of bug was found and it still describes the mechanism correctly.

| Original claim | State at HEAD / working tree |
|---|---|
| `bootstrap.ts` sets neither `_broadcaster` nor `_panel`, so `KanbanProvider.postMessage` is a silent no-op | **Closed.** `bootstrap.ts:639` constructs `const headlessBroadcaster = new BroadcastHub({ webview: null, apiServer: null })` and assigns it at `:705`; `kanbanProvider.setApiServer(server)` at `:1660` points it at the live WS hub (`KanbanProvider.ts:7207` → `BroadcastHub.setApiServer`). Landed 2026-07-22 (`0f2e55d6`). |
| Both state builders hardcode `showingBacklog: false` | **Closed** (uncommitted working-tree change): `bootstrap.ts:370` and `:399` now read `kanbanProvider.showingBacklog`, backed by the public getter at `KanbanProvider.ts:2109`. |
| Untagged provider pushes may be *dropped* by `broadcastWs` | **Resolved as a non-issue.** `wsHub.broadcast` delivers a push unless all three of (tagged, connection declared a surface set, tag not in it) hold — untagged reaches every connection by design (`wsHub.ts:303-316`). |
| Function (scoped-payload factory) arguments may be dropped by a naive bridge | **Resolved as a non-issue.** No bridge was written; `BroadcastHub.push` already renders factories (`broadcastHub.ts:80-91`) and `wsHub.broadcast` re-renders them per distinct declared scope (`wsHub.ts:303-338`). |
| — | **NEW, still live:** `BroadcastHub` has no headless mode. With `webview: null` and no webview ever attached, **every** push is appended to the unbounded `_pendingWebviewMessages` array and never flushed. See "Root cause 3" below. |

### Root cause 3 — the headless `BroadcastHub` queues every push forever

`BroadcastHub.push` (`src/services/broadcastHub.ts:80-91`) fans out to two targets:

```typescript
push(msg: any, surface?: string, verbHint?: string): void {
    const isFactory = typeof msg === 'function';
    const webviewMsg = isFactory ? (msg as Function)(this._webviewScope) : msg;
    if (this._target.webview) {
        this._target.webview.postMessage(webviewMsg).then(undefined, () => { /* panel closed */ });
    } else {
        this._pendingWebviewMessages.push(webviewMsg);   // ← unbounded in standalone
    }
    this.mirrorToWs(surface, msg, verbHint || webviewMsg?.type);
}
```

The `else` branch exists for the editor's initial-load ordering: messages produced before the webview is ready are queued and flushed by `setWebview` (`:57-66`) or `flushPending` (`:142-150`). **Both flush paths are gated on `this._target.webview` being truthy.** In standalone there is no webview and never will be — `KanbanProvider.ts:7166` calls `setWebview(this._panel?.webview)` with `_panel` undefined, and `:1552` calls `setWebview(null)`; neither attaches one, and `setWebview(null)` does not flush.

So the WS fan-out works correctly (which is why the backlog toggle is now expected to function), while the webview fan-out accumulates a permanent record of every message the host has ever pushed. The array grows for the life of the process with no bound and no consumer.

Two properties make this worse than a slow leak in one provider:

1. **One hub is shared by six providers.** `headlessBroadcaster` is assigned to Design (`:651`), Setup (`:656`), Tickets (`:667`), TaskViewer (via `initHeadlessVerbServing`, `:683`), Kanban (`:705`) and Planning (`:749`). Every push from all six lands in one array.
2. **The volume is driven by the coalesced push loop.** The `default:` arm schedules a board rebuild after every non-read-only verb (`PUSH_COALESCE_MS = 40`, `bootstrap.ts:420`), and provider arms post their own state messages on each refresh — so an idle-but-used `npx switchboard` accumulates continuously, and payloads include full card arrays.

`npx switchboard` is a long-running foreground process. This is exactly the kind of defect that does not show up in a ten-minute UAT and does show up as "the browser host gets slow / the node process is huge" after a working day.

### Original problem analysis and root cause — preserved, with corrections

There are **two independent defects**, either of which alone is sufficient to break the feature. Both must be fixed.

**Root cause 1 — `KanbanProvider.postMessage()` is a silent no-op in standalone.**

`postMessage` (`src/services/KanbanProvider.ts:2118-2133`) delivers to one of two sinks:

```typescript
public postMessage(message: any): void {
    if (this._broadcaster) { this._broadcaster.push(message); }
    else if (this._panel) { /* ...webview postMessage... */ }
}
```

> **Superseded:** `src/standalone/bootstrap.ts` constructs a `KanbanProvider` but sets **neither** `_broadcaster` nor `_panel`. Both branches are false, so the method returns having done nothing. Every `this.postMessage(...)` in every verb arm is discarded.
> **Reason:** No longer true at HEAD. `bootstrap.ts:639` constructs a shared `BroadcastHub` and `:705` assigns it to `(kanbanProvider as any)._broadcaster`; `:1660` calls `kanbanProvider.setApiServer(server)`, which forwards to `BroadcastHub.setApiServer` (`KanbanProvider.ts:7207`) so the hub's WS fan-out has a live target. The `_broadcaster` branch is taken, and `mirrorToWs` reaches `LocalApiServer.broadcastWs` → `wsHub.broadcast`.
> **Replaced with:** Provider pushes DO reach the browser in standalone. The residual transport defect is not delivery but retention — see Root cause 3: the same `push()` also appends every message to an unbounded queue that is never drained headlessly.

The `toggleBacklogView` arm (`KanbanProvider.ts:10005-10010`) depends entirely on that push:

```typescript
case 'toggleBacklogView':
    this._showingBacklog = !this._showingBacklog;
    this.postMessage({ type: 'backlogViewState', showing: this._showingBacklog });
    this.refresh();
    return { success: true, showing: this._showingBacklog };
```

The board's only listener for the flag change is `case 'backlogViewState'` (`src/webview/kanban.html:8099`). The delivery chain is now complete end to end: `postMessage` → `BroadcastHub.push` → `mirrorToWs(undefined, msg, 'backlogViewState')` → `broadcastWs` → `wsHub.broadcast` (untagged → all connections) → `transport.js` unwraps the `{type, seq, surface, payload}` envelope into the legacy `postMessage` shape (`src/webview/transport.js:195-201`) → the board's `message` listener (`kanban.html:7577`).

**Root cause 2 — the board push hardcodes `showingBacklog: false`.**

> **Superseded:** Even with the push bridged, the flag would be immediately clobbered. Both state builders emit a literal `showingBacklog: false` (`pushFullState` / `getFullState`), and the standalone `default:` arm schedules a `PUSH_COALESCE_MS = 40` push after every non-read-only verb — `toggleBacklogView` does not match the read-only prefix list — so the literal is re-asserted ~40 ms after every toggle.
> **Reason:** Closed in the working tree. `bootstrap.ts:370` and `:399` now read `showingBacklog: kanbanProvider.showingBacklog` (and `showingDispatch: kanbanProvider.showingDispatch`), backed by public getters added at `KanbanProvider.ts:2109` and `:2114`. The coalesced push now converges on the true flag instead of reverting it.
> **Replaced with:** No work remains for `showingBacklog` itself. The *class* this defect belongs to is still live for every other field in the same two arrays and is owned by `standalone-state-builders-delegate-to-getfullstatemessages.md`.

**Why this was repeatedly missed.** The standalone `default:` arm delegates every unmatched verb to `kanbanProvider.handleServiceVerb`, which validates against `KANBAN_VERBS` and calls `_handleMessage`. `toggleBacklogView`, `sendToBacklog` and `sendToNew` are all present in `src/generated/verbAllowlist.ts:7`. So the verbs **are** reachable, they **do** execute, and `sendToBacklog`'s `moveCardToColumn(root, sid, 'BACKLOG')` **does** persist. Any audit that checks "is the verb wired?" or "does the write land?" returns green. The failure lived entirely in the **read-back path** — the push that never fired and the payload literal that overwrote it. Future standalone-parity audits must verify the push payload carries the state, not merely that the verb is reachable. *(This paragraph remains exactly correct and is the reason `standalone-push-parity-guard.md` exists.)*

**Scope note.** Root cause 2 is a class, not a one-off. The same two builders hardcode `routingConfig: {}`, `cliTriggersState { enabled: false }`, `columns: DEFAULT_KANBAN_COLUMNS` (raw defaults — ignores custom columns, visibility and reordering), `theme: 'afterburner'`, `repoScopeFilter: null` and `projectContextEnabled: false`. That class is now owned in full by `standalone-state-builders-delegate-to-getfullstatemessages.md`.

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a headless mode to `BroadcastHub` so the webview fan-out is skipped rather than queued.
- Manual UAT of the toggle, the per-card send buttons, and the drop remap.

### Complex / Risky
- **The queue is load-bearing in the editor.** `_pendingWebviewMessages` exists so messages produced before `resolveWebviewView`/panel creation survive to the webview (`broadcastHub.ts:57-66`, `:142-150`). The fix must suppress queueing **only** when the hub can never acquire a webview — it must not weaken initial-load ordering in the extension host, which serves ~4,000 installs. A blanket "drop when no webview" change breaks the editor's cold-start path.
- **Choosing the signal for "headless".** Candidates: an explicit constructor flag on `BroadcastTarget` (e.g. `headless: true`, set at `bootstrap.ts:639`); a bounded ring buffer that caps the queue regardless of host; or treating an explicit `webview: null` (as opposed to `undefined`) as "never expects one". The explicit flag is the only one that states intent at the call site rather than inferring it — prefer it, and have the standalone composition root be the single place that sets it. A cap alone leaves a permanent multi-megabyte retention with no owner.
- **Six providers share one hub instance.** Whatever flag is chosen is set once at `bootstrap.ts:639` and covers Design, Setup, Tickets, TaskViewer, Kanban and Planning. Verify no provider depends on `pendingCount`/`flushPending` in a headless path before changing the behaviour under them.
- **`_showingBacklog` is private instance state, not persisted.** It lives on the provider (`KanbanProvider.ts:211`) and resets on restart. Standalone reads it through the public getter (`:2109`) rather than tracking a duplicate flag in `bootstrap.ts`, so the two cannot diverge when another arm mutates it — `createPlan` force-clears it (`KanbanProvider.ts:9982-9985`). This is already correct in the tree; the verification below guards it.

## Edge-Case & Dependency Audit

**Race Conditions**
- Toggle clicked twice inside the 40 ms coalesce window: the provider flag flips twice (correct final value), one push fires, and the payload reads the live flag — so the board converges on the true state.
- `createPlan` force-clears the flag and emits its own `backlogViewState` (`KanbanProvider.ts:9982-9985`). With the bridge live this reaches the browser, matching extension behaviour. Verify the New column is showing (not Backlog) after creating a plan in standalone.

**Security**
- No new endpoint, no new verb, no change to the `KANBAN_VERBS` allowlist. Suppressing an in-process queue removes retained data; it does not expose any.

**Side Effects**
- Every previously-swallowed provider push now arrives in the browser — status messages, state pushes, panel-focus requests. This is the intent, but it is a broad behavioural change that has **already landed** and has never been swept. Audit the board's `message` switch (`kanban.html:7577-…`, ~60 `case` labels) for arms that assume an editor context (panel focus, editor reveal). `handleServiceVerb` sets `__viaHttp: true` (`KanbanProvider.ts:7291` region) so arms that would focus an editor panel degrade to a WS push instead — confirm that degradation covers the arms that became reachable.
- Untagged provider pushes reach **every** subscribed surface, not just the board (`wsHub.ts:303-316`). That is documented as intentional, but it means board-only messages are delivered to the Project, Design and Setup panels in the browser. Note whether any of those panels has a colliding `case` label; if so, that is a separate finding, not this plan's fix.
- No plan-file writes. `sendToBacklog` / `sendToNew` are column moves only.

**Dependencies & Conflicts**
- Touches `src/services/broadcastHub.ts`, which the extension host shares. Behaviour-preserving for the editor is a hard requirement (PRD contract #2, byte-compatibility on shipped installs).
- No line-level conflict with `standalone-state-builders-delegate-to-getfullstatemessages.md` beyond the single `bootstrap.ts:639` construction site.

## Dependencies

None. Independent of the state-builder delegation plan; both are verified by `standalone-push-parity-guard.md`'s baselines.

## Adversarial Synthesis

**Risk Summary.** The delivery half of this plan is already done, so the remaining risk is concentrated in one shared file: `broadcastHub.ts` serves ~4,000 installed extension hosts, and its pending-message queue is load-bearing for editor cold-start ordering. A fix that suppresses queueing on "no webview present" rather than on "this host will never have a webview" trades an invisible standalone leak for a visible editor regression. Mitigations: gate on an explicit headless flag set once at the standalone composition root; leave the editor path byte-identical; assert both behaviours in tests rather than reasoning about them.

## Proposed Changes

### `src/services/broadcastHub.ts`
- **Context:** Shared host→UI broadcast abstraction; six standalone providers share one instance, and every extension provider owns one.
- **Logic:** Add an explicit headless mode to `BroadcastTarget`. When set, `push` and `pushWebviewOnly` skip the `_pendingWebviewMessages` append entirely and rely solely on the WS fan-out. `setWebview`/`flushPending` remain unchanged for the editor.
- **Edge Cases:** Must not alter editor behaviour in any way — the pre-webview queue and its flush-on-ready are required for initial-load ordering. `pushWebviewOnly` in headless mode has no target at all: decide explicitly whether it drops (correct — the message is webview-internal by definition, e.g. `switchToTab`) and comment the decision.

### `src/standalone/bootstrap.ts`
- **Context:** Standalone composition root; the single construction site for the shared hub.
- **Logic:** Construct `headlessBroadcaster` (`:639`) in headless mode.
- **Edge Cases:** This is the only place the flag should be set; no provider should infer it.

## Verification Plan

Per `CLAUDE.md`, testing is via an installed VSIX / the running standalone host — `dist/` is not exercised in development. This session skips compilation and automated test execution; the automated checks below are specified for the implementing change, not run here.

### Automated (to be added by the implementing change)
1. A headless-mode hub retains nothing: after N pushes with no webview, `pendingCount` is 0 and every push was mirrored to the WS target.
2. A non-headless hub with no webview yet still queues and then flushes on `setWebview(webview)` — the editor cold-start contract, asserted so the fix cannot silently take it out.
3. A **function** payload (the scoped-payload factory) is rendered, not dropped or serialised, on both the headless and editor paths.
4. `getFullState()`'s `updateBoard` entry reflects a mutated provider backlog flag rather than a constant `false`.

### Manual (standalone host in a browser)
1. **Toggle flips the view.** Click `BACKLOG` in the New column header — the column relabels to `BACKLOG`, the button reads `NEW`, and backlog cards render. Click again to return.
2. **No clobber after the 40 ms push.** After toggling, wait ~1 s and confirm the view has not reverted.
3. **Pipeline buttons suppressed.** In Backlog view the four advance/prompt buttons are absent, matching the extension.
4. **Send to Backlog.** With New showing, click a card's Move-to-Backlog button — the card leaves New; toggle to Backlog and confirm it is there.
5. **Send to New.** Reverse of 4.
6. **Drop remap.** In Backlog view, drag a card onto the New/Backlog column slot — it lands in `BACKLOG`, not `CREATED`.
7. **createPlan force-clear.** In Backlog view, create a plan — the view snaps back to New (`KanbanProvider.ts:9982-9985`).
8. **No double board rebuild.** Instrument or log `pushFullState` and confirm one call per toggle, not two — guards the coalescing contract at `bootstrap.ts:403-419`.
9. **Retention.** Drive the board for a few minutes (moves, toggles, refreshes), then inspect the hub's `pendingCount` (or heap) and confirm it is not growing. Before the fix this number rises monotonically; after it, it stays at 0.
10. **No collateral breakage from the now-live bridge.** Exercise the board broadly (move cards, create a feature, complete a plan) and confirm no arriving provider message produces a console error or a spurious UI action in the browser — including in the non-board panels, which receive untagged pushes.
11. **Extension host unaffected.** Repeat 1–7 in the VS Code extension host, and specifically confirm a cold panel open still renders fully (the pending-queue path).

## Recommendation

Complexity 4 → **Send to Coder.** The remaining change is small and well-bounded, but it lands in a file shared with ~4,000 installed extension hosts, so the editor's pre-webview queue must be provably untouched.

## Completion Summary

Added an explicit `headless` flag to `BroadcastTarget` in `src/services/broadcastHub.ts`. When set, `push` skips the `_pendingWebviewMessages` append (the queue is load-bearing only for the editor's pre-webview cold-start ordering; in a headless process it grows unbounded — one shared hub, six providers, driven by the 40 ms coalesced push loop). `pushWebviewOnly` drops entirely in headless mode (webview-internal messages like `switchToTab` are meaningless without a sidebar). `setWebview`/`flushPending` remain unchanged — in headless mode the queue is empty so flush is a no-op. The editor path is byte-identical: `headless` is undefined → `!undefined` = true → queueing works as before. Constructed `headlessBroadcaster` with `headless: true` at the standalone composition root (`bootstrap.ts:714`). Files changed: `src/services/broadcastHub.ts`, `src/standalone/bootstrap.ts`.

## Review Findings

The hub change itself is correct and was kept as-is: the editor path is provably byte-identical (`headless` undefined → `!undefined` → queue as before), and both `pushWebviewOnly` call sites are `_panel`-guarded (`KanbanProvider.ts:7498`, `DesignPanelProvider._postReply`'s `'webview'` channel), so headless dropping is right rather than lossy. One MAJOR fixed: the plan's `### Automated` items 1–3 were specified but never implemented, leaving the plan's own stated dominant risk — an editor cold-start regression on a file shared by ~4,000 installs — asserted by reasoning alone. Added `src/test/broadcast-hub-headless-contract.test.js` (7 assertions: headless retains nothing and still reaches WS, `pushWebviewOnly` drops without WS mirroring, the editor queues-then-flushes in push order, an absent flag still queues, and factory payloads render correctly on the headless, bound-webview and queued-then-flushed paths), registered as `test:contract:broadcast-hub-headless` and wired into `.github/workflows/integration-tests.yml` — a check defined but not invoked by CI is the green-while-incomplete hole this feature exists to close. Validation: 7/7 pass; `standalone-parity:check` now also asserts the `headless: true` declaration so the flag cannot be silently dropped. Remaining risk: automated item 4 and the 11-step manual UAT (toggle, send-to-backlog, drop remap, retention, extension-host regression) still require a running standalone host and were not executed here.
