# Show The CLI Brand Icon In Each Terminal Pane Header

## Goal

Put the agent's coloured CLI brand mark at the left of every terminal pane's header, so the operator can identify which CLI is in which pane at a glance — the same identification the sidebar rows and the shell rail already offer.

### Problem analysis

In the terminals grid, telling one pane's agent from another's is a **reading** task, not a **glancing** task. The pane header carries `P<n> · CLAUDE CLI · claude-2`, and at 2x3 / 3x3 density it collapses to the agent label alone with the handle ellipsised away. Every other surface that lists terminals already shows the brand mark:

- **Sidebar rows** — `renderTerminalRow` builds an `<img class="item-role-icon">` from `brandIconForCliLabel` / `brandIconUri` (`src/webview/terminals.js`, function opens at ~1855).
- **Shell rail fleet buttons** — `renderTerminalSection` renders `<img class="strip-term-icon">` from a `t.iconUri` that the panel resolves with the *same* two helpers and relays out (`src/webview/shell.js:542-562`).
- **Startup curtain** — `renderStartupCurtain` builds `<img class="startup-curtain-icon">` from the same pair (`terminals.js:1639-1662`).

The pane header is the only terminal-identifying surface with no brand mark. That is an omission, not a decision: the header was rebuilt to add the agent label (`terminals.js:3884-3888` — "The agent name was absent from the pane header entirely"), and the icon was simply never carried across in that pass.

### Root cause

`updatePaneElement`'s assigned branch (`terminals.js:3873-3942`) composes `.pane-title` from four spans — `.pane-index-chip` (3875-3879), `.pane-title-name` (3896-3905), optional `.pane-badge` (3910-3915), optional `.pane-badge.is-gap` (3916-3922) — and then the input-state chip (3928-3930). It resolves `agentLabel` at line 3882 via `agentLabelForRole(fleetItem && fleetItem.role)`, which is exactly the input `brandIconForCliLabel` takes. The icon is one derivation away and simply is not made.

All the machinery already exists and needs no extension:
- `CLI_BRAND_ICON_KEYS` (`terminals.js:1764`) and `brandIconForCliLabel(cliLabel)` (`terminals.js:1786-1810`)
- `brandIconUri(key)` reading `document.body.dataset.brandIcon*` (`terminals.js:1813-1839`), stamped by `headlessPanelHtml.ts` on the `<body>` tag
- A 14px sibling style, `.item-role-icon` — `terminals.html:406-415`

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux
- **Project:** Browser Switchboard
- **Feature:** b34dfbb3-d1f1-406e-ad95-459e38ceef81

## User Review Required

None. The icon is additive chrome using an existing resolver, an existing asset set and an existing CSP allowance. No new setting, no new control, no behaviour change.

## Complexity Audit

### Routine

- Adding a `.pane-brand-icon` rule to `terminals.html`, modelled on `.item-role-icon`.
- Resolving the icon in `updatePaneElement`'s assigned branch and prepending it to `.pane-title`.

### Complex / Risky

- **A variable-hoist edit inside a live block.** The icon needs `agentLabel`, which is currently declared at `terminals.js:3881-3882`, *after* the `.pane-index-chip` append. Prepending the icon means hoisting `fleetItem`/`agentLabel` to the top of the `if (assignedName)` block and **deleting** the original declarations. Leave both and it is a `const` redeclaration in the same block scope — the whole panel fails to parse and every pane goes blank. This is the single highest-consequence line in the change.
- **Panes are reused, not rebuilt.** `updatePaneElement`'s load-bearing invariant (`terminals.js:3815-3820`) is that it must not touch `entry.container`'s parent unless the *assignment* changed. Appending into `.pane-title` is safe because the branch already does `titleEl.textContent = ''` at line 3873 and rebuilds every child from scratch — the icon must be created **after** that clear and **before** the index chip, or it is wiped on the next poll tick.
- **Header width at density.** `.pane-title` is a flex row that ellipsises in `1x3`/`2x3`/`3x3` (`terminals.html:750-757`), and `.pane-title-name` is its only shrinkable child (`terminals.html:993-1001`). A 14px icon at those densities costs real characters of the terminal name; shrink the icon to 12px there rather than dropping it, since the icon is the *point* of the change at density.
- **Two sibling subtasks edit this same file and this same flex row.** See Dependencies & Conflicts — this is a sequencing constraint, not a design one, but a merge-order mistake silently drops one of the two headers' contributions.

## Edge-Case & Dependency Audit

### Race Conditions

1. **The 5s poll re-renders the header continuously.** `updatePaneElement` runs on every tick and clears `titleEl` outright. The icon must be rebuilt from `fleetList` each time — never cached on the element and never conditionally skipped — or a role change (rename, re-seat) leaves a stale brand mark on a pane that now runs a different CLI.
2. **`fleetList` may not have landed yet.** On first paint `fleetItem` is `undefined`, so `agentLabel` is falsy and `brandIconForCliLabel` returns `null`. The `|| 'default'` fallback then renders the default mark, which flips to the real one on the first poll. That is the same first-paint behaviour the startup curtain already has and is acceptable; do not add a "wait for fleetList" gate, which would leave the header iconless for up to 5s.

### Security

3. **CSP.** `terminals.html`'s panel CSP is `img-src 'self' data:` (declared in the meta tag at `terminals.html:5`). The brand URIs are same-origin `/static/...` paths stamped onto `<body>` by `headlessPanelHtml.ts:410`, so they already satisfy it — the sidebar and curtain render them today from the same dataset. **No CSP change, and none must be added.**
4. **No untrusted string reaches the DOM as markup.** The icon is built with `document.createElement` and `.src` assignment from the body dataset, never `innerHTML`. Keep it that way.

### Side Effects

5. **No brand match.** `brandIconForCliLabel` returns `'default'` for an unrecognised label and `null` for a falsy label or the literal `'No agent assigned'` (`terminals.js:1787`). Follow the curtain's pattern (`terminals.js:1649-1651`): `brandIconForCliLabel(agentLabel) || 'default'`, then `brandIconUri(iconKey) || brandIconUri('default')`, then render only if the URI is non-empty.
6. **Missing dataset attributes.** `brandIconUri` reads `document.body.dataset.brandIcon*` and returns `''` for an unknown key. If the host did not stamp them, every lookup returns `''` — the guard above must therefore skip the `<img>` entirely rather than emit a broken image.
7. **Solo pop-out.** A solo window renders the same pane with `document.body.classList.contains('is-solo')`. The icon should render there too — it is the one surface where the header is the *only* identifier (no sidebar).
8. **Empty / unassigned panes.** The assigned branch is guarded by `if (assignedName)` at line 3874; the `else` placeholder branch (3943-3951) must be left alone so an empty slot shows no icon.
9. **Kanban-mode panes.** `updatePaneElement` returns early into `renderKanbanPane` at `terminals.js:3847-3850`, before the assigned branch runs, so a kanban pane is naturally excluded. The transition *out of* terminal mode is also safe, and the mechanism is worth stating precisely: `renderKanbanPane` rebuilds `.pane-title` under a picker-signature gate (`terminals.js:4368`), and on a pane arriving from terminal mode `titleEl.querySelector('.kanban-pane-column-picker')` is `null`, so the `!picker` arm fires and `titleEl.textContent = ''` (4369) wipes the brand icon along with everything else. **Do not add an icon to `renderKanbanPane`'s own header** — a brand mark on a board-column pane is a lie.
10. **Exited terminals.** The handle gains an ` (exited)` suffix (`terminals.js:3890-3891`); the icon should dim rather than disappear, matching how the sidebar keeps its icon on `.is-exited` rows.

    > **Superseded:** Style the dimming with `.terminal-pane.is-exited .pane-brand-icon { opacity: 0.45; }` (and a companion `.pane-title-name + .pane-brand-icon` selector).
    > **Reason:** Both selectors are **dead CSS**. (a) `is-exited` is applied only to `.terminal-item` — the *sidebar row* — at `terminals.js:1864`; `.terminal-pane` never receives it, and nothing in `updatePaneElement` sets it. The rule could never match. (b) `.pane-title-name + .pane-brand-icon` is a next-sibling selector, but this plan inserts the icon **before** `.pane-title-name`, so it also could never match. The two dead selectors were comma-joined, which is how the mistake survived review: the rule looked like it had two ways to match when it had none.
    > **Replaced with:** Stamp the state on the image itself, where `fleetItem.status === 'exited'` is already computed two lines away (`terminals.js:3890`): set `brandImg.classList.add('is-exited')` and style `.pane-brand-icon.is-exited { opacity: 0.45; }`. One selector, one condition, provably reachable.

### Dependencies & Conflicts

11. **Do NOT reuse `.item-role-icon`.** Use a distinct `.pane-brand-icon`.

    > **Superseded:** *"`dismissStartupCurtain` strips `.is-starting` off elements matching `.item-role-icon[data-terminal="…"]` (`terminals.js:1620-1621`). Reusing the class in the pane header would make the curtain teardown reach into pane headers."*
    > **Reason:** Factually wrong, and it was the *primary* justification. That sweep is scoped to the sidebar: `listEl.querySelectorAll('.item-role-icon[data-terminal="…"]')` (`terminals.js:1623-1625`), where `listEl` is the sidebar list, not `paneGridEl`. It could not reach a pane header even if the class matched. Keeping a false reason in the plan invites the next reader to "correct" it by reusing the class.
    > **Replaced with:** Use a distinct `.pane-brand-icon` for two real reasons: (a) `.item-role-icon` declares `margin-right: 4px` (`terminals.html:411`), which stacks with `.pane-title`'s `gap: 6px` (`terminals.html:991`) to give a 10px lead gap the header was not designed for; (b) the class is sidebar-semantic — it is the row's role icon, and giving a second surface the same class means any future sidebar-scoped rule or sweep silently acquires a pane-header meaning. As a belt-and-braces measure, do **not** stamp `data-terminal` on the pane icon: that attribute is the curtain teardown's addressing key, and leaving it off keeps the two surfaces addressable apart no matter how the sweep's scope changes later.

12. **Shares `updatePaneElement`'s assigned branch and `terminals.html` with sibling subtasks.** *Snappier PTY Prompt Delivery With A Dispatch Progress Chip In The Pane Header* edits the **same** `if (assignedName)` block (inserting a `syncDispatchChip` call next to `syncInputStateChip` at 3930), modifies `syncInputStateChip` itself, and adds a `.pane-dispatch-state` rule near `.pane-input-state` (`terminals.html:822`). *Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List* edits `terminals.html:721-722` and `1037-1046`. Per the project PRD's orchestration discipline (*"One agent stream per provider file … the same file serialises"*), these must not be applied concurrently. **Order: kanban-scroll → this subtask → dispatch chip.** Whoever lands second must re-derive line numbers rather than trusting the ones written here; this plan's hoist of `fleetItem`/`agentLabel` moves every line below it in the branch.
13. **The webview loads from `dist/`, not `src/`.** Verify against a rebuilt VSIX or the live standalone server — a `src`-only edit will appear to change nothing.
14. **No confirmation dialogs**, no new controls — this is additive header chrome.

## Dependencies

- **Sibling subtask (ordering, same file):** *Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List* — lands before this one.
- **Sibling subtask (ordering, same function):** *Snappier PTY Prompt Delivery With A Dispatch Progress Chip In The Pane Header* — lands after this one; it inserts into the same `if (assignedName)` block.
- No external session dependencies.

## Adversarial Synthesis

**Risk summary.** The one change that can break the panel outright is the `fleetItem`/`agentLabel` hoist: leaving the original `const` declarations in place is a same-scope redeclaration that stops the whole script parsing, blanking every pane rather than degrading one. The second risk is silent rather than loud — two of the originally-proposed CSS selectors were unreachable, so the "exited seat dims its icon" behaviour would have shipped as dead code that verification step 7 could never have passed. Mitigations: treat the hoist as the review focus and confirm exactly one declaration of each name survives; stamp the exited state as a class on the `<img>` where the condition is already in scope; and serialise this subtask against the two siblings that edit the same file.

## Proposed Changes

### 1. `src/webview/terminals.html` — a pane-header icon style

Add beside `.pane-index-chip` (~907) / `.pane-title` (~983):

```css
        /* Brand mark in the pane header. Deliberately NOT .item-role-icon: that
           class declares margin-right:4px (411), which stacks with .pane-title's
           gap:6px (991) into a 10px lead gap, and it is sidebar-semantic — the
           curtain teardown addresses `.item-role-icon[data-terminal=…]` (scoped to
           listEl today, but the class should not acquire a second meaning). This
           element carries NO data-terminal for the same reason.
           An <img>, not a CSS mask, for the same reason the sidebar uses one:
           these are multi-hue brand marks whose baked-in fill IS the identity. */
        .pane-brand-icon {
            width: 14px;
            height: 14px;
            flex-shrink: 0;
            align-self: center;
            object-fit: contain;
            opacity: 0.9;
            pointer-events: none;
        }
        /* Class on the IMAGE, not on .terminal-pane: `is-exited` is a
           .terminal-item (sidebar row) class only — terminals.js:1864 — and the
           pane element never receives it, so a `.terminal-pane.is-exited …`
           selector would be dead. updatePaneElement stamps this directly, where
           fleetItem.status is already in scope. */
        .pane-brand-icon.is-exited { opacity: 0.45; }
        /* Dense grids: the title ellipsises first by flex design, so shrink the
           icon rather than drop it — at these densities the icon is the primary
           identifier. Scoped to the three ELLIPSISING layouts (750-752), not to
           isTerseLayout()'s 2x3/3x3 pair: isTerseLayout gates on header HEIGHT
           (which is what collapses the input-state chip to a dot), while this is a
           column-WIDTH concern, and 1x3's columns are as narrow as 2x3's — see the
           comment at 747-749. */
        .pane-grid.layout-1x3 .pane-brand-icon,
        .pane-grid.layout-2x3 .pane-brand-icon,
        .pane-grid.layout-3x3 .pane-brand-icon {
            width: 12px;
            height: 12px;
        }
```

### 2. `src/webview/terminals.js` — resolve and prepend the icon in the assigned branch

In `updatePaneElement`, inside `if (assignedName) { … }`, immediately after `titleEl.textContent = ''` and **before** the `.pane-index-chip` append (currently `terminals.js:3873-3879`):

```js
        titleEl.textContent = '';
        if (assignedName) {
            const fleetItem = fleetList.find(t => t.friendlyName === assignedName);
            const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);

            // Brand mark first — the same identifier the sidebar rows
            // (renderTerminalRow), the shell rail (postFleetStateToShell) and the
            // startup curtain (renderStartupCurtain) already show, resolved through
            // the same two helpers so all four surfaces cannot disagree.
            // `|| 'default'` on BOTH calls mirrors renderStartupCurtain (1649-1651):
            // an unrecognised label still gets a mark, and a host that never stamped
            // the dataset attributes gets no <img> at all rather than a broken one.
            const brandKey = brandIconForCliLabel(agentLabel) || 'default';
            const brandUri = brandIconUri(brandKey) || brandIconUri('default');
            if (brandUri) {
                const brandImg = document.createElement('img');
                brandImg.className = 'pane-brand-icon';
                brandImg.src = brandUri;
                // alt='' + aria-hidden: the pane's aria-label below already carries
                // the agent label and handle. A brand name here double-announces.
                brandImg.alt = '';
                brandImg.setAttribute('aria-hidden', 'true');
                brandImg.dataset.brand = brandKey;
                // Dimmed, not dropped — same treatment the sidebar gives an exited
                // row. Stamped here rather than via a `.terminal-pane.is-exited`
                // rule: the pane element never carries that class (it is a
                // .terminal-item class, set at terminals.js:1864).
                if (fleetItem && fleetItem.status === 'exited') {
                    brandImg.classList.add('is-exited');
                }
                // NO data-terminal stamp — see the CSS comment.
                titleEl.appendChild(brandImg);
            }

            const idxEl = document.createElement('span');
            const isPinned = Boolean(pinnedPanes[index]);
            idxEl.className = 'pane-index-chip' + (isPinned ? ' is-pinned' : '');
            idxEl.textContent = isPinned ? `📌P${index + 1}` : `P${index + 1}`;
            titleEl.appendChild(idxEl);

            // (the two `const` declarations that used to live here are now hoisted
            //  above — see the note below)
```

**Mandatory follow-up edit, not optional cleanup:** the existing declarations

```js
            const fleetItem = fleetList.find(t => t.friendlyName === assignedName);
            const agentLabel = agentLabelForRole(fleetItem && fleetItem.role);
```

at `terminals.js:3881-3882` must be **deleted**. They are hoisted above by this edit, and leaving both is a `const` redeclaration in the same block scope: the panel script fails to parse and *every* pane renders blank, not just this one. Confirm exactly one declaration of each name survives in the branch before considering the change done.

Everything below (the `handle` composition at 3889-3894, `nameSpan` at 3896-3905, `titleEl.title`/`aria-label` at 3907-3908, the two badges at 3910-3922 and the input-state chip at 3928-3930) is unchanged and continues to consume the hoisted `fleetItem`/`agentLabel`.

## Verification Plan

1. **Icon renders per pane.** Open the Terminals panel with at least three seats running different CLIs (e.g. claude, gemini, codex). Confirm each pane header leads with that CLI's coloured mark, and that the mark matches the same terminal's sidebar row icon and its shell-rail button icon.
2. **Panel still parses — check this first.** Open devtools and confirm there is no `SyntaxError: Identifier 'fleetItem' has already been declared` in the console and that panes render at all. This is the redeclaration guard; if it fires, nothing else in this list is testable.
3. **Unknown agent falls back.** Create a seat whose role maps to a label outside `brandIconForCliLabel`'s prefix list. Confirm the default mark renders — not a broken-image glyph.
4. **Missing dataset.** In devtools, delete `document.body.dataset.brandIconDefault` and the other brand attrs, then force a re-render (resize or wait for the 5s poll). Confirm the header renders with no `<img>` and no broken image.
5. **Density.** Switch to `1x3`, `2x3` then `3x3`. Confirm the icon shrinks to 12px in all three, remains visible, and the terminal name still ellipsises rather than the icon being pushed out.
6. **Pane reuse invariant.** With a terminal actively producing output, let several 5s poll ticks pass. Confirm the icon persists, the xterm does not flicker or scroll-jump, and no terminal DOM is reparented (watch for a scroll-position reset — that is the invariant's failure signature).
7. **Role change repaints the mark.** Re-seat a pane from a claude seat to a gemini seat. Confirm the mark changes on the next render and no stale brand survives.
8. **Empty and kanban panes.** Unassign a pane, then switch it to kanban mode. Confirm neither the empty placeholder nor the kanban column header shows a brand mark, and that switching back to terminal mode restores it.
9. **Exited seat.** Kill a PTY. Confirm the header shows `… (exited)` with the brand mark visibly dimmed (inspect the element: it must carry `class="pane-brand-icon is-exited"`), not removed.
10. **Solo pop-out.** Pop a terminal out to its own window. Confirm the solo pane header carries the mark.
11. **Accessibility.** With a screen reader (or by reading `paneEl.getAttribute('aria-label')`), confirm the pane announces `Pane N: <LABEL> — <handle>` exactly once, with no extra brand-name announcement from the image.
12. **Startup curtain interaction.** Create a new seat so the startup curtain shows, then dismiss it. Confirm `dismissStartupCurtain` clears the sidebar icon's `.is-starting` class and does **not** touch the pane header icon.
13. **Both themes.** Toggle afterburner / claudify; confirm the marks keep their brand colours in both (they are `<img>`, so they must be unaffected by theme).

### Automated Tests

- **Extend an existing `terminals.html`-reading contract test** (e.g. `src/test/terminal-focus-affordance-contract.test.js` or `terminal-pane-pinning-contract.test.js`, both of which already `readFileSync` the panel HTML) with two assertions:
  - `terminals.html` declares a `.pane-brand-icon` rule.
  - `terminals.html` contains **no** `.terminal-pane.is-exited` selector — a direct guard against the dead-selector class of mistake this plan corrected, since `is-exited` is a `.terminal-item` class only.
- **Add a `terminals.js` source assertion** in the same style: the `updatePaneElement` region contains exactly **one** `const fleetItem =` occurrence. A count assertion is the only cheap mechanical guard against the redeclaration failure, and it is a genuine property of the file's text rather than a proxy for behaviour.
- **Regression suites to run before merge** (not run during planning): the `terminals.html`/`terminals.js`-reading contract tests under `src/test/` — `terminal-focus-affordance-contract.test.js`, `terminal-pane-pinning-contract.test.js`, `terminal-solo-popout-contract.test.js`, `terminal-scroll-affordance-contract.test.js`. This change adds header chrome those tests do not assert on; a failure means the edit landed outside the intended branch.

## Recommendation

**Complexity 3 → Send to Intern.** Two small, well-located edits reusing four existing helpers with no new mechanism. The single non-mechanical step is the `fleetItem`/`agentLabel` hoist-and-delete, which is spelled out above and covered by both a manual check (step 2) and a source-count assertion.

---

## Completion report (2026-08-13)

Implemented in `src/webview/terminals.html` (a `.pane-brand-icon` rule at 14px, an `.is-exited` variant at 0.45 opacity, and a 12px override scoped to `layout-1x3`/`2x3`/`3x3`) and `src/webview/terminals.js` (icon resolved via `brandIconForCliLabel`/`brandIconUri` with `|| 'default'` on both calls and prepended to `.pane-title` after the `titleEl.textContent = ''` clear, before the index chip). The hoist-and-delete landed correctly and was verified rather than asserted: exactly one `const fleetItem` and one `const agentLabel` survive in the assigned branch, and `node --check` parses the file, so the redeclaration failure this plan flagged as its highest-consequence line is closed. `renderKanbanPane` carries no brand icon, no `data-terminal` is stamped on the image, and the exited state is a class on the `<img>` rather than a dead `.terminal-pane.is-exited` rule. One review cycle removed a plan-authoring scaffolding comment (`"the two const declarations that used to live here are now hoisted above — see the note below"`) that had been copied into shipped source, where it pointed a reader at a note existing only in this plan file. The `### Automated Tests` proposals were deliberately not implemented under this dispatch's SKIP TESTS directive — note for whoever picks them up that the proposed "`terminals.html` contains no `.terminal-pane.is-exited` selector" assertion will false-positive on this plan's own prescribed CSS comment, which names that selector while explaining why never to write it, so it must strip comments first.
