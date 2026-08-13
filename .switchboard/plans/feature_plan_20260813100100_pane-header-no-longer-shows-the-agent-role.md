# The Terminal Pane Header Shows the CLI Brand and the Handle, But No Longer Shows the Agent Role

## Goal

Restore the agent **role** (planner / coder / reviewer / lead / …) to the pane header in
the Terminals panel, so a pane can be identified by what the agent *is* without reading
the sidebar. Today the header shows the CLI brand and the terminal handle; the role is
only recoverable by inference from the handle, and disappears entirely the moment a
terminal is renamed.

### The problem

In `terminals.html`'s grid, each pane's header reads:

```
[brand icon] P1  Claude Code · planner-2
```

`Claude Code` is the **CLI brand** (`agentNames[role]`, e.g. the label configured in the
Agents tab). `planner-2` is the **handle** — a uniquifier minted by `ptyFleetService` as
`${role}-${n}`. The role itself is never rendered as a field. It survives only as a
substring of the auto-generated handle, and the panel ships a rename affordance
(`item-name` double-click → inline input) that overwrites exactly that substring. Rename
`planner-2` to `spec-pass` and the pane header becomes:

```
[brand icon] P1  Claude Code · spec-pass
```

with no way to tell a planner from a reviewer. In the terse layouts (`2x3`, `3x3`) it is
worse: the header renders the brand label **alone**, so nine panes in a planning fan-out
all read `Claude Code` and nothing else.

### Root cause

`updatePaneElement()` in `src/webview/terminals.js` builds the title from exactly two
inputs, and `role` is not one of them:

```js
const fleetItem = fleetList.find(t => t.friendlyName === assignedName);
const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);
...
let handle = assignedName;
if (fleetItem && fleetItem.status === 'exited') { handle += ' (exited)'; }
else if (!fleetItem && hasFetchedList) { handle += ' (no longer listed)'; }

const nameSpan = document.createElement('span');
nameSpan.className = 'pane-title-name';
if (!agentLabel) {
    nameSpan.textContent = handle;
} else if (isTerseLayout()) {
    nameSpan.textContent = agentLabel;
} else {
    nameSpan.textContent = `${agentLabel} · ${handle}`;
}
titleEl.appendChild(nameSpan);
titleEl.title = `${agentLabel ? agentLabel + ' — ' : ''}${handle}`;
```

`agentLabelForRole(role)` is a **brand** lookup, not a role formatter:

```js
function agentLabelForRole(role) {
    if (!role || role === NO_ROLE) { return ''; }
    const label = agentNames[role];
    if (!label || label === 'No agent assigned') { return ''; }
    return label;
}
```

`fleetItem.role` is read on the line above and then used only to resolve the brand. It is
never written into the header, never into `titleEl.title`, and never into the pane's
`aria-label`.

**This is a regression introduced by the header rewrite** (commit `1c7de0f6`, "Headless
Host Correctness — Boot, Catalog & Verb Rail"). `git show 1c7de0f6^` shows the previous
header body was:

```js
let displayTitle = assignedName;
if (…exited…) displayTitle += ' (exited)';
else if (…) displayTitle += ' (no longer listed)';
titleEl.appendChild(document.createTextNode(displayTitle));
```

— the bare handle, which for an un-renamed terminal *is* `role-N` and therefore carried the
role. The rewrite added the brand mark and the brand label but replaced the handle-only
title with `brand · handle`, and the role went from "implicit in the only field" to
"absent from every field". The same commit's diff shows the sidebar's own role line being
rewritten in the opposite direction — it kept an explicit role:

```js
roleEl.textContent = agentLabel
    ? `${item.friendlyName}${exitedSuffix} · ${item.role}`
    : item.role;
```

So the sidebar row and the pane header disagree today: the sidebar names the role, the
pane header does not.

### Background context

- `fleetItem.role` is always present on a live fleet entry — `ptyCreateTerminal` defaults
  it to `coder` when the caller sends none, and the "No role" picker button sends the
  sentinel `shell` (`NO_ROLE`), for which `agentLabelForRole` deliberately returns `''`.
- Custom agents have arbitrary role strings (`custom_agent_*` and user-defined roles), so
  the role must be rendered as raw text, not looked up in a fixed label map.
- The header is width-critical. `.pane-title` is a flex row whose **only** shrinkable
  child is `.pane-title-name`; `.pane-grid.layout-1x3/2x3/3x3 .pane-title` applies
  `overflow: hidden; text-overflow: ellipsis`. Any new field must either live inside the
  ellipsising span or be `flex-shrink: 0` and short.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## Complexity Audit

**Routine.** One function in one webview file plus one CSS rule. No state, no persistence,
no backend, no message plumbing. The role is already in hand at the exact site that needs
it — the change is what gets written into the DOM, not what gets fetched.

The one real design decision is *where* the role goes in a terse (`2x3` / `3x3`) header,
where the existing code drops the handle entirely to fit. Resolved below: terse layouts
show the **role**, not the brand, because the role is the discriminator in a fan-out where
every pane runs the same CLI.

## Edge-Case & Dependency Audit

1. **`role === 'shell'` (the "No role" picker button).** `agentLabelForRole` returns `''`
   and the header falls into the `!agentLabel` arm showing the handle alone. A `shell`
   pane must **not** grow a `shell` role chip — it is the deliberate no-agent case. Gate
   the role field on `role && role !== NO_ROLE`.

2. **Custom agent roles.** Arbitrary strings such as `custom_agent_1754...`. Render as-is;
   do not attempt a label lookup that would silently blank them. Long ids are absorbed by
   the ellipsis on `.pane-title-name`.

3. **Terse layouts.** `isTerseLayout()` currently shows the brand alone. Nine panes of
   `Claude Code` carry zero information; nine panes of `planner`, `reviewer`, `coder` carry
   the discriminator. Swap the terse content to the role. The brand is still on screen —
   the coloured `.pane-brand-icon` sits immediately to the left of the `P<n>` chip and is
   built from the same `agentLabel`.

4. **Exited / no-longer-listed suffixes.** These qualify the **handle** (`planner-2
   (exited)`), not the brand and not the role. Keep them attached to the handle exactly as
   today. In a terse layout that shows the role only, the suffix has no handle to attach
   to — append it to the role field there so an exited pane still reads as dead.

5. **`fleetItem` missing entirely** (terminal vanished between poll and render). `role` is
   unavailable; the header must fall back to the handle plus `(no longer listed)` with no
   role field, which the `role &&` guard gives for free.

6. **Header width in `2x3` / `3x3`.** `.pane-grid.layout-2x3 .pane-header` drops to
   `font-size: 10px` and the action buttons abbreviate. Adding a third text field to the
   *non*-terse arm (`1`, `2h`, `2v`, `2x2`, `1x3`) is safe — those headers already fit
   `brand · handle` with room. `1x3` ellipsises but has full pane height; that is the
   existing, accepted treatment.

7. **`aria-label` and `title`.** `paneEl.setAttribute('aria-label', ...)` and
   `titleEl.title` are both derived from the same string today. Both must gain the role, or
   a screen reader and a hover tooltip will disagree with the visible header.

8. **Do not touch the sidebar.** `renderTerminalRow` already renders the role correctly
   (`handle · role`). This plan changes the pane header only; making the two *agree* is the
   goal, not making them identical.

## Proposed Changes

### 1. `src/webview/terminals.js` — write the role into the pane header

Inside `updatePaneElement()`, in the `if (assignedName)` branch, replace the
`nameSpan` construction and the two derived strings.

```js
            // The ROLE is the discriminator the header lost. agentLabel is the CLI BRAND
            // (agentNames[role]) and `handle` is a uniquifier (`${role}-${n}`) that the
            // rename affordance overwrites — so neither one carries "what is this agent".
            // NO_ROLE ('shell') is the deliberate no-agent case and gets no chip.
            const role = (fleetItem && fleetItem.role) || '';
            const showRole = role && role !== NO_ROLE;

            let handle = assignedName;
            let statusSuffix = '';
            if (fleetItem && fleetItem.status === 'exited') {
                statusSuffix = ' (exited)';
            } else if (!fleetItem && hasFetchedList) {
                statusSuffix = ' (no longer listed)';
            }
            handle += statusSuffix;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'pane-title-name';
            if (isTerseLayout()) {
                // Nine panes in a fan-out all run the same CLI, so the brand alone
                // (the previous terse content) told the operator nothing. The role is
                // the field that differs. The brand is still on screen as the coloured
                // .pane-brand-icon immediately left of the P<n> chip.
                // The status suffix attaches HERE in terse mode — there is no handle
                // field for it to qualify.
                nameSpan.textContent = showRole
                    ? role + statusSuffix
                    : (agentLabel ? agentLabel + statusSuffix : handle);
            } else if (!agentLabel && !showRole) {
                nameSpan.textContent = handle;
            } else {
                const lead = [agentLabel, showRole ? role : ''].filter(Boolean).join(' · ');
                nameSpan.textContent = `${lead} · ${handle}`;
            }
            titleEl.appendChild(nameSpan);

            // Tooltip and accessible name carry the full identity in every layout, so a
            // terse header that shows only the role is never the sole source of truth.
            const identityParts = [agentLabel, showRole ? role : '', handle].filter(Boolean);
            titleEl.title = identityParts.join(' — ');
            paneEl.setAttribute('aria-label', `Pane ${index + 1}: ${titleEl.title}`);
```

Note the two behavioural deltas beyond adding the field:

- `statusSuffix` is now a separate variable so the terse arm can attach it. Previously the
  suffix lived only inside `handle`, and the terse arm did not render `handle`, so an
  exited pane in a `3x3` grid showed no exited marker at all.
- The `!agentLabel` arm becomes `!agentLabel && !showRole`, so a role with no configured
  CLI label (an agent whose Agents-tab command is blank) still shows its role rather than
  falling back to the bare handle.

### 2. `src/webview/terminals.html` — no new element, one width note

No new DOM node is introduced, so no new rule is required. Update the mandatory comment on
`.pane-title` so the next editor knows the span now carries three fields:

```css
        /* The name is the ONLY shrinkable child of the .pane-title flex row — the
           brand icon, the P<n> chip and the state chips are all flex-shrink: 0.
           This span carries "<brand> · <role> · <handle>" in roomy layouts and
           "<role>" alone in the terse ones (see updatePaneElement); it must keep
           min-width: 0 or the row overflows instead of ellipsising.
           (see the mandatory note on .pane-title above). */
        .pane-title-name {
```

## Verification Plan

1. **Roomy layout, un-renamed terminal.** Open a planner in layout `1`. Header reads
   `P1  Claude Code · planner · planner-1`. Hover: tooltip reads
   `Claude Code — planner — planner-1`.
2. **The regression case — renamed terminal.** Double-click the sidebar name, rename
   `planner-1` to `spec-pass`. Header reads `P1  Claude Code · planner · spec-pass`. This
   is the assertion that the role is a real field and not a substring of the handle.
3. **Terse layout fan-out.** Open nine terminals across `planner`, `coder` and `reviewer`
   and switch to `3x3`. Each header shows its own role, not nine identical brand labels.
   Confirm no header overflows its pane (the row ellipsises, it does not wrap or clip the
   action buttons).
4. **Exited terminal, terse layout.** Kill a terminal's process while it is seated in a
   `3x3` pane. Header reads `planner (exited)`. Before this change it read `Claude Code`
   with no exit marker.
5. **"No role" terminal.** Create one via the picker's "No role" button (`shell`). Header
   shows the handle alone in roomy layouts and no `shell` chip anywhere.
6. **Custom agent.** Configure a custom agent in the Agents tab, open a terminal for it.
   Header shows its raw role string; a long id ellipsises rather than pushing the buttons
   off the row.
7. **Agent with a blank CLI command.** Clear the Agents-tab command for `analyst`, open an
   analyst terminal. Header shows `analyst · analyst-1`, not the bare handle.
8. **Accessibility.** Read `paneEl.getAttribute('aria-label')` in devtools for a terse pane
   and confirm it carries brand, role and handle even though the visible text is the role
   alone.
9. **Sidebar unchanged.** Confirm `renderTerminalRow` output is byte-identical to before —
   this plan touches `updatePaneElement` only.
10. `node --check src/webview/terminals.js` clean.
