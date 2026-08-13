# A Terminal Shows The Wrong Agent CLI Until The Panel Is Reloaded

## Goal

Make the terminals panel show the agent CLI a role actually runs, not the one it ran when the panel opened.

### The problem

Reported from UAT: *"when the agent terminals are first started, they are named by the wrong CLI. In my parent window this terminal is named Devin CLI, but when I popped out the window it corrected itself to Claude CLI."*

Both windows were right about what they knew. The parent panel was holding a stale label map; the popped-out window was a fresh panel instance that fetched a current one.

### Root cause: the cache is invalidated on key presence, not on value change

`agentNames` (`src/webview/terminals.js:151`) is fetched once in `init()` (`:1187`) and then refreshed by exactly one guard, inside the fleet-poll handler (`:1501`):

```js
// Self-heal for a custom agent added mid-session: only re-reads when
// a role turns up that the cached label map has never seen, so the
// common terminalsChanged refresh costs nothing extra.
if (fleetList.some(t => t.role && !(t.role in agentNames))) {
    await fetchAgentNames();
}
```

The comment states the intent honestly, and the guard does exactly what it says: it fires when a **new role** appears. It cannot fire when an **existing role's command changes**, because `'lead' in agentNames` is already true and stays true whatever the value becomes.

So the sequence that produces the report is entirely ordinary:

1. Panel opens. `fetchAgentNames()` (`:5841`) resolves `lead → 'Devin CLI'` from the saved startup commands, via `POST /kanban/verb/getStartupCommands`.
2. The operator edits the `lead` command in the Agents tab and saves (`kanban.html:4523` → `saveStartupCommands`).
3. Every subsequent fleet poll sees `'lead' in agentNames` → true → no refetch.
4. The sidebar keeps rendering `Devin CLI` for the rest of the panel's life.

Popping out constructs a new panel, which runs `fetchAgentNames()` from scratch — hence the "it corrected itself" half of the report. Nothing was wrong with the popped-out window; the parent had simply never been told.

### Why it is worth fixing rather than tolerating

The label is not only decoration. `brandIconForCliLabel(agentLabel)` (`:1856`) derives the per-row brand icon from this same string (`:1241`, `:1719`, `:1968`), and the starting-terminal curtain renders `Starting <agentLabel>…` (`:1712-1719`). A stale map mislabels a row, mis-ices its icon, and puts the wrong product name in front of the operator at the exact moment they are watching a terminal boot.

## Metadata

**Complexity:** 3
**Tags:** frontend, bugfix, ui

## User Review Required

None.

## Complexity Audit

### Routine

- `fetchAgentNames()` already exists, already swallows its own failures, and is already idempotent. Every new trigger is one more call to a function that is safe to call at any time.
- The inbound-message arm at `:1023` and the fleet-poll guard at `:1501` are both established patterns in this file; the change adds a case to each rather than a mechanism.
- No persisted state. `agentNames` is an in-memory cache of a config read — nothing to migrate.

### Complex / Risky

- **The push has to cross a panel boundary.** `saveStartupCommands` is a *kanban* verb handled in `KanbanProvider`; the stale cache is in the *terminals* webview. There is no direct channel between them — the fix has to ride the existing broadcast hub (`wsHub.broadcast(type, payload, 'terminals')`, the same rail `terminalWsGateway.ts:502` uses for `terminalsChanged`) and be received at `terminals.js:964`.
- **The visibility backstop does not exist in the host that filed the report.** See the superseded callout in Design — `panelVisibility` has exactly one sender in the tree and it is the browser cockpit's iframe rail.
- Push fan-out in the browser cockpit is known to be 6× per broadcast, so an un-debounced refetch on the new signal costs six `getStartupCommands` round trips per save.

## Edge-Case & Dependency Audit

### Race Conditions

- Two panels (parent + popout) refetch on the same broadcast. Both converge on the same server value, so a lost-update race is not possible — `fetchAgentNames` only ever replaces the whole map with a fresh read.
- A refetch racing a save: the push is emitted *after* the write completes, so the refetch reads the new value. A refetch that somehow lands early self-corrects on the visibility hook or the next save.
- A push arriving before `init()` finishes its first `fetchAgentNames()` results in two reads of the same value. Harmless.

### Security

- None. `getStartupCommands` is an already-allowlisted verb the panel already calls; this adds call sites, not surface.

### Side Effects

- Extra `getStartupCommands` traffic on save and on panel focus. Bounded by operator actions, not by a timer — this is the property that must not be traded away.
- Corrected labels change the brand icon on the next render (`brandIconForCliLabel` lowercases and substring-matches, `:1856-1861`). That is the intended outcome, not a regression.

### Dependencies & Conflicts

- Independent of every other subtask in this feature. It touches `terminals.js`'s label cache and one broadcast emission; no team, group, spawn or standing-order code is involved.
- Sibling subtasks also edit `terminals.js` (`LINK_PRESETS` in *Team Members Gain A Scope And A Relationship*, the standing-orders marker in *Clear The Coder Between Subtasks*). Different regions of the file, but under the project's one-stream-per-file rule they serialise against each other.

## Dependencies

- `sess_20260812190001 — agentNames cache invalidation on startup-command save`

## Adversarial Synthesis

Key risks: the fix's own backstop layer targets a message (`panelVisibility`) that only the browser cockpit emits, so the VS Code panel — the host that filed the report — is left with one new trigger rather than two; and the broadcast rail fans out ~6× in the cockpit, turning one save into six refetches unless the handler debounces. Mitigations: make the save-push the primary carrier and verify it in the VS Code panel specifically, treat the visibility hook as cockpit-only (or add an extension-side sender deliberately, as its own decision), and coalesce repeated pushes into one fetch. The failure mode of the whole change is benign by construction — `fetchAgentNames` swallows errors and never blanks the map.

## Design

### Invalidate on the event that actually changes the answer

`agentNames` is derived from the startup-commands config. The correct trigger is therefore "the startup commands were saved", not "a poll happened to notice an unfamiliar role".

Refetch when the panel is told the commands changed. The board already owns that write (`saveStartupCommands` → `KanbanProvider._saveStartupCommands`, `:4604`), so the panel needs a signal on the same broadcast rail it already uses for `terminalsChanged` rather than a new channel of its own. Wire it as an additive push — the panel keeps working if the push never arrives, because the existing guard and the fallback below still stand.

### Keep the existing guard, and add a bounded fallback

Three layers, cheapest first, none of them replacing the others:

| trigger | catches | available in |
| :-- | :-- | :-- |
| new role appears in the fleet (existing, `:1501`) | a custom agent added mid-session | both hosts |
| startup commands saved (new) | the reported case — an existing role's command edited | both hosts |
| panel becomes visible after being hidden (new) | an edit made in another window, or a push missed | **browser cockpit only** — see below |

> **Superseded:** *"The visibility hook is the cheap backstop that makes the fix robust without polling: `panelVisibility` is already an inbound message this file handles (`:997`), so a refetch on the transition to visible costs one request per panel focus and closes the multi-window case the push alone cannot."*
> **Reason:** `panelVisibility` has exactly one sender in the tree — `src/webview/shell.js:149`, the browser cockpit's iframe rail, which posts it to each panel frame from `selectPanel()`. No extension-host code emits it; a grep of `src/` returns only the `terminals.js` receiver, the `shell.js` sender, and `terminal-renderer-lifecycle-contract.test.js`. So in the VS Code panel this hook never fires — and the VS Code panel is the surface the UAT report came from (*"in my parent window…"*). Sold as *"the backstop that makes the fix robust"*, it is a backstop that is absent in the host that needs it. (The receiver line is also `:1023`, not `:997`.)
> **Replaced with:** The **save-push is the fix**; the visibility hook is a cockpit-only bonus. Wire it at `:1023` anyway — it is nearly free and genuinely closes the cockpit's multi-frame case — but do not count it as the multi-window answer, and do not let it justify a thin push. If an extension-side `panelVisibility` sender is wanted, that is a separate, deliberate change to the VS Code panel's lifecycle messaging, not a line of this bugfix. Verification step 4 below is scoped accordingly.

Do **not** refetch on every fleet poll. That is a request every five seconds per open panel for a value that changes a few times a session, and the existing comment is right to have avoided it.

### Coalesce the push

The browser cockpit fans a single broadcast out to every panel frame — the known 6× fan-out, because the transport does not filter on `msg.surface`. An un-debounced handler therefore issues six identical `getStartupCommands` calls per save. Coalesce on the receiving side: collapse pushes arriving within a short window into one fetch. A trailing-edge debounce is correct here — the last push carries the same information as the first, and the value is already written before any of them are sent.

### Keep the failure behaviour

`fetchAgentNames()` swallows errors on purpose — *"labels are decoration — a failure must not blank the sidebar"* (`:5854`). Every new call site inherits that. A refetch that fails must leave the previous map in place, never clear it.

## Implementation Notes

- `agentLabelForRole` returns `''` for three distinct no-label cases (empty map, the literal `'No agent assigned'`, and the CLI-less `shell` role — `:5865-5870`). None of them change here; a stale-value fix must not turn a legitimate blank into a label.
- The popped-out window is a separate panel instance with its own `agentNames`. After this change both instances refetch on the same push, so they converge rather than one being authoritative.
- `brandIconForCliLabel` lowercases and substring-matches the label (`:1856-1861`). A corrected label changes the icon on the next render, which is the intended outcome — confirm the icon updates with the text rather than only after a reload.
- No persisted state is involved. `agentNames` is an in-memory cache of a config read; there is nothing to migrate.
- The webview API is frozen on the editor side — do not attempt to distinguish origin by stamping an originator id on the new push; it is a silent no-op there. Every panel refetching is the intended behaviour anyway.
- `saveStartupCommands` is written from three surfaces (`kanban.html:4523`, `setup.html:2050`/`:2818`, `implementation.html:1775`/`:3555`). Emit the push from the provider-side write, not from a webview, or two of the three surfaces silently keep the bug.

## Proposed Changes

### `src/services/KanbanProvider.ts`

- **Context.** `_saveStartupCommands` (`:4604`) is the single provider-side write for every surface that edits agent CLI commands. `_getAgentNames` (used at `:4572`) is the derivation the terminals panel reads back.
- **Logic.** After the write succeeds, broadcast a "startup commands changed" signal on the `'terminals'` surface — the same rail `terminalsChanged` uses.
- **Implementation.** Emit once, after the config write completes, so any receiver that refetches immediately reads the new value. Carry no payload; the receiver refetches rather than trusting a pushed map, which keeps one derivation of the labels.
- **Edge Cases.** Emit from here rather than from each webview, so `setup.html` and `implementation.html` saves are covered too. A broadcast failure must not fail the save.

### `src/webview/terminals.js`

- **Context.** `agentNames` (`:151`), first fetch in `init()` (`:1187`), sole refresh guard (`:1501`), inbound message arm (`:964-1023`), `fetchAgentNames` (`:5841`).
- **Logic.** Two new triggers for the existing fetch; the existing guard stays.
- **Implementation.** Add a message arm for the new push that calls a debounced `fetchAgentNames()`, then re-renders the sidebar so labels and brand icons update together. Add a refetch on the `panelVisibility` → visible transition at `:1023`. Leave the `:1501` guard exactly as it is.
- **Edge Cases.** Debounce the push arm against the cockpit's 6× fan-out. Preserve `fetchAgentNames`'s swallow-and-keep behaviour at every new call site. Do not add any timer-driven refetch.

## Verification Plan

1. **The reported case.** With the terminals panel open, change the `lead` role's CLI command in the Agents tab and save. Without reloading, confirm the sidebar row's label and brand icon change to the new CLI.
2. **No reload, no popout.** Verify in the parent VS Code panel specifically — the bug is invisible if the check is done in a freshly opened window.
3. **Multi-window.** With two panels open (one popped out), save a command change from the board and confirm both converge, not just the focused one.
4. **Visibility backstop, scoped honestly.** In the **browser cockpit**, navigate away from the Terminals panel, change a command, navigate back: the label must be correct on return. Then confirm the same navigation in the VS Code panel is a no-op — `panelVisibility` is not emitted there, and step 1 is what covers that host.
5. **Fan-out is coalesced.** Save once with the cockpit open and count `getStartupCommands` requests in the network panel. One, not six.
6. **Every save surface.** Repeat step 1 for a command saved from the Setup panel, not just the Agents tab.
7. **Existing self-heal intact.** Add a custom agent mid-session and confirm a terminal with that new role still picks up its label on the next poll.
8. **Failure is silent.** Force the fetch to fail (stop the API server) and confirm the sidebar keeps its previous labels rather than blanking.
9. **No poll-rate regression.** Watch the network panel through a minute of idle fleet polling; there must be no periodic `getStartupCommands` traffic.
10. **No-label cases unchanged.** A `shell`-role terminal and a role with no assigned command still render no label and the default icon.

### Automated Tests

Per the session directive, no compilation or automated-test run is part of this pass's verification; the checks above are manual. At implementation time the natural regression guard is a contract test in the style of `terminal-renderer-lifecycle-contract.test.js` asserting that `terminals.js` refetches agent names on the new push arm and that no fetch call was added to the fleet-poll path.

## Recommendation

Complexity 3 → **Send to Intern**.

## Completion Summary

Implemented the stale agent CLI label cache fix across three files. There are two independent write paths for startup commands, and both now emit the push. In `KanbanProvider.ts`, the `saveStartupCommands` arm (kanban.html Agents tab) broadcasts a payload-free `startupCommandsChanged` signal on the `'terminals'` surface via `_broadcaster.mirrorToWs` after the config write succeeds, wrapped in a try/catch so a broadcast failure never fails the save. In `TaskViewerProvider.ts`, the same emission was added at the end of `handleSaveStartupCommands` — the shared write path for setup.html, implementation.html, and SetupPanelProvider — covering the two surfaces the KanbanProvider path does not reach; the `SURFACES` import was added for this. In `terminals.js`, a new `startupCommandsChanged` message arm calls a trailing-edge debounced (200 ms) `fetchAgentNames` + `renderSidebarList` + `renderPaneGrid` sequence, coalescing the cockpit's ~6× fan-out into one `getStartupCommands` round trip per save; the 200 ms debounce also harmlessly collapses the case if both write paths ever fire for one save. The `panelVisibility` → visible transition in the same handler calls the same debounced refetch as a cockpit-only backstop for edits made in another window or missed pushes. The existing fleet-poll self-heal guard was left exactly as-is, and `fetchAgentNames`'s swallow-and-keep failure behaviour is inherited at every new call site. No compile or automated-test steps were run per the session directive; verification is manual per the plan's 10-step checklist.

## Review Findings

Reviewed against the plan and found no defects; no code was changed for this subtask. Both provider-side write paths emit (`KanbanProvider.ts:11029` for the Agents tab, `TaskViewerProvider.ts:10933` for setup.html / implementation.html / SetupPanelProvider), both on the `terminals` surface via `mirrorToWs` and both try/catch-wrapped so a broadcast failure cannot fail the save; the receiving arm (`terminals.js:1023`) coalesces through a 200 ms trailing debounce and re-renders sidebar and grid together, and the fleet-poll self-heal guard is untouched. Confirmed the rail reaches the host that filed the report, not just the cockpit: `terminals.js` is served only through `headlessPanelHtml.ts` with the transport shim injected, and that shim re-dispatches WS frames as `MessageEvent`s into the same handler. Validation: typecheck clean, `node --check src/webview/terminals.js` clean, `terminal-renderer-lifecycle` and `pty-route-surface` contracts green. Remaining risk: the `panelVisibility` backstop stays cockpit-only, exactly as the plan's superseded callout scoped it.
