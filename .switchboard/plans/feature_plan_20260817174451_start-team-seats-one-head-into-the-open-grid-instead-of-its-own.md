# START TEAM Seats One Head Into Whatever Grid Is Open Instead of Opening the Team's Own Grid

## Goal

Make the terminals panel's `START TEAM` button seat the whole team in its own grid — head plus every member, sized by the team's registered layout — exactly as a team auto-started by creating its head role already does. Today it drops a single head terminal into whichever pane happens to be focused, in whatever layout is already on screen, and leaves every member unseated and invisible.

### Problem analysis and root cause

Two independent gaps compose. Both are in the START-TEAM path only; the correct seating code already exists and is already used by the other team-start path.

**1. The `ptyStartTeam` response never carries the team's group id.**

`wireSpawnedTeam` registers a terminals group for every started team and returns its id (`src/services/teamWiring.ts:1038-1079`). Its header comment is explicit about why (`:866-873`):

> The terminals-group id registered for this team. Returned so the create response can hand it to the webview verbatim — the id formula below is NOT to be duplicated client-side, where it would drift silently and the grid would fail to seat the team with no error anywhere.

The `ptyCreateTerminal` path honours that: `TaskViewerProvider.ts:3081` sets `result.teamGroupId = wired.groupId`, and the standalone host does the same at `bootstrap.ts:1402`. A contract test pins both (`src/test/team-autostart-workspace-scope.test.js:187-196`, "both hosts reference wired.groupId").

The `ptyStartTeam` path does not. Both hosts route it through `instantiateAgentGroupCore` — extension: `ptyStartTeam` → `startTeamForWorkspace` (`TaskViewerProvider.ts:2791-2811`, `:11808-11848`) → `startTeamById` → `instantiateAgentGroup` → core; standalone: `ptyStartTeam` → `startAgentGroupById` → the instantiator registered at `bootstrap.ts:2157-2196` → core. And the core discards the id (`src/services/agentGroupInstantiation.ts:123-139`):

```ts
const wired = await wireSpawnedTeam({ db, settings: opts.settings, headName, children: workers, … });
if (!wired.ok) { return { success: true, created, workers, delegateError, error: `Terminals created but team wiring failed: ${wired.error}` }; }
return { success: true, created, workers, delegateError: result.delegateError || undefined };
//      ^ wired.groupId is computed, returned by wireSpawnedTeam, and dropped here.
```

`InstantiateAgentGroupResult` (`:57-63`) has no `teamGroupId` field at all.

**2. `startTeam()` seats one terminal into the focused pane instead of switching to the team's group.**

`src/webview/terminals.js:6825-6842` ends the success path with:

```js
await fetchTerminalList();
if (headName) { assignToFocusedPane(headName); }
```

`assignToFocusedPane` (`:3688-3707`) drops any active group lock and places **exactly one** terminal into the currently focused pane. It does not grow the layout and knows nothing about members. So: one head appears where the caret was, the grid stays whatever size it already was, and the members exist only as sidebar rows. That is the reported behaviour — "it simply tries to amend it to whatever grid is open at the time".

The correct branch is fifteen lines up the file, on the `ptyCreateTerminal` path (`:6642-6658`):

```js
let seatFallbackReason = null;
if (delegates.length === 0) {
    assignToFocusedPane(data.terminal.friendlyName);
} else if (data.teamGroupId && await switchToTeamGroup(data.teamGroupId, data.terminal.friendlyName)) {
    // Seated by the group lock — sized by the group's stored layout …
} else {
    seatFallbackReason = data.teamGroupId ? 'its group did not load' : 'no group was registered';
    seatTeamWithoutGroup(data.terminal.friendlyName, delegates);
}
```

`switchToTeamGroup` (`:6683-6689`), `seatTeamWithoutGroup` (`:6725-6761`) and `focusSeatedTerminal` (`:6702-6709`) are all already written, already commented, and already used — by one caller. `startTeam` was added later and never got the branch.

**Root cause in one line:** the seating contract ("the backend returns the group id, the webview switches to it") was implemented for the auto-start-on-head-role path and not for the explicit START TEAM path, and the response field it depends on is dropped one layer below both hosts.

**Blast radius.** One shared service file (`agentGroupInstantiation.ts`, which both hosts call — so one edit satisfies the both-hosts rule) and one webview file (`terminals.js`). No DB change, no config change, no new verb, no new HTTP surface.

## Metadata

**Complexity:** 4
**Tags:** bugfix, frontend, backend, ui
**Project:** Browser Switchboard

## Complexity Audit

### Routine

- Adding `teamGroupId?: string` to `InstantiateAgentGroupResult` and returning `wired.groupId` on the success path.
- Replacing four lines at the end of `startTeam()` with the three-branch seating block that already exists on the create path.

### Complex / Risky

- **`switchToTeamGroup` must not be reordered.** Its own comment (`terminals.js:6678-6681`) says the reload must precede the switch, because `switchToGroup` calls `saveLayoutSettings()`, which writes the WHOLE in-memory `terminalGroups` array back and would clobber the group the backend just registered. Call it as-is; do not inline it.
- **`assignToFocusedPane` must NOT be called on the team branch.** It drops the group lock (`:3704-3707`), which would undo the seating on the next reconcile — the `keepLock` contract that `terminal-sidebar-groupings-contract.test.js` pins. `focusSeatedTerminal` exists precisely to move the caret without dropping the lock.
- **The zero-member case must stay on `assignToFocusedPane`.** `wireSpawnedTeam` returns no `groupId` when there are no children (`teamWiring.ts:902-911`; pinned by `team-autostart-workspace-scope.test.js:174-185`), and a member-less team is a legitimate state — the shipped seed is one (`SEEDED_AGENT_GROUP`, `teamWiring.ts:222-227`). Switching a one-terminal "team" into a group lock would be a regression in the other direction.
- **`reportTeamStart` is NOT reusable verbatim here.** It reads `data.wiringError` (`:6779`), which is the field the *create* path sets (`TaskViewerProvider.ts:3073`). `instantiateAgentGroupCore` reports a wiring failure as `success: true` plus `error` (`agentGroupInstantiation.ts:124-132`), which `startTeam` already surfaces at `:6839-6842`. Keep `startTeam`'s existing toasts and add only the seat-fallback line; do not swap in `reportTeamStart` and assume the fields line up.
- **Do not re-derive the group id client-side.** The formula lives in `wireSpawnedTeam` and the header comment forbids duplicating it. If `teamGroupId` is absent, the fallback is `seatTeamWithoutGroup`, not a locally-computed `'team_' + headName`.
- **Both hosts, one edit.** Because `ptyStartTeam` funnels through `instantiateAgentGroupCore` on both hosts, the single change there covers extension and standalone. The existing "both hosts reference `wired.groupId`" test already passes on source text and stays green; the new coverage must assert the *returned field*, not another source-text grep.
- **No confirm gate, no new control.** This changes what an existing button does after it succeeds.

## Edge-Case & Dependency Audit

**Members not yet in `fleetList`.** `getGroupMembers()` filters a group's stored names through a liveness set built from `fleetList`; seating before the list refresh resolves the team to its head alone (`terminals.js:6636-6640`). `startTeam` already awaits `fetchTerminalList()` before seating, so the ordering is already correct — keep the await ahead of the branch.

**Shared-scope members reuse a live terminal.** `spawnDelegates` returns an existing handle for a shared member rather than spawning (`ptyFleetService.ts:485-491`), so that name may already be seated in another group. `switchToGroup` rebuilds `paneAssignments` from the group's members, so the terminal simply appears in this team's grid too; nothing double-seats.

**Team larger than the current window.** The group's stored `layout` comes from `layoutForTeamSize` (`teamWiring.ts:110-115`), capped at `3x3`. `applyLayoutFloor` may drop to a smaller rendered layout in a narrow window and page the rest — that is existing, correct behaviour and is why `seatActiveGroupPage` exists. No change.

**Operator-authored layout survives.** `mutateTerminalGroups`'s upsert preserves an existing group's `layout` when it is in `TERMINALS_LAYOUT_MODES` (`teamWiring.ts:1063-1065`), including `'2v'`, which the auto-pick ladder deliberately omits. Restarting a team must not revert an operator's chosen layout — this is already handled host-side and the client change does not touch it.

**Wiring failed but terminals exist.** `instantiateAgentGroupCore` returns `success: true` with an `error` and no `teamGroupId`. The new branch falls to `seatTeamWithoutGroup`, which seats the team's own names into free slots and clears `activeGroupId` first (`:6725-6738` explains why that ordering is load-bearing). Both the wiring warning and the seat-fallback notice must reach the operator.

**Double-start refusal.** `startTeamById` refuses when the head role is already live (`teamWiring.ts:810-820`) and returns `success: false` with a specific message. That path is untouched — `startTeam` already surfaces it verbatim at `:6843-6848`.

**Solo mode.** `growLayoutForFleet` no-ops when the panel is in solo mode, so `seatTeamWithoutGroup` may leave members unseated by design. The fallback toast is the honest channel for that (already noted at `:6721-6723`).

**No migration.** Nothing persisted changes shape. `teamGroupId` is a response field, not stored state.

## Proposed Changes

### `src/services/agentGroupInstantiation.ts` — return the group id

Add the field to the result interface (`:57-63`):

```ts
export interface InstantiateAgentGroupResult {
    success: boolean;
    created?: string[];
    workers?: any[];
    delegateError?: string;
    error?: string;
    /**
     * The terminals-group id `wireSpawnedTeam` registered for this team.
     * The webview switches to this group to seat the whole team; the id
     * formula is NOT to be re-derived client-side (see wireSpawnedTeam's
     * WireSpawnedTeamResult comment). Absent when no group was registered
     * (member-less team) or when wiring failed.
     */
    teamGroupId?: string;
}
```

and return it from the success path (`:134-139`):

```ts
    return {
        success: true,
        created,
        workers,
        delegateError: result.delegateError || undefined,
        ...(wired.groupId ? { teamGroupId: wired.groupId } : {}),
    };
```

The wiring-failure early return (`:124-132`) stays as it is: no group was registered, so no id is claimed and the webview falls to the by-name seat.

### `src/webview/terminals.js` — seat the team, not one head

Replace the success tail of `startTeam` (`:6825-6842`). Everything above it — payload construction, the read-body-regardless-of-`res.ok` handling, `armStartupCurtain` for head and workers — is unchanged:

```js
            if (data && data.success) {
                const headName = data.terminal?.friendlyName || (data.created && data.created[0]);
                if (headName) { armStartupCurtain(headName, true); }
                const workers = Array.isArray(data.workers) ? data.workers : [];
                for (const w of workers) {
                    if (w?.friendlyName) { armStartupCurtain(w.friendlyName, true); }
                }
                // Members must be in fleetList before any seating — getGroupMembers()
                // filters the group's stored names through a liveness set built from
                // fleetList, so seating before this await resolves the team to its
                // head alone.
                await fetchTerminalList();

                // Same three branches as the create path (:6642-6658). NOT
                // assignToFocusedPane on the team branch: that helper drops the
                // group lock, which would undo the seating on the next reconcile.
                let seatFallbackReason = null;
                if (!headName) {
                    // Nothing to seat — the warnings below are still delivered.
                } else if (workers.length === 0) {
                    assignToFocusedPane(headName);
                } else if (data.teamGroupId && await switchToTeamGroup(data.teamGroupId, headName)) {
                    // Seated by the group lock — sized by the group's stored layout
                    // and paged by seatActiveGroupPage.
                } else {
                    seatFallbackReason = data.teamGroupId
                        ? 'its group did not load'
                        : 'no group was registered';
                    seatTeamWithoutGroup(headName, workers);
                }

                if (data.delegateError) {
                    showPaneToast(`Team started with a delegate warning: ${data.delegateError}`);
                } else if (data.error) {
                    // Terminals created but wiring failed — surface it.
                    showPaneToast(`Team started with a warning: ${data.error}`);
                } else if (seatFallbackReason) {
                    showPaneToast(`Team seated without its group — ${seatFallbackReason}.`);
                }
            } else if (data && data.error) {
```

The `else if (data && data.error)` refusal branch and the network-error `catch` are unchanged.

### `src/test/terminal-sidebar-groupings-contract.test.js` — pin the second call site

The file already anchors on the create path's `} else if (data.teamGroupId` marker (`:757`, `:791`). Add a matching assertion inside `startTeam`:

- `startTeam` contains a `switchToTeamGroup(data.teamGroupId, …)` branch;
- `startTeam` contains a `seatTeamWithoutGroup(` fallback;
- `startTeam` does **not** call `assignToFocusedPane` on a path where `workers.length > 0` — assert the `workers.length === 0` guard literal is present, so a refactor that reinstates the unconditional seat fails CI.

### `src/test/team-autostart-workspace-scope.test.js` — pin the returned field

The existing test 11 greps both hosts for `wired.groupId`. Add a behavioural case against `instantiateAgentGroupCore` with a stub `createHeadWithDelegates` returning one head and two delegates, asserting the result carries `teamGroupId` equal to the id formula, and a second case with zero members asserting `teamGroupId` is absent.

## Verification Plan

**Automated**

1. `node src/test/terminal-sidebar-groupings-contract.test.js` — the new `startTeam` markers pass and the existing create-path markers still pass.
2. `node src/test/team-autostart-workspace-scope.test.js` — the new `instantiateAgentGroupCore` cases pass; tests 9, 10 and 11 still pass.
3. `npx tsc --noEmit -p tsconfig.json` — clean.

**Manual (installed VSIX, extension host)**

4. Open the terminals panel with a busy grid — say `2x2` with four unrelated terminals seated and the caret in pane 3.
5. Click `START TEAM` in the sidebar ops block, pick the `Coding` team (head + 3 coders + 1 reviewer), submit.
6. Expected: the grid switches to the team's own group — the group tab strip shows the team as active, the layout grows to the team's registered layout, head and all four members are seated, and the caret is on the head. The four pre-existing terminals are no longer on screen but are still in the sidebar and still on their own group tab.
7. Click back to the previous group tab: the original four terminals are seated exactly as they were. Nothing was destroyed.
8. Start a **member-less** team (the seeded `Lead team`). Expected: the head lands in the focused pane, the layout does not change, and no group lock is taken — the current behaviour, unchanged.
9. Start a team while a team of the same head role is already live. Expected: the verbatim refusal toast, and the grid is untouched.

**Manual (standalone / browser cockpit)**

10. Repeat steps 4-8 against `npx switchboard` in a browser. Both hosts route `ptyStartTeam` through the same core, so the group id must appear in both responses — check the `ptyStartTeam` response body in devtools for `teamGroupId`.

**Negative check**

11. Temporarily stub `wireSpawnedTeam` to return `{ ok: false, error: 'forced' }`, start a team, and confirm the operator sees the wiring warning toast and the team is still seated by name via `seatTeamWithoutGroup` — not silently unseated.
