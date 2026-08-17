# Terminal frames restore seat name and add crown icon for team lead

## Goal

The terminal pane headers in `terminals.html` no longer show the seat name (friendlyName) in dense team layouts, making it impossible to tell which pane is the team lead versus a coder. Additionally, the team lead should have a distinct crown icon so it is identifiable at a glance.

### Problem Analysis & Root Cause

**Seat name regression.** `updatePaneElement` in `terminals.js` (line 4832-4840) builds the pane title as:
- Non-terse layouts: `${agentLabel} · ${handle}` (e.g. "CLAUDE CLI · lead-1")
- Terse layouts (2x3, 3x3): `${agentLabel}` only (e.g. "CLAUDE CLI")

Teams commonly use 2x3 (4 members) or 3x3 (up to 9) layouts — exactly the layouts where the seat name is dropped. Every pane shows the same "CLAUDE CLI" label, so the operator cannot distinguish the lead from coders. The comment at line 4820 acknowledges "The agent name was absent from the pane header entirely" — the agent label was added but in terse layouts it *replaced* the handle instead of accompanying it. The sidebar row (`renderTerminalRow`, line 2214) correctly shows `${item.friendlyName} · ${item.role}` on the subline, so the information is available — the pane header just drops it in the one place it matters most.

**No team-lead icon.** The pane header shows a brand icon (`.pane-brand-icon`) resolved from the CLI label, not the role. A team lead and a coder running the same CLI (e.g. both Claude) get the identical brand icon. The frontend has the information to identify a team head: `terminalGroups` (loaded via `reloadTerminalGroups`) contains manual groups where the first member is the head (written by `wireSpawnedTeam` at `teamWiring.ts:1036`). The fleet list also exposes `parentInstanceId` — the head has no parentInstanceId while delegate children do — but that is not team-head-specific (any standalone terminal lacks it). The reliable signal is group membership: the first member of a `source: 'manual'` group is the head.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Adding the handle to the terse-layout pane title is a one-line conditional change in `updatePaneElement`.
- Adding a crown icon is a small DOM append in the same function, plus one CSS class.
- Identifying the team head is a lookup against the already-loaded `terminalGroups` array.

**Low risk:**
- The pane title is display-only chrome; no downstream logic reads `nameSpan.textContent`.
- The `titleEl.title` attribute already carries the full identity, so accessibility is unaffected.
- The brand icon rendering path is untouched — the crown is an additional element, not a replacement.

## Edge-Case & Dependency Audit

1. **No terminal groups loaded yet.** `terminalGroups` may be empty on first paint before `reloadTerminalGroups` resolves. The crown lookup must be defensive — no crown when groups are empty, not a crash.
2. **Terminal in multiple groups.** A terminal can be a member of multiple groups (extras overlay). The head check must look for `source: 'manual'` groups where the terminal is the *first* member, not just any group.
3. **Custom-renamed terminals.** The friendlyName may have been renamed by the operator. The group's `members` array stores friendlyNames, so the lookup still works after rename (the group is updated on rename).
4. **Exited terminals.** An exited head should still show the crown (dimmed), matching the brand icon's `.is-exited` treatment.
5. **Terse layout handle truncation.** In 2x3/3x3 the header is 10px with ellipsis. Adding the handle back means "CLAUDE CLI · lead-1" may ellipsise. The handle should come FIRST in terse layouts (it is the unique identifier), with the agent label dropped or truncated — the brand icon already carries the agent identity.
6. **Solo mode.** Solo mode forces `effectiveLayout = '1'` (non-terse), so the handle is already shown. No change needed there.

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

Add a crown icon for the team head. Insert a helper that checks whether the assigned terminal is the head of a manual group, then append a crown SVG:

```javascript
// After the brand icon is appended (line 4811), before the index chip:
if (isTeamHead(assignedName)) {
    const crown = document.createElement('span');
    crown.className = 'pane-crown-icon';
    crown.setAttribute('aria-hidden', 'true');
    crown.title = 'Team lead';
    crown.innerHTML = CROWN_SVG; // defined below
    titleEl.appendChild(crown);
}
```

New helper function (near `agentLabelForRole`):

```javascript
/**
 * Whether `name` is the head (first member) of a registered manual team group.
 * The head is the first entry in the group's members array, written by
 * wireSpawnedTeam (teamWiring.ts:1036). Defensive against empty/unloaded groups.
 */
function isTeamHead(name) {
    if (!name || !Array.isArray(terminalGroups)) { return false; }
    return terminalGroups.some(g =>
        g && g.source === 'manual' &&
        Array.isArray(g.members) &&
        g.members.length > 0 &&
        g.members[0] === name
    );
}
```

Crown SVG constant (inline, no external asset needed):

```javascript
const CROWN_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M2 5l3 3 3-5 3 5 3-3-1.5 7h-9L2 5z"/>'
    + '</svg>';
```

### `src/webview/terminals.html` — CSS for crown icon

Add after the `.pane-brand-icon` rules (line ~1175):

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
/* Dense grids: match the brand icon shrink */
.pane-grid.layout-1x3 .pane-crown-icon,
.pane-grid.layout-2x3 .pane-crown-icon,
.pane-grid.layout-3x3 .pane-crown-icon {
    width: 12px;
    height: 12px;
}
```

### `src/webview/terminals.js` — `renderTerminalRow` (sidebar row, ~line 2193)

Also add the crown to the sidebar role icon row so the sidebar and pane header agree:

```javascript
// After the brand icon is appended to roleRow (line 2207):
if (isTeamHead(item.friendlyName)) {
    const crown = document.createElement('span');
    crown.className = 'item-crown-icon';
    crown.setAttribute('aria-hidden', 'true');
    crown.title = 'Team lead';
    crown.innerHTML = CROWN_SVG;
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
```

## Verification Plan

1. **Terse layout shows seat name.** Start a Coding team (lead + 3 coders = 4 members, 2x2 layout — non-terse, shows "CLAUDE CLI · lead-1"). Switch to 2x3 or 3x3 layout. Confirm each pane header shows the handle (e.g. "lead-1", "coder-1") instead of just "CLAUDE CLI".
2. **Crown icon on team lead.** In the same team grid, confirm the lead's pane header shows a gold crown icon to the left of the seat name. Coders show no crown.
3. **Sidebar crown.** Confirm the sidebar row for the lead also shows the crown icon next to the role icon.
4. **Non-terse layout unchanged.** In 2x2 layout, confirm the pane header still shows "CLAUDE CLI · lead-1" (agent label + handle) with the crown.
5. **No team, no crown.** Start a standalone terminal (no team). Confirm no crown icon appears in the pane header or sidebar.
6. **Exited head.** Kill the lead terminal. Confirm the crown remains visible but dimmed (opacity 0.45), matching the brand icon treatment.
7. **Custom rename.** Rename the lead terminal. Confirm the crown follows the renamed terminal (group members array is updated on rename).
8. **Run existing tests.** `npx jest src/test/standing-orders-marker-contract.test.js` — the pane title change is display-only and does not affect the standing-orders marker contract.
