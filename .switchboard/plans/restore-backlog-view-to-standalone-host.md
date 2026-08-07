# Restore the Backlog View to the Standalone (Browser) Host

## Metadata

**Complexity:** 5
**Tags:** bug, backend, standalone, parity
**Project:** Browser Switchboard

## Goal

The Backlog view — the `BACKLOG` / `NEW` toggle in the New column header — is completely dead in the standalone/browser host. The button renders (the board HTML is shared), the click posts a verb, the verb executes and mutates state on the server, and the browser UI never changes. Restore it to full parity with the extension host, and fix the shared transport defect that makes it fail, because that defect disables several other board features the same way.

### Problem analysis and root cause

There are **two independent defects**, either of which alone is sufficient to break the feature. Both must be fixed.

**Root cause 1 — `KanbanProvider.postMessage()` is a silent no-op in standalone.**

`postMessage` (`src/services/KanbanProvider.ts:2105-2120`) delivers to one of two sinks:

```typescript
public postMessage(message: any): void {
    if (this._broadcaster) { this._broadcaster.push(message); }
    else if (this._panel) { /* ...webview postMessage... */ }
}
```

`src/standalone/bootstrap.ts` constructs a `KanbanProvider` but sets **neither** `_broadcaster` (`KanbanProvider.ts:221`) nor `_panel`. Both branches are false, so the method returns having done nothing. Every `this.postMessage(...)` in every verb arm is discarded.

The `toggleBacklogView` arm (`KanbanProvider.ts:9963-9967`) depends entirely on that push:

```typescript
case 'toggleBacklogView':
    this._showingBacklog = !this._showingBacklog;
    this.postMessage({ type: 'backlogViewState', showing: this._showingBacklog });
    this.refresh();
    return { success: true, showing: this._showingBacklog };
```

The board's only listener for the flag change is `case 'backlogViewState'` (`src/webview/kanban.html:7981-7982`). In standalone that message is never emitted, so `showingBacklog` (`kanban.html:6987`) stays `false` forever.

**Root cause 2 — the board push hardcodes `showingBacklog: false`.**

Even with the push bridged, the flag would be immediately clobbered. Both state builders emit a literal:

- `pushFullState` — `bootstrap.ts:345`
- `getFullState` — `bootstrap.ts:374`

```typescript
{ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: false, routingConfig: {}, featureWorktrees, surface: SURFACES.kanban }
```

The board assigns from that payload on every update (`kanban.html:7737-7738`). And the standalone `default:` arm schedules a push after every non-read-only verb (`bootstrap.ts:1078`); `toggleBacklogView` does not match the read-only prefix list at `bootstrap.ts:1075` (`['get','fetch','load','check','select','is','has','file']`), so a `PUSH_COALESCE_MS = 40` (`bootstrap.ts:395`) push follows every toggle and re-asserts `false`.

**Why this was repeatedly missed.** The standalone `default:` arm (`bootstrap.ts:1062-1087`) delegates every unmatched verb to `kanbanProvider.handleServiceVerb`, which validates against `KANBAN_VERBS` and calls `_handleMessage` (`KanbanProvider.ts:7261-7291`). `toggleBacklogView`, `sendToBacklog` and `sendToNew` are all present in `src/generated/verbAllowlist.ts:7`. So the verbs **are** reachable, they **do** execute, and `sendToBacklog`'s `moveCardToColumn(root, sid, 'BACKLOG')` **does** persist. Any audit that checks "is the verb wired?" or "does the write land?" returns green. The failure lives entirely in the **read-back path** — the push that never fires and the payload literal that overwrites it. Future standalone-parity audits must verify the push payload carries the state, not merely that the verb is reachable.

**Scope note.** Root cause 2 is a class, not a one-off. The same two builders hardcode `routingConfig: {}`, `cliTriggersState { enabled: false }`, `columns: DEFAULT_KANBAN_COLUMNS` (raw defaults — ignores custom columns, visibility and reordering), `theme: 'afterburner'`, `repoScopeFilter: null` and `projectContextEnabled: false`. This plan fixes **backlog only**, but builds the postMessage bridge as shared infrastructure so the sibling fixes become small. The others are tracked as separate plans.

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing the `showingBacklog: false` literal with a real read in both state builders.
- Adding a public accessor for the provider's backlog flag.
- Manual UAT of the toggle, the per-card send buttons, and the drop remap.

### Complex / Risky
- **Bridging `postMessage` without double-pushing.** `bootstrap.ts` already has a coalesced push path (`schedulePushFullState`, `bootstrap.ts:399-405`) whose header comment (`bootstrap.ts:378-394`) documents that two publishers per mutation caused the board to rebuild twice. Bridging `postMessage` adds a **third** publisher. The bridge must forward provider messages verbatim to the WS without triggering another full-state rebuild, or every verb pays a redundant board read.
- **Message surface tagging.** `server.broadcastWs(msg.type, msg, msg.surface)` (`bootstrap.ts:347`) requires a `surface`. Provider `postMessage` payloads such as `{ type: 'backlogViewState', showing }` carry **no** `surface` field. An untagged broadcast either fans out to every surface or is dropped, depending on `broadcastWs`'s handling of `undefined` — this must be resolved explicitly, not left to chance. Default unknown-surface messages to `SURFACES.kanban`.
- **Scoped-payload factories.** `postMessage` accepts a **function** as well as an object (`KanbanProvider.ts:2113`) — the per-connection scoped-payload factory. A naive bridge that JSON-serialises the argument silently drops those. The bridge must render a function argument (call it with `undefined` for the singleton fallback) exactly as the `_panel` branch does.
- **`_showingBacklog` is private instance state, not persisted.** It lives on the provider (`KanbanProvider.ts:211`) and resets on restart. Standalone must read it through a new accessor rather than tracking a duplicate flag in `bootstrap.ts`, or the two diverge the moment any other arm mutates it — `createPlan` force-clears it (`KanbanProvider.ts:9944-9947`).

## Edge-Case & Dependency Audit

**Race Conditions**
- Toggle clicked twice inside the 40 ms coalesce window: the provider flag flips twice (correct final value), one push fires, and the payload now reads the live flag — so the board converges on the true state. This is only safe once root cause 2 is fixed; with the literal in place, converging is what breaks it.
- `createPlan` force-clears the flag and emits its own `backlogViewState` (`KanbanProvider.ts:9944-9947`). With the bridge in place this now reaches the browser, matching extension behaviour. Verify the New column is showing (not Backlog) after creating a plan in standalone.

**Security**
- No new endpoint, no new verb, no change to the `KANBAN_VERBS` allowlist. The bridge forwards provider-authored messages onto an already-existing localhost WS channel.

**Side Effects**
- Bridging `postMessage` makes **every** previously-swallowed provider push start arriving in the browser — status messages, state pushes, panel-focus requests. This is the intent, but it is a broad behavioural change: messages the browser has never received before will now be handled by whatever listeners `kanban.html` has registered. Sweep the board's `onmessage` switch for arms that assume an editor context (panel focus, editor reveal). `handleServiceVerb` already sets `__viaHttp: true` (`KanbanProvider.ts:7291`) so arms that would focus an editor panel "degrade to a WS push instead" — confirm that degradation covers the arms that now become reachable.
- No plan-file writes. `sendToBacklog` / `sendToNew` are column moves only.

**Dependencies & Conflicts**
- Depends on `BroadcastHub`'s interface (`KanbanProvider.ts:221`) — the cheapest bridge is a minimal `BroadcastHub`-shaped adapter over `server.broadcastWs`, reusing the existing `_broadcaster` branch rather than adding a third sink to `postMessage`. Prefer that over editing `postMessage`, which is shared with the extension host.
- Conflicts with the push-coalescing contract documented at `bootstrap.ts:378-394` if the bridge triggers a full-state rebuild.

## Dependencies

None. Self-contained; unblocks the sibling hardcoded-payload plans.

## Implementation

### 1. Give the provider a readable backlog flag

**File:** `src/services/KanbanProvider.ts`

- Add a public getter beside `_showingBacklog` (`:211`):
  ```typescript
  public get showingBacklog(): boolean { return this._showingBacklog; }
  ```
- Do **not** change `postMessage` (`:2105`) — it is shared with the extension host and its `_broadcaster` branch is already the correct seam.

### 2. Bridge provider pushes to the WS in standalone

**File:** `src/standalone/bootstrap.ts`

- Construct a minimal `BroadcastHub`-shaped adapter and assign it to the provider before first use, so `postMessage` takes its existing `_broadcaster` branch:
  - `push(message)`: render a function argument (`typeof message === 'function' ? message(undefined) : message`) to match `KanbanProvider.ts:2113`; then `server.broadcastWs(rendered.type, rendered, rendered.surface ?? SURFACES.kanban)`.
  - `setWebview(...)`: no-op in standalone (called at `KanbanProvider.ts:1549`).
- The adapter must **not** call `pushFullState` or `schedulePushFullState`. It is a pass-through only; the `default:` arm already owns post-mutation board rebuilds (`bootstrap.ts:1078`).

### 3. Stop hardcoding `showingBacklog`

**File:** `src/standalone/bootstrap.ts`

- In `pushFullState` (`:345`) and `getFullState` (`:374`), replace the literal with the live provider flag:
  ```typescript
  showingBacklog: kanbanProvider.showingBacklog,
  ```
- Both builders must change. They are near-duplicate state arrays; fixing one and not the other reproduces the bug on whichever path the client happens to take (initial `getFullState` fetch vs. subsequent `pushFullState` broadcasts).

### 4. Confirm the card-level buttons round-trip

**File:** verification only — no code change expected.

`sendToBacklog` / `sendToNew` (`KanbanProvider.ts:9969-9984`) already persist via `moveCardToColumn` and are in the allowlist, so with step 3 in place the moved card should render in the correct view. Confirm rather than assume: the buttons are rendered conditionally on `showingBacklog` (`kanban.html:6794-6798`), so they were untestable in standalone before this plan.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** Shared provider driving both hosts.
- **Logic:** Add a public `showingBacklog` getter. No behavioural change; `postMessage` untouched.
- **Edge Cases:** Getter must reflect live state, not a snapshot — other arms mutate `_showingBacklog` (`:9944`).

### `src/standalone/bootstrap.ts`
- **Context:** Standalone host — verb dispatch and WS state push.
- **Logic:** Add a `BroadcastHub`-shaped adapter wired to `server.broadcastWs` and assign it to the provider; replace the two `showingBacklog: false` literals with the provider getter.
- **Edge Cases:** Surface defaulting for untagged provider messages; function-payload rendering; must not re-enter the coalesced push.

## Verification Plan

Per `CLAUDE.md`, testing is via an installed VSIX / the running standalone host — `dist/` is not exercised in development. Verification is behavioural.

### Automated
- Add a unit test asserting the bridge adapter renders a **function** payload (the scoped-payload factory) rather than dropping or serialising it — this is the failure mode most likely to regress silently.
- Add a regression test asserting `getFullState()`'s `updateBoard` entry reflects a mutated provider backlog flag rather than a constant `false`.

### Manual (standalone host in a browser)
1. **Toggle flips the view.** Click `BACKLOG` in the New column header — the column relabels to `BACKLOG`, the button reads `NEW`, and backlog cards render. Click again to return.
2. **No clobber after the 40 ms push.** After toggling, wait ~1 s and confirm the view has not reverted — this is the specific regression of root cause 2.
3. **Pipeline buttons suppressed.** In Backlog view the four advance/prompt buttons are absent (`kanban.html:5595`), matching the extension.
4. **Send to Backlog.** With New showing, click a card's Move-to-Backlog button — the card leaves New; toggle to Backlog and confirm it is there.
5. **Send to New.** Reverse of 4.
6. **Drop remap.** In Backlog view, drag a card onto the New/Backlog column slot — it lands in `BACKLOG`, not `CREATED` (`kanban.html:7251`).
7. **createPlan force-clear.** In Backlog view, create a plan — the view snaps back to New (`KanbanProvider.ts:9944-9947`).
8. **No double board rebuild.** Instrument or log `pushFullState` and confirm one call per toggle, not two — guards the coalescing contract at `bootstrap.ts:378-394`.
9. **No collateral breakage from the bridge.** Exercise the board broadly (move cards, create a feature, complete a plan) and confirm no newly-arriving provider message produces a console error or a spurious UI action in the browser.
10. **Extension host unaffected.** Repeat 1–7 in the VS Code extension host and confirm no regression.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The literal swap is trivial, but the `postMessage` bridge touches shared transport, changes what the browser receives across the board, and has two non-obvious correctness traps (function payloads, surface tagging).
