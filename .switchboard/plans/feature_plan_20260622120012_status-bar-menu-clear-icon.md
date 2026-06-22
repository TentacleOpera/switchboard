# Give the "Clear" Option an Icon in the Switchboard Status Bar Menu

## Goal

In the Switchboard status-bar quick menu, the **Clear** option shows no icon while the other items do. It must display a valid icon consistent with the rest of the menu.

### Problem Analysis

The status-bar menu is a `showQuickPick` built in [extension.ts:2066-2155](src/extension.ts#L2066). Each item uses a codicon prefix: `$(shield)` Guard, `$(hubot)` Agents, `$(stop-circle)` Reset, `$(table)` Kanban, `$(notebook)` Artifacts, `$(project)` Project, `$(symbol-color)` Design, `$(comment-discussion)` Memo. The Clear item is:

```js
items.push({
    label: '$(eraser) Clear',          // extension.ts:2091
    description: 'Clear agent terminals',
    command: 'switchboard.clearAllTerminals'
});
```

`eraser` is **not a valid VS Code codicon** (the codicon set has no `eraser`; valid "erase/clear" glyphs are `clear-all`, `trash`, `close-all`, `circle-slash`). When a QuickPick label references a non-existent codicon, VS Code renders nothing, so the Clear row appears icon-less while the others — all using real codicons — render correctly. The same `$(eraser)` literal is also used on the terminal Clear status bar item ([extension.ts:1811](src/extension.ts#L1811)), which is similarly blank.

### Root Cause

The label uses `$(eraser)`, an invalid codicon name, so no glyph is drawn.

## Metadata

**Complexity:** 1
**Tags:** vscode, statusbar, icons, polish

## Complexity Audit

### Routine
- Swapping the invalid codicon for a valid one in (at minimum) the QuickPick item, and ideally also the matching status-bar item for consistency.

### Complex / Risky
- None. Verify the chosen codicon name against the VS Code codicon reference before committing.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** None — label cosmetic only; `command` unchanged.
- **Dependencies & Conflicts:** Coordinate with the status-bar-menu theme plan (same menu). Use a codicon distinct from `$(stop-circle)` Reset and `$(table)` etc. to avoid ambiguity. `$(clear-all)` reads as "clear" and is visually distinct.

## Proposed Changes

### 1. `src/extension.ts` — QuickPick Clear item
At [extension.ts:2091](src/extension.ts#L2091):
```js
label: '$(clear-all) Clear',   // was $(eraser) — invalid codicon
```

### 2. `src/extension.ts` — terminal Clear status bar item (consistency)
At [extension.ts:1811](src/extension.ts#L1811):
```js
terminalClearStatusBarItem.text = '$(clear-all) Clear';   // was $(eraser)
```

> If a trash-can metaphor is preferred over a clear-all metaphor, `$(trash)` is also valid; pick one and use it in both places.

## Verification Plan

1. Build/run; open the Switchboard status-bar menu (the command bound to the status bar hub, with Terminal Controls enabled in Setup).
2. Confirm the **Clear** row now shows the `clear-all` glyph, aligned with the other icons.
3. Confirm the terminal **Clear** status bar item also shows the glyph.
4. Sanity-check the codicon name against the VS Code codicon list so it is guaranteed to render.
