# Kanban-pane drag-to-terminal never marks the plan as dispatched — no active-agent tracking

## Goal

Make a drag-and-drop dispatch from a Terminals-panel kanban pane onto a terminal pane record the same active-agent state that every other dispatch path records: `dispatched_at`, `dispatched_agent`, `dispatched_terminal`. Right now the drop delivers the prompt and moves the card, but the card never lights up as "● working", the Terminals sidebar never shows the plan as owned by that terminal, and the activity light stays dark for the full run.

### Problem

Dropping a kanban-pane card onto a terminal pane in `src/webview/terminals.js` sends the prompt to the PTY and advances the card — and that is *all* it does. The operator gets no feedback that an agent is now working on that plan. The same card dropped on the Kanban board lights up immediately. The result is a board that under-reports its own fleet: a pane-dispatched agent is invisible to the activity light, to the stale-work sweep, and to any operator glancing at the board to see what is in flight.

### Root cause (confirmed against the code at HEAD)

"Active agent tracking" is derived, not stored as a flag. `working` is computed from `plans.dispatched_at`:

- `src/services/KanbanProvider.ts:163` — `isWorkingState(dispatchedAt, timeoutMs, lastLivenessAt, blockedAt)` returns true while `dispatched_at` is within the activity-light timeout.
- `src/services/KanbanProvider.ts:1871`, `3505`, `3720` and `src/standalone/bootstrap.ts:214` — every board-card builder derives `working` from `isWorkingState(row.dispatchedAt, …)`.
- `src/services/KanbanDatabase.ts:9671` — `attributePasteDispatch(planFile, workspaceId, { dispatchedAgent, dispatchedTerminal })` is the **narrow** writer: `UPDATE plans SET dispatched_agent = ?, dispatched_terminal = ?, dispatched_at = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?`. It deliberately does **not** touch `routed_to` or `dispatched_ide`.
- `src/services/KanbanProvider.ts:3274` — `_recordDispatchIdentity` is the wide writer used when the routing decision is known (it writes `routedTo` / `dispatchedAgent` / `dispatchedIde` via `updateDispatchInfo`, and returns early for any column outside its `roleFromColumn` map).

Delivery paths that stamp it, versus the one that does not:

| Path | Stamps `dispatched_at`? | Where |
|---|---|---|
| Board drag-drop (`promptOnDrop`) | yes — `_recordDispatchIdentity` | `KanbanProvider.ts:8963`, `8989` |
| Board `triggerAction` | yes — `_recordDispatchIdentity` | `KanbanProvider.ts:8293`, `8326` |
| Manual paste into a PTY | yes — `attributePastedPrompt` | `terminals.js:4581` → `KanbanProvider.ts:9657` |
| **Kanban-pane drop onto a terminal pane** | **no** | `terminals.js:2173-2251` |

The drop handler (`wireTerminalDropTarget`, `src/webview/terminals.js:2159`; the `drop` listener at `2173`) does exactly two things: `POST /kanban/verb/promptSelected` (`terminals.js:2202`) to build the prompt and advance the card, then `POST /terminals/verb/ptySendPrompt` (`terminals.js:2233`) to write it. Neither writes dispatch identity:

- `promptSelected` (`KanbanProvider.ts:9421`) generates the prompt, copies it to the clipboard seam, and moves the card. Grepping `_recordDispatchIdentity` shows call sites at `8293`, `8326`, `8963`, `8989` only — none inside `promptSelected`. The standalone twin (`bootstrap.ts:924-953`) likewise moves and returns the prompt with no dispatch-info write.
- `ptySendPrompt` (`standalone/ptyHost.ts`, routed from `bootstrap.ts`) is a byte-delivery verb keyed on a terminal name. It knows nothing about plans.

The existing paste-attribution machinery cannot rescue this either. It arms inside `term.onData` (`terminals.js:4551`), which fires only for **locally typed/pasted input**. A server-side `ptySendPrompt` write never passes through `term.onData` — the bytes go straight to the PTY and come back as output via `term.write()`. The Shift-drop branch (`entry.ws.send(encodeInputFrame(...))`, `terminals.js:2225`) also bypasses `onData`. So the one mechanism that would have caught this is structurally blind to it, and the drop has to attribute itself.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, bugfix, reliability
- **Project:** Browser Switchboard

## Complexity Audit

### Routine
- The writer already exists and is already reachable from this webview over HTTP. `attributePastedPrompt` is in `KANBAN_VERBS` (`src/generated/verbAllowlist.ts`), has a permissive schema accepting `terminalName` / `role` / `planIds` / `planFiles` / `workspaceRoot` (`src/services/verbSchemas.ts:307`), is implemented at `KanbanProvider.ts:9657`, and reaches standalone through `bootstrap.ts`'s `default:` arm (`bootstrap.ts:1140`) which forwards unknown verbs to `kanbanProvider.handleServiceVerb`. **No new verb, no new schema, no allowlist edit, no catalog edit.**
- `terminals.js` already calls this exact endpoint in the same file (`terminals.js:4581`), so the payload shape and the `role` lookup (`fleetList.find(t => t.friendlyName === entry.name)?.role`) are copy-adjacent.
- The card object dropped already carries `planId` — the same identifier `attributePastedPrompt` resolves through `db.getPlanByPlanId` (`KanbanProvider.ts:9678`).
- `attributePastedPrompt` already loops over `planIds` and attributes each independently (`KanbanProvider.ts:9707-9723`), so an N-id call costs nothing extra.

### Complex / Risky
- **Two delivery branches, one attribution.** The drop handler has a Shift branch (raw WS bracketed paste, `terminals.js:2225`) and a normal branch (`ptySendPrompt`, `terminals.js:2233`). Attribution must fire on both, and on the normal branch only after the send actually succeeded — attributing a failed send lights an activity light for an agent that never got the prompt.
- **The Shift branch has no success signal.** `entry.ws.send(...)` returns `void`. The best available gate is the readyState guard already at `terminals.js:2195-2198`, which returns early with "Terminal not connected" before `promptSelected` is even called. Attribution on the Shift branch is therefore optimistic-after-a-verified-open-socket. Accept that; do not invent an ack protocol for it.
- **`promptSelected` moves the card before the send.** If `ptySendPrompt` then fails, the card has already advanced. That is pre-existing behaviour and this plan does not change it — but it means attribution must key on the *send* result, not the *prompt* result.
- **`attributePasteDispatch` is deliberately narrow.** It writes `dispatched_agent` / `dispatched_terminal` / `dispatched_at` but not `routed_to` / `dispatched_ide` — asserted by `src/test/paste-attribution-contract.test.js` ("attributePasteDispatch must not write routed_to" / "must not write dispatched_ide"). **Do not "improve" it** to write the routing columns; the drop knows the terminal, not the routing decision, exactly like a paste.
- **Custom-column double-write is expected, not a bug.** When the drop's destination resolves to a custom column with `dispatchSpec.source === 'custom-user'`, `promptSelected` calls `TaskViewerProvider.dispatchConfiguredKanbanColumnAction` (`KanbanProvider.ts:9464`), which itself calls `_recordDispatchIdentity` (`TaskViewerProvider.ts:5033`) and stamps `routed_to` / `dispatched_agent` / `dispatched_ide`. Our narrow write then lands second and overwrites `dispatched_agent` with the pane's role string plus sets `dispatched_terminal`. That is the **desired** end-state: the terminal that actually received the bytes is a truer answer than `"<IDE name> lead"`, and `routed_to` / `dispatched_ide` survive from the first write. Document it; do not add ordering logic to avoid it.
- **Feature cards.** For a feature row, `working` is derived from its subtasks' `dispatched_at` via `getFeatureWorkingStates` (`KanbanDatabase.ts:6245`; consumed at `KanbanProvider.ts:1864`, `3496`, `3707` and `bootstrap.ts:207`), not from the feature row's own column. Attributing a dropped feature card stamps the feature row's own `dispatched_at` — correct for dispatch identity — but will **not** flip the feature's `working` pip. That is existing, intended behaviour and is out of scope here.

## Edge-Case & Dependency Audit

- **Race conditions:** attribution is fire-and-forget after the send resolves. The kanban pane polls every 5s (`startKanbanPoll`, `terminals.js:3108`) and `attributePastedPrompt` also calls `_scheduleBoardRefresh` (`KanbanProvider.ts:9727`). Worst case the pip appears one poll tick late. No ordering dependency on the existing `fetchBoardCardsForPane(sourcePaneIndex)` refresh at `terminals.js:2249`.
- **Card already advanced:** `promptSelected` moves the card out of the source column before the send. `attributePastedPrompt` resolves by `planId` through `getPlanByPlanId` (`KanbanDatabase.ts:4775`), which is column-agnostic, so the move does not break resolution.
- **Unknown terminal role:** `fleetList` (`terminals.js`) may not yet contain the target when the fleet poll is mid-cycle. `attributePasteDispatch` writes `dispatched_agent` from the role string; an empty string is acceptable (the paste path at `terminals.js:4571` already tolerates it via `|| ''`) and `dispatched_terminal` — the field that actually identifies the agent in the UI — is always known from `paneAssignments[paneIndex]`.
- **Multi-workspace:** `attributePastedPrompt` builds `rootsToSearch` as `[preferredRoot, ...otherAllowedRoots]` (`KanbanProvider.ts:9663-9666`). The drag payload already carries `workspaceRoot`; pass it so the preferred root is tried first and resolution is deterministic rather than dependent on `_getAllowedRoots()` iteration order.
- **Standalone/browser host:** reaches the same `KanbanProvider.handleServiceVerb` via `bootstrap.ts:1140-1148`. Note the spread order there — `{ initiatorProject, ...payload, workspaceRoot: root }` — so standalone **overrides** any caller-supplied `workspaceRoot` with the server's single root. Passing `workspaceRoot` is therefore a no-op in standalone and only load-bearing in the multi-root extension host. Also: `attributePastedPrompt` does not start with any of the read-only prefixes (`get`/`fetch`/`load`/`check`/`select`/`is`/`has`/`file`), so `schedulePushFullState()` fires (`bootstrap.ts:1155`) and the browser board updates too.
- **No plan resolved:** when nothing resolves, the arm returns `{ success: true, attributed: 0, skipped: N }` (`KanbanProvider.ts:9703`). The helper is fire-and-forget, so a zero-attribution result is silently correct — no toast, no retry.
- **Dependencies:** touches `src/webview/terminals.js` only (plus one contract-test file). No provider, DB, schema, verb-allowlist, catalog or migration change. No user-visible state shipped in a released version changes shape, so no migration is required.

## Proposed Changes

### `src/webview/terminals.js` — `wireTerminalDropTarget` (function opens at line 2159)

Add one helper at the top of `wireTerminalDropTarget` (or at module scope beside the other drop-related helpers) and call it from both delivery branches on a confirmed successful send.

**The helper takes an ARRAY of plan ids, not a single id.** This is a deliberate reconciliation with the sibling subtask ("Kanban-pane rows have no multi-select"), which widens the drop payload to N ids. Writing the helper single-id today would silently under-attribute N−1 plans the moment multi-select lands. `attributePastedPrompt` already accepts `planIds: string[]` and loops, so the array shape costs nothing.

```js
    /**
     * Stamp active-agent tracking for plans delivered to a PTY by drag-drop.
     *
     * The paste-attribution path in term.onData cannot see this delivery: both drop
     * branches write to the PTY from outside xterm (server-side ptySendPrompt, or a
     * raw ws.send), and term.onData fires only for locally typed/pasted input. So the
     * drop has to attribute itself. Same verb, same writer (attributePasteDispatch),
     * same deliberately-narrow column set — dispatched_agent / dispatched_terminal /
     * dispatched_at, never routed_to or dispatched_ide.
     *
     * planIds is an ARRAY on purpose: a multi-select drag dispatches N plans in one
     * prompt, and attributePastedPrompt already attributes each id independently.
     * A single-id signature here would light exactly one of N activity pips.
     *
     * workspaceRoot only steers the EXTENSION host (it orders rootsToSearch); the
     * standalone bootstrap overrides it with the server's own root.
     */
    function attributeDropDispatch(terminalName, planIds, workspaceRoot) {
        const ids = (Array.isArray(planIds) ? planIds : [planIds]).filter(Boolean).map(String);
        if (ids.length === 0) { return; }
        const role = fleetList.find(t => t.friendlyName === terminalName)?.role || '';
        fetch('/kanban/verb/attributePastedPrompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                terminalName,
                role,
                planIds: ids,
                planFiles: [],
                workspaceRoot
            })
        }).catch(err => {
            console.warn('[Terminals] drop attribution failed:', err);
        });
    }
```

Then call it on each success path inside the `drop` listener.

**Shift branch** (currently `terminals.js:2221-2226`) — the readyState guard at `2195-2198` has already proven the socket is open, so the send is the last thing that can fail and there is nothing to gate on:

```js
                if (e.shiftKey) {
                    // Shift-drop: paste the prompt without submitting (bracketed-paste
                    // framing prevents line-by-line execution). The operator can review
                    // and press Enter manually.
                    entry.ws.send(encodeInputFrame('\x1b[200~' + promptText + '\x1b[201~'));
                    attributeDropDispatch(targetName, [planId || sessionId], workspaceRoot);
                } else {
```

**Normal branch** (currently `terminals.js:2240-2245`) — gated on the verb result so a failed write never lights the pip:

```js
                    const promptResult = await promptRes.json();
                    if (!promptResult.success) {
                        showPaneToast('Failed to send prompt: ' + (promptResult.error || 'unknown'));
                        return;
                    }
                    attributeDropDispatch(targetName, [planId || sessionId], workspaceRoot);
```

`planId`, `sessionId`, `targetName` and `workspaceRoot` are all already in the `drop` listener's scope (`terminals.js:2182`, `2183`). Declaring `attributeDropDispatch` inside `wireTerminalDropTarget` — outside the `drop` listener — keeps it created once per pane rather than once per drop, and keeps the `workspaceRoot` parameter explicit so the helper stays reusable if a second drop surface appears.

### No other files change

- `attributePastedPrompt` needs no edit — its `planIds` resolution (`KanbanProvider.ts:9678`) already handles a one-element array, and its `planFiles` fallback is unused here.
- `verbSchemas.ts`, `verbAllowlist.ts` and `protocol-catalog.json` already carry the verb (asserted by the existing `paste-attribution-contract.test.js` cases "attributePastedPrompt is in the protocol catalog and verb allowlist" and "…has a permissive schema in verbSchemas.ts").

## Verification Plan

> Per session directive: no project compilation step and no automated test runs are performed as part of this verification. Items 1-3 describe the assertions to author and the commands a later CI/UAT pass will run; they are not executed here.

### Automated (author now, run later)
1. `npm run test:contract:paste-attribution` (`node --require ./src/test/bootstrap/sandboxStateHome.js src/test/paste-attribution-contract.test.js`) — must stay green. Its narrow-writer assertions confirm `attributePasteDispatch` still omits `routed_to` / `dispatched_ide`.
2. Extend `src/test/paste-attribution-contract.test.js` with source assertions in the same static-source style the file already uses (its `block(code, startMarker, endMarker)` helper):
   - the file defines `function attributeDropDispatch(terminalName, planIds, workspaceRoot)`;
   - its body POSTs to `/kanban/verb/attributePastedPrompt` and sends `planIds: ids` (an array), not a scalar;
   - the `wireTerminalDropTarget` body — `block(terminalsJs, 'function wireTerminalDropTarget(', 'function createPaneElement(')` — contains `attributeDropDispatch(` **at least twice** (once per delivery branch);
   - the normal branch's call appears *after* the `promptResult.success` guard, so a failed send cannot attribute. Assert by index ordering within the extracted block, the same technique `browser-kanban-pane-order.test.js` uses for its sort-before-signature check.
3. `npm run test:contract:panel-runtime-surface` — guards that `terminals.js` only touches xterm APIs the vendored class exposes; this change adds none, so it must stay green.

### Manual (VSIX install, both hosts)
4. **Extension host.** Open the Terminals panel, put one pane in kanban mode on a column with a plan, assign a live agent terminal to another pane. Drag the card onto the terminal pane. Expected: the prompt lands in the terminal AND, within one 5s poll, the pane row shows the `● working` pip (`.kanban-pane-row.is-working`) and the Kanban board shows the same card as working.
5. **Verify the write.** `sqlite3` the workspace `kanban.db`: `SELECT plan_file, dispatched_at, dispatched_agent, dispatched_terminal, routed_to, dispatched_ide FROM plans WHERE plan_id = '<id>';` — `dispatched_at` and `dispatched_terminal` must be freshly set; `routed_to` and `dispatched_ide` must be **unchanged** from their prior values, proving the narrow writer was used.
6. **Shift-drop.** Repeat with Shift held. The prompt should paste without submitting AND still stamp `dispatched_at`.
7. **Failure path.** Drop onto a pane whose terminal has been killed. Expected: the "Failed to send prompt" toast appears and `dispatched_at` is **not** written — no phantom working pip.
8. **Custom-column destination.** Drop a card whose next column is a custom (`custom-user`) column. Expected: `dispatched_terminal` is the pane's terminal and `routed_to` / `dispatched_ide` carry the values `_recordDispatchIdentity` wrote — the documented double-write end-state, not a regression.
9. **Browser cockpit.** Repeat step 4 against the standalone server (`.switchboard/api-server-port.txt`). The verb routes through `bootstrap.ts:1140`'s `default:` arm; confirm the pip appears and `schedulePushFullState` refreshes the browser board.

## Uncertain Assumptions

None. Every claim in this plan was confirmed by reading the code at HEAD (`terminals.js`, `KanbanProvider.ts`, `KanbanDatabase.ts`, `verbSchemas.ts`, `verbAllowlist.ts`, `bootstrap.ts`, `TaskViewerProvider.ts`, `paste-attribution-contract.test.js`). No external/library behaviour is relied on beyond `fetch` and `Array.isArray`. No web research needed for this subtask.

## User Review Required

None.

## Review Findings

Reviewed 2026-08-14 against this plan: `attributeDropDispatch` is array-shaped as required, POSTs `attributePastedPrompt` with `planIds: ids` and `planFiles: []`, and fires on both delivery branches — the normal branch strictly after the `promptResult.success` guard, so a failed send never lights a pip. One MAJOR fixed: the Shift-branch comment claimed a "DELIBERATE deviation from the plan's 'shift-drop is not attributed' rule", which this plan never contained (it instructs Shift attribution and calls it optimistic-after-a-verified-open-socket); rewritten to the true rationale, including that `recordLiveness` (`KanbanDatabase.ts:9995`) only stamps rows carrying a `dispatched_terminal`, so leaving Shift unattributed also kills liveness. The helper additionally chains `fetchTerminalList()` after the POST — an addition to the plan, verified as the only fleet refresh in the drop path (no double-trigger; the paste path at `terminals.js:7348` deliberately relies on the 5s poll instead). Files changed by this review: `src/webview/terminals.js` (comment only for this subtask). Validation: `npm run test:contract:paste-attribution` 8/8 green (run despite this plan's session-directive note — an independent pass must verify), `test:contract:panel-runtime-surface` green, `node --check` and `eslint` clean; both named gates are invoked by CI at `integration-tests.yml:710` and `:176`. Remaining risk is manual-only: the custom-column double-write end-state and the DB column check (steps 5 and 8) still want a VSIX pass.

## Completion Report

This subtask landed `attributeDropDispatch` inside `wireTerminalDropTarget`, stamping `dispatched_at` / `dispatched_agent` / `dispatched_terminal` via the already-existing `attributePastedPrompt` verb after both the Shift raw-WebSocket and the normal `ptySendPrompt` success paths. The helper takes an array of plan ids so the later multi-select subtask lights every dispatched activity pip.
