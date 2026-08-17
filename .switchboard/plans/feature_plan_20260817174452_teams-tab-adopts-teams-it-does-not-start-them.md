# The TEAMS Tab Adopts Teams; It Does Not Start Them

## Goal

Remove the start action from the board panel's TEAMS tab. The tab's flow panel keeps one button — `USE`, which adopts a shipped team type into the workspace's own teams — and the team is started from the terminals panel, which is the surface that owns the grid the team has to appear in. Starting a team from the TEAMS tab spawns a head and its members into a panel that cannot show them, so the operator gets a `STARTING…` button that goes quiet and no visible team.

### Problem analysis and root cause

**The TEAMS tab is not in the terminals panel.** It is a tab of the board webview: `<button class="shared-tab-btn" data-tab="teams">TEAMS</button>` (`src/webview/kanban.html:2892`) with content at `#teams-tab-content` (`:3226`). Its only channel to the host is `postKanbanMessage` — the panel has no terminal grid, no pane assignments, and no layout.

**So a team started from there has nowhere to land.** `teamsTabStartTeam` (`:5100-5108`) posts `{ type: 'startAgentGroup', groupId }`; `KanbanProvider` handles it (`src/services/KanbanProvider.ts:11633-11667`) by routing to `startTeamForWorkspace` (extension host) or `startAgentGroupById` (standalone). Both end in `wireSpawnedTeam`, which registers a terminals group and pushes a `terminalsGroupsChanged` broadcast (`TaskViewerProvider.ts:11844-11846`).

The terminals panel's entire reaction to that broadcast is `reloadTerminalGroups()` (`src/webview/terminals.js:1132-1141`), which merges the new group into the in-memory array and re-renders the sidebar list. It deliberately does **not** switch to the group or seat a pane — its own comment says the merge exists so "a backend-registered group appears in an open panel before the panel's next whole-array save can clobber it" (`:1629-1640`), which is a persistence guard, not a seating path. Seating is done by the caller of the start, from the response — `switchToTeamGroup(data.teamGroupId, headName)` (`:6683-6689`). The TEAMS tab is not that caller and cannot be: it is a different webview and gets its result over `postMessage`, not over the pty verb response.

Result, as observed in UAT: the flow panel's button reads `STARTING…`, `startAgentGroupResult` comes back `success: true`, the button resets, and nothing appears anywhere the operator is looking. If the terminals panel is closed, the team is spawned entirely off-screen.

**There is already a first-class start control in the right place.** `START TEAM` sits in the terminals sidebar ops block as a full-width button with an inline team+workspace chooser (`src/webview/terminals.html:1976-1987`, wired at `terminals.js:949-1021`). That control was deliberately promoted there — its own plan (`.switchboard/plans/feature_plan_20260816212500_start-team-is-a-first-class-sidebar-control.md`) states the rule it was built to satisfy: *"One entry point, not two. Leaving the picker's team section in place while adding a sidebar button produces two peer controls that do the same thing — the exact 'peer modes' failure this panel keeps regressing into."* The TEAMS-tab button is that second peer control, in the one surface that cannot render the result.

**Root cause:** the TEAMS tab's design step ("START sits on the flow panel, so you start the thing you are looking at") was written before the terminals panel had a start control, and it reasoned about which *card* you are looking at rather than which *panel* can show a terminal. The tab's real job — pick a team, see it drawn, adopt it, configure its roster and its START ON LOAD — needs no start action.

### What changes for the operator

- Flow panel, un-adopted shipped type → **`USE`**. Adopts it into Your Teams and re-renders. This is the pre-existing USE semantics, moved onto the flow panel where the current button lives.
- Flow panel, already-adopted team → **no action button**. The team is already in Your Teams with its EDIT / × row controls and its START ON LOAD toggle.
- One line of static text under the panel action: `Start it from the terminals panel.` — so an operator who has just adopted a team is not left guessing. One sentence, no link, no modal.
- Unchanged: the three cards, the flow diagram, the roster strips, `+ Build your own`, the member editor, the START ON LOAD checkbox and its worktree field (`:4839-4891`) — that toggle is *configuration* of when the host starts a team, not an operator-initiated start, and it stays.

## Metadata

**Complexity:** 3
**Tags:** ux, ui, frontend
**Project:** Browser Switchboard

## Complexity Audit

### Routine

- Changing the flow-panel button's label and handler from a two-state `START` / `USE & START` to a single `USE` shown only for un-adopted types.
- Deleting `teamsTabStartTeam` and the `startAgentGroupResult` message arm.

### Complex / Risky

- **The adopt path must survive the start deletion.** `teamsTabAdoptAndStart` (`:5070-5091`) does two things: fork-and-persist, and sequence a start on the `saveAgentGroupResult` round-trip. Deleting the whole function would delete adoption too — the card-body `USE` button was already removed when adoption moved to the flow panel (`:4790-4792`), so this is the only adoption entry point for a shipped type besides `+ Build your own`. Keep the fork-and-persist half; delete only the pending-start bookkeeping.
- **The failure rollback in `saveAgentGroupResult` is not start machinery and must not be deleted wholesale.** `:9885-9911` rolls the optimistic push back when the save fails, so a card does not sit in Your Teams pointing at an id the host never persisted. That rollback is still required after this change — a failed adopt must still revert the card. What goes is the `teamsTabStartTeam(id)` call on the success branch and the `teamsTabStartingId` busy-state it exists to clear.
- **Keep the host `startAgentGroup` verb arm.** `KanbanProvider.ts:11633-11667` stays. It is an allowlisted kanban verb (`src/generated/verbAllowlist.ts`) and appears in `protocol-catalog.json` (`:153`, `:840`, `:6491`) — both are generated from source, so deleting the arm forces a regeneration of two committed artefacts and removes an HTTP surface that external orchestration can legitimately use to start a team headlessly. This plan removes a *UI control*, not a capability. Leaving the arm also means no migration question: nothing persisted changes.
- **Do not add a confirm gate or a "are you sure you want to leave" prompt anywhere in this change.** `USE` adopts immediately.
- **Do not add a "go to the terminals panel" button.** A one-sentence static line is the whole affordance. A cross-panel navigation control is a new mechanism and is out of scope.

## Edge-Case & Dependency Audit

**A team currently mid-start when the change lands.** Not possible across a reload — `teamsTabStartingId` / `teamsTabPendingStartId` are in-memory webview state, discarded when the panel reloads with the new build.

**`startAgentGroupResult` arriving with no handler.** After the arm is deleted, a late `startAgentGroupResult` (e.g. from a start initiated over HTTP by something else while the board is open) falls through the `switch` in `kanban.html`'s message handler with no `default` side effect. Confirm the switch has no `default:` that would surface an error for an unknown type before deleting the case; if it does, keep a no-op case rather than letting an unrelated caller's result raise a UI error.

**Adopted-team cards with no action button.** `teamsTabRenderFlow` (`:4912-5061`) builds `actionDiv` unconditionally today. For an adopted team the div becomes the static line only; it must not render an empty `<button>` or an empty flex row that shifts the diagram.

**The error span.** `#teams-flow-error` (`:5056-5059`) is still needed — the adopt round-trip can fail and `saveAgentGroupResult`'s rollback writes into it (`:9908-9909`). Keep the span and keep it after the re-render, for the reason already documented at `:9906-9907`.

**Zero teams / first run.** Unchanged. The three shipped cards always render; `USE` is available on each.

**Standalone / browser cockpit.** The TEAMS tab is served in both hosts from the same `kanban.html`. The change is host-independent. Note that on the standalone host the board and the terminals panel are two tabs of the same shell, so "start it from the terminals panel" is a tab switch, not a different window.

**No shipped-state migration.** Nothing on disk changes shape: `terminals.agentGroups` rows are untouched, the `startAgentGroup` verb stays registered, and the deleted state is webview-local.

## Proposed Changes

### `src/webview/kanban.html` — flow panel action becomes adopt-only

Replace the action block in `teamsTabRenderFlow` (`:5032-5060`):

```js
            // Action — adopt only. Starting a team is the terminals panel's job:
            // this panel has no grid to seat one in, and the terminals panel's
            // only reaction to a backend team registration is reloadTerminalGroups()
            // (terminals.js:1132-1141), which merges the group and seats nothing.
            const actionDiv = document.createElement('div');
            actionDiv.className = 'teams-flow-action';
            if (!entry.adopted) {
                const btn = document.createElement('button');
                btn.className = 'agents-tab-custom-agent-item-btn';
                btn.id = 'teams-flow-use-btn';
                btn.textContent = 'USE';
                btn.addEventListener('click', () => teamsTabAdopt(entry.group));
                actionDiv.appendChild(btn);
            }
            const hint = document.createElement('span');
            hint.className = 'teams-flow-hint';
            hint.textContent = 'Start it from the terminals panel.';
            actionDiv.appendChild(hint);
            const errorSpan = document.createElement('span');
            errorSpan.className = 'teams-flow-error';
            errorSpan.id = 'teams-flow-error';
            actionDiv.appendChild(errorSpan);
            panel.appendChild(actionDiv);
```

The `starting` / `teamsTabStartingId` branch (`:5038-5047`) goes with it.

Rename `teamsTabAdoptAndStart` → `teamsTabAdopt` and drop the start bookkeeping (`:5070-5091`):

```js
        /**
         * Fork a shipped type into the workspace's own teams and persist it.
         * The card re-renders as an adopted team; starting it is the terminals
         * panel's job.
         */
        function teamsTabAdopt(type) {
            const forked = {
                id: 'group-' + type.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36),
                name: type.name,
                headRole: type.headRole,
                members: (type.members || []).map(m => ({ ...m })),
                ...(type.prompt ? { prompt: type.prompt } : {}),
                ...(type.headPrompt ? { headPrompt: type.headPrompt } : {})
            };
            agentsTabAgentGroups.push(forked);
            teamsTabPendingAdoptId = forked.id;   // rollback key on a failed save
            teamsTabPickedKey = forked.id;
            teamsTabRenderAgentGroups();
            teamsTabRenderGallery();
            postKanbanMessage({ type: 'saveAgentGroup', group: forked });
        }
```

Delete `teamsTabStartTeam` (`:5100-5108`) and the `teamsTabStartingId` declaration (`:4279`). Rename `teamsTabPendingStartId` (`:4275`) to `teamsTabPendingAdoptId` — it now only keys the rollback.

Rework the `saveAgentGroupResult` arm (`:9874-9913`) to keep the rollback and drop the start:

```js
                case 'saveAgentGroupResult': {
                  if (msg.success) {
                    postKanbanMessage({ type: 'getAgentGroups' });
                  } else {
                    document.getElementById('agent-groups-error').textContent = msg.error || 'Failed to save agent group';
                  }
                  if (teamsTabPendingAdoptId) {
                    const id = teamsTabPendingAdoptId;
                    teamsTabPendingAdoptId = null;
                    if (!msg.success) {
                      // The save failed, so the forked id does not exist on the
                      // host. Roll the optimistic push back — leaving it draws an
                      // adopted card for a team the host has never seen.
                      const idx = agentsTabAgentGroups.findIndex(g => g.id === id);
                      if (idx >= 0) {
                        const reverted = agentsTabAgentGroups[idx];
                        agentsTabAgentGroups.splice(idx, 1);
                        teamsTabPickedKey = 'type:' + reverted.name;
                      }
                      teamsTabRenderAgentGroups();
                      teamsTabRenderGallery();
                      // After the re-render — teamsTabRenderFlow rebuilds the
                      // error span, so writing before it would be erased.
                      const errEl = document.getElementById('teams-flow-error');
                      if (errEl) { errEl.textContent = msg.error || 'Failed to adopt team.'; }
                    }
                  }
                  break;
                }
```

Delete the `startAgentGroupResult` case (`:9914-9928`). If the enclosing `switch` has a `default:` arm that surfaces unknown message types, replace the case with an empty `case 'startAgentGroupResult': break;` instead of deleting it, so a start initiated elsewhere cannot raise a spurious UI error.

Add the hint style beside `.teams-flow-error` in the tab's CSS block:

```css
.teams-flow-hint { font-size: 10px; color: var(--text-secondary); }
```

### `src/webview/terminals.html` — nothing

The `START TEAM` control is already correct and already the single entry point after this change. No edit.

### Tests

Add a source-text contract case to the TEAMS-tab coverage (or a new `teams-tab-no-start-contract.test.js` if none exists) asserting that `kanban.html`:

- contains no `postKanbanMessage({ type: 'startAgentGroup'` call site;
- contains no `teams-flow-start-btn` id;
- still contains `teamsTabAdopt(` and a `saveAgentGroup` post — so a future refactor cannot delete adoption along with the start.

## Verification Plan

**Automated**

1. `node src/test/<teams-tab contract>.test.js` — the three assertions pass.
2. Confirm `src/generated/verbAllowlist.ts` and `protocol-catalog.json` are byte-unchanged by `git diff` — the host verb arm is deliberately untouched, so neither generated artefact may move.

**Manual (installed VSIX)**

3. Open the board → TEAMS. Click each of the three cards. The flow diagram draws as before. Un-adopted cards show `USE` plus the hint line; there is no `START` or `USE & START` anywhere in the tab.
4. Click `USE` on `Multi-agent planning`. The card moves into Your Teams, the flow panel re-renders with no action button and the hint line, and no terminal is spawned — check the terminals panel's sidebar: unchanged.
5. Click the now-adopted card. No action button; hint line present; EDIT / × still available on its Your Teams row; START ON LOAD checkbox still on the card and still persists when toggled.
6. Open the terminals panel, click `START TEAM`, pick the team just adopted, submit. The team starts and seats there — the single entry point works.
7. **Failed adopt rollback.** With the board open, make the save fail (e.g. point the board at a workspace with no writable DB) and click `USE`. The card must revert to its shipped-type state and the error must appear in `#teams-flow-error`.
8. **Standalone.** Repeat 3-6 against `npx switchboard` in a browser.

**Regression**

9. `+ Build your own` still opens the member editor, saves a custom team, and draws it as a fourth card.
10. START ON LOAD still auto-starts a marked team on window load (open a window with a marked team and confirm the team spawns) — this plan does not touch that path.
