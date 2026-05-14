# Fix: Prevent webview default-value drift across kanban, setup, and implementation

## Goal

Eliminate the maintenance hazard where `lastVisibleAgents` (and related default config objects) are hard-coded independently in three webview files, causing them to fall out of sync when new roles are added.

## Metadata

- **Tags:** frontend, bugfix, reliability
- **Complexity:** 5

## User Review Required

- Confirm the default visibility values (`true`/`false`) for `ticket_updater`, `researcher`, and `splitter` in `implementation.html` match product intent.

## Problem

The Switchboard extension has three webview panels (`kanban.html`, `setup.html`, `implementation.html`) that each declare an inline `lastVisibleAgents` default object. Because these objects are duplicated by hand, adding a new agent role requires remembering to update all three files. The recent bugfix for researcher / ticket_updater / splitter defaults only covered `kanban.html` and `setup.html`; `implementation.html` still lacks `gatherer`, `ticket_updater`, `researcher`, and `splitter` keys.

If the extension host's `visibleAgents` message arrives late or is dropped, `implementation.html` will silently show or hide the wrong columns.

## Root Cause

Each webview is a self-contained HTML file with an inline `<script>` block. There is no shared JS module for default constants, so values are copy-pasted between files.

### Current drift snapshot

| File | `lastVisibleAgents` keys | Missing keys |
|------|--------------------------|--------------|
| `kanban.html` | lead, coder, intern, reviewer, tester, planner, analyst, jules, gatherer, **ticket_updater, researcher, splitter** | — |
| `setup.html` | planner, lead, coder, intern, reviewer, tester, analyst, jules, gatherer, **ticket_updater, researcher, splitter** | — |
| `implementation.html` | planner, lead, coder, intern, reviewer, tester, analyst, jules | **gatherer, ticket_updater, researcher, splitter** |

Additionally, `kanban.html` has `DEFAULT_CONFIG` with role-specific addon defaults that are not present in the other files.

## Proposed Changes

### Option A (Recommended): Extract shared defaults module

Create `src/webview/sharedDefaults.js` containing:

```js
const DEFAULT_VISIBLE_AGENTS = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    jules: true,
    gatherer: true,
    ticket_updater: false,
    researcher: false,
    splitter: false
};

const DEFAULT_ROLE_CONFIG = {
    // ... current DEFAULT_CONFIG from kanban.html ...
    ticket_updater: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, ticketUpdateEnabled: false } },
    researcher:     { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, researchEnabled: false } },
    // ... etc
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_VISIBLE_AGENTS, DEFAULT_ROLE_CONFIG };
}
```

Update the three HTML files to include a placeholder before their first inline `<script>` block:

```html
<!-- SHARED_DEFAULTS_SCRIPT -->
```

Each panel provider replaces this placeholder with a `<script src="...">` computed via `webview.asWebviewUri(...)` at runtime.

Replace inline declarations with:

```js
let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS };
```

**Pros:** Single source of truth, no drift, trivial to add new roles.  
**Cons:** Requires URI injection in three panel providers; minor build/packaging verification needed to ensure the file is included in the `.vsix`.

### Option B: Inline extraction via WebviewMessage

Have the extension host compute the default object in TypeScript and send it as part of the initial `init` or `visibleAgents` message, so the webview never declares its own fallback. The webview would start with an empty `{}` and wait for the host.

**Pros:** No shared JS file needed.  
**Cons:** Introduces a hard dependency on the host message arriving before first paint; if the message is delayed, the board renders with zero columns until it arrives. Less resilient than a correct fallback.

### Option C: Add CI drift check (low-effort guardrail)

Add a Node script in `.agent/scripts/check-webview-sync.js` that greps all three HTML files for `lastVisibleAgents = {` and compares key sets. If they differ, the script exits non-zero. Wire it into `.husky/pre-commit` or GitHub Actions.

**Pros:** Fast to implement, catches omission at PR time.  
**Cons:** Does not fix the duplication; just detects it.

### Execution Details

#### `src/webview/sharedDefaults.js` (new file)
- **Context:** Centralizes all webview default constants.
- **Logic:** Export `DEFAULT_VISIBLE_AGENTS` and `DEFAULT_ROLE_CONFIG` as global vars for browser consumption, with a Node-compatible `module.exports` guard for testability.
- **Edge Cases:** Keep `jules` and `gatherer` out of `DEFAULT_ROLE_CONFIG` because `kanban.html` does not currently define role configs for them; this preserves existing behavior.

#### `src/services/KanbanProvider.ts` (~lines 5583–5648)
- **Context:** `_getHtml(webview)` reads `kanban.html`, injects CSP nonce, and returns HTML.
- **Implementation:** After reading the HTML string, compute:
  ```ts
  const sharedDefaultsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedDefaults.js')).toString();
  ```
  Then replace `<!-- SHARED_DEFAULTS_SCRIPT -->` with `<script src="${sharedDefaultsUri}"></script>`.
- **Edge Cases:** The regex `/<script>/g` used for nonce injection will NOT match `<script src="...">` because it has attributes, so the external script tag is left untouched. The CSP already includes `script-src 'nonce-...' ${webview.cspSource}`, and `localResourceRoots` includes `this._extensionUri`, so the local script load is permitted.

#### `src/services/SetupPanelProvider.ts` (~lines 1089–1118)
- **Context:** `_getHtml(webview)` reads `setup.html`, injects CSP nonce, and returns HTML.
- **Implementation:** Same URI computation and placeholder replacement as KanbanProvider.
- **Edge Cases:** Same CSP/localResourceRoots behavior as kanban.

#### `src/services/TaskViewerProvider.ts` (~lines 15935–15988)
- **Context:** `_getHtmlForWebview(webview)` reads `implementation.html`, injects CSP nonce, and returns HTML.
- **Implementation:** Same URI computation and placeholder replacement. Note: `TaskViewerProvider` uses a `WebviewView` (not `WebviewPanel`), but `webview.asWebviewUri()` and `localResourceRoots` work identically.
- **Edge Cases:** The file search in `_getHtmlForWebview` probes `dist/webview/implementation.html`, `webview/implementation.html`, and `src/webview/implementation.html`. In production, `dist/webview/sharedDefaults.js` will exist because webpack `CopyPlugin` copies `src/webview/*.js` to `dist/webview/` (see `webpack.config.js` lines 54–78).

#### `src/webview/kanban.html` (~line 2893)
- **Context:** Inline `lastVisibleAgents` declaration.
- **Implementation:** Add `<!-- SHARED_DEFAULTS_SCRIPT -->` before the first `<script>` tag. Replace:
  ```js
  let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, jules: true, gatherer: true, ticket_updater: false, researcher: false, splitter: false };
  ```
  with:
  ```js
  let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS };
  ```
- **Edge Cases:** `DEFAULT_CONFIG` (~line 2411) should also be replaced with `{ ...DEFAULT_ROLE_CONFIG }`, and `loadRoleConfigs` (~line 2430) should continue to reference the same role list.

#### `src/webview/setup.html` (~line 1341)
- **Context:** Inline `lastVisibleAgents` declaration.
- **Implementation:** Add `<!-- SHARED_DEFAULTS_SCRIPT -->` before the first `<script>` tag. Replace inline declaration with `let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS };`.

#### `src/webview/implementation.html` (~line 2203)
- **Context:** Inline `lastVisibleAgents` declaration.
- **Implementation:** Add `<!-- SHARED_DEFAULTS_SCRIPT -->` before the first `<script>` tag. Replace:
  ```js
  let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, jules: true };
  ```
  with:
  ```js
  let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS };
  ```
  This automatically adds the missing `gatherer`, `ticket_updater`, `researcher`, and `splitter` keys with correct defaults.

#### `.agent/scripts/check-webview-sync.js` (new file)
- **Context:** CI/pre-commit guardrail.
- **Logic:** Parse `DEFAULT_VISIBLE_AGENTS` and `DEFAULT_ROLE_CONFIG` from `src/webview/sharedDefaults.js`, then verify that each of the three HTML files references those globals rather than inline declarations. Alternatively, compare key sets across all three files directly.
- **Edge Cases:** Run against both `src/webview/*.html` (dev) and `dist/webview/*.html` (prod) if available.

## Recommendation

Implement **Option A** (shared module) + **Option C** (mandatory CI check).

## Implementation Steps

1. Create `src/webview/sharedDefaults.js` with `DEFAULT_VISIBLE_AGENTS` and `DEFAULT_ROLE_CONFIG`.
2. Update `KanbanProvider.ts` `_getHtml` (~line 5583) to inject `<script src="${sharedDefaultsUri}"></script>` by replacing `<!-- SHARED_DEFAULTS_SCRIPT -->`.
3. Do the same for `SetupPanelProvider.ts` `_getHtml` (~line 1089) and `TaskViewerProvider.ts` `_getHtmlForWebview` (~line 15935).
4. Add `<!-- SHARED_DEFAULTS_SCRIPT -->` placeholder before the first inline `<script>` in `kanban.html`, `setup.html`, and `implementation.html`.
5. Replace inline `lastVisibleAgents` declarations in all three HTML files with `let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS };`.
6. Replace inline `DEFAULT_CONFIG` in `kanban.html` (~line 2411) with `const DEFAULT_CONFIG = { ...DEFAULT_ROLE_CONFIG };`.
7. Add `.agent/scripts/check-webview-sync.js` to compare key sets and run it in CI/pre-commit.
8. Verify the `.vsix` build includes `dist/webview/sharedDefaults.js` (webpack `CopyPlugin` already copies `src/webview/*.js`).

## Verification Plan

### Manual Tests
- Delete `.switchboard/state.json`, reload window, confirm all three panels render correctly with default visibility.
- Toggle a specialty role ON in setup, reload, confirm it appears in kanban and implementation.

### Automated Tests
- Run the new `check-webview-sync.js` script; expect exit 0.
- Temporarily remove a key from `DEFAULT_VISIBLE_AGENTS` in one HTML file and confirm the script exits non-zero.
- Verify `dist/webview/sharedDefaults.js` exists after `npm run compile` or `vsce package`.

## Dependencies

- None

## Complexity Audit

### Routine
- Creating shared JS file and replacing inline declarations.

### Complex / Risky
- Ensuring `sharedDefaults.js` is correctly served by the webview URI resolver in all three panel providers.
- Verifying VS Code webview CSP allows the local script load.

## Edge-Case & Dependency Audit

### Race Conditions
- If `visibleAgents` host message arrives after the webview renders, the shared defaults determine initial column visibility; the message then hydrates over them. No race condition introduced by this change.

### Security
- The new external script is loaded from the extension's own package via `webview.asWebviewUri()`, restricted by `localResourceRoots`. It is not remote or user-controlled.
- The CSP `script-src` already includes `webview.cspSource`, which authorizes local resource URIs. No CSP weakening is required.

### Side Effects
- Existing persisted state (stored in `.switchboard/state.json` or VS Code settings) is hydrated over the shared defaults on message receipt, so user customizations are preserved.
- The `DEFAULT_ROLE_CONFIG` object in `kanban.html` is currently missing `jules` and `gatherer` entries. Extracting the shared config preserves this omission; a future plan can add them if needed.

### Dependencies & Conflicts
- Webpack `CopyPlugin` (in `webpack.config.js` lines 65–68) already copies `src/webview/*.js` to `dist/webview/`. No build-tool changes are needed.
- The `.vscodeignore` excludes `src/**` but keeps `!dist/**`, so `dist/webview/sharedDefaults.js` will be packaged in the `.vsix` automatically.

## Adversarial Synthesis

Key risks: CSP restrictions may block external script loads if nonce handling is misconfigured; `TaskViewerProvider` (implementation.html) uses a `WebviewView` rather than a `WebviewPanel`, requiring careful verification of URI resolution paths; adding a new JS file to `src/webview/` is automatically copied by webpack but any future build system changes could silently drop it. Mitigations: test all three panels in both dev (`src/webview/`) and prod (`dist/webview/`) paths, add CI check as backstop, and verify file presence in build output.

**Recommendation:** Send to Coder.
