# Terminal frames restore seat name and add crown icon for team lead

## Goal

The terminal pane headers in `terminals.html` no longer show the seat name (friendlyName) in dense team layouts, making it impossible to tell which pane is the team lead versus a coder. Additionally, the team lead should have a distinct crown icon so it is identifiable at a glance.

### Problem Analysis & Root Cause

**Seat name regression.** `updatePaneElement` in `terminals.js` (line 4832-4840) builds the pane title as:
- Non-terse layouts: `${agentLabel} · ${handle}` (e.g. "CLAUDE CLI · lead-1")
- Terse layouts (2x3, 3x3): `${agentLabel}` only (e.g. "CLAUDE CLI")

Teams commonly use 2x3 (4 members) or 3x3 (up to 9) layouts — exactly the layouts where the seat name is dropped. Every pane shows the same "CLAUDE CLI" label, so the operator cannot distinguish the lead from coders. The comment at line 4820 acknowledges "The agent name was absent from the pane header entirely" — the agent label was added but in terse layouts it *replaced* the handle instead of accompanying it. The sidebar row (`renderTerminalRow`, line 2214) correctly shows `${item.friendlyName} · ${item.role}` on the subline, so the information is available — the pane header just drops it in the one place it matters most.

**No team-lead icon.** The pane header shows a brand icon (`.pane-brand-icon`) resolved from the CLI label, not the role. A team lead and a coder running the same CLI (e.g. both Claude) get the identical brand icon. The frontend has the information to identify a team head: `terminalGroups` (loaded via `reloadTerminalGroups`) contains manual groups where the first member is the head (written by `wireSpawnedTeam` at `teamWiring.ts:1039`: `const groupMembers = [headName, ...childNames]`). The fleet list also exposes `parentInstanceId` — the head has no parentInstanceId while delegate children do — but that is not team-head-specific (any standalone terminal lacks it). The reliable signal is group membership: the first member of a team-spawned group is the head. Team-spawned groups are distinguishable from operator-saved groups by their ID prefix: `team_` (teamWiring.ts:918) vs `grp_` (terminals.js:2396, 2530).

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## User Review Required

The head-identification mechanism relies on a `team_` ID prefix convention (teamWiring.ts:918) to distinguish team-spawned groups from manually saved groups. Both group types carry `source: 'manual'`, so the prefix is the only reliable discriminator. Review whether this convention is stable enough to depend on, or whether a more explicit flag should be added to the group object in a follow-up.

## Complexity Audit

### Routine
- Adding the handle to the terse-layout pane title is a one-line conditional change in `updatePaneElement`.
- Adding a crown icon is a small DOM append in the same function, plus one CSS class.
- Identifying the team head is a lookup against the already-loaded `terminalGroups` array.
- The pane title is display-only chrome; no downstream logic reads `nameSpan.textContent`.
- The `titleEl.title` attribute already carries the full identity, so accessibility is unaffected.
- The brand icon rendering path is untouched — the crown is an additional element, not a replacement.

### Complex / Risky
- The `isTeamHead` helper must distinguish team-spawned groups (`id` prefix `team_`) from operator-saved groups (`id` prefix `grp_`); both carry `source: 'manual'`, so checking source alone produces false crowns on manually saved groups.
- The crown must receive `.is-exited` dimming to match the brand icon treatment; this requires stamping the class at creation time in both the pane header and the sidebar row.

## Edge-Case & Dependency Audit

### Race Conditions
- **No terminal groups loaded yet.** `terminalGroups` may be empty on first paint before `reloadTerminalGroups` resolves. The crown lookup must be defensive — no crown when groups are empty, not a crash. The `isTeamHead` helper guards with `Array.isArray(terminalGroups)`.

### Security
- None. The crown is a display-only DOM element with no data flow, no verb calls, no user input handling. `pointer-events: none` prevents interaction.

### Side Effects
- **Terminal in multiple groups.** A terminal can be a member of multiple groups (extras overlay). The head check must look for `team_`-prefixed groups where the terminal is the *first* member, not just any group.
- **Custom-renamed terminals.** The friendlyName may have been renamed by the operator. `renameTerminal` (terminals.js:7173-7183) updates `g.members` and `g.order` arrays in-place, replacing the old name with the new name. The group's `name` field is NOT updated (it stays as the original head name), but `isTeamHead` uses `members[0]`, not `name`, so the lookup still works after rename.
- **Exited terminals.** An exited head should still show the crown (dimmed), matching the brand icon's `.is-exited` treatment. The crown element must receive the `is-exited` class at creation time, same as the brand icon at line 4807-4808.
- **Terse layout handle truncation.** In 2x3/3x3 the header is 10px with ellipsis. Adding the handle back means "CLAUDE CLI · lead-1" may ellipsise. The handle should come FIRST in terse layouts (it is the unique identifier), with the agent label dropped — the brand icon already carries the agent identity.
- **Solo mode.** Solo mode forces `effectiveLayout = '1'` (non-terse), so the handle is already shown. No change needed there.

### Dependencies & Conflicts
- None. This plan is self-contained within `src/webview/terminals.js` and `src/webview/terminals.html`. No verb schemas, no provider arms, no host seams, no backend changes.

## Dependencies

None — this plan is a self-contained frontend change with no dependency on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) false crowns on operator-saved groups if `isTeamHead` checks only `source: 'manual'` without the `team_` ID prefix discriminator; (2) missing `.is-exited` dimming on the crown if the class is not stamped at creation time in both pane and sidebar. Mitigations: `isTeamHead` requires `g.id.startsWith('team_') && g.members[0] === name`; the crown element receives `is-exited` when `fleetItem?.status === 'exited'` (pane) or `item.status === 'exited'` (sidebar), mirroring the brand icon pattern at line 4807-4808.

## Proposed Changes

### `src/webview/terminals.js` — `updatePaneElement` (line ~4832)

Change the terse-layout branch to show the handle (seat name) instead of the agent label, since the brand icon already identifies the CLI:

```javascript
// BEFORE (line 4834-4840):
if (!agentLabel) {
    nameSpan.textContent = handle;
} else if (isTerseLayout()) {
    nameSpan.textContent = agentLabel;
} else {
    nameSpan.textContent = `${agentLabel} · ${handle}`;
}

// AFTER:
if (!agentLabel) {
    nameSpan.textContent = handle;
} else if (isTerseLayout()) {
    // Brand icon already carries the CLI identity; the handle (seat name)
    // is the unique identifier that tells siblings apart in a dense grid.
    nameSpan.textContent = handle;
} else {
    nameSpan.textContent = `${agentLabel} · ${handle}`;
}
```

### `src/webview/terminals.js` — `updatePaneElement` (after brand icon append, ~line 4812)

Add a crown icon for the team head. Insert after the brand icon is appended (line 4811), before the index chip (line 4814). The crown receives `.is-exited` dimming when the terminal is exited, matching the brand icon treatment at line 4807-4808:

```javascript
// After the brand icon is appended (line 4811), before the index chip:
if (isTeamHead(assignedName)) {
    const crown = document.createElement('span');
    crown.className = 'pane-crown-icon';
    crown.setAttribute('aria-hidden', 'true');
    crown.title = 'Team lead';
    crown.innerHTML = CROWN_SVG; // defined at module scope below
    if (fleetItem && fleetItem.status === 'exited') {
        crown.classList.add('is-exited');
    }
    titleEl.appendChild(crown);
}
```

### `src/webview/terminals.js` — `isTeamHead` helper and `CROWN_SVG` constant (near `agentLabelForRole`, line ~6346)

> **Superseded:** `isTeamHead` checked `g.source === 'manual' && g.members[0] === name`.
> **Reason:** Both team-spawned groups (teamWiring.ts:1044) and operator-saved groups (terminals.js:2401, 2535) carry `source: 'manual'`. Without the ID prefix check, the first member of every manually saved group gets a false crown — an operator who saves a group named "My Coders" sees a gold crown on the first coder.
> **Replaced with:** `isTeamHead` requires `g.id.startsWith('team_')` to distinguish team-spawned groups (ID prefix `team_`, teamWiring.ts:918) from manually saved groups (ID prefix `grp_`, terminals.js:2396, 2530). The `members[0] === name` check is retained because it survives rename (renameTerminal updates members in-place at lines 7173-7183).

New helper and constant at module scope:

```javascript
const CROWN_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M2 5l3 3 3-5 3 5 3-3-1.5 7h-9L2 5z"/>'
    + '</svg>';

/**
 * Whether `name` is the head (first member) of a registered team-spawned group.
 * The head is the first entry in the group's members array, written by
 * wireSpawnedTeam (teamWiring.ts:1039: `const groupMembers = [headName, ...childNames]`).
 *
 * Team-spawned groups are identified by their `team_` ID prefix (teamWiring.ts:918);
 * operator-saved groups use `grp_` (terminals.js:2396, 2530) and must NOT trigger
 * a crown — both carry source: 'manual', so the ID prefix is the only discriminator.
 *
 * Survives rename: renameTerminal (terminals.js:7173-7183) updates g.members and
 * g.order in-place, so members[0] tracks the renamed head. The group's `name`
 * field is NOT updated on rename, which is why this uses members[0], not g.name.
 *
 * Defensive against empty/unloaded groups.
 */
function isTeamHead(name) {
    if (!name || !Array.isArray(terminalGroups)) { return false; }
    return terminalGroups.some(g =>
        g && typeof g.id === 'string' &&
        g.id.startsWith('team_') &&
        g.source === 'manual' &&
        Array.isArray(g.members) &&
        g.members.length > 0 &&
        g.members[0] === name
    );
}
```

### `src/webview/terminals.html` — CSS for crown icon (after `.pane-brand-icon` rules, line ~1195)

```css
.pane-crown-icon {
    flex-shrink: 0;
    align-self: center;
    width: 14px;
    height: 14px;
    color: var(--feature-accent, #D4A017);
    opacity: 0.95;
    pointer-events: none;
    margin-right: 2px;
}
.pane-crown-icon.is-exited { opacity: 0.45; }
/* Dense grids: match the brand icon shrink — 1x3/2x3/3x3 have narrow columns */
.pane-grid.layout-1x3 .pane-crown-icon,
.pane-grid.layout-2x3 .pane-crown-icon,
.pane-grid.layout-3x3 .pane-crown-icon {
    width: 12px;
    height: 12px;
}
```

### `src/webview/terminals.js` — `renderTerminalRow` (sidebar row, ~line 2207)

Also add the crown to the sidebar role icon row so the sidebar and pane header agree. The crown receives `.is-exited` dimming when the terminal is exited, using `item.status` which is already in scope (line 2173: `const exitedSuffix = item.status === 'exited' ? ' (exited)' : ''`):

```javascript
// After the brand icon is appended to roleRow (line 2207):
if (isTeamHead(item.friendlyName)) {
    const crown = document.createElement('span');
    crown.className = 'item-crown-icon';
    crown.setAttribute('aria-hidden', 'true');
    crown.title = 'Team lead';
    crown.innerHTML = CROWN_SVG;
    if (item.status === 'exited') {
        crown.classList.add('is-exited');
    }
    roleRow.appendChild(crown);
}
```

### `src/webview/terminals.html` — CSS for sidebar crown

```css
.item-crown-icon {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    color: var(--feature-accent, #D4A017);
    opacity: 0.95;
    pointer-events: none;
    margin-left: 2px;
}
.item-crown-icon.is-exited { opacity: 0.45; }
```

## Verification Plan

### Automated Tests
- `npm run test:contract:standing-orders-marker` — the repo has no jest dependency and its tests are plain node scripts, so the original `npx jest ...` form here could never run; the CI-wired npm script (`.github/workflows/integration-tests.yml`) is the real gate. It covers `reloadTerminalGroups` and the `wireSpawnedTeam` roster upsert (including "unknown keys survive upsert"), which is what the crown reads.
- `npm run test:contract:external-headed-team` — the discriminating check for the crown: it asserts an external-headed team's `members` excludes the head.

### Manual Verification
1. **Terse layout shows seat name.** Start a Coding team (lead + 3 coders = 4 members, 2x2 layout — non-terse, shows "CLAUDE CLI · lead-1"). Switch to 2x3 or 3x3 layout. Confirm each pane header shows the handle (e.g. "lead-1", "coder-1") instead of just "CLAUDE CLI".
2. **Crown icon on team lead.** In the same team grid, confirm the lead's pane header shows a gold crown icon to the left of the seat name. Coders show no crown.
3. **Sidebar crown.** Confirm the sidebar row for the lead also shows the crown icon next to the role icon.
4. **Non-terse layout unchanged.** In 2x2 layout, confirm the pane header still shows "CLAUDE CLI · lead-1" (agent label + handle) with the crown.
5. **No team, no crown.** Start a standalone terminal (no team). Confirm no crown icon appears in the pane header or sidebar.
6. **Exited head.** Kill the lead terminal. Confirm the crown remains visible but dimmed (opacity 0.45), matching the brand icon treatment.
7. **Custom rename.** Rename the lead terminal. Confirm the crown follows the renamed terminal (group members array is updated on rename at terminals.js:7173-7183).
8. **Manually saved group — no false crown.** Save a group via the sidebar (saveCurrentAsGroup or saveSelectionAsGroup). Confirm the first member of that group does NOT get a crown — only `team_`-prefixed groups produce crowns.

## Completion Report

Implemented seat name restoration in dense/terse layouts (`2x3`, `3x3`) and added crown icon for team lead across pane headers and sidebar rows. Modified `src/webview/terminals.js` (`isTeamHead`, `CROWN_SVG`, `updatePaneElement`, `renderTerminalRow`) and `src/webview/terminals.html` (`.pane-crown-icon`, `.item-crown-icon`). Verified with red team review and accuracy protocol; no issues encountered.

## Review Findings

Reviewed against the plan; two material defects fixed. **CRITICAL — false crown on external-headed teams:** `wireSpawnedTeam` deliberately omits the head from `members` when `externalHead` is set (`teamWiring.ts`, verified by `external-headed-team-contract.test.js` case 3), so `members[0]` was the first *coder* and wore the lead crown — the exact confusion the icon exists to remove; fixed by persisting an `externalHead` flag on the group object and gating `isTeamHead` on `!g.externalHead`. **MAJOR — dense-grid shrink was a no-op:** `CROWN_SVG` carries `width="14" height="14"`, which beat the wrapper span, so the 1x3/2x3/3x3 12px rule spilled a 14px glyph out of a 12px slot; fixed with a `.pane-crown-icon svg, .item-crown-icon svg { width:100%; height:100% }` rule, and `margin-right:2px` was dropped from `.pane-crown-icon` because the adjacent `.pane-brand-icon` comment explicitly forbids stacking a margin on `.pane-title`'s `gap:6px`. Also corrected two comments in `updatePaneElement` that still claimed terse layouts show the agent label alone. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/services/teamWiring.ts`. Validation — `tsc -p tsconfig.test.json` clean, `node --check terminals.js` clean, eslint clean, and green on `external-headed-team` (9), `standing-orders-marker` (55), `terminal-sidebar-groupings` (53), `terminal-groups-key` (18), `terminal-pane-grid-reconcile`, `team-autostart-scope` (21), plus all three PRD gates (`verb-returns:check`, `parity:check`, `push-routing:check`). Remaining risks: the `team_` ID-prefix convention is still the discriminator against `grp_` operator groups (the plan's own User Review Required item stands); external teams wired *before* this change keep a flag-less stored group and will show the stale false crown until re-wired; and a cross-panel `terminalsGroupsChanged` broadcast refreshes the sidebar crown immediately but the pane crown only on the next 5s fleet poll — not fixed, because `renderPaneGrid()` tears down and reparents live xterms and the team-start path (`switchToTeamGroup` → `switchToGroup` → `renderPaneGrid`) already paints it at once.
