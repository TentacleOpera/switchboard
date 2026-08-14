# Remove the cryptic `N (Xa/Yx)` count badge from the Terminals sidebar headers

## Goal

Each workspace row in the Terminals panel sidebar carries a badge that reads like `4 (4a/0x)`. Nobody can decode it on sight, it competes with the workspace name for a 220px-wide column, and everything it encodes is already visible in the rows directly beneath it. Delete it.

### Problem analysis

`renderSidebarList()` (`src/webview/terminals.js:3032`) builds the badge twice — once per workspace header, once per worktree sub-header.

Workspace header (`src/webview/terminals.js:3199-3229`):

```js
            let totalItems = parentGroup.direct.length;
            let activeCount = parentGroup.direct.filter(i => i.status !== 'exited').length;

            for (const wtGroup of parentGroup.worktreesMap.values()) {
                totalItems += wtGroup.items.length;
                activeCount += wtGroup.items.filter(i => i.status !== 'exited').length;
            }
            const exitedCount = totalItems - activeCount;
            ...
            const countEl = document.createElement('span');
            countEl.className = 'worktree-count';
            countEl.textContent = `${totalItems} (${activeCount}a/${exitedCount}x)`;
```

Worktree sub-header (`src/webview/terminals.js:3284-3308`):

```js
                    const wtActive = wtGroup.items.filter(i => i.status !== 'exited').length;
                    const wtExited = wtGroup.items.length - wtActive;
                    ...
                    const wtCountEl = document.createElement('span');
                    wtCountEl.className = 'worktree-count';
                    wtCountEl.textContent = `${wtGroup.items.length} (${wtActive}a/${wtExited}x)`;
```

So `4 (4a/0x)` means "4 terminals total, 4 active, 0 exited". The `a`/`x` suffixes are undocumented single letters with no legend, no tooltip, and no hover affordance anywhere in the panel.

### Root cause

The badge is a **debug readout that shipped as UI**. It reports three numbers whose entire content is derivable by looking at the list it sits on top of: the rows are right there, and exited rows already announce themselves — `renderTerminalRow` appends `(exited)` to the handle (`src/webview/terminals.js:2020`) and applies `.is-exited` styling (`src/webview/terminals.js:2007`, `src/webview/terminals.html:452-453`). The badge is a second, encoded source of truth for information the primary surface already shows plainly, and it consumes horizontal space in the narrowest column in the panel — `.worktree-title-area` is `overflow: hidden` (`src/webview/terminals.html:578-583`), so on a long workspace name the badge is what pushes the name into an ellipsis.

### Decision

**Delete both badges outright**, along with the counting they exist to feed and the now-unused CSS rule. Do not replace them with a plain number: the row list is the count, and a header that reads `switchboard` is more legible than one that reads `switchboard 4`. `totalItems` stays — it gates the "no terminals" empty notice — but `activeCount`, `exitedCount`, `wtActive`, and `wtExited` all become dead and go with the badge.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, ux, refactor
- **Project:** Browser Switchboard

## Feature context — this is subtask 1 of 5

This plan is the first edit in the feature **Terminals Panel Sidebar & Group Selection UX**. It lands first *because* it is a pure deletion inside `renderSidebarList()`: the two sibling plans that restructure the same function ("filter the agent tree to the locked group" and "workspace dropdown") both rewrite the header-construction block this plan shrinks, and doing the deletion first means they rebase onto three fewer lines instead of merging around a badge one of them would then have to delete anyway.

**Reconciled contract with the siblings:**

- **`totalItems` survives and stays the empty-notice gate.** The group-filter plan re-points the *input* of the bucketing loop (`fleetList` → a group-filtered array) and rewrites the notice *text*; it does not touch the accumulation. Both are compatible because `totalItems` is computed from `parentGroup.direct` / `worktreesMap` — i.e. from whatever was bucketed — so it filters for free.
- **The workspace header block this plan edits is the same block the workspace-dropdown plan makes conditional** (`if (!flattenHeaders) { ... }`). After this plan, that block no longer contains a badge, so the dropdown plan wraps a shorter, badge-free header. The worktree sub-header keeps *its* header in both modes, so its badge is not removed by the dropdown plan — it is only removed here. **This plan is not subsumed by the dropdown plan; both badges are its scope.**

## Complexity Audit (Routine vs Complex/Risky)

**Routine** — this is a deletion of presentation-only code. Five variable computations, two element constructions, two `appendChild` calls, and one CSS rule.

**Complex / Risky**

- **`totalItems` is not dead.** It gates `if (totalItems === 0)` at `src/webview/terminals.js:3268`, which renders the `(no terminals — + to open)` notice, and that notice is the `else` arm of the whole row-rendering block. Delete the accumulation and every workspace renders the notice *and* no rows. The worktree-loop accumulation into `totalItems` must survive; only `activeCount`/`exitedCount` go.
- **Scope must cover both headers.** The workspace header and the worktree sub-header share the `.worktree-count` class and the same format string. Removing one and leaving the other would leave the panel visibly inconsistent — this is one change, not two.
- **`.worktree-count` may have other users.** Confirm with a grep before deleting the rule; at time of writing the only three references are the CSS declaration (`src/webview/terminals.html:590`) and the two `className` assignments (`src/webview/terminals.js:3224`, `:3303`).

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Workspace with zero terminals | Header + `+` render; `(no terminals — + to open)` notice still renders — `totalItems` must still be computed. |
| Workspace whose terminals all live under worktrees | `totalItems` still accumulates from `worktreesMap`, so the notice does not falsely appear. |
| Workspace with exited terminals only | Header renders, rows render with their `(exited)` suffix and `.is-exited` styling. The information the badge carried is on the rows. |
| Long workspace name | Now gets the full `.worktree-title-area` width before ellipsising — the visible upside of the deletion. |
| Collapsed workspace | Rows are `display: none`; the header shows name + chevron + `+` and no count. Accepted: expanding is one click, and the badge was unreadable anyway. |
| `Unmapped` bucket | Same treatment — it is built as an ordinary parent group (`src/webview/terminals.js:3140-3147`). |
| Another panel using `.worktree-count` | None — the class is local to `src/webview/terminals.html`. Verify by grep before deleting the rule. |
| Fleet poll (5s) after the change | `renderSidebarList()` re-runs with the removed locals absent from every path. No `undefined` deref is possible because the variables are deleted together with their only readers. |

**Dependencies:** none. No verb calls, no persisted settings, no backend, no other panel. Within the feature, this plan lands **before** the group-filter and workspace-dropdown plans, which rewrite the same header block.

## Proposed Changes

### `src/webview/terminals.js`

**1. Workspace header — drop the active/exited split and the badge (`~3199`).**

```js
            // totalItems survives: it gates the "no terminals" notice below,
            // which is the else-arm of the row render — losing it renders the
            // notice on every workspace AND suppresses every row. The
            // active/exited split does not survive: the rows already announce
            // their own state ((exited) suffix + .is-exited styling), and the
            // encoded badge that reported it was unreadable.
            let totalItems = parentGroup.direct.length;
            for (const wtGroup of parentGroup.worktreesMap.values()) {
                totalItems += wtGroup.items.length;
            }
```

and at `~3223`, the badge construction and its `appendChild` go:

```js
            titleArea.appendChild(icon);
            titleArea.appendChild(nameEl);
```

**2. Worktree sub-header — same (`~3284`).** Delete `wtActive`, `wtExited`, `wtCountEl` and its `appendChild`, leaving:

```js
                    wtTitleArea.appendChild(wtIcon);
                    wtTitleArea.appendChild(wtNameEl);
```

### `src/webview/terminals.html`

Delete the now-unreferenced rule (`~590`):

```css
        .worktree-count {
            font-size: 9px;
            background: var(--border-color);
            color: var(--text-secondary);
            padding: 1px 4px;
            border-radius: 8px;
        }
```

## Verification Plan

> Testing is done against an **installed VSIX**, not the repo's `dist/`. No compilation or automated-test step is part of this plan.

1. **Grep first:** `grep -rn "worktree-count" src/` must return exactly the three sites named above before the change, and **zero** after it.
2. **Install + open:** install the current VSIX and open the Terminals panel in a browser window.
3. **Workspace headers:** confirm every workspace row shows chevron + name + `+` and no numeric badge.
4. **Worktree sub-headers:** spawn a terminal in a worktree so a sub-header renders. Confirm it too shows only chevron + name + `+`.
5. **Empty notice still works:** collapse/expand a workspace with no terminals and confirm `(no terminals — + to open)` still renders — this is the `totalItems` regression check, and the single highest-value step in this plan.
6. **Worktree-only workspace:** ensure a workspace whose terminals all live under worktrees does **not** show the empty notice — the second half of the same regression check.
7. **Long name:** confirm a long workspace name now uses the full title width before ellipsising.
8. **Exited state legible:** exit a terminal and confirm its row still carries the `(exited)` suffix and dimmed styling, so nothing that was in the badge is lost.
9. **Collapse/expand + spawn:** confirm the chevron still toggles, the `+` still opens the role picker under the right header, and the spawn lands in the right workspace/worktree.
10. **Console:** no `undefined` reference errors from the removed variables on any render, including the 5s fleet poll (leave the panel idle 30s).
