# Group paging controls are a red full-width banner that shoves the grid down — move them into the layout toolbar

## Goal

When the operator picks a grid size that holds fewer panes than the locked group has members, the Terminals panel renders the paging controls as a red, full-width, error-styled banner **below** the grid-size buttons, displacing the entire pane grid downward. Paging is a control, not an error. It must sit beside the grid-size buttons, in the panel's own theme colours, and must not change the page's vertical layout when it appears.

### Problem analysis

`#layout-fallback-banner` (`src/webview/terminals.html:1994`) is a single element serving two unrelated purposes, decided in `applyLayoutFloor()` (`src/webview/terminals.js:5622-5663`):

```js
const shortfall = activeGroup && members > rendered;
const floored = effectiveLayout !== currentLayout;
fallbackBannerEl.classList.toggle('visible', floored || !!shortfall);
...
if (activeGroup && shortfall) {
    label.textContent = `Showing ${start + 1}–${Math.min(start + rendered, members)} of ${members} — ${activeGroup.name} `;
    fallbackBannerEl.appendChild(mkPage('‹ prev', -1, activeGroupPage <= 0));
    fallbackBannerEl.appendChild(mkPage('next ›', 1, activeGroupPage >= pageCount - 1));
} else if (floored) {
    fallbackBannerEl.textContent = 'Window too small for requested layout — using simpler layout floor.';
}
```

Its CSS (`src/webview/terminals.html:1706-1726`) is hardcoded error red — no theme token in sight:

```css
.layout-fallback-banner {
    background: rgba(248, 81, 73, 0.15);
    color: #f85149;
    border-bottom: 1px solid #f85149;
    padding: 4px 12px;
    font-size: 11px;
    display: none;
}
.layout-fallback-banner.visible { display: block; }
```

And it is a block-level child of `.terminals-main`'s column flex, sitting between `.layout-toolbar` and `#group-tab-strip`. `display: none → block` therefore inserts a new row into the column and pushes the tab strip and the whole pane grid down by its height, every time the operator drops to a smaller grid.

### Root cause

Two failures compounded:

1. **A control was implemented inside an error surface.** The shortfall pager was bolted onto the pre-existing "window too small" warning element because that element was already positioned near the layout picker. It inherited the warning's red literals — `#f85149` written directly, not a theme token — so it renders identically red under both `cyber-theme-enabled` and `theme-claudify`, where the panel's accent is `#D97757`.
2. **It was placed in flow, not in the toolbar.** `.layout-toolbar` (`src/webview/terminals.html:518-527`) is already a `justify-content: space-between` flex row with `.layout-picker` on the left and `.toolbar-actions` on the right, with unused horizontal space in the middle — exactly where a pager belongs. Nothing was ever put there, so the pager went below and became a layout-shifting bar.

### Decisions

- **The pager moves into `.layout-toolbar`, immediately right of `.layout-picker`.** `.layout-picker` and the new `#group-pager` are wrapped in a `.layout-toolbar-left` flex box so `space-between` still pins `.toolbar-actions` to the right edge.
- **The pager wears the panel's neutral chrome:** `--text-secondary`, `--border-bright`, `--accent-teal` on hover — the same family `.btn-layout` already uses (`src/webview/terminals.html:531-549`). `--accent-teal` is declared on `:root` as `var(--accent-primary)` (`src/webview/terminals.html:32`) and redeclared as `#D97757` under `.theme-claudify` (`src/webview/terminals.html:64`), so this is genuinely theme-aware. Do **not** use `--accent-violet`: it is never declared in `:root` in this file (every one of its ~14 uses carries a `#c586c0` fallback) and would stay violet in Claudify.
- **The pager reserves its space.** It is `visibility: hidden` when there is no shortfall, not `display: none`, so appearing and disappearing never reflows the toolbar or moves the grid.
- **The banner survives, for the window-too-small case only,** and stops being a hardcoded red literal — it becomes `var(--state-connecting)` (`#d7a03a`, `src/webview/terminals.html:48`), the amber the panel already owns for non-fatal state. That case *is* a warning about a degraded layout, and it is genuinely transient (it clears on resize).

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Feature context — this is subtask 4 of 5

Feature: **Terminals Panel Sidebar & Group Selection UX**. This is the only subtask that does not touch `renderSidebarList()` — its whole surface is `applyLayoutFloor()` plus toolbar markup and CSS. It shares **no edited line** with the three sidebar plans, so it can land at any point in the sequence.

**Reconciled contract with the "ungrouped terminals get their own grid" sibling:**

- That plan introduces an `Unassigned` pseudo-group that `getAllGroups()` returns and `getGroupMembers()` computes. The pager reads both through the existing generic lookups (`getAllGroups().find(...)`, `getGroupMembers(activeGroup).length`), so an over-subscribed `Unassigned` grid pages correctly with **no change to this plan**. The label will read `Unassigned 1–4 of 6`, which is correct.
- That plan also adds a `clearGroupLock()` fallback inside `seatActiveGroupPage()`. `applyLayoutFloor()`'s `changed` branch calls `seatActiveGroupPage()`, and `clearGroupLock()` calls `applyLayoutFloor()` at its own tail (`src/webview/terminals.js:2366`) — so a dissolving lock re-enters this function once. It terminates: `clearGroupLock` nulls `activeGroupId` **before** calling back, so the inner pass takes `activeGroup === null` → `shortfall === false` → pager hidden, and its own `if (activeGroupId) { seatActiveGroupPage(); }` guard is false. **No guard is needed in this plan**, but the pager's hidden-state branch must be genuinely idempotent (it is — it only clears text and disables buttons). Recorded here so a reviewer seeing the re-entrancy does not read it as a defect in either plan.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- New markup in `.layout-toolbar`, new CSS block, retheming an existing CSS block.
- Rewriting the shortfall branch of `applyLayoutFloor()` to target a different element.

**Complex / Risky**

- **`applyLayoutFloor()` can re-enter.** When `changed` is true it calls `renderPaneGrid()` and returns *before* reaching the tail (`src/webview/terminals.js:5664-5671`). The pager update must happen in the block that runs on **both** paths (it already does — the banner block is above the `if (changed)` early return). Keep it there.
- **The page buttons mutate `activeGroupPage` and then call `applyLayoutFloor({ fit: false })`** — i.e. the handler re-enters the function that built the button. The existing code rebuilds the button DOM from inside its own click handler, which works but is fragile. Moving the buttons to static markup removes the problem entirely: attach the listeners **once at init**, and let the re-entrant call only update labels and disabled flags. Do not rebuild the pager's nodes per render.
- **`body.is-solo` hides `.layout-toolbar` and `.layout-fallback-banner`** (`src/webview/terminals.html:1903-1906`). The pager inherits the toolbar's hide for free; do not add a separate solo rule.
- **`activeGroupPage` is transient by design** (`src/webview/terminals.js:93`) and is reset to 0 by `switchToGroup` on every lock move. The pager must never persist it.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| No group locked | Pager hidden (space reserved). Banner shows only if the layout floored. |
| Group locked, members ≤ rendered slots | Pager hidden. No banner. |
| Group locked, members > rendered slots | Pager visible with `<group> 1–4 of 9 · ‹ ›`; **no** banner unless the layout also floored. |
| Group locked **and** window too small (both conditions) | Pager shows the paging state; banner shows the window-too-small warning. Today these are mutually exclusive because one element served both — splitting them fixes the case where the operator was told nothing about the floor because paging won the branch. |
| Single page (`pageCount === 1`) | Not reachable — shortfall is false when members ≤ rendered. Guard anyway: hide the pager when `pageCount <= 1`. |
| First / last page | `‹` disabled at page 0, `›` disabled at `pageCount - 1`, via a `.group-pager-btn:disabled` opacity treatment. |
| Layout floors while paged past the new end | `seatActiveGroupPage()` re-clamps `activeGroupPage` (`src/webview/terminals.js:2446-2447`); the pager must read the clamped value, so build it *after* the clamp — i.e. keep it where the banner block already sits, below `const rendered = getSlotCount(effectiveLayout)`. |
| Window resized narrow | `.layout-toolbar` has `gap: 8px` and no wrap. The pager must be `flex-shrink: 0` on its buttons and allow its label to ellipsise. |
| Claudify theme | Pager renders in `#D97757`-derived accent on hover; nothing red anywhere. |
| Locked group dissolves mid-flight (`Unassigned` sibling) | `seatActiveGroupPage()` → `clearGroupLock()` → `applyLayoutFloor()` re-entry; inner pass hides the pager, outer pass finds `activeGroupId === null` on its own next run. Terminates in one extra level. |

**Dependencies:** none outside `src/webview/terminals.html` and `src/webview/terminals.js`. No persisted setting changes (`activeGroupPage` is already transient, `src/webview/terminals.js:93`). No shared edited lines with any sibling subtask.

## Proposed Changes

### `src/webview/terminals.html`

**1. Wrap the left half of the toolbar and add the pager (`~1968`).**

```html
        <div class="layout-toolbar">
            <div class="layout-toolbar-left">
                <div class="layout-picker">
                    ... unchanged layout buttons ...
                </div>
                <!-- Group paging. A CONTROL, not a warning: it lives beside the
                     grid-size buttons it responds to, in the panel's own chrome
                     colours. It reserves its space (visibility, not display) so
                     appearing never pushes the pane grid down. -->
                <div id="group-pager" class="group-pager">
                    <span id="group-pager-label" class="group-pager-label"></span>
                    <button type="button" id="group-pager-prev" class="group-pager-btn" title="Previous page">‹</button>
                    <button type="button" id="group-pager-next" class="group-pager-btn" title="Next page">›</button>
                </div>
            </div>
            <div class="toolbar-actions">
                ... unchanged ...
            </div>
        </div>
```

**2. New CSS beside `.layout-picker` (`~528`).**

```css
        .layout-toolbar-left {
            display: flex;
            align-items: center;
            gap: 12px;
            min-width: 0;
        }
        /* Group paging. Same chrome family as .btn-layout — neutral by default,
           --accent-teal on hover. --accent-teal is redeclared per theme
           (:root -> var(--accent-primary), .theme-claudify -> #D97757), so this
           tracks the theme. NOT --accent-violet: that token is never declared in
           :root here, only ever used with a #c586c0 fallback, so it would stay
           violet in Claudify.
           visibility (not display) keeps the toolbar's height and the grid's
           position fixed whether or not a group is over-subscribed. */
        .group-pager {
            display: flex;
            align-items: center;
            gap: 4px;
            visibility: hidden;
            min-width: 0;
        }
        .group-pager.visible { visibility: visible; }
        .group-pager-label {
            font-size: 10px;
            color: var(--text-secondary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .group-pager-btn {
            background: transparent;
            border: 1px solid var(--border-bright);
            color: var(--text-secondary);
            font-family: inherit;
            font-size: 11px;
            line-height: 1;
            padding: 2px 6px;
            border-radius: 3px;
            cursor: pointer;
            flex-shrink: 0;
        }
        .group-pager-btn:hover:not(:disabled) {
            color: var(--accent-teal);
            border-color: var(--accent-teal);
        }
        .group-pager-btn:disabled { opacity: 0.35; cursor: default; }
```

**3. Retheme the surviving banner (`~1706`) and drop the now-dead `.banner-page-btn` rules.**

```css
        /* Window-too-small only. The paging control moved to the toolbar; what is
           left here is a genuine transient warning, so it uses the panel's amber
           state token rather than the red literal it used to hardcode. */
        .layout-fallback-banner {
            background: color-mix(in srgb, var(--state-connecting) 14%, transparent);
            color: var(--state-connecting);
            border-bottom: 1px solid var(--state-connecting);
            padding: 4px 12px;
            font-size: 11px;
            display: none;
        }
        .layout-fallback-banner.visible { display: block; }
```

Delete `.banner-page-btn` and `.banner-page-btn:disabled` (`src/webview/terminals.html:1715-1726`) — nothing renders them once the pager moves. Confirm with `grep -rn "banner-page-btn" src/` that `applyLayoutFloor`'s `mkPage` was the only producer.

### `src/webview/terminals.js`

**1. Cache the new handles beside `fallbackBannerEl` (`~196`).**

```js
    const groupPagerEl = document.getElementById('group-pager');
    const groupPagerLabelEl = document.getElementById('group-pager-label');
    const groupPagerPrevEl = document.getElementById('group-pager-prev');
    const groupPagerNextEl = document.getElementById('group-pager-next');
```

**2. Replace the banner block in `applyLayoutFloor()` (`~5628-5663`).** The two surfaces become independent — a floored layout and an over-subscribed group can now both be reported at once, which the single-element version could not do.

```js
        const activeGroup = activeGroupId ? getAllGroups().find(g => g.id === activeGroupId) : null;
        const members = activeGroup ? getGroupMembers(activeGroup).length : 0;
        const rendered = getSlotCount(effectiveLayout);
        const shortfall = !!activeGroup && members > rendered;
        const floored = effectiveLayout !== currentLayout;

        // Banner: window-too-small ONLY. Paging is a control and lives in the toolbar.
        fallbackBannerEl.classList.toggle('visible', floored);
        fallbackBannerEl.textContent = floored
            ? 'Window too small for requested layout — using simpler layout floor.'
            : '';

        // Pager: built after the slot count is known, so the page index it reads
        // is the one seatActiveGroupPage() clamped against the floored layout.
        // Idempotent in both branches — this function re-enters (see the
        // clearGroupLock path) and must be safe to run twice with no lock.
        if (groupPagerEl) {
            const pageCount = shortfall ? Math.max(1, Math.ceil(members / rendered)) : 1;
            const show = shortfall && pageCount > 1;
            groupPagerEl.classList.toggle('visible', show);
            if (show) {
                const start = activeGroupPage * rendered;
                groupPagerLabelEl.textContent =
                    `${activeGroup.name} ${start + 1}–${Math.min(start + rendered, members)} of ${members}`;
                groupPagerLabelEl.title = `${activeGroup.name}: ${members} terminals, ${rendered} panes on screen`;
                groupPagerPrevEl.disabled = activeGroupPage <= 0;
                groupPagerNextEl.disabled = activeGroupPage >= pageCount - 1;
            } else {
                groupPagerLabelEl.textContent = '';
                groupPagerLabelEl.title = '';
                groupPagerPrevEl.disabled = true;
                groupPagerNextEl.disabled = true;
            }
        }
```

**3. Wire the two buttons once, at init, beside the other static toolbar handlers.** They are static markup now, so the listeners are attached once instead of being rebuilt inside the render — no stale-closure risk, because the handler reads `activeGroupPage` at click time and the re-entrant `applyLayoutFloor` call only updates labels and disabled flags.

```js
    const stepGroupPage = (delta) => {
        activeGroupPage += delta;
        seatActiveGroupPage();
        applyLayoutFloor({ fit: false });
        batchFitVisiblePanes();
    };
    if (groupPagerPrevEl) { groupPagerPrevEl.addEventListener('click', () => stepGroupPage(-1)); }
    if (groupPagerNextEl) { groupPagerNextEl.addEventListener('click', () => stepGroupPage(1)); }
```

## Verification Plan

> Testing is done against an **installed VSIX**, not the repo's `dist/`. No compilation or automated-test step is part of this plan.

1. **Install + open:** install the current VSIX and open the Terminals panel in a browser window.
2. **Shortfall, no shift:** spawn 6 terminals of one role so a derived group materialises. Lock it. Note the vertical pixel position of the top of the pane grid. Switch the grid size to `2x2`. Confirm the pane grid **does not move down**, and the pager appears inside the toolbar to the right of the grid-size buttons reading `<group> 1–4 of 6`.
3. **No red:** confirm nothing in the toolbar is red. Inspect the computed colour of `.group-pager-label` and `.group-pager-btn` — both resolve from `--text-secondary`/`--border-bright`.
4. **Paging works:** click `›`. Panes 5–6 seat, the label reads `5–6 of 6`, `›` disables, `‹` enables. Click `‹` to return.
5. **Theme:** switch to the Claudify theme. Confirm the pager's hover colour becomes `#D97757` and no violet or red appears.
6. **Clear:** raise the grid size to `3x3` so all 6 fit. Confirm the pager hides, the toolbar height does not change, and the grid does not move.
7. **Floor case still reported:** shrink the browser window until the layout floors. Confirm the amber `Window too small…` banner appears and is amber, not red.
8. **Both at once:** with the group still locked and over-subscribed, shrink the window until the floor also trips. Confirm the pager reports the *new, smaller* page window **and** the banner reports the floor — the case the old single-element branch could not show.
9. **Dead CSS gone:** `grep -rn "banner-page-btn" src/` returns zero hits.
10. **Solo mode:** enter solo. Confirm the toolbar (and with it the pager) is hidden and no console error fires.
11. **Unlocked:** click **All**. Confirm the pager hides and the toolbar layout is visually identical to the pre-change baseline.
12. **Re-entrancy (only once the `Unassigned` sibling has landed):** lock `Unassigned` with more members than panes so the pager is visible, then group its last remaining members so the pseudo-group dissolves. Confirm the pager hides, no console error fires, and the panel does not hang.
