# Brand the terminals.html sidebar list with real CLI brand icons and names

## Goal

The browser terminals page (`src/webview/terminals.html`, driven by `src/webview/terminals.js`) renders each terminal row in the left sidebar with a generic, binary-derived subline like `lead · CLAUDE CLI`, `coder · AGY CLI`, `reviewer · DEVIN CLI`. A user testing the page asked for the list to reflect the **actual CLI brands**: a Claude Code icon for the `claude` CLI, an Antigravity icon for the `agy` CLI (and rename "AGY CLI" → "Antigravity CLI" everywhere it appears), a Devin icon for the `devin` CLI, and so on for other CLIs.

### Problem analysis & root cause

There are two intertwined root causes:

1. **Display-name derivation is a dumb `basename(binary).toUpperCase() + ' CLI'`.** The agent CLI label that reaches the sidebar is computed in five places — `src/services/TaskViewerProvider.ts:8960`, `:9248`, `:18301`, `:18370` and `src/extension.ts:3402` — all using the identical expression:
   ```ts
   const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
   ```
   For the `agy` binary this yields `AGY CLI`, which is the raw executable name, not the product brand. The user explicitly wants `Antigravity CLI`. The same map is the single source of truth for the **kanban column subline** too (`src/webview/kanban.html:5896-5906` reads `lastAgentNames[role]`), and `terminals.js:29-31` documents that the two surfaces are deliberately kept in lock-step ("exactly as the kanban column sublines show it … so the two surfaces cannot disagree"). So fixing the derivation fixes both surfaces at once.

2. **The sidebar row renders no brand icon at all.** `renderTerminalRow` in `terminals.js:695-795` builds an `.item-info` block with `.item-name` (the terminal's friendly name) and `.item-role` (the `role · cliLabel` string, `terminals.js:710-715`). There is no `<img>`/`<svg>` for the CLI brand. The project ships no brand icon assets today (confirmed: no claude/antigravity/devin SVGs under `src/` or a `media/`/`resources/` dir), so they must be added.

The CSP in `terminals.html` (`img-src 'self' data:`) permits both served image assets and inline `data:` URIs, so either path is open. The established project pattern for icons is `{{ICON_*}}` placeholders resolved server-side in `headlessPanelHtml.ts` against `/static/icons/...` (see the kanban icon map at `headlessPanelHtml.ts:190-218`). The terminals panel already resolves font/JS placeholders in `getTerminalsHtml` (`headlessPanelHtml.ts:386-413`), so adding brand-icon placeholders there follows the existing convention.

### Intended outcome

- Each sidebar row shows a small brand glyph next to the `role · <Brand> CLI` subline: Claude Code icon for `claude`, Antigravity icon for `agy`, Devin icon for `devin`, and a neutral fallback glyph for any other/unknown CLI.
- "AGY CLI" is replaced by "Antigravity CLI" on both the terminals sidebar and the kanban column subline (same shared `agentNames` map).
- The mapping is data-driven (binary → `{ brandName, iconKey }`) so adding a new CLI brand later is a one-line table edit, not a code branch.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, refactor
**Project:** Browser Switchboard

## Complexity Audit

**Low–Medium. Routine, but multi-file.** The change is a brand-mapping table plus one icon `<img>` per row — no state, no API, no persistence, no layout reflow risk (the icon sits in the existing `.item-info` flex column). The five displayName derivation sites are a mechanical extract-to-helper refactor. Risk surfaces:

- **Five identical derivation sites.** They must all call the same helper so the kanban subline and the terminals sidebar never diverge (the existing comment at `terminals.js:29-31` treats this invariant as load-bearing). A shared `deriveAgentDisplayName(binary)` function eliminates the drift risk permanently.
- **Static asset plumbing.** Adding `{{ICON_BRAND_CLAUDE}}` etc. placeholders requires edits in `getTerminalsHtml` (and the kanban path if icons are also wanted on the board subline — out of scope here; the user asked for the *sidebar list*, so only terminals.html needs the icon wiring). The kanban subline gets the *rename* for free via the shared helper, but not the icon.
- **Test contract.** `src/test/kanban-auto-export.test.ts:364` asserts exported content includes `**Agent:** CLAUDE CLI`. The rename must NOT change `claude` → something else (the user only asked to rename `agy`), so that test stays green. If a test asserts `AGY CLI` literally, it must be updated — verify before/after.

No complex/risky logic, no concurrency, no data migration.

## Edge-Case & Dependency Audit

- **`claude` must stay `CLAUDE CLI`, not become `Claude Code`.** The user asked for a *Claude Code icon* for the claude CLI, and only explicitly renamed `agy` → `Antigravity CLI`. Keep `claude` → `CLAUDE CLI` to avoid breaking `kanban-auto-export.test.ts:364` and the existing kanban/terminal label contract. (If the user later wants `Claude Code` as the label, that is a one-line table change — but do not assume it now.)
- **Custom agents.** `getStartupCommands` merges custom agents from `~/.switchboard/integration-config.json` (`TaskViewerProvider.ts:5514-5524`). A custom agent's binary is unknown to the brand table → must fall back to the current `basename().toUpperCase() + ' CLI'` behaviour so custom CLIs are not misbranded. The fallback also covers `jules`, `codex`, etc. that have no brand icon yet.
- **`No agent assigned` sentinel.** `terminals.js:713` and `kanban.html:5898` both special-case the literal string `'No agent assigned'`. The brand helper must return this sentinel unchanged (it is not a binary-derived label) and the icon must be omitted for it.
- **Icon size/alignment.** The `.item-role` row is 10px text in a 220px sidebar. The glyph must be ~12-14px and vertically centered so it does not push the role text onto a second line or break the existing `.item-info` flex layout. Use a fixed-size `<img>` with `flex-shrink:0` and `align-self:center`.
- **Theme variants.** The page has `theme-claudify` (terracotta accent) and `cyber-theme-enabled` (cyan). Brand icons should be monochrome SVGs that inherit `currentColor` or use a neutral fill so they read on both the dark default and the themed sidebar backgrounds (`terminals.html:78-83` gives the sidebar a translucent blurred background under themes). Prefer `currentColor`-driven SVGs.
- **`dist/webview/terminals.html` mirror.** `headlessPanelHtml.ts:388-389` reads `dist/webview/terminals.html` first, then `src/webview/terminals.html`. The build copies `src/webview/*` to `dist/webview/*`; only `src/` is edited, and the build step regenerates `dist/`. Do not hand-edit `dist/`.
- **Kanban icon scope.** The user asked for the *terminals.html sidebar list*. Do NOT add brand icons to the kanban column subline in this plan — that is a separate surface and a separate decision. The kanban subline receives the `AGY CLI` → `Antigravity CLI` rename for free via the shared helper, but no icon.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — extract a shared brand-aware display-name helper

Add a module-level (or exported) helper near the other terminal-agent helpers, and replace the five inline derivation sites with calls to it.

```ts
// Binary → brand display name. Falls back to basename().toUpperCase() + ' CLI'
// for any CLI not in the table (custom agents, jules, codex, …) so they are
// never misbranded. Returns the sentinel 'No agent assigned' unchanged.
const CLI_BRAND_NAMES: Record<string, string> = {
    agy: 'Antigravity CLI',
    // claude intentionally stays 'CLAUDE CLI' (see plan edge-case + kanban-auto-export.test.ts).
};

function deriveAgentDisplayName(startupCommand: string): string {
    const cmd = (startupCommand || '').trim();
    if (!cmd) { return ''; }
    const binary = cmd.split(/\s+/)[0];
    const base = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (CLI_BRAND_NAMES[base]) { return CLI_BRAND_NAMES[base]; }
    return path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
}
```

Then replace each of the five sites:

- `TaskViewerProvider.ts:8960` — `const displayName = ... + ' CLI';` → `const displayName = deriveAgentDisplayName(startupCommand);`
- `TaskViewerProvider.ts:9248` — same replacement.
- `TaskViewerProvider.ts:18301` — same replacement.
- `TaskViewerProvider.ts:18370` — same replacement.
- `extension.ts:3402` — `const displayName = ... + ' CLI';` → `const displayName = deriveAgentDisplayName(cmd);` (export the helper from `TaskViewerProvider` or move it to a tiny shared module both files import; prefer exporting from `TaskViewerProvider` since `extension.ts` already imports from it).

### 2. Add brand icon SVG assets

Add monochrome, `currentColor`-driven SVGs (so they adapt to theme) under a new static-served icons path. Following the kanban `/static/icons/` convention:

- `media/icons/brand-claude.svg` (Claude Code mark)
- `media/icons/brand-antigravity.svg` (Antigravity mark)
- `media/icons/brand-devin.svg` (Devin mark)
- `media/icons/brand-cli-default.svg` (neutral fallback terminal glyph)

These must be served at `/static/icons/...`. Confirm the static route in `LocalApiServer.ts` already maps the icons dir (kanban uses `/static/icons/25-1-100 Sci-Fi Flat icons-*.png`, so the route exists); if the route serves from a different on-disk dir, place the SVGs there instead of `media/icons/`. Verify the actual static root before writing files.

### 3. `src/services/headlessPanelHtml.ts` — wire brand-icon placeholders for the terminals panel

In `getTerminalsHtml` (`headlessPanelHtml.ts:386-413`), after the existing placeholder replacements, add:

```ts
const brandIconDir = '/static/icons';
content = content.replace(/\{\{ICON_BRAND_CLAUDE\}\}/g, `${brandIconDir}/brand-claude.svg`);
content = content.replace(/\{\{ICON_BRAND_ANTIGRAVITY\}\}/g, `${brandIconDir}/brand-antigravity.svg`);
content = content.replace(/\{\{ICON_BRAND_DEVIN\}\}/g, `${brandIconDir}/brand-devin.svg`);
content = content.replace(/\{\{ICON_BRAND_CLI_DEFAULT\}\}/g, `${brandIconDir}/brand-cli-default.svg`);
```

### 4. `src/webview/terminals.html` — declare the icon URIs and add row CSS

Near the top of the inline `<script>` (or in a small constants block read by `terminals.js`), expose the resolved URIs. Since `terminals.js` is loaded as an external file, the cleanest path is to stamp them into a `window.__SB_BRAND_ICONS__` global from a tiny nonce'd inline script in `terminals.html`, OR pass them as `data-*` attributes on `<body>`. Prefer the body-dataset approach (already used for `data-pty-host-origin`):

In `terminals.html`, add to the `<body>` tag (the file uses a `{{...}}`-templated body; `headlessPanelHtml.injectBodyAttributes` appends attributes, so add them directly in the static `terminals.html` body tag):
```html
data-brand-icon-claude="{{ICON_BRAND_CLAUDE}}"
data-brand-icon-antigravity="{{ICON_BRAND_ANTIGRAVITY}}"
data-brand-icon-devin="{{ICON_BRAND_DEVIN}}"
data-brand-icon-default="{{ICON_BRAND_CLI_DEFAULT}}"
```

Add CSS for the icon:
```css
.item-role-icon {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    align-self: center;
    margin-right: 4px;
    opacity: 0.85;
    /* Monochrome SVGs use currentColor; inherit the role text colour. */
}
.item-role-row {
    display: flex;
    align-items: center;
    gap: 0;
}
```

Restructure `.item-role` to sit inside an `.item-role-row` flex container so the icon and text align (see step 5).

### 5. `src/webview/terminals.js` — render the brand icon in `renderTerminalRow`

Add a binary → icon-key map and resolve the icon URI from the body dataset. In `renderTerminalRow` (`terminals.js:695-795`), change the `.item-role` construction (`terminals.js:710-715`):

```js
const CLI_BRAND_ICON_KEYS = {
    claude: 'claude',
    agy: 'antigravity',
    antigravity: 'antigravity',
    devin: 'devin',
};

function brandIconForCliLabel(cliLabel) {
    if (!cliLabel || cliLabel === 'No agent assigned') { return null; }
    // cliLabel is the display name, e.g. 'Antigravity CLI', 'CLAUDE CLI', 'DEVIN CLI'.
    // Map by the known brand names; fall back to the default icon for any other CLI.
    const key = cliLabel.toLowerCase();
    if (key.startsWith('antigravity')) { return 'antigravity'; }
    if (key.startsWith('claude')) { return 'claude'; }
    if (key.startsWith('devin')) { return 'devin'; }
    return 'default';
}

function brandIconUri(key) {
    const ds = document.body.dataset || {};
    const map = {
        claude: ds.brandIconClaude,
        antigravity: ds.brandIconAntigravity,
        devin: ds.brandIconDevin,
        default: ds.brandIconDefault,
    };
    return map[key] || '';
}
```

Then in the row builder, wrap the role text and icon:

```js
const roleRow = document.createElement('div');
roleRow.className = 'item-role-row';

const cliLabel = agentNames[item.role];
const iconKey = brandIconForCliLabel(cliLabel);
if (iconKey) {
    const icon = document.createElement('img');
    icon.className = 'item-role-icon';
    icon.src = brandIconUri(iconKey);
    icon.alt = '';
    icon.dataset.brand = iconKey;
    roleRow.appendChild(icon);
}

const roleEl = document.createElement('div');
roleEl.className = 'item-role';
roleEl.textContent = (cliLabel && cliLabel !== 'No agent assigned')
    ? `${item.role} · ${cliLabel}`
    : item.role;
roleRow.appendChild(roleEl);

info.appendChild(termNameEl);
info.appendChild(roleRow);
```

This keeps the existing `agentNames[item.role]` lookup (the lock-step-with-kanban invariant) and only adds the icon visually.

## Verification Plan

1. **Build:** run the project's webview build so `dist/webview/terminals.html` + `dist/webview/terminals.js` regenerate from `src/`. Confirm no build error.
2. **Type-check / compile:** `npm run compile` (or the project's TS build) — confirms the new `deriveAgentDisplayName` helper and its five call sites type-check, and the `extension.ts` import resolves.
3. **Unit test — `kanban-auto-export.test.ts`:** run it. `**Agent:** CLAUDE CLI` must still appear (the `claude` mapping is intentionally unchanged). If any test asserts `AGY CLI` literally, update it to `Antigravity CLI` and confirm it passes.
4. **Manual — terminals sidebar:** open the browser terminals page with a fleet that includes a `claude` terminal, an `agy` terminal, and a `devin` terminal. Confirm:
   - the `agy` row shows `Antigravity CLI` (not `AGY CLI`) and the Antigravity icon;
   - the `claude` row shows `CLAUDE CLI` and the Claude Code icon;
   - the `devin` row shows `DEVIN CLI` and the Devin icon;
   - a terminal with an unknown/custom CLI shows the default glyph and the existing `basename + ' CLI'` label.
5. **Manual — kanban subline:** open the kanban board. Confirm the column agent subline for an `agy`-backed role now reads `Antigravity CLI` (the shared helper feeds both surfaces). Confirm `claude`-backed roles still read `CLAUDE CLI`.
6. **Theme check:** toggle `theme-claudify` and `cyber-theme-enabled`. Confirm the brand icons remain legible on both sidebar backgrounds (monochrome `currentColor` SVGs should adapt; if a fixed-fill SVG was used, verify it does not clash with the terracotta/cyan accents).
7. **Static contract:** `src/test/terminal-solo-popout-contract.test.js` and the `headlessPanelHtml` contract tests must still pass — the new `data-brand-icon-*` attributes are additive and the CSP `img-src 'self' data:` already permits served SVGs.
