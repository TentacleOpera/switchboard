# Make the Switchboard Status Bar Menu Respect the Current Switchboard Theme

## Goal

The Switchboard status-bar quick menu does not respect the active Switchboard theme (Afterburner / Claudify). It should visually reflect the chosen theme as closely as the platform allows.

### Problem Analysis

The menu is implemented as a native `vscode.window.showQuickPick` in [extension.ts:2149-2151](src/extension.ts#L2149), populated with codicon-prefixed items ([2066-2142](src/extension.ts#L2066)).

A native QuickPick is rendered by the VS Code workbench and is styled **exclusively by the active VS Code color theme** (the editor theme), via `quickInput.*` theme tokens. There is no API to apply arbitrary CSS or a custom webview theme to a QuickPick. Switchboard's themes are CSS-variable palettes applied inside its **webview** panels (e.g. `--accent-primary` redeclared per theme); none of that reaches a native QuickPick. So the menu can never match the Switchboard webview theme through styling alone — this is the root limitation.

### Root Cause

The status-bar menu uses a native QuickPick, which inherits the VS Code workbench theme and cannot be styled to match Switchboard's custom (webview-only) theme palette.

## Metadata

**Complexity:** 6
**Tags:** vscode, statusbar, theme, ux, architecture

## User Review Required

Choose the approach (native QuickPick cannot be CSS-themed):
- **A. Themed webview menu (recommended for "respect the theme"):** replace the QuickPick with a small webview quick-menu (or a panel-anchored popup) that uses the same theme CSS variables as the other panels. Fully honors the Switchboard theme; higher effort and changes the interaction model.
- **B. Light-touch within native limits:** keep the QuickPick but inject theme-derived signals — a themed SVG `iconPath` per item (tinted to the active accent) and a `title`/`placeholder` that names the active theme. Cheaper; only partially "themed" (text/background still follow the VS Code theme).
- **C. Document the limitation:** accept that native menus follow the VS Code theme and adjust the expectation.

## Complexity Audit

### Routine
- Option B: reading the active theme and setting per-item themed icons / a themed title.

### Complex / Risky
- Option A: building and positioning a webview-based menu, wiring each action to its command, dismiss-on-blur behavior, and keyboard navigation — non-trivial and a UX change.

## Edge-Case & Dependency Audit

- **Race Conditions:** Option A's popup must read the current theme (`switchboard.theme.name`) at open time and re-read if the theme changes while open.
- **Security:** Option A webview must use a nonce/CSP like the other panels.
- **Side Effects:** Option A introduces a new webview lifecycle to manage (create/dispose, focus loss). Option B's themed icons require generating/shipping tinted SVGs.
- **Dependencies & Conflicts:** Same menu as the "Clear icon" fix — apply that first so the menu items already have valid icons. Reads `switchboard.theme.name` (same source as other theme features).

## Proposed Changes

### Recommended: Option A — themed webview quick-menu
1. Add a lightweight webview (or reuse a minimal panel) `src/webview/statusMenu.html` styled with the shared theme variables, applying the `theme-<name>` body class from `switchboard.theme.name` exactly like the other panels.
2. Render the same action list currently built in [extension.ts:2070-2142](src/extension.ts#L2070) (Guard / Agents / Clear / Reset / Kanban / Artifacts / Project / Design / Memo), gated by the same `statusBar.*` settings.
3. On item click, `postMessage` the chosen `command`; the host runs `vscode.commands.executeCommand(command)` and disposes the menu.
4. Dismiss on blur/Escape.

### Fallback: Option B — themed native QuickPick
- Build a per-item `iconPath` (themed SVG tinted to the active accent: `#00e5ff` Afterburner, `#D97757` Claudify) instead of codicon labels, and set `quickPick.title = 'Switchboard · <Theme>'`. Keep the existing command wiring.

## Verification Plan

1. Decide A vs B with the user.
2. **Option A:** open the menu under Afterburner → confirm cyan accent, themed background/borders matching the Kanban panel; switch to Claudify → reopen → confirm orange accent. Confirm every item runs its command and the menu dismisses on selection/blur/Escape.
3. **Option B:** open the menu under each theme → confirm item icons are tinted to the active accent and the title names the theme; confirm commands still fire.
4. Confirm the menu still respects the `statusBar.*` visibility toggles and the empty-state message.
