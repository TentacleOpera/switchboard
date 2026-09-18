# Seat the whole team in the terminal grid when a team head starts

## Goal

Starting a team head (e.g. `lead`) must put **every** team terminal — head *and* members — on screen in the terminals grid, sized to fit. Today only the head is seated; the members exist, are running their agent CLIs, and are invisible in the grid, which makes the team feature unusable.

### Problem analysis

A Switchboard "team" has no instantiate button by design — `src/webview/kanban.html:3097` states it outright: *"A team starts when its head role starts — no instantiate button."* So "opening a team" **is** creating an unparented terminal whose role heads a team. The backend already does the whole job:

1. `TaskViewerProvider.handlePtyVerb` (`src/services/TaskViewerProvider.ts:2238-2300`) — and its standalone twin `src/standalone/bootstrap.ts:1169-1190` — look up the team for the head role and rewrite `payload.delegates` to the team's member definitions.
2. `PtyFleetService.spawnDelegates` (`src/standalone/ptyFleetService.ts:448-548`) creates one pty per member, parented to the head.
3. `injectStartupCommand` (`src/standalone/ptyFleetService.ts:360-375`) falls back to the **role's** configured startup command when the member definition has none — so every member really is running an agent CLI.
4. `wireSpawnedTeam` (`src/services/teamWiring.ts:400-548`) installs the standing orders **and registers a manual terminals group** named for the head, id `team_<encoded headName>`, with `layout` pre-sized by `layoutForTeamSize()` and `members: [headName, ...childNames]`.
5. Both hosts return `delegates: [{friendlyName, agentInstanceId, role, status}]` on the `ptyCreateTerminal` response (`src/standalone/ptyHost.ts:106-112`, `src/standalone/bootstrap.ts:1216`), plus `delegateError`, `wiringError`, and (extension host only) `teamAutoStart`.

**Root cause — the webview throws all of it away.** `createTerminal()` in `src/webview/terminals.js:6283-6320` does exactly three things with the response:

```js
armStartupCurtain(data.terminal.friendlyName, hasStartupCommand);
await fetchTerminalList();
assignToFocusedPane(data.terminal.friendlyName);
```

It never reads `data.delegates`, never grows the layout, and never switches to the team group the backend just registered. `assignToFocusedPane` seats exactly one terminal — and (per `src/test/terminal-sidebar-groupings-contract.test.js:360`) *drops the active group lock* while doing it. The members land in `fleetList` on the next `fetchTerminalList()` and render as sidebar rows, but nothing ever seats them into a pane. Net observable result: **only the lead shows in the grid.**

The one asynchronous path that could have covered this also stops short. `wireSpawnedTeam` success triggers a `terminalsGroupsChanged` push (`TaskViewerProvider.ts:2419`, `bootstrap.ts:1213`), which the webview handles at `terminals.js:1052` by calling `reloadTerminalGroups()` (`terminals.js:1546-1568`) — that function merges the new group into `terminalGroups` and re-renders the **sidebar and tab strip only**. It deliberately does not switch to the group. So the team appears as a clickable tab that the operator must find and click, with no indication it exists.

Everything needed to fix this already works: `getGroupMembers()` was explicitly fixed to return head + children for manual groups (`terminals.js:2545-2567` — *"A team registers head + children explicitly (teamWiring.ts); members are parented by construction, so the old set resolved every team to its head alone"*), `layoutForGroupSwitch()` honours the group's stored layout, and `seatActiveGroupPage()` seats every member. `switchToGroup(teamGroupId)` does the entire job in one call. Nothing calls it.

Secondary defect on the same path: the create response's failure channels are silently discarded. `delegateError` (a delegate cap refusal or a spawn failure) and `wiringError` (standing-order cap, group-write failure) are dropped on the floor by `createTerminal`, so a team that half-spawns looks identical to a team that fully spawned. `teamAutoStart.memberDefinitions > 0` with `delegates.length === 0` — the "team defined members but none spawned" case the backend logs three distinct messages for — is likewise invisible in the UI.

### Fix shape

Make the group id an explicit part of the create contract (rather than re-deriving `teamWiring.ts`'s id formula in the webview, which would silently drift), then have `createTerminal()` branch: no delegates → today's behaviour byte-for-byte; delegates present → arm member curtains, refresh, lock onto the team group, put the caret on the head, and report any spawn/wiring/seating failure in a toast.

### Verified preconditions (improve pass, 2026-08-15)

Every claim above was re-checked against source in this pass, plus three that the fix depends on and the original draft asserted only implicitly:

- **Members reach `fleetList`.** `spawnDelegates` creates children with `{ _isTeamMember: true, claudeInlineRendering }` and **no** `hidden` flag, and `ptyListTerminals` projects `terminals: all.filter(t => !t.hidden)` (`ptyHost.ts:138-161`) while the webview assigns `fleetList = data.terminals` (`terminals.js:1582`). Children are therefore live names by the time `getGroupMembers()` runs its liveness filter. If members were ever made hidden, `getGroupMembers` would silently drop them and the grid would size for N and seat 1 — the original bug with a bigger grid. That dependency is now stated so a future "hide delegates" change knows what it breaks.
- **`saveLayoutSettings()` persists `terminals.groups` wholesale** (`terminals.js:1530`). `switchToGroup` calls it, so the reload MUST precede the switch or the panel's own save clobbers the backend-registered group. The ordering in Proposed Changes is load-bearing, not stylistic.
- **`switchToGroup` early-returns on an unknown id** (`terminals.js:2431`: `const group = getAllGroups().find(g => g.id === id); if (!group) { return; }`) and `reloadTerminalGroups` swallows its own errors (`catch { /* ignore */ }`). An unchecked `switchToGroup(data.teamGroupId)` is therefore a **silent no-op** on any reload failure. See the Superseded callout in Proposed Changes §4.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, ui, frontend
- **Project:** Browser Switchboard

## User Review Required

- **None.** One behaviour change is decided rather than deferred: starting a team **rearranges the grid**, because `switchToGroup` → `seatActiveGroupPage` rebuilds `paneAssignments` wholesale. This is the correct trade — starting a team is a deliberate, layout-changing gesture, identical to clicking the team's group tab — and it ships as specified. Pinned panes survive as they do on any group switch (`seatActiveGroupPage` clears only pins whose slot the group left empty).

## Complexity Audit

### Routine

- Adding an optional `groupId` to `WireSpawnedTeamResult` — additive, existing callers (`agentGroupInstantiation.ts:130`, both `handlePtyVerb` sites) read only `.ok`/`.error`.
- Threading `teamGroupId` onto the two `ptyCreateTerminal` responses — additive response field; unknown fields are already ignored by every consumer.
- Arming startup curtains for members — same helper, same call shape as the head.

### Complex / Risky

- **Group-lock interaction.** `assignToFocusedPane` clears `activeGroupId` unless `keepLock` is passed. The team branch must *replace* the `assignToFocusedPane` call, not run alongside it — otherwise the lock we just took is dropped and the seating reverts on the next reconcile. This is the single highest-risk line in the change.
- **Silent-no-op risk on the switch.** `reloadTerminalGroups()` swallows its errors and `switchToGroup()` early-returns on an unknown id, so the happy path can fail with nothing on screen. The presence check in §4 is what converts that into the fallback + toast.
- **Focus state is not part of group switching.** `switchToGroup`/`seatActiveGroupPage` never touch `focusedPaneIndex` or `activeTerminalName` (verified: neither identifier is assigned anywhere in `terminals.js:2418-2490`). After a create, that leaves `activeTerminalName` pointing at a still-live terminal that is no longer on the grid — every "act on the active terminal" path (prompt drop, paste, send) then targets an off-screen terminal.
- **Pane clobbering.** `seatActiveGroupPage` rebuilds `paneAssignments` wholesale, so an operator with panes already arranged loses that arrangement when a team starts. Accepted — see User Review Required.
- **Contract-test coupling.** `src/test/multi-parent-terminals-contract.test.js:246` slices `createTerminal` from its header to the `fetch(` line; `src/test/terminal-sidebar-groupings-contract.test.js:372` counts `assignToFocusedPane(... keepLock` call sites across the whole file and asserts **exactly 1**. The first is safe (all edits land *after* the fetch); the second stays green because nothing in this change passes `keepLock`.
- **Two hosts, one webview.** `terminals.js` is served to both the VS Code panel and the browser cockpit. The response field must be added to **both** `TaskViewerProvider` and `bootstrap.ts` or the cockpit silently keeps the broken behaviour.

## Edge-Case & Dependency Audit

**Race conditions**

- The backend `terminals.groups` write is `await`ed inside `handlePtyVerb`/`bootstrap` **before** the create response returns, so the group is durable by the time the webview reloads. Seating is therefore deterministic and does not depend on the `terminalsGroupsChanged` broadcast arriving first.
- The broadcast still fires and calls `reloadTerminalGroups()` concurrently with the create path's own reload. Both merge by id and are idempotent (`existingIds` guard), so the double-load is harmless.
- Two heads started in quick succession: `_groupsWriteChain` (`teamWiring.ts:90`) serialises the group writes; each create switches to its own team group, so the last one wins the lock. Acceptable and self-explanatory.

**Security** — none. No new input crosses a trust boundary; `teamGroupId` is host-computed and only ever compared against ids already loaded from the host's own config.

**Side effects** — the grid is re-composed and `terminals.activeGroupId` / `terminals.paneAssignments` are persisted by `switchToGroup`'s `saveLayoutSettings()`. Solo mode is exited by `switchToGroup` (`terminals.js:2427-2432`).

**Dependencies & conflicts**

| Case | Expected behaviour |
|---|---|
| Head role heads no team (`data.delegates` absent/empty) | Byte-identical to today: arm curtain, `fetchTerminalList()`, `assignToFocusedPane(head)`. No group switch, no toast. This is the overwhelmingly common path and must not regress. |
| Team defined with **zero** members (the shipped `SEEDED_AGENT_GROUP`, `teamWiring.ts:103-108`) | `delegates` is empty → falls into the no-team branch above. Correct: a member-less team starts a bare head. |
| `wireSpawnedTeam` failed (`wiringError` present, so no group was registered) | `teamGroupId` is absent → the by-name fallback seats head + members explicitly, then toasts the wiring error. Never leave the operator with an unseated team *and* no message. |
| `wireSpawnedTeam` succeeded but the group did not reach memory (reload failed / discarded by `loadLayoutSettings` validation) | The presence check fails → same by-name fallback, plus a toast naming the missing group. This is the case an unguarded `switchToGroup` would have swallowed in silence. |
| `delegateError` present (cap refusal / partial spawn) | Seat whatever `delegates` came back, then toast the error text. A half-team is honest; a silent half-team is the current bug. |
| `teamAutoStart.memberDefinitions > 0` but `delegates.length === 0` | Toast: the team wanted members and got none. Extension host only — `bootstrap.ts` does not emit `teamAutoStart`; treat its absence as "no diagnosis available", never as "zero members". |
| Shared (`scope: 'shared'`) members, including a **reused** existing terminal | Spawned unparented and returned in `children` (`ptyFleetService.ts:500-515`), so they are in `delegates` and in the group's `members` array. `getGroupMembers`'s manual branch is name-based, not parentage-based, so shared members seat exactly like per-team ones. |
| Solo mode active | `switchToGroup` exits solo first (`terminals.js:2427-2432`) — team start legitimately leaves solo, same as clicking any group tab. On the **fallback** path solo is *not* exited (`growLayoutForFleet` no-ops under `is-solo`, `terminals.js:1386`), so a wiring failure during solo leaves the members unseated with the toast as the only signal. Accepted: wiring-failure ∧ solo is a rare intersection and the toast is honest. |
| Layout floor on a small window | `applyLayoutFloor()` still owns `effectiveLayout`; `seatActiveGroupPage()` re-clamps `activeGroupPage` against the floored slot count and pages the remainder. A 5-member team in a floored 2-slot grid shows page 1 and the existing fallback banner explains it. No new UI. |
| Team member whose command comes from the member definition, not the role | The curtain is armed off `hasCommand[role]`, so such a member gets no curtain and shows its raw boot. Cosmetic only — explicitly out of scope; do not add a response field for it. |
| Clicking **All** after a team starts | `clearGroupLock()` re-seats excluding delegate children (`terminals.js:2343-2346`), so the members leave the grid. Pre-existing, deliberate ("no delegate children"), and out of scope for this plan. |
| Members made `hidden` by some future change | They would drop out of `ptyListTerminals().terminals` → out of `fleetList` → filtered by `getGroupMembers`'s liveness set, and the grid would size for N and seat 1. Not a case to handle here; recorded so the dependency is visible. |

**Dependencies:** none new. All touched code is in-repo; no new settings, no migration (the group id already persists in `terminals.groups`, and this change only *reports* an id the backend already computes).

## Dependencies

None. No upstream session, plan, or external service gates this work.

## Adversarial Synthesis

**Risk summary.** The three real risks are (1) the group lock being dropped by an `assignToFocusedPane` left in the team branch, which would silently revert the seating on the next reconcile; (2) the happy path failing *silently*, because `reloadTerminalGroups()` swallows its errors and `switchToGroup()` early-returns on an unknown id — an unguarded call reproduces the exact "invisible team, no message" bug this plan exists to kill; and (3) the wiring-failure fallback using `fillEmptyPanes()`, which seats in `fleetList` order and would hand the free panes to unrelated terminals. Mitigations: the team branch calls `switchToGroup` **instead of** `assignToFocusedPane` and adds no `keepLock` caller; the switch is gated on an explicit `terminalGroups.some(g => g.id === …)` presence check with a by-name fallback and a toast; and the fallback seats the team's own names explicitly rather than delegating to `fillEmptyPanes`. Focus is handed to the head explicitly, since group switching deliberately does not move it.

## Proposed Changes

### 1. `src/services/teamWiring.ts` — return the registered group id

`groupId` is computed at line 516 and thrown away. Return it so callers never re-derive the formula.

```ts
export interface WireSpawnedTeamResult {
    ok: boolean;
    error?: string;
    /**
     * The terminals-group id registered for this team. Returned so the create
     * response can hand it to the webview verbatim — the id formula below is
     * NOT to be duplicated client-side, where it would drift silently and the
     * grid would fail to seat the team with no error anywhere.
     * Absent when no group was registered (no children, or a failure above).
     */
    groupId?: string;
}
```

Then thread it through the success return; the group-write failure return stays `{ ok: false, error }`:

```ts
    try {
        const p = _groupsWriteChain.then(async () => { /* …unchanged… */ });
        _groupsWriteChain = p.catch(() => {});
        await p;
    } catch (err: any) {
        return { ok: false, error: `Group registration failed: ${err?.message || err}` };
    }

    return { ok: true, groupId };
```

The early `return { ok: true }` guards (no `db`… no children, no valid child names) stay as-is — no group is registered on those paths, so no id exists. Note the second of these, `childNames.length === 0`, is reachable with a **non-empty** `children` array (every child missing a `friendlyName`); the webview must treat "delegates present, `teamGroupId` absent" as a legitimate state, which the §4 fallback does.

### 2. `src/services/TaskViewerProvider.ts` — attach `teamGroupId` to the create response

At the post-create wiring hook (~line 2410):

```ts
                        try {
                            const wired = await wireSpawnedTeam({ db, headName, children: result.delegates, members: Array.isArray(payload.delegates) ? payload.delegates : undefined });
                            if (!wired.ok) {
                                result.wiringError = wired.error;
                            } else {
                                // The webview seats the whole team by switching to this
                                // group. Sent on the response rather than left to the
                                // broadcast: reloadTerminalGroups() only re-renders the
                                // sidebar, and racing a push against the create return
                                // makes seating non-deterministic.
                                result.teamGroupId = wired.groupId;
                                this._broadcaster?.push({ type: 'terminalsGroupsChanged' }, SURFACES.terminals);
                            }
                        } catch (err: any) { /* …unchanged… */ }
```

### 3. `src/standalone/bootstrap.ts` — the same field on the standalone host

At ~line 1205-1216:

```ts
                    let wiringError: string | undefined;
                    let teamGroupId: string | undefined;
                    if (spawned.children.length > 0) {
                        const wired = await wireSpawnedTeam({ db, headName: terminal.friendlyName, children: spawned.children, members: rawDelegates });
                        if (!wired.ok) {
                            wiringError = wired.error;
                        } else {
                            teamGroupId = wired.groupId;
                            try { server.broadcastWs('terminalsGroupsChanged', { type: 'terminalsGroupsChanged' }, SURFACES.terminals); } catch { /* broadcast failure must not fail the create */ }
                        }
                    }
                    return {
                        success: true,
                        terminal: { /* …unchanged… */ },
                        delegates: spawned.children.map(t => ({ /* …unchanged… */ })),
                        ...(spawned.error ? { delegateError: spawned.error } : {}),
                        ...(wiringError ? { wiringError } : {}),
                        ...(teamGroupId ? { teamGroupId } : {})
                    };
```

`src/standalone/ptyHost.ts` needs **no** change — it never calls `wireSpawnedTeam` (no DB in that child process; see `teamWiring.ts:13-19`), and the host that proxies it attaches the field.

### 4. `src/webview/terminals.js` — seat the team (the actual fix)

Replace the tail of `createTerminal()` (lines 6303-6316). Everything above `const res = await fetch(...)` is untouched, which keeps `multi-parent-terminals-contract.test.js:246` green.

> **Superseded:** `await reloadTerminalGroups(); switchToGroup(data.teamGroupId);` — call the switch unconditionally once the group id is present.
> **Reason:** `reloadTerminalGroups()` ends in `catch { /* ignore — the next fleet poll will pick it up */ }` and `switchToGroup()` opens with `const group = getAllGroups().find(g => g.id === id); if (!group) { return; }`. If the reload's `loadSetting` fails, or the group is discarded by the `LAYOUT_MODES`/`source` validation, the pair is a **silent no-op** — the operator gets an unseated team and no message, which is the precise bug this plan exists to fix, surviving inside the fix.
> **Replaced with:** gate the switch on an explicit presence check and fall through to by-name seating plus a toast when the group did not arrive (`switchToTeamGroup` below).

> **Superseded:** the wiring-failure fallback `growLayoutForFleet(1 + delegates.length); assignToFocusedPane(head); fillEmptyPanes();`
> **Reason:** `fillEmptyPanes()` (`terminals.js:6562`) seats `fleetList.filter(t => t.status !== 'exited' && !paneAssignments.includes(...))` in **fleetList order**, with no notion of which terminals belong to this team. On a busy fleet with other unseated terminals, the free panes go to strangers and the members stay invisible — the fallback reproducing the bug it exists to prevent.
> **Replaced with:** `seatTeamWithoutGroup(head, delegates)`, which seats the team's own names explicitly into free, unpinned, non-kanban slots.

> **Superseded:** the team branch ends after seating (no focus handling).
> **Reason:** `switchToGroup`/`seatActiveGroupPage` deliberately never assign `focusedPaneIndex` or `activeTerminalName` — a tab click is navigation, not selection. After a **create**, that leaves `activeTerminalName` on a still-live terminal that the rebuild pushed off the grid (the reconcile at `terminals.js:1902` only nulls it when the terminal *dies*), so drag-to-terminal, paste, and send-prompt all target something the operator can no longer see.
> **Replaced with:** an explicit `focusSeatedTerminal(headName)` after the switch — sets the index and the active name directly, deliberately **not** via `assignToFocusedPane`, which would drop the lock we just took.

```js
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.terminal) {
                    const delegates = Array.isArray(data.delegates) ? data.delegates : [];
                    // BEFORE fetchTerminalList/assign: those are what build the pane and
                    // its xterm, and updatePaneElement reads startupCurtains to decide
                    // whether to paint the overlay. Arming after them would paint one
                    // reconcile late — a visible flash of the raw prompt.
                    armStartupCurtain(data.terminal.friendlyName, hasStartupCommand);
                    if (delegates.length > 0) {
                        // Team members run the role's configured agent CLI even when the
                        // member definition carries no command of its own
                        // (ptyFleetService.injectStartupCommand falls back to the role's),
                        // so they need curtains too. One fetch for the whole team.
                        const { hasCommand } = await fetchPtyVisibleRoles();
                        for (const d of delegates) {
                            if (d && d.friendlyName) {
                                armStartupCurtain(d.friendlyName, hasCommand[d.role] === true);
                            }
                        }
                    }
                    // Members must be in fleetList before any seating: getGroupMembers()
                    // filters the group's stored names through a liveness set built from
                    // fleetList, so seating before this await resolves the team to its
                    // head alone — the original bug with a bigger grid.
                    await fetchTerminalList();

                    let seatFallbackReason = null;
                    if (delegates.length === 0) {
                        assignToFocusedPane(data.terminal.friendlyName);
                    } else if (data.teamGroupId && await switchToTeamGroup(data.teamGroupId, data.terminal.friendlyName)) {
                        // Seated by the group lock — sized by the group's stored layout
                        // and paged by seatActiveGroupPage. Deliberately INSTEAD OF
                        // assignToFocusedPane: that helper drops the group lock (see the
                        // keepLock contract in terminal-sidebar-groupings-contract), which
                        // would undo the seating on the next reconcile.
                    } else {
                        seatFallbackReason = data.teamGroupId
                            ? 'its group did not load'
                            : 'no group was registered';
                        seatTeamWithoutGroup(data.terminal.friendlyName, delegates);
                    }

                    reportTeamStart(data, delegates, seatFallbackReason);
                } else if (data && data.error) {
                    console.error('[Terminals] Create rejected:', data.error);
                }
            }
```

And three helpers beside it:

```js
    /**
     * Pull the backend-registered team group into memory, then lock onto it.
     * Returns false when the group did not arrive, so the caller can seat the
     * team by hand instead.
     *
     * The presence check is NOT defensive padding: reloadTerminalGroups() ends
     * in `catch { }` and switchToGroup() early-returns on an unknown id, so an
     * unchecked pair fails silently — an unseated team with nothing on screen
     * to say so, which is the bug this whole change exists to remove.
     *
     * The reload must precede the switch: switchToGroup calls
     * saveLayoutSettings(), which writes the WHOLE in-memory terminalGroups
     * array back to `terminals.groups` and would clobber the group the backend
     * just registered.
     */
    async function switchToTeamGroup(groupId, headName) {
        await reloadTerminalGroups();
        if (!terminalGroups.some(g => g && g.id === groupId)) { return false; }
        switchToGroup(groupId);
        focusSeatedTerminal(headName);
        return true;
    }

    /**
     * Put the caret on the head after a team seat. switchToGroup rebuilds
     * paneAssignments but deliberately leaves focusedPaneIndex and
     * activeTerminalName alone — a tab click is navigation, not selection.
     * After a CREATE that is wrong: the operator's active terminal would stay
     * pointing at whatever was focused before, which the rebuild just pushed
     * off the grid, and every act-on-the-active-terminal path (drag-to-terminal,
     * paste, send prompt) would target something invisible.
     *
     * NOT assignToFocusedPane: that helper drops the group lock.
     */
    function focusSeatedTerminal(name) {
        const idx = paneAssignments.indexOf(name);
        if (idx < 0 || idx >= getSlotCount(effectiveLayout)) { return; }
        focusedPaneIndex = idx;
        activeTerminalName = name;
        renderSidebarList();
        renderPaneGrid();
    }

    /**
     * Seat a team when no group is available — wiring failed, or the group did
     * not load. Seats the team's OWN names, in team order, into free slots.
     *
     * Explicitly not fillEmptyPanes(): that helper fills in fleetList order with
     * no notion of this team, so on a busy fleet the free panes go to unrelated
     * terminals and the members stay invisible — the fallback reproducing the
     * bug it exists to prevent. Pinned slots and kanban panes are skipped for
     * the same reasons fillEmptyPanes skips them.
     *
     * Members that do not fit are left unseated; the caller's toast is the
     * honest channel for that (and for solo mode, where growLayoutForFleet
     * no-ops by design).
     */
    function seatTeamWithoutGroup(headName, delegates) {
        const names = [headName, ...delegates.map(d => d && d.friendlyName).filter(Boolean)];
        growLayoutForFleet(names.length);
        const rendered = getSlotCount(effectiveLayout);
        const next = paneAssignments.slice();
        while (next.length < getMaxSlotCount()) { next.push(null); }
        let slot = 0;
        for (const name of names) {
            if (next.includes(name)) { continue; }
            while (slot < rendered && (next[slot] || pinnedPanes[slot] || paneModes[slot] === 'kanban')) { slot++; }
            if (slot >= rendered) { break; }
            next[slot++] = name;
        }
        paneAssignments = next;
        const headIdx = paneAssignments.indexOf(headName);
        if (headIdx >= 0 && headIdx < rendered) {
            focusedPaneIndex = headIdx;
            activeTerminalName = headName;
        }
        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }

    /**
     * Surface team auto-start failures. The create response carries three
     * independent failure channels and the UI showed none of them, so a team
     * that half-spawned looked exactly like one that fully spawned. The fourth
     * (seatFallbackReason) is local: the team is on screen but not locked to
     * its group, so the next reconcile composes differently than the operator
     * expects.
     *
     * `teamAutoStart` is extension-host only; its ABSENCE means "no diagnosis
     * available", never "zero members".
     */
    function reportTeamStart(data, delegates, seatFallbackReason) {
        if (data.delegateError) {
            showPaneToast(`Team partially started: ${data.delegateError}`);
            return;
        }
        if (data.wiringError) {
            showPaneToast(`Team started but wiring failed: ${data.wiringError}`);
            return;
        }
        if (seatFallbackReason) {
            showPaneToast(`Team seated without its group — ${seatFallbackReason}.`);
            return;
        }
        const wanted = data.teamAutoStart && data.teamAutoStart.memberDefinitions;
        if (wanted > 0 && delegates.length === 0) {
            showPaneToast(`Team "${data.teamAutoStart.team || 'unknown'}" defines ${wanted} member${wanted === 1 ? '' : 's'} but none started.`);
        }
    }
```

`reloadTerminalGroups()` is already `async` and already validates `LAYOUT_MODES` / `source` before merging, so `switchToGroup` cannot be handed a group the loader would have discarded — and when the validation *does* discard it, the presence check turns that into the fallback instead of silence.

### 5. `src/test/` — contract coverage

Add to `src/test/terminal-sidebar-groupings-contract.test.js` (it already owns the `switchToGroup` / `keepLock` contracts):

- `createTerminal`'s team branch calls `switchToTeamGroup(` and does **not** call `assignToFocusedPane` in the same branch — slice from `if (delegates.length === 0)` to `reportTeamStart(`.
- `switchToTeamGroup` awaits `reloadTerminalGroups()` **and** guards on `terminalGroups.some(` before calling `switchToGroup` — an unguarded switch is a silent no-op.
- The no-delegate branch still calls `assignToFocusedPane(data.terminal.friendlyName)`.
- The fallback seats by name: `seatTeamWithoutGroup` references `delegates.map(` and the create path contains no bare `fillEmptyPanes()` call.
- `focusSeatedTerminal` assigns `focusedPaneIndex` and `activeTerminalName` and does not call `assignToFocusedPane`.
- The existing `keepLock` call-site count assertion at line 372 must still read exactly 1 (this change adds no `keepLock` caller).

Add to `src/test/team-autostart-workspace-scope.test.js` (it already loads `out/services/teamWiring`):

- `wireSpawnedTeam` returns a `groupId` matching `'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g,'_')` on success with children, and no `groupId` when there are no children.
- Both host files (`TaskViewerProvider.ts`, `bootstrap.ts`) reference `wired.groupId` — a source-text assertion, so a fix landing in one host and not the other fails CI.

## Verification Plan

> This improve pass ran **no** compilation and **no** tests (session directive). The commands below are for the implementing coder.

### Automated Tests

1. `npx tsc --noEmit -p .` — clean (the `WireSpawnedTeamResult` field is additive; confirm no caller destructures exhaustively).
2. `node --test src/test/terminal-sidebar-groupings-contract.test.js` — new team-branch contracts pass, the existing `keepLock` count (exactly 1) and `switchToGroup` contracts stay green.
3. `node --test src/test/multi-parent-terminals-contract.test.js` — the `createTerminal` header-to-fetch slice and the open-all payload contract are unaffected.
4. `node --test src/test/team-autostart-workspace-scope.test.js` — `groupId` return contract + both-hosts source assertion.
5. Full suite — confirm against the known-red baseline at HEAD; do not attribute a pre-existing failure to this change.

### Manual (installed VSIX, not `dist/`)

6. In the TEAMS tab, give the `lead` team ≥2 members (e.g. 1× coder, 1× reviewer). Open the terminals panel with an empty grid. Start a `lead` from the sidebar role picker.
   - **Expected:** the grid grows to fit head + members, every team terminal is seated and visibly booting its CLI, the team's group tab is active in the tab strip, **and the head's pane is the focused one**. This is the acceptance criterion — the head alone on screen is a fail, and so is a correctly-seated grid whose caret is on an off-grid terminal.
7. Repeat with a 4-member team → grid resolves to `2x3`/`3x3` per `layoutForTeamSize`; no member is left unseated without a toast.
8. Start a role that heads **no** team → exactly one terminal seated into the focused pane, no group switch, no toast (the no-regression case).
9. Start a `lead` whose team is the shipped member-less `Lead team` → bare head, no group switch, no toast.
10. Force a cap refusal (define 9+ per-team members, exceeding `MAX_DELEGATES_PER_PARENT`) → head starts, toast names the cap, whatever spawned is seated.
11. Force the group-missing path (e.g. temporarily make `wireSpawnedTeam` return `{ ok: true }` with no `groupId`) → the team is still fully seated by name and the toast says the group was not registered. Revert after.
12. With several unrelated terminals already running and unseated, repeat step 11 → the **team members** take the free panes, not the strangers.
13. Repeat step 6 in the **browser cockpit** against the standalone host → identical behaviour, proving the `bootstrap.ts` half landed.
14. Resize the window small enough to trigger the layout floor mid-team-start → members page rather than vanish; the existing fallback banner explains the demotion.

---

**Recommendation:** Complexity 5 → **Send to Coder**.

---

## Completion Report

Implemented the full plan: starting a team head now seats every team member in the terminal grid. Changes: (1) `src/services/teamWiring.ts` — added `groupId?: string` to `WireSpawnedTeamResult` and returned it on the success path (the early no-children guards stay `{ ok: true }` with no groupId); (2) `src/services/TaskViewerProvider.ts` — set `result.teamGroupId = wired.groupId` in the post-create wiring success branch; (3) `src/standalone/bootstrap.ts` — added a `teamGroupId` local, set it from `wired.groupId`, and spread it into the create response (the both-hosts rule); (4) `src/webview/terminals.js` — replaced the tail of `createTerminal()` with a delegates-aware branch (arm member curtains via `fetchPtyVisibleRoles`, `fetchTerminalList`, then seat via `switchToTeamGroup` or fall back to `seatTeamWithoutGroup`), plus four helpers (`switchToTeamGroup`, `focusSeatedTerminal`, `seatTeamWithoutGroup`, `reportTeamStart`) that handle the group-lock presence check, explicit focus on the head, by-name fallback seating, and failure toasts; (5) contract tests added to `terminal-sidebar-groupings-contract.test.js` (6 tests: team branch uses `switchToTeamGroup` not `assignToFocusedPane`, `switchToTeamGroup` guards on `terminalGroups.some`, no-delegate branch still calls `assignToFocusedPane`, `seatTeamWithoutGroup` seats by name with no `fillEmptyPanes`, `focusSeatedTerminal` assigns focus directly, keepLock count stays 1) and `team-autostart-workspace-scope.test.js` (3 tests: `wireSpawnedTeam` returns `groupId` on success with children, no `groupId` without children, both hosts reference `wired.groupId`). Verified `node --check src/webview/terminals.js` passes (exit 0) and both test files pass `node --check`. No compilation or automated tests were run per the session directive. No issues encountered; the sibling subtask (derived role groups) was not touched.

## Review Findings

Reviewer pass (2026-08-16) against `teamWiring.ts`, `TaskViewerProvider.ts`, `bootstrap.ts`, `terminals.js`, and the two contract test files. Two material defects were found and fixed: (1) the plan's own §5 test spec sliced `createTerminal` from `if (delegates.length === 0)` — a range that necessarily contains the no-delegate branch's *required* `assignToFocusedPane` call — so the coder's faithful implementation shipped a **RED** CI gate (`test:contract:terminal-sidebar-groupings`, wired at `integration-tests.yml:557`); the slice now starts at `} else if (data.teamGroupId`. (2) `seatTeamWithoutGroup` never cleared `activeGroupId`, and `growLayoutForFleet` only drops the lock as a `setLayoutMode` side effect that no-ops when the grid already fits — so a fallback seat under an existing lock was reverted by the next `seatActiveGroupPage()` (resize/floor, banner paging, `promoteGroupMember`), reproducing the invisible-team bug inside its own fallback; the lock is now dropped explicitly and a contract assertion pins it. Verification: `npx tsc --noEmit` clean for this change (5 pre-existing `TS2835` errors in untouched files, incl. unmodified `ClickUpSyncService.ts`); `test:contract:team-autostart-scope` 11/11; `test:contract:multi-parent-terminals` 29/29; `test:contract:terminal-sidebar-groupings` 47/1 — the single remaining failure ("role groups are opt-in…") belongs to the concurrent derived-role-groups subtask, not this one. Remaining risks: `src/test/team-autostart-workspace-scope.test.js` is **untracked in git** while CI invokes it at `integration-tests.yml:634` — it must be `git add`-ed or that job fails on a missing file; and the sibling `startTeam()`/`ptyStartTeam` path (`terminals.js:6690`) still seats only the head via `assignToFocusedPane`, so the same bug survives on that second team-start entry point (`instantiateAgentGroup` already has `wired.groupId` in hand and discards it) — out of this plan's scope, recorded for the plan that owns that button.

**Second reviewer pass (2026-08-17), tests executed.** Re-verified `teamWiring.ts`, `TaskViewerProvider.ts:2873`, `bootstrap.ts:1294/1300`, `terminals.js` and both contract files; no CRITICAL or MAJOR finding survived and **no code changes were applied**. Both risks the first pass fixed are confirmed closed — `activeGroupId = null` is explicit at `terminals.js:6668`, and `src/test/team-autostart-workspace-scope.test.js` is now git-tracked, so the CI job at `integration-tests.yml:646` no longer runs against a missing file. New regression checks all clean: `reloadTerminalGroups`'s merge is genuinely idempotent under the concurrent broadcast (`existingIds` is computed after the await, the push is synchronous), `focusSeatedTerminal`'s slot guard cannot silently no-op because `group.order` seats the head first on page 0, and `reportTeamStart`'s `undefined > 0` correctly reads an absent `teamAutoStart` as "no diagnosis". Verification: `test:contract:terminal-sidebar-groupings` **48/48**, `test:contract:team-autostart-scope` **11/11**, `test:contract:multi-parent-terminals` **29/29**, `tsc --noEmit` clean for this change (5 pre-existing `TS2835` errors, confirmed present at `842e4187`); all three checks defined in `package.json` **and** invoked by CI. Sole residual risk is unchanged and deliberately unfixed: `startTeam()` (`terminals.js:6767`) still seats the head alone, and the approved plan *"Promote START TEAM Out of the Tiny `+` Picker"* rewrites that exact function — editing it here would collide with it.
