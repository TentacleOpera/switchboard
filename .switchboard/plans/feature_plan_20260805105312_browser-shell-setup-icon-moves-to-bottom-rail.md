# Browser Shell: Move the Setup Icon to the Bottom of the Rail, Next to the Theme Toggle

## Goal

Relocate the Setup icon in the browser shell's left rail from the middle of the panel list to the bottom cluster, adjacent to the theme toggle.

### Problem Analysis & Root Cause

The rail is built entirely from the `/panels` manifest, in manifest order (`src/webview/shell.js`, `renderManifest`):

```js
for (const panel of manifest) {
    if (panel.enabled === false) { continue; }
    const icon = buildIcon(panel);
    const frame = buildFrame(panel);
    icons.set(panel.id, icon);
    frames.set(panel.id, frame);
    strip.appendChild(icon);      // ← position === manifest index
    content.appendChild(frame);
}

const themeBtn = buildThemeToggle();
strip.appendChild(themeBtn);
renderTerminalSection([]);
```

The manifest (`src/services/headlessPanelHtml.ts`, `getPanelsManifest`) lists Setup seventh of eight:

```ts
{ id: 'board',     … }, { id: 'project',  … }, { id: 'memo',   … },
{ id: 'tickets',   … }, { id: 'planning', … }, { id: 'design', … },
{ id: 'setup',     label: 'Setup',     icon: `${iconDir}/nav-setup.svg`,     enabled: setupEnabled },
{ id: 'terminals', label: 'Terminals', icon: `${iconDir}/nav-terminals.svg`, enabled: terminalsEnabled },
```

So Setup renders inline with the workspace panels, while the *actual* bottom cluster is formed by two elements that are anchored there by CSS and DOM order:

- `#strip-terminals` carries `margin-top: auto` (`shell.html:153-165`), which absorbs the rail's free space and pins itself and everything after it to the bottom.
- The theme toggle is appended last, and `renderTerminalSection` inserts `#strip-terminals` *before* it, moving the `margin-top: auto` responsibility between the two depending on whether the Terminals panel exists (`renderTerminalSection`: sets `themeBtn.style.marginTop = 'auto'` when there is no terminals frame, clears it when the container is created).

There is no concept of rail *placement* in the manifest — only order — and no bottom group other than the implicit one created by that `margin-top: auto`. Setup is a settings surface, not a workspace surface: it belongs with the theme toggle, which is the other settings-shaped control.

**Root cause:** rail position is a pure function of manifest index, and the manifest is also the source for `getPanelHtmlById` routing and the default-panel choice. There is no way to express "render this icon in the bottom cluster" without either reordering the manifest (which changes other consumers' assumptions) or introducing a placement concept.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux
- **Project:** Browser Switchboard
- **Files touched:** `src/services/headlessPanelHtml.ts`, `src/webview/shell.js`, `src/webview/shell.html`, `src/test/shell-terminal-strip.test.js`
- **Risk:** Low-medium — the bottom-anchor mechanism is subtle (`margin-top: auto` moves between two elements at runtime) and a test pins it.

## User Review Required

None. "Down the bottom, near the theme switcher" specifies the target position.

## Complexity Audit

### Routine
- Give the manifest entry a `placement: 'bottom'` marker.
- Have `renderManifest` append bottom-placed icons after the top group.

### Complex / Risky
- **The bottom anchor is dynamic.** `#strip-terminals` owns `margin-top: auto` when the Terminals panel exists; the theme button owns it otherwise. Inserting a third element into that cluster must not break either case — a Setup icon appended after the anchor is fine, but one appended *before* it lands at the top of the free space instead of the bottom.
- **`shell-terminal-strip.test.js` asserts the anchor**: it checks `#strip-terminals { … margin-top: auto … }` in the CSS and inspects the `container.id = 'strip-terminals'` construction site. Any restructuring must keep those assertions true, or update them deliberately.
- **`defaultPanelId` returns the first *enabled manifest* entry** — Board today. Placement must not be implemented by *reordering* the manifest array (moving `setup` to the end would be harmless for the default, but moving anything before Board would silently change the landing panel). Use a marker, not a reorder.
- **`enabled: false` panels are omitted, not disabled** (documented in `renderManifest`). A bottom-placed panel that is disabled must simply not appear — the bottom group must not render an empty container or a stray separator.
- **Deep links and the icon/frame maps** are keyed by `panel.id` and are order-independent (`frames`, `icons`, `selectPanel`, `hashchange`), so placement cannot break `/#setup`.

## Edge-Case & Dependency Audit

1. **Terminals panel absent** (editor-hosted browser board, or `node-pty` unavailable → `terminals: false` fail-closed). `renderTerminalSection` removes `#strip-terminals` and gives the theme button `margin-top: auto`. The Setup icon must sit immediately above the theme button in that case, still at the bottom.
2. **Terminals panel present with zero terminals.** `#strip-terminals` exists but is empty; `#strip-terminals:empty` drops its border and padding (`shell.html:168-171`). The bottom order must read: Setup, then the (invisible) terminals container, then the theme toggle — or Setup, then terminals, then theme, whichever keeps Setup adjacent to the theme toggle in both the empty and populated cases. **Decision: place Setup immediately *above* `#strip-terminals`**, so the reading order is `… Setup | terminals fleet | Toggle Theme`. That keeps Setup in the bottom cluster and stops a growing fleet list from pushing Setup away from the bottom, which is exactly what would happen if Setup were above nothing.
3. **Fleet list grows past `max-height: 40vh`** (`shell.html:161`) and scrolls internally. Because Setup sits above the scroll container and the container has the `margin-top:auto` anchor, Setup stays pinned to the top edge of the bottom cluster and never drifts.
4. **`renderTerminalSection` runs repeatedly** (on every `terminalFleetState` push) and does `strip.insertBefore(container, themeBtn)` when creating the container. **Settled:** `insertBefore` with a node already in the DOM re-parents it — it moves, never duplicates — and the reference is always `themeBtn`, which sits after the Setup icon. So repeated fleet pushes keep the `… Setup | fleet | theme` order stable; the idempotency question resolves to "safe by DOM semantics". Verify once in UAT, no code guard needed.
5. **`#setup` deep link on load.** `selectPanel('setup')` works from any DOM position; verify.
6. **Setup disabled** (`setupEnabled === false`): no icon, no frame, bottom cluster is just terminals + theme. No empty wrapper.
7. **Rail overflow.** `#strip` is `overflow-y: auto` (`shell.html:66`). With a bottom-anchored group, a rail short enough to scroll must still let the user reach Setup — verify at a small viewport height.
8. **Editor host unaffected.** `shell.js` and `getPanelsManifest` serve the browser shell only; the VS Code sidebar has its own navigation. No editor-side change.

## Dependencies

None — no external session dependencies. The shell, manifest, and terminal-strip anchor mechanism are merged code; this plan adds a placement marker on top of them.

## Adversarial Synthesis

Key risks: the bottom anchor (`margin-top: auto`) migrates between `#strip-terminals` and the theme button at runtime, so a misplaced insert lands the icon at the top of the free space instead of the bottom cluster; and the anchor is pinned by `shell-terminal-strip.test.js`, so the change must cooperate with it rather than restructure it. Mitigations: a `placement: 'bottom'` marker instead of a manifest reorder (keeps `defaultPanelId` and routing untouched), a two-pass append that places bottom icons after the top group and before the anchor-bearing elements, and a settled idempotency argument (`insertBefore` re-parents, never duplicates) for repeated fleet pushes.

## Proposed Changes

### `src/services/headlessPanelHtml.ts`

Add an optional placement marker to the manifest entry type and mark Setup:

```ts
export interface PanelManifestEntry {
    id: string;
    label: string;
    icon: string;
    route: string;
    enabled: boolean;
    /**
     * Rail placement. Omitted = the main (top) panel group, in manifest order.
     * 'bottom' = the settings cluster at the foot of the rail, beside the theme
     * toggle. A marker rather than a manifest reorder on purpose: manifest ORDER
     * also determines defaultPanelId (first enabled entry), and getPanelHtmlById
     * routing reads ids, so reordering would couple rail layout to unrelated
     * behaviour.
     */
    placement?: 'bottom';
}
```

```ts
{ id: 'setup', label: 'Setup', icon: `${iconDir}/nav-setup.svg`, enabled: setupEnabled, placement: 'bottom' },
```

Leave the array order untouched so `defaultPanelId` still resolves to Board.

### `src/webview/shell.js`

Split `renderManifest`'s single append loop into two passes, and place the bottom group before the terminals section:

```js
function renderManifest(manifest) {
    if (!Array.isArray(manifest) || manifest.length === 0) { …unchanged error path… }

    const bottomPanels = [];
    for (const panel of manifest) {
        // A panel the host did not enable is OMITTED, not greyed out. (unchanged rationale)
        if (panel.enabled === false) { continue; }
        const icon = buildIcon(panel);
        const frame = buildFrame(panel);
        icons.set(panel.id, icon);
        frames.set(panel.id, frame);
        content.appendChild(frame);
        // Frames are position-independent (display-toggled, keyed by id); only the
        // ICON's rail position depends on placement.
        if (panel.placement === 'bottom') { bottomPanels.push(icon); } else { strip.appendChild(icon); }
    }

    // Bottom cluster, in reading order: settings icons, then the fleet list, then
    // the theme toggle. The fleet container carries `margin-top: auto`, so anything
    // appended BEFORE it and AFTER the top group lands at the top of the bottom
    // cluster — which is what keeps Setup adjacent to the theme toggle even as the
    // fleet list grows toward its 40vh cap.
    for (const icon of bottomPanels) { strip.appendChild(icon); }

    const themeBtn = buildThemeToggle();
    strip.appendChild(themeBtn);

    renderTerminalSection([]);
    …unchanged deep-link + initial selection…
}
```

`renderTerminalSection`'s `strip.insertBefore(container, themeBtn)` then naturally lands the fleet container between the Setup icon and the theme button. When there is no Terminals panel it moves `margin-top: auto` onto the theme button; because Setup is appended before the theme button, it sits directly above it. Both cases give the requested adjacency — verify both.

### `src/webview/shell.html`

Add a bottom-group marker class hook for spacing (a hairline separator above the settings cluster reads correctly in both the terminals-present and terminals-absent cases):

```css
/* Settings cluster at the foot of the rail. `margin-top: auto` lives on
   #strip-terminals (or, when Terminals is unavailable, on .theme-toggle-btn —
   see renderTerminalSection); this class only supplies the separator, so it must
   not add its own auto margin or it would fight the anchor. */
.strip-icon.strip-placement-bottom {
    border-top: 1px solid var(--border);
    padding-top: 0;
    margin-top: 6px;
}
```

and set the class in `buildIcon` when `panel.placement === 'bottom'`.

### `src/test/shell-terminal-strip.test.js`

Extend with a placement assertion so a future refactor cannot silently return Setup to the top group, and re-confirm the anchor assertions still hold:

```js
check('the Setup icon is placed in the bottom rail cluster', () => {
    const manifestSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');
    assert.ok(/id:\s*'setup'[^}]*placement:\s*'bottom'/.test(manifestSrc),
        "the setup manifest entry must carry placement: 'bottom'");
    const shellSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'shell.js'), 'utf8');
    // Ordering is the whole point: bottom icons must be appended after the top
    // group and BEFORE the theme toggle, so the fleet container's margin-top:auto
    // still anchors the cluster.
    assert.ok(shellSrc.indexOf('bottomPanels.push(icon)') !== -1, 'placement must be honoured in renderManifest');
    assert.ok(shellSrc.indexOf('for (const icon of bottomPanels)') < shellSrc.indexOf('const themeBtn = buildThemeToggle()'),
        'bottom icons must be appended before the theme toggle');
});
```

## Verification Plan

1. **Build & tests:** *Deferred per dispatch directive — no project compilation step and no automated test runs in this verification plan.* The placement assertions added to `shell-terminal-strip.test.js` under Proposed Changes are validated by the coder's normal gates and CI, not by this plan's verification.
2. **UAT — position with Terminals available.** Open the browser shell in standalone: the rail reads top-to-bottom `Board, Project, Memo, Tickets, Artifacts, Design`, then a separator, then `Setup`, then the fleet terminal dots, then `Toggle Theme` pinned at the very bottom.
3. **UAT — position without Terminals.** Open the extension-served browser board (Terminals unavailable): the rail ends with `Setup` directly above `Toggle Theme`, both at the bottom, no empty fleet container or stray separator.
4. **UAT — fleet growth.** Spawn several terminals so the fleet list fills and starts scrolling at its 40vh cap: Setup stays in the bottom cluster and does not get pushed up out of it; the theme toggle stays at the very bottom.
5. **UAT — Setup still works.** Click the Setup icon: the Setup panel activates, the icon highlights, and the URL hash becomes `#setup`.
6. **UAT — deep link.** Load `/#setup` directly: the Setup panel is active on first paint.
7. **UAT — default panel unchanged.** Load `/` with no hash: Board is selected (confirms the manifest was not reordered).
8. **UAT — Setup disabled.** With `setup: false` availability, the icon is absent, the bottom cluster shows only terminals + theme, and no separator hangs in space.
9. **UAT — short viewport.** Shrink the window height until the rail scrolls: Setup and the theme toggle remain reachable by scrolling the rail.
10. **UAT — theme toggle.** Click `Toggle Theme` after the move: the theme still switches across every panel iframe and any pop-out windows.
