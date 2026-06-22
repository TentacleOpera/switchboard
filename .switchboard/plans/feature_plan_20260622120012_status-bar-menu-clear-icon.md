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

`eraser` is **not a valid VS Code codicon** (the codicon set has no `eraser`; valid "erase/clear" glyphs are `clear-all`, `trash`, `close-all`, `circle-slash`). When a QuickPick label references a non-existent codicon, VS Code renders nothing, so the Clear row appears icon-less while the others — all using real codicons — render correctly.

The same `$(eraser)` literal appears in **three** places in `src/extension.ts`, all of which render blank:

1. **Line 1811** — the terminal Clear **status bar item** (`terminalClearStatusBarItem.text`).
2. **Line 1987** — the terminal Clear **markdown hover/actions link** (`[$(eraser) Clear](command:...)`), built inside the status-bar tooltip string builder.
3. **Line 2091** — the terminal Clear **QuickPick item** (`label`).

All three must be fixed for the icon to appear consistently across every surface.

### Root Cause

The label uses `$(eraser)`, an invalid codicon name, so no glyph is drawn. The invalid name is duplicated across three call sites in `src/extension.ts`.

## Metadata

**Tags:** ui, ux, bugfix
**Complexity:** 1

## User Review Required

No — this is a purely cosmetic icon-name correction with no behavioral, data, or configuration impact. The `command` bindings are unchanged; only the displayed glyph changes. Safe to execute without user confirmation.

## Complexity Audit

### Routine
- Swapping the invalid codicon `$(eraser)` for a valid one (`$(clear-all)`) in all three occurrences in `src/extension.ts` (lines 1811, 1987, 2091).
- All three sites are simple string-literal edits with no logic changes.
- The chosen codicon `$(clear-all)` is confirmed valid in the VS Code codicon font (`codicon.ttf`); it is visually distinct from the other menu icons (`$(stop-circle)` Reset, `$(hubot)` Agents, etc.).

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — all three sites are static string assignments evaluated at menu/tooltip construction time.
- **Security:** None — label cosmetic only; `command` strings unchanged.
- **Side Effects:** None — no behavioral change; only the rendered glyph differs.
- **Dependencies & Conflicts:** Use a codicon distinct from `$(stop-circle)` Reset and `$(table)` Kanban to avoid visual ambiguity. `$(clear-all)` reads as "clear" and is visually distinct from all other icons in the menu. If a trash-can metaphor is preferred, `$(trash)` is also a valid codicon and equally distinct — pick one and use it consistently in all three places.

## Dependencies

- None — this plan is self-contained and has no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: the original plan identified only two of three `$(eraser)` occurrences, missing the markdown hover link at line 1987 — an incomplete fix would leave the tooltip icon blank. Mitigations: grep-verified all three sites and included all in the proposed changes. Secondary risk: choosing a codicon that is not actually in the VS Code codicon font. Mitigations: `$(clear-all)` and `$(trash)` are both confirmed valid codicons in the `codicon` font shipped with VS Code.

## Proposed Changes

### `src/extension.ts` — terminal Clear status bar item (consistency)

At [extension.ts:1811](src/extension.ts#L1811):
```js
terminalClearStatusBarItem.text = '$(clear-all) Clear';   // was $(eraser) — invalid codicon
```

### `src/extension.ts` — terminal Clear markdown hover/actions link

At [extension.ts:1987](src/extension.ts#L1987):
```js
lines.push(`[$(clear-all) Clear](command:switchboard.clearAllTerminals)`);   // was $(eraser)
```

### `src/extension.ts` — QuickPick Clear item

At [extension.ts:2091](src/extension.ts#L2091):
```js
label: '$(clear-all) Clear',   // was $(eraser) — invalid codicon
```

> If a trash-can metaphor is preferred over a clear-all metaphor, `$(trash)` is also a valid codicon; pick one and use it in **all three** places for consistency.

## Verification Plan

### Automated Tests

No automated tests required — this is a cosmetic string-literal change with no logic impact. The test suite (run separately by the user) should remain green.

### Manual Verification

1. Open the Switchboard status-bar menu (the command bound to the status bar hub, with Terminal Controls enabled in Setup).
2. Confirm the **Clear** row in the QuickPick now shows the `clear-all` glyph, aligned with the other icons.
3. Confirm the terminal **Clear** status bar item (right-aligned status bar) also shows the glyph.
4. Hover over the Switchboard status bar hub item and confirm the **Clear** markdown link in the hover tooltip also shows the glyph.
5. Sanity-check the codicon name `clear-all` against the VS Code codicon list so it is guaranteed to render.

---

**Recommendation:** Complexity 1 → **Send to Intern**
