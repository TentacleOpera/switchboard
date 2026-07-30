# Style Scrollbars in the Browser Cockpit Panels (memo, project, setup, shell)

## Goal

Give every browser-cockpit surface the same dark, thin scrollbar the board already has, so scrolling the cockpit in a plain browser stops rendering wide light-grey OS scrollbars over black panels.

### Problem

Opening the Switchboard cockpit in a browser (`http://127.0.0.1:<port>/`, served by `LocalApiServer` — either the extension host or the standalone `npx` host) shows native, unstyled scrollbars. They read as light-grey/white tracks on the panels' near-black backgrounds — wider than the 6px thumb the styled panels use, and visually foreign to the panel chrome.

### Root cause

Scrollbar styling in this repo is **per-panel inline CSS**, and only four of the eight webview HTML files carry it:

| Panel HTML | `::-webkit-scrollbar` rules | Scroll containers in browser mode |
| :--- | :--- | :--- |
| `src/webview/kanban.html` | yes — [kanban.html:1142-1159](../../src/webview/kanban.html#L1142-L1159) | column bodies, modals |
| `src/webview/planning.html` | yes — planning.html:1032-1047 | sidebars, doc preview |
| `src/webview/design.html` | yes — design.html:1004-1019 | sidebars, thumb strip |
| `src/webview/implementation.html` | yes — implementation.html:755-770 | sidebar (not a browser route) |
| `src/webview/memo.html` | **none** | `body { overflow-y: auto }` (memo.html:52) + the textarea |
| `src/webview/project.html` | **none** | 24 `overflow` declarations (sidebars, doc preview, lists) |
| `src/webview/setup.html` | **none** | 7 `overflow` declarations |
| `src/webview/shell.html` | **none** | `#strip { overflow-y: auto }` (shell.html:56) |

Two independent factors make the gap visible **only** in browser mode:

1. **No `::-webkit-scrollbar` rules at all** in `memo.html`, `project.html`, `setup.html`, `shell.html` — verified: `grep -c webkit-scrollbar` returns 0 for each. Those four panels therefore paint Chromium's default scrollbar.
2. **Nothing declares a dark colour scheme.** `grep -rn "color-scheme" src/webview/*.html` returns zero hits repo-wide. Chromium picks the *light* native scrollbar/form-control palette unless a page opts into `color-scheme: dark`. Inside the VS Code webview the host supplies its own dark chrome, so the same markup looks correct there and wrong in a browser tab.

The already-styled panels are fine in a browser because their thumb colour is written defensively — `var(--vscode-scrollbarSlider-background, var(--border-bright))` — so the missing `--vscode-*` variable falls through to the panel's own token. That is the pattern to reuse verbatim.

Scope note: this plan is CSS-only and touches the four HTML files that lack the rules. It does not restyle any panel's palette, layout, or components.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** Four additive CSS blocks, no JS, no host code, no message contracts, no build-graph changes. `webpack.config.js:74-92` already copies `src/webview/*.html` to `dist/webview/`, and both HTML resolvers (`headlessPanelHtml.ts` `findFile([dist…, src…])`) and the static route (`staticRoutes.webview: [dist/webview, src/webview]`) prefer `dist` — so a rebuild is required for the change to be served, but no wiring changes.

Risk points, all small:

- **Token names differ per panel.** `project.html` / `setup.html` define `--border-bright: #444444` and `--text-secondary: #8C8C8C`; `shell.html` defines neither (its tokens are `--border: #1f1f2e`, `--text-dim: #7a7a8c`); `memo.html` currently defines only `--border-color` / `--text-secondary`. Each block must reference tokens that exist **in that file**, otherwise the thumb resolves to nothing and renders transparent (invisible scrollbar — worse than an ugly one).
- **`color-scheme: dark` also affects native form controls** (select dropdowns, date pickers, the textarea's inner scrollbar) in the same document. That is the desired direction — every one of these panels is hard-dark (`#000`/`#0d0d0d` backgrounds) in both themes — but it is a wider blast radius than the scrollbar selectors alone, so the verification plan checks the panels' inputs and selects explicitly.
- **Two `<style>` blocks in `setup.html`** (first closes at line 540, second at 610). The rules belong in the **first** block, with the tokens.

Not risky: no data, no persistence, no dispatch, no CSP change (all rules are inline in an existing `<style>`, already permitted by every panel's `style-src 'unsafe-inline'`).

## Edge-Case & Dependency Audit

- **Editor webview must not regress.** `project.html` and `setup.html` are served to the VS Code webview too (`PlanningPanelProvider` / `SetupPanelProvider`). Keeping `var(--vscode-scrollbarSlider-background, …)` first in the fallback chain means the editor keeps host-tinted thumbs and only the browser uses the local token.
- **`color-scheme: dark` under a light VS Code theme.** These panels do not follow the editor's light/dark theme — they are always dark-surfaced — so declaring `dark` is consistent, not a mismatch. It is scoped to `:root` in each panel, never to a shared file that a light surface could inherit.
- **Firefox / non-Chromium.** `::-webkit-scrollbar` is ignored there; the paired `scrollbar-width: thin` + `scrollbar-color` declarations cover it. Both are cheap and harmless in Chromium (Chromium honours `scrollbar-color` too — the `::-webkit-*` rules win where both apply).
- **`scrollbar-corner`.** Where a container scrolls in both axes (project.html doc preview, kanban board), the unset corner paints a light square in browser mode. Include `::-webkit-scrollbar-corner { background: transparent; }` in each block.
- **Shell iframes do not inherit.** `shell.html` hosts each panel in a same-origin `<iframe>` (`.panel-frame`). CSS does not cross the iframe boundary, which is exactly why each panel file needs its own copy — styling only the shell would fix the 48px icon strip and nothing else.
- **Idempotency.** If a concurrent change has already added a scrollbar block to one of these four files, do not add a second one — merge into the existing block. Duplicate `::-webkit-scrollbar` rules are not an error but make the next edit ambiguous.
- **A shared stylesheet was considered and rejected.** A single `browser-chrome.css` served at `/static/webview/` would need a new URI placeholder substituted at three injection sites (`headlessPanelHtml.ts`, `PlanningPanelProvider`, `SetupPanelProvider`) and a `<link>` that resolves in both hosts. `webview-shim-injection-contract.test.js` documents what happens when a single per-panel injection marker goes missing (a dead Setup panel shipped in 1.7.13). For ~12 lines of CSS, four inline copies matching the existing precedent is the lower-risk trade.
- **Build/deploy dependency.** `dist/` wins over `src/` in both resolvers, and the *installed* extension serves from its own install folder — not this repo's `dist/`. Verification must build and sync to the installed extension, then reload, before judging the result.

## Proposed Changes

### 1. `src/webview/memo.html` — add the block inside the existing `<style>` (before `</style>` at line 71)

```css
        :root { color-scheme: dark; }

        /* Scrollbar styling — matches kanban.html/planning.html/design.html.
           The --vscode-* var is absent in a browser and falls through to the
           panel's own token, so one declaration serves both hosts. */
        * { scrollbar-width: thin; scrollbar-color: var(--border-color) transparent; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-corner { background: transparent; }
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, var(--border-color));
            border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, var(--text-secondary));
        }
```

`memo.html` has no `--border-bright`; it defines `--border-color: #333333` and `--text-secondary: #888888` at `:root` (memo.html:22-28), so the thumb uses those.

### 2. `src/webview/project.html` — add before `</style>` (line 1222)

```css
        :root { color-scheme: dark; }

        /* Scrollbar styling — parity with kanban/planning/design. */
        * { scrollbar-width: thin; scrollbar-color: var(--border-bright) transparent; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-corner { background: transparent; }
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, var(--border-bright));
            border-radius: 3px;
            border: none;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, var(--text-secondary));
        }
```

Tokens exist at `project.html:26-45` (`--border-bright: #444444`, `--text-secondary: #8C8C8C`) and are redeclared in the `body.theme-claudify` block, so both themes resolve.

### 3. `src/webview/setup.html` — add at the end of the **first** `<style>` block (before `</style>` at line 540)

Same block as project.html; `setup.html:16-35` defines `--border-bright: #444444` and `--text-secondary: #8C8C8C`, and its `body.theme-claudify` block redeclares both.

### 4. `src/webview/shell.html` — add before `</style>` (line 129), using the shell's own tokens

```css
        :root { color-scheme: dark; }

        /* Scrollbar styling for the icon strip (#strip overflows on short viewports). */
        * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-corner { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
```

The shell is browser-only (`getShellHtml`), so it needs no `--vscode-*` fallback; it has no `--border-bright` / `--text-secondary`, so it uses `--border` (shell.html:29) and `--text-dim` (shell.html:31).

### 5. `src/test/browser-panel-scrollbar-contract.test.js` — new contract test

Follows the convention in `src/test/webview-shim-injection-contract.test.js`: a plain-node script that renders each panel through `headlessPanelHtml` and asserts on the served HTML.

```js
'use strict';
/**
 * Contract: every browser-served panel styles its own scrollbars.
 *
 * Scrollbar CSS in this repo is per-panel inline CSS — there is no shared
 * stylesheet to inherit from and no CSS across the shell's iframe boundary.
 * A new panel route that forgets the block ships light OS scrollbars on a
 * black surface, which is invisible to every existing test.
 */
const assert = require('assert');
const { getPanelHtmlById, getShellHtml } = require('../../out/services/headlessPanelHtml');

const REPO_ROOT = /* resolved as in webview-shim-injection-contract.test.js */;
const PANELS = ['board', 'project', 'memo', 'planning', 'design', 'setup'];

for (const id of PANELS) {
    const { html } = getPanelHtmlById(id, REPO_ROOT, '/tmp/ws');
    assert.match(html, /::-webkit-scrollbar\s*{/, `${id}: no ::-webkit-scrollbar rule`);
    assert.match(html, /::-webkit-scrollbar-thumb\s*{/, `${id}: no thumb rule`);
    assert.match(html, /color-scheme:\s*dark/, `${id}: no dark color-scheme`);
}
const shell = getShellHtml(REPO_ROOT);
assert.match(shell.html, /::-webkit-scrollbar\s*{/, 'shell: no ::-webkit-scrollbar rule');
assert.match(shell.html, /color-scheme:\s*dark/, 'shell: no dark color-scheme');
```

### 6. `package.json` — register the test

```json
    "test:contract:panel-scrollbars": "node src/test/browser-panel-scrollbar-contract.test.js",
```

## Verification Plan

**Automated**

1. `npm run compile-tests && npm run compile` — builds `out/` (for the test's `require`) and `dist/webview/` (what the server serves).
2. `npm run test:contract:panel-scrollbars` — passes; then temporarily delete the block from `src/webview/setup.html`, rebuild, and confirm it **fails** naming `setup` (proves the assertion is load-bearing, not vacuous).
3. `npm run test:contract:shim-injection` — still green (the same files are re-rendered; confirms no marker/anchor was disturbed).
4. `npm run lint` — clean.

**Manual — browser mode (the reported surface)**

5. Sync the build to the installed extension folder and reload the window (the installed extension serves from its own folder, not this repo's `dist/`). Read `.switchboard/api-server-port.txt` and open `http://127.0.0.1:<port>/`.
6. **Memo panel** (`/memo`): paste enough text to overflow the textarea and shrink the window until the panel body scrolls. Both scrollbars are 6px, dark, transparent-tracked. No white gutter.
7. **Project panel** (`/project`): scroll the plan list, the sidebar, and a doc preview. Where a container scrolls both axes, the bottom-right corner is transparent, not a white square.
8. **Setup panel** (`/setup`): scroll the settings body; open a `<select>` and confirm the dropdown renders dark (this is the `color-scheme: dark` side effect — confirm it is an improvement, not a regression).
9. **Shell strip**: shrink the window vertically until the 48px icon strip overflows; its scrollbar is dark and 6px.
10. **Board panel** (`/board`): unchanged from before the change (regression check on an already-styled panel).

**Manual — editor webview (no regression)**

11. In VS Code, open the Project panel and the Setup panel. Scrollbars still follow the editor theme's slider colour (the `--vscode-scrollbarSlider-background` branch), and no input, dropdown, or panel background changed appearance.
12. Switch theme (`switchboard.theme.name`: `afterburner` → `claudify`) with the cockpit open in both hosts; the thumb colour follows each theme's `--border-bright` / `--border-color` and never renders invisible.
