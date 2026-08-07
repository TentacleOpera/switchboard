# Terminals Panel: Show the Agent CLI Name in the Sidebar Rows and on the Pane Header

## Goal

Make the agent's CLI name (`CLAUDE CLI`) the identity a user reads in the Terminals panel — lead with it in the sidebar rows instead of the raw `planner-2` handle, and put it on the pane header frame, where it is currently absent entirely.

### Problem Analysis & Root Cause

Two surfaces in `src/webview/terminals.js` render a terminal's identity, and neither leads with the agent name.

**1. Sidebar rows lead with the generated handle.** `renderTerminalRow`:

```js
const termNameEl = document.createElement('div');
termNameEl.className = 'item-name';
termNameEl.textContent = item.friendlyName;          // ← "planner-2"

const roleEl = document.createElement('div');
roleEl.className = 'item-role';
const cliLabel = agentNames[item.role];
roleEl.textContent = (cliLabel && cliLabel !== 'No agent assigned')
    ? `${item.role} · ${cliLabel}`                    // ← "planner · CLAUDE CLI", secondary
    : item.role;
```

`friendlyName` is not a name a human chose — it is a uniquifier minted by the fleet service (`src/standalone/ptyFleetService.ts`, `create`):

```js
let name = friendlyName || `${role}-1`;
let counter = 1;
while (this.terminals.has(name)) { counter++; name = `${role}-${counter}`; }
```

So the primary, high-contrast line of every row (`.item-name`, styled at `terminals.html:335`; `.terminal-item.assigned .item-name` gets `--text-primary` at `:768`) reads `planner-2`, and the agent CLI name is demoted to the dim `.item-role` subline (`terminals.html:342`) behind the role slug.

**2. The pane header has no agent name at all.** `updatePaneElement` builds `.pane-title` from exactly three things — the pane-index chip, the `friendlyName` (plus an `(exited)` / `(no longer listed)` suffix), and the badge/input-state chips:

```js
titleEl.textContent = '';
if (assignedName) {
    …idxEl (P1 / 📌P1)…
    let displayTitle = assignedName;                  // ← "planner-2", nothing else
    …' (exited)' / ' (no longer listed)' suffixes…
    titleEl.appendChild(document.createTextNode(displayTitle));
    …badge chip, input-state chip…
}
```

`agentNames` is not consulted anywhere in the pane-rendering path. The map itself is present and correct — `fetchAgentNames()` pulls it from the existing `getStartupCommands` verb, which returns the same `agentNames` the kanban column sublines use (`KanbanProvider._getAgentNames` derives `basename(startupCommand).toUpperCase() + ' CLI'`), and `init()` deliberately awaits it before the first paint *"so rows do not visibly gain their CLI name a beat after appearing."* There is even a self-heal that re-fetches when an unknown role appears (`fetchTerminalList`). The data was plumbed all the way to the webview and then used only for the dim subline.

**Root cause:** the two render paths treat `friendlyName` as *the* display name because it is also the identity key — it is what `locateTerminal`, `clearTerminal`, `renameTerminal`, `paneAssignments`, `terminalBadges` and `resolveInputState` are all keyed on. Displaying the key was the path of least resistance, and the agent label — already fetched, already pre-derived, already awaited before first paint — was never promoted to the primary slot or wired into the pane header at all.

### The constraint that shapes the fix

`friendlyName` must stay **visible**, because it is the only thing that distinguishes two terminals running the same agent (`planner-1` vs `planner-2` are both `CLAUDE CLI`), and because the inline rename reads it out of the DOM:

```js
listEl.addEventListener('dblclick', (e) => {
    const nameEl = e.target.closest('.item-name');
    if (nameEl && nameEl.textContent) { beginInlineRename(nameEl, nameEl.textContent); }
});
```

and `beginInlineRename(nameEl, currentName)` passes that text straight to `renameTerminal(currentName, next)`. So changing `.item-name`'s text to the CLI label **without** re-pointing the rename source would make double-click rename target a terminal called `CLAUDE CLI`, which does not exist. That is the single most likely way to break this fix.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/terminals.js`, `src/webview/terminals.html`
- **Risk:** Medium-low — display-only, but the display element doubles as the rename input source and the pane header has hard width limits in the 6- and 9-pane layouts.

## User Review Required

None. Lead with the agent CLI name, keep the unique handle visible as secondary, and put the agent name on the pane header — all three are stated in the report.

> `src/webview/terminals.js` is under active concurrent edit (recently gained `paneModes` / `kanbanPaneColumn`). Anchor on the named functions `renderTerminalRow` and `updatePaneElement`, not on line numbers.

## Complexity Audit

### Routine
- Swap which string goes in `.item-name` and which in `.item-role`.
- Prepend the CLI label to the pane title text.

### Complex / Risky
- **Inline rename reads `.item-name`'s `textContent`.** Must be re-pointed at the element that carries `friendlyName`, or stamped via `dataset.friendlyName`, before the swap. Silent breakage otherwise: the rename posts a verb naming a nonexistent terminal.
- **Terse layouts.** `isTerseLayout()` returns true for `2x3` and `3x3`, and `.pane-grid.layout-2x3 .pane-title` / `.layout-3x3 .pane-title` carry dedicated CSS (`terminals.html:592-595`) precisely because those headers cannot fit long strings — the header font drops to 10px and the input-state chip collapses to a dot there. Adding a second name unconditionally would overflow. The pane header needs a compact form in terse layouts.

   > **Superseded:** "…the action buttons are already abbreviated to `c` / `h` / `p` there."
   > **Reason:** False in the current working tree (verified during improve pass): `updatePaneElement` sets the pane action buttons to their full words (`clear` / `hide`) unconditionally, and the comment above `isTerseLayout()` (`terminals.js:1667-1669`) states "Button labels are NOT condensed — the title ellipsizes first by flex design."
   > **Replaced with:** What terse layouts condense is the input-state chip (dot only, via `syncInputStateChip`) and the header font/padding; the width pressure is real but carried by the title's ellipsis, not by abbreviated buttons.
- **Missing / sentinel labels.** `agentNames[role]` can be absent (fetch failed — the catch comment says *"labels are decoration — a failure must not blank the sidebar"*) or the literal `'No agent assigned'` for a role with no startup command, and `role` can be `'shell'` (the `NO_ROLE` constant, deliberately without a CLI). Every one of those must fall back gracefully, never to an empty primary line.
- **Kanban-mode panes** return early from `updatePaneElement` via `renderKanbanPane` and have no assigned terminal; the title change must sit inside the `if (assignedName)` branch only.
- **`updatePaneElement`'s load-bearing rule** — *"touch `entry.container`'s parent ONLY when the assignment for this slot actually changed"* — must not be disturbed. The title is rebuilt every reconcile already (`titleEl.textContent = ''` then re-append), so adding text there is safe; do not move terminal DOM.
- **Solo mode** sets `document.title = soloTerminalName` in `init()`. Worth extending to include the agent name, but only after `fetchAgentNames` resolves — and solo mode does not call it today (it takes the other `init()` branch). **Decision: leave solo's `document.title` as the raw name** — a pop-out window title is an OS-level identifier the user matches against the taskbar, and it is outside the two surfaces named in the report.

## Edge-Case & Dependency Audit

1. **Two terminals, same agent.** `planner-1` and `planner-2` both resolve to `CLAUDE CLI`. The handle must remain visible on each row (secondary line) and in each pane header, or the rows become indistinguishable.
2. **Renamed terminal.** `renameTerminal` changes `friendlyName` to an arbitrary user string; `agentNames` is keyed on `role`, which does not change. So a renamed terminal keeps its CLI label and shows the new handle. Verify a rename round-trip.
3. **`agentNames` empty (verb failed).** Fall back to `role`, then to `friendlyName`. Primary line must never be blank.
4. **`'No agent assigned'`** — the existing sentinel from `_getAgentNames` for a role with no startup command. Already special-cased in the current subline logic; keep that check and fall back to the role.
5. **`role === 'shell'`** (`NO_ROLE`) — deliberately has no CLI, and the code comments warn against giving it one. Show the handle as primary for shell terminals.
6. **Exited / no-longer-listed suffixes** must stay attached to the *handle*, not the agent label — `planner-2 (exited)` is meaningful; `CLAUDE CLI (exited)` is not.
7. **Terse pane headers.** In `2x3` / `3x3`, render the agent label only (dropping the handle from the header) — the pane-index chip `P5` already disambiguates panes, and the sidebar row carries the handle. Confirm no overflow at 9 panes. (The header is 10px with an ellipsising title and a dot-only state chip there — the "abbreviated `c`/`h`/`p` buttons" this plan originally cited do not exist; see the superseded callout in the Complexity Audit.)
8. **Badge and input-state chips** are appended to `.pane-title` after the text (`terminalBadges`, `syncInputStateChip`). The title comment in `terminals.html:673` notes `.pane-title` is a flex row whose terminal name must be the shrinkable element — the new label must live inside that shrinkable text node/span, not as a third flex child that steals space from the chips.
9. **Sidebar CSS.** `.item-name` and `.item-role` differ in size/colour (`terminals.html:335`, `:342`) and `.terminal-item.assigned .item-name` promotes the primary colour. Swapping the *content* means the CLI label inherits the primary treatment, which is the intent — but check truncation: `CLAUDE CLI` is short, while a long custom rename in the subline may need `text-overflow: ellipsis`. **`.item-role` also carries `text-transform: capitalize`** — tolerable while it shows `role · CLI LABEL` (both already capitalised words), but once the subline leads with the *handle* it would render `planner-2` as `Planner-2` and mangle the case of any mixed-case custom rename. Displaying an identity key in the wrong case is exactly the class of lie this feature exists to remove, so the rule must be dropped as part of this change (see Proposed Changes).
10. **`postFleetStateToShell`** sends `{ name, role, worktreePath, light }` to the shell rail, which builds its own label `${t.name} · ${t.role} · ${wtBase}`. That is a *different* surface (the rail tooltip) and is out of scope here; note it so a later report about the rail is not mistaken for this one.
11. **Accessibility.** The pane header is visual only; add the composed name to the pane's `aria-label` (or the title element's `title` attribute) so the full `AGENT · handle` string is available even in terse layouts.

## Dependencies

- None — no session dependencies. Independent of the two sibling picker plans: they touch the `.layout-picker` block and `setLayoutMode`/`init()`'s boot continuation; this plan touches `renderTerminalRow`, the dblclick binding, `updatePaneElement`, and sidebar/pane CSS. Only shared lines are inside `init()` (event-binding region vs boot-continuation region — no overlap). Land last for merge-hygiene only; see the feature file's Dependencies & sequencing.

## Adversarial Synthesis

Key risks: breaking inline rename by leaving the dblclick handler reading `.item-name`'s `textContent` after it starts showing the CLI label (mitigated by the `dataset.friendlyName` stamp and a rename round-trip UAT — the single most likely regression); pane-header overflow in terse `2x3`/`3x3` layouts (mitigated by the agent-only terse form, the `.pane-title-name` shrinkable span, and a 9-pane UAT); and `.item-role`'s `text-transform: capitalize` silently mis-casing the handle now displayed there (mitigated by dropping the rule in this change). All fallbacks (`agentNames` empty, `No agent assigned`, `shell` role) resolve to the handle, so no surface can render blank.

## Proposed Changes

### `src/webview/terminals.js`

**1. One resolver, used by both surfaces** (place near `fetchAgentNames`):

```js
/**
 * The agent CLI label for a role, or '' when there isn't one.
 *
 * Handles the three no-label cases: the map is empty (fetchAgentNames swallows
 * failures — labels must never blank the sidebar), the role has no startup
 * command (KanbanProvider._getAgentNames returns the literal 'No agent
 * assigned'), and the deliberate CLI-less `shell` role (NO_ROLE).
 */
function agentLabelForRole(role) {
    if (!role || role === NO_ROLE) { return ''; }
    const label = agentNames[role];
    if (!label || label === 'No agent assigned') { return ''; }
    return label;
}
```

**2. `renderTerminalRow`** — lead with the agent, keep the handle secondary, and stamp the handle for the rename path:

```js
const agentLabel = agentLabelForRole(item.role);

const termNameEl = document.createElement('div');
termNameEl.className = 'item-name';
// Lead with the agent CLI name. friendlyName is a uniquifier minted by
// ptyFleetService (`${role}-${n}`), not a name anyone chose, so it belongs on the
// subline. It stays VISIBLE because it is the only thing separating two terminals
// running the same agent — and it stays available to the rename path via the
// dataset stamp below, which the dblclick handler now reads instead of textContent.
termNameEl.textContent = agentLabel || item.friendlyName;
termNameEl.dataset.friendlyName = item.friendlyName;
termNameEl.title = `${agentLabel ? agentLabel + ' — ' : ''}${item.friendlyName} (${item.role})`;

const roleEl = document.createElement('div');
roleEl.className = 'item-role';
// Handle first on the subline: it is what the user needs to tell siblings apart.
roleEl.textContent = agentLabel
    ? `${item.friendlyName} · ${item.role}`
    : item.role;
```

**3. The dblclick rename binding in `init()`** — read the stamp, not the rendered text:

```js
listEl.addEventListener('dblclick', (e) => {
    const nameEl = e.target && e.target.closest ? e.target.closest('.item-name') : null;
    // dataset, NOT textContent: .item-name now shows the agent CLI label, and
    // renameTerminal(currentName, next) needs the real friendlyName key.
    const current = nameEl && nameEl.dataset ? nameEl.dataset.friendlyName : '';
    if (nameEl && current) { beginInlineRename(nameEl, current); }
});
```

**4. `updatePaneElement`** — put the agent name on the header frame, inside the existing `if (assignedName)` branch, replacing the `displayTitle` construction:

```js
const fleetItem = fleetList.find(t => t.friendlyName === assignedName);
const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);

// The agent name was absent from the pane header entirely. Terse layouts
// (2x3/3x3) get the label alone — those headers already abbreviate the action
// buttons to single letters, and the P<n> chip plus the sidebar row carry the
// handle. Status suffixes attach to the HANDLE: "planner-2 (exited)" is
// meaningful, "CLAUDE CLI (exited)" is not.
let handle = assignedName;
if (fleetItem && fleetItem.status === 'exited') {
    handle += ' (exited)';
} else if (!fleetItem && hasFetchedList) {
    handle += ' (no longer listed)';
}

const nameSpan = document.createElement('span');
nameSpan.className = 'pane-title-name';   // the shrinkable flex child
if (!agentLabel) {
    nameSpan.textContent = handle;
} else if (isTerseLayout()) {
    nameSpan.textContent = agentLabel;
} else {
    nameSpan.textContent = `${agentLabel} · ${handle}`;
}
titleEl.appendChild(nameSpan);
// Full identity stays reachable even when the terse header shows only the agent.
titleEl.title = `${agentLabel ? agentLabel + ' — ' : ''}${handle}`;
paneEl.setAttribute('aria-label', `Pane ${index + 1}: ${titleEl.title}`);
```

### `src/webview/terminals.html`

Give the new span the shrink behaviour the existing `.pane-title` comment requires (near the `.pane-title` rules):

```css
/* The name is the ONLY shrinkable child of the .pane-title flex row — the
   pane-index chip, badge and input-state chip must keep their intrinsic width
   (see the mandatory note on .pane-title above). */
.pane-title-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

and ensure `.item-role` truncates and stops re-casing, since it now carries the case-sensitive handle plus a potentially long custom rename:

```css
.item-role {
    /* …existing rules MINUS text-transform: capitalize — the subline now leads
       with friendlyName, an identity key whose case is meaningful ("planner-2",
       and any mixed-case custom rename). Capitalize was decoration for the old
       `role · CLI LABEL` content; kept, it would print "Planner-2". */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

## Verification Plan

> Session directive: no compilation step and no automated test runs as part of this verification. Static review plus manual UAT only.

1. **Static review:** `agentLabelForRole` is the single resolver used by both surfaces; the dblclick binding reads `dataset.friendlyName` (never `textContent`); the pane-title change sits inside the `if (assignedName)` branch; `updatePaneElement` still moves no terminal DOM (only the title subtree is rebuilt, as before); `.item-role` no longer carries `text-transform: capitalize`. `src/webview/terminals.js` is under concurrent edit — anchor on the named functions when applying, not line numbers.
2. **UAT — sidebar leads with the agent.** With a `planner` terminal running and `claude` configured as that role's startup command, the sidebar row's primary line reads `CLAUDE CLI` and the subline reads `planner-2 · planner`. The raw handle is no longer the prominent text.
3. **UAT — pane header shows the agent.** Seat that terminal in a pane: the header reads `P1  CLAUDE CLI · planner-2`, plus any badge/input-state chips.
4. **UAT — two terminals, same agent.** Spawn `planner-1` and `planner-2`. Both rows show `CLAUDE CLI` as primary; their sublines differ, and their pane headers differ. They are distinguishable at a glance.
5. **UAT — rename still works (the regression this fix could cause).** Double-click a sidebar row's primary line: the inline input opens pre-filled with the **handle** (`planner-2`), not `CLAUDE CLI`. Rename to `alpha`, press Enter: the terminal is renamed, the row's subline shows `alpha · planner`, the primary line still shows `CLAUDE CLI`, and the pane header reads `CLAUDE CLI · alpha`. Scrollback is intact.
6. **UAT — no agent configured.** Clear the startup command for a role (so `_getAgentNames` yields `No agent assigned`) and open a terminal for it: the row's primary line falls back to the handle, the subline shows the role, and the pane header shows the handle. Nothing is blank.
7. **UAT — shell terminal.** Open a `shell`-role terminal: primary line is the handle (no fabricated CLI label).
8. **UAT — labels unavailable.** Block `POST /kanban/verb/getStartupCommands` (stop the server briefly, then open the panel): rows still render with handle-only names, no exceptions in the console, and the labels appear after the next `terminalsChanged` refetch.
9. **UAT — terse layouts.** Switch to `2x3` and then `3x3` with panes filled: headers show the agent label only, with no overflow, no wrapping, and the `c`/`h`/`p` buttons still visible. Hovering a header reveals the full `AGENT — handle` string.
10. **UAT — exited terminal.** Kill a terminal's process: the pane header reads `CLAUDE CLI · planner-2 (exited)` — the suffix on the handle, not on the label — and the sidebar row's status dot goes to the exited state.
11. **UAT — kanban-mode pane.** Set an empty pane to kanban mode: it renders the column viewer unchanged, with no agent-name text injected.
12. **UAT — long rename truncates.** Rename a terminal to a 60-character string: the sidebar subline ellipsises, the pane header name ellipsises, and the pane-index/badge/input-state chips keep their full width.

## Completion Report

Implemented the agent CLI name surfacing in `src/webview/terminals.js` and `src/webview/terminals.html`. Added `agentLabelForRole()`, rewrote `renderTerminalRow()` to lead with the agent label while stamping the real `friendlyName` in `dataset.friendlyName`, and rewrote `updatePaneElement()` to show `AGENT · handle` in the pane header (agent-only in terse `2x3`/`3x3` layouts). Updated the sidebar dblclick rename binding to read `dataset.friendlyName`. In the HTML, added `.pane-title-name` shrink rules and removed `text-transform: capitalize` from `.item-role` so mixed-case handles survive. `node --check src/webview/terminals.js` passed.

## Review Findings

**Stage 1 (Grumpy):** Oh good, the plan that could break rename if a single line was wrong. Let's see if they managed it. `agentLabelForRole()` — returns `''` for `NO_ROLE` ('shell'), empty map, and `'No agent assigned'`. Correct. `renderTerminalRow()` — `termNameEl.textContent = agentLabel || item.friendlyName` leads with the agent, falls back to handle. `termNameEl.dataset.friendlyName = item.friendlyName` stamps the key. The dblclick handler at line 400 reads `nameEl.dataset.friendlyName` — NOT `textContent`. `beginInlineRename(nameEl, current)` receives the real handle. `renameTerminal(currentName, next)` gets the correct key. The single most likely regression is averted. `updatePaneElement()` — inside `if (assignedName)` branch only. `fleetItem = fleetList.find(...)` with null-safe `fleetItem && fleetItem.role` passed to `agentLabelForRole`. Status suffixes (`(exited)`, `(no longer listed)`) attach to the handle, not the label. `nameSpan.className = 'pane-title-name'` — the shrinkable flex child. Terse layouts get agent-only; non-terse get `AGENT · handle`; no-label gets handle only. `titleEl.title` and `paneEl.setAttribute('aria-label', ...)` set for accessibility. CSS: `.pane-title-name` has `min-width: 0` (the critical flex-shrink enabler) plus ellipsis. `.item-role` — `text-transform: capitalize` is gone, truncation added. `displayTitle` variable completely removed — no orphaned references (grep confirmed zero hits). The `brandIconForCliLabel` addition from a concurrent feature wraps `roleEl` in a `roleRow` with an optional icon — additive, doesn't alter the plan's core logic. Kanban-mode panes return early via `renderKanbanPane` — no agent text injected. `updatePaneElement`'s load-bearing rule (move terminal DOM only on assignment change) is undisturbed — the title subtree is rebuilt every reconcile as before. I found nothing. This is becoming a pattern.

**Stage 2 (Balanced):** No CRITICAL, MAJOR, or NIT findings. The implementation matches the plan across all three surfaces (resolver, sidebar row, pane header) with correct fallbacks, correct rename re-pointing via `dataset.friendlyName`, correct terse-layout compaction, and correct CSS (shrinkable name span, removed `text-transform: capitalize`). Regression analysis: no orphaned `displayTitle` references, no broken rename path, no pane DOM movement, no kanban-mode interference, no blank primary line possible (all fallbacks resolve to handle). The `brandIconForCliLabel`/`roleRow` addition from a concurrent feature is additive and doesn't conflict. No code fixes needed.

**Validation:** `node --check src/webview/terminals.js` passed. Terminal contract tests (7 files including `terminal-pane-grid-reconcile-contract.test.js`) all passed. One pre-existing failure in `terminal-focus-affordance-contract.test.js` (unrelated — fails on clean HEAD, checks for `entry.inputDropNoticed = false` which doesn't exist in the codebase). No plan-defined automated checks to gate-wiring audit (manual UAT only). No SKIP TESTS/SKIP COMPILATION directive in dispatch — tests run independently per anti-leakage rule.

**Remaining risks:** None material. The `brandIconForCliLabel` function from a concurrent feature returns `'default'` for unknown CLI labels, which renders a default icon — if that icon URI is unset in `document.body.dataset`, `brandIconUri` returns `''` and the `img.src` is empty. This is a concurrent-feature concern, not this plan's.
