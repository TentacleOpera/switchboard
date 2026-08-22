# Extract Agent Control into its own panel file

## Goal

Create `src/webview/agent-control.html` (+ `agent-control.js`) carrying the Agents, Teams and Prompts tabs, and serve the already-registered `agent-control` panel from it — so Agent Control is a real panel rather than a CSS-filtered projection of the kanban board. Dual-run alongside `kanban.html`'s copies; a separate plan retires those after UAT.

### Problem Analysis

`agent-control` is **already a first-class panel everywhere except where its HTML comes from**. The manifest declares it with its own label, icon and route (`headlessPanelHtml.ts:529`: `{ id: 'agent-control', label: 'Agents', icon: nav-agent-control.svg, route: '/agent-control', enabled: true }`), `shell.html` renders the icon strip from that manifest ("adding a panel route later adds a strip icon with no shell code change"), `LocalApiServer.ts:6256` serves the route, and `KanbanProvider._handleMessage` already branches on `source === 'agent-control'` (`:8960-8963`).

What it does not have is a file. Today the panel is produced by injecting an attribute into the board: `KanbanProvider.ts:13633` — `viewAttr = viewMarker === 'agent-control' ? ' data-view="agent-control"' : ''` — and then hiding most of the board with CSS: `kanban.html:2913` hides every tab button except `agents`, `teams` and `prompts`, while `:2914-2918` hides five content panes with `display: none !important`.

**The consequences of a projection rather than a panel:**

- **Everything loads.** A user opening Agent Control parses all 13,368 lines of `kanban.html`, including ~9,500 lines of script from line 3869 and 489 function definitions, to see three tabs. The board's WebSocket wiring, drag-and-drop, column rendering and dispatch logic all initialise behind `display: none`.
- **The filter is a negative selector, so every new tab is hidden by default** in the view that most needs it — the failure mode being a tab that exists, works and cannot be seen.
- **Two view modes share one DOM**, so any board-tab change can affect Agent Control and vice versa, with no boundary to test against.
- **It is the wrong side of the project's own convention.** Seven panels have a companion `.js` (`connections`, `planning`, `tickets`, `terminals`, `design`, `memo`, `project`); only `kanban.html` and `setup.html` are inline-script monoliths. A new panel should join the majority, not extend the exception.

### Root Cause

The `data-view` projection was the cheap way to get an Agents panel into the rail without splitting a 13k-line file, and it worked — so the temporary step became the shipped state. The manifest entry, route, icon and message-source branch were all built as though the panel were real, which is why the projection is invisible from every direction except the HTML itself.

## Metadata

**Complexity:** 5
**Tags:** frontend, refactor, ui, performance

## User Review Required

- **Dual-run is assumed.** The three tabs keep working in `kanban.html` until `retire-the-agent-tabs-from-kanban-html.md` removes them after a week of clean UAT. That means duplicated behaviour for that week, and the plan below chooses *extracted shared modules* over *copy-paste* to keep the duplication from becoming divergence. Confirm that trade — copy-paste is faster and strictly worse.
- Confirm the tab set is exactly Agents, Teams, Prompts, and that Orders (see `add-an-orders-tab-to-agent-control.md`) lands in the new file rather than being back-ported.

## Complexity Audit

### Routine

- The markup is **contiguous and at the end**: `agents-tab-content` (`:3187`), `teams-tab-content` (`:3275`), `prompts-tab-content` (`:3422`) run to `:3864`, immediately before `<script>` at `:3869`. ~677 lines move as a block.
- A new manifest-served file: `getPanelHtmlById` (`headlessPanelHtml.ts:533`) gains an `agent-control` case returning the new HTML instead of the board.
- Reusing `shared-tabs.css` and the existing tab-button markup pattern.

### Complex / Risky

- **The script is smaller than the file size suggests — measured, not estimated.** Of 9,501 script lines, **275 reference any of the 142 ids in the three panes (2.9%)**, and those lines fall inside **50 functions**. Better still, the code is *already namespaced by tab*: 47 distinct identifiers carry an `agentsTab*` (17), `teamsTab*` (28) or `promptsTab*` (2) prefix — `agentsTabCollectConfig`, `agentsTabSaveConfig`, `teamsTabShowGroupForm`, `teamsTabHandleIconFile`, `initPromptsTabListeners`. Ownership was drawn by whoever wrote them; this plan is mostly moving code that already declares which tab it belongs to.

  The genuinely shared set is small and identifiable: `closeModal`, `flashCopyBtn`, `removeGlow`, `handleRoleChange`, `applyRemoteControlButtonState`, `openFeatureCreateModal`. Those are the module candidates. Everything with a tab prefix moves wholesale.

  So the honest sizing is: ~677 lines of contiguous markup, ~50 functions of which most are pre-namespaced, and roughly six shared helpers to extract. That is a substantial afternoon's work with a clear boundary, not an open-ended refactor of a 13k-line file — and the earlier framing of this as an unmeasured unknown was wrong.
- **Shared helpers must be extracted, not copied.** During dual-run the same behaviour exists in two files. If it is copy-pasted, the two diverge silently and the retirement plan later deletes the *stale* copy or the *fresh* one with no way to tell. Anything used by both must become a module both import — that is what makes the week of dual-run safe rather than a fork.
- **The webview and HTTP hosts take different paths to the same file.** `KanbanProvider._getHtml(webview, 'agent-control')` (`:13591`) builds the extension-host webview with `injectInitialWebviewState` and a CSP/nonce; `_handleServePanelById` (`LocalApiServer.ts:1089`) serves the headless host through `getPanelHtml`, honouring the manifest's `enabled` flag. Both must render the new file, and the webview path must keep its state injection. A file that works in the browser and not in the panel (or vice versa) is the likely first defect.
- **`_handleMessage(msg, source?: 'agent-control')` (`:8960`) is the message contract** and must keep working unchanged from the new file. The new panel is not a new backend — it posts the same messages. Any message the three tabs send today must be enumerated and re-verified from the new file, because a silently-unhandled message in a webview fails without an error.
- **`AGENT_CONTROL_VIEW` (`:6533`) and the initial-tab resolver (`:6563-6567`) become dead** once the panel is its own file — but only after retirement. During dual-run they must keep working, so they cannot be deleted here. Leaving them is correct; deleting them early breaks the projection that is still shipping.
- **CSP and nonce.** `shell.html` mounts panels as same-origin iframes under a strict CSP (`script-src 'nonce-{{NONCE}}' 'self'`). A companion `agent-control.js` must be loaded the way the other seven companion files are, not inlined, or it is blocked in the headless host and works in the webview — a split failure that only shows in one host.

## Edge-Case & Dependency Audit

**Migration.** No user state moves. The panel id, route and label are unchanged, so a bookmarked `/agent-control` keeps working and the rail icon does not move. This is the migration-safety property that makes the extraction low-risk despite its size: nothing user-visible is renamed.

**Security.** Same CSP, same auth (`_checkAuth`, `LocalApiServer.ts:1095`), same manifest `enabled` gate. The new file must not widen `connect-src` or add an inline script. No new endpoint.

**Performance.** The point of the plan: Agent Control stops parsing and initialising the board. Worth measuring before and after so the claim is evidenced rather than asserted.

**Side effects.** During dual-run, a change to any of the three tabs must be made in both places unless it lives in a shared module — which is the argument for extracting rather than copying.

## Dependencies

- **Blocks** `add-an-orders-tab-to-agent-control.md`. Orders should land in the new file, not be added to `kanban.html` and moved later.
- **Blocked by** nothing.
- **Followed by** `retire-the-agent-tabs-from-kanban-html.md`, gated on a week of clean UAT.

## Adversarial Synthesis

**"The projection works — this is churn."** It works and it costs: a full board parse to render three tabs, a negative-selector filter that hides new tabs by default, and no boundary between two view modes sharing one DOM. The Orders tab is the immediate forcing case, and adding it to the projection means adding it twice.

**"Copy the markup and the handlers, delete later — dual-run is temporary."** A week is long enough for both copies to be edited. The retirement plan then cannot tell which is current. Extracting shared modules costs more now and is the only version where retirement is a deletion rather than a merge.

**"Split the whole of `kanban.html` while you are in there."** Out of scope and much riskier. This plan takes the three tabs that already have their own panel identity and leaves the board alone. `setup.html` is the other inline monolith and is not touched either.

**"Do it in one step — extract and delete together."** That is a single irreversible cutover on the panel a user drives agents from, with no fallback if a handler was missed. The week of dual-run exists precisely because a missed message fails silently in a webview.

## Proposed Changes

1. **Confirm the measured boundary** (already taken, see Complexity Audit): 275 script lines across 50 functions touch the three panes' 142 ids; 47 identifiers are already tab-prefixed. Verify the six shared helpers named there are the complete shared set before moving anything — the measurement bounds the work, it does not prove exhaustiveness.
2. **Create `src/webview/agent-control.html` + `agent-control.js`**, following the seven-panel companion convention rather than the inline-script exception.
3. **Move the ~677 lines of pane markup** (`:3187`–`:3864`) into the new file, keeping ids and `data-tab` values identical so the message contract and any tests keyed on them still match.
4. **Extract shared helpers into modules** imported by both files. No copy-paste of anything used by both.
5. **Point `getPanelHtmlById`'s `agent-control` case** at the new file, and make `KanbanProvider._getHtml(webview, 'agent-control')` render it with its existing state injection.
6. **Leave the projection intact** — `data-view`, the `:2913` filter, `AGENT_CONTROL_VIEW`, the initial-tab resolver — all stay until retirement.
7. **Measure load cost** before and after, so the performance claim is evidenced.

### Migration

None. Panel id, route, label and icon unchanged; `/agent-control` keeps working.

## Verification Plan

### Goal Invariants

- `/agent-control` serves `agent-control.html` in the headless host, and the extension-host panel renders the same file with state injection intact.
- Every message the three tabs sent from `kanban.html` is still sent, and still handled, from the new file.
- No behaviour used by both files exists as two copies.
- The board is not parsed or initialised when Agent Control is opened.

### Automated Tests

- **Both hosts render the new file:** assert the HTTP route and `KanbanProvider._getHtml(webview, 'agent-control')` both resolve to `agent-control.html`. Two assertions, not one — the split-host failure is the likeliest first defect and a single test hides it.
- **Message contract parity:** enumerate the message types the three panes post today and assert each is still posted from the new file and accepted by `_handleMessage` with `source: 'agent-control'`. This is the test that catches the silent failure mode, since an unhandled webview message throws nothing.
- **No duplicated logic:** assert no function body used by both files appears in both — the invariant that makes retirement a deletion.
- **Board not initialised:** assert opening Agent Control does not construct the board's column rendering or drag-and-drop. Otherwise the panel is a new file with the old cost.
- **CSP intact:** assert the new file loads its script the way the other companion panels do, with no inline script and no widened `connect-src`.
- **Projection still works:** the existing `kanban.html` Agent Control view continues to pass its current tests unchanged, since it is still shipping during dual-run.
- **Ids preserved:** assert `agents-tab-content`, `teams-tab-content`, `prompts-tab-content` and their `data-tab` values are unchanged in the new file.

### Manual Verification

- Open Agent Control from the rail in the headless host and as the extension panel; exercise each of the three tabs.
- Confirm the rail icon and label are unchanged and `/agent-control` still resolves.

## Outstanding Questions

- **[user]** Confirm extracted shared modules over copy-paste (see User Review Required).
- **Measured: 2.9% of script lines, 50 functions, ~6 genuinely shared helpers.** The residual question is only whether those six are the complete shared set, or whether a seventh is reached indirectly (a helper calling a helper). Cheap to settle by following the call graph out one level from the six before moving code.
- Does `setup.html` share any helper with these three panes? If so it becomes a third consumer of the extracted modules, which is fine but should be known before the split rather than discovered during it.
