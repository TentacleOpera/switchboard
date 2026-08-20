# Shell Strip: Team Icons in Place of Per-Terminal CLI Icons

## Goal
Replace the shell rail's one-button-per-terminal list with one button per **team**, wearing that team's chosen icon. Terminals belonging to no team keep an individual button. Clicking a team icon opens that team's cockpit (built in the companion plan); the rail becomes a roster of squads rather than a list of processes.

### The problem, and the root cause
`renderTerminalSection` (`src/webview/shell.js:423`) renders exactly one `.strip-term-btn` per live terminal, and paints each with the CLI brand mark of the agent running in it. The URI is resolved panel-side in `postFleetStateToShell` (`src/webview/terminals.js:1361`) from `agentLabelForRole` → `brandIconForCliLabel` → `brandIconUri`, so what the rail communicates is **"which CLI is this"** — not "whose work is this".

That is the wrong axis for a team fleet. A four-member team running one CLI is four identical marks; two teams running the same CLI are indistinguishable; and a nine-terminal fleet is nine buttons in a 48px rail with no grouping at all. The rail scales with process count instead of with the number of things the operator actually thinks about.

It renders per-CLI because that is the only identity available: teams have no icon (fixed by the team-icon plan) and no live link to their definition (fixed by the team-identity plan). Both are prerequisites of this plan.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, ui, ux, feature
- **Project:** browser-switchboard
- **Feature:** 72bda17f-bb0c-4ad9-b9b9-55c19fc9cba7

## User Review Required
No user review required — the panel-side aggregation, backward-compatible `teams` array, and rail mode toggle are fully specified.

## Complexity Audit

### Routine
- Extending `postFleetStateToShell` to emit a second `teams` array beside the existing `terminals` array.
- Rendering team buttons in `renderTerminalSection` using the same `<img>` pattern as existing per-terminal buttons.
- Adding a rail mode toggle (teams / terminals) persisted alongside other strip prefs.

### Complex / Risky
- The aggregate light and pulse logic — `any-done wins`, `doneStamp = max` over members, pulse ledger keyed on `groupId` instead of terminal name. Must reuse `renderTerminalSection`'s existing pulse machinery verbatim to avoid forking the animation-resume logic.
- The stable-order requirement — the `teams` array must be sorted panel-side (by definition order, then name) before sending, because the shell cannot sort by definition order it does not have.
- The `popoutTeam` window-name dedup — the existing `shell.js:566` already-open-then-focus check would prevent a second window on the same team, contradicting the cockpit plan's allowance for two windows on the same team. Do not dedup team windows by name.

## Edge-Case & Dependency Audit
- **Race Conditions:** A team rebuild that removes a hovered button strands the tooltip overlay. The plan correctly calls `hideStripTooltip()` at the top of the rebuild — same hazard as per-terminal rebuilds.
- **Security:** No new attack surface. The `teams` array is built panel-side from in-memory group records and icon resolvers. No caller-supplied data is interpolated into URLs.
- **Side Effects:** The `teams` array increases the `postFleetStateToShell` payload size. Bounded by the number of teams (typically <10). Negligible.
- **Dependencies & Conflicts:** Depends on team identity foundation (`definitionId` / `head` / `teamKind` / `isSpawnedTeamGroup` / `resolveDefinitionForGroup`) and team icon picker (`icon` field / `teamIconSrc` resolver). The `popoutTeam` click behaviour opens the team cockpit (`/terminals?team=<groupId>`), supplied by the cockpit plan. Window-name dedup must be skipped for teams to allow the cockpit plan's two-window scenario.

## Adversarial Synthesis
Key risks: (1) the `teams` array must be sorted panel-side before sending — the shell cannot sort by definition order it does not have; (2) the `popoutTeam` window-name dedup contradicts the cockpit plan's two-window allowance — do not dedup team windows by name; (3) the aggregate pulse ledger keyed on `groupId` must reuse the existing pulse machinery verbatim to avoid forking the animation-resume logic. Mitigations: sort panel-side; skip the already-open check for team pop-outs; reuse `renderTerminalSection`'s pulse machinery without modification.

## Proposed Changes

### `src/webview/terminals.js`
- **Context:** `postFleetStateToShell` (line 1345) emits only a `terminals` array. The shell rail renders one button per terminal, painted with CLI brand marks.
- **Logic:** Extend `postFleetStateToShell` to emit a `teams` array beside `terminals`. Each entry: `{ groupId, definitionId, name, head, iconUri, memberNames[], light, doneStamp, activeCount, exitedCount }`. Build it panel-side (the panel holds `fleetList`, group records, and icon resolvers). Sort by definition order, then name — never fleet-poll order. Keep sending `terminals` unchanged and complete.
- **Edge Cases:** Aggregate `light` per team: `'done'` if any member has an unacknowledged completion badge, else `'active'` if any member is active, else `'exited'`. `doneStamp` = max over member stamps. A terminal in two groups: only groups where `isSpawnedTeamGroup(g)` is true become team buttons.

### `src/webview/shell.js`
- **Context:** `renderTerminalSection` (line 423) renders one `.strip-term-btn` per live terminal. The pulse ledger (`pulsedDoneStamps`, line 481) keys on terminal name.
- **Logic:** Emit one button per team (in stable order), then one button per ungrouped terminal. Team button contents: team icon as `<img class="strip-team-icon">`, plus a small member-count badge. Key the pulse ledger on `groupId` instead of terminal name. Add a `popoutTeam` sibling to `popoutTerminal` (line 731) opening `/terminals?team=<groupId>`. Add a rail mode toggle (teams / terminals) persisted alongside other strip prefs.
- **Edge Cases:** Do not dedup team windows by name — use a unique window name per open action or skip the already-open check for teams, to allow the cockpit plan's two-window scenario. Clicking a team with an unacknowledged completion is the acknowledgement — relay `clearTeamBadges` carrying `memberNames`. Keep `hideStripTooltip()` at the top of the function. Three-deep icon fallback: no team icon → role portrait → brand mark → role letter.

## Dependencies
- **Team identity foundation** — `definitionId` / `head` / `teamKind` on the registered group, plus `resolveDefinitionForGroup`.
- **Team icon picker** — the `icon` field and the `teamIconSrc` resolver.

Neither is optional: without the first, the strip cannot tell which terminals form a team; without the second, there is no icon to draw.

## Approach

### 1. Send teams, not just terminals
Extend `postFleetStateToShell` (`terminals.js:1345`) to emit a second array beside the existing `terminals`:

```js
window.parent.postMessage({ type: 'terminalFleetState', terminals, teams }, location.origin);
```

Each `teams` entry: `{ groupId, definitionId, name, head, iconUri, memberNames[], light, doneStamp, activeCount, exitedCount }`.

Build it panel-side, not shell-side — the panel already holds `fleetList`, the group records and the icon resolvers, and the existing comment at `terminals.js:1361` records the standing decision that icon URIs resolve in the panel so the shell needs no icon table of its own. Honour that.

Keep sending `terminals` unchanged and complete. The shell decides what to draw; a shell that has not been updated must keep working against a new panel, and vice versa.

### 2. Aggregate the light and the pulse
The rail's three-state light (`strip-term-active` / `-done` / `-exited`) and its one-shot done pulse are per-terminal today. Aggregate per team:
- `light: 'done'` if **any** member has an unacknowledged completion badge — a team is "done" when it has something to report.
- else `'active'` if any member is active.
- else `'exited'`.
- `doneStamp` = the **maximum** member stamp. The pulse ledger (`pulsedDoneStamps`, `shell.js:481`) keys on name and compares stamps to distinguish a fresh completion from a stale one; a max over members preserves that property — a second member finishing raises the stamp and re-pulses exactly once, which is the desired signal.

Reuse `renderTerminalSection`'s existing pulse machinery verbatim, keying the ledger on `groupId` instead of terminal name. Do not fork the animation-resume logic at `shell.js:513` — the `Math.floor` and the strict `<` comparison there are both deliberate guards against a green flash on an expired completion, documented at length in place.

### 3. Render team buttons
In `renderTerminalSection`:
- Emit one button per team (in a stable order — definition order, then name; never fleet-poll order, which would make icons jump between polls).
- Then one button per **ungrouped** terminal, using today's exact per-terminal rendering. A terminal in no team must not disappear from the rail.
- Team button contents: the team icon as an `<img class="strip-team-icon">` (same `<img>` rationale as `shell.js:542`), plus a small member-count badge. With `light === 'done'`, the count reads as the badge already does for terminals.
- `aria-label`: `"<team name> · <n> agents · <head> leads [<light>]"`. `dataset.tooltip` mirrors it and adds the roster on subsequent lines — the strip's custom tooltip (`shell.js:196`) already handles multi-line and viewport flipping, so this is free.
- Keep the `hideStripTooltip()` call at the top of the function. A rebuild that removes a hovered button strands the overlay, and team rebuilds have the same hazard.

### 4. Click behaviour
A team button opens that team's cockpit: reuse the existing pop-out path, which already round-trips through the shell. `shell.js:731` handles `popoutTerminal` with `window.open('/terminals?solo=…', 'sb-term-<slug>')`; add a `popoutTeam` sibling opening `/terminals?team=<groupId>` under window name `sb-team-<groupId-slug>`, with the same already-open-then-focus check (`shell.js:566`) and the same `popoutBlocked` fallback message.

Clicking a team with an unacknowledged completion **is** the acknowledgement, exactly as it is for a terminal today (`shell.js:578`). Relay a `clearTeamBadges` message carrying `memberNames` so the panel clears every member's badge — otherwise the aggregate light burns forever, which is the regression the per-terminal `clearTerminalBadge` relay was added to prevent.

### 5. Keep a way back to per-terminal
Per-terminal marks remain genuinely useful when debugging one agent. Add a rail mode toggle — teams (default) / terminals — persisted alongside the other strip prefs. Do not ship this as a hard replacement: the plan's title says "in place of", but an operator who wants the old rail must not have to downgrade to get it.

## Edge cases
- **A team whose members span workspaces.** The group's `members` array is the truth; the rail must not re-derive membership from `worktreePath`. Tooltip shows the head's location; the roster lines carry each member's.
- **Head exited, members alive.** Still one team button, `light` from the aggregate. Do not special-case the head's death into hiding the team.
- **Every member exited.** `light: 'exited'`, button stays until the terminals are closed — same as today's per-terminal behaviour for an exited terminal.
- **Team with no icon** (definition deleted, or icon never set). Fall back to the role portrait, then to the head's CLI brand mark, then to the head's role letter. Three fallbacks deep is not over-engineering here: the rail is the primary navigation surface and must never render an empty button.
- **A terminal in two groups.** `terminals.groups` also holds derived `role` and `worktree` groups and hand-saved manual selections; a terminal can appear in several. Only groups where `isSpawnedTeamGroup(g)` is true become team buttons, so overlap with derived groups is not a conflict. If two *spawned* team groups somehow claim the same terminal, first-by-stable-order wins and the terminal is not also drawn as ungrouped.
- **Terminals panel closed.** `renderTerminalSection` already removes the whole `#strip-terminals` container when `frames.has('terminals')` is false (`shell.js:430`) and clears the pulse ledger. Team buttons live in the same container and inherit that, including the `applyBottomAnchor()` re-anchoring — verify the Setup/theme cluster still pins correctly with team buttons present.
- **Rail overflow.** Teams compress the common case, but 6 teams plus stragglers can still overflow a short window. `#strip-terminals` clips (noted at `shell.js:174`); confirm it scrolls rather than pushing the bottom cluster off-screen.

## Verification Plan
1. `npm run compile` — clean.
2. `src/test/shell-terminal-strip.test.js` — extend, do not replace. Existing per-terminal assertions must still pass in terminals mode; add team-mode cases.
3. Unit: aggregate light — any-done wins over active; all-exited yields exited; `doneStamp` is the member max; a second member completing raises the stamp.
4. Unit: pulse ledger keyed on `groupId` fires once per stamp change and resumes mid-animation on rebuild (mirror the existing per-terminal test).
5. Unit: ungrouped terminals still render, and a terminal claimed by a team does not render twice.
6. Unit: icon fallback chain — no team icon → role portrait → brand mark → role letter, with no empty button in any arm.
7. Manual, installed VSIX: start two teams plus one loose terminal. Rail shows two team icons and one CLI mark. Hover each — tooltip names the team, count, head, roster.
8. Manual: let a member finish. The team button pulses once and holds the done light. Click it — the cockpit opens, the light clears, and it does not re-pulse on the next poll.
9. Manual: toggle to terminals mode and confirm today's rail returns exactly; toggle back and confirm the mode persists across a shell reload.
10. Manual: close the Terminals panel and confirm the container disappears and the Setup + theme cluster stays anchored at the foot of the rail.

---

## Completion Report

Implemented all five subtasks of the Shell Strip plan. Files changed: `src/webview/terminals.js`, `src/webview/shell.js`, `src/webview/shell.html`, `src/test/shell-terminal-strip.test.js`.

### 1. `postFleetStateToShell` emits a `teams` array (terminals.js)
Extended `postFleetStateToShell` to build and send a `teams` array beside the existing `terminals` array. Each entry: `{ groupId, definitionId, name, head, headRole, iconUri, memberNames[], light, doneStamp, activeCount, exitedCount }`. Built panel-side from `terminalGroups` (spawned teams only, via `isSpawnedTeamGroup`), `fleetList` (live member status), and `_agentGroupsCache` (team definitions with `icon` field, refreshed async via `fetchAgentGroups`). Sorted by definition order then name — never fleet-poll order. `terminals` stays unchanged and complete (backward compat). Aggregate light: done > active > exited. `doneStamp` = max over member stamps. Three-deep icon fallback: team icon (via `resolveArtForShell`) → head's brand mark → null (shell falls back to role letter).

### 2. `renderTerminalSection` renders team buttons (shell.js)
Branches on `railMode`: 'teams' (default) renders one `.strip-team-btn` per team in stable order, then one `.strip-term-btn` per ungrouped terminal (claimed names excluded); 'terminals' renders the legacy per-terminal rail. Team buttons carry `strip-term-<light>` state classes (shared CSS with terminal buttons), a `.strip-team-icon` `<img>` (with `pixel-art` class for PNGs), and a `.strip-team-count` member-count badge. `aria-label` follows the plan spec: `"<team name> · <n> agents · <head> leads [<light>]"`. Tooltip mirrors aria-label plus roster on subsequent lines. `hideStripTooltip()` stays at the top. The per-terminal click handler was extracted into `buildTerminalButton(t, seenKeys)` so both modes share the exact same rendering and click behaviour.

### 3. Pulse ledger keyed on `groupId`
The pulse ledger (`pulsedDoneStamps`) uses composite keys: `'team:<groupId>'` for team buttons, `'term:<name>'` for terminal buttons. Same machinery, same guards (strict `<`, `Math.floor`, stamp gate, resume via negative animation-delay). Pruning uses `seenKeys` set that tracks both key forms.

### 4. `popoutTeam` + `clearTeamBadges`
Added `popoutTeam` handler in shell.js message listener — origin-guarded, opens `/terminals?team=<groupId>` with a unique window name (no dedup, per the cockpit plan's two-window allowance). Added `clearTeamBadges` handler in terminals.js — origin-guarded, clears all member badges, re-relays. Team button click: if `light === 'done'`, relays `clearTeamBadges` carrying `memberNames`; opens team cockpit via `window.open`; blocked pop-out falls back to peeking the head terminal in-panel.

### 5. Rail mode toggle
Added `ensureRailModeToggle(container)` — creates a `#strip-rail-mode` button after the orchestrator icon, persists mode in `localStorage` under `sb-rail-mode`, toggles between 'teams' (default) and 'terminals'. Clicking re-requests fleet state for immediate re-render. SVG icons: two overlapping circles for teams, terminal rectangle for terminals. CSS in shell.html for `.strip-rail-mode-btn` and `.strip-team-count` badge.

### Test updates
Updated `shell-terminal-strip.test.js` markers: `renderTerminalSection(terminals)` → `renderTerminalSection(terminals, teams)`, click handler test scoped to `buildTerminalButton`, tooltip wipe selector relaxed for compound `.strip-term-btn, .strip-team-btn` selector. All 46 tests pass.

### Verification
- `node -c` syntax check: shell.js OK, terminals.js OK
- `npx tsc --noEmit`: no new errors (5 pre-existing import-extension errors in unrelated files)
- `npm run catalog:check`: OK (regenerated to include `getIconPalette` from prior session)
- `node src/test/shell-terminal-strip.test.js`: 46 passed, 0 failed

### Red-team review
- **Pulse ledger key collision**: impossible — `'team:'` and `'term:'` prefixes are disjoint.
- **Stale ledger entries**: pruned by `seenKeys` set tracking both forms.
- **First-by-stable-order wins**: `claimedNames` set built from team member lists before rendering ungrouped terminals; a terminal in two spawned teams appears in the first team's button only.
- **Definition-only teams (no members)**: skipped (`liveMembers.length === 0 && members.length === 0`).
- **All-exited teams**: still render with `light: 'exited'` — same as per-terminal exited behaviour.
- **`localStorage` unavailable**: try/catch defaults to 'teams' mode.
- **`pixel-art` class**: applied to team icon PNGs only, not to SVG brand-mark fallbacks.
